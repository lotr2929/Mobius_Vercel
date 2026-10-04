// workspace.js — Boon's cloud drives, worked through the chat instead of through Settings.
// "What drives are linked?", "list the files in the GPR folder", "read the second one", "summarise it": the router
// (pcm/router.js) turns such a message into a small instruction, and this module carries it out against Google
// Drive (read-only, as Boon, through the account he connected) and hands the result to the model.
// Where we are (which drive, folder, file, and the numbered list he was just shown) is kept in mobius_state, so
// "this folder", "the third one" and "it" mean what he thinks they mean.
import { getState, setState } from './pcm/memory.js';
import { userDrive, account as googleAccount, noteFailure } from './google.js';
import { extractText, SUPPORTED_MIME } from './docs/drive.js';
import { listSources, addSource, removeSource, syncSources } from './docs/sources.js';
import { saveDoc } from './docs/store.js';
import { storageReport } from './pcm/housekeeping.js';
import { supabase } from './db.js';
import { termsOf } from './docs/live.js';

const FOLDER = 'application/vnd.google-apps.folder';
const STATE_KEY = 'workspace';
const STATE_TTL = 12 * 3600e3;
const MAX_LIST = 60;       // items shown for a folder
const MAX_KEPT = 120;      // items remembered so "the 80th one" still works
const TEXT_CHARS = 20000;  // of a file given to the model in one go
const KEEP_CHARS = 1000000; // of a long file filed in the archive when Boon asks for it to be read
const KEEP_STOP_PERCENT = 85;
const IMAGE_BYTES = 3.5 * 1024 * 1024;

const esc = s => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const nameQuery = text => String(text).split(/\s+/).filter(Boolean).slice(0, 6).map(w => `name contains '${esc(w)}'`).join(' and ');
const perthDate = iso => iso ? new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Perth', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso)) : '';
const size = b => { const n = Number(b || 0); return !n ? '' : n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; };
const kind = m => m === FOLDER ? 'folder' : m === 'application/pdf' ? 'PDF' : /wordprocessingml|msword/.test(m) ? 'Word' : /spreadsheet|excel|csv/.test(m) ? 'spreadsheet' : /presentation|powerpoint/.test(m) ? 'slides'
  : m === 'application/vnd.google-apps.document' ? 'Google Doc' : m?.startsWith('image/') ? 'image' : m?.startsWith('video/') ? 'video' : m?.startsWith('audio/') ? 'audio' : m?.startsWith('text/') || m === 'application/json' ? 'text' : (String(m).split('/').pop() || 'file').slice(0, 24);

// ── Where we are ─────────────────────────────────────────────────────────────
export async function loadState() {
  const s = await getState(STATE_KEY).catch(() => null);
  return s && s.at && Date.now() - Date.parse(s.at) < STATE_TTL ? s : null;
}
const saveState = async patch => { const cur = (await loadState()) || {}; await setState(STATE_KEY, { ...cur, ...patch, at: new Date().toISOString() }); };

// A line for the router, so "it" and "this folder" can be resolved.
export async function describeState() {
  const [acct, s] = await Promise.all([googleAccount().catch(() => null), loadState()]);
  const parts = [acct?.connected ? `Google Drive connected as ${acct.email}` : 'No cloud drive is connected'];
  if (s?.folder) parts.push(`current folder: "${s.folder.name}"${s.items?.length ? ` (a numbered list of ${s.items.length} items was just shown: ${s.items.slice(0, 6).map(i => `${i.n}=${i.name}`).join('; ')}${s.items.length > 6 ? '; …' : ''})` : ''}`);
  if (s?.pending?.length) parts.push(`Boon was asked which folder he meant, among: ${s.pending.map(p => `${p.n}=${p.path}`).join('; ')}`);
  if (s?.file) parts.push(`last file opened: "${s.file.name}"`);
  return parts.join('. ');
}

// Which drive a result came from: "Google Drive: boonlayong@gmail.com"
async function driveLabel() {
  const a = await googleAccount().catch(() => null);
  return `Google Drive: ${a?.email || 'your account'}`;
}

