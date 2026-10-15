
// backup-cli.mjs — a copy of everything Mobius cannot rebuild, kept in Boon's own Google Drive.
//   npm run backup                 make a backup now
//   npm run backup -- --if-due     only if the newest one is over 20 hours old
//   npm run backup -- --daemon     stay running, check every 3 hours (started at login by the Startup folder)
// Written into "<Drive>\My Drive\Atlas\_mobius" through the Google Drive desktop app (no sign-in or write permission
// is needed for Mobius itself), as one compressed file per run; the newest 7 are kept. If that folder is not there
// (Drive not mounted) it goes to C:\_Personal\_Mobius\Backup\db instead.
// Saved: conversations, memory (profile, projects, week), notes, settings and state, development notes, linked-folder list,
// digests, the trash (everything Mobius has removed), and the text of documents that were uploaded by hand.
// Sealed private chats are NOT written there (Atlas is read by other AIs); they are copied to C:\_Personal\_Mobius\Backup\sealed on this PC only.
// Not saved: what can be rebuilt (search passages, embeddings, books read from Drive, scripture texts, traces) and what is secret
// (the sealed Google token, passkeys).
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { supabase } from './db.js';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

const DRIVE_DIR = process.env.BACKUP_DRIVE_DIR || 'J:\\My Drive\\Atlas\\_mobius'; // the atlas is the shared "Atlas" folder inside My Drive (moved there 10 Oct 2026)
const LOCAL_DIR = 'C:\\_Personal\\_Mobius\\Backup\\db';
const KEEP = 7, DUE_HOURS = 20, CHECK_EVERY_MS = 3 * 3600e3;
const SKIP = new Set(['mobius_docs', 'mobius_bible', 'mobius_traces', 'mobius_google', 'mobius_passkeys', 'mobius_sealed_messages']); // sealed private chats: never in the Drive backup
const SEALED_DIR = 'C:\\_Personal\\_Mobius\\Backup\\sealed'; // their copy stays on this PC (not in Google Drive)
const DROP_COLUMNS = ['embedding', 'fts'];

const stamp = () => { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`; }; // 20261004-1130, local time
const say = m => console.log(`[${new Date().toLocaleString('en-AU', { timeZone: 'Australia/Perth' })}] ${m}`);

function targetDir() {
  const root = path.parse(DRIVE_DIR).root;
  // Use the Drive only if its parent folder (the shared Atlas folder) is really there; never create a stray one beside it.
  if (fs.existsSync(path.join(root, 'My Drive')) && fs.existsSync(path.dirname(DRIVE_DIR))) { fs.mkdirSync(DRIVE_DIR, { recursive: true }); return DRIVE_DIR; }
  fs.mkdirSync(LOCAL_DIR, { recursive: true });
  say(`Drive folder not found (${DRIVE_DIR}); using ${LOCAL_DIR}`);
  return LOCAL_DIR;
}

const newest = dir => fs.readdirSync(dir).filter(f => /^mobius-\d{8}-\d{4}\.json\.gz$/.test(f)).sort().at(-1);

async function allRows(table) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    let q = supabase.from(table).select('*').range(from, from + 999);
    if (table === 'mobius_docs_full') q = q.not('filename', 'like', '%/%'); // only hand-uploaded files; the rest are read again from Drive
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...data.map(r => { for (const c of DROP_COLUMNS) delete r[c]; return r; }));
    if (data.length < 1000) break;
  }
  return rows;
}

// Sealed private chats ("Private:" messages) are backed up to this PC only. The Drive backup above sits in the Atlas folder, which other AIs read.
async function backupSealedLocally() {
  const { data, error } = await supabase.from('mobius_sealed_messages').select('*').order('id');
  if (error) throw new Error('mobius_sealed_messages: ' + error.message);
  if (!data?.length) return null;
  fs.mkdirSync(SEALED_DIR, { recursive: true });
  const file = path.join(SEALED_DIR, `sealed-${stamp()}.json.gz`);
  fs.writeFileSync(file, zlib.gzipSync(JSON.stringify({ made_at: new Date().toISOString(), rows: data })));
  for (const f of fs.readdirSync(SEALED_DIR).filter(f => /^sealed-\d{8}-\d{4}\.json\.gz$/.test(f)).sort().slice(0, -KEEP)) fs.unlinkSync(path.join(SEALED_DIR, f));
  say(`Sealed chats: ${data.length} messages copied to ${file} (this PC only).`);
  return file;
}
export async function backupNow() {
  if (!supabase) throw new Error('No database connection.');
  const spec = await (await fetch(`${SUPABASE_URL}/rest/v1/`, { headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY } })).json();
  const tables = Object.keys(spec.definitions || {}).filter(t => t.startsWith('mobius_') && !SKIP.has(t)).sort();
  if (!tables.length) throw new Error('Could not list the tables.');
  const out = { made_at: new Date().toISOString(), note: 'Mobius backup. Embeddings and rebuildable text are left out.', tables: {} };
  const counts = [];
  for (const t of tables) {
    try { out.tables[t] = await allRows(t); counts.push(`${t} ${out.tables[t].length}`); }
    catch (e) { counts.push(`${t} FAILED (${e.message.slice(0, 60)})`); out.tables[t] = { error: e.message }; }
  }
  const dir = targetDir();
  const file = path.join(dir, `mobius-${stamp()}.json.gz`);
  fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(out)));
  const old = fs.readdirSync(dir).filter(f => /^mobius-\d{8}-\d{4}\.json\.gz$/.test(f)).sort().slice(0, -KEEP);
  for (const f of old) fs.unlinkSync(path.join(dir, f));
  say(`Backup written: ${file} (${(fs.statSync(file).size / 1024).toFixed(0)} KB). ${counts.join(', ')}.${old.length ? ` Removed ${old.length} older.` : ''}`);
  await backupSealedLocally().catch(e => say('Sealed backup failed: ' + e.message));
  return file;
}

function isDue() {
  const dir = targetDir();
  const f = newest(dir);
  if (!f) return true;
  return Date.now() - fs.statSync(path.join(dir, f)).mtimeMs > DUE_HOURS * 3600e3;
}

const args = process.argv.slice(2);
if (args.includes('--daemon')) {
  say('Backup watcher started.');
  for (;;) {
    try { if (isDue()) await backupNow(); } catch (e) { say('Backup failed: ' + e.message); }
    await new Promise(r => setTimeout(r, CHECK_EVERY_MS));
  }
} else {
  try {
    if (args.includes('--if-due') && !isDue()) say('A recent backup exists; nothing to do.');
    else await backupNow();
  } catch (e) { say('Backup failed: ' + e.message); process.exitCode = 1; }
  process.exit();
}
