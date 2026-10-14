// test/local.test.mjs - "Ask: Local" / "Ask: Cloud": answering on the laptop with Qwen (Ollama). No network, no database, no Ollama:
// the switch is read from what Boon types, the prompt is cut for the local model's window, the reply is streamed from a made-up Ollama,
// and chat.js / server.js / index.html are wired the way the design says (the server never calls the laptop; the page does).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LOCAL_MODEL, MODELS, parseAskPrefix } from '../backend/ai/models.js';
import { fitForRoom } from '../backend/ai/cascade.js';
import '../frontend/local.js';

const L = globalThis.MobiusLocal;
const read = p => readFileSync(new URL(p, import.meta.url), 'utf8');

test('the switch: "Ask: Local" and "Ask: Cloud" are read, ordinary sentences and named models are not', () => {
  assert.deepEqual(L.parseSwitch('Ask: Local'), { mode: 'local', rest: '' });
  assert.deepEqual(L.parseSwitch('ask: cloud'), { mode: 'cloud', rest: '' });
  assert.deepEqual(L.parseSwitch('  Ask: Local  what is the capital of Peru?'), { mode: 'local', rest: 'what is the capital of Peru?' });
  assert.deepEqual(L.parseSwitch('Ask: Cloud, and say it plainly'), { mode: 'cloud', rest: 'and say it plainly' });
  assert.equal(L.parseSwitch('Ask local councils about the bins'), null, 'no colon: an ordinary sentence');
  assert.equal(L.parseSwitch('Ask: localisation of the app'), null, 'a longer word is not the switch');
  assert.equal(L.parseSwitch('Ask: Gemini hello'), null, 'a named cloud model is handled by the server, as before');
  assert.equal(L.parseSwitch('Ask: Qwen hello'), null, '"Ask: Qwen" still means the cloud Qwen');
  assert.equal(parseAskPrefix('Ask: Qwen hello').forceProvider, 'qwen', 'the server still reads Ask: Qwen as the cloud model');
  assert.equal(parseAskPrefix('Ask: Local hello').forceProvider, null, 'the server never sees Local as a model name');
});

test('the mode is kept per device and defaults to Cloud', () => {
  const real = globalThis.localStorage; const mem = {};
  globalThis.localStorage = { getItem: k => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = v; } };
  try {
    assert.equal(L.getMode(), 'cloud');
    assert.equal(L.setMode('local'), 'local'); assert.equal(L.getMode(), 'local');
    assert.equal(L.setMode('anything else'), 'cloud');
  } finally { globalThis.localStorage = real; }
  assert.equal(L.getMode(), 'cloud', 'with no storage at all it is Cloud');
});

test('the local model is not a cloud model: it stays out of the cascade and does not train', () => {
  assert.ok(!MODELS.some(m => m.key === 'local' || m.id === LOCAL_MODEL.ollama), 'it is not in the cloud list');
  assert.equal(LOCAL_MODEL.trains, false);
  assert.ok(LOCAL_MODEL.numCtx * 2 >= LOCAL_MODEL.maxChars / 3 + 1500, 'Ollama context holds the prompt (about 3 characters a token) and a reply');
});

test('the prompt is cut for the local window the way the cascade cuts it for a cloud model', () => {
  const system = 's'.repeat(10000);
  const turns = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `turn ${i} ` + 'x'.repeat(3900) }));
  turns.push({ role: 'user', content: 'FULL MEMORY ' + 'm'.repeat(30000) + ' the question' });
  let asked = null;
  const rebuild = room => { asked = room; return [...turns.slice(0, -1), { role: 'user', content: 'SMALL MEMORY ' + 'm'.repeat(3000) + ' the question' }]; };
  const out = fitForRoom(turns, system, LOCAL_MODEL.maxChars, rebuild);
  assert.equal(asked, LOCAL_MODEL.maxChars - system.length, 'the memory block is rebuilt for what is left after the system prompt');
  const chars = out.reduce((n, m) => n + m.content.length, 0);
  assert.ok(chars + system.length <= LOCAL_MODEL.maxChars + 100, `everything fits the window (${chars + system.length})`);
  assert.equal(out[0].role, 'user', 'it starts with a user turn');
  assert.equal(out.at(-1).role, 'user'); assert.match(out.at(-1).content, /SMALL MEMORY[\s\S]*the question$/, 'the newest message, with its rebuilt memory, is kept');
  assert.ok(out.length < turns.length, 'the oldest turns gave way');
});