// ── Reaching Drive ───────────────────────────────────────────────────────────
const friendly = (e, what = 'Google Drive') => {
  const msg = String(e?.message || e);
  if (/has not been used in project|is disabled|accessNotConfigured/i.test(msg)) return `${what} refused the request because the Google Drive API is switched off in the Google project behind Mobius's key. Enable it at https://console.cloud.google.com/apis/library/drive.googleapis.com and try again.`;
  if (/invalid_grant|invalid_client|unauthorized_client|Invalid Credentials|401/i.test(msg)) return 'The connection to your Google account has ended. Press Connect in Settings → Google account, then ask again.';
  if (/rate|quota|429/i.test(msg)) return `${what} is limiting requests just now. Try again in a minute.`;
  return `${what} said: ${msg.slice(0, 200)}`;
};
async function driveOrNull() { return userDrive().catch(() => null); }
const NOT_CONNECTED = 'No cloud drive is connected, so there is nothing to look in. Connect your Google account in Settings → Google account (one-off), then ask again.';

async function pathOf(drive, id, cache) {
  if (id === 'root') return 'My Drive';
  const names = []; let cur = id;
  for (let hops = 0; cur && hops < 8; hops++) {
    if (cur === 'root') { names.unshift('My Drive'); cur = null; break; }
    if (cache.has(cur)) { names.unshift(...cache.get(cur)); cur = null; break; }
    const r = await drive.files.get({ fileId: cur, fields: 'id, name, parents', supportsAllDrives: true }).catch(() => null);
    if (!r) break;
    names.unshift(r.data.name);
    cur = r.data.parents?.[0];
  }
  const path = names.length ? names.join('/') : 'My Drive';
  cache.set(id, names);
  return path;
}

// ── Finding a folder by what Boon called it ──────────────────────────────────
async function resolveFolder(drive, intent, state) {
  const ref = intent.ref, target = String(intent.target || '').trim();
  if (Number.isInteger(ref) && ref > 0) {
    const pick = state?.pending?.find(p => p.n === ref) || state?.items?.find(i => i.n === ref);
    if (pick) return pick.folder === false ? { notFolder: pick } : { folder: { id: pick.id, name: pick.name, path: pick.path || pick.name } };
    return { none: `there is no item number ${ref} in the list I last showed` };
  }
  if (!target || /^(this|here|the same|current|that)( folder| one)?$/i.test(target)) {
    if (state?.folder) return { folder: state.folder };
    return { folder: { id: 'root', name: 'My Drive', path: 'My Drive' } };
  }
  if (/^(root|my drive|the root|top level|the top|everything|my google drive|google drive|the drive|this drive|my files)$/i.test(target)) return { folder: { id: 'root', name: 'My Drive', path: 'My Drive' } };

  const terms = target.replace(/\b(folder|directory|the|my)\b/gi, ' ').trim();
  if (!terms) return { folder: state?.folder || { id: 'root', name: 'My Drive', path: 'My Drive' } };
  const inside = state?.folder?.id && state.folder.id !== 'root'
    ? await drive.files.list({ q: `'${state.folder.id}' in parents and mimeType = '${FOLDER}' and ${nameQuery(terms)} and trashed = false`, pageSize: 10, fields: 'files(id, name)', supportsAllDrives: true, includeItemsFromAllDrives: true }).then(r => r.data.files || []).catch(() => [])
    : [];
  let found = inside.map(f => ({ id: f.id, name: f.name }));
  if (!found.length) {
    const all = await drive.files.list({ q: `mimeType = '${FOLDER}' and ${nameQuery(terms)} and trashed = false`, pageSize: 30, fields: 'files(id, name, parents)', supportsAllDrives: true, includeItemsFromAllDrives: true });
    found = (all.data.files || []).map(f => ({ id: f.id, name: f.name }));
  }
  if (!found.length) return { none: `I could not find a folder called "${terms}" in your Drive` };
  const exact = found.filter(f => f.name.toLowerCase() === terms.toLowerCase());
  const shortlist = exact.length ? exact : found;
  const cache = new Map();
  const withPaths = [];
  for (const f of shortlist.slice(0, 6)) withPaths.push({ ...f, path: await pathOf(drive, f.id, cache) });
  if (withPaths.length === 1) return { folder: withPaths[0] };
  return { ambiguous: withPaths.map((f, i) => ({ ...f, n: i + 1 })), more: Math.max(0, shortlist.length - 6) };
}

