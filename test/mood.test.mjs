// test/mood.test.mjs - the mood record (backend/mood.js). No network, no database, no model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FEELING_CUE, MOOD_ASK, GREETING, dayOf, dayRoll, isChatStart, shouldGreet, moodStats, shouldRaisePattern, moodText } from '../backend/mood.js';
import fs from 'node:fs';

const NOW = new Date('2026-10-08T04:00:00Z'); // noon in Perth
const ago = (days, extra = {}) => ({ id: Math.random(), created_at: new Date(NOW - days * 86400000).toISOString(), kind: 'report', score: -1, quote: 'a bit flat', ...extra });

test('the gate lets feeling statements through and keeps ordinary messages out', () => {
  for (const s of ['I have been feeling quite down lately', 'I am feeling a bit low today', "I'm tired", 'I\u2019ve been so flat this week', 'Feeling much better today',
    'my mood has been poor', 'good day today', 'I can\u2019t sleep', 'Honestly I feel rubbish', 'I am not very well', 'I have no energy at all', 'feeling a bit flat'])
    assert.ok(FEELING_CUE.test(s), s);
  for (const s of ['Can you write a healing prayer for Fee Yoon', 'What is the capital of France?', 'Explain Matthew 22', 'How do I deploy the app?', 'The weather in Perth is good'])
    assert.ok(!FEELING_CUE.test(s), s);
});

test('questions about his mood are told from other questions', () => {
  for (const s of ['How have I been lately?', 'give me a summary of my mood for my GP', 'my mood this month', 'Can you write something for my GP about how I have been'])
    assert.ok(MOOD_ASK.test(s), s);
  for (const s of ['hello there', 'What did Tillich mean by the ground of being?', 'Write a prayer for Fee Yoon'])
    assert.ok(!MOOD_ASK.test(s), s);
});

test('the greeting is the plain friendly line, in one place only', () => {
  assert.equal(GREETING, 'How are you keeping today, Boon?');
  const chat = fs.readFileSync(new URL('../backend/chat.js', import.meta.url), 'utf8');
  assert.match(chat, /GREETING/);
  assert.match(chat, /atChatStart/);
});

test('days are Perth days, and "random" days are fixed for a date', () => {
  assert.equal(dayOf('2026-10-08T17:00:00Z', 'Australia/Perth'), '2026-10-09'); // 1 am next day in Perth
  assert.equal(dayRoll('2026-10-08'), dayRoll('2026-10-08'));
  const rolls = Array.from({ length: 200 }, (_, i) => dayRoll(dayOf(new Date(NOW - i * 86400000))));
  const share = rolls.filter(r => r < 0.3).length / rolls.length;
  assert.ok(share > 0.18 && share < 0.42, `about three days in ten (${share})`);
});

test('a chat starts after a long silence', () => {
  assert.equal(isChatStart(null, NOW), true);
  assert.equal(isChatStart(new Date(NOW - 5 * 60000), NOW), false);
  assert.equal(isChatStart(new Date(NOW - 3 * 3600000), NOW), true);
});

test('greeting: at most twice a week, never twice a day, never after he has said how he is, never on consecutive days', () => {
  const always = { now: NOW, chance: 1.1 };
  assert.equal(shouldGreet({ ...always, rows: [] }), true);
  assert.equal(shouldGreet({ now: NOW, chance: 0, rows: [] }), false);
  assert.equal(shouldGreet({ ...always, rows: [ago(0, { kind: 'asked', score: null })] }), false, 'already asked today');
  assert.equal(shouldGreet({ ...always, rows: [ago(0.1, { kind: 'report' })] }), false, 'said how he is today');
  assert.equal(shouldGreet({ ...always, rows: [ago(1, { kind: 'asked', score: null })] }), false, 'yesterday');
  assert.equal(shouldGreet({ ...always, rows: [ago(3, { kind: 'asked', score: null })] }), true, 'three days ago is fine');
  assert.equal(shouldGreet({ ...always, rows: [ago(3, { kind: 'asked', score: null }), ago(5, { kind: 'asked', score: null })] }), false, 'two already this week');
  assert.equal(shouldGreet({ ...always, rows: [ago(3, { kind: 'asked', score: null }), ago(9, { kind: 'asked', score: null })] }), true);
});

