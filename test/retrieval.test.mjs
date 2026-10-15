// test/retrieval.test.mjs - questions about what one of his own documents says are answered from its stored text, and the best passages come first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isContentQuestion } from '../backend/pcm/contentq.js';
import { rankPassages } from '../backend/docs/digest.js';

const P = 'my 2002 paper "Green plot ratio: an ecological measure for architecture and urban planning"';
const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');

test('a question about what a document says is a content question, not a request to find a file', () => {
  for (const q of [
    `How does ${P} define the green plot ratio, and what is it based on?`,
    `In ${P}, what leaf area index does the paper suggest for turf or grass?`,
    `According to ${P}, what are the ways a suitable GPR may be determined?`,
    `What mean LAI does ${P} give for shrubs?`,
    'What does my Green Plot Ratio paper say about shrubs and LAI?',
    'What caveats does the 2002 Green Plot Ratio paper give about using GPR?',
    'What does the book argue about the Trinity?',
  ]) assert.equal(isContentQuestion(q), true, q);
});

test('a request to locate, open, list or link something is not', () => {
  for (const q of [
    'Where is my 2002 paper?', 'Find the file called GPR 2002 in my Drive', 'Open my thesis', 'List the files in the PhD folder',
    'What folders are in my Atlas?', 'Link this folder to Mobius', 'Sync the document folder', 'hello', 'What is the capital of France?', 'Who wrote the Bible?',
  ]) assert.equal(isContentQuestion(q), false, q);
});

test('the router treats a content question as an archive question: no Drive lookup, no web search', () => {
  const r = read('../backend/pcm/router.js');
  assert.match(r, /import \{ isContentQuestion \} from '\.\/contentq\.js'/);
  assert.match(r, /return fixContent\(accept\(parseJson\(raw\)/);
  assert.match(r, /return fixContent\(fallback, query\)/);
  assert.match(r, /isContentQuestion\(query\) \? \{ \.\.\.plan, drive: null, needsWeb: false, needsArchive: true \}/);
});

test('passages are ranked by their rarest matching words, so the one holding the answer comes first', () => {
  const chunks = [
    'LAI is related to a range of ecological processes like photosynthesis and transpiration. The leaf area index is a dimensionless number.',
    'Several methods for measuring leaf area index exist. The leaf area index may be measured directly or indirectly.',
    'It is reasonable to assume that turf or grass will have an LAI of 1, and densely wooded landscapes with trees may reach an LAI of 6.',
    'The leaf area index of various biomes is shown in Table 1. Leaf area index values vary between methods.',
  ];
  const ranked = rankPassages(chunks, ['leaf', 'area', 'index', 'turf', 'grass', 'wooded', 'trees', 'suggest'], 2);
  assert.equal(ranked[0], chunks[2]);
  assert.equal(ranked.length, 2);
  assert.deepEqual(rankPassages(chunks, ['zebra'], 3), []);
});