// ── The actions ──────────────────────────────────────────────────────────────
async function actAccounts() {
  const [acct, sources] = await Promise.all([googleAccount().catch(() => null), listSources().catch(() => [])]);
  const lines = ['Cloud accounts and drives linked to Mobius:'];
  if (acct?.connected) {
    lines.push(`1. Google Drive: ${acct.email}. Connected${acct.connectedAt ? ' on ' + perthDate(acct.connectedAt) : ''}; read-only (Mobius can read and list files but cannot change, create or delete anything).`);
    const idx = sources.filter(s => s.provider === 'gdrive' && s.status !== 'unsupported');
    if (idx.length) { lines.push('   Folders Mobius keeps indexed for searching:'); for (const s of idx) lines.push(`   - ${s.label}: ${s.files_indexed ?? 0} files read${s.files_seen ? ' of ' + s.files_seen + ' found' : ''}${s.last_synced ? ', last read ' + perthDate(s.last_synced) : ''}${s.status !== 'ok' ? ' (' + s.status + ')' : ''}`); }
    else lines.push('   No folders are indexed yet. You can say, for example, “link the GPR folder” to index one; the rest of the Drive can still be listed and read whenever you ask.');
  } else {
    lines.push('1. Google Drive: not connected' + (acct?.problem ? ` (${acct.problem})` : '') + '. It can be connected in Settings → Google account.');
  }
  lines.push('2. Dropbox: not connected (not yet supported).', '3. OneDrive: not connected (not yet supported).');
  return { text: lines.join('\n') };
}

async function actList(drive, intent, state) {
  const r = await resolveFolder(drive, intent, state);
  if (r.none) return { text: `Could not do that: ${r.none}.` };
  if (r.notFolder) return actOpen(drive, { ...intent, ref: r.notFolder.n }, state);
  if (r.ambiguous) {
    await saveState({ pending: r.ambiguous });
    return { text: `More than one folder matches "${intent.target}". Which one do you mean? Answer with a number.\n${r.ambiguous.map(f => `${f.n}. ${f.path}`).join('\n')}${r.more ? `\n(${r.more} more matches not shown)` : ''}` };
  }
  const folder = r.folder;
  const cache = new Map();
  folder.path = folder.path || await pathOf(drive, folder.id, cache);
  const items = [];
  let pageToken;
  do {
    const res = await drive.files.list({ q: `'${folder.id}' in parents and trashed = false`, pageSize: 200, pageToken, orderBy: 'folder,name', fields: 'nextPageToken, files(id, name, mimeType, size, modifiedTime)', supportsAllDrives: true, includeItemsFromAllDrives: true });
    items.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken && items.length < 400);
  const numbered = items.map((f, i) => ({ n: i + 1, id: f.id, name: f.name, mime: f.mimeType, folder: f.mimeType === FOLDER, size: f.size, modified: f.modifiedTime, path: f.mimeType === FOLDER ? `${folder.path}/${f.name}` : undefined }));
  await saveState({ folder: { id: folder.id, name: folder.name, path: folder.path }, items: numbered.slice(0, MAX_KEPT), pending: null });
  const nf = numbered.filter(i => i.folder).length;
  const who = await driveLabel();
  const head = `**${who}**  \n**Folder:** ${folder.path} — ${items.length} item${items.length === 1 ? '' : 's'}${items.length ? ` (${nf} folder${nf === 1 ? '' : 's'}, ${items.length - nf} file${items.length - nf === 1 ? '' : 's'})` : ''}`;
  if (!items.length) return { text: head + '\n\nThe folder is empty.' };
  const line = i => `${i.n}. ${i.folder ? '[folder] ' : ''}${i.name}${i.folder ? '' : ` — ${kind(i.mime)}${size(i.size) ? ', ' + size(i.size) : ''}${i.modified ? ', changed ' + perthDate(i.modified) : ''}`}`;
  const shown = numbered.slice(0, MAX_LIST);
  return { text: head + '\n\n' + [...shown.map(line), items.length > shown.length ? `\n…and ${items.length - shown.length} more not shown (ask for a particular name, or for the rest).` : ''].filter(Boolean).join('\n') };
}

