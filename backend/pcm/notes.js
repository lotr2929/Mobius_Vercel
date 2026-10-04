// pcm/notes.js — things Boon asks Mobius to remember, and suggestions Mobius finds for him.
//   active    saved, and sent to the model on every turn
//   proposed  suggested by the review job (maintain.js); waits for Boon: "save 14", "drop 15"
//   forgotten / rejected  kept for the record so the same thing is not suggested again
//
// Commands are plain sentences at the start of a message, matched by rules rather than by a
// model, so they work instantly and even when every model is down:
//   Remember that ... | Note: ... | Keep in mind ... | From now on ...
//   Forget ... | Forget #14
//   Show notes | Show suggestions | Save 14, 16 | Save all | Drop 15 | Drop all
import { supabase } from '../db.js';

const T = 'mobius_notes';
const STOP = new Set('the and that this with for you your are was were have has had not but about from they them his her its our can will would should what when where who how why all any out too very also just than then into over under boon'.split(' '));
const norm = s => String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const words = s => [...new Set(norm(s).split(' ').filter(w => w.length > 2 && !STOP.has(w)))];

// ── Storage ──────────────────────────────────────────────────────────────────
export async function listNotes(statuses = ['active', 'proposed']) {
  if (!supabase) return [];
  const { data, error } = await supabase.from(T).select('id, content, source, status, created_at')
    .in('status', statuses).order('created_at', { ascending: false }).limit(400);
  if (error) { console.warn('[notes]', error.message); return []; }
  return data || [];
}

// Rewrite the text of a note (from the Memory page).
export async function updateNote(id, content) {
  const text = String(content).trim().replace(/\s+/g, ' ').slice(0, 500);
  if (!text) throw new Error('A note cannot be empty');
  const { error } = await supabase.from(T).update({ content: text, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) throw new Error('notes: ' + error.message);
}

export async function setStatus(ids, status) {
  if (!ids.length) return;
  const { error } = await supabase.from(T).update({ status, updated_at: new Date().toISOString() }).in('id', ids);
  if (error) throw new Error('notes: ' + error.message);
}

// Adds a note unless the same words are already there. A note Boon once forgot comes back if he
// asks for it again; one he rejected is not suggested a second time.
export async function addNote(content, { source = 'asked', status = 'active' } = {}) {
  const text = String(content).trim().replace(/\s+/g, ' ').slice(0, 500);
  if (!text) return { error: 'empty' };
  const all = await listNotes(['active', 'proposed', 'forgotten', 'rejected']);
  const same = all.find(n => norm(n.content) === norm(text));
  if (same) {
    if (same.status === 'active') return { id: same.id, duplicate: true };
    if (status === 'active') { await setStatus([same.id], 'active'); return { id: same.id, restored: true }; }
    if (same.status === 'proposed') return { id: same.id, duplicate: true };
    return { id: same.id, duplicate: true, skipped: true }; // previously forgotten or rejected: do not re-suggest
  }
  const { data, error } = await supabase.from(T).insert({ content: text, source, status }).select('id').single();
  if (error) throw new Error('notes: ' + error.message);
  return { id: data.id };
}

// Notes ranked by how many of the query's words they share.
export function rankNotes(notes, text) {
  const q = words(text);
  if (!q.length) return [];
  return notes
    .map(note => { const nw = new Set(words(note.content)); return { note, score: q.filter(w => nw.has(w)).length / q.length }; })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score);
}

// The active notes for the prompt: all of them if they fit, otherwise the most relevant to this
// message plus the newest.
export function notesForPrompt(active, queryText, cap = 3000) {
  const line = n => `- (#${n.id}, ${n.created_at.slice(0, 10)}) ${n.content}`;
  const all = active.map(line).join('\n');
  if (all.length <= cap) return all;
  const picked = new Map();
  for (const x of rankNotes(active, queryText).slice(0, 15)) picked.set(x.note.id, x.note);
  for (const n of active.slice(0, 10)) picked.set(n.id, n); // active is newest first
  const out = [];
  let size = 0;
  for (const n of picked.values()) { const l = line(n); if (size + l.length > cap) break; out.push(l); size += l.length + 1; }
  return `${out.join('\n')}\n(${active.length - out.length} more saved notes are not shown here)`;
}

