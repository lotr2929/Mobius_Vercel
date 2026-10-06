// Plain-code checks on a finished answer (pcm/checks.js). No network, no database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkAnswer, checkNotice } from '../backend/pcm/checks.js';

const kinds = f => f.map(x => x.kind);

test('a stated count that matches the numbered list passes', () => {
  assert.deepEqual(checkAnswer('There are three reasons:\n\n1. One\n2. Two\n3. Three\n'), []);
  assert.deepEqual(checkAnswer('Five key arguments follow.\n\n1. a\n2. b\n3. c\n4. d\n5. e'), []);
});

test('a stated count that differs from the numbered list is caught, in words or digits', () => {
  const f = checkAnswer('Here are seven points:\n\n1. a\n2. b\n3. c\n4. d\n5. e\n');
  assert.deepEqual(kinds(f), ['count']);
  assert.equal(f[0].stated, 7);
  assert.equal(f[0].listed, 5);
  assert.deepEqual(kinds(checkAnswer('3 reasons:\n1) a\n2) b\n3) c\n4) d')), ['count']);
});

test('hedged counts, prose counts and unrelated lists are left alone', () => {
  assert.deepEqual(checkAnswer('Two or three reasons stand out:\n\n1. a\n2. b\n'), []);
  assert.deepEqual(checkAnswer('At least four points matter here:\n\n1. a\n2. b\n'), []);
  assert.deepEqual(checkAnswer('There are three reasons, and I will give them in prose. First, a. Second, b. Third, c.'), []);
  assert.deepEqual(checkAnswer('There are three reasons for this view.\n\n' + 'x'.repeat(500) + '\n\n1. unrelated\n2. list\n'), [], 'a list far away is not its list');
  assert.deepEqual(checkAnswer('One reason is enough.\n\n1. a\n2. b\n'), [], 'one is not counted');
});

test('opening by agreeing or praising is flagged, an ordinary opening is not', () => {
  for (const s of ["You're right, and that changes things.", 'You are quite right about that.', "\u201cYou\u2019re absolutely right,\u201d", 'Great question. Here is the answer.', "That's a really good point.", 'What a fascinating observation.']) {
    assert.deepEqual(kinds(checkAnswer(s)), ['opener'], s);
  }
  for (const s of ['The question is older than the church.', 'Tillich does not say that.', 'Not quite: the claim is narrower.']) {
    assert.deepEqual(checkAnswer(s), [], s);
  }
});

test('a change of mind is flagged only while one of its own positions was in force', () => {
  const text = 'The sceptical case is stronger than I allowed. I concede that point.';
  assert.deepEqual(checkAnswer(text), []);
  assert.deepEqual(kinds(checkAnswer(text, { positions: true })), ['moved']);
});

test('only a wrong count is shown to Boon', () => {
  const note = checkNotice(checkAnswer('Here are seven points:\n\n1. a\n2. b\n3. c\n'));
  assert.match(note, /seven points/);
  assert.match(note, /lists 3/);
  assert.equal(checkNotice(checkAnswer("You're right.")), '');
  assert.equal(checkNotice([]), '');
  assert.equal(checkNotice(undefined), '');
});

test('empty and odd input does not break the checks', () => {
  assert.deepEqual(checkAnswer(''), []);
  assert.deepEqual(checkAnswer(null), []);
  assert.deepEqual(checkAnswer(undefined, { positions: true }), []);
});
