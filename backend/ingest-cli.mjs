
// ingest-cli.mjs — put files from this computer into Mobius's archive, with no size limit.
//   npm run ingest -- "C:\path\to\book.pdf" --label "Scriptura Fidelium"
//   npm run ingest -- "C:\path\to\a folder" --label "Scriptura Fidelium"      (PDF, Word, text and Markdown files, folders included)
// The live site can only read Drive files under 25 MB and about 330 pages; this has neither limit. With --label the
// file is filed in that linked folder ("<label>/<file name>"), exactly where reading the folder from Drive would put it.
// Afterwards `npm run maintain` writes the digests and embeds the new text for search.
import fs from 'fs';
import path from 'path';
import { supabase } from './db.js';
import { extractFromBuffer } from './docs/extract.js';
import { saveDoc, LIBRARY_CHUNK } from './docs/store.js';
import { listSources } from './docs/sources.js';
import { storageReport } from './pcm/housekeeping.js';

const MAX_CHARS = 6000000;
const STOP_AT_PERCENT = 85;
const KINDS = /\.(pdf|docx|epub|xlsx|pptx|html?|txt|md)$/i;

const args = process.argv.slice(2);
const flag = n => { const i = args.indexOf(n); return i < 0 ? null : args.splice(i, 2)[1] || null; };
const label = flag('--label');
const target = args[0];
if (!target || !fs.existsSync(target)) {
  console.log('Usage: npm run ingest -- "<file or folder>" [--label "<linked folder name>"]');
  process.exit(1);
}
if (!supabase) { console.log('No database connection (check SUPABASE_URL and SUPABASE_KEY in .env).'); process.exit(1); }

let source = 'upload', prefix = '', chunking = {};
if (label) {
  const src = (await listSources()).find(s => s.label.toLowerCase() === label.toLowerCase());
  if (!src) { console.log(`No linked folder is called "${label}". Linked: ${(await listSources()).map(s => s.label).join(', ') || 'none'}.`); process.exit(1); }
  source = 'gdrive:' + src.id; prefix = src.label + '/';
  if (src.library) chunking = LIBRARY_CHUNK; // a library shelf is cut into larger passages (about a third of the space)
}

const files = [];
(function walk(p) {
  if (fs.statSync(p).isDirectory()) fs.readdirSync(p).sort().forEach(f => walk(path.join(p, f)));
  else if (KINDS.test(p)) files.push(p);
})(target);
if (!files.length) { console.log('No PDF, Word, EPUB, Excel, PowerPoint, HTML, text or Markdown files found there.'); process.exit(1); }

let added = 0;
for (const file of files) {
  const rep = await storageReport().catch(() => null);
  if (rep && rep.percent >= STOP_AT_PERCENT) { console.log(`Stopped: the database is ${rep.percent}% full. Free some space first (Mobius Settings → Storage).`); break; }
  const name = prefix + path.basename(file);
  const mb = (fs.statSync(file).size / 1048576).toFixed(1);
  process.stdout.write(`${name} (${mb} MB) … `);
  try {
    const text = (await extractFromBuffer(fs.readFileSync(file), file)).slice(0, MAX_CHARS);
    if (!text.trim()) { console.log('no readable text (a scan?), skipped'); continue; }
    const n = await saveDoc(name, text, { source, modifiedAt: fs.statSync(file).mtime.toISOString(), ...chunking });
    console.log(`${text.length.toLocaleString()} characters, ${n.toLocaleString()} search passages (about ${Math.round(n * (chunking.size ? 3 : 7.5) / 1024)} MB of database)`);
    added++;
  } catch (e) { console.log('failed: ' + e.message); }
}
console.log(`\n${added} of ${files.length} file${files.length === 1 ? '' : 's'} added. Next: npm run maintain   (writes the digests and embeds the text for search)`);
process.exit(0);
