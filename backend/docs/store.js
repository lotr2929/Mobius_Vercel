// docs/store.js — the document store (archive tier).
//   mobius_docs_full  one row per file, the whole text (returned when a file is named)
//   mobius_docs       overlapping chunks for search; embedded later in the background
import { supabase } from '../db.js';

const CHUNK_SIZE = 600;
const CHUNK_OVERLAP = 100;

export function chunkText(text) {
  const chunks = [];
  for (let i = 0; i < text.length; i += CHUNK_SIZE - CHUNK_OVERLAP) chunks.push(text.slice(i, i + CHUNK_SIZE));
  return chunks.filter(c => c.trim().length > 20);
}

// Replaces any earlier version of the file. Chunks are saved without vectors, so an
// upload is quick and keyword-searchable at once; semantic search follows once embedded.
export async function saveDoc(filename, text, { source = 'upload', modifiedAt = null } = {}) {
  if (!supabase) return 0;
  const now = new Date().toISOString();
  await supabase.from('mobius_docs_full').upsert({ filename, content: text, updated_at: now });
  await supabase.from('mobius_docs').delete().eq('filename', filename);
  const rows = chunkText(text).map(chunk => ({ filename, chunk, source, modified_at: modifiedAt, created_at: now }));
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await supabase.from('mobius_docs').insert(rows.slice(i, i + 200));
    if (error) throw new Error('saving chunks: ' + error.message);
  }
  return rows.length;
}

// Does the query name a specific stored file? Match the file's name (minus extension)
// against the query, either whole or by all its significant words.
export async function findNamedDoc(query) {
  if (!supabase) return null;
  const { data } = await supabase.from('mobius_docs_full').select('filename');
  const q = query.toLowerCase();
  for (const { filename } of data || []) {
    const stem = filename.replace(/\.(pdf|txt|md|docx?|csv|json|js|py)$/i, '')
      .replace(/[_-]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
    if (stem.length > 6 && q.includes(stem)) return filename;
    const words = stem.split(' ').filter(w => w.length > 3);
    if (words.length >= 2 && words.every(w => q.includes(w))) return filename;
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

export async function deleteDoc(filename) {
  if (!supabase) return;
  await supabase.from('mobius_docs').delete().eq('filename', filename);
  await supabase.from('mobius_docs_full').delete().eq('filename', filename);
}
