// test/sealed.test.mjs - sealed private exchanges. A "Private:" message is kept, but in a compartment no search, digest, summary, mood or
// learning job can read. These tests are tripwires: if any other file touches the sealed table, or imports the module that does, they fail
// until the change has been looked at.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeByTime, stripPrivatePrefix, SEALED_ID_OFFSET } from '../backend/pcm/sealed.js';

const backend = fileURLToPath(new URL('../backend/', import.meta.url));
const walk = d => readdirSync(d).flatMap(n => { const p = join(d, n); return statSync(p).isDirectory() ? (n === 'node_modules' ? [] : walk(p)) : (p.endsWith('.js') || p.endsWith('.mjs')) ? [p] : []; });
const files = walk(backend).map(p => ({ name: relative(backend, p).replace(/\\/g, '/'), text: readFileSync(p, 'utf8') }));
const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');

test('only pcm/sealed.js and the backup script touch the sealed table', () => {
  assert.deepEqual(files.filter(f => f.text.includes('mobius_sealed_messages')).map(f => f.name).sort(), ['backup-cli.mjs', 'pcm/sealed.js']); // the backup script keeps it OUT of the Drive backup and copies it to this PC only
});

test('only chat.js and server.js import the sealed module', () => {
  const importers = files.filter(f => /from\s+'\.{1,2}\/(?:pcm\/)?sealed\.js'/.test(f.text)).map(f => f.name).sort();
  assert.deepEqual(importers, ['chat.js', 'server.js']);
});

test('the jobs that read ordinary messages know nothing of the sealed ones', () => {
  for (const name of ['pcm/maintain.js', 'pcm/chats.js', 'pcm/retrieve.js', 'pcm/mood.js', 'mood.js', 'pcm/learn.js', 'pcm/embed.js', 'pcm/review.js'])
    for (const f of files.filter(f => f.name === name)) assert.ok(!/sealed/i.test(f.text), name + ' must not mention sealed messages');
});

test('chat.js: only a private turn reads the sealed exchanges, and a private turn saves only into the sealed compartment', () => {
  const chat = read('../backend/chat.js');
  assert.match(chat, /const raw = privateMode \? await getRecentWithSealed\(RECENT_MESSAGES \+ 4\) : await getMessages\(RECENT_MESSAGES \+ 4\)/);
  assert.match(chat, /if \(privateMode && !dryRun && !signal\?\.aborted && full\.trim\(\)\) await safe\(\(\) => saveSealedExchange\(/);
  assert.match(chat, /if \(!privateMode && !dryRun && !signal\?\.aborted && full\.trim\(\)\) \{\s*\n\s*const saved = await saveExchange\(/, 'the ordinary save is still for non-private messages only');
  assert.match(chat, /save: !dryRun, sealed: privateMode/);
});

test('server.js: the history screen shows sealed exchanges; a private exchange from the laptop is filed sealed and never embedded', () => {
  const server = read('../backend/server.js');
  assert.match(server, /getHistoryWithSealed\(/);
  assert.match(server, /const latest = await latestStamp\(\)/);
  const branch = server.slice(server.indexOf('if (sealed === true)'), server.indexOf('const saved = await saveExchange({'));
  assert.match(branch, /saveSealedExchange\(/);
  assert.match(branch, /return res\.json/, 'returns before the ordinary save and before the embedding top-up');
  assert.ok(!/embedBacklog/.test(branch));
  assert.match(read('../frontend/index.html'), /sealed: !!job\.sealed/);
});

test('merging: time order, the newest kept, ids of sealed rows offset so they cannot clash', () => {
  const a = [{ id: 1, role: 'user', created_at: '2026-10-15T01:00:00.000Z' }, { id: 2, role: 'assistant', created_at: '2026-10-15T01:00:00.001Z' }];
  const b = [{ id: SEALED_ID_OFFSET + 1, role: 'user', created_at: '2026-10-15T00:30:00+00:00' }, { id: SEALED_ID_OFFSET + 2, role: 'assistant', created_at: '2026-10-15T00:30:00.001+00:00' }];
  assert.deepEqual(mergeByTime(a, b, 10).map(m => m.id), [SEALED_ID_OFFSET + 1, SEALED_ID_OFFSET + 2, 1, 2]);
  assert.deepEqual(mergeByTime(a, b, 2).map(m => m.id), [1, 2]);
});

test('the typed prefix is removed before a private exchange is kept', () => {
  assert.equal(stripPrivatePrefix('Private: what is x?'), 'what is x?');
  assert.equal(stripPrivatePrefix('  confidential - what is x?'), 'what is x?');
  assert.equal(stripPrivatePrefix('what is x?'), 'what is x?');
});

test('the schema file carries the table, with row-level security on', () => {
  const sql = read('../supabase/schema.sql');
  assert.match(sql, /create table if not exists mobius_sealed_messages/);
  assert.match(sql, /alter table mobius_sealed_messages enable row level security/);
});

test('the Drive backup (in the shared Atlas folder) never includes the sealed chats; they are copied to this PC only', () => {
  const b = read('../backend/backup-cli.mjs');
  assert.match(b, /const SKIP = new Set\(\[[^\]]*'mobius_sealed_messages'/);
  assert.match(b, /const SEALED_DIR = 'C:\\\\_Personal\\\\_Mobius\\\\Backup\\\\sealed'/);
  assert.match(b, /await backupSealedLocally\(\)/);
  assert.ok(!/DRIVE_DIR[^\n]*sealed|sealed[^\n]*DRIVE_DIR/i.test(b.replace(/\/\/[^\n]*/g, '')), 'no code path writes the sealed chats to the Drive folder');
});

test('the Drive backup folder is outside Atlas, which other AIs read', () => {
  const line = read('../backend/backup-cli.mjs').split('\n').find(l => l.startsWith('const DRIVE_DIR ='));
  assert.match(line, /J:\\\\My Drive\\\\_mobiusstore/);
  assert.ok(!/Atlas/.test(line.split('//')[0]), 'the backup folder is not inside Atlas');
});