
// rechunk-cli.mjs — cut the books on every library shelf into the larger search passages (docs/store.js LIBRARY_CHUNK).
//   node backend/rechunk-cli.mjs
// Only the search passages are replaced; each book's stored text, and the digests written from it, are not touched.
// Safe to run again. Passages lose their meaning-vectors (they are filled in again by `npm run maintain`).
import { supabase } from './db.js';
import { saveChunks, LIBRARY_CHUNK } from './docs/store.js';

const { data: shelves } = await supabase.from('mobius_sources').select('id, label').eq('library', true);
let before = 0, after = 0, books = 0;
for (const s of shelves || []) {
  const { data: files } = await supabase.from('mobius_docs_full').select('filename').like('filename', s.label.replace(/[\\%_]/g, m => '\\' + m) + '/%');
  for (const { filename } of files || []) {
    const { data: full } = await supabase.from('mobius_docs_full').select('content').eq('filename', filename).maybeSingle();
    const { data: old, count } = await supabase.from('mobius_docs').select('source, modified_at', { count: 'exact' }).eq('filename', filename).limit(1);
    const n = await saveChunks(filename, full.content, { source: old?.[0]?.source || 'gdrive:' + s.id, modifiedAt: old?.[0]?.modified_at || null, ...LIBRARY_CHUNK });
    before += count || 0; after += n; books++;
    console.log(`${filename.split('/').pop().slice(0, 60).padEnd(60)} ${String(count || 0).padStart(6)} → ${String(n).padStart(5)} passages`);
  }
}
console.log(`\n${books} books: ${before.toLocaleString()} passages → ${after.toLocaleString()}.`);
process.exit(0);
