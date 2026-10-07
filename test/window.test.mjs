// test/window.test.mjs — what a model with a small window is sent (6 Oct 2026). No network, no database.
// Groq's models take about 22,000 characters in all and the system prompt uses half, so about 10,000 are left for everything else.
// One big message trimmed from its middle once threw away Boon's saved prayer instructions: gpt-oss-120b wrote the prayer without them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assembleContext } from '../backend/pcm/assemble.js';

// the parts a theology request produces, with the ranks chat.js gives them
const parts = () => [
  { title: 'Positions', rank: 1, cap: 3400, text: 'position '.repeat(300) },
  { title: 'Shelf', rank: 2, cap: 4500, text: 'shelf '.repeat(800) },
  { title: 'Library passages', rank: 2, cap: 11000, text: 'passage '.repeat(1500) },
  { title: 'Notes', rank: 1, cap: 3000, text: 'NOTE: pray boldly, quote new passages, end with a prayer for Boon, Xin and Daniel. '.repeat(30) },
  { title: 'Week', rank: 4, cap: 3600, text: 'week '.repeat(900) },
];

test('standing notes survive a small window; the bulk of the library does not', () => {
  const small = assembleContext(parts(), 5400);
  assert.match(small.text, /NOTE: pray boldly/, 'the notes are in');
  const notes = small.sections.find(s => s.title === 'Notes');
  assert.ok(notes.chars > 1500, `a useful share of the notes is kept (${notes.chars})`);
  const passages = small.sections.find(s => s.title === 'Library passages');
  assert.ok(passages.chars < 300, 'the library passages give way');
  assert.ok(small.text.length < 5400 + 400, 'the pack fits the room it was given');
});

test('chat.js ranks the standing notes with the highest priority and rebuilds for small windows', () => {
  const src = readFileSync(new URL('../backend/chat.js', import.meta.url), 'utf8');
  assert.match(src, /title: 'Notes saved from Boon[^\n]*rank: 1, cap: 3000/, 'notes are rank 1: they come before the library and the week');
  assert.match(src, /rebuild: windowFor/, 'the cascade is given the builder for small windows');
  const cascade = readFileSync(new URL('../backend/ai/cascade.js', import.meta.url), 'utf8');
  assert.match(cascade, /rebuild && room < 60000/, 'only models with a small window use it');
  assert.match(cascade, /no first token within/, 'a model that says nothing in time is given up on');
});