async function actFind(drive, intent, state) {
  const words = termsOf(intent.query || intent.target || '').slice(0, 4);
  if (!words.length) return { text: 'I could not search, because there was nothing to search for. Tell me what words the file should contain or be named after.' };
  const q = `${words.map(w => `(name contains '${esc(w)}' or fullText contains '${esc(w)}')`).join(' and ')} and trashed = false and mimeType != '${FOLDER}'`;
  const r = await drive.files.list({ q, pageSize: 20, fields: 'files(id, name, mimeType, size, modifiedTime, parents)', supportsAllDrives: true, includeItemsFromAllDrives: true });
  const files = r.data.files || [];
  if (!files.length) return { text: `No files in your Drive match "${words.join(' ')}" by name or content. Google's search may take a while to cover files uploaded very recently.` };
  const parents = new Map();
  for (const id of [...new Set(files.map(f => f.parents?.[0]).filter(Boolean))].slice(0, 12)) parents.set(id, (await drive.files.get({ fileId: id, fields: 'name', supportsAllDrives: true }).catch(() => null))?.data?.name || '?');
  const numbered = files.map((f, i) => ({ n: i + 1, id: f.id, name: f.name, mime: f.mimeType, folder: false, size: f.size, modified: f.modifiedTime, parent: parents.get(f.parents?.[0]), parentId: f.parents?.[0] }));
  await saveState({ items: numbered, pending: null });
  return { text: [`**${await driveLabel()}**  \n**Search:** "${words.join(' ')}" — ${files.length}${files.length === 20 ? ' or more' : ''} file${files.length === 1 ? '' : 's'}\n`, ...numbered.map(i => `${i.n}. ${i.name} — ${kind(i.mime)}${size(i.size) ? ', ' + size(i.size) : ''}, in "${i.parent || '?'}", changed ${perthDate(i.modified)}`)].join('\n') };
}

