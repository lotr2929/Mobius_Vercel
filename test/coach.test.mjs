// test/coach.test.mjs - the coach (backend/coach.js). Pure parts are tested directly; the privacy promises are pinned by tripwires that
// fail if any other file touches the coach's tables, if the coach ever sends a word to a model that may train, or if a job that reads
// ordinary messages learns of the coaching.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseCoachMessage, modeActive, MODE_IDLE_MS, dayKey, dayStartUtc, addDays, weekdayOf, monday, parseDue, describeDue, formatItems,
  distressSignal, parseCoachCommand, COACH_PROMPT, DISTRESS_NOTE, buildCoachSystem, buildJournalPrompt, parseJournalReply,
} from '../backend/coach.js';

const backend = fileURLToPath(new URL('../backend/', import.meta.url));
const walk = d => readdirSync(d).flatMap(n => { const p = join(d, n); return statSync(p).isDirectory() ? (n === 'node_modules' ? [] : walk(p)) : (p.endsWith('.js') || p.endsWith('.mjs')) ? [p] : []; });
const files = walk(backend).map(p => ({ name: relative(backend, p).replace(/\\/g, '/'), text: readFileSync(p, 'utf8') }));
const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');
const NOW = new Date('2026-10-29T03:00:00Z'); // Thursday 29 October 2026, 11 am in Perth

test('the prefix: "Coach:" starts or continues, "Coach: off" leaves, anything else is not coaching', () => {
  assert.deepEqual(parseCoachMessage('Coach: I slept badly'), { prefixed: true, body: 'I slept badly', leave: false });
  assert.deepEqual(parseCoachMessage('  coach - hello'), { prefixed: true, body: 'hello', leave: false });
  assert.equal(parseCoachMessage('Coach:').body, '');
  for (const w of ['off', 'Done', 'end.', 'stop', "that's all", 'bye']) assert.equal(parseCoachMessage('Coach: ' + w).leave, true, w);
  assert.equal(parseCoachMessage('Coach: I am done with this marking').leave, false);
  assert.equal(parseCoachMessage('My coach said so').prefixed, false);
  assert.equal(parseCoachMessage('Private: coach: x').prefixed, false);
});

test('a session stays open for four quiet hours, then closes by itself', () => {
  const t = Date.now();
  assert.equal(modeActive({ on: true, at: new Date(t - 3600e3).toISOString() }, t), true);
  assert.equal(modeActive({ on: true, at: new Date(t - MODE_IDLE_MS - 1000).toISOString() }, t), false);
  assert.equal(modeActive({ on: false, at: new Date(t).toISOString() }, t), false);
  assert.equal(modeActive(null, t), false);
});

test('days are Boon\'s own: Perth is eight hours ahead of UTC', () => {
  assert.equal(dayKey(new Date('2026-10-29T16:30:00Z'), 'Australia/Perth'), '2026-10-30');
  assert.equal(dayKey(new Date('2026-10-29T15:30:00Z'), 'Australia/Perth'), '2026-10-29');
  assert.equal(dayStartUtc('2026-10-29', 'Australia/Perth').toISOString(), '2026-10-28T16:00:00.000Z');
  assert.equal(addDays('2026-10-31', 2), '2026-11-02');
  assert.equal(weekdayOf('2026-10-29'), 4);
  assert.equal(monday('2026-10-29'), '2026-10-26');
  assert.equal(monday('2026-11-01'), '2026-10-26');
});

test('due dates are read from ordinary words', () => {
  const p = s => parseDue(s, NOW, 'Australia/Perth');
  assert.equal(p('today'), '2026-10-29');
  assert.equal(p('tomorrow'), '2026-10-30');
  assert.equal(p('yesterday'), '2026-10-28');
  assert.equal(p('Friday'), '2026-10-30');
  assert.equal(p('Sat 31 Oct'), '2026-10-31', 'a written date beats its weekday');
  assert.equal(p('sunday evening'), '2026-11-01');
  assert.equal(p('Monday'), '2026-11-02');
  assert.equal(p('Thursday'), '2026-10-29');
  assert.equal(p('next Thursday'), '2026-11-05');
  assert.equal(p('2 Nov'), '2026-11-02');
  assert.equal(p('Nov 2nd'), '2026-11-02');
  assert.equal(p('31 October 2026'), '2026-10-31');
  assert.equal(p('2026-11-04'), '2026-11-04');
  assert.equal(p('whenever'), null);
  assert.equal(p(''), null);
});

