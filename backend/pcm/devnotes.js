// pcm/devnotes.js — Boon's to-do list for Mobius itself: instructions and improvements typed in
// Settings (from the phone, say) to be worked through at the next session on the laptop. Kept in
// Supabase so it is the same everywhere; when Mobius runs on the laptop it also keeps an up-to-date
// copy in _dev\devnotes.md for anyone working in the project folder. Never sent to an AI model.
import fs from 'fs';
import path from 'path';
import { supabase } from '../db.js';
import { ROOT, IS_VERCEL } from '../config.js';
import { isoDaysAgo } from '../util.js';
import { trash } from './backup.js';

const T = 'mobius_devnotes';
const FILE = path.join(ROOT, '_dev', 'devnotes.md');
const clean = s => String(s ?? '').replace(/\r/g, '').trim().slice(0, 2000);

export async function listDevNotes() {
  if (!supabase) return { open: [], done: [] };
  const [open, done] = await Promise.all([
    supabase.from(T).select('*').eq('status', 'open').order('id'),
    supabase.from(T).select('*').eq('status', 'done').order('done_at', { ascending: false }).limit(30),
  ]);
  return { open: open.data || [], done: done.data || [] };
}

export async function addDevNote(content) {
  const text = clean(content);
  if (!text) throw new Error('A note cannot be empty');
  const { data, error } = await supabase.from(T).insert({ content: text }).select('id').single();
  if (error) throw new Error(error.message);
  syncFile().catch(() => {});
  return data.id;
}

export async function updateDevNote(id, content) {
  const text = clean(content);
  if (!text) throw new Error('A note cannot be empty');
  const { error } = await supabase.from(T).update({ content: text }).eq('id', id);
  if (error) throw new Error(error.message);
  syncFile().catch(() => {});
}

// done = true marks it finished (with a line saying what was done); false reopens it.
export async function setDevNoteDone(id, done, result = null) {
  const { error } = await supabase.from(T).update(done
    ? { status: 'done', done_at: new Date().toISOString(), result: result ? clean(result).slice(0, 500) : null }
    : { status: 'open', done_at: null, result: null }).eq('id', id);
  if (error) throw new Error(error.message);
  syncFile().catch(() => {});
}

// Removed notes go to the backup first, like everything else.
export async function removeDevNote(id, reason = 'deleted by Boon') {
  const { data: row } = await supabase.from(T).select('*').eq('id', id).maybeSingle();
  if (!row) return;
  await trash('devnote', row.content.slice(0, 80), { content: row.content, status: row.status, result: row.result, created_at: row.created_at }, reason);
  const { error } = await supabase.from(T).delete().eq('id', id);
  if (error) throw new Error(error.message);
  syncFile().catch(() => {});
}

export async function restoreDevNote(p) {
  const { error } = await supabase.from(T).insert({ content: p.content, status: p.status || 'open', result: p.result || null, created_at: p.created_at || undefined });
  if (error) throw new Error(error.message);
}

// Finished items more than 90 days old are retired (into the backup).
export async function tidyDevNotes() {
  const { data } = await supabase.from(T).select('id').eq('status', 'done').lt('done_at', isoDaysAgo(90)).limit(100);
  for (const n of data || []) await removeDevNote(n.id, 'finished more than 90 days ago');
  return { retired: (data || []).length };
}

// Laptop only: a readable copy of the open items, so the list is at hand in the project folder.
export async function syncFile() {
  if (IS_VERCEL || !supabase) return;
  const { open } = await listDevNotes();
  const when = iso => new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Australia/Perth' });
  const body = open.length
    ? open.map(n => `## #${n.id} (added ${when(n.created_at)})\n${n.content}\n`).join('\n')
    : 'Nothing open.\n';
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, `# Mobius development notes: open items\n\nTyped by Boon in Settings. Source of truth: table mobius_devnotes in Supabase. Refreshed ${new Date().toLocaleString('en-AU', { timeZone: 'Australia/Perth' })}.\n\n${body}`, 'utf8');
}
