// docs/sources.js — cloud folders linked in Settings by pasting a share link.
//   gdrive    read through the service account (the folder must be shared with its address) and indexed
//   others    (OneDrive, Dropbox, Box, anything else) are recorded with an explanation but not yet readable
// A big Drive is handled by reading gradually, not by copying it: newest files first, at most max_files per
// folder, files over 25 MB skipped, and indexing stops while the free database is nearly full.
import { supabase } from '../db.js';
import { DRIVE_CREDENTIALS } from '../config.js';
import { client, extractText, SUPPORTED_MIME, driveConfigured } from './drive.js';
import { saveDoc, deleteDoc } from './store.js';
import { storageReport } from '../pcm/housekeeping.js';

const T = 'mobius_sources';
const FOLDER = 'application/vnd.google-apps.folder';
const MAX_BYTES = 25 * 1024 * 1024;  // bigger files are skipped
const MAX_CHARS = 300000;            // text kept per file (about 100 pages); the rest is left out
const STOP_AT_PERCENT = 85;          // stop indexing when the database is this full
const OTHER_NAMES = { onedrive: 'OneDrive / SharePoint', dropbox: 'Dropbox', box: 'Box', other: 'this service' };

export const serviceAccountEmail = () => DRIVE_CREDENTIALS?.client_email || null;

// ── Reading a pasted link ────────────────────────────────────────────────────
export function parseLink(raw) {
  const text = String(raw || '').trim();
  if (!text) throw new Error('Paste a link first.');
  let u;
  try { u = new URL(text); }
  catch {
    if (/^[A-Za-z0-9_-]{20,}$/.test(text)) return { provider: 'gdrive', id: text, resourceKey: null };
    throw new Error('That does not look like a link. Copy the folder\'s address from your browser and paste it here.');
  }
  const host = u.hostname.toLowerCase();
  if (host === 'drive.google.com' || host === 'docs.google.com') {
    const m = u.pathname.match(/\/(?:folders|file\/d|document\/d|spreadsheets\/d|presentation\/d)\/([A-Za-z0-9_-]+)/);
    const id = m?.[1] || u.searchParams.get('id');
    if (!id) throw new Error('I could not find a folder in that Google Drive link. Open the folder in Drive and copy its address from the browser bar.');
    return { provider: 'gdrive', id, resourceKey: u.searchParams.get('resourcekey') };
  }
  if (/(^|\.)(1drv\.ms|onedrive\.live\.com|sharepoint\.com)$/.test(host)) return { provider: 'onedrive' };
  if (/(^|\.)dropbox\.com$/.test(host)) return { provider: 'dropbox' };
  if (/(^|\.)box\.com$/.test(host)) return { provider: 'box' };
  return { provider: 'other' };
}

// ── Walking a Drive folder ───────────────────────────────────────────────────
const keyHeaders = (id, key) => (key ? { headers: { 'X-Goog-Drive-Resource-Keys': `${id}/${key}` } } : {});

// Every readable file under a folder, with its path. Stops at a time or size limit and says so.
async function listTree(drive, rootId, resourceKey, { budgetMs = 30000, maxEntries = 20000 } = {}) {
  const t0 = Date.now();
  const queue = [{ id: rootId, path: '' }];
  const files = [];
  const skipped = { tooBig: 0, unsupported: 0 };
  let truncated = false;
  while (queue.length) {
    if (Date.now() - t0 > budgetMs || files.length + skipped.tooBig + skipped.unsupported > maxEntries) { truncated = true; break; }
    const { id, path } = queue.shift();
    let pageToken;
    do {
      const r = await drive.files.list({
        q: `'${id}' in parents and trashed = false`, pageSize: 1000, pageToken,
        supportsAllDrives: true, includeItemsFromAllDrives: true,
        fields: 'nextPageToken, files(id, name, mimeType, size, modifiedTime)',
      }, id === rootId ? keyHeaders(rootId, resourceKey) : undefined);
      for (const f of r.data.files || []) {
        if (f.mimeType === FOLDER) queue.push({ id: f.id, path: path + f.name + '/' });
        else if (!SUPPORTED_MIME.has(f.mimeType)) skipped.unsupported++;
        else if (Number(f.size || 0) > MAX_BYTES) skipped.tooBig++;
        else files.push({ ...f, path: path + f.name });
      }
      pageToken = r.data.nextPageToken;
    } while (pageToken);
  }
  return { files, skipped, truncated };
}

