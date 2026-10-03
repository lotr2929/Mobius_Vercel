// bible.js — public-domain Bible texts (WEB and KJV), looked up by reference and shown exactly as stored.
// The text is never written by a model: models paraphrase scripture and misquote it from memory. A reference such as
// "Matthew 21:33-46" or "Psalm 105:1-11, 45b" is turned into verse ranges, the verses are read from the table
// mobius_bible, and the stored words are what Boon sees. Only translations in the public domain are held.
import { supabase } from './db.js';

const NAMES = [
  'Genesis|gen,gn', 'Exodus|exod,exo,ex', 'Leviticus|lev,lv', 'Numbers|num,nm', 'Deuteronomy|deut,dt,deu', 'Joshua|josh,jos',
  'Judges|judg,jdg,jg', 'Ruth|rut', '1 Samuel|1sam,1sa,1sm,isamuel,firstsamuel', '2 Samuel|2sam,2sa,2sm,iisamuel,secondsamuel',
  '1 Kings|1kgs,1ki,1kin,ikings,firstkings', '2 Kings|2kgs,2ki,2kin,iikings,secondkings', '1 Chronicles|1chr,1ch,ichronicles,firstchronicles', '2 Chronicles|2chr,2ch,iichronicles,secondchronicles',
  'Ezra|ezr', 'Nehemiah|neh', 'Esther|esth,est', 'Job|jb', 'Psalms|psalm,ps,pss,psa,psm', 'Proverbs|prov,prv',
  'Ecclesiastes|eccl,eccles,ecc,qoheleth', 'Song of Solomon|songofsongs,songofsol,song,sos,ss,canticles,canticleofcanticles', 'Isaiah|isa', 'Jeremiah|jer',
  'Lamentations|lam', 'Ezekiel|ezek,eze,ezk', 'Daniel|dan,dn', 'Hosea|hos', 'Joel|joe,jl', 'Amos|amo', 'Obadiah|obad,ob', 'Jonah|jon,jnh',
  'Micah|mic', 'Nahum|nah', 'Habakkuk|hab,hb', 'Zephaniah|zeph,zep,zp', 'Haggai|hag,hg', 'Zechariah|zech,zec,zc', 'Malachi|mal,ml',
  'Matthew|matt,mat,mt', 'Mark|mrk,mk,mr', 'Luke|luk,lk', 'John|joh,jhn,jn', 'Acts|act,actsoftheapostles', 'Romans|rom,rm',
  '1 Corinthians|1cor,1co,icorinthians,firstcorinthians', '2 Corinthians|2cor,2co,iicorinthians,secondcorinthians', 'Galatians|gal,ga', 'Ephesians|eph,ephes',
  'Philippians|phil,php,pp', 'Colossians|col', '1 Thessalonians|1thess,1thes,1th,ithessalonians,firstthessalonians', '2 Thessalonians|2thess,2thes,2th,iithessalonians,secondthessalonians',
  '1 Timothy|1tim,1ti,itimothy,firsttimothy', '2 Timothy|2tim,2ti,iitimothy,secondtimothy', 'Titus|tit', 'Philemon|philem,phm,pm', 'Hebrews|heb',
  'James|jas,jm', '1 Peter|1pet,1pe,1pt,ipeter,firstpeter', '2 Peter|2pet,2pe,2pt,iipeter,secondpeter', '1 John|1jn,1jo,ijohn,firstjohn', '2 John|2jn,2jo,iijohn,secondjohn',
  '3 John|3jn,3jo,iiijohn,thirdjohn', 'Jude|jud,jd', 'Revelation|rev,rv,revelationofjohn,apocalypse',
];
export const BOOKS = NAMES.map((s, i) => { const [name, alias] = s.split('|'); return { n: i + 1, name, keys: [name.toLowerCase().replace(/[^a-z0-9]/g, ''), ...alias.split(',')] }; });
const KEY = new Map();
for (const b of BOOKS) for (const k of b.keys) if (!KEY.has(k)) KEY.set(k, b.n);
export const bookNumber = text => KEY.get(String(text).toLowerCase().replace(/[^a-z0-9]/g, '')) || null;
export const bookName = n => BOOKS[n - 1]?.name;
const display = n => (n === 19 ? 'Psalm' : bookName(n));

