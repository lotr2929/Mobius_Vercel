// review.js — a second model checks a draft before it is sent (layer 2 of the answer checks; layer 1 is pcm/checks.js).
//
// What a reviewer can do and what it cannot (agreed 6 Oct 2026): a model marking its own or another model's work without outside
// evidence often does not improve it. So the reviewer is used for two kinds of thing only:
//   1. what can be seen in the text itself: a contradiction of one of Mobius's stored positions, a question left unanswered,
//      flattery, a miscount (these come from the draft and the positions alone, no evidence needed);
//   2. claims that outside evidence can settle (a quotation, a source, a date, a book): the reviewer names them, a web search is
//      run, and only a claim the search CONTRADICTS counts. "Could not verify" is never a problem.
// A model of a different provider from the answering one does the reviewing. If problems are found the answering cascade is
// asked, once, to write the reply again with the problems and the evidence in front of it. Everything fails safe: if the reviewer
// is down, over its allowance, unreadable or too slow, the draft goes out exactly as it was.
//
// chat.js holds the draft while this runs (a draft that may be rewritten cannot be streamed) and sends what comes back.

import { askModel, runCascade } from '../ai/cascade.js';
import { MODELS } from '../ai/models.js';
import { tavilySearch } from '../web.js';
import { PRIVATE_TOPIC } from './notes.js';
import { checkAnswer } from './checks.js';
import { clip } from '../util.js';

// ── Which answers are reviewed ───────────────────────────────────────────────
const FACT_QUESTION = /\b(?:who (?:wrote|said|argued|coined|founded|was|were)|when (?:did|was|were)|what year|which (?:book|author|paper|study|council|verse|chapter)|how many|how much|according to|quot(?:e|ed|ation)s?|cit(?:e|ed|ation)s?|sources?|references?|evidence|studies|research|history of|first (?:to|used)|origins? of|is it true|did (?:\w+ ){1,2}(?:say|write|argue|claim))\b/i;

// Decided BEFORE the answer is written, because a reviewed answer is held back rather than streamed. Theology, questions that
// went to a web search, and questions that ask for facts, sources or quotations are reviewed; casual talk, Mobius's own
// documentation, listings, attached documents, forced models, private messages and anything touching a private topic are not.
export function shouldReview({ mode = 'on', query = '', plan = {}, theology = false, trivial = false, privateMode = false, direct = false, memoryAction = false, attached = false, forced = false } = {}) {
  if (mode === 'off' || privateMode || direct || memoryAction || attached || forced || trivial) return false;
  if (plan?.aboutSelf || String(query).trim().length < 25) return false;
  if (PRIVATE_TOPIC.test(query)) return false; // the question and draft go to a second provider that may train on them
  return !!(theology || plan?.needsWeb || FACT_QUESTION.test(query));
}

// ── The reviewer's brief ─────────────────────────────────────────────────────
const REVIEW_SYSTEM = 'You are a careful, fair reviewer of another AI assistant\'s draft reply to a user. You do not rewrite the reply. You report only real problems you can point to in the text, and you never invent a problem to look useful: when unsure, report nothing. You reply with a single JSON object and nothing else.';

const CHECKLIST = `Report only real problems, from this list:
- contradiction: the draft contradicts one of the stored positions above, or contradicts itself
- missed: the draft does not answer what the question actually asks
- flattery: the draft opens or closes by praising or agreeing with the user instead of assessing
- count: the draft says it gives N things and gives a different number
- unsupported: a specific claim stated as fact (a quotation, a source, a date, a name, a statistic, a book or article) that looks wrong or invented. You cannot be sure without outside evidence, so for each such claim also write a short web search query that would settle it in "search" (at most 2 in all).
Reply with JSON only, in this shape:
{"problems":[{"type":"contradiction|missed|flattery|count|unsupported","claim":"<the claim, under 25 words>","issue":"<one sentence>"}],"search":["<query>"]}
Use empty lists when the draft is sound. Do not invent problems.`;

export function reviewPrompt({ query, draft, stance = '' }) {
  return [
    `The user's question:\n${clip(query, 1500)}`,
    `Draft reply to review:\n"""\n${clip(draft, 7000)}\n"""`,
    stance ? `The assistant's own stored positions that bear on this question (the draft must not contradict them unless it names a new argument or new evidence):\n${clip(stance, 2500)}` : '',
    CHECKLIST,
  ].filter(Boolean).join('\n\n');
}

