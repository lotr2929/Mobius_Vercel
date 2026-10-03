// bible.js — public-domain Bible texts (WEB and KJV), looked up by reference and shown exactly as stored.
// The text is never written by a model: models paraphrase scripture and misquote it from memory. A reference such as
// "Matthew 21:33-46" or "Psalm 105:1-11, 45b" is turned into verse ranges, the verses are read from the table
// mobius_bible, and the stored words are what Boon sees. Only translations in the public domain are held.
import { supabase } from './db.js';

// The reading of references is shared with the browser (frontend/scripture.js), which underlines them in the chat.
import '../frontend/scripture.js';
const S = globalThis.MobiusScripture;
export const { BOOKS, bookNumber, bookName, extractRefs } = S;

export const TRANSLATIONS = { WEB: 'World English Bible', KJV: 'King James Version' };

// ── Reading the stored text ──────────────────────────────────────────────────
const inRange = (c, v, r) => (c > r.c1 || (c === r.c1 && v >= r.v1)) && (c < r.c2 || (c === r.c2 && v <= r.v2));

export async function fetchRef(translation, ref, { maxVerses = 250 } = {}) {
  const lo = Math.min(...ref.ranges.map(r => r.c1)), hi = Math.max(...ref.ranges.map(r => r.c2));
  const { data, error } = await supabase.from('mobius_bible').select('chapter, verse, text')
    .eq('translation', translation).eq('book', ref.book).gte('chapter', lo).lte('chapter', hi)
    .order('chapter', { ascending: true }).order('verse', { ascending: true }).limit(2500);
  if (error) throw new Error('bible: ' + error.message);
  const verses = (data || []).filter(row => ref.ranges.some(r => inRange(row.chapter, row.verse, r)));
  return { verses: verses.slice(0, maxVerses), cut: Math.max(0, verses.length - maxVerses) };
}

const clean = t => String(t).replace(/\s+/g, ' ').trim();

// Passages laid out one verse to a line, with the verse number in bold.
export function formatPassage(ref, translation, verses, cut = 0) {
  const multiChapter = new Set(verses.map(v => v.chapter)).size > 1;
  const lines = verses.map(v => `**${multiChapter ? v.chapter + ':' : ''}${v.verse}** ${clean(v.text)}`);
  return `**${ref.label}** (${translation})\n\n${lines.join('\n')}${cut ? `\n\n…${cut} more verse${cut === 1 ? '' : 's'} not shown; ask for the rest by range.` : ''}`;
}

// spec = { refs: ["Matthew 21:33-46", …], translation: 'WEB' | 'KJV' | 'both' | '' }
// → { text, found, notes } where `text` is the passages exactly as stored
export async function runBible(spec) {
  if (!supabase) return { text: '', found: 0, notes: ['No database connection.'] };
  const trans = /both|compare|and/i.test(spec.translation || '') ? ['WEB', 'KJV'] : [/kjv|king/i.test(spec.translation || '') ? 'KJV' : 'WEB'];
  const refs = (spec.refs || []).flatMap(r => extractRefs(r, { chapterOnlyOk: true })).slice(0, 8);
  const notes = [], blocks = [];
  let found = 0;
  if (!refs.length) return { text: '', found: 0, notes: ['No scripture reference could be read from that request.'] };
  for (const ref of refs) {
    const perTrans = [];
    for (const t of trans) {
      const { verses, cut } = await fetchRef(t, ref);
      if (!verses.length) { notes.push(`${ref.label} was not found in the ${t}${t === 'WEB' ? '' : ''} (the book may not have that chapter or verse).`); continue; }
      found += verses.length;
      perTrans.push(formatPassage(ref, t, verses, cut));
    }
    if (perTrans.length) blocks.push(perTrans.join('\n\n'));
    if (ref.partial) notes.push(`${ref.label}: a verse was given with a letter (such as 45b). The text is held by whole verse, so the whole verse is shown.`);
  }
  const tail = [...new Set(trans)].map(t => `${t} = ${TRANSLATIONS[t]}, public domain`).join('; ');
  return { text: blocks.length ? blocks.join('\n\n---\n\n') + `\n\n*${tail}.*` : '', found, notes };
}

// All references Boon wrote, for the router's fallback and for "show me them" requests.
export const refStrings = (text, opts) => extractRefs(text, opts).map(r => r.text);

// One reference for the pop-up in the chat: { label, translation, verses: [{ chapter, verse, text }], cut, partial } or { error }.
export async function lookupJson(refText, translation) {
  if (!supabase) return { error: 'No database connection.' };
  const t = /kjv/i.test(translation || '') ? 'KJV' : 'WEB';
  const ref = extractRefs(String(refText || '').slice(0, 120), { chapterOnlyOk: true })[0];
  if (!ref) return { error: 'That is not a reference I can read.' };
  const { verses, cut } = await fetchRef(t, ref, { maxVerses: 120 });
  if (!verses.length) return { error: `${ref.label} was not found in the ${t}.`, label: ref.label, translation: t };
  return { label: ref.label, translation: t, name: TRANSLATIONS[t], verses: verses.map(v => ({ chapter: v.chapter, verse: v.verse, text: clean(v.text) })), cut, partial: ref.partial };
}