// ── Commands ─────────────────────────────────────────────────────────────────
const IDS = '(all|#?\\d+(?:\\s*(?:,|and|&)?\\s*#?\\d+)*)';
const REMEMBER = /^(?:please\s+)?(?:remember|make a note|note|keep in mind|don'?t forget)(?:\s+that)?\s*[:,-]?\s+(.{3,})$/is;
const STANDING = /^(?:from now on|going forward|in future)\b[,:]?\s*(.{3,})$/is;
const FORGET = /^(?:please\s+)?(?:forget(?:\s+(?:that|about|the note about|the note))?|(?:delete|remove)\s+(?:the\s+)?(?:note|memory)(?:\s+(?:about|that))?)\s*[:,-]?\s+(.{1,})$/is;
const SHOW_NOTES = /^(?:show|list|display)(?:\s+me)?(?:\s+(?:all|my|the|your))*\s+(?:saved\s+)?(?:notes|memories)\b/i;
const SHOW_SUGGESTIONS = /^(?:(?:show|list|review)(?:\s+me)?(?:\s+(?:the|my|any|all|your))*\s+(?:suggestions|suggested notes|proposed notes|proposals)\b|any suggestions\b)/i;
const APPROVE = new RegExp('^(?:save|keep|approve|accept)\\s+' + IDS + '\\s*[.!]?$', 'i');
const REJECT = new RegExp('^(?:drop|reject|discard|dismiss)\\s+' + IDS + '\\s*[.!]?$', 'i');

// → { action, text?, ids? } or null when the message is an ordinary question.
export function parseCommand(query, hasSuggestions) {
  const q = query.trim();
  if (!q || q.length > 600) return null;
  const asking = q.endsWith('?');
  let m;
  if (!asking && (m = q.match(REMEMBER))) return { action: 'remember', text: m[1].trim() };
  if (!asking && (m = q.match(STANDING))) return { action: 'remember', text: q };
  if (!asking && (m = q.match(FORGET)) && !/^(?:it|that|this|them|everything|about it)\W*$/i.test(m[1].trim())) return { action: 'forget', text: m[1].trim() };
  if (SHOW_NOTES.test(q)) return { action: 'list_notes' };
  if (SHOW_SUGGESTIONS.test(q)) return { action: 'list_suggestions' };
  if (hasSuggestions && (m = q.match(APPROVE))) return { action: 'approve', ids: m[1].toLowerCase() === 'all' ? 'all' : [...m[1].matchAll(/\d+/g)].map(x => Number(x[0])) };
  if (hasSuggestions && (m = q.match(REJECT))) return { action: 'reject', ids: m[1].toLowerCase() === 'all' ? 'all' : [...m[1].matchAll(/\d+/g)].map(x => Number(x[0])) };
  return null;
}

const block = (notes, withDate = true) => notes.map(n => `#${n.id}${withDate ? ` (${n.created_at.slice(0, 10)})` : ''}: ${n.content}`).join('\n');

// Carries out a command and returns what happened, as text for the model to report to Boon,
// or null when it turns out not to be a command after all (e.g. "save 5 minutes").
export async function runCommand(cmd, { active, pending }) {
  switch (cmd.action) {
    case 'remember': {
      const r = await addNote(cmd.text, { source: 'asked', status: 'active' });
      if (r.error) return null;
      const how = r.restored ? 'restored an earlier note' : r.duplicate ? 'already had this note' : 'saved a new note';
      return `Done: ${how} #${r.id}: "${cmd.text}". Confirm to Boon in one short sentence. It will be sent to you with every message from now on.`;
    }
    case 'forget': {
      const idMatch = cmd.text.match(/^#?(\d+)$/);
      const hits = idMatch ? active.filter(n => n.id === Number(idMatch[1])).map(note => ({ note, score: 1 })) : rankNotes(active, cmd.text);
      if (!hits.length) return `Nothing was forgotten: no saved note matches "${cmd.text}". Tell Boon plainly. Only saved notes can be forgotten this way; the profile and project notes are separate. Offer to show his notes.`;
      const top = hits[0];
      const second = hits[1];
      if (top.score >= 0.5 && (!second || top.score >= second.score * 2 || idMatch)) {
        await setStatus([top.note.id], 'forgotten');
        return `Done: forgot note #${top.note.id}: "${top.note.content}". Confirm to Boon in one short sentence.`;
      }
      return `Nothing was forgotten yet: several notes could match "${cmd.text}". Show Boon these candidates and ask which to forget (he can say "forget #<number>"):\n${block(hits.slice(0, 5).map(h => h.note))}`;
    }
    case 'list_notes':
      return active.length
        ? `Boon asked to see his saved notes. List them for him clearly, newest first, keeping the numbers. Tell him he can say "forget #<number>" to remove one.\n${block(active)}`
        : 'Boon asked to see his saved notes, but there are none yet. Tell him he can say "Remember that ..." to add one.';
    case 'list_suggestions':
      return pending.length
        ? `Boon asked to review suggested notes (things Mobius noticed in his conversations that he may want remembered). Present them as a list keeping their numbers, then tell him he can say "save 14, 16", "drop 15", "save all" or "drop all".\n${block(pending)}`
        : 'Boon asked to review suggested notes, but none are waiting. Tell him so.';
    case 'approve':
    case 'reject': {
      const chosen = cmd.ids === 'all' ? pending : pending.filter(n => cmd.ids.includes(n.id));
      if (!chosen.length) return null; // not about any waiting suggestion: treat as ordinary chat
      const approving = cmd.action === 'approve';
      await setStatus(chosen.map(n => n.id), approving ? 'active' : 'rejected');
      return `Done: ${approving ? 'saved' : 'dropped'} ${chosen.length} suggested note${chosen.length > 1 ? 's' : ''}:\n${block(chosen, false)}\nConfirm to Boon briefly${approving ? '; they will now be sent to you with every message' : ''}.`;
    }
    default:
      return null;
  }
}

// ── Suggestions that need no review ──────────────────────────────────────────
// Boon does not review suggestions (4 Oct 2026), so a suggestion left unreviewed for a few hours is promoted to an active note
// unless it (a) repeats what an active note already says, or (b) touches something private: health, money, identifiers and
// passwords, legal trouble, sex and relationships, immigration. Those stay "proposed" for ever: they are never sent to a model.
// Active notes ride in every prompt, including those that go to free tiers which may train on them, so privacy is decided here.
export const PRIVATE_TOPIC = /\b(?:health|ill(?:ness)?|sick|disease|diagnosed|diagnosis of|symptom\w*|medicat\w*|medicine|drug|dose|cancer|tumou?r|liver|kidney|heart|stroke|surgery|hospital|clinic|doctor|therap\w*|psychiatr\w*|depress\w*|anxiety|suicid\w*|self[- ]harm|addict\w*|dementia|pregnan\w*|salary|income|wage|debt|loan|mortgage|tax|bank|account number|credit|savings|shares|stocks|portfolio|inherit\w*|password|passcode|pin\b|passport|licen[cs]e number|tax file|ssn|lawsuit|sued|court|police|arrest\w*|convict\w*|divorce|affair|sexual\w*|gay|lesbian|visa\b|immigra\w*|citizenship|abuse[ds]?|assault\w*|stress\w*|strain|burn(?:ed|t)?[- ]?out|overwhelm\w*|exhaust\w*|grie[fv]\w*|bereave\w*|lonel\w*|marginali[sz]\w*|marriage|marital|spouse|wife|husband|home life|family life)\b/i;

// How much of the shorter note's words the longer one contains: 1 means one is inside the other.
export function overlap(a, b) {
  const A = words(a), B = new Set(words(b));
  if (!A.length || !B.size) return 0;
  const common = A.filter(w => B.has(w)).length;
  return common / Math.min(A.length, B.size);
}

export async function promoteSuggestions({ minAgeHours = 6, max = 12 } = {}) {
  if (!supabase) return { skipped: 'no database' };
  const all = await listNotes(['active', 'proposed']);
  const active = all.filter(n => n.status === 'active');
  const cutoff = Date.now() - minAgeHours * 3600e3;
  const out = { promoted: 0, heldPrivate: 0, duplicates: 0, waiting: 0 };
  const promote = [], taken = [...active];
  for (const n of all.filter(x => x.status === 'proposed').sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    if (Date.parse(n.created_at) > cutoff) { out.waiting++; continue; }
    if (PRIVATE_TOPIC.test(n.content)) { out.heldPrivate++; continue; }
    if (taken.some(t => overlap(n.content, t.content) >= 0.6)) { out.duplicates++; await setStatus([n.id], 'rejected'); continue; } // already known: not suggested again
    if (promote.length >= max) { out.waiting++; continue; }
    promote.push(n.id); taken.push(n);
  }
  if (promote.length) {
    const { error } = await supabase.from(T).update({ status: 'active', source: 'suggested-auto', updated_at: new Date().toISOString() }).in('id', promote);
    if (error) throw new Error('notes: ' + error.message);
  }
  out.promoted = promote.length;
  return out;
}
