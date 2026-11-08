// test/mode.test.mjs - the four modes: Cloud, Local, Private, Coach. Kept per device and until switched. Local, Private and Coach are all private
// (every message is handled as a "Private:" one); the header badge spells the mode out. No network, no database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseAskPrefix } from '../backend/ai/models.js';
import { coachRoute } from '../backend/coach.js';
import '../frontend/local.js';

const L = globalThis.MobiusLocal;
const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');
const withStorage = fn => {
  const real = globalThis.localStorage; const mem = {};
  globalThis.localStorage = { getItem: k => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = v; } };
  try { return fn(); } finally { globalThis.localStorage = real; }
};

test('the switch: Cloud, Local, Private and Coach are read ("Ask:" or "Mode:"); "Public" means Cloud; ordinary sentences are not', () => {
  assert.deepEqual(L.parseSwitch('Ask: Private'), { mode: 'private', rest: '' });
  assert.deepEqual(L.parseSwitch('ask: coach'), { mode: 'coach', rest: '' });
  assert.deepEqual(L.parseSwitch('Mode: Local'), { mode: 'local', rest: '' });
  assert.deepEqual(L.parseSwitch('Ask: Public'), { mode: 'cloud', rest: '' });
  assert.deepEqual(L.parseSwitch('  Ask: Private  what is x?'), { mode: 'private', rest: 'what is x?' });
  assert.deepEqual(L.parseSwitch('Ask: Cloud, and say it plainly'), { mode: 'cloud', rest: 'and say it plainly' });
  assert.equal(L.parseSwitch('Ask: privately owned'), null, 'a longer word is not the switch');
  assert.equal(L.parseSwitch('Ask: publicly speaking'), null);
  assert.equal(L.parseSwitch('Ask: coaching tips'), null);
  assert.equal(L.parseSwitch('Mode private'), null, 'no colon: an ordinary sentence');
  assert.equal(L.parseSwitch('Private: what is x?'), null, 'the one-message prefix is a different thing, handled by the server');
  assert.equal(L.parseSwitch('Ask: Gemini hello'), null);
  assert.equal(parseAskPrefix('Ask: Qwen hello').forceProvider, 'qwen', 'named models are untouched');
});

test('"Coach:" is read by the page too: it switches to Coach, and "Coach: off" leaves', () => {
  assert.deepEqual(L.parseCoach('Coach: I slept badly'), { leave: false });
  assert.deepEqual(L.parseCoach('coach:'), { leave: false });
  assert.deepEqual(L.parseCoach('Coach: off'), { leave: true });
  assert.deepEqual(L.parseCoach('Coach: Done.'), { leave: true });
  assert.deepEqual(L.parseCoach("coach - that's all"), { leave: true });
  assert.deepEqual(L.parseCoach('Coach: I am done with this marking'), { leave: false });
  assert.equal(L.parseCoach('My coach said so'), null);
  assert.equal(L.parseCoach('Private: coach: x'), null);
});

test('"Private:" switches to Private and stays until "Public:"; from Local or Coach it does not take him out', () => {
  assert.deepEqual(L.parseSticky('Private: what is x?'), { mode: 'private', rest: 'what is x?' });
  assert.deepEqual(L.parseSticky('  confidential - hello'), { mode: 'private', rest: 'hello' });
  assert.deepEqual(L.parseSticky('Private:'), { mode: 'private', rest: '' });
  assert.deepEqual(L.parseSticky('Public: back again'), { mode: 'cloud', rest: 'back again' });
  assert.deepEqual(L.parseSticky('public:'), { mode: 'cloud', rest: '' });
  assert.equal(L.parseSticky('Public - private partnerships'), null, 'Public needs the colon');
  assert.equal(L.parseSticky('Publicly: x'), null);
  assert.equal(L.parseSticky('Privately owned'), null);
  const html = read('../frontend/index.html');
  assert.match(html, /if \(st && \(st\.mode === 'cloud' \|\| MobiusLocal\.getMode\(\) === 'cloud'\)\) \{\s*\n\s*MobiusLocal\.setMode\(st\.mode\)/);
  assert.match(html, /if \(st\.mode === 'cloud'\) q = st\.rest;/, 'only Public: is removed from the message; Private: stays for the server');
});

test('the mode is kept per device until switched, and is Cloud unless set; only Local, Private and Coach are private', () => {
  withStorage(() => {
    assert.equal(L.getMode(), 'cloud'); assert.equal(L.isPrivate(), false);
    for (const m of ['local', 'private', 'coach']) { assert.equal(L.setMode(m), m); assert.equal(L.getMode(), m); assert.equal(L.isPrivate(), true, m + ' is private'); }
    assert.equal(L.setMode('cloud'), 'cloud'); assert.equal(L.isPrivate(), false);
    assert.equal(L.setMode('anything else'), 'cloud', 'anything unrecognised is Cloud');
  });
  assert.equal(L.getMode(), 'cloud', 'with no storage at all it is Cloud');
});

test('chat.js: the flag makes every turn private, the prefix still works, and Coach mode routes to the coach without a prefix', () => {
  const chat = read('../backend/chat.js');
  assert.match(chat, /dryRun = false, local = false, privateAll = false, coachAll = false, laptopTools = false \}\) \{/);
  assert.match(chat, /const prefixPrivate = PRIVATE_PREFIX\.test\(asked\);\s*\n\s*const privateMode = privateAll === true \|\| prefixPrivate;/);
  assert.match(chat, /const userQuery = prefixPrivate \? \(asked\.replace\(PRIVATE_PREFIX, ''\) \|\| asked\) : asked;/, 'only a typed prefix is stripped from the question');
  assert.match(chat, /coachRoute\(asked, \{ forced: coachAll === true \}\)/);
  assert.match(chat, /save: !dryRun, sealed: privateMode/, 'a local answer is filed sealed, because Local is private');
});

