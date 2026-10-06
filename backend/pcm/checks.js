// checks.js — plain-code checks on a finished answer. No model, no network, no database: they work when every model is down
// and add no waiting time. They catch only what code can know for certain, and leave the rest to a reviewer model (not built yet).
//   count   — the answer says "three reasons" (or "7 points") and then numbers a list of a different length
//   opener  — the answer begins by agreeing or praising ("You're right", "Great question") before it has said anything
//   moved   — the answer says it has changed its mind while one of Mobius's own positions was in force (a flag to check that
//             the message brought a new argument; code cannot judge that)
// `count` is shown to Boon as a short note under the answer (a wrong count is a plain error he should not have to find).
// `opener` and `moved` are only written to the trace, where they can be counted and reviewed.

const WORDS = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
const NOUNS = 'reasons|points|ways|steps|items|arguments|objections|books|examples|options|things|factors|problems|questions|ideas|themes|sources|stages|principles|differences|similarities|claims|criticisms|strands|positions|types|kinds|considerations';
// "three reasons", "7 points", "five key distinct arguments" (up to two words between the number and the noun)
const CLAIM = new RegExp(`\\b(\\d{1,2}|${Object.keys(WORDS).join('|')})\\s+(?:[a-z-]+\\s+)?(?:[a-z-]+\\s+)?(?:${NOUNS})\\b`, 'gi');
// "two or three reasons", "at least four points", "about five ways": not a promise of an exact count
const HEDGE = /\b(?:or|to|least|most|about|around|over|under|than|some|and)\s*$/i;

const LEAD = '[\\s*_>"\'\u201c\u2018]*';
const OPENER = new RegExp(
  `^${LEAD}(?:you(?:'|\u2019)re|you are) (?:\\w+ )?(?:right|correct)\\b`
  + `|^${LEAD}(?:that(?:'|\u2019)s|what) (?:a|an) (?:\\w+ )?(?:great|excellent|fantastic|brilliant|wonderful|fascinating|insightful|good|astute|sharp) (?:question|point|observation|insight)\\b`
  + `|^${LEAD}(?:great|excellent|good) (?:question|point)\\b`,
  'i');

const CONCESSION = /\bi (?:was wrong|stand corrected|concede|retract|withdraw (?:that|my))\b|\bi(?:'|\u2019)ve changed my (?:mind|view|position)\b|\bi have changed my (?:mind|view|position)\b/i;

// Length of the numbered list (1., 2., 3. ... or 1), 2), ...) that starts within 400 characters after `from`; 0 when there is none.
function listAfter(text, from) {
  const re = /^[ \t]*(\d{1,2})[.)][ \t]+\S/gm;
  re.lastIndex = from;
  const first = re.exec(text);
  if (!first || first.index - from > 400 || Number(first[1]) !== 1) return 0;
  let n = 1;
  for (let m; (m = re.exec(text)) && Number(m[1]) === n + 1; ) n++;
  return n;
}

// answer: the finished text of the reply. positions: true when one of Mobius's own positions was sent with this message.
// Returns a list of { kind, detail, ... }, empty when all is well.
export function checkAnswer(answer, { positions = false } = {}) {
  const text = String(answer || '');
  const found = [];
  const head = text.slice(0, 160);
  if (OPENER.test(head)) found.push({ kind: 'opener', detail: head.slice(0, 60) });
  for (const m of text.matchAll(CLAIM)) {
    const stated = WORDS[m[1].toLowerCase()] ?? Number(m[1]);
    if (!(stated >= 2)) continue;
    if (/\b(?:or|to|and)\b/i.test(m[0])) continue; // "two or three reasons": the match began at the first number, and this is no exact promise
    if (HEDGE.test(text.slice(Math.max(0, m.index - 14), m.index))) continue;
    const listed = listAfter(text, m.index + m[0].length);
    if (listed >= 2 && listed !== stated) { found.push({ kind: 'count', stated, listed, detail: m[0] }); break; }
  }
  if (positions && CONCESSION.test(text)) found.push({ kind: 'moved', detail: 'says it has changed its mind while one of its own positions was in force' });
  return found;
}

// The note shown to Boon under the answer: only for a wrong count.
export function checkNotice(findings) {
  const c = (findings || []).find(f => f.kind === 'count');
  return c ? `\n\n*Check: the answer says \u201c${c.detail}\u201d but lists ${c.listed}. One of the two is wrong; ask me to recount.*` : '';
}
