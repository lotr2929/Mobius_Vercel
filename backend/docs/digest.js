
// docs/digest.js — reading a long document, or a whole folder, "from above".
// Search finds passages; it cannot answer "what runs through all of these?" or "what does this book argue?", because no
// model has seen the whole. So each document is digested once, in advance (a step of the maintenance run):
//   1. its text is cut into sections of about 16,000 characters (small enough for every model in the stack);
//   2. a model writes a short digest of each section                         → mobius_digests level 'section'
//   3. the section digests are folded, in order, into one digest of the file → mobius_digests level 'doc'
// A question about a folder is then answered from the 'doc' digests; a question about one long book gets its 'doc'
// digest plus the section digests that best match the question. Short files (under 4,000 characters) are their own digest.
// Digests are derived, so they are never backed up: a changed file simply has them rebuilt. Work is resumable: a rate
// limit or a time limit stops the run and the next one carries on from the last finished section.
import { supabase } from '../db.js';
import { askModel } from '../ai/cascade.js';

export const SECTION_CHARS = 16000;
const SHORT_FILE = 4000;     // a file this short is its own digest (no model call)
const FOLD_CHARS = 14000;    // most digest text folded into one call
const CALL_TIMEOUT = 60000;
const PAUSE_MS = 3000;       // between calls, to stay inside per-minute allowances
const sleep = ms => new Promise(r => setTimeout(r, ms));
const same = (a, b) => !!a && !!b && Date.parse(a) === Date.parse(b);
const titleOf = filename => filename.split('/').pop().replace(/\.(pdf|txt|md|docx?|csv|json)$/i, '');

// Cuts at a paragraph, line or sentence break in the last 40% of each section, so a section rarely ends mid-sentence.
export function splitSections(text, size = SECTION_CHARS) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(text.length, i + size);
    if (end < text.length) {
      const lo = Math.floor(size * 0.6);
      const win = text.slice(i + lo, end);
      const cut = Math.max(win.lastIndexOf('\n\n'), win.lastIndexOf('\n'), win.lastIndexOf('. '));
      if (cut > 0) end = i + lo + cut + 1;
    }
    out.push({ from: i, to: end, text: text.slice(i, end) });
    i = end;
  }
  // a stub of a last section is joined to the one before (still well inside the smallest model's window)
  if (out.length > 1 && out.at(-1).text.length < 2000) {
    const last = out.pop(), prev = out.at(-1);
    prev.to = last.to; prev.text += last.text;
  }
  return out;
}

// Greedy packing of digest texts into groups of at most `max` characters, order kept.
export function packGroups(items, max = FOLD_CHARS) {
  const groups = [];
  let cur = [], size = 0;
  for (const it of items) {
    if (cur.length && size + it.length > max) { groups.push(cur); cur = []; size = 0; }
    cur.push(it); size += it.length;
  }
  if (cur.length) groups.push(cur);
  return groups;
}

const SECTION_PROMPT = (name, i, n, text) => `You are indexing a document so that questions about it can be answered later without re-reading it. This is part ${i} of ${n} of "${name}".

Write 150 to 200 words of plain prose (no headings, no bullet points, no preamble): what this part is about; its main claims, events or arguments; the people, works and technical terms that matter in it; and any Bible passages it quotes or discusses (give the references as written). Say only what this text says and add nothing from memory. If the text is mostly front matter, an index, a bibliography or page furniture, say so in one sentence.

TEXT:
${text}`;

const FOLD_PROMPT = (name, parts, final) => `Below are digests of consecutive parts of "${name}". ${final
  ? 'Write one digest of the whole document in 300 to 400 words of plain prose: what it is and what it argues or records; how it is organised from beginning to end; the main people, works, themes and Bible passages that recur; and what is distinctive about its approach or conclusions.'
  : 'Merge them into one digest of about 200 words that keeps the order, the main claims and the key names.'} No headings, no bullet points, no preamble. Say only what the digests say.

${parts.join('\n\n')}`;

async function say(prompt, left) {
  const timeoutMs = Math.min(CALL_TIMEOUT, Math.max(5000, left() - 2000));
  return (await askModel(prompt, { role: 'deep', timeoutMs })).trim();
}

