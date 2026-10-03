// readings.js — the Revised Common Lectionary readings for a Sunday, without trusting a model's memory of them.
// Two things go wrong when a model is simply asked: it names the wrong year of the three-year cycle (this week it gave
// last year's Year C readings for a Year A Sunday), and it recalls readings from memory. So:
//   1. the Sunday, its year (A, B or C) and its Proper number are worked out here, by arithmetic;
//   2. the references are looked up by web search, with that year and Proper in the search;
//   3. a model only copies references out of the search results, and anything for another year is discarded;
//   4. the words of each reading come from the stored Bible (bible.js), never from a model.
import { tavilySearch } from './web.js';
import { askModel } from './ai/cascade.js';
import { parseJson, clip } from './util.js';
import { extractRefs } from './bible.js';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAY = 864e5;

// today's date in Perth as a UTC-midnight Date (so the arithmetic below ignores time zones and daylight saving)
function perthToday(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Perth', year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(now).map(x => [x.type, x.value]));
  return new Date(Date.UTC(+p.year, +p.month - 1, +p.day));
}

// The Sunday meant by the request: a date written in it, "next Sunday / next week", or the coming Sunday (today, if it is one).
export function sundayFor(request, now = new Date()) {
  const q = String(request || '');
  const m = q.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTHS.join('|')})(?:,?\\s+(\\d{4}))?`, 'i')) || q.match(new RegExp(`\\b(${MONTHS.join('|')})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?`, 'i'));
  const today = perthToday(now);
  let d;
  if (m) {
    const [day, mon] = /^\d/.test(m[1]) ? [+m[1], m[2]] : [+m[2], m[1]];
    d = new Date(Date.UTC(m[3] ? +m[3] : today.getUTCFullYear(), MONTHS.findIndex(x => x.toLowerCase() === mon.toLowerCase()), day));
    d = new Date(d.getTime() + ((7 - d.getUTCDay()) % 7) * DAY); // a date during the week means the Sunday that ends it
  } else {
    d = new Date(today.getTime() + ((7 - today.getUTCDay()) % 7) * DAY);
    if (/\bnext\s+(?:sunday|week)\b/i.test(q) && !/\bthis\b/i.test(q)) d = new Date(d.getTime() + 7 * DAY);
  }
  return d;
}

// → { year: 'A'|'B'|'C', proper: 4..29 | null } for a Sunday. The church year begins on the first Sunday of Advent
// (the Sunday from 27 November to 3 December); Advent 2025 began Year A (as did 2022 and 2028), so the letter follows the year modulo 3.
export function lectionaryOf(sunday) {
  const y = sunday.getUTCFullYear();
  const adventStart = yr => { const n = new Date(Date.UTC(yr, 10, 27)); return new Date(n.getTime() + ((7 - n.getUTCDay()) % 7) * DAY); };
  const start = sunday >= adventStart(y) ? y : y - 1;
  const year = { 0: 'A', 1: 'B', 2: 'C' }[start % 3];
  const may29 = new Date(Date.UTC(y, 4, 29));
  const inPropers = sunday >= new Date(Date.UTC(y, 5, 24)) && sunday <= new Date(Date.UTC(y, 10, 26));
  const proper = inPropers ? 4 + Math.floor((sunday - may29) / (7 * DAY)) : null;
  return { year, proper: proper >= 4 && proper <= 29 ? proper : null };
}

const longDate = d => `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;

// → { refs, header, note, year, proper, sunday }
export async function findReadings(request, now = new Date()) {
  const sunday = sundayFor(request, now);
  const { year, proper } = lectionaryOf(sunday);
  const header = `Sunday ${longDate(sunday)} — ${proper ? `Proper ${proper}, ` : ''}Year ${year}`;
  const where = `${longDate(sunday)} Year ${year}${proper ? ' Proper ' + proper : ''}`;
  // one search tends to find only part of the set (often just the Old Testament reading and the psalm), so ask three ways
  const found = (await Promise.all([
    tavilySearch(`Revised Common Lectionary ${where} readings`),
    tavilySearch(`lectionary ${where} Gospel and Epistle reading`),
    tavilySearch(`Revised Common Lectionary Year ${year}${proper ? ' Proper ' + proper : ''} first reading psalm second reading gospel`),
  ])).filter(Boolean);
  const web = [...new Set(found)].join('\n\n');
  if (!web) return { refs: [], header, year, proper, sunday, note: 'The lectionary readings could not be looked up just now, because web search was unavailable.' };
  const raw = await askModel(`Below are web search results. Find the Revised Common Lectionary readings for ${header} (${longDate(sunday)}).

Reply with ONLY JSON: {"year":"A, B or C as shown for the readings you found","occasion":"the name, for example Proper 22","readings":["first reading reference","psalm reference","second reading reference","gospel reference"]}
Rules: use ONLY references that appear in the results AND belong to Year ${year}${proper ? ` (Proper ${proper})` : ''}; ignore readings that the results give for any other year; write each as book chapter:verses (for example Matthew 21:33-46; a psalm may be a chapter alone, such as Psalm 80); if two tracks are shown (semi-continuous and complementary) include both first readings and both psalms; if the results do not show the readings for this Sunday and year, return an empty list.

${clip(web, 9000)}`, { role: 'quick', timeoutMs: 25000 });
  const j = parseJson(raw);
  const said = String(j.year || '').trim().toUpperCase().slice(0, 1);
  if (said && said !== year) return { refs: [], header, year, proper, sunday, note: `The search results gave Year ${said} readings, but ${longDate(sunday)} is in Year ${year}, so I did not use them.` };
  const seen = new Set(), refs = [];
  for (const s of Array.isArray(j.readings) ? j.readings : []) {
    for (const r of extractRefs(String(s), { chapterOnlyOk: true })) if (!seen.has(r.label)) { seen.add(r.label); refs.push(r.text); }
  }
  const few = refs.length > 0 && refs.length < 4;
  return {
    refs: refs.slice(0, 8), header, year, proper, sunday, partial: few,
    note: refs.length
      ? `The references were found by web search; check them against your own lectionary.${few ? ` Only ${refs.length} reading${refs.length === 1 ? ' was' : 's were'} found, whereas a Sunday usually has four (first reading, psalm, second reading, Gospel): ask for any missing one by its reference.` : ''}`
      : 'The search results did not show the readings for that Sunday.',
  };
}
