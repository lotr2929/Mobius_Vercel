// pcm/backup.js — nothing Mobius removes is gone for good.
// Whatever it deletes (a document, an older profile version, a stale note) goes to the trash table
// in Supabase first, with everything needed to restore it. That is the source of truth, so it
// works wherever Mobius runs. When Mobius runs on the laptop it also writes each item as a file
// into the Backup folder (config BACKUP_DIR); items trashed while it ran in the cloud are written
// the next time it runs on the laptop. The trash is cleared after TRASH_DAYS.
import fs from 'fs';
import path from 'path';
import { supabase } from '../db.js';
import { BACKUP_DIR, IS_VERCEL, TRASH_DAYS } from '../config.js';
import { isoDaysAgo } from '../util.js';
import { addNote } from './notes.js';
import { put } from './memory.js';

const T = 'mobius_trash';
export const canMirror = () => !IS_VERCEL;

export async function trash(kind, label, payload, reason) {
  if (!supabase) throw new Error('No database: refusing to delete something that cannot be backed up');
  const { data, error } = await supabase.from(T).insert({ kind, label: String(label).slice(0, 200), reason, payload }).select('id').single();
  if (error) throw new Error('trash: ' + error.message);
  mirror().catch(() => {}); // on the laptop the file appears straight away
  return data.id;
}

const stamp = iso => new Date(iso).toLocaleString('sv-SE', { timeZone: 'Australia/Perth' }).replace(/[-:]/g, '').replace(' ', '_').slice(0, 13);
const safeName = s => String(s).replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60);

// Write trash that has not yet reached the Backup folder. Only does anything on the laptop.
export async function mirror() {
  if (!canMirror() || !supabase) return { written: 0 };
  const { data, error } = await supabase.from(T).select('*').eq('mirrored', false).order('id').limit(200);
  if (error || !data?.length) return { written: 0 };
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  let written = 0;
  for (const row of data) {
    const file = path.join(BACKUP_DIR, `${stamp(row.created_at)}_${row.kind}_${safeName(row.label)}_${row.id}.json`);
    fs.writeFileSync(file, JSON.stringify({ id: row.id, kind: row.kind, label: row.label, reason: row.reason, removedAt: row.created_at, payload: row.payload }, null, 2), 'utf8');
    const { error: e2 } = await supabase.from(T).update({ mirrored: true }).eq('id', row.id);
    if (!e2) written++;
  }
  return { written };
}

export async function listTrash(limit = 100) {
  if (!supabase) return [];
  const { data } = await supabase.from(T).select('id, created_at, kind, label, reason, mirrored, restored_at')
    .order('id', { ascending: false }).limit(limit);
  return data || [];
}

export async function trashStats() {
  if (!supabase) return { items: 0, waitingForLaptop: 0 };
  const count = async narrow => (await narrow(supabase.from(T).select('id', { count: 'exact', head: true }))).count ?? 0;
  return { items: await count(q => q), waitingForLaptop: await count(q => q.eq('mirrored', false)) };
}

// Put an item back where it came from.
export async function restoreTrash(id) {
  const { data: row } = await supabase.from(T).select('*').eq('id', id).maybeSingle();
  if (!row) throw new Error('That item is no longer in the backup');
  const p = row.payload;
  if (row.kind === 'document') {
    const { saveDoc } = await import('../docs/store.js'); // imported here to avoid a circular import
    await saveDoc(p.filename, p.content, { source: p.source || 'upload', modifiedAt: p.modified_at || null });
  } else if (row.kind === 'note') {
    await addNote(p.content, { source: p.source || 'asked', status: 'active' });
  } else if (row.kind === 'memory') {
    await put(p.kind, p.key, { content: p.content });
  } else {
    throw new Error('Do not know how to restore a ' + row.kind);
  }
  await supabase.from(T).update({ restored_at: new Date().toISOString() }).eq('id', id);
  return { label: row.label, kind: row.kind };
}

export async function deleteTrash(id) {
  const { error } = await supabase.from(T).delete().eq('id', id);
  if (error) throw new Error(error.message);
}

// Clear out old trash. Items already written to the Backup folder go after TRASH_DAYS; items that
// never reached it are kept for twice as long.
export async function purgeTrash() {
  if (!supabase) return { purged: 0 };
  const a = await supabase.from(T).delete({ count: 'exact' }).eq('mirrored', true).lt('created_at', isoDaysAgo(TRASH_DAYS));
  const b = await supabase.from(T).delete({ count: 'exact' }).lt('created_at', isoDaysAgo(TRASH_DAYS * 2));
  return { purged: (a.count || 0) + (b.count || 0) };
}
