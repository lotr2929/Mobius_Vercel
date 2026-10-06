// The answer reviewer (pcm/review.js). The model calls, the web search and the redraft are replaced by fakes: no network, no database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldReview, parseVerdict, reviewDraft, reviewPrompt, redraftPrompt, labelProblems } from '../backend/pcm/review.js';

const ASKED = 'What did Bachelard actually argue in The Poetics of Space about the house?';
const DRAFT = 'Bachelard argues that the house shelters daydreaming, and that its rooms, from cellar to attic, hold different kinds of memory. He reads the house as a set of images before it is a set of walls, which is why his book is closer to phenomenology than to architecture.';
const NEW_TEXT = 'Bachelard argues that the house shelters daydreaming. Its cellar and attic hold opposite kinds of memory, and he reads the house first as images and only then as walls, which makes the book phenomenology rather than architecture.';
const PASS = '{"problems":[],"search":[]}';
const later = ms => Date.now() + ms;

// A fake set of parts. `replies` are the reviewer's answers in order; a Error in the list makes that call fail.
function fakes({ replies = [PASS], found = 'Search result text', redraft = NEW_TEXT } = {}) {
  const calls = { ask: [], search: [], redraft: [] };
  let n = 0;
  return {
    calls,
    deps: {
      ask: async (prompt, opts) => { calls.ask.push({ prompt, opts }); const r = replies[Math.min(n++, replies.length - 1)]; if (r instanceof Error) throw r; opts.meta.model = 'fake-reviewer'; return r; },
      search: async (q, opts) => { calls.search.push({ q, opts }); return found; },
      redraft: async args => { calls.redraft.push(args); return typeof redraft === 'function' ? redraft(args) : redraft; },
    },
  };
}
const run = (f, extra = {}) => reviewDraft({ query: ASKED, draft: DRAFT, stance: '', answeredBy: 'gemini-3.8-flash', messages: [{ role: 'user', content: ASKED }], system: 'sys', deadline: later(60000), deps: f.deps, ...extra });

test('which answers are reviewed', () => {
  const base = { query: ASKED, plan: { needsWeb: false } };
  assert.equal(shouldReview({ ...base }), true, 'a question asking what an author argued');
  assert.equal(shouldReview({ query: 'Tell me about the structure of the argument in this chapter please', plan: {}, theology: true }), true, 'theology');
  assert.equal(shouldReview({ query: 'Tell me about what happened in the news this week please', plan: { needsWeb: true } }), true, 'a web search was needed');
  assert.equal(shouldReview({ query: 'I think I will go for a walk later this afternoon', plan: {} }), false, 'casual talk');
  assert.equal(shouldReview({ ...base, mode: 'off' }), false);
  assert.equal(shouldReview({ ...base, privateMode: true }), false);
  assert.equal(shouldReview({ ...base, direct: true }), false);
  assert.equal(shouldReview({ ...base, memoryAction: true }), false);
  assert.equal(shouldReview({ ...base, attached: true }), false);
  assert.equal(shouldReview({ ...base, forced: true }), false);
  assert.equal(shouldReview({ ...base, trivial: true }), false);
  assert.equal(shouldReview({ ...base, plan: { aboutSelf: true } }), false);
  assert.equal(shouldReview({ query: 'Who wrote the study on my medication and my doctor said', plan: {} }), false, 'a private topic is never sent to a second provider');
  assert.equal(shouldReview({ query: 'Who wrote it?', plan: {} }), false, 'too short to be worth it');
});

test('the reviewer\'s JSON is read from a fence or from after some thinking, and bounded', () => {
  const v = parseVerdict('Let me look.\n```json\n{"problems":[{"type":"Missed","claim":"x","issue":"y"},{"type":"","claim":"","issue":""}],"search":["a","b","c"," "]}\n```');
  assert.equal(v.problems.length, 1);
  assert.equal(v.problems[0].type, 'missed');
  assert.deepEqual(v.search, ['a', 'b']);
  assert.deepEqual(parseVerdict('{}'), { problems: [], search: [] });
  assert.equal(parseVerdict('no json here'), null);
  assert.equal(parseVerdict('{"problems": [oops'), null);
  assert.equal(parseVerdict(''), null);
  assert.equal(parseVerdict(null), null);
});

test('a sound draft passes unchanged, and the reviewer is of another provider than the answerer', async () => {
  const f = fakes();
  const r = await run(f);
  assert.equal(r.text, DRAFT);
  assert.equal(r.note, '');
  assert.equal(r.report.verdict, 'pass');
  assert.equal(r.report.reviewer, 'fake-reviewer');
  assert.equal(f.calls.ask.length, 1);
  assert.equal(f.calls.ask[0].opts.exceptProvider, 'gemini');
  assert.equal(f.calls.ask[0].opts.role, 'review');
  assert.equal(f.calls.redraft.length, 0);
});

test('a problem seen in the text alone is redrafted once, and Boon is told', async () => {
  const f = fakes({ replies: ['{"problems":[{"type":"contradiction","claim":"the house is only a set of walls","issue":"it holds the opposite position"}],"search":[]}'] });
  const r = await run(f, { stance: 'Your position: the house is not only walls.' });
  assert.equal(r.text, NEW_TEXT);
  assert.match(r.note, /Checked before sending: revised for a contradiction of its own position/);
  assert.equal(r.report.verdict, 'revised');
  assert.equal(f.calls.redraft.length, 1, 'redrafted once');
  assert.equal(f.calls.redraft[0].draft, DRAFT);
  assert.match(f.calls.ask[0].prompt, /own stored positions/);
});

