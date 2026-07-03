// chunk-only-sync.mjs
// Chunks every Drive file into mobius_docs with embedding=null — no Gemini
// calls at all. Existing chunks for a file are replaced only if the file's
// modifiedTime changed. Run the embedding backfill separately afterwards.
//
// Standalone maintenance script — run manually via `node -e`, not imported
// by server.js or any live request path. Same for rake-index.mjs.
import { createClient } from '@supabase/supabase-js';
import { getDriveClient, listFiles, extractText, chunkText } from './drive-indexer.mjs';

const DRIVE_FOLDER_ID = '1VVnAQfq___O30Jz7wW_ovRNQdk8jQdLj';

export async function chunkOnlySync(keyPath, supabaseUrl, supabaseKey) {
  const drive = getDriveClient(keyPath);
  const supabase = createClient(supabaseUrl, supabaseKey);

  const files = await listFiles(drive, DRIVE_FOLDER_ID);
  console.log(`[chunk-only] Found ${files.length} files`);

  let chunked = 0, skipped = 0, failed = 0;

  for (const file of files) {
    const { data: existing } = await supabase
      .from('mobius_docs')
      .select('id')
      .eq('filename', file.path)
      .eq('modified_at', file.modifiedTime)
      .limit(1);
    if (existing?.length) { skipped++; continue; }

    const text = await extractText(drive, file);
    if (!text.trim()) { skipped++; continue; }

    await supabase.from('mobius_docs').delete().eq('filename', file.path);

    const chunks = chunkText(text);
    const rows = chunks.map(chunk => ({
      filename: file.path,
      chunk,
      embedding: null,
      embedding_provider: null,
      modified_at: file.modifiedTime,
      source: 'gdrive',
      created_at: new Date().toISOString(),
    }));

    const { error } = await supabase.from('mobius_docs').insert(rows);
    if (error) { console.warn(`[chunk-only] insert failed for ${file.path}:`, error.message); failed++; }
    else { console.log(`[chunk-only] ${file.path} — ${rows.length} chunks`); chunked++; }
  }

  console.log(`[chunk-only] done — ${chunked} chunked, ${skipped} skipped (unchanged), ${failed} failed`);
  return { chunked, skipped, failed, total: files.length };
}
