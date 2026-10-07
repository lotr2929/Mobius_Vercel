// prayer.js — scripture for the prayers Boon asks for, taken from the stored Bible and never from a model's memory.
//
// Why this exists (6 Oct 2026): Boon asks for healing prayers that quote scripture, boldly, with new passages each time. Left to
// themselves the models quoted from memory: words that are not in any Bible, a verse given the wrong number, and the same few
// passages again and again. So the passages are chosen here, in code, by theme; they are read from the stored WEB exactly as
// written; passages used in his recent prayers are left out; and the model is told to quote only from what it is handed.
//
// The lists below are a first draft, in Boon's hands to change: add, remove or re-theme any reference (checked against the stored
// text by test/prayer.test.mjs). They avoid fruitfulness and children, and the father's cry of Mark 9, which he has asked not to hear every time.
import { extractRefs, fetchRef } from './bible.js';

export const THEMES = {
  healing: [
    'Exodus 15:26', 'Exodus 23:25', '2 Kings 20:5', 'Psalm 6:2', 'Psalm 30:2', 'Psalm 41:3', 'Psalm 103:2-5', 'Psalm 107:19-21',
    'Psalm 118:17', 'Psalm 147:3', 'Proverbs 3:7-8', 'Proverbs 4:20-22', 'Proverbs 17:22', 'Isaiah 33:24', 'Isaiah 38:16-17', 'Isaiah 53:4-5',
    'Isaiah 57:18-19', 'Isaiah 58:8', 'Jeremiah 17:14', 'Jeremiah 30:17', 'Jeremiah 33:6', 'Hosea 6:1', 'Malachi 4:2', 'Matthew 8:16-17',
    'Matthew 9:20-22', 'Matthew 9:35', 'Mark 5:34', 'Mark 10:51-52', 'Mark 11:24', 'Luke 8:48', 'Acts 10:38', 'Romans 8:11', 'James 5:14-16',
    '1 Peter 2:24', '3 John 1:2', 'Revelation 21:4', 'Revelation 22:2',
  ],
  strength: [
    'Psalm 28:7', 'Psalm 73:26', 'Isaiah 40:29-31', 'Isaiah 41:10', 'Lamentations 3:22-23', 'Habakkuk 3:17-19', 'Matthew 11:28-30',
    'Romans 8:28', 'Romans 15:13', '2 Corinthians 4:16-18', '2 Corinthians 12:9', 'Philippians 4:13', 'Hebrews 4:16',
  ],
  protection: [
    'Numbers 6:24-26', 'Deuteronomy 31:6', 'Joshua 1:9', 'Psalm 16:8', 'Psalm 23:1-4', 'Psalm 32:8', 'Psalm 46:1-2', 'Psalm 91:1-2', 'Psalm 91:11-12',
    'Psalm 121:7-8', 'Psalm 139:7-10', 'Proverbs 3:5-6', 'Isaiah 26:3', 'Isaiah 43:2', 'John 14:27', 'Philippians 4:6-7',
  ],
  marriage: [
    'Proverbs 3:3-4', 'Ecclesiastes 4:9-12', 'Song of Solomon 8:6-7', 'Romans 12:9-10', '1 Corinthians 13:4-8', 'Ephesians 4:2-3', 'Ephesians 5:25',
    'Colossians 3:12-14', 'Philippians 2:1-4', '1 John 4:7-8',
  ],
  work: [
    'Genesis 2:15', 'Exodus 31:3', 'Psalm 1:3', 'Psalm 90:17', 'Proverbs 2:6', 'Proverbs 16:3', 'Ecclesiastes 9:10', 'Jeremiah 29:7',
    'Colossians 3:23-24', 'James 1:5', 'Revelation 22:2',
  ],
};