// ── Building ─────────────────────────────────────────────────────────────────
// Digests one file, resuming where an earlier run stopped. → { filename, done, sections, made, error? }
export async function digestDoc(filename, { left = () => Infinity, pause = PAUSE_MS, maxParts = Infinity } = {}) {
  const { data: full } = await supabase.from('mobius_docs_full').select('content, updated_at').eq('filename', filename).maybeSingle();
  const text = full?.content || '';
  if (!text.trim()) return { filename, done: false, skipped: 'no text' };
  const version = full.updated_at;
  const save = (level, idx, content, span = {}) => supabase.from('mobius_digests')
    .upsert({ filename, level, idx, content, doc_updated: version, chars_from: span.from ?? null, chars_to: span.to ?? null });

  if (text.length < SHORT_FILE) { await save('doc', 0, text.trim()); return { filename, done: true, sections: 0, made: 0 }; }

  let { data: have } = await supabase.from('mobius_digests').select('level, idx, doc_updated').eq('filename', filename);
  if ((have || []).some(r => !same(r.doc_updated, version))) { // the file changed since: start again
    await supabase.from('mobius_digests').delete().eq('filename', filename);
    have = [];
  }
  const sections = splitSections(text);
  const done = new Set((have || []).filter(r => r.level === 'section').map(r => r.idx));
  const name = titleOf(filename);
  let made = 0;
  const stopped = (why) => ({ filename, done: false, sections: sections.length, made, have: done.size + made, ...(why ? { error: String(why).slice(0, 140) } : {}) });

  for (let i = 0; i < sections.length; i++) {
    if (done.has(i)) continue;
    if (left() < 8000 || made >= maxParts) return stopped();
    try {
      const content = await say(SECTION_PROMPT(name, i + 1, sections.length, sections[i].text), left);
      const { error } = await save('section', i, content, sections[i]);
      if (error) return stopped(error.message);
      made++;
    } catch (e) { return stopped(e.message); }
    await sleep(pause);
  }

  // Every section has its digest: fold them, in order, into the digest of the whole.
  const { data: rows } = await supabase.from('mobius_digests').select('idx, content').eq('filename', filename).eq('level', 'section').order('idx');
  let layer = (rows || []).map(r => r.content);
  if (!layer.length) return stopped('no section digests were saved');
  if (layer.length === 1) await save('doc', 0, layer[0]);
  else {
    for (let round = 0; round < 8; round++) {
      let groups = packGroups(layer);
      if (groups.length >= layer.length && layer.length > 1) groups = [layer.map(s => s.slice(0, 1500))]; // cannot shrink further: force the last round
      const final = groups.length === 1;
      const next = [];
      for (const g of groups) {
        if (left() < 8000) return stopped();
        try { next.push(await say(FOLD_PROMPT(name, g, final), left)); } catch (e) { return stopped(e.message); }
        await sleep(pause);
      }
      layer = next;
      if (final) break;
    }
    const { error } = await save('doc', 0, layer[0]);
    if (error) return stopped(error.message);
  }
  return { filename, done: true, sections: sections.length, made };
}

// Every file whose digest is missing or out of date, until the time runs out, `maxParts` calls have been made, or a
// model gives up. Files from linked folders ("<folder>/<name>") come first, then the newest.
export async function digestPending({ left = () => Infinity, maxDocs = 100, maxParts = Infinity } = {}) {
  if (!supabase) return { skipped: 'no database' };
  const { data: files } = await supabase.from('mobius_docs_full').select('filename, updated_at').order('updated_at', { ascending: false });
  const { data: digests } = await supabase.from('mobius_digests').select('filename, doc_updated').eq('level', 'doc');
  const have = new Map((digests || []).map(d => [d.filename, d.doc_updated]));
  const todo = (files || []).filter(f => !same(have.get(f.filename), f.updated_at))
    .sort((a, b) => (b.filename.includes('/') - a.filename.includes('/')) || String(b.updated_at).localeCompare(String(a.updated_at)));
  const out = { pending: todo.length, finished: 0, parts: 0, stoppedBy: null };
  for (const f of todo.slice(0, maxDocs)) {
    if (left() < 8000) { out.stoppedBy = 'time'; break; }
    if (out.parts >= maxParts) { out.stoppedBy = 'daily allowance'; break; }
    const r = await digestDoc(f.filename, { left, maxParts: maxParts - out.parts });
    out.parts += r.made || 0;
    if (r.done) { out.finished++; continue; }
    if (r.skipped) continue;
    out.stoppedBy = r.error || (out.parts >= maxParts ? 'daily allowance' : 'time'); out.working_on = `${f.filename}: ${r.have}/${r.sections} parts`;
    break;
  }
  out.pending -= out.finished;
  return out;
}