// Can Mobius open it? → { status, name?, isFolder?, seen?, detail }
async function verifyDrive(id, resourceKey) {
  if (!driveConfigured()) return { status: 'error', detail: 'Google Drive is not set up on this deployment (no service-account key).' };
  const drive = client();
  try {
    const f = await drive.files.get({ fileId: id, fields: 'id, name, mimeType', supportsAllDrives: true }, keyHeaders(id, resourceKey));
    const isFolder = f.data.mimeType === FOLDER;
    if (!isFolder) {
      return SUPPORTED_MIME.has(f.data.mimeType)
        ? { status: 'ok', name: f.data.name, isFolder: false, seen: 1, detail: 'A single file.' }
        : { status: 'unsupported', name: f.data.name, isFolder: false, detail: 'Mobius cannot read this type of file yet (it reads PDF, Word, text, Markdown, CSV, JSON, Google Docs and Google Sheets).' };
    }
    const tree = await listTree(drive, id, resourceKey, { budgetMs: 15000, maxEntries: 5000 });
    const n = tree.files.length;
    const skips = [tree.skipped.unsupported && `${tree.skipped.unsupported} of other types`, tree.skipped.tooBig && `${tree.skipped.tooBig} over 25 MB`].filter(Boolean);
    return {
      status: 'ok', name: f.data.name, isFolder: true, seen: n,
      detail: `Opened. ${tree.truncated ? 'At least ' : ''}${n.toLocaleString()} readable file${n === 1 ? '' : 's'} found${skips.length ? ' (skipping ' + skips.join(' and ') + ')' : ''}.`,
    };
  } catch (e) {
    const code = e.code || e.response?.status;
    if (code === 400 || code === 403 || code === 404) {
      return { status: 'no_access', detail: `Mobius cannot open this folder. In Google Drive, right-click it → Share → add ${serviceAccountEmail() || 'the Mobius service account'} as a Viewer, then press Check.` };
    }
    return { status: 'error', detail: 'Google Drive said: ' + String(e.message).slice(0, 160) };
  }
}

// ── The list of linked folders ───────────────────────────────────────────────
export async function listSources() {
  if (!supabase) return [];
  const { data, error } = await supabase.from(T).select('*').order('id');
  if (error) throw new Error('sources: ' + error.message);
  return data || [];
}

export async function addSource({ url, label, maxFiles }) {
  if (!supabase) throw new Error('No database connection.');
  const link = parseLink(url);
  const max = Math.min(2000, Math.max(5, parseInt(maxFiles, 10) || 200));
  let row;
  if (link.provider === 'gdrive') {
    const dupe = (await listSources()).find(s => s.provider === 'gdrive' && s.external_id === link.id);
    if (dupe) throw new Error(`That folder is already linked as “${dupe.label}”.`);
    const v = await verifyDrive(link.id, link.resourceKey);
    row = {
      provider: 'gdrive', url: String(url).trim(), external_id: link.id, resource_key: link.resourceKey || null,
      label: (String(label || '').trim() || v.name || 'Google Drive folder').slice(0, 60).replace(/[\\/]+/g, '-'),
      is_folder: v.isFolder !== false, max_files: max, status: v.status, detail: v.detail,
      files_seen: v.seen ?? null, last_checked: new Date().toISOString(),
    };
  } else {
    row = {
      provider: link.provider, url: String(url).trim(), label: (String(label || '').trim() || OTHER_NAMES[link.provider]).slice(0, 60),
      max_files: max, status: 'unsupported', last_checked: new Date().toISOString(),
      detail: `Recorded, but Mobius cannot read ${OTHER_NAMES[link.provider]} yet. It needs a one-off app set-up with that service. Google Drive links work now.`,
    };
  }
  const { data, error } = await supabase.from(T).insert(row).select('*').single();
  if (error) throw new Error('sources: ' + error.message);
  return data;
}

export async function updateSource(id, { label, maxFiles }) {
  const patch = {};
  if (label != null) patch.label = String(label).trim().slice(0, 60).replace(/[\\/]+/g, '-') || 'Folder';
  if (maxFiles != null) patch.max_files = Math.min(2000, Math.max(5, parseInt(maxFiles, 10) || 200));
  const { error } = await supabase.from(T).update(patch).eq('id', id);
  if (error) throw new Error('sources: ' + error.message);
}

export async function checkSource(id) {
  const { data: src } = await supabase.from(T).select('*').eq('id', id).maybeSingle();
  if (!src) throw new Error('That linked folder no longer exists.');
  if (src.provider !== 'gdrive') return src;
  const v = await verifyDrive(src.external_id, src.resource_key);
  const patch = { status: v.status, detail: v.detail, files_seen: v.seen ?? src.files_seen, last_checked: new Date().toISOString() };
  const { data } = await supabase.from(T).update(patch).eq('id', id).select('*').single();
  return data;
}

