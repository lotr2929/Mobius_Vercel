import test from 'node:test';
import assert from 'node:assert/strict';
import { isFileTurn, turnsForLocal } from '../backend/laptop.js';

test('a request about files or folders on the laptop is recognised', () => {
  for (const q of ['Create a file called hello.md in C:/_personal/_mobius saying "test".', 'What folders are in my Atlas?', 'list J:\\My Drive\\Atlas', 'open notes.txt'])
    assert.equal(isFileTurn(q), true, q);
  for (const q of ['hello', 'Who wrote Hebrews?', 'Explain the green plot ratio'])
    assert.equal(isFileTurn(q), false, q);
});

test('a file request goes to Qwen without the earlier turns, so its old wrong answers are not copied; other chat keeps its history', () => {
  const msgs = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'I cannot reach that folder' }, { role: 'user', content: 'new' }];
  assert.deepEqual(turnsForLocal(msgs, 'create a file hello.md in C:/x', true), [msgs[2]]);
  assert.equal(turnsForLocal(msgs, 'create a file hello.md in C:/x', false), msgs);
  assert.equal(turnsForLocal(msgs, 'tell me a story', true), msgs);
});

test('the manual no longer says Mobius can never touch his computer', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../backend/self.js', import.meta.url), 'utf8');
  assert.match(src, /The one exception is the Mobius AI desktop app/);
});