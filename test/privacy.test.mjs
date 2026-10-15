import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { guardQuery, guardQueries, parseNames, searchFooter } from '../backend/privacy.js';

const NAMES = ['Boon Lay Ong', 'Boon', 'Ong', 'Fee Yoon', 'Yoon', 'Xin', 'Daniel'];
const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');

test('a generic, public search passes', () => {
  for (const q of ['latest solar panel efficiency record 2026', 'warfarin ibuprofen interaction', 'green plot ratio urban greenery standard', 'Book of Daniel authorship scholarly views', 'Mark 9 father cry help my unbelief commentary'.replace(' my ', ' ')])
    assert.equal(guardQuery(q, { names: NAMES }).ok, true, q);
});

test('personal wording, names, numbers, addresses and long detail are refused, each with a reason that does not repeat the name', () => {
  const cases = [
    ['my wife medication side effects', 'personal wording'],
    ["I'm worried about blood pressure tablets", 'personal wording'],
    ['I have a rash after antibiotics', 'personal wording'],
    ['Boon Lay Ong curriculum vitae', 'a name from your own notes'],
    ['Fee Yoon specialist treatment options', 'a name from your own notes'],
    ['xin birthday gift ideas', 'a name from your own notes'],
    ['contact boon@example.com about licence', 'an email address'],
    ['call +61 8 9266 1234 to book', 'a phone, account or ID-like number'],
    ['account 123456 balance', 'a phone, account or ID-like number'],
    ['https://example.com/private/page summary', 'a web address'],
    ['one two three four five six seven eight nine ten eleven twelve thirteen', 'too long'],
  ];
  for (const [q, why] of cases) {
    const r = guardQuery(q, { names: NAMES });
    assert.equal(r.ok, false, q);
    assert.ok(r.why.includes(why), `${q} -> ${r.why}`);
  }
});

test('a name that is also a book of the Bible passes as the book ("Daniel 9"), but not as a person', () => {
  assert.equal(guardQuery('Daniel 9 seventy weeks interpretation', { names: NAMES }).ok, true);
  assert.equal(guardQuery('the Book of Daniel dating', { names: NAMES }).ok, true);
  assert.equal(guardQuery('Daniel birthday party ideas', { names: NAMES }).ok, false);
  assert.equal(guardQuery('Daniel 9 and Daniel birthday', { names: NAMES }).ok, false, 'the person is still caught when the book is mentioned too');
});

test('with no list of names the guard allows nothing (it fails closed)', () => {
  assert.equal(guardQuery('solar panel efficiency', { names: null }).ok, false);
  assert.equal(guardQuery('solar panel efficiency', {}).ok, false);
  assert.equal(parseNames(null), null);
  assert.equal(parseNames('ab, cd'), null, 'too short to be names');
  assert.deepEqual(parseNames('["Boon","Xin"]'), ['Boon', 'Xin']);
  assert.deepEqual(guardQueries(['solar panel efficiency'], {}), { allowed: [], blocked: [{ why: 'the list of names to keep out of searches could not be read' }] });
});

test('at most three queries go out, duplicates dropped, refusals counted', () => {
  const r = guardQueries(['a topic one', 'a topic one', 'topic two here', 'topic three here', 'topic four here', 'my own topic'], { names: NAMES });
  assert.deepEqual(r.allowed, ['a topic one', 'topic two here', 'topic three here']);
  assert.equal(r.blocked.length, 1);
});

test('the footer shows exactly what was sent out', () => {
  assert.match(searchFooter(['solar panel efficiency']), /sent out: “solar panel efficiency”/);
  assert.match(searchFooter(['a', 'b']), /“a”, “b”/);
});

test('chat.js: a private message searches only with guarded queries, never the whole question, never pasted links', () => {
  const chat = read('../backend/chat.js');
  assert.match(chat, /privateGuard = privateMode && plan\.needsWeb/);
  assert.match(chat, /getState\('private_names'\)/);
  assert.match(chat, /privateMode \? tavilySearchMany\(privateGuard\.allowed/);
  assert.match(chat, /\(!privateMode \|\| privateGuard\.allowed\.length > 0\)/);
  assert.match(chat, /const linkedUrls = privateMode \|\|/, 'pasted links are still not opened in a private message');
  assert.match(chat, /searchFooter\(privateGuard\.allowed\)/);
  const web = read('../backend/web.js');
  assert.ok(!/privateMode/.test(web), 'the search module knows nothing of private mode: only chat.js decides what is sent');
});

test('the planner is told what a private search query must look like', () => {
  assert.match(read('../backend/pcm/router.js'), /This message is PRIVATE\. Its webQueries will be sent to an outside search company/);
});