export async function forgetDigests(filename) {
  if (supabase) await supabase.from('mobius_digests').delete().eq('filename', filename);
}

// ── Using ────────────────────────────────────────────────────────────────────
// Is this question about a whole folder or collection? → { label } (label null = "all my documents") or null.
// A folder's name alone is not enough: "Scriptura Fidelium" is also Boon's own term, used in ordinary talk, so the
// name must be paired with a word like folder, documents or files ("the documents in Scriptura Fidelium").
const WHOLE = /\b(?:all|every|each|across|throughout|whole|entire|overall|together|collectively|compare|contrast|common|recurring|themes?|survey|overview|synthesi[sz]e)\b[^.?!]{0,100}\b(?:(?:my|these|those|the)\s+)?(?:documents?|files?|pdfs?|papers?|folders?|collection)\b|\b(?:all|across|throughout|compare|synthesi[sz]e)\b[^.?!]{0,40}\bmy\s+(?:books|writings|texts)\b/i;
const KIND = '(?:folder|collection|documents?|files?|papers?|pdfs?|books?|texts?|writings|materials?)';
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function folderScope(query, labels = []) {
  const q = String(query || '');
  for (const l of labels.filter(Boolean)) {
    const L = esc(l);
    const named = new RegExp(`${L}(?:['’]s)?\\s+${KIND}\\b|\\b${KIND}\\s+(?:(?:called|named)\\s+)?(?:(?:in|of|from|within|across|inside)\\s+)?(?:the\\s+|my\\s+)?${L}`, 'i');
    if (named.test(q)) return { label: l };
  }
  return WHOLE.test(q) ? { label: null } : null;
}

const STOP = new Set('about above after again also because been before being between both could does doing down during each from have having here into just more most much must only other over same should some such than that their them then there these they this those through under until very what when where which while will with would your'.split(' '));
const termsOf = q => [...new Set((String(q).toLowerCase().match(/[\p{L}\p{N}']{4,}/gu) || []).filter(w => !STOP.has(w)))];

// The digests of whole documents, for a question about a folder or collection. `folder` limits them to one linked
// folder (files are stored as "<folder label>/<path>"). → [{ filename, content }]
export async function docDigests({ folder = null, max = 60 } = {}) {
  if (!supabase) return [];
  let q = supabase.from('mobius_digests').select('filename, content').eq('level', 'doc').order('filename').limit(max);
  if (folder) q = q.like('filename', folder.replace(/[\\%_]/g, m => '\\' + m) + '/%');
  const { data } = await q;
  return data || [];
}

// "Folder overview" text within a character budget: each digest gets an equal share of it.
export function formatOverview(rows, budget = 14000) {
  if (!rows.length) return '';
  const share = Math.max(350, Math.floor(budget / rows.length) - 80);
  return rows.map(r => `[${r.filename}]\n${r.content.length > share ? r.content.slice(0, share).replace(/\s+\S*$/, '') + ' …' : r.content}`).join('\n\n');
}

// One long file, for a question about it: the digest of the whole, then the section digests that best match the
// question (most of its words present), in the order they occur. Null when the file has not been digested yet.
export async function digestOutline(filename, query, { budget = 18000 } = {}) {
  if (!supabase) return null;
  const { data: rows } = await supabase.from('mobius_digests').select('level, idx, content').eq('filename', filename).order('idx');
  const doc = (rows || []).find(r => r.level === 'doc');
  if (!doc) return null;
  const parts = (rows || []).filter(r => r.level === 'section');
  const terms = termsOf(query);
  const scored = parts.map(p => ({ p, score: terms.filter(t => p.content.toLowerCase().includes(t)).length }))
    .filter(s => s.score > 0).sort((a, b) => b.score - a.score || a.p.idx - b.p.idx);
  let room = budget - doc.content.length - 400;
  const chosen = [];
  for (const s of scored) { if (s.p.content.length + 40 > room) break; chosen.push(s.p); room -= s.p.content.length + 40; }
  chosen.sort((a, b) => a.idx - b.idx);
  return `Digest of the whole document (written in advance from its full text):\n${doc.content}`
    + (chosen.length ? `\n\nDigests of the ${chosen.length} part${chosen.length === 1 ? '' : 's'} (of ${parts.length}) that best match the question:\n\n${chosen.map(p => `[Part ${p.idx + 1} of ${parts.length}] ${p.content}`).join('\n\n')}` : '');
}
