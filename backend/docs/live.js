// docs/live.js — search Boon's linked Drive folders at the moment he asks, instead of storing them.
// The free database holds only a few hundred documents, so a big Drive cannot be copied in. Instead Mobius asks
// Google Drive's own search (names and contents) inside the linked folders, opens the best few files, picks the
// passages that mention what he asked about, and hands them to the model for that one message. Nothing is stored.
import { supabase } from '../db.js';
import { client, extractText, SUPPORTED_MIME, driveConfigured } from './drive.js';
import { userDrive, noteFailure } from '../google.js';

const MAX_BYTES = 25 * 1024 * 1024;
const FOLDER_BATCH = 40;      // folders per Drive query
const MAX_BATCHES = 6;        // so at most 240 folders per linked folder are searched
const FILES_OPENED = 4;
const FILE_CHARS = 1500;      // passages kept per file
const OUT_CHARS = 5200;       // everything handed to the model

const STOP = new Set(('about above after again all also and any are because been before being between both but can could did does doing down during each few for from further had has have having her here him his how into its just like more most much must not now off once only other our out over own same she should some such than that the their them then there these they this those through under until very was were what when where which while who whom why will with would you your ' +
  'please tell give show find look need want help make made know think said say get got let using use used mine').split(/\s+/));

// Words worth searching for: the longer, rarer ones first.
export function termsOf(text) {
  const words = String(text || '').toLowerCase().replace(/[^\p{L}\p{N}\s-]+/gu, ' ').split(/\s+/).filter(w => w.length > 3 && !STOP.has(w));
  return [...new Set(words)].sort((a, b) => b.length - a.length).slice(0, 5);
}

// Does the message look like it is about his own documents or work? (Searching Drive on every message would be slow.)
const DOC_WORDS = /\b(drive|folders?|files?|documents?|docs?|papers?|reports?|manuscripts?|drafts?|thesis|chapters?|spreadsheets?|slides?|presentations?|pdfs?|notes|datasets?|data ?sets?|proposals?|grants?|submissions?|minutes|my (work|writing|research|files|papers|notes))\b/i;
export function wantsDriveLookup(query, plan, labels = []) {
  const q = String(query || '').toLowerCase();
  return DOC_WORDS.test(q) || (plan?.projects?.length > 0) || labels.some(l => l && l.length > 2 && q.includes(l.toLowerCase()));
}

const esc = s => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

// The text that matters in a file: windows that mention the search words, best first, in reading order.
export function passages(text, terms, maxChars = FILE_CHARS) {
  const clean = String(text || '').replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n');
  const wins = [];
  for (let i = 0; i < clean.length; i += 600) wins.push({ i, s: clean.slice(i, i + 800) });
  const scored = wins.map(w => {
    const low = w.s.toLowerCase(); let score = 0;
    for (const t of terms) { const n = low.split(t).length - 1; if (n) score += 1 + Math.min(n, 3) * 0.3; }
    return { ...w, score };
  }).filter(w => w.score > 0).sort((a, b) => b.score - a.score);
  const picked = []; let size = 0;
  for (const w of scored) {
    if (picked.some(p => Math.abs(p.i - w.i) < 700)) continue; // windows overlap: skip near neighbours
    if (size + w.s.length > maxChars) break;
    picked.push(w); size += w.s.length;
  }
  if (!picked.length) return clean.slice(0, Math.min(600, maxChars)).trim();
  // Windows cut words in half at their edges; start and end them at a word boundary.
  const tidy = w => { let t = w.s; if (w.i > 0) t = t.replace(/^\S+\s+/, ''); if (w.i + w.s.length < clean.length) t = t.replace(/\s+\S*$/, ''); return t.trim(); };
  return picked.sort((a, b) => a.i - b.i).map(tidy).join('\n … \n');
}