test('an unsupported claim counts only if the search contradicts it, with a source', async () => {
  const unsupported = '{"problems":[{"type":"unsupported","claim":"Bachelard published The Pit in 1931","issue":"looks invented"}],"search":["Bachelard The Pit 1931"]}';
  const contradicted = '{"problems":[{"type":"contradicted","claim":"Bachelard published The Pit in 1931","issue":"no such book; The Poetics of Space is 1958","evidence":"Britannica: Gaston Bachelard"}]}';
  const f = fakes({ replies: [unsupported, contradicted] });
  const r = await run(f);
  assert.equal(r.report.verdict, 'revised');
  assert.equal(r.report.searched, 1);
  assert.equal(f.calls.search[0].opts.depth, 'basic');
  assert.equal(f.calls.ask.length, 2);
  assert.match(r.note, /a claim the sources contradict/);
  assert.match(redraftPrompt(f.calls.redraft[0].problems), /source: Britannica/);

  const noSource = fakes({ replies: [unsupported, '{"problems":[{"type":"contradicted","claim":"c","issue":"i"}]}'] });
  assert.equal((await run(noSource)).report.verdict, 'pass', 'no source, no problem');
  const unverified = fakes({ replies: [unsupported, PASS] });
  assert.equal((await run(unverified)).report.verdict, 'pass', 'could not verify is not a problem');
  const noEvidence = fakes({ replies: [unsupported], found: null });
  const r3 = await run(noEvidence);
  assert.equal(r3.report.verdict, 'pass', 'with nothing found there is nothing to act on');
  assert.equal(noEvidence.calls.ask.length, 1);
});

test('an unsupported claim with no evidence step is never acted on by itself', async () => {
  const f = fakes({ replies: ['{"problems":[{"type":"unsupported","claim":"c","issue":"i"}],"search":[]}'] });
  assert.equal((await run(f)).report.verdict, 'pass');
});

test('what code can see (a miscount, a flattering opener) counts even when the reviewer finds nothing', async () => {
  const count = 'Here are seven points:\n\n1. a\n2. b\n3. c\n4. d\n5. e\n';
  const f = fakes();
  const r = await run(f, { draft: count });
  assert.equal(r.report.verdict, 'revised');
  assert.match(r.note, /a miscount/);
  const g = fakes();
  const r2 = await run(g, { draft: "You're right, and Bachelard goes further than that. " + DRAFT });
  assert.equal(r2.report.verdict, 'revised');
  assert.match(r2.note, /an opening that flattered/);
});

test('if the reviewer is down, unreadable, unknown or out of time, the draft goes out untouched', async () => {
  const down = fakes({ replies: [new Error('HTTP 429')] });
  const r = await run(down);
  assert.equal(r.text, DRAFT);
  assert.equal(r.note, '');
  assert.match(r.report.skipped, /no reviewer/);
  assert.equal(down.calls.redraft.length, 0);

  assert.match((await run(fakes({ replies: ['sorry, I cannot do that'] }))).report.skipped, /unreadable/);
  assert.match((await run(fakes(), { answeredBy: 'some-model-nobody-has' })).report.skipped, /unknown/);
  const rushed = fakes();
  assert.match((await run(rushed, { deadline: later(5000) })).report.skipped, /time/);
  assert.equal(rushed.calls.ask.length, 0, 'nothing is started when there is no time');
});

test('a reviewer that is too slow is abandoned', async () => {
  const slow = { ask: () => new Promise(() => {}), search: async () => null, redraft: async () => NEW_TEXT, limits: { start: 100 } };
  const r = await reviewDraft({ query: ASKED, draft: DRAFT, answeredBy: 'gemini-3.8-flash', messages: [], system: 's', deadline: later(2300), deps: slow });
  assert.equal(r.text, DRAFT);
  assert.ok(r.report.skipped);
});

test('if the reply cannot be written again, the draft goes out and the problem is stated', async () => {
  const f = fakes({ replies: ['{"problems":[{"type":"missed","claim":"","issue":"it never says what he argues about the attic"}],"search":[]}'], redraft: null });
  const r = await run(f);
  assert.equal(r.text, DRAFT);
  assert.equal(r.report.verdict, 'flagged');
  assert.match(r.note, /found part of the question left unanswered, which I could not correct in time/);
  const short = fakes({ replies: ['{"problems":[{"type":"missed","claim":"","issue":"x"}],"search":[]}'], redraft: 'Sorry.' });
  assert.equal((await run(short)).report.verdict, 'flagged', 'a stub of a reply is not accepted');
});

test('the labels and the redraft instruction are short and plain', () => {
  const ps = [{ type: 'count', claim: 'seven points', issue: 'lists five', evidence: '' }, { type: 'count', claim: 'seven points', issue: 'lists five', evidence: '' }, { type: 'flattery', claim: '', issue: '', evidence: '' }, { type: 'missed', claim: '', issue: 'x', evidence: '' }, { type: 'contradicted', claim: 'c', issue: 'i', evidence: 's' }];
  const label = labelProblems(ps);
  assert.equal(label.split('; ').length, 3, 'at most three, no repeats');
  assert.match(label, /a miscount \(\u201cseven points\u201d\)/);
  const p = redraftPrompt(ps);
  assert.match(p, /Do not mention the review/);
  assert.match(p, /Do not open by agreeing or praising/);
  assert.match(reviewPrompt({ query: 'q', draft: 'd', stance: '' }), /Do not invent problems/);
  assert.ok(!/own stored positions/.test(reviewPrompt({ query: 'q', draft: 'd', stance: '' })), 'no positions block when there are none');
});
