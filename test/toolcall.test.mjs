// test/toolcall.test.mjs - Qwen sometimes writes its tool call as plain text, with a file's text in single quotes and raw \n, which Ollama
// cannot read. The page must still carry out the call (or ask once more) and must not show the raw <tool_call> text.
import test from 'node:test';
import assert from 'node:assert/strict';
import '../frontend/local.js';

const L = globalThis.MobiusLocal;

// exactly what Qwen wrote on 15 Oct 2026 (single-quoted content, \n as two characters, unescaped double quotes inside)
const FAILED = String.raw`<tool_call> {"name": "work__write_file", "arguments": {"path": "C:/_personal/_mobiusfiles/largest_files.ps1", "content": '$folderPath = Read-Host "Enter the folder path"\n$items = Get-ChildItem -Recurse $folderPath | Where-Object { $_.PSIsContainer -eq $false }\n$largestFiles = $items | Sort-Object Length -Descending | Select-Object -First 20\n$dateTime = Get-Date -Format "yyyyMMdd_HHmmss"\n$outputFile = "C:\_personal\_mobiusfiles\{0}.txt" -f $dateTime\n$largestFiles | Format-Table Name, @{Name="Size (MB)";Expression={$_.Length / 1MB}}, FullName | Out-File -FilePath $outputFile'}} </tool_call>`;

test('a tool call written as text is read, with the file text turned back into real lines', () => {
  const c = L.parseTextToolCall(FAILED);
  assert.equal(c.name, 'work__write_file');
  assert.equal(c.args.path, 'C:/_personal/_mobiusfiles/largest_files.ps1');
  const lines = c.args.content.split('\n');
  assert.equal(lines.length, 6);
  assert.equal(lines[0], '$folderPath = Read-Host "Enter the folder path"');
  assert.ok(!c.args.content.includes('\\n'), 'no literal backslash-n is left in the file');
  assert.ok(c.args.content.includes(String.raw`"C:\_personal\_mobiusfiles\{0}.txt"`), 'Windows paths keep their backslashes');
  assert.ok(c.args.content.endsWith('-FilePath $outputFile'));
});

test('valid JSON in the tags is read as it is; anything else is not mistaken for a call', () => {
  const ok = L.parseTextToolCall('<tool_call>{"name":"files__list_directory","arguments":{"path":"J:/My Drive/Atlas"}}</tool_call>');
  assert.deepEqual(ok, { name: 'files__list_directory', args: { path: 'J:/My Drive/Atlas' } });
  assert.equal(L.parseTextToolCall('Here is the file you asked for.'), null);
  assert.equal(L.parseTextToolCall('<tool_call>{broken'), null);
  assert.equal(L.parseTextToolCall(`<tool_call>{"name": "work__write_file", 'arguments': {"path": "C:/x/a.txt"}}</tool_call>`), null, 'an unreadable write with no text is not carried out');
});

// ---- the whole stream, against a made-up Ollama and a made-up desktop shell ----
const enc = new TextEncoder();
const reply = chunks => ({ ok: true, body: { getReader() {
  const data = enc.encode(chunks.map(x => JSON.stringify(x)).join('\n') + '\n'); let gone = false;
  return { read: async () => gone ? { done: true } : (gone = true, { done: false, value: data }) };
} } });
async function run(rounds) {
  const realFetch = globalThis.fetch, realTauri = globalThis.__TAURI__;
  const asked = [], calls = [], tokens = [], tools = [];
  let n = 0;
  globalThis.fetch = async (url, init) => { asked.push(JSON.parse(init.body)); return reply(rounds[Math.min(n++, rounds.length - 1)]); };
  globalThis.__TAURI__ = { core: { invoke: async (cmd, a) => {
    if (cmd === 'shell_info') return { api: 2, mcp: true };
    if (cmd === 'mcp_tools') return [{ name: 'work__write_file', description: 'write', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } } }];
    if (cmd === 'mcp_call') { calls.push(a); return 'Successfully wrote'; }
    throw new Error('unexpected ' + cmd);
  } } };
  try {
    const text = await L.stream({ model: 'm', system: 'SYS', messages: [{ role: 'user', content: 'write the file' }] }, { onToken: t => tokens.push(t), onTool: t => tools.push(t.name) });
    return { text, asked, calls, tokens: tokens.join(''), tools };
  } finally { globalThis.fetch = realFetch; if (realTauri === undefined) delete globalThis.__TAURI__; else globalThis.__TAURI__ = realTauri; }
}
const saved = [{ message: { content: 'Saved.' } }, { done: true }];

test('a text tool call is carried out, never shown, and the answer after it is', async () => {
  const half = FAILED.length >> 1;
  const r = await run([[{ message: { content: FAILED.slice(0, half) } }, { message: { content: FAILED.slice(half) } }, { done: true }], saved]);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].name, 'work__write_file');
  assert.equal(r.calls[0].arguments.path, 'C:/_personal/_mobiusfiles/largest_files.ps1');
  assert.deepEqual(r.tools, ['work__write_file']);
  assert.equal(r.tokens, 'Saved.', 'the raw <tool_call> text never reaches the screen');
  assert.equal(r.text, 'Saved.');
});

test('an unreadable call gets a reminder of how to write it, then works', async () => {
  const good = '<tool_call>{"name":"work__write_file","arguments":{"path":"C:/a/b.txt","content":"hi"}}</tool_call>';
  const r = await run([[{ message: { content: '<tool_call>{"name": "work__write_file", "arguments": {broken' } }, { done: true }], [{ message: { content: good } }, { done: true }], saved]);
  assert.match(r.asked[1].messages.at(-1).content, /could not be read/);
  assert.equal(r.calls.length, 1);
  assert.deepEqual(r.calls[0].arguments, { path: 'C:/a/b.txt', content: 'hi' });
  assert.equal(r.tokens, 'Saved.');
});

test('after two reminders it gives up and shows what the model wrote, rather than hanging', async () => {
  const bad = [{ message: { content: '<tool_call>{nonsense' } }, { done: true }];
  const r = await run([bad, bad, bad]);
  assert.equal(r.calls.length, 0);
  assert.equal(r.asked.length, 3);
  assert.equal(r.tokens, '<tool_call>{nonsense');
});

test('ordinary answers, including very short ones, are shown at once as before', async () => {
  assert.equal((await run([[{ message: { content: 'Yes.' } }, { done: true }]])).tokens, 'Yes.');
  assert.equal((await run([[{ message: { content: '<b' } }, { message: { content: 'old>' } }, { done: true }]])).tokens, '<bold>');
});