// Unlinking keeps the documents unless asked; they go to the backup, as any deletion does.
export async function removeSource(id, { withDocs = false } = {}) {
  let removedDocs = 0;
  if (withDocs) {
    const { data } = await supabase.rpc('pcm_doc_sources');
    for (const r of (data || []).filter(x => x.source === 'gdrive:' + id)) { await deleteDoc(r.filename, 'its Google Drive link was removed'); removedDocs++; }
  }
  const { error } = await supabase.from(T).delete().eq('id', id);
  if (error) throw new Error('sources: ' + error.message);
  return { removedDocs };
}

// ── Reading the folders ──────────────────────────────────────────────────────
async function syncOne(drive, src, left) {
  const tree = await listTree(drive, src.external_id, src.resource_key, { budgetMs: Math.max(5000, Math.min(20000, left() / 2)) });
  const wanted = [...tree.files].sort((a, b) => String(b.modifiedTime).localeCompare(String(a.modifiedTime))).slice(0, src.max_files);
  const source = 'gdrive:' + src.id;
  let indexed = 0, unchanged = 0, failed = 0, paused = null;
  for (const f of wanted) {
    if (left() < 6000) break;
    const name = `${src.label}/${f.path}`;
    const { data: have } = await supabase.from('mobius_docs').select('id').eq('filename', name).eq('modified_at', f.modifiedTime).limit(1);
    if (have?.length) { unchanged++; continue; }
    if (indexed % 10 === 0) {
      const rep = await storageReport().catch(() => null);
      if (rep && rep.percent >= STOP_AT_PERCENT) { paused = `The database is ${rep.percent}% full, so reading stopped. Free some space (Settings → Storage), then press “Read new files now”.`; break; }
    }
    try {
      const text = (await extractText(drive, f)).slice(0, MAX_CHARS);
      if (!text.trim()) { failed++; continue; }
      await saveDoc(name, text, { source, modifiedAt: f.modifiedTime });
      indexed++;
    } catch (e) { failed++; console.warn('[sources]', name, e.message); }
  }
  const { data: all } = await supabase.rpc('pcm_doc_sources');
  const total = (all || []).filter(r => r.source === source).length;
  const more = Math.max(0, tree.files.length - wanted.length);
  const notes = [
    `${total.toLocaleString()} file${total === 1 ? '' : 's'} read of ${tree.files.length.toLocaleString()} found${tree.truncated ? '+' : ''}.`,
    more ? `${more.toLocaleString()} older file${more === 1 ? ' is' : 's are'} beyond the limit of ${src.max_files} (raise it to include more).` : '',
    tree.skipped.unsupported ? `${tree.skipped.unsupported.toLocaleString()} of other types skipped.` : '',
    tree.skipped.tooBig ? `${tree.skipped.tooBig.toLocaleString()} over 25 MB skipped.` : '',
    failed ? `${failed} had no readable text (for example scanned pages).` : '',
    indexed + unchanged < wanted.length && !paused ? 'Not finished: press “Read new files now” again to continue.' : '',
  ].filter(Boolean);
  await supabase.from(T).update({
    status: paused ? 'paused' : 'ok', detail: paused || notes.join(' '),
    files_seen: tree.files.length, files_indexed: total, last_synced: new Date().toISOString(),
  }).eq('id', src.id);
  return { id: src.id, label: src.label, indexed, unchanged, failed, paused: !!paused };
}

// Reads every linked Google Drive folder, newest files first, within a time budget. Called by the daily
// job and by the Settings button; whatever is left is picked up on the next run.
export async function syncSources({ budgetMs = Infinity, drive: injected = null } = {}) {
  if (!supabase || !driveConfigured()) return { skipped: 'Drive or database not configured' };
  const t0 = Date.now();
  const left = () => budgetMs - (Date.now() - t0);
  const { data: sources } = await supabase.from(T).select('*').eq('provider', 'gdrive').in('status', ['ok', 'pending', 'paused', 'error']).order('id');
  const drive = injected || client();
  const out = [];
  for (const src of sources || []) {
    if (left() < 8000) { out.push({ id: src.id, label: src.label, skipped: 'out of time; next run' }); continue; }
    try { out.push(await syncOne(drive, src, left)); }
    catch (e) {
      await supabase.from(T).update({ status: 'error', detail: 'Reading stopped: ' + String(e.message).slice(0, 160) }).eq('id', src.id);
      out.push({ id: src.id, label: src.label, error: e.message });
    }
  }
  return out;
}
