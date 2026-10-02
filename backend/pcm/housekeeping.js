// pcm/housekeeping.js — Mobius tidies itself. Part of every maintenance run.
//   • writes anything trashed while it was running in the cloud into the laptop's Backup folder
//   • condenses a profile that was saved whole because no AI was available at the time
//   • rebuilds documents whose search chunks are missing
//   • retires old data: stale suggestions, long-forgotten notes, old traces, old trash
//   • measures how full Supabase is, so Settings can warn before the free plan runs out
// Nothing is deleted outright: it goes to the trash (pcm/backup.js) so it can be restored.
import { supabase } from '../db.js';
import { isoDaysAgo } from '../util.js';
import { mirror, trash, purgeTrash } from './backup.js';
import { setState } from './memory.js';
import { condenseProfileIfNeeded } from './profile.js';
import { tidyDevNotes, syncFile } from './devnotes.js';

export const STORAGE_LIMIT_BYTES = 500 * 1024 * 1024; // Supabase free plan, whole project

async function healDocs() {
  const { saveDoc } = await import('../docs/store.js'); // imported here to avoid a circular import
  const [{ data: full }, { data: stats }] = await Promise.all([
    supabase.from('mobius_docs_full').select('filename, content'),
    supabase.rpc('pcm_doc_stats'),
  ]);
  const chunked = new Set((stats || []).map(s => s.filename));
  const have = new Set((full || []).map(f => f.filename));
  let rebuilt = 0;
  for (const f of full || []) {
    if (!chunked.has(f.filename) && f.content?.trim()) { await saveDoc(f.filename, f.content); rebuilt++; } // text but no chunks: rebuild them
  }
  const chunksOnly = [...chunked].filter(f => !have.has(f)); // chunks but no stored whole text: reported, never deleted
  return { rebuilt, chunksWithoutText: chunksOnly };
}

async function tidyNotes() {
  const out = { expiredSuggestions: 0, retired: 0 };
  // Suggestions nobody looked at for two months lapse.
  const expired = await supabase.from('mobius_notes').update({ status: 'rejected', updated_at: new Date().toISOString() }, { count: 'exact' })
    .eq('status', 'proposed').lt('created_at', isoDaysAgo(60));
  out.expiredSuggestions = expired.count || 0;
  // Notes forgotten or rejected long ago go to the trash. (Until then they stop the same thing being suggested again.)
  const { data: old } = await supabase.from('mobius_notes').select('id, content, source, status, created_at')
    .in('status', ['forgotten', 'rejected']).lt('updated_at', isoDaysAgo(180)).limit(200);
  for (const n of old || []) {
    await trash('note', n.content.slice(0, 80), { content: n.content, source: n.source, status: n.status, created_at: n.created_at }, `${n.status} more than 180 days ago`);
    await supabase.from('mobius_notes').delete().eq('id', n.id);
    out.retired++;
  }
  return out;
}

async function pruneTraces() {
  const r = await supabase.from('mobius_traces').delete({ count: 'exact' }).lt('created_at', isoDaysAgo(14));
  return { deleted: r.count || 0 };
}

export async function storageReport() {
  const { data } = await supabase.rpc('pcm_storage');
  const rows = data || [];
  const db = Number(rows.find(r => r.name === 'database')?.bytes || 0);
  return {
    at: new Date().toISOString(),
    databaseBytes: db, limitBytes: STORAGE_LIMIT_BYTES, percent: Math.round(db / STORAGE_LIMIT_BYTES * 100),
    tables: rows.filter(r => r.name !== 'database').slice(0, 6).map(r => ({ name: r.name, bytes: Number(r.bytes) })),
  };
}

export async function housekeeping() {
  if (!supabase) return { skipped: 'no database' };
  const report = {};
  const steps = [
    ['backupFolder', () => mirror()],
    ['profile', () => condenseProfileIfNeeded()],
    ['documents', () => healDocs()],
    ['notes', () => tidyNotes()],
    ['devNotes', async () => { const r = await tidyDevNotes(); await syncFile(); return r; }],
    ['traces', () => pruneTraces()],
    ['trash', () => purgeTrash()],
    ['storage', () => storageReport()],
  ];
  for (const [name, run] of steps) {
    try { report[name] = await run(); } catch (e) { report[name] = { error: e.message }; }
  }
  try { await setState('housekeeping', { at: new Date().toISOString(), report }); } catch { /* table may not exist yet */ }
  return report;
}
