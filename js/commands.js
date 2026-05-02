// ── js/commands.js ── v2 ──────────────────────────────────────────────────────
// Core infrastructure for mobius.
// Provides: model chains, conversation history, auth, folder access,
//           AI send helpers, command detection, COMMANDS registry.
// All command handlers live in their own module files.
// Context injection: brief + slim + lastReadFile prepended to every AI query.
// ─────────────────────────────────────────────────────────────────────────────

// ── Model chains ──────────────────────────────────────────────────────────────

const CLOUD_CHAIN = ['gemini-lite', 'groq', 'mistral', 'github'];
const MODEL_CHAIN = ['gemini-lite', 'groq', 'mistral', 'github', 'gemini', 'qwen35', 'qwen', 'deepseek', 'web'];

const LOCAL_MODEL_CHAIN = [
  { key: 'qwen35',   model: 'qwen3.5:35b-a3b',  name: 'Qwen3.5 35B'      },
  { key: 'qwen',     model: 'qwen2.5-coder:7b', name: 'Qwen2.5-Coder 7B' },
  { key: 'deepseek', model: 'deepseek-r1:7b',   name: 'DeepSeek R1 7B'   },
];

function getLastModel() {
  return sessionStorage.getItem('coder_last_model') || 'gemini-lite';
}

function setLastModel(model) {
  if (!MODEL_CHAIN.includes(model)) return;
  sessionStorage.setItem('coder_last_model', model);
}

function nextCloudModel(current) {
  const idx = CLOUD_CHAIN.indexOf(current);
  if (idx === -1 || idx === CLOUD_CHAIN.length - 1) return null;
  return CLOUD_CHAIN[idx + 1];
}

// ── Conversation history ───────────────────────────────────────────────────────

const MAX_HISTORY = 10;
let conversationHistory = [];
let lastCloudQuery      = null;
let lastCloudModelKey   = null;

function addToHistory(userContent, assistantContent) {
  conversationHistory.push({ role: 'user',      content: userContent      });
  conversationHistory.push({ role: 'assistant', content: assistantContent });
  if (conversationHistory.length > MAX_HISTORY * 2) {
    conversationHistory = conversationHistory.slice(-MAX_HISTORY * 2);
  }
}

function clearHistory() {
  conversationHistory = [];
  lastCloudQuery      = null;
  lastCloudModelKey   = null;
}

// ── Auth helpers ───────────────────────────────────────────────────────────────

function getAuth(key) {
  const ls = localStorage.getItem(key);
  if (ls) return ls;
  const match = document.cookie.match(new RegExp('(?:^|;\\s*)' + key + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}

// ── IndexedDB — folder handle persistence ─────────────────────────────────────

const DB_NAME  = 'MobiusCoderFS';
const DB_STORE = 'handles';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore(DB_STORE);
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = () => reject(req.error);
  });
}

async function saveHandle(handle) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).put(handle, 'rootHandle');
    tx.oncomplete = resolve;
    tx.onerror    = () => reject(tx.error);
  });
}

async function loadHandle() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(DB_STORE, 'readonly');
    const req = tx.objectStore(DB_STORE).get('rootHandle');
    req.onsuccess = () => resolve(req.result || null);
    req.onerror   = () => reject(req.error);
  });
}

async function clearHandle() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).delete('rootHandle');
    tx.oncomplete = resolve;
    tx.onerror    = () => reject(tx.error);
  });
}

// ── Folder access management ───────────────────────────────────────────────────

let rootHandle = null;

async function ensureAccess(output, silentOnly = false) {
  if (rootHandle) return true;
  try {
    const stored = await loadHandle();
    if (stored) {
      const perm = await stored.queryPermission({ mode: 'readwrite' });
      if (perm === 'granted') { rootHandle = stored; return true; }
      if (silentOnly) return false; // no user gesture available -- skip requestPermission
      const perm2 = await stored.requestPermission({ mode: 'readwrite' });
      if (perm2 === 'granted') { rootHandle = stored; return true; }
    }
  } catch { /* fall through */ }
  if (silentOnly) return false;
  output('No folder access. Running Project: Open...');
  return await handleAccess(output);
}