export function evidencePrompt({ query, draft, claims, evidence }) {
  return [
    `The user's question:\n${clip(query, 1000)}`,
    `Draft reply:\n"""\n${clip(draft, 6000)}\n"""`,
    `Claims in the draft to verify:\n${claims.map(c => `- ${c}`).join('\n')}`,
    `Web search results (the only evidence you may use):\n${evidence.join('\n\n')}`,
    `For each claim decide: supported, contradicted, or unverified. Unverified means the results neither confirm nor refute it; that is NOT a problem. Report ONLY claims that the results contradict (the real wording, date, author or fact is different, or the thing the draft cites plainly does not exist), saying what the results show and naming the source.
Reply with JSON only: {"problems":[{"type":"contradicted","claim":"<the claim>","issue":"<what the results show instead>","evidence":"<source title or URL>"}]}
Use an empty list when nothing is contradicted.`,
  ].join('\n\n');
}

// The reviewer's JSON (it may arrive in a code fence, or after some thinking) → { problems, search } or null when unreadable.
export function parseVerdict(text) {
  if (!text) return null;
  const s = String(text).replace(/```(?:json)?/gi, '');
  const i = s.indexOf('{'), j = s.lastIndexOf('}');
  if (i < 0 || j <= i) return null;
  let o;
  try { o = JSON.parse(s.slice(i, j + 1)); } catch { return null; }
  if (!o || typeof o !== 'object') return null;
  const str = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
  const problems = (Array.isArray(o.problems) ? o.problems : [])
    .map(p => ({ type: str(p?.type, 30).toLowerCase(), claim: str(p?.claim, 200), issue: str(p?.issue, 300), evidence: str(p?.evidence, 200) }))
    .filter(p => p.type && (p.claim || p.issue))
    .slice(0, 8);
  const search = (Array.isArray(o.search) ? o.search : []).map(q => str(q, 120)).filter(Boolean).slice(0, 2);
  return { problems, search };
}

// Problems the reviewer may raise without outside evidence. "unsupported" is not among them: it only leads to a search.
const ACTIONABLE = new Set(['contradiction', 'missed', 'flattery', 'count']);
const LABEL = {
  count: 'a miscount', flattery: 'an opening that flattered', contradiction: 'a contradiction of its own position',
  missed: 'part of the question left unanswered', contradicted: 'a claim the sources contradict',
};
const SHOW_CLAIM = new Set(['count', 'contradiction', 'contradicted']);
export function labelProblems(problems) {
  const seen = new Set(), out = [];
  for (const p of problems) {
    const text = (LABEL[p.type] || p.type) + (SHOW_CLAIM.has(p.type) && p.claim ? ` (\u201c${clip(p.claim, 60)}\u201d)` : '');
    if (seen.has(text)) continue;
    seen.add(text); out.push(text);
    if (out.length === 3) break;
  }
  return out.join('; ');
}

export function redraftPrompt(problems) {
  const lines = problems.map(p => `- ${LABEL[p.type] || p.type}${p.claim ? `: "${p.claim}"` : ''}${p.issue ? ` \u2014 ${p.issue}` : ''}${p.evidence ? ` (source: ${p.evidence})` : ''}`);
  return `[Review of your draft] A reviewer checked your draft reply and found these problems:\n${lines.join('\n')}\n\nWrite the reply to Boon's message again, correcting each one. Where a source contradicts a claim, correct it or drop it, and say plainly if you are no longer sure; do not defend an error. Do not change a position of your own unless a problem above supplies a new argument or new evidence. Do not open by agreeing or praising. Do not mention the review, the reviewer or this message: write the reply as if for the first time, beginning with its first sentence.`;
}

// ── Running it ───────────────────────────────────────────────────────────────
// Resolves to the thunk's value, or null if it fails or takes longer than `ms`. The thunk is only started if there is time.
function within(thunk, ms) {
  return new Promise(resolve => {
    if (!(ms > 0)) return resolve(null);
    const t = setTimeout(() => resolve(null), ms);
    let p;
    try { p = Promise.resolve(thunk()); } catch { clearTimeout(t); return resolve(null); }
    p.then(v => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(null); });
  });
}

// The answering cascade writes the reply again: the turn so far, its own draft, then the problems.
async function redraftWith({ messages, system, draft, problems, signal }) {
  const turns = [...messages, { role: 'assistant', content: draft }, { role: 'user', content: redraftPrompt(problems) }];
  let out = '';
  for await (const chunk of runCascade(turns, { system, signal })) {
    if (typeof chunk === 'string') out += chunk;
    else if (chunk.event === 'cut-off') return null;
  }
  return out.trim();
}

const MIN_START_MS = 18000;    // time needed to start a review at all
const MIN_EVIDENCE_MS = 12000; // time needed to weigh search results
const MIN_REDRAFT_MS = 22000;  // time needed to write the reply again

