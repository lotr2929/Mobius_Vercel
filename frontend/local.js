/* local.js - "Ask: Local" and "Ask: Cloud": answering on this laptop with Qwen (Ollama), or by the cloud models.
 * Loaded by the app as a plain script (index.html) and imported by the tests. It holds nothing about what to say: chat.js on the server
 * builds the system prompt and memory block and hands them to the page as a { local } job; this file only
 *   - reads the switch from what Boon types ("Ask: Local ...", "Ask: Cloud ..."),
 *   - remembers the mode on this device (a phone cannot reach the laptop's Ollama, so the mode is per device, not shared),
 *   - checks that Ollama answers, and streams the reply from it.
 * Ollama must allow the Mobius site (OLLAMA_ORIGINS); the browser may ask once for permission to reach this computer. */
(function () {
  'use strict';
  const OLLAMA = 'http://127.0.0.1:11434';
  const KEY = 'mobius.mode';
  const FIRST_TOKEN_MS = 240000; // a 7B model on a CPU needs time to load and to read the prompt before the first word
  const TOTAL_MS = 900000;

  // "Ask: Local", "Ask: Cloud", "ask: local what is X". The colon is required so that an ordinary sentence
  // such as "Ask local councils about it" is never taken for the switch. A specific model ("Ask: Gemini ...") is not handled here.
  function parseSwitch(q) {
    const m = String(q || '').match(/^\s*ask\s*:\s*(local|cloud)\b[\s:,.\-\u2013\u2014]*([\s\S]*)$/i);
    return m ? { mode: m[1].toLowerCase(), rest: m[2].trim() } : null;
  }

  const store = () => { try { return globalThis.localStorage || null; } catch { return null; } };
  function getMode() { const s = store(); let v = null; try { v = s && s.getItem(KEY); } catch {} return v === 'local' ? 'local' : 'cloud'; }
  function setMode(mode) { const s = store(); try { if (s) s.setItem(KEY, mode === 'local' ? 'local' : 'cloud'); } catch {} return getMode(); }

  // Does Ollama answer? (the browser may show its permission question the first time)
  async function ping(ms = 5000) {
    try {
      const r = await fetch(OLLAMA + '/api/version', { cache: 'no-store', signal: AbortSignal.timeout(ms), targetAddressSpace: 'loopback' });
      return !!r.ok;
    } catch { return false; }
  }

  // ---- Tools on this laptop (MCP), only inside the Mobius AI desktop app -------------------------------------------------
  // The desktop app (Tauri) can start MCP servers on this computer and offers the page their read-only tools. In a browser or on a phone
  // there is no such app, so toolList() is empty and everything below behaves exactly as before.
  const MAX_ROUNDS = 6;           // tool calls the model may chain before it must answer
  const TOOL_RESULT_CHARS = 12000; // of one tool result handed to a 7B model with a small window
  const TOOL_NOTE = '\n\nYou can look at files and folders on Boon\'s laptop with the tools provided (read-only: you cannot change anything). ' +
    'Use them only when Boon asks about files, folders or documents on his computer. Use a tool, read what it returns, then answer from it. ' +
    'Say plainly if a tool returns nothing or an error. Never invent file names or contents.';

  function shellCore() { const t = globalThis.__TAURI__; return t && t.core && typeof t.core.invoke === 'function' ? t.core : null; }

  async function toolList() {
    const core = shellCore(); if (!core) return [];
    try {
      const info = await core.invoke('shell_info');
      if (!info || !(info.api >= 2) || !info.mcp) return [];
      const tools = await core.invoke('mcp_tools');
      return (tools || []).map(t => ({ type: 'function', function: { name: t.name, description: t.description || '', parameters: t.inputSchema || { type: 'object', properties: {} } } }));
    } catch { return []; }
  }

  async function runTool(name, args) {
    const core = shellCore(); if (!core) return 'Error: the desktop app is not available.';
    try {
      let a = args; if (typeof a === 'string') { try { a = JSON.parse(a); } catch { a = {}; } }
      const out = await core.invoke('mcp_call', { name, arguments: a && typeof a === 'object' ? a : {} });
      const s = String(out == null ? '' : out);
      return s.length > TOOL_RESULT_CHARS ? s.slice(0, TOOL_RESULT_CHARS) + '\n[cut: showing the first ' + TOOL_RESULT_CHARS + ' characters]' : (s || '(empty)');
    } catch (e) { return 'Error: ' + (e && e.message ? e.message : String(e)); }
  }

  // Streams the answer. job = { model, numCtx, system, messages } from the server. Calls onToken(text) as words arrive and resolves
  // with the whole text. If nothing at all arrived the error has noToken = true, so the caller can fall back to the cloud.
  // In the desktop app the model may first ask for tools (onTool({ name, args }) is called for each); in a browser it never does.
  async function stream(job, { onToken = () => {}, onTool = () => {}, signal } = {}) {
    const ctl = new AbortController();
    const link = () => ctl.abort(signal && signal.reason);
    if (signal) signal.addEventListener('abort', link, { once: true });
    const overall = setTimeout(() => ctl.abort(new Error('the local model took too long')), TOTAL_MS);
    let first = setTimeout(() => ctl.abort(new Error('the local model gave no answer in time')), FIRST_TOKEN_MS);
    let text = '';
    const fail = (e, extra) => Object.assign(e instanceof Error ? e : new Error(String(e)), extra);
    try {
      const tools = await toolList();
      const msgs = [{ role: 'system', content: job.system + (tools.length ? TOOL_NOTE : '') }, ...job.messages];
      for (let round = 0; round <= MAX_ROUNDS; round++) {
        const offerTools = tools.length > 0 && round < MAX_ROUNDS;
        let res;
        try {
          res = await fetch(OLLAMA + '/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: job.model, stream: true, keep_alive: '30m',
              options: { num_ctx: job.numCtx || 8192 },
              messages: msgs,
              ...(offerTools ? { tools } : {}),
            }),
            signal: ctl.signal, targetAddressSpace: 'loopback',
          });
        } catch (e) { throw fail(e, { noToken: !text }); }
        if (!res.ok || !res.body) {
          let why = ''; try { why = (await res.text()).slice(0, 200); } catch {}
          throw fail(new Error('Ollama answered HTTP ' + res.status + (why ? ': ' + why : '')), { noToken: !text });
        }
        const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = ''; let done = false;
        let roundText = ''; const calls = [];
        while (!done) {
          const chunk = await reader.read(); if (chunk.done) break;
          buf += dec.decode(chunk.value, { stream: true });
          const lines = buf.split('\n'); buf = lines.pop();
          for (const line of lines) {
            if (!line.trim()) continue;
            let obj; try { obj = JSON.parse(line); } catch { continue; }
            if (obj.error) throw fail(new Error(String(obj.error).slice(0, 200)), { noToken: !text });
            const m = obj.message || {};
            if (m.tool_calls && m.tool_calls.length) { if (first) { clearTimeout(first); first = null; } calls.push(...m.tool_calls); }
            const t = m.content;
            if (t) { if (first) { clearTimeout(first); first = null; } roundText += t; text += t; onToken(t); }
            if (obj.done) done = true;
          }
        }
        if (!calls.length) break; // the model answered in words: finished
        // the model asked for tools: run them here, give the results back, and let it carry on
        msgs.push({ role: 'assistant', content: roundText, tool_calls: calls });
        for (const c of calls) {
          const fn = c.function || {};
          try { onTool({ name: fn.name, args: fn.arguments }); } catch {}
          const result = await runTool(fn.name, fn.arguments);
          msgs.push({ role: 'tool', tool_name: fn.name, content: result });
        }
        first = setTimeout(() => ctl.abort(new Error('the local model gave no answer in time')), FIRST_TOKEN_MS);
      }
      if (!text.trim()) throw fail(new Error('the local model returned an empty answer'), { noToken: true });
      return text;
    } catch (e) {
      throw fail(e, { noToken: !text, partial: text });
    } finally {
      clearTimeout(overall); if (first) clearTimeout(first);
      if (signal) signal.removeEventListener('abort', link);
    }
  }

  globalThis.MobiusLocal = { OLLAMA, parseSwitch, getMode, setMode, ping, stream, toolList };
})();
