// pcm/learn.js — Mobius notices what is worth keeping, without being told to.
// After each message a model (the 'learn' role in models.js) reads what Boon said, alongside the
// assistant's previous reply (he may be correcting it) and what is already saved, and picks out:
//   definition  he explains a term or concept of his own      ("X is my approach to ...")
//   correction  he corrects the assistant or states what is true ("On the contrary ...")
//   preference  a standing rule for how he wants things done
//   decision / fact  plans, commitments, lasting facts about his work or life
// In 'auto' mode (config LEARN_MODE) an *explicit* definition, correction or preference is saved
// straight away; chat.js then tells Boon what was noted and how to undo it ("forget #14").
// Everything else becomes a suggestion that waits for his say-so. It runs alongside the answer,
// so it adds no waiting time.
import { LEARN_MODE } from '../config.js';
import { askModel } from '../ai/cascade.js';
import { addNote } from './notes.js';
import { clip, parseJson } from '../util.js';

const AUTO_KINDS = new Set(['definition', 'correction', 'preference']);
const MAX_AUTO = 2;
const MAX_SUGGESTED = 2;

// → [{ id, text, kind, status: 'active' | 'proposed' }]  (only notes that are new)
export async function learnFromExchange({ query, previousAnswer = '', notes = [], dryRun = false }) {
  if (LEARN_MODE === 'off' || String(query).trim().length < 25) return [];

  const known = notes.slice(0, 40).map(n => `- ${clip(n.content, 140)}`).join('\n') || '(none)';
  const prompt = `You decide whether Boon's latest message to his AI assistant contains something the assistant should remember permanently.

Notes already saved:
${known}

The assistant's previous reply (context only; Boon may be correcting it):
${clip(previousAnswer, 800) || '(none)'}

Boon's latest message:
"""
${clip(query, 1500)}
"""

Look only at what Boon himself says in the latest message. Extract, as separate notes, any of:
- definition: he defines or explains a term, concept, framework or name of his own (for example "X is my approach to ...")
- correction: he corrects the assistant or states what is true ("On the contrary ...", "No, it is ...")
- preference: a standing preference or rule for how he wants things done
- decision: a decision, plan or commitment he states
- fact: a lasting fact about his work, circumstances or people
Ignore questions, requests for a one-off task, small talk, and anything already saved. Be conservative: most messages contain nothing worth keeping.
Write each note as one self-contained sentence in the third person that will still make sense months later: name the term being defined ("Boon defines Scriptura Fidelium as ...", "Boon prefers ..."). At most 300 characters each. If one idea is both a definition and a correction, write it as a single note.
"explicit" is true only when Boon clearly stated or defined it himself in this message, not when you inferred it.
Reply with ONLY JSON: {"notes":[{"text":"...","kind":"definition|correction|preference|decision|fact","explicit":true}]}
If nothing qualifies reply {"notes":[]}.`;

  let items;
  try { items = parseJson(await askModel(prompt, { role: 'learn', timeoutMs: 9000 })).notes; }
  catch { return []; }
  if (!Array.isArray(items)) return [];

  const saved = [];
  let auto = 0, suggested = 0;
  for (const it of items) {
    const text = String(it?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
    const kind = String(it?.kind ?? 'fact').toLowerCase();
    if (text.length < 15) continue;
    const goesActive = LEARN_MODE === 'auto' && it.explicit === true && AUTO_KINDS.has(kind) && auto < MAX_AUTO;
    if (!goesActive && suggested >= MAX_SUGGESTED) continue;
    if (dryRun) { saved.push({ text, kind, status: goesActive ? 'active' : 'proposed' }); goesActive ? auto++ : suggested++; continue; }
    const r = await addNote(text, { source: goesActive ? 'learned' : 'suggested', status: goesActive ? 'active' : 'proposed' });
    if (!r.id || r.duplicate) continue;
    saved.push({ id: r.id, text, kind, status: goesActive ? 'active' : 'proposed' });
    goesActive ? auto++ : suggested++;
  }
  return saved;
}

// The line appended to the answer so Boon always knows what was kept, and how to undo it.
export function learnedNotice(learned) {
  const active = learned.filter(l => l.status === 'active');
  const waiting = learned.filter(l => l.status === 'proposed');
  const parts = [];
  if (active.length) parts.push(`Noted: ${active.map(l => `${l.text} (#${l.id})`).join(' ')} Say "forget #${active[0].id}" to undo.`);
  if (waiting.length) parts.push(`I also spotted ${waiting.length === 1 ? 'something' : waiting.length + ' things'} that may be worth keeping. Say "show suggestions" to review.`);
  return parts.length ? `\n\n---\n*${parts.join(' ')}*` : '';
}
