// test/voice.test.mjs — how Mobius speaks (7 Oct 2026). No network, no database.
// Boon: it should talk to him ("you prefer…"), not about him ("Boon prefers…"), and in the plain, unhurried voice of a well-read scholar
// (C.S. Lewis), with technical terms only where needed and explained, instead of a technical manual's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BASE_PROMPT } from '../backend/ai/prompt.js';

test('the system prompt tells Mobius to speak to Boon, in the voice of a scholar', () => {
  for (const rule of [
    'Speak TO Boon, never ABOUT him', '"You prefer a concise answer", never "Boon prefers a concise answer"', 'Do not talk about your own machinery',
    'highly educated, well-read and intelligent scholar', 'C.S. Lewis', 'explain it in plain English the first time', 'Prefer the plain word to the learned one',
  ]) assert.ok(BASE_PROMPT.includes(rule), `system prompt lost: ${rule}`);
});

test('the earlier rules about prose and house style are still there beside it', () => {
  for (const rule of ['NEVER use tables', 'Use British English', 'Take a position', 'Never open with "You are right"']) assert.ok(BASE_PROMPT.includes(rule), `system prompt lost: ${rule}`);
});

test('web answers end with links, a plain list with bold phrases is welcome, tables are never used (12 Oct 2026)', async () => {
  // Local Qwen answered a news question from search results that carried addresses, and gave no links; Boon likes list-with-bold-phrases answers.
  assert.match(BASE_PROMPT, /ALWAYS end it with a brief closing line of short links/);
  assert.match(BASE_PROMPT, /a plain list is welcome, each item opening with a short bold phrase/);
  assert.match(BASE_PROMPT, /NEVER use tables/);
  const { readFileSync } = await import('node:fs');
  const chat = readFileSync(new URL('../backend/chat.js', import.meta.url), 'utf8');
  assert.match(chat, /End your answer with a brief closing line of short markdown links to the pages you used/, 'the reminder sits beside the web results, where a small model reads it');
});
