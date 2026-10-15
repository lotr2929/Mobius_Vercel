// test/coverage.test.mjs - "have you read everything in Atlas?" is answered from exact figures; the folders linked to Mobius are chosen on purpose.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { asksCoverage } from '../backend/docs/coverage.js';

const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');

test('a question about what Mobius has read is recognised', () => {
  for (const q of [
    'Can you confirm whether you read everything in your Atlas folder?',
    'Have you read the documents in Scriptura Fidelium?',
    'Did you index the files in my PhD folder?',
    'What have you read from my Drive?',
    'Do you know everything in the Atlas folder?',
    'Has Mobius ingested all the documents?',
  ]) assert.equal(asksCoverage(q), true, q);
});

test('ordinary questions are not mistaken for it', () => {
  for (const q of ['What does my 2002 paper say about turf?', 'What folders are in my Atlas?', 'hello', 'Have you heard of Chesterton?', 'Who wrote the Bible?'])
    assert.equal(asksCoverage(q), false, q);
});

test('chat.js gives the model the exact figures when asked', () => {
  const chat = read('../backend/chat.js');
  assert.match(chat, /import \{ asksCoverage, coverageText \} from '\.\/docs\/coverage\.js'/);
  assert.match(chat, /const coverage = asksCoverage\(userQuery\) \? await safe\(\(\) => coverageText\(\), ''\) : ''/);
  assert.match(chat, /never claim to have read a folder that is listed as not linked/);
});

test('the daily sync links the Atlas folders chosen for it: personal and very large ones are left out, PhD is capped', () => {
  const src = read('../backend/docs/sources.js');
  assert.match(src, /await ensureConfiguredLinks\(\)\.catch/, 'the sync links before it reads');
  const want = src.slice(src.indexOf('export const DEFAULT_ATLAS_LINKS'), src.indexOf('export async function ensureConfiguredLinks'));
  assert.match(want, /name: 'PhD', max: 40/);
  for (const left of ['Personal Details', 'Beyond Environmental Comfort', 'ChatGPT Discovers God']) assert.ok(!want.includes(left), left + ' is not linked');
  assert.match(src, /getState\('atlas_links'\)/, 'the list can be changed in the database');
});