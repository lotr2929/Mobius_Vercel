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