test('the coach: the prefix, or the device being in Coach mode; no idle timeout any more', async () => {
  assert.deepEqual(await coachRoute('Coach: hello'), { kind: 'turn', body: 'hello', opening: false });
  assert.equal((await coachRoute('Coach: off')).kind, 'leave');
  assert.deepEqual(await coachRoute('how is my day looking?', { forced: true }), { kind: 'turn', body: 'how is my day looking?', opening: false });
  assert.equal(await coachRoute('how is my day looking?'), null, 'with no prefix and no Coach mode it is an ordinary message, however recently coaching was open');
});

test('server.js and index.html: the page sends the flags from the mode, and the server passes them on strictly', () => {
  const server = read('../backend/server.js'), html = read('../frontend/index.html');
  assert.match(server, /privateMode: privateAll, coach: coachAll \} = req\.body/);
  assert.match(server, /privateAll: privateAll === true, coachAll: coachAll === true/, 'only a real true counts');
  assert.match(html, /if \(MobiusLocal\.isPrivate\(\)\) body\.privateMode = true;/);
  assert.match(html, /if \(MobiusLocal\.getMode\(\) === 'coach'\) body\.coach = true;/);
  assert.match(html, /MobiusLocal\.parseCoach\(q\)/);
  assert.match(html, /if \(co\) \{ if \(!co\.leave\) MobiusLocal\.setMode\('coach'\); else if \(MobiusLocal\.getMode\(\) === 'coach'\) MobiusLocal\.setMode\('cloud'\)/, 'Coach: off leaves Coach only if he is in it, so it never drops him out of Private');
  assert.match(html, /if \(MobiusLocal\.getMode\(\) === 'coach'\) q = q\.replace\(\/\^\\s\*\(\?:private\|confidential\)/, 'in Coach a Private: prefix is dropped, so the message is still coaching');
});

test('the header badge spells the mode out: Cloud, Local, Private or Coach, with "offline" when unreachable', () => {
  const html = read('../frontend/index.html');
  assert.match(html, /b\.textContent = mode\.charAt\(0\)\.toUpperCase\(\) \+ mode\.slice\(1\) \+ \(ok \? '' : ' offline'\);/);
  assert.match(html, /b\.className = 'show' \+ \(mode !== 'cloud' \? ' ' \+ mode : ''\)/);
  for (const m of ['local', 'private', 'coach']) assert.match(html, new RegExp('#mode-badge\\.' + m + '\\{'), m + ' has its own colour');
  assert.doesNotMatch(html, /'L:'|C:Private|C:Public/, 'no abbreviations');
  assert.doesNotMatch(html, /getPrivacy|setPrivacy|parsePrivacy/, 'the separate privacy switch is gone');
});

test('the error log never receives the text of a private message', () => {
  const html = read('../frontend/index.html');
  assert.doesNotMatch(html, /source: q\.slice\(0, 80\)/, 'every report goes through srcOf');
  assert.match(html, /const srcOf = s => \(MobiusLocal\.isPrivate\(\) \|\| PRIVATE_LEAD\.test\(s\)\) \? '\[private\]'/);
});