test('how a due date is described, and how the list reads', () => {
  assert.equal(describeDue('2026-10-29', '2026-10-29'), 'due Thu 29 Oct (today)');
  assert.match(describeDue('2026-10-31', '2026-10-29'), /in 2 days/);
  assert.match(describeDue('2026-10-27', '2026-10-29'), /overdue by 2 days/);
  assert.equal(describeDue(null, '2026-10-29'), '');
  assert.match(formatItems([{ id: 3, text: 'Mark BAS150', detail: '12 left', due: '2026-10-31' }], '2026-10-29'), /^#3 Mark BAS150 \[12 left\] \u2014 due Sat 31 Oct \(in 2 days\)$/);
});

test('clear distress is recognised; ordinary venting is not (he must be able to vent without being sent anywhere)', () => {
  for (const t of ['I want to die', 'I wish I were dead', 'I have been thinking about suicide', "I'm going to kill myself", 'I want to end my life', 'Everyone would be better off without me',
    "there's no point in living", "I don't want to live any more", 'thinking of self-harm', 'I want to hurt myself'])
    assert.equal(distressSignal(t), true, t);
  for (const t of ["I'm so fed up with this marking", 'This deadline is killing me', "I can't go on like this with the emails", 'I could kill myself for forgetting my glasses',
    "I'm dead tired", 'exhausted and anxious again', "I'm dying to finish this", 'I woke at 4:43 tense and worried', 'Fee Yoon is not well and I am scared', 'I hate Mondays',
    'no point in replying to that email', 'I feel useless today', 'I am overwhelmed'])
    assert.equal(distressSignal(t), false, t);
});

test('commands are plain rules', () => {
  const c = s => parseCoachCommand(s, NOW, 'Australia/Perth');
  assert.deepEqual(c('show journal'), { cmd: 'show-journal', arg: null });
  assert.deepEqual(c('Show journal 28 Oct'), { cmd: 'show-journal', arg: '28 Oct' });
  assert.deepEqual(c('show commitments'), { cmd: 'show-items' });
  assert.deepEqual(c('done 3'), { cmd: 'item-done', id: 3 });
  assert.deepEqual(c('Done #12.'), { cmd: 'item-done', id: 12 });
  assert.deepEqual(c('drop 4'), { cmd: 'item-drop', id: 4 });
  assert.deepEqual(c('later 5 to Friday'), { cmd: 'item-move', id: 5, due: '2026-10-30', phrase: 'Friday' });
  assert.deepEqual(c('add: submit the Accelerate draft by Sunday'), { cmd: 'item-add', text: 'submit the Accelerate draft', due: '2026-11-01' });
  assert.deepEqual(c('add call the bank'), { cmd: 'item-add', text: 'call the bank', due: null });
  assert.deepEqual(c('note: mornings are hardest'), { cmd: 'profile-add', text: 'mornings are hardest' });
  assert.deepEqual(c('close the day'), { cmd: 'close-day' });
  assert.deepEqual(c('weekly review'), { cmd: 'weekly' });
  assert.deepEqual(c('forget entry 28 Oct'), { cmd: 'forget-entry', arg: '28 Oct' });
  for (const t of ['I am done with this', 'I added too much today', 'Tell me about my journal habits', 'drop it', 'show me what you think', 'done'])
    assert.equal(c(t), null, t);
});

test('the character: honest, brief, British, speaks to him, never sends him to a professional without clear distress', () => {
  for (const line of [
    'You are Mobius, acting as Boon\'s personal coach', 'not a counsellor and not a doctor', 'Speak TO him', 'British English',
    'Never open by praising or agreeing', 'No flattery', 'Listen first', 'Do not fix, lecture', 'answer it directly: never ask whether he wants to be listened to when he has asked something', 'weigh it honestly against the open commitments', 'Do NOT suggest a therapist, counsellor, psychologist, doctor or helpline in ordinary conversation',
    'CLEAR DISTRESS', 'promise less, deliver more', 'Ask at most one question at a time', 'only after he has said yes to something', 'never dictate his day', 'Never invent a number', 'do not raise his faith unless he does',
    'never advise on medicines or doses', 'Do not recite his health, his family or his worries back to him unless he raises them', 'capable, experienced adult', 'Never remind him about check-ups, appointments, medicines, sleep habits or looking after himself', 'never claim to be any other assistant or vendor',
  ]) assert.ok(COACH_PROMPT.includes(line), 'missing: ' + line);
  assert.ok(COACH_PROMPT.length < 6000, 'the prompt must leave room in a 22,000-character window');
  assert.match(DISTRESS_NOTE, /13 11 14/);
  assert.match(DISTRESS_NOTE, /000/);
  assert.match(DISTRESS_NOTE, /Do not lecture/);
});

test('the system prompt: the distress note only when needed, the commitments and journal in, and small enough for a 22,000-character model', () => {
  const items = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, text: 'A commitment number ' + i + ' with some words', due: '2026-11-02', detail: null }));
  const entries = Array.from({ length: 5 }, (_, i) => ({ period: '2026-10-2' + i, content: 'x'.repeat(4000) }));
  const base = { profile: 'p'.repeat(6000), items, entries, week: { content: 'w'.repeat(4000) }, now: NOW, tz: 'Australia/Perth' };
  const plain = buildCoachSystem(base, { distress: false });
  const flagged = buildCoachSystem(base, { distress: true });
  assert.ok(!plain.includes('CLEAR DISTRESS: his last message'));
  assert.ok(flagged.includes('CLEAR DISTRESS: his last message'));
  assert.ok(plain.length < 15000, 'system prompt is ' + plain.length); // worst case: a full profile, 25 commitments, 3 long entries and a week review
  assert.ok(flagged.length < 16000);
  assert.match(plain, /#1 A commitment number 0/);
  assert.match(plain, /Your journal of recent days/);
  assert.ok(!plain.includes('#26 '), 'no more than 25 commitments are sent');
  assert.match(buildCoachSystem({ ...base, opening: true }, {}), /just opened a coaching session/);
  assert.match(buildCoachSystem({ ...base, newSession: true }, {}), /first message of a new coaching session/);
  assert.match(buildCoachSystem({ now: NOW, tz: 'Australia/Perth' }, {}), /no open commitments/);
});