test('over a simulated year the greeting averages one to two a week and never breaks the limits', () => {
  const rows = [];
  let total = 0;
  for (let d = 365; d >= 0; d--) {
    const now = new Date(NOW - d * 86400000);
    if (shouldGreet({ now, rows })) { rows.push({ kind: 'asked', created_at: now.toISOString() }); total++; }
  }
  const perWeek = total / (366 / 7);
  assert.ok(perWeek >= 0.8 && perWeek <= 2, `${perWeek.toFixed(2)} a week`);
});

test('statistics compare the last fortnight with his own usual, and say so when there is too little to compare', () => {
  const calm = Array.from({ length: 12 }, (_, i) => ago(20 + i * 5, { score: 0 }));
  const flat = [1, 2, 4, 6, 8, 10].map(d => ago(d, { score: -1 }));
  const s = moodStats([...calm, ...flat], NOW);
  assert.equal(s.n14, 6);
  assert.equal(s.verdict, 'lower');
  assert.equal(s.lowRun, true);
  assert.equal(moodStats([...flat], NOW).verdict, 'unknown');
  const few = moodStats([ago(1), ago(2)], NOW);
  assert.equal(few.lowRun, false, 'two reports are never a pattern');
  const oneDay = moodStats([...calm, ...[0.1, 0.2, 0.3, 0.4, 0.5].map(d => ago(d, { score: -2 }))], NOW);
  assert.equal(oneDay.lowRun, false, 'one bad day is not a run');
  const steady = moodStats([...calm.map(r => ({ ...r, score: -1 })), ...flat], NOW);
  assert.equal(steady.verdict, 'usual', 'low is his usual, so this fortnight is not unusual');
  assert.equal(steady.lowRun, false);
});

test('a low run is raised once in two weeks, no more', () => {
  const calm = Array.from({ length: 12 }, (_, i) => ago(20 + i * 5, { score: 0 }));
  const flat = [1, 2, 4, 6, 8, 10].map(d => ago(d, { score: -1 }));
  const rows = [...calm, ...flat];
  assert.equal(shouldRaisePattern({ stats: moodStats(rows, NOW), rows, now: NOW }), true);
  const withNote = [...rows, ago(5, { kind: 'noted', score: null })];
  assert.equal(shouldRaisePattern({ stats: moodStats(withNote, NOW), rows: withNote, now: NOW }), false);
  const old = [...rows, ago(20, { kind: 'noted', score: null })];
  assert.equal(shouldRaisePattern({ stats: moodStats(old, NOW), rows: old, now: NOW }), true, 'twenty days after the last time is fine');
});

test('the words given to a model: short by default, with his own words only for a summary', () => {
  const calm = Array.from({ length: 8 }, (_, i) => ago(20 + i * 5, { score: 0, quote: 'ok today' }));
  const flat = [1, 3, 5, 7, 9].map(d => ago(d, { score: -2, quote: 'I cannot face anything' }));
  const rows = [...calm, ...flat], stats = moodStats(rows, NOW);
  const short = moodText(stats, rows, { now: NOW }), full = moodText(stats, rows, { detail: true, now: NOW });
  assert.ok(!short.includes('cannot face'), 'no quotes by default');
  assert.match(short, /LOWER than his own usual/);
  assert.match(short, /how he SAYS he is/);
  assert.match(full, /cannot face/);
  assert.match(full, /Week by week/);
  assert.match(moodText(moodStats([], NOW), [], { now: NOW }), /no record to speak from/);
});

test('the mood record is only ever read by models that do not train, and a private message never reaches it', () => {
  const mood = fs.readFileSync(new URL('../backend/mood.js', import.meta.url), 'utf8');
  assert.match(mood, /privateOnly: true/);
  const chat = fs.readFileSync(new URL('../backend/chat.js', import.meta.url), 'utf8');
  assert.match(chat, /!privateMode[^;]*moodFromMessage|moodFromMessage[^;]*!privateMode|moodJob = !privateMode/);
  assert.match(chat, /privateOnly: privateMode \|\| moodAsk/);
});
