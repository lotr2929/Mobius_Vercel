// docs/store.js — the document store (archive tier).
//   mobius_docs_full  one row per file, the whole text (returned when a file is named)
//   mobius_docs       overlapping chunks for search; embedded later in the background
import { supabase } from '../db.js';
import { trash } from '../pcm/backup.js';

const CHUNK_SIZE = 600;
const CHUNK_OVERLAP = 100;

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

// Books on a library shelf are cut into larger passages with no overlap: the search machinery (keyword index, meaning-vector)
// costs far more per passage than the text does, so 1,800 characters instead of 600+overlap cuts a book's footprint by about two thirds.
export const LIBRARY_CHUNK = { size: 1800, overlap: 0 };

export function chunkText(text, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
  const chunks = [];
  if (overlap === 0) { // cut at a paragraph or sentence end near the limit, so a passage rarely stops mid-sentence
    for (let i = 0; i < text.length;) {
      let end = Math.min(text.length, i + size);
      if (end < text.length) {
        const win = text.slice(i + Math.floor(size * 0.7), end);
        const cut = Math.max(win.lastIndexOf('\n\n'), win.lastIndexOf('. '), win.lastIndexOf('.\n'));
        if (cut > 0) end = i + Math.floor(size * 0.7) + cut + 1;
      }
      chunks.push(text.slice(i, end).replace(LONE_SURROGATE, ''));
      i = end;
    }
  } else {
    for (let i = 0; i < text.length; i += size - overlap) chunks.push(text.slice(i, i + size).replace(LONE_SURROGATE, '')); // a cut can split an emoji-like pair
  }
  return chunks.filter(c => c.trim().length > 20);
}

// Replaces the search passages of a file (not its stored text, so digests stay valid). Passages are saved without vectors, so an
// upload is quick and keyword-searchable at once; semantic search follows once embedded.
export async function saveChunks(filename, text, { source = 'upload', modifiedAt = null, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP } = {}) {
  const now = new Date().toISOString();
  await supabase.from('mobius_docs').delete().eq('filename', filename);
  const rows = chunkText(text, size, overlap).map(chunk => ({ filename, chunk, source, modified_at: modifiedAt, created_at: now }));
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await supabase.from('mobius_docs').insert(rows.slice(i, i + 200));
    if (error) throw new Error('saving chunks: ' + error.message);
  }
  return rows.length;
}

// Replaces any earlier version of the file: its whole text, then its passages.
export async function saveDoc(filename, text, opts = {}) {
  if (!supabase) return 0;
  // PDF text can hold NUL characters and unpaired surrogates, which the database refuses ("unsupported Unicode escape sequence").
  text = String(text).replace(/\u0000/g, '').replace(LONE_SURROGATE, '');
  await supabase.from('mobius_docs_full').upsert({ filename, content: text, updated_at: new Date().toISOString() });
  return saveChunks(filename, text, opts);
}

// Does the query name a specific stored file? Match the file's name (minus extension)
// against the query, either whole or by all its significant words.
// Names and queries are compared without brackets, punctuation and the "(Z-Library)" tag that downloaded books carry.
const norm = s => String(s).toLowerCase()
  .replace(/\(?\bz[- ]?library\b\)?|\(?\bpdfdrive\b\)?|\(?\blibgen\b\)?/g, ' ')
  .replace(/[()[\]{}.,:;'"’“”!?]/g, ' ').replace(/[_-]/g, ' ').replace(/\s+/g, ' ').trim();
export async function findNamedDoc(query) {
  if (!supabase) return null;
  const { data } = await supabase.from('mobius_docs_full').select('filename');
  const q = norm(query);
  for (const { filename } of data || []) {
    // Files read from a linked folder are stored as "<folder>/<path>"; the name Boon would use is the file's own.
    const stem = norm(filename.split('/').pop().replace(/\.(pdf|txt|md|docx?|csv|json|js|py)$/i, ''));
    if (stem.length > 6 && q.includes(stem)) return filename;
    const words = stem.split(' ').filter(w => w.length > 3);
    if (words.length >= 2 && words.every(w => q.includes(w))) return filename;
    // A long title is rarely typed in full: its first three words (without a leading "a" or "the") are enough.
    // Not for exported chats, whose names end in a hash and begin with ordinary words ("chesterton and the devil-6a40…").
    const lead = stem.replace(/^(?:a|an|the) /, '').split(' ').slice(0, 3).join(' ');
    if (stem.split(' ').length >= 5 && lead.length >= 14 && !/\b[0-9a-f]{8}\b/.test(stem) && q.includes(lead)) return filename;
  }
  return null;
}

export async function getFullDoc(filename) {
  if (!supabase) return null;
  const { data } = await supabase.from('mobius_docs_full').select('content').eq('filename', filename).maybeSingle();
  return data?.content || null;
}

// Files with how many chunks are embedded (the UI shows "searchable" when all are).
export async function listDocs() {
  if (!supabase) return [];
  const { data: files } = await supabase.from('mobius_docs_full')
    .select('filename, updated_at').order('updated_at', { ascending: false });
  const { data: stats } = await supabase.rpc('pcm_doc_stats');
  const byFile = new Map((stats || []).map(s => [s.filename, s]));
  return (files || []).map(f => ({
    filename: f.filename,
    created_at: f.updated_at,
    chunks: Number(byFile.get(f.filename)?.total || 0),
    embedded: Number(byFile.get(f.filename)?.embedded || 0),
  }));
}

// Removing a document moves its whole text to the backup first (restorable from Settings).
// If the backup cannot be made, nothing is deleted.
export async function deleteDoc(filename, reason = 'deleted by Boon') {
  if (!supabase) return;
  const { data: full } = await supabase.from('mobius_docs_full').select('content').eq('filename', filename).maybeSingle();
  if (full?.content) {
    const { data: first } = await supabase.from('mobius_docs').select('source, modified_at').eq('filename', filename).limit(1);
    await trash('document', filename, { filename, content: full.content, source: first?.[0]?.source || 'upload', modified_at: first?.[0]?.modified_at || null }, reason);
  }
  await supabase.from('mobius_docs').delete().eq('filename', filename);
  await supabase.from('mobius_docs_full').delete().eq('filename', filename);
  await supabase.from('mobius_digests').delete().eq('filename', filename); // derived, so rebuilt if the file returns
}
