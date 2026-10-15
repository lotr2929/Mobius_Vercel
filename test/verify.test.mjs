// test/verify.test.mjs - a digest may say only what its source says (docs/verify.js), and only models that do not train write digests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { numbersIn, namesIn, quotesIn, unsupported, isClean, tidy } from '../backend/docs/verify.js';

const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');
const SOURCE = 'Luther wrote to the princes in 1520 and again in 1525. The treatise ran to 2,500 copies. He called the pope "the enemy of the gospel and of every honest conscience". Cranmer, writing from Eng-\nland, later disagreed. The Lutheran churches grew quickly.';

test('numbers, names and quotations are picked out of a digest', () => {
  assert.deepEqual(numbersIn('In 1520, 2,500 copies and 3.5% more; item 7'), ['1520', '2500', '3.5']);
  assert.deepEqual(namesIn('This part follows Martin Luther and the Lutheran churches. It begins with Cranmer.'), ['Martin', 'Luther', 'Lutheran', 'Cranmer']);
  assert.deepEqual(quotesIn('He said "the enemy of the gospel" and \u201Ca short one\u201D and "tiny"'), ['the enemy of the gospel']);
});

test('a faithful digest passes, whatever the number format, accents or a word broken across lines', () => {
  const ok = 'Luther wrote in 1520 and 1525. About 2500 copies were printed. He called the pope "the enemy of the gospel and of every honest conscience". Cranmer wrote from England; the Lutheran churches grew.';
  assert.ok(isClean(unsupported(ok, SOURCE)), JSON.stringify(unsupported(ok, SOURCE)));
});

test('an added figure, name or quotation is caught', () => {
  const u = unsupported('Luther wrote in 1521 to Calvin. He called the pope "a tyrant over every nation on earth".', SOURCE);
  assert.deepEqual(u.numbers, ['1521']);
  assert.deepEqual(u.names, ['Calvin']);
  assert.equal(u.quotes.length, 1);
});

test('tidy cuts only the sentences that cannot be supported: a figure or quotation not in the part, a name in no part of the document', () => {
  const part = SOURCE, whole = SOURCE + ' Elsewhere in the book Melanchthon appears.';
  const digest = 'Luther wrote in 1520. Luther wrote in 1599. The text names Melanchthon. The text names Zwingli. He said "a tyrant over every nation on earth".';
  const r = tidy(digest, part, whole);
  assert.equal(r.text, 'Luther wrote in 1520. The text names Melanchthon.');
  assert.equal(r.removed.length, 3);
});

test('digests are written only by models that do not train on prompts, never by the small fallbacks, and every one is checked', () => {
  const d = read('../backend/docs/digest.js');
  assert.match(d, /askModel\(prompt, \{ role: 'deep', timeoutMs, privateOnly: true, excludeWeak: true \}\)/);
  assert.match(d, /const content = await verifiedSection\(draft, sections\[i\]\.text, text, left\)/);
  assert.match(d, /tidy\(await say\(FOLD_PROMPT\(name, g, final\), left\), g\.join\(/);
  assert.match(d, /Use only names, numbers, dates and quotations that appear in the TEXT below/);
  assert.match(read('../backend/ai/cascade.js'), /\(!excludeWeak \|\| !modelByKey\(k\)\.weak\)/);
});

test('answers resting on his documents are told to name the file and not to fill gaps from memory', () => {
  const chat = read('../backend/chat.js');
  assert.match(chat, /When you rely on them, name the file; quote only words that appear in them/);
  assert.match(chat, /A digest is a summary written by a model and may leave things out/);
});