async function actOpen(drive, intent, state) {
  let file = null;
  const ref = intent.ref, target = String(intent.target || '').trim();
  if (Number.isInteger(ref) && ref > 0) file = state?.items?.find(i => i.n === ref) || null;
  else if ((ref === 'last' || !target) && state?.file) file = state.file;
  if (!file && target) {
    const terms = target.replace(/\b(file|document|the|my)\b/gi, ' ').trim();
    const inFolder = state?.folder?.id ? `'${state.folder.id}' in parents and ` : '';
    for (const scope of inFolder ? [inFolder, ''] : ['']) {
      const r = await drive.files.list({ q: `${scope}${nameQuery(terms)} and trashed = false and mimeType != '${FOLDER}'`, pageSize: 10, fields: 'files(id, name, mimeType, size, modifiedTime, parents)', supportsAllDrives: true, includeItemsFromAllDrives: true });
      const hits = r.data.files || [];
      const exact = hits.filter(f => f.name.toLowerCase() === terms.toLowerCase());
      const pick = exact.length ? exact : hits;
      if (pick.length === 1) { file = { id: pick[0].id, name: pick[0].name, mime: pick[0].mimeType, size: pick[0].size, modified: pick[0].modifiedTime, parentId: pick[0].parents?.[0] }; break; }
      if (pick.length > 1) {
        const numbered = pick.map((f, i) => ({ n: i + 1, id: f.id, name: f.name, mime: f.mimeType, folder: false, size: f.size, modified: f.modifiedTime, parentId: f.parents?.[0] }));
        await saveState({ pending: numbered.map(f => ({ ...f, path: f.name })), items: numbered });
        return { text: `More than one file matches "${terms}". Which one do you mean? Answer with a number.\n${numbered.map(f => `${f.n}. ${f.name} — ${kind(f.mime)}, changed ${perthDate(f.modified)}`).join('\n')}` };
      }
    }
  }
  if (!file) return { text: Number.isInteger(ref) ? `Could not open it: there is no item number ${ref} in the list I last showed.` : 'I could not tell which file you mean. Give me its name, or list a folder first and pick one by number.' };
  if (file.folder) return actList(drive, { ...intent, ref: file.n, target: '' }, state);

  const mime = file.mime || file.mimeType;
  const parentId = file.parentId || (Number.isInteger(ref) ? state?.folder?.id : null) || null;
  await saveState({ file: { id: file.id, name: file.name, mime, size: file.size, modified: file.modified, parentId, archived: file.archived || null }, pending: null });
  if (mime?.startsWith('image/')) {
    if (Number(file.size || 0) > IMAGE_BYTES) return { text: `"${file.name}" is an image of ${size(file.size)}, too large to look at here (the limit is ${size(IMAGE_BYTES)}).` };
    const res = await drive.files.get({ fileId: file.id, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' });
    return { text: `Opened "${file.name}" (image). The picture is attached to this message.`, images: [{ mimeType: mime, base64: Buffer.from(res.data).toString('base64') }] };
  }
  if (!SUPPORTED_MIME.has(mime)) return { text: `"${file.name}" is a ${kind(mime)} file, which Mobius cannot read as text yet (it reads PDF, Word, text, Markdown, CSV, JSON, Google Docs and Google Sheets, and can look at images).` };
  const text = await extractText(drive, { id: file.id, name: file.name, mimeType: mime });
  if (!text || !text.trim()) return { text: `"${file.name}" opened but has no readable text (it may be a scan or an image-only PDF).` };
  const cut = text.length > TEXT_CHARS;
  // A file too long to give whole is filed in the archive, so that this question and the ones after it can reach all of it
  // (search passages now, digests once they are written), instead of only the first pages.
  const archived = cut ? await archiveOpened(file, text, parentId).catch(e => { console.warn('[workspace] not filed:', e.message); return null; }) : null;
  if (archived) await saveState({ file: { id: file.id, name: file.name, mime, size: file.size, modified: file.modified, parentId, archived } });
  const pct = (TEXT_CHARS / text.length * 100).toFixed(1);
  return {
    text: `Opened "${file.name}" from ${await driveLabel()} (${kind(mime)}${size(file.size) ? ', ' + size(file.size) : ''}, changed ${perthDate(file.modified)}). ${cut
      ? `It has ${text.length.toLocaleString()} characters, and ONLY THE FIRST ${TEXT_CHARS.toLocaleString()} (${pct}%) ARE GIVEN BELOW.${archived ? ' The whole text has been filed in the Mobius archive and a digest of it is being written in the background, so questions about the whole document can be answered once that is done.' : ' The rest could not be filed.'}`
      : 'The whole text is given below.'}`,
    fileText: text.slice(0, TEXT_CHARS), fileName: file.name, archived,
    partial: cut ? { shown: TEXT_CHARS, total: text.length } : null,
  };
}

// Files the long text of an opened file under the folder it came from (if that folder is linked, the very name that
// reading the folder would give it, so nothing is stored twice), else under "Drive/". → the archive name, or null
async function archiveOpened(file, text, parentId) {
  if (!supabase) return null;
  const sources = await listSources().catch(() => []);
  const home = parentId ? sources.find(s => s.provider === 'gdrive' && s.external_id === parentId) : null;
  const name = home ? `${home.label}/${file.name}` : `Drive/${file.name}`;
  const source = home ? 'gdrive:' + home.id : 'gdrive:opened';
  const modifiedAt = file.modified || null;
  const { data: have } = await supabase.from('mobius_docs').select('id').eq('filename', name).eq('modified_at', modifiedAt).limit(1);
  if (have?.length) return name; // filed already, unchanged
  const rep = await storageReport().catch(() => null);
  if (rep && rep.percent >= KEEP_STOP_PERCENT) return null; // the free database is nearly full
  await saveDoc(name, text.slice(0, KEEP_CHARS), { source, modifiedAt });
  return name;
}

async function actLink(drive, intent, state) {
  const r = await resolveFolder(drive, intent, state);
  if (r.none) return { text: `Could not link it: ${r.none}.` };
  if (r.ambiguous) { await saveState({ pending: r.ambiguous }); return { text: `More than one folder matches "${intent.target}". Which one should be linked? Answer with a number.\n${r.ambiguous.map(f => `${f.n}. ${f.path}`).join('\n')}` }; }
  const f = r.folder;
  if (f.id === 'root') return { text: 'Linking the whole of My Drive is not offered, because it would fill the free storage. Please name a folder instead.' };
  try {
    const src = await addSource({ url: `https://drive.google.com/drive/folders/${f.id}`, label: f.name, maxFiles: intent.maxFiles || 200 });
    if (src.status !== 'ok') return { text: `Linked "${f.name}" but it could not be opened: ${src.detail}` };
    const rep = await syncSources({ budgetMs: 25000 });
    const mine = Array.isArray(rep) ? rep.find(x => x.id === src.id) : null;
    const after = (await listSources()).find(s => s.id === src.id);
    return { text: `Linked "${f.name}" (${f.path}) for indexing. ${src.detail} ${mine ? `First pass: ${mine.indexed} file(s) read now.` : ''} ${after?.detail || ''} A large folder is read in stages; saying “update the index” continues it. It is now also searched live when you ask about your documents.` };
  } catch (e) { return { text: `Could not link "${f.name}": ${e.message}` }; }
}

async function actUnlink(intent) {
  const sources = await listSources();
  const t = String(intent.target || '').toLowerCase().replace(/\b(folder|the|my)\b/g, '').trim();
  const hit = sources.filter(s => t && (s.label.toLowerCase().includes(t) || t.includes(s.label.toLowerCase())));
  if (hit.length !== 1) return { text: hit.length ? `More than one indexed folder matches "${t}": ${hit.map(s => s.label).join(', ')}. Which do you mean?` : `No indexed folder is called "${t}". The folders currently indexed: ${sources.map(s => s.label).join(', ') || 'none'}.` };
  const r = await removeSource(hit[0].id, { withDocs: !!intent.withDocs });
  return { text: `Stopped indexing "${hit[0].label}"${intent.withDocs ? ` and moved its ${r.removedDocs} stored document(s) to the Backup` : '. The text already read stays in Mobius unless you ask for it to be removed'}. Nothing in your Drive was touched.` };
}

async function actSync() {
  const rep = await syncSources({ budgetMs: 40000 });
  if (!Array.isArray(rep)) return { text: `Nothing was read: ${rep?.skipped || 'no result'}.` };
  if (!rep.length) return { text: 'No folders are indexed yet, so there is nothing to update. You can say “link the … folder” first.' };
  return { text: 'Index updated:\n' + rep.map(x => x.error ? `- ${x.label}: problem — ${x.error}` : x.skipped ? `- ${x.label}: ${x.skipped}` : `- ${x.label}: ${x.indexed} new or changed file(s) read, ${x.unchanged} already up to date${x.paused ? ' (paused: the free database is nearly full)' : ''}`).join('\n') };
}

// → { text, fileText?, fileName?, images? } or null when the instruction is not one this module handles
export async function runWorkspace(intent, { drive: injected = null } = {}) {
  try {
    const state = await loadState();
    if (intent.account && !/^(google|gdrive|google drive|drive)$/i.test(intent.account) && intent.action !== 'accounts') {
      return { text: `${intent.account} is not connected; only Google Drive is supported so far.` };
    }
    if (intent.action === 'accounts') return await actAccounts();
    if (intent.action === 'unlink') return await actUnlink(intent);
    const drive = injected || await driveOrNull();
    if (!drive) return { text: NOT_CONNECTED };
    switch (intent.action) {
      case 'list': return await actList(drive, intent, state);
      case 'find': return await actFind(drive, intent, state);
      case 'open': return await actOpen(drive, intent, state);
      case 'link': return await actLink(drive, intent, state);
      case 'sync': return await actSync();
      default: return null;
    }
  } catch (e) {
    if (/invalid_grant|invalid_client/i.test(String(e.message))) await noteFailure(e).catch(() => {});
    return { text: 'That did not work. ' + friendly(e) };
  }
}
