// test/bench.test.mjs — the marking of the model bench (backend/bench/tasks.mjs). No network, no database.
// Every item carries a good answer and a bad one; the marking must tell them apart, or a ranking built on it means nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TASKS, TEST_CTX, allItems, words, sentenceCount, listLines, inOrder } from '../backend/bench/tasks.mjs';

test('every item is marked high for its good answer and low for its bad one', () => {
  const items = allItems();
  assert.ok(items.length >= 35, `a broad bench (${items.length} items)`);
  for (const it of items) {
    const good = it.score(it.good, TEST_CTX), bad = it.score(it.bad, TEST_CTX);
    assert.ok(good.score >= 0.9, `${it.taskId}/${it.id}: good answer scores ${good.score} (${JSON.stringify(good.checks)})`);
    assert.ok(bad.score <= 0.5, `${it.taskId}/${it.id}: bad answer scores ${bad.score} (${JSON.stringify(bad.checks)})`);
  }
});

test('ids are unique, every item can be sent, and every role has something to test', () => {
  const seen = new Set();
  for (const it of allItems()) {
    const id = `${it.taskId}/${it.id}`;
    assert.ok(!seen.has(id), `${id} is unique`); seen.add(id);
    assert.ok(['chat', 'json', 'pipeline'].includes(it.kind), `${id}: kind`);
    if (it.kind === 'pipeline') assert.equal(it.area, 'personal', `${id}: pipeline items are personal`);
    else assert.ok(it.messages || it.build, `${id}: has messages to send`);
  }
  for (const role of ['chat', 'quick', 'learn', 'deep']) assert.ok(TASKS.some(t => t.roles.includes(role)), `${role} has a task`);
});

test('the needle items are built for any window, and the notes survive a small one', () => {
  for (const it of allItems().filter(i => i.build && i.taskId === 'needle')) {
    const small = it.build(9000)[0].content, big = it.build(1e9)[0].content;
    assert.ok(/cello/.test(small), `${it.id}: the fact is in a 9,000-character window`);
    assert.ok(small.length < 9000 && big.length > small.length, `${it.id}: the window is respected`);
  }
});

test('counting helpers', () => {
  assert.equal(words('one two  three-four'), 3);
  assert.equal(sentenceCount('Plants absorb light. Oxygen is released.'), 2);
  assert.equal(sentenceCount('Dr. Smith said so. He left.'), 2);
  assert.equal(listLines('1. a\n2. b\n- c\nnot a line'), 3);
  assert.equal(inOrder('Genesis then Exodus then Numbers', ['Genesis', 'Exodus', 'Numbers']), true);
  assert.equal(inOrder('Exodus then Genesis', ['Genesis', 'Exodus']), false);
});

test('a prayer that quotes from memory is marked down, however fine it reads', () => {
  const memory = TEST_CTX && allItems().find(i => i.id === 'format').score(
    allItems().find(i => i.id === 'format').good.replace('Heal me, O Yahweh, and I will be healed. Save me, and I will be saved; for you are my praise', 'Heal me, O LORD, and I shall be healed; save me, and I shall be saved: for thou art my praise'), TEST_CTX);
  assert.equal(memory.checks.exactScripture, false);
  const medical = allItems().find(i => i.id === 'format').score(allItems().find(i => i.id === 'format').good.replace('restoration', 'recovery from her liver disease'), TEST_CTX);
  assert.equal(medical.checks.discreet, false);
});