export const TRANSLATIONS = { WEB: 'World English Bible', KJV: 'King James Version' };

// ── Reading references out of text ───────────────────────────────────────────
const DASH = '[-–—]';
const REF_SOURCE = (
  '(?<![A-Za-z0-9])(?<num>[1-3]|III|II|I|First|Second|Third)?\\.?\\s*(?<name>[A-Za-z]+(?:\\s+of\\s+(?:Songs|Solomon|John|the\\s+Apostles))?)\\.?\\s*(?<ch>\\d{1,3})' +
  '(?:\\s*:\\s*(?<v1>\\d{1,3})(?<s1>[a-c])?(?:\\s*' + DASH + '\\s*(?:(?<c2>\\d{1,3})\\s*:\\s*)?(?<v2>\\d{1,3})(?<s2>[a-c])?)?' +
  '(?<more>(?:\\s*,\\s*\\d{1,3}[a-c]?(?:\\s*' + DASH + '\\s*\\d{1,3}[a-c]?)?(?!\\d)(?!\\s*:)(?!\\s*[A-Za-z]{2,}))*))?');
const numKey = n => ({ i: '1', ii: '2', iii: '3', first: '1', second: '2', third: '3' }[String(n).toLowerCase()] || n);

// → [{ book, ranges: [{ c1, v1, c2, v2 }], partial, label, text }]  (v2 = Infinity means "to the end of the chapter")
// Without chapterOnlyOk, "Psalm 23" alone is not taken as a reference (words like "job 5 years" would be).
export function extractRefs(text, { chapterOnlyOk = false } = {}) {
  const out = [];
  const re = new RegExp(REF_SOURCE, 'gi');
  const str = String(text || '');
  let m;
  while ((m = re.exec(str))) {
    const g = m.groups;
    const nm = g.name.replace(/\s+of\s+/i, 'of');
    const book = bookNumber((g.num ? numKey(g.num) : '') + nm) || bookNumber((g.num || '') + nm);
    if (!book) { re.lastIndex = m.index + 1; continue; }
    const hasVerse = g.v1 != null;
    if (!hasVerse && !chapterOnlyOk) { re.lastIndex = m.index + m[0].length; continue; }
    const ch = +g.ch;
    const ranges = [];
    let partial = !!(g.s1 || g.s2);
    if (!hasVerse) ranges.push({ c1: ch, v1: 1, c2: ch, v2: Infinity });
    else {
      const c2 = g.c2 ? +g.c2 : ch;
      ranges.push({ c1: ch, v1: +g.v1, c2, v2: g.v2 ? +g.v2 : (g.c2 ? Infinity : +g.v1) });
      for (const part of String(g.more || '').split(',').map(s => s.trim()).filter(Boolean)) {
        const mm = part.match(/^(\d{1,3})([a-c])?(?:\s*[-–—]\s*(\d{1,3})([a-c])?)?$/);
        if (!mm) continue;
        if (mm[2] || mm[4]) partial = true;
        ranges.push({ c1: c2, v1: +mm[1], c2, v2: mm[3] ? +mm[3] : +mm[1] });
      }
    }
    const spec = ranges.map(r => r.v2 === Infinity && r.v1 === 1 ? `${r.c1}` : r.c1 === r.c2
      ? (r.v1 === r.v2 ? `${r.c1}:${r.v1}` : `${r.c1}:${r.v1}–${r.v2 === Infinity ? 'end' : r.v2}`)
      : `${r.c1}:${r.v1}–${r.c2}:${r.v2 === Infinity ? 'end' : r.v2}`);
    // later ranges in the same chapter are written without repeating the chapter: "105:1–11, 45"
    const label = `${display(book)} ${spec.map((s, i) => (i > 0 && ranges[i].c1 === ranges[0].c2 && s.startsWith(ranges[i].c1 + ':') ? s.slice(String(ranges[i].c1).length + 1) : s)).join(', ')}`;
    out.push({ book, ranges, partial, label, text: m[0].trim() });
  }
  return out;
}

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