async function handleAccess(output) {
  if (!('showDirectoryPicker' in window)) {
    output('File System Access API not supported in this browser.\nUse Chrome or Edge.');
    return false;
  }
  try {
    rootHandle = null;
    await clearHandle();
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    rootHandle = handle;
    await saveHandle(handle);
    document.getElementById('input').value = '';
    const entries = [];
    for await (const [name, h] of handle.entries()) {
      entries.push((h.kind === 'directory' ? '\uD83D\uDCC1' : '\uD83D\uDCC4') + ' ' + name);
    }
    entries.sort();
    const listing = 'Access granted: ' + handle.name + '\n' + entries.join('\n');
    window._lastAccessListing = listing;
    output(listing);
    return true;
  } catch (err) {
    output(err.name === 'AbortError' ? 'Cancelled.' : 'Access denied: ' + err.message);
    return false;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────────

function formatMs(ms) {
  if (ms < 1000) return ms + 'ms';
  const s   = Math.floor(ms / 1000);
  const rem = ms % 1000;
  return rem > 0 ? s + 's ' + rem + 'ms' : s + 's';
}

function describeError(raw) {
  if (!raw) return 'unknown error';
  const r = raw.toLowerCase();
  const retryMatch = raw.match(/retry in (\d+)s/i);
  if (retryMatch)                                                                return 'quota exceeded, retry in ' + retryMatch[1] + 's';
  if (r.includes('quota exceeded') || r.includes('resource_exhausted'))         return 'daily quota exceeded';
  if (r.includes('429') || r.includes('rate limit'))                            return 'rate limit reached';
  if (r.includes('401') || r.includes('unauthorized') || r.includes('invalid api key')) return 'API key rejected';
  if (r.includes('403') || r.includes('forbidden'))                             return 'access denied';
  if (r.includes('404'))                                                         return 'endpoint not found';
  if (r.includes('503') || r.includes('overloaded') || r.includes('capacity'))  return 'model overloaded';
  if (r.includes('500') || r.includes('502') || r.includes('server error'))     return 'server error';
  if (r.includes('timeout') || r.includes('timed out') || r.includes('abort'))  return 'request timed out';
  if (r.includes('fetch failed') || r.includes('econnrefused') || r.includes('network')) return 'network unreachable';
  if (r.includes('not set on the server') || r.includes('not configured'))      return 'API key not configured';
  if (r.includes('no candidates') || r.includes('returned no content'))         return 'returned empty response';
  return raw.length > 80 ? raw.slice(0, 80) + '...' : raw;
}

// ── AI send helpers ────────────────────────────────────────────────────────────

async function sendToAI(model, messages, output, outputEl, options = {}) {
  const userId = getAuth('mobius_user_id');
  const start  = Date.now();
  output('Thinking...');

  // Build context-prepended query: memory + brief + slim + last-read file + user query.
  // CLAUDE.md excluded -- contains MCP/Desktop instructions not relevant to cloud AI.
  let _finalQuery = messages[messages.length - 1].content;
  const _parts = [];
  if (window.getMemoryContext) {
    try {
      const _mem = await window.getMemoryContext(_finalQuery);
      if (_mem) _parts.push('[Memory]\n' + _mem);
    } catch { /* never block on memory */ }
  }
  if (window.getCodeContext) {
    try {
      const _code = await window.getCodeContext(_finalQuery);
      if (_code) _parts.push(_code);
    } catch { /* never block on code index */ }
  }
  if (window.lastReadFile && window.lastReadFile.content) {
    const c = window.lastReadFile.content;
    _parts.push('[File: ' + window.lastReadFile.path + ']\n'
      + (c.length > 8000 ? c.slice(0, 8000) + '\n...[truncated]' : c));
  }
  if (_parts.length) _finalQuery = _parts.join('\n\n') + '\n\n' + _finalQuery;

  try {
    const res = await fetch('/ask', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query:   _finalQuery,
        model,
        userId,
        history: [...conversationHistory, ...messages.slice(0, -1)]
      })
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    const ms         = Date.now() - start;
    const reply      = data.reply || data.answer || '';
    const md         = window.markdownToHtml || (t => '<div class="chat-answer">' + t.replace(/\n/g, '<br>') + '</div>');
    const modelLabel = (data.modelUsed || model) + ' \u00b7 ' + formatMs(ms);

    if (window.appendToLog) {
      window.appendToLog(
        messages[messages.length - 1].content,
        [{ model: data.modelUsed || model, content: reply }],
        'single',
        _parts.join('\n\n')
      ).catch(() => {});
    }

    let trailHtml = '';
    if (data.failedModels && data.failedModels.length > 0) {
      const lines = data.failedModels.map((f, i) => {
        const isLast = i === data.failedModels.length - 1;
        const winner = (data.modelUsed || model).split(' (')[0];
        const suffix = isLast ? ', trying ' + winner + '...' : ', trying next...';
        return '<div>' + f.model + ' - ' + describeError(f.reason) + suffix + '</div>';
      });
      trailHtml = '<div style="font-size:12px;color:var(--text-dim);font-style:italic;'
        + 'margin-bottom:8px;padding:5px 10px;border-left:2px solid var(--border2);">'
        + lines.join('') + '</div>';
    }

    if (options.toPanel && window.panel) {
      window.panel.open(
        options.panelTitle || 'Output',
        options.panelRaw ? reply : md(reply),
        options.panelType || 'html'
      );
      outputEl.classList.add('html-content');
      outputEl.innerHTML = trailHtml + '<span style="font-size:13px;color:var(--text-dim);">'
        + '&#8594; shown in panel &nbsp;&middot;&nbsp;' + modelLabel + '</span>';
    } else {
      outputEl.classList.add('html-content');
      outputEl.innerHTML = trailHtml + md(reply)
        + '<div style="font-size:11px;color:#8d7c64;margin-top:6px;">' + modelLabel + '</div>';
    }
    document.getElementById('input').value = '';
    addToHistory(messages[messages.length - 1].content, reply);
    if (window.autoExtractMemory) {
      window.autoExtractMemory(messages[messages.length - 1].content, reply);
    }
    lastCloudQuery    = { query: messages[messages.length - 1].content, messages };
    lastCloudModelKey = model;
    setLastModel(model);
    return reply;
  } catch (err) {
    output('Error: ' + err.message);
    return null;
  }
}

async function sendToLocal(startKey, messages, output, outputEl) {
  const start    = Date.now();
  const startIdx = LOCAL_MODEL_CHAIN.findIndex(m => m.key === startKey);
  const chain    = startIdx !== -1
    ? [...LOCAL_MODEL_CHAIN.slice(startIdx), ...LOCAL_MODEL_CHAIN.slice(0, startIdx)]
    : LOCAL_MODEL_CHAIN;

  const endpoints = [
    'http://localhost:3000/ollama/v1/chat/completions',
    'http://localhost:11434/v1/chat/completions'
  ];

  const failedModels = [];

  for (const m of chain) {
    output('Trying ' + m.name + '...');
    let modelErr = null;
    for (const url of endpoints) {
      try {
        const r = await fetch(url, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ model: m.model, messages }),
          signal:  AbortSignal.timeout(180000)
        });
        if (!r.ok) { modelErr = 'HTTP ' + r.status; continue; }
        const data    = await r.json();
        const content = data.choices?.[0]?.message?.content;
        if (!content) { modelErr = 'empty response'; continue; }
        const ms = Date.now() - start;
        const md = window.markdownToHtml || (t => '<div class="chat-answer">' + t.replace(/\n/g, '<br>') + '</div>');
        let trailHtml = '';
        if (failedModels.length > 0) {
          const lines = failedModels.map((f, i) => {
            const isLast = i === failedModels.length - 1;
            const suffix = isLast ? ', trying ' + m.name + '...' : ', trying next...';
            return '<div>' + f.model + ' - ' + describeError(f.reason) + suffix + '</div>';
          });
          trailHtml = '<div style="font-size:12px;color:var(--text-dim);font-style:italic;'
            + 'margin-bottom:8px;padding:5px 10px;border-left:2px solid var(--border2);">'
            + lines.join('') + '</div>';
        }
        outputEl.classList.add('html-content');
        outputEl.innerHTML = trailHtml + md(content)
          + '<div style="font-size:11px;color:#8d7c64;margin-top:6px;">'
          + m.name + ' (local) \u00b7 ' + formatMs(ms) + '</div>';
        document.getElementById('input').value = '';
        setLastModel(m.key);
        return;
      } catch (err) { modelErr = err.message || err.name || 'unknown error'; continue; }
    }
    if (modelErr) failedModels.push({ model: m.name, reason: modelErr });
  }

  const proxyUp = await fetch('http://localhost:3000/health', { signal: AbortSignal.timeout(1000) })
    .then(r => r.ok).catch(() => false);
  const finalMsg = proxyUp
    ? 'Ollama not responding. Is Ollama running? Check the system tray.'
    : 'Local proxy not running. Double-click local-proxy.bat to start, then try again.';

  if (failedModels.length > 0) {
    outputEl.classList.add('html-content');
    const lines = failedModels.map(f => '<div>' + f.model + ' - ' + describeError(f.reason) + '</div>');
    outputEl.innerHTML = '<div style="font-size:12px;color:var(--text-dim);font-style:italic;'
      + 'margin-bottom:8px;padding:5px 10px;border-left:2px solid var(--border2);">'
      + lines.join('') + '</div>'
      + '<div style="font-size:13px;color:var(--red);">' + finalMsg + '</div>';
  } else {
    output(finalMsg);
  }
}

