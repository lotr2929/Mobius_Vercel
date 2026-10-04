
// test/core.test.mjs — the contract that must not break as Mobius grows: how text is cut, how references and folders are read,
// how the model list is ordered, and the standing rules in the system prompt. No network, no database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkText, LIBRARY_CHUNK } from '../backend/docs/store.js';
import { splitSections, packGroups } from '../backend/docs/digest.js';
import { folderScope } from '../backend/docs/digest.js';
import { isTheology } from '../backend/docs/library.js';
import { extractRefs } from '../backend/bible.js';
import { driveRules, bibleRules, isTrivial } from '../backend/pcm/router.js';
import { MODELS, orderFor, parseAskPrefix, modelByKey } from '../backend/ai/models.js';
import { BASE_PROMPT } from '../backend/ai/prompt.js';
import { assembleContext } from '../backend/pcm/assemble.js';

test('chunking: ordinary passages overlap, library passages are contiguous and lose nothing', () => {
  const text = 'Sentence number one is here. '.repeat(400);
  const small = chunkText(text);
  assert.ok(small.every(c => c.length <= 600));
  assert.equal(small[0].slice(-100), small[1].slice(0, 100), 'ordinary passages overlap by 100');
  const big = chunkText(text, LIBRARY_CHUNK.size, LIBRARY_CHUNK.overlap);
  assert.ok(big.every(c => c.length <= 1800) && big.length < small.length / 2);
  assert.equal(big.join('').replace(/\s+/g, ''), text.replace(/\s+/g, ''), 'no text lost or repeated');
  assert.ok(big.slice(0, -1).every(c => /\.\s*$/.test(c)), 'cut at sentence ends');
});

test('sections for digests: contiguous, within the smallest model window, stub merged', () => {
  const text = ('A paragraph of ordinary prose. '.repeat(30) + '\n\n').repeat(60);
  const s = splitSections(text);
  assert.ok(s.every((x, i) => i === 0 ? x.from === 0 : x.from === s[i - 1].to) && s.at(-1).to === text.length);
  assert.ok(s.every(x => x.text.length <= 18000), 'must fit gpt-oss-20b’s 22,000-character window with instructions');
  assert.ok(s.length === 1 || s.at(-1).text.length >= 2000, 'a stub of a last section is merged');
  assert.deepEqual(packGroups(['a'.repeat(9000), 'b'.repeat(9000), 'c'.repeat(100)], 14000).map(g => g.length), [1, 2]);
});

test('scripture references: dashes, words, lists, chapter runs', () => {
  const ref = q => extractRefs(q, { chapterOnlyOk: true }).map(r => r.label);
  assert.deepEqual(ref('Matthew 25:31\u201146, Revelation 20\u201121'), ['Matthew 25:31–46', 'Revelation 20–21']);
  assert.deepEqual(ref('Genesis 1:1 to 2:4'), ['Genesis 1:1–2:4']);
  assert.deepEqual(ref('Acts 4:27, 28 and 5:1'), ['Acts 4:27, 28, 5:1']);
  assert.deepEqual(ref('Psalm 105:1–11, 45b'), ['Psalm 105:1–11, 45']);
  assert.deepEqual(ref('John 3:16 and then he left'), ['John 3:16']);
  assert.deepEqual(extractRefs('Job 5 years of work').map(r => r.label), [], 'a bare "Job 5" is not a reference unless asked for');
});

test('folder questions and theology detection do not fire on ordinary talk', () => {
  const labels = ['Scriptura Fidelium', 'GPR'];
  assert.equal(folderScope('What themes run across all the documents in Scriptura Fidelium?', labels)?.label, 'Scriptura Fidelium');
  assert.equal(folderScope('Which themes recur across my documents?', labels)?.label, null);
  assert.equal(folderScope('Using Scriptura Fidelium’s historical-critical approach, was Paul a Jew?', labels), null);
  assert.equal(folderScope('What themes run through the books of Paul?', labels), null);
  assert.ok(isTheology('Is his account of Anglicanism representative?'));
  assert.ok(isTheology('Does Tillich treat grace differently from Augustine?'));
  assert.ok(isTheology('how does faith relate to suffering?'));
  assert.ok(!isTheology('What is the weather in Perth today?'));
  assert.ok(!isTheology('I have a job interview and need to write a cover letter'));
});

test('router rules: drive and scripture requests, and greetings', () => {
  assert.deepEqual(driveRules('list the files in the GPR folder'), { action: 'list', target: 'GPR' });
  assert.deepEqual(driveRules('read the second one'), { action: 'open', ref: 2 });
  assert.equal(driveRules('what is the capital of France'), null);
  const b = bibleRules('show me Matthew 21:33-46 in the KJV');
  assert.equal(b.show, true); assert.equal(b.translation, 'KJV'); assert.deepEqual(b.refs, ['Matthew 21:33-46']);
  assert.ok(isTrivial('thanks!') && !isTrivial('thanks for the summary of Tillich'));
});

test('model list: shape, order and the privacy flags', () => {
  const keys = MODELS.map(m => m.key);
  assert.equal(new Set(keys).size, keys.length, 'keys are unique');
  for (const m of MODELS) {
    assert.ok(['gemini', 'groq', 'mistral', 'nvidia'].includes(m.provider), `${m.key}: known provider`);
    assert.equal(typeof m.trains, 'boolean', `${m.key}: must say whether its provider trains on prompts`);
    assert.ok(m.maxChars >= 20000 && m.maxTokens >= 512 && m.maxTokens <= 16384, `${m.key}: sensible limits (qwen on Groq is held to 900: its free key allows 1,000 output tokens a minute)`);
  }
  assert.ok(MODELS.some(m => m.trains === false), 'at least one model can answer a Private: message');
  const chat = orderFor('chat').map(modelByKey);
  const firstWeak = chat.findIndex(m => m.weak);
  assert.ok(chat.slice(firstWeak).every(m => m.weak || m.key === 'gemini25'), 'small models come last in the chat order');
  assert.ok(orderFor('chat').indexOf('gemini') < orderFor('chat').indexOf('ministral'));
  assert.equal(parseAskPrefix('Ask: flash-3.6 hello').forceProvider, 'gemini36');
  assert.equal(parseAskPrefix('ask nemotron: hello').cleanQuery, 'hello');
  assert.equal(parseAskPrefix('no prefix here').forceProvider, null);
});

test('the system prompt keeps the rules that give Mobius its character', () => {
  for (const rule of ['British English', 'NEVER use tables', 'Never claim to have read more of a document', 'Library:', 'Scripture: never quote Bible text from memory', 'Take a position', 'C.S. Lewis']) {
    assert.ok(BASE_PROMPT.includes(rule), `system prompt lost: ${rule}`);
  }
});

test('context assembly: the most important sections survive a flood of the least important', () => {
  const out = assembleContext([
    { title: 'Needed now', rank: 1, cap: 5000, text: 'IMPORTANT-FACT '.repeat(50) },
    { title: 'Background', rank: 6, cap: 90000, text: 'filler '.repeat(14000) },
  ]);
  assert.ok(out.text.includes('IMPORTANT-FACT'));
  assert.ok(out.text.length < 45000, 'stays within the context budget');
});