async function searchFolders(drive, folderIds, terms, deadline) {
  const batches = [];
  for (let i = 0; i < folderIds.length && batches.length < MAX_BATCHES; i += FOLDER_BATCH) batches.push(folderIds.slice(i, i + FOLDER_BATCH));
  const hits = new Map();
  let splits = 0;
  for (const mode of ['and', 'or']) { // all the words first; if that finds little, any of them
    const used = terms.slice(0, mode === 'and' ? 3 : 4);
    if (mode === 'or' && used.length < 2) break;
    const text = used.map(t => `fullText contains '${esc(t)}'`).join(` ${mode} `);
    // One folder that has since been deleted or unshared makes Drive answer "not found" for the whole query, so a
    // failing batch is halved and retried until the bad folder is left out (within a small limit).
    const runBatch = async ids => {
      const parents = ids.map(id => `'${id}' in parents`).join(' or ');
      try {
        const r = await drive.files.list({
          q: `(${text}) and (${parents}) and trashed = false and mimeType != 'application/vnd.google-apps.folder'`,
          pageSize: 20, supportsAllDrives: true, includeItemsFromAllDrives: true,
          fields: 'files(id, name, mimeType, size, modifiedTime)',
        });
        for (const f of r.data.files || []) hits.set(f.id, f);
      } catch (e) {
        if ((e.code || e.response?.status) === 404 && ids.length > 1 && splits < 30 && Date.now() < deadline) {
          splits++;
          const mid = Math.ceil(ids.length / 2);
          await Promise.all([runBatch(ids.slice(0, mid)), runBatch(ids.slice(mid))]);
        } else if (drive.__user) await noteFailure(e);
      }
    };
    await Promise.all(batches.map(runBatch));
    if (hits.size >= 3 || Date.now() > deadline) break;
  }
  return [...hits.values()].filter(f => SUPPORTED_MIME.has(f.mimeType) && Number(f.size || 0) <= MAX_BYTES);
}

const within = (p, ms) => Promise.race([p, new Promise(res => setTimeout(() => res(null), ms))]);

// → { text, files: [names] } or null when there is nothing to add
export async function liveDriveSearch(query, plan = {}, { budgetMs = 9000, drive: injected = null } = {}) {
  if (!supabase) return null;
  const { data: sources } = await supabase.from('mobius_sources').select('id, label, access, folder_ids, status, is_folder')
    .eq('provider', 'gdrive').eq('is_folder', true).in('status', ['ok', 'paused']);
  const usable = (sources || []).filter(s => Array.isArray(s.folder_ids) && s.folder_ids.length);
  if (!usable.length || !wantsDriveLookup(query, plan, usable.map(s => s.label))) return null;
  const terms = termsOf(query);
  if (!terms.length) return null;

  const t0 = Date.now(), deadline = t0 + budgetMs;
  const user = injected ? null : await userDrive();
  if (user) user.__user = true;
  const service = injected || (driveConfigured() ? client() : null);

  const found = [];
  for (const src of usable) {
    const drive = injected || (src.access === 'user' ? user : service) || user || service;
    if (!drive) continue;
    for (const f of await searchFolders(drive, src.folder_ids, terms, deadline)) found.push({ ...f, drive, source: src.label });
  }
  if (!found.length) return null;

  // The files whose names match come first, then the most recently changed.
  const score = f => terms.filter(t => f.name.toLowerCase().includes(t)).length * 3 + (Date.now() - Date.parse(f.modifiedTime) < 365 * 864e5 ? 1 : 0);
  const top = found.sort((a, b) => score(b) - score(a)).slice(0, FILES_OPENED);

  const parts = await Promise.all(top.map(async f => {
    const text = await within(extractText(f.drive, f).catch(() => ''), Math.max(2500, deadline - Date.now()));
    if (!text || !text.trim()) return null;
    return { name: `${f.source}/${f.name}`, body: passages(text.slice(0, 250000), terms), modified: f.modifiedTime };
  }));
  const ok = parts.filter(Boolean);
  if (!ok.length) return null;
  const per = Math.floor(OUT_CHARS / ok.length);
  const text = ok.map(p => `[${p.name}] (changed ${String(p.modified).slice(0, 10)})\n${p.body.slice(0, per)}`).join('\n\n');
  return { text, files: ok.map(p => p.name), ms: Date.now() - t0 };
}
