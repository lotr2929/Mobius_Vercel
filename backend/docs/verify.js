// docs/verify.js - does a digest say only what its source says?
// A digest is written by a model, and a model can add a name, a figure or a quotation that is not in the text it was given (often something
// it knows from elsewhere: "Martin" for a Luther the text only calls Luther). These checks are plain code, not a model: every NUMBER, every
// capitalised NAME and every "QUOTATION" in a digest must be found in the text it describes. They catch details that were added; they
// cannot catch a claim that is wrong but built only from words in the source, so they reduce the risk, they do not remove it.

const flat = s => String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const plain = s => String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

// Words that start with a capital in ordinary prose, so a capital alone says nothing.
const COMMON = new Set(('the this that these those there then thus they their them it its he she his her we our you your i in on at as by for from with without within into onto and but or nor so yet if while when where which who whom whose what why how however moreover also both each every some any all most many several other another such part parts chapter chapters section sections book books author authors text document paper argues argue discusses discuss describes describe examines examine explores explore presents present outlines outline first second third finally overall together according despite although because since after before during between among throughout beyond later earlier today now one two three four five six seven eight nine ten monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december').split(' '));

// numbers of two or more digits (years, quantities, percentages), written the plain way, thousands separators removed
export function numbersIn(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const n = m[0].replace(/,(?=\d{3}(?!\d))/g, '').replace(/[.,]+$/, '');
    if (n.replace(/\D/g, '').length >= 2) out.add(n);
  }
  return [...out];
}

// capitalised words that are not simply the first word of a sentence and not an everyday word
export function namesIn(text) {
  const out = new Set();
  const s = String(text || '');
  for (const m of s.matchAll(/\p{Lu}[\p{L}'\u2019-]{2,}/gu)) {
    const before = s.slice(0, m.index).trimEnd().slice(-1);
    const starts = !before || /[.!?:;\u2014\n"\u201C(]/.test(before);
    const w = plain(m[0]).replace(/['\u2019]s$/, '');
    if (COMMON.has(w) || starts) continue; // a sentence's first word is not evidence of a name
    out.add(m[0].replace(/['\u2019]s$/, ''));
  }
  return [...out];
}

// quotations: curly pairs, or straight pairs when the quotation marks come in an even number (otherwise they cannot be paired reliably)
export function quotesIn(text) {
  const s = String(text || ''), out = [];
  for (const m of s.matchAll(/\u201C([^\u201C\u201D]{12,300}?)\u201D/g)) out.push(m[1]);
  const marks = [...s.matchAll(/"/g)].map(m => m.index);
  if (marks.length % 2 === 0) for (let i = 0; i < marks.length; i += 2) {
    const q = s.slice(marks[i] + 1, marks[i + 1]);
    if (q.length >= 12 && q.length <= 300 && !/\n/.test(q)) out.push(q);
  }
  return out;
}

// The text a digest is checked against, prepared once (a book is large, and every sentence of every digest is checked against it).
export function prepare(source) {
  if (source && source.prepared) return source;
  const srcFlat = ' ' + flat(source) + ' ';
  const words = new Set(srcFlat.split(' ').filter(Boolean));
  return {
    prepared: true,
    nums: plain(source).replace(/(\d),(?=\d{3}(?!\d))/g, '$1'),
    flat: srcFlat,
    squash: srcFlat.replace(/ /g, ''), // PDF text breaks words at line ends, so quotations and names are also compared without spaces
    words,
    stems: new Set([...words].filter(w => w.length >= 5).map(w => w.slice(0, 4))), // Bible ~ biblical, Luther ~ Lutheran
  };
}

// What in `digest` cannot be found in `source` (a text, or the result of prepare)? -> { numbers, names, quotes }
export function unsupported(digest, source) {
  const s = prepare(source);
  const numbers = numbersIn(digest).filter(n => !s.nums.includes(n));
  const names = namesIn(digest).filter(n => !flat(n).split(' ').every(x => s.words.has(x) || (x.length >= 5 && (s.stems.has(x.slice(0, 4)) || s.squash.includes(x)))));
  const quotes = quotesIn(digest).filter(q => !s.squash.includes(flat(q).replace(/ /g, '')));
  return { numbers, names, quotes };
}
export const isClean = u => !u.numbers.length && !u.names.length && !u.quotes.length;

// Removes every sentence that holds something the text does not support. A number or a quotation must be in `section` (the text the digest
// describes); a name must be somewhere in `whole` (the document), because a name that is in the book but not in this part is usually a
// harmless completion, while one in no part of it was brought in from outside. Returns { text, removed }.
export function tidy(digest, section, whole = section) {
  const sentences = String(digest || '').match(/[^.!?]+(?:[.!?]+["\u201D')\]]*|$)\s*/g) || [String(digest || '')];
  const kept = [], removed = [];
  const sec = prepare(section), who = whole === section ? sec : prepare(whole);
  for (const s of sentences) {
    if (!s.trim()) continue;
    const a = unsupported(s, sec), b = unsupported(s, who);
    if (a.numbers.length || a.quotes.length || b.names.length) removed.push(s.trim()); else kept.push(s);
  }
  return { text: kept.join('').trim(), removed };
}