test('the journal: what the model proposes is checked against the real list before anything changes', () => {
  const reply = '```json\n' + JSON.stringify({ entry: '**DATE:** x', items: [
    { op: 'add', text: 'Submit the draft', due: '2026-11-01', detail: null }, { op: 'add', text: '   ' }, { op: 'add', text: 'No date', due: 'soon' },
    { op: 'done', id: 3 }, { op: 'done', id: 99 }, { op: 'drop', id: 4 }, { op: 'update', id: 3, due: '2026-11-03', detail: '8 left' }, { op: 'delete', id: 3 }, 'junk', null,
  ] }) + '\n```';
  const r = parseJournalReply(reply, [3, 4]);
  assert.equal(r.parsed, true);
  assert.equal(r.entry, '**DATE:** x');
  assert.deepEqual(r.ops, [
    { op: 'add', text: 'Submit the draft', due: '2026-11-01', detail: null },
    { op: 'add', text: 'No date', due: null, detail: null },
    { op: 'done', id: 3 }, { op: 'drop', id: 4 }, { op: 'update', id: 3, due: '2026-11-03', detail: '8 left' },
  ]);
  const bad = parseJournalReply('Here is the entry: it was a long day.', [1]);
  assert.equal(bad.parsed, false);
  assert.deepEqual(bad.ops, [], 'an unreadable reply never changes a commitment');
  assert.match(bad.entry, /long day/);
});