// an Ollama that streams newline-delimited JSON, as the real one does
const ollama = (lines, { ok = true, status = 200 } = {}) => async (url, opts) => {
  ollama.last = { url: String(url), opts };
  if (!ok) return { ok: false, status, text: async () => 'model not found', body: null };
  const enc = new TextEncoder(); let i = 0;
  return { ok: true, status: 200, body: { getReader: () => ({ read: async () => (i < lines.length ? { done: false, value: enc.encode(lines[i++]) } : { done: true }) }) } };
};

test('streaming: tokens arrive in order, split lines are joined, and the request asks for the right window', async () => {
  const real = globalThis.fetch;
  const l1 = JSON.stringify({ message: { content: 'Hel' } }), l2 = JSON.stringify({ message: { content: 'lo ' } }), l3 = JSON.stringify({ message: { content: 'there' }, done: true });
  globalThis.fetch = ollama([l1 + '\n' + l2.slice(0, 10), l2.slice(10) + '\n', l3 + '\n']);
  try {
    const got = [];
    const text = await L.stream({ model: 'qwen2.5:7b', numCtx: 8192, system: 'SYS', messages: [{ role: 'user', content: 'hi' }] }, { onToken: t => got.push(t) });
    assert.equal(text, 'Hello there'); assert.deepEqual(got, ['Hel', 'lo ', 'there']);
    const { url, opts } = ollama.last; const body = JSON.parse(opts.body);
    assert.equal(url, 'http://127.0.0.1:11434/api/chat'); assert.equal(opts.targetAddressSpace, 'loopback');
    assert.equal(body.model, 'qwen2.5:7b'); assert.equal(body.stream, true); assert.equal(body.options.num_ctx, 8192);
    assert.deepEqual(body.messages[0], { role: 'system', content: 'SYS' }); assert.deepEqual(body.messages[1], { role: 'user', content: 'hi' });
  } finally { globalThis.fetch = real; }
});

test('streaming: nothing from Ollama is marked so the page can fall back to the cloud; a stop part-way keeps what came', async () => {
  const real = globalThis.fetch;
  try {
    globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
    await assert.rejects(L.stream({ model: 'm', system: 's', messages: [] }), e => e.noToken === true, 'not reachable');
    globalThis.fetch = ollama([], { ok: false, status: 404 });
    await assert.rejects(L.stream({ model: 'm', system: 's', messages: [] }), e => e.noToken === true && /404/.test(e.message), 'HTTP error');
    globalThis.fetch = ollama([JSON.stringify({ message: { content: '' }, done: true }) + '\n']);
    await assert.rejects(L.stream({ model: 'm', system: 's', messages: [] }), e => e.noToken === true, 'an empty answer is nothing');
    globalThis.fetch = ollama([JSON.stringify({ message: { content: 'Part' } }) + '\n', JSON.stringify({ error: 'model crashed' }) + '\n']);
    await assert.rejects(L.stream({ model: 'm', system: 's', messages: [] }), e => e.noToken === false && e.partial === 'Part', 'a stop part-way is not a fallback');
  } finally { globalThis.fetch = real; }
});

test('ping: true only when Ollama answers', async () => {
  const real = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: true }); assert.equal(await L.ping(), true);
    globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); }; assert.equal(await L.ping(), false);
  } finally { globalThis.fetch = real; }
});

