// pcm/projects.js — the projects shown under "Your projects" in Settings (mobius_memory kind 'project').
// Mobius also writes and updates these notes itself from the conversations (maintain.js); this module is
// Boon's side: read them, add one, edit one, remove one. Removing goes to the backup first, so it can be restored.

import { listActive, put, archiveActive } from './memory.js';
import { trash } from './backup.js';

export const PROJECT_MAX = 1500;   // same limit maintain.js applies to the notes it writes
const MAX_KEYWORDS = 8;

const flat = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const keywordList = k => (Array.isArray(k) ? k : String(k ?? '').split(','))
  .map(x => flat(x, 40)).filter(Boolean).slice(0, MAX_KEYWORDS);

export async function listProjects() {
  return (await listActive('project')).map(p => ({
    name: p.key, content: p.content || '', keywords: p.keywords || [], updatedAt: p.updated_at,
  }));
}

// Add a project, or replace the note of an existing one (matched by name, ignoring case).
export async function saveProject({ name, content, keywords }) {
  const title = flat(name, 80);
  const text = String(content ?? '').trim();
  if (!title) throw new Error('A project needs a name.');
  if (!text) throw new Error('A project needs a note: its goal, where it stands, what is open.');
  if (text.length > PROJECT_MAX) throw new Error(`That note is ${text.length.toLocaleString()} characters; the limit is ${PROJECT_MAX.toLocaleString()}. Shorten it and save again.`);
  const existing = (await listActive('project')).find(p => p.key.toLowerCase() === title.toLowerCase());
  await put('project', existing ? existing.key : title, { content: text, keywords: keywordList(keywords) });
  return { name: existing ? existing.key : title, created: !existing };
}

export async function removeProject(name) {
  const existing = (await listActive('project')).find(p => p.key.toLowerCase() === flat(name, 80).toLowerCase());
  if (!existing) throw new Error('That project is no longer on the list.');
  await trash('memory', existing.key, { kind: 'project', key: existing.key, content: existing.content, keywords: existing.keywords || [] }, 'removed by you in Settings');
  await archiveActive('project', existing.key);
  return { name: existing.key };
}