test('the journal prompt asks for the five-part layout, keeps to what was said, and carries the transcript', () => {
  const p = buildJournalPrompt({ day: '2026-10-29', transcript: 'Boon: I slept six hours.', items: [{ id: 7, text: 'Mark BAS150', due: '2026-10-31', detail: '12 left' }], previous: 'yesterday text' });
  for (const h of ['**1. HEALTH & ENERGY**', '**2. CAREGIVING & HOUSEHOLD**', '**3. WORKLOAD & PROGRESS**', '**4. CREATION & PROJECTS**', "**5. REFLECTION & NEXT DAY'S INTENTION**", '**AGREED**'])
    assert.ok(p.includes(h), h);
  assert.match(p, /Thursday 29 October 2026/);
  assert.match(p, /#7 Mark BAS150 \[12 left\] \(due 2026-10-31\)/);
  assert.match(p, /Boon: I slept six hours\./);
  assert.match(p, /Add an item only if he clearly agreed to it/);
});

// ── Tripwires ───────────────────────────────────────────────────────────────
test('only coach.js touches the coach\'s tables (the backup script copies them to this PC; the schema creates them)', () => {
  for (const t of ['mobius_coach_journal', 'mobius_coach_items'])
    assert.deepEqual(files.filter(f => f.text.includes(t)).map(f => f.name).sort(), ['backup-cli.mjs', 'coach.js'], t);
});

test('only chat.js and server.js import the coach, and only coach.js and chat.js/server.js import the sealed module', () => {
  assert.deepEqual(files.filter(f => /from\s+'\.{1,2}\/coach\.js'/.test(f.text)).map(f => f.name).sort(), ['chat.js']);
  assert.deepEqual(files.filter(f => /from\s+'\.{1,2}\/(?:pcm\/)?sealed\.js'/.test(f.text)).map(f => f.name).sort(), ['chat.js', 'coach.js', 'server.js']);
});

test('the coach never reaches a model that may train: every call is private-only', () => {
  const src = files.find(f => f.name === 'coach.js').text.replace(/\/\/[^\n]*/g, '');
  // each call is read to its closing bracket, however much is nested inside it
  const calls = [];
  for (const m of src.matchAll(/\b(?:runCascade|askModel)\(/g)) {
    if (/\bimport\b[^;]*$/.test(src.slice(Math.max(0, m.index - 80), m.index))) continue;
    let depth = 0, i = m.index + m[0].length - 1;
    for (; i < src.length; i++) { if (src[i] === '(') depth++; else if (src[i] === ')' && --depth === 0) break; }
    calls.push(src.slice(m.index, i + 1));
  }
  assert.ok(calls.length >= 3, 'found ' + calls.length + ' model calls (the conversation, the day entry, the week review)');
  for (const c of calls) assert.match(c, /privateOnly: true/, 'must be private-only: ' + c.slice(0, 90));
});

test('the coach uses no web search, embedding, learning, mood, review, router or library step', () => {
  const src = files.find(f => f.name === 'coach.js').text;
  const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map(m => m[1]).sort();
  assert.deepEqual(imports, ['./ai/cascade.js', './config.js', './db.js', './pcm/memory.js', './pcm/messages.js', './pcm/sealed.js', './trace.js', './util.js']);
  assert.ok(!/tavily|embed|learnFrom|moodFrom|reviewDraft|analyse\(|libraryContext/.test(src.replace(/\/\/[^\n]*/g, '')));
});

test('chat.js: the coach branch comes before anything is looked up, and never takes a private or forced-model message', () => {
  const chat = read('../backend/chat.js');
  const at = chat.indexOf('const route = await safe(() => coachRoute(asked), null);');
  assert.ok(at > 0 && at < chat.indexOf("const trace = startTrace('chat'"), 'the coach branch precedes the ordinary trace');
  assert.match(chat, /if \(!privateMode && !forceProvider\) \{\s*\n\s*const route = await safe\(\(\) => coachRoute\(asked\), null\);/);
  assert.match(chat, /yield\* coachTurn\(\{ route, signal, dryRun, tz: ctx\.tz, /);
});

test('jobs that read ordinary messages know nothing of the coach', () => {
  for (const name of ['pcm/maintain.js', 'pcm/chats.js', 'pcm/retrieve.js', 'mood.js', 'pcm/learn.js', 'pcm/embed.js', 'pcm/review.js', 'pcm/notes.js', 'pcm/router.js', 'pcm/stance.js', 'pcm/profile.js', 'docs/digest.js'])
    for (const f of files.filter(f => f.name === name)) assert.ok(!/coach/i.test(f.text), name + ' must not mention the coach');
});

test('sealed.js: a private turn never sees coaching, the coach sees only its own, and the history screen shows both', () => {
  const s = read('../backend/pcm/sealed.js');
  assert.match(s, /sealedRows\(limit, 'private'\)/);
  assert.match(s, /sealedRows\(limit, 'coach'\)/);
  assert.match(s, /q = q\.is\('kind', null\)/);
  assert.match(s, /row\.kind === 'coach' \? 'Coach: ' : 'Private: '/);
  assert.match(s, /\.\.\.tag/);
});

test('schema: the coach tables exist with row-level security, and the sealed table has its kind column', () => {
  const sql = read('../supabase/schema.sql');
  assert.match(sql, /alter table mobius_sealed_messages add column if not exists kind text/);
  for (const t of ['mobius_coach_journal', 'mobius_coach_items']) {
    assert.match(sql, new RegExp('create table if not exists ' + t));
    assert.match(sql, new RegExp('alter table ' + t + ' enable row level security'));
  }
  assert.match(sql, /unique \(kind, period\)/);
});

test('backup: the coach\'s tables stay out of the Drive backup and are copied to this PC only', () => {
  const b = read('../backend/backup-cli.mjs');
  assert.match(b, /const SKIP = new Set\(\[[^\]]*'mobius_coach_journal'[^\]]*'mobius_coach_items'/);
  assert.match(b, /await backupCoachLocally\(\)/);
  assert.match(b, /coach-\$\{stamp\(\)\}\.json\.gz/);
  assert.ok(!/DRIVE_DIR[^\n]*coach|coach[^\n]*DRIVE_DIR/i.test(b.replace(/\/\/[^\n]*/g, '')), 'no code path writes the coaching journal to the Drive folder');
});