// what each theme is recognised by in the request (the message and its standalone rewrite)
const CUES = {
  healing: /\b(?:heal\w*|sick\w*|ill|illness|disease\w*|health\w*|recover\w*|well|medic\w*|pain\w*|suffer\w*|frail\w*|weak\w*|cure\w*|treatment)\b/i,
  marriage: /\b(?:marriage|marital|married|husband|wife|spouse|couple)\b/i,
  work: /\b(?:work|project|research|career|GPR|book|paper|study|studies|teach\w*|job|vocation|plant\w*|thesis|PhD)\b/i,
  protection: /\b(?:protect\w*|safe\w*|travel\w*|overseas|abroad|guid\w*|peace\w*|anxi\w*|worr\w*|decision\w*|journey\w*|far from home|homesick|missing home|lonel\w*)\b/i,
  strength: /\b(?:include me|for me|and me|me too|myself|Boon|strength\w*|weary|tired\w*|hope\w*|courage\w*|burden\w*|carer|caring|exhaust\w*)\b/i,
};
const PER_THEME = { healing: 5, strength: 1, protection: 2, marriage: 2, work: 2 }; // about a dozen passages: room is short in a small model's window

// A request for a prayer to be WRITTEN ("give me a healing prayer", "write a prayer for"), not a talk about prayer
const REQUEST = /\b(?:give|write|compose|draft|offer|prepare|say|pray)\b[^.?!]{0,40}\bprayers?\b|\b(?:need|want|like|have|get|try)\s+(?:a|another|new|fresh|one more)\s+(?:\w+\s+){0,2}prayers?\b|\bpray (?:for|with|over)\b/i;
export const isPrayerRequest = q => REQUEST.test(String(q || ''));

export function themesFor(q) {
  const s = String(q || '');
  const found = Object.keys(CUES).filter(t => CUES[t].test(s));
  const themes = new Set(found);
  if (/\bheal\w*\b/i.test(s)) themes.add('healing');                  // "healing prayer": always
  if (!themes.size) { themes.add('strength'); themes.add('protection'); } // some prayer for some need: comfort and keeping
  return [...themes];
}

// Do two references overlap (same book, a verse in common)?
const key = (c, v) => c * 1000 + v;
export function overlaps(a, b) {
  return a.book === b.book && a.ranges.some(x => b.ranges.some(y => key(x.c1, x.v1) <= key(y.c2, y.v2) && key(y.c1, y.v1) <= key(x.c2, x.v2)));
}

// References quoted or cited in earlier prayers (the texts of the assistant's recent replies that were prayers)
export function usedIn(texts) {
  const used = [];
  for (const t of texts) if (/\b(?:Lord|Father)\b/.test(t) && /\bpray/i.test(t)) used.push(...extractRefs(t, {}));
  return used;
}

// A small deterministic shuffle: the same request on the same day gives the same passages, another day or another request others
function seeded(str) { let h = 2166136261; for (const c of str) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return () => ((h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0) / 4294967296); }
const shuffle = (list, rnd) => { const a = [...list]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

// → [{ theme, ref: 'Psalm 103:2-5' }, ...]: unused passages for each theme, no passage twice, healing first
export function pickPassages({ themes, used = [], seed = '' }) {
  const rnd = seeded(seed);
  const taken = [];
  const out = [];
  for (const theme of ['healing', 'strength', 'protection', 'marriage', 'work'].filter(t => themes.includes(t))) {
    let n = 0;
    for (const text of shuffle(THEMES[theme], rnd)) {
      if (n >= PER_THEME[theme]) break;
      const ref = extractRefs(text, { chapterOnlyOk: true })[0];
      if (!ref || used.some(u => overlaps(ref, u)) || taken.some(u => overlaps(ref, u))) continue;
      taken.push(ref); out.push({ theme, ref: text }); n++;
    }
  }
  return out;
}

const clean = t => String(t).replace(/\s+/g, ' ').trim();

// The passages, exactly as stored (WEB): { text, refs, themes, skipped }
export async function prayerScripture({ query, pastTexts = [], today = new Date().toISOString().slice(0, 10) }) {
  const themes = themesFor(query);
  const picks = pickPassages({ themes, used: usedIn(pastTexts), seed: `${today}|${query}` });
  const lines = [], refs = [];
  for (const { theme, ref: text } of picks) {
    const ref = extractRefs(text, { chapterOnlyOk: true })[0];
    try {
      const { verses } = await fetchRef('WEB', ref, { maxVerses: 6 });
      if (!verses.length) continue;
      lines.push(`${ref.label} (${theme}): ${verses.map(v => clean(v.text)).join(' ')}`);
      refs.push(ref.text);
    } catch { /* one passage missing is no reason to lose the rest */ }
  }
  return { text: lines.join('\n\n'), refs, themes, used: usedIn(pastTexts).length };
}
