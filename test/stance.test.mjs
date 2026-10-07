// Mobius's own positions (pcm/stance.js) and the resting of models that are out of allowance (ai/cascade.js).
// No network, no database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStance, renderStance, stancesFor, mergeUpdate, cleanKeywords, MAX_COVERED } from '../backend/pcm/stance.js';
import { restFor, retryDelayMs } from '../backend/ai/cascade.js';
import { BASE_PROMPT } from '../backend/ai/prompt.js';

const row = (key, keywords, s) => ({ key, keywords, content: JSON.stringify(s) });
const GOD = row('God', ['god', 'theism', 'atheist'], { position: 'Open.', confidence: 'high that it is open', because: 'No decisive argument.', change: 'A new argument.', covered: [] });
const WAR = row('Religion, power and violence', ['violence', 'cartel', 'christianity'], { position: 'Both strands are real.', covered: [] });

test('a position is shown only when the message bears on it, and "Godfather" is not God', () => {
  assert.match(stancesFor([GOD, WAR], 'Does God exist?'), /Your position: Open\./);
  assert.equal(stancesFor([GOD, WAR], 'The Godfather trilogy captures this reality well.'), '');
  assert.equal(stancesFor([GOD, WAR], 'What is the capital of France?'), '');
  const both = stancesFor([GOD, WAR], 'How do cartel leaders reconcile Christianity with violence, and where is God in it?');
  assert.match(both, /Both strands are real/);
  assert.match(both, /Open\./);
});

test('a longer keyword may carry a suffix: "christian" finds Christianity', () => {
  assert.match(stancesFor([row('X', ['christian'], { position: 'p' })], 'Christianity and power'), /Your position: p/);
});

test('an update that leaves the position out records what was argued and leaves the position alone', () => {
  const merged = mergeUpdate(GOD, { covered: [{ point: 'Boon argued morality is a social development, not divine', outcome: 'held' }] }, '2026-10-06');
  assert.equal(merged.position, 'Open.');
  assert.equal(merged.revised, null);
  assert.equal(merged.covered.length, 1);
  assert.equal(merged.covered[0].date, '2026-10-06');
  assert.equal(merged.covered[0].outcome, 'held');
});

test('a new position is taken, dated, and the old one is not lost to a repeat of an argument', () => {
  const once = mergeUpdate(GOD, { covered: [{ point: 'The moral argument from obligation', outcome: 'open' }] }, '2026-10-06');
  const twice = mergeUpdate({ content: JSON.stringify(once) }, { covered: [{ point: 'the moral argument from obligation!', outcome: 'held' }], position: 'Leaning to open, with theism slightly ahead.' }, '2026-10-07');
  assert.equal(twice.covered.length, 1, 'the same argument is not recorded twice');
  assert.equal(twice.position, 'Leaning to open, with theism slightly ahead.');
  assert.equal(twice.revised, '2026-10-07');
});

test('a new topic without a position of its own is not kept, and the record of what was argued is bounded', () => {
  assert.equal(mergeUpdate(null, { covered: [{ point: 'Something that was argued at length', outcome: 'open' }] }, '2026-10-06'), null);
  let s = GOD;
  for (let i = 0; i < MAX_COVERED + 6; i++) s = { content: JSON.stringify(mergeUpdate(s, { covered: [{ point: `argument number ${i} about the cosmos`, outcome: 'open' }] }, '2026-10-06')) };
  assert.equal(parseStance(s.content).covered.length, MAX_COVERED);
});

test('what has been argued is shown to the model as not to be rerun', () => {
  const text = renderStance('God', { position: 'Open.', covered: [{ date: '2026-10-05', point: 'Fine-tuning versus a multiverse', outcome: 'open' }] });
  assert.match(text, /do not rerun it/);
  assert.match(text, /Fine-tuning versus a multiverse \[open\]/);
});

test('plain text and junk content do not break reading', () => {
  assert.equal(parseStance('Just a sentence.').position, 'Just a sentence.');
  assert.deepEqual(parseStance('{"position":"p"}').covered, []);
  assert.deepEqual(cleanKeywords(['ab', ' Faith ', 7, null]), ['Faith']);
});

test('the system prompt keeps Mobius from siding by reflex', () => {
  for (const rule of ['neither is the default', 'You have positions of your own', 'Take neither the believer', 'already argued', 'do not treat his faith']) {
    assert.ok(BASE_PROMPT.includes(rule), `system prompt lost: ${rule}`);
  }
  assert.ok(!BASE_PROMPT.includes('Disagreement is the default'), 'reflexive disagreement is gone');
});

test('a provider\'s retry hint is understood, in both styles', () => {
  assert.equal(retryDelayMs('... "retryDelay": "37s" ...'), 37000);
  assert.equal(retryDelayMs('Please try again in 1h2m3.5s.'), 3723500);
  assert.equal(retryDelayMs('Please try again in 850ms.'), 850);
  assert.equal(retryDelayMs('Please try again in 15m33s.'), 933000);
  assert.equal(retryDelayMs('no hint here'), null);
});

test('a spent daily allowance rests for hours, a per-minute limit for a short while, and nothing rests for ever', () => {
  const groqDay = restFor(429, 'Rate limit reached ... on tokens per day (TPD): Limit 200000 ... Please try again in 5h2m3s.', 'groq');
  assert.equal(groqDay.daily, true);
  assert.equal(groqDay.ms, 3 * 3600e3, 'capped at three hours so it is rechecked');
  const geminiDay = restFor(429, '"quotaId": "GenerateRequestsPerDayPerProjectPerModel-FreeTier" ... "retryDelay": "13s"', 'gemini');
  assert.equal(geminiDay.daily, true);
  assert.ok(geminiDay.ms >= 15 * 60e3 && geminiDay.ms <= 3 * 3600e3);
  assert.equal(restFor(429, 'tokens per minute (TPM) ... Please try again in 3.2s.', 'groq').ms, 15000, 'at least fifteen seconds');
  assert.equal(restFor(429, 'too many requests', 'groq').ms, 60000);
  assert.equal(restFor(404, '', 'gemini').ms, 6 * 3600e3);
  assert.equal(restFor(500, '', 'gemini').ms, 20000);
  // 5-6 Oct 2026: four Gemini models answered 503 to almost every message and a flat 20 s rest meant each message paid for all four again
  assert.equal(restFor(503, '', 'gemini', 1).ms, 40000, 'each failure in a row doubles the rest');
  assert.equal(restFor(503, '', 'gemini', 3).ms, 160000);
  assert.equal(restFor(503, '', 'gemini', 50).ms, 15 * 60e3, 'but never beyond fifteen minutes, so a recovered model is found again');
});
