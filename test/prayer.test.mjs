// test/prayer.test.mjs — the scripture chosen for Boon's prayers (backend/prayer.js). No network, no database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { THEMES, isPrayerRequest, themesFor, pickPassages, usedIn, overlaps } from '../backend/prayer.js';
import { extractRefs } from '../backend/bible.js';

const ask1 = 'Give me a healing prayer for Fee Yoon in the format we had agreed on.';
const ask2 = "Give me a healing prayer for Fee Yoon and include me, Xin and Daniel towards the end. Pray for my GPR work and for Xin and Daniel's marriage as we have discussed. Don't just reference Biblical verses, quote them in your prayer.";

test('a request for a prayer is told from a talk about prayer', () => {
  for (const q of [ask1, ask2, 'Write a prayer for my father.', 'I need another prayer for her', 'Can you pray for Xin and Daniel?', 'I want a short healing prayer'])
    assert.equal(isPrayerRequest(q), true, q);
  for (const q of ['What is the role of prayer in Tillich?', 'Tell me about the prayer of St Francis', 'I need to understand prayer', 'Why does prayer matter to Anglicans?', 'Exodus 32 and the golden calf'])
    assert.equal(isPrayerRequest(q), false, q);
});

test('themes follow what is asked: healing always for a healing prayer, work, marriage and protection when named', () => {
  const t = themesFor(ask2);
  for (const want of ['healing', 'work', 'marriage', 'strength']) assert.ok(t.includes(want), `${want} in ${t}`);
  assert.deepEqual(themesFor('Give me a healing prayer for Fee Yoon.').sort(), ['healing']);
  assert.ok(themesFor('Write a prayer for my daughter travelling overseas').includes('protection'));
  assert.deepEqual(themesFor('Write a prayer for the church').sort(), ['protection', 'strength'], 'some comfort and keeping when no need is named');
});

test('every reference in the lists is readable, none echoes Mark 9, and none speaks of children', () => {
  for (const [theme, list] of Object.entries(THEMES)) for (const t of list) {
    const refs = extractRefs(t, { chapterOnlyOk: true });
    assert.equal(refs.length, 1, `${theme}: ${t} reads as one reference`);
    assert.ok(!/^Mark 9/.test(t) && !/^Psalm 127|^Psalm 128/.test(t), `${t} is one Boon asked not to hear, or is about children`);
  }
});

test('passages used before are left out, none is chosen twice, and the choice varies with the day and the request', () => {
  const past = ['Lord, we ask that, as Isaiah 53:5 and Psalm 103:2-5 say, Fee Yoon be healed. We pray. Amen. James 5:14-16'];
  const used = usedIn(past);
  assert.equal(used.length, 3);
  const a = pickPassages({ themes: ['healing', 'strength', 'protection', 'marriage', 'work'], used, seed: '2026-10-07|x' });
  const refs = a.map(p => extractRefs(p.ref, { chapterOnlyOk: true })[0]);
  for (const r of refs) for (const u of used) assert.equal(overlaps(r, u), false, `${r.label} was used before`);
  for (let i = 0; i < refs.length; i++) for (let j = i + 1; j < refs.length; j++) assert.equal(overlaps(refs[i], refs[j]), false, `${refs[i].label} twice`);
  assert.equal(a.filter(p => p.theme === 'healing').length, 5);
  assert.ok(a.length >= 10 && a.length <= 14, `about a dozen passages (${a.length})`);
  const again = pickPassages({ themes: ['healing', 'strength', 'protection', 'marriage', 'work'], used, seed: '2026-10-07|x' });
  assert.deepEqual(again, a, 'the same request on the same day gives the same passages');
  const other = pickPassages({ themes: ['healing', 'strength', 'protection', 'marriage', 'work'], used, seed: '2026-10-08|x' });
  assert.notDeepEqual(other.map(p => p.ref), a.map(p => p.ref), 'another day, other passages');
});

test('a passage used in a prayer counts as used when a longer or shorter range covers it', () => {
  const [wide] = extractRefs('Psalm 103:1-8', { chapterOnlyOk: true });
  const [inside] = extractRefs('Psalm 103:2-5', { chapterOnlyOk: true });
  const [elsewhere] = extractRefs('Psalm 104:2-5', { chapterOnlyOk: true });
  assert.equal(overlaps(wide, inside), true);
  assert.equal(overlaps(wide, elsewhere), false);
});

test('chat.js gives a prayer its own scripture and leaves out the positions and the theology shelf', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../backend/chat.js', import.meta.url), 'utf8');
  assert.match(src, /prayerScripture\(/);
  assert.match(src, /title: 'Scripture for this prayer: the exact words of the WEB[^\n]*rank: 1/, 'rank 1: it is kept when room is short');
  assert.match(src, /!prayerRequest && !attached\.length/, 'no theology shelf for a prayer');
  assert.match(src, /plan\.aboutSelf \|\| prayerRequest \? '' : safe\(async \(\) => stancesFor/, 'no positions for a prayer');
});