test('wiring: the server hands the prompt over and files nothing; the page writes and files; Private is never filed', () => {
  const chat = read('../backend/chat.js'), server = read('../backend/server.js'), html = read('../frontend/index.html'), sw = read('../frontend/sw.js');
  assert.match(chat, /const localTurn = local && !forceProvider && !sendImages\.length && !bibleOnly && !\(directAnswer && !bibleShown\)/, 'a named cloud model, a picture or a lookup done by code is not answered locally');
  assert.match(chat, /const reviewing = !localTurn && shouldReview/, 'a local answer is not sent to a cloud reviewer');
  const branch = chat.slice(chat.indexOf('if (localTurn) {'), chat.indexOf('if (!bibleOnly && !(directAnswer && !bibleShown)) for await'));
  assert.match(branch, /fitForRoom\(messages, system, LOCAL_MODEL\.maxChars, windowFor\)/);
  assert.match(branch, /save: !privateMode && !dryRun/, 'a Private: message is not filed');
  assert.match(branch, /return;/, 'and nothing else runs for the turn');
  assert.doesNotMatch(branch, /saveExchange|runCascade/, 'the server neither saves nor calls a cloud model in this branch');
  assert.match(server, /local: local === true/); assert.match(server, /app\.post\('\/api\/chat\/local-save'/);
  assert.match(html, /<script src="\/local\.js"><\/script>/); assert.match(html, /body\.local = true/); assert.match(html, /\/api\/chat\/local-save/);
  assert.match(html, /body\.local = false;[\s\S]{0,200}await pump\(\)/, 'with nothing from Ollama the same message goes to the cloud');
  assert.match(html, /MobiusLocal\.getMode\(\) === 'local' && !imgs\.length/, 'a message with pictures is never sent for Local');
  assert.match(sw, /endsWith\('\.js'\)/, 'local.js is served network-first like the rest of the app');
});

test('tools (desktop app only): the model asks, the app runs the read-only tool, the result goes back, and the model answers; a browser never offers tools', async () => {
  const realFetch = globalThis.fetch, realTauri = globalThis.__TAURI__;
  const enc = new TextEncoder();
  const body = lines => { const parts = lines.map(l => enc.encode(l + '\n')); let i = 0; return { getReader: () => ({ read: async () => (i < parts.length ? { done: false, value: parts[i++] } : { done: true }) }) }; };
  const sent = []; let turn = 0;
  globalThis.fetch = async (url, opts) => {
    sent.push(JSON.parse(opts.body)); turn++;
    return { ok: true, body: turn === 1
      ? body([JSON.stringify({ message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'files__list_directory', arguments: { path: 'E:\\Personal Details' } } }] } }), JSON.stringify({ done: true })])
      : body([JSON.stringify({ message: { content: 'It holds a CV folder.' } }), JSON.stringify({ done: true })]) };
  };
  const calls = [];
  globalThis.__TAURI__ = { core: { invoke: async (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === 'shell_info') return { api: 2, mcp: true };
    if (cmd === 'mcp_tools') return [{ name: 'files__list_directory', description: 'List a folder', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }];
    if (cmd === 'mcp_call') return '[DIR] CV';
    throw new Error('unexpected ' + cmd);
  } } };
  try {
    const seen = [];
    const text = await L.stream({ model: 'm', system: 'SYS', messages: [{ role: 'user', content: 'what is in my Personal Details folder?' }] }, { onTool: t => seen.push(t.name) });
    assert.equal(text, 'It holds a CV folder.'); assert.deepEqual(seen, ['files__list_directory']);
    assert.equal(sent[0].tools[0].function.name, 'files__list_directory'); assert.match(sent[0].messages[0].content, /read-only/);
    const second = sent[1].messages; assert.equal(second[second.length - 1].role, 'tool'); assert.equal(second[second.length - 1].content, '[DIR] CV');
    assert.deepEqual(calls.find(c => c[0] === 'mcp_call')[1], { name: 'files__list_directory', arguments: { path: 'E:\\Personal Details' } });
    // in a browser (no desktop app) no tools are offered and the prompt is untouched
    delete globalThis.__TAURI__; turn = 1; sent.length = 0;
    await L.stream({ model: 'm', system: 'SYS', messages: [] });
    assert.equal(sent[0].tools, undefined); assert.equal(sent[0].messages[0].content, 'SYS');
  } finally { globalThis.fetch = realFetch; if (realTauri === undefined) delete globalThis.__TAURI__; else globalThis.__TAURI__ = realTauri; }
});

test('laptop tools: the page says so, and the server then leaves a question about files to Qwen instead of the cloud-Drive lookup', () => {
  const page = read('../frontend/index.html'), server = read('../backend/server.js'), chat = read('../backend/chat.js');
  assert.match(page, /body\.laptopTools = true/);
  assert.match(server, /laptopTools: laptopTools === true/);
  assert.match(chat, /laptopTools = false \}\) \{/);
  assert.match(chat, /!memoryAction && !laptopTools && plan\.drive/);
});