// ── Command detection ──────────────────────────────────────────────────────────

function detectCommand(text) {
  const trimmed = text.trim();
  if (trimmed === '?') return { command: '?', args: '' };
  const q = trimmed.match(/^([\w]+)\?$/);
  if (q) {
    const qcmd = q[1].toLowerCase() + '?';
    if (COMMANDS[qcmd]) return { command: qcmd, args: '' };
  }
  const m = trimmed.match(/^([\w]+):\s*([\s\S]*)$/);
  if (!m) return null;
  const base       = m[1].trim().toLowerCase();
  const rest       = m[2];
  const firstWord  = rest.trim().split(/\s+/)[0].toLowerCase();
  const afterFirst = rest.trim().replace(/^\S+\s*/, '');
  const twoWord = base + ': ' + firstWord;
  if (COMMANDS[twoWord]) return { command: twoWord, args: afterFirst };
  if (COMMANDS[base])    return { command: base,    args: rest       };
  return null;
}

// ── COMMANDS registry ──────────────────────────────────────────────────────────

const COMMANDS = {};

// ── Window exposes ────────────────────────────────────────────────────────────

window.detectCommand         = detectCommand;
window.COMMANDS              = COMMANDS;
window.esc                   = function (s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
window.getLastModel          = getLastModel;
window.setLastModel          = setLastModel;
window.nextCloudModel        = nextCloudModel;
window.getAuth               = getAuth;
window.sendToAI              = sendToAI;
window.sendToLocal           = sendToLocal;
window.getRootHandle         = function ()  { return rootHandle; };
window.clearRootHandle       = function ()  { rootHandle = null; };
window.ensureAccess          = ensureAccess;
window.handleAccess          = handleAccess;
window.clearHistory          = clearHistory;
window.addToHistory          = addToHistory;
window.getLastCloudQuery     = function ()  { return lastCloudQuery;    };
window.getLastCloudModelKey  = function ()  { return lastCloudModelKey; };
window.setLastCloudQuery     = function (q) { lastCloudQuery    = q;    };
window.setLastCloudModelKey  = function (k) { lastCloudModelKey = k;    };

// ── sendToLastModel ────────────────────────────────────────────────────────────

const LOCAL_KEYS = new Set(['qwen35', 'qwen', 'deepseek']);

window.sendToLastModel = async function (text, output, outputEl) {
  // All queries route through the Mobius orchestration pipeline.
  // Orch: prefix is accepted but not required.
  if (window.runOrchestrator) {
    const query = text.replace(/^Orch:\s*/i, '').trim();
    const chatPanel = document.getElementById('chatPanel');
    return await window.runOrchestrator(query, chatPanel, outputEl);
  }

  // Fallback if orchestrator not loaded
  const messages = [{ role: 'user', content: text }];
  return await sendToAI(getLastModel() || 'gemini-lite', messages, output, outputEl);
};