// Returns { text, note, report }: text is the reply to send (the draft itself when nothing changed), note a line for the end of it
// (empty when the review found nothing), report what happened, for the trace. It never throws.
//   answeredBy: the name of the model that wrote the draft;  messages/system: the turn as the answerer saw it
//   deadline: Date.now()-style time by which the whole turn must be done;  deps: replaceable parts, for tests
export async function reviewDraft({ query, draft, stance = '', answeredBy, messages, system, deadline, signal, deps = {} }) {
  const d = { ask: askModel, search: tavilySearch, redraft: redraftWith, now: () => Date.now(), ...deps };
  const lim = { start: MIN_START_MS, evidence: MIN_EVIDENCE_MS, redraft: MIN_REDRAFT_MS, ...deps.limits };
  const report = { ran: false };
  const left = () => deadline - d.now();
  const began = d.now();
  const done = (text, note = '') => { report.ms = d.now() - began; return { text, note, report }; };
  const skip = why => { report.skipped = why; return done(draft); };
  try {
    const answerer = MODELS.find(m => m.name === answeredBy);
    if (!answerer) return skip('answering model unknown');
    if (left() < lim.start) return skip('not enough time left');

    // Step 1: the reviewer reads the draft against the checklist.
    const meta = {};
    const opts = () => ({ role: 'review', exceptProvider: answerer.provider, system: REVIEW_SYSTEM, timeoutMs: Math.max(5000, Math.min(20000, left() - 4000)), meta });
    const first = await within(() => d.ask(reviewPrompt({ query, draft, stance }), opts()), left() - 2000);
    if (!first) return skip('no reviewer from another provider answered in time');
    const verdict = parseVerdict(first);
    if (!verdict) return skip('the reviewer\'s reply was unreadable');
    report.ran = true;
    report.reviewer = meta.model || null;

    // What code can see for certain is added to what the reviewer found.
    const problems = checkAnswer(draft, { positions: !!stance }).flatMap(f => (
      f.kind === 'count' ? [{ type: 'count', claim: f.detail, issue: `says ${f.stated} but lists ${f.listed}`, evidence: '' }]
        : f.kind === 'opener' ? [{ type: 'flattery', claim: f.detail, issue: 'opens by agreeing or praising', evidence: '' }] : []));
    for (const p of verdict.problems.filter(p => ACTIONABLE.has(p.type))) {
      if (problems.some(q => q.type === p.type && (p.type === 'count' || p.type === 'flattery'))) continue; // already found by code
      problems.push(p);
    }

    // Step 2: claims that outside evidence can settle are searched for, and weighed against what the searches show.
    const queries = verdict.search;
    if (queries.length && left() > lim.evidence + 8000) {
      const found = await Promise.all(queries.map(q => within(() => d.search(q, { depth: 'basic' }), Math.min(10000, left() - lim.evidence))));
      const evidence = found.map((t, i) => (t ? `Search: ${queries[i]}\n${clip(t, 1800)}` : null)).filter(Boolean);
      report.searched = queries.length;
      report.evidence = evidence.length;
      if (evidence.length && left() > lim.evidence) {
        const claims = verdict.problems.filter(p => p.type === 'unsupported' && p.claim).map(p => p.claim).slice(0, 3);
        const second = await within(() => d.ask(evidencePrompt({ query, draft, claims: claims.length ? claims : queries, evidence }), opts()), left() - 2000);
        const checked = parseVerdict(second);
        if (checked) problems.push(...checked.problems.filter(p => p.type === 'contradicted' && p.evidence)); // no source, no problem
      }
    }

    report.problems = problems.map(p => ({ type: p.type, claim: p.claim.slice(0, 120), issue: p.issue.slice(0, 200), evidence: p.evidence.slice(0, 120) }));
    if (!problems.length) { report.verdict = 'pass'; return done(draft); }

    // Step 3: the reply is written again, once. If that cannot be done in time, the draft goes out and Boon is told what was found.
    const labels = labelProblems(problems);
    const again = left() > lim.redraft ? await within(() => d.redraft({ messages, system, draft, problems, signal }), left() - 2000) : null;
    if (typeof again === 'string' && again.trim().length >= Math.min(80, draft.length * 0.3)) {
      report.verdict = 'revised';
      return done(again.trim(), `\n\n*Checked before sending: revised for ${labels}.*`);
    }
    report.verdict = 'flagged';
    return done(draft, `\n\n*Checked before sending: found ${labels}, which I could not correct in time.*`);
  } catch (e) {
    report.error = String(e?.message || e).slice(0, 200);
    return done(draft);
  }
}
