// ── js/router.js ──────────────────────────────────────────────────────────────
// Conversational intent router.
// Intercepts plain-text input, classifies intent via Groq, identifies
// relevant files from the project map, and responds conversationally.
// Falls back to sendToLastModel for general chat.
//
// Session state: window.routerContext = { files, topic, action }
// Cleared on Chat: New (clearHistory already handles this via clearRouterContext).
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  // ── System prompts (brief -- routing layer only) ───────────────────────────

  const S_EXPL = 'You are a patient coding teacher. Explain clearly in plain English. '
    + 'Walk through what each part does and why. British English.';

  const S_FIX  = 'You are an expert debugger. Provide a minimal, targeted fix. '
    + 'Show changed lines with enough context to locate them. Explain what was wrong. British English.';

  const S_REVW = 'You are a senior code reviewer. Group findings by severity: Critical / High / Medium / Low. '
    + 'Be specific and actionable. British English.';

  // ── Helpers ────────────────────────────────────────────────────────────────

  function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function buildFileBlock(files) {
    return files.map(f => 'File: ' + f.path + '\n\n```\n' + f.content + '\n```').join('\n\n---\n\n');
  }

  function parseJSON(raw) {
    try {
      return JSON.parse(raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim());
    } catch { return null; }
  }

  async function groq(prompt, output) {
    const res  = await fetch('/ask', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: prompt, model: 'groq', userId: window.getAuth && window.getAuth('mobius_user_id') })
    });
    const data = await res.json();
    return data.reply || data.answer || '';
  }

  // ── File reading ───────────────────────────────────────────────────────────

  const SKIP = new Set(['.git', 'node_modules', '_debug', 'dist', 'build', '.vercel', 'backups', '__pycache__', '.venv']);

  async function readPath(rootHandle, relPath) {
    try {
      const parts = relPath.replace(/\\/g, '/').split('/').filter(Boolean);
      let cur = rootHandle;
      for (const part of parts) {
        let found = false;
        for await (const [name, h] of cur.entries()) {
          if (name === part) { cur = h; found = true; break; }
        }
        if (!found) return null;
      }
      if (cur.kind !== 'file') return null;
      return await (await cur.getFile()).text();
    } catch { return null; }
  }

  async function readFiles(paths, rootHandle) {
    const out = [];
    for (const p of paths) {
      const content = await readPath(rootHandle, p);
      if (content !== null) out.push({ path: p, content });
    }
    return out;
  }

  // ── Intent classification ──────────────────────────────────────────────────
  // Returns: { type: 'coding'|'open_project'|'chat', topic, action }

  async function classifyIntent(text) {
    const lower = text.toLowerCase();

    // Fast-path: opening a project
    if (lower.match(/\b(open|work on|start|load|switch to)\b/) &&
        lower.match(/\b(project|folder|gprtool|coder|mobius|repo)\b/)) {
      return { type: 'open_project', topic: text, action: 'open' };
    }

    // Fast-path keywords that suggest coding work
    const codingHints = ['fix', 'bug', 'explain', 'review', 'compass', 'rotation', 'npoint',
      'north point', 'function', 'error', 'crash', 'broken', 'deploy', 'debug', 'how does',
      'what does', 'why does', 'how is', 'walk me through', 'look at', 'work on'];
    const looksLikeCoding = codingHints.some(h => lower.includes(h));

    if (!looksLikeCoding) return { type: 'chat', topic: text, action: null };

    // Groq classification for ambiguous cases
    try {
      const prompt = 'Classify this developer query. Respond ONLY with valid JSON, no markdown.\n\n'
        + 'Query: "' + text + '"\n\n'
        + '{"type":"coding|chat","topic":"brief topic (3-6 words)","action":"explain|fix|review|find|null"}';
      const raw = await groq(prompt);
      const parsed = parseJSON(raw);
      if (parsed && parsed.type) return parsed;
    } catch { /* fall through */ }

    return { type: 'coding', topic: text, action: null };
  }

  // ── File identification ────────────────────────────────────────────────────
  // Groq reads project map and identifies relevant files.

  async function identifyFiles(topic, output) {
    const map = window.projectMap;
    if (!map) return null;

    output('Identifying relevant files...');

    const trimmedMap = map.split('\n').slice(0, 130).join('\n');
    const prompt = 'You are helping a developer find relevant source files in a project.\n\n'
      + 'Project map:\n' + trimmedMap + '\n\n'
      + 'Task: "' + topic + '"\n\n'
      + 'Return the 1-3 most relevant source files. '
      + 'Respond ONLY with a JSON array of relative file paths. No explanation.\n'
      + 'Example: ["app/js/north-point-2d.js","app/js/north-point-3d.js"]';

    try {
      const raw   = await groq(prompt, output);
      const paths = parseJSON(raw);
      if (Array.isArray(paths) && paths.length > 0) return paths;
    } catch { /* fall through */ }

    return null;
  }

  // ── Action dispatch ────────────────────────────────────────────────────────
  // Called on follow-up queries when files are already loaded.
  // Respects Ask: All mode -- uses runAllModels if active.

  async function dispatchAction(text, files, output, outputEl) {
    const lower  = text.toLowerCase();
    const block  = buildFileBlock(files);
    const fnames = files.map(f => f.path.split('/').pop()).join(', ');

    let sys, title, model;

    if (lower.match(/\b(explain|how|what|walk|describe|understand)\b/)) {
      sys = S_EXPL; title = 'Explain: ' + fnames; model = 'gemini-lite';
    } else if (lower.match(/\b(fix|bug|broken|wrong|error|crash|issue|problem)\b/)) {
      sys = S_FIX;  title = 'Fix: ' + fnames;     model = 'gemini';
    } else if (lower.match(/\b(review|audit|check|assess|look at)\b/)) {
      sys = S_REVW; title = 'Review: ' + fnames;  model = 'gemini';
    } else {
      sys = S_EXPL; title = 'Answer: ' + fnames;  model = 'gemini-lite';
    }

    // Inject file context into the query for All Mode
    const augmented = sys + '\n\n' + block + '\n\n' + text;

    // All Mode: fire all models simultaneously so we can compare and vote
    if (window.allModeActive && window.runAllModels) {
      output('Asking all models...');
      await window.runAllModels(augmented, output, outputEl, true); // true = right panel
      return true;
    }

    const messages = [{ role: 'user', content: augmented }];
    await window.sendToAI(model, messages, output, outputEl,
      { toPanel: true, panelTitle: title, panelType: 'html' });
    return true;
  }

  // ── Conversational response after file identification ──────────────────────

  function presentFiles(files, topic, outputEl) {
    const fileList = files.map(f => {
      const name = f.path.split('/').pop();
      const kb   = (f.content.length / 1024).toFixed(1);
      const hint = f.content.split('\n').slice(0, 4)
        .map(l => l.trim()).filter(l => l.startsWith('//') || l.startsWith('#') || l.startsWith('*'))
        .map(l => l.replace(/^[/#*\s-]+/, ''))
        .find(l => l.length > 10 && l.length < 100) || '';
      return '<li style="margin:5px 0;">'
        + '<strong>' + esc(name) + '</strong>'
        + ' <span style="color:var(--text-dim);font-size:12px;">(' + kb + ' KB)</span>'
        + (hint ? '<br><span style="color:var(--text-muted);font-size:12px;">' + esc(hint) + '</span>' : '')
        + '<br><span style="color:var(--text-dim);font-size:11px;">' + esc(f.path) + '</span>'
        + '</li>';
    }).join('');

    outputEl.classList.add('html-content');
    outputEl.innerHTML = '<div style="font-size:13px;">'
      + '<div style="margin-bottom:8px;">Found <strong>' + files.length
      + ' file' + (files.length > 1 ? 's' : '') + '</strong> relevant to <em>'
      + esc(topic) + '</em>:</div>'
      + '<ul style="margin:4px 0 12px 18px;padding:0;">' + fileList + '</ul>'
      + '<div style="color:var(--text-dim);">Files are loaded. What would you like to do?</div>'
      + '<div style="font-size:12px;color:var(--text-muted);margin-top:4px;">'
      + 'Try: <em>explain how it works</em> &nbsp;&middot;&nbsp; '
      + '<em>what is the rotation bug</em> &nbsp;&middot;&nbsp; '
      + '<em>review the code</em>'
      + '</div>'
      + '</div>';
    document.getElementById('input').value = '';
  }

  function presentOpenProject(outputEl) {
    outputEl.classList.add('html-content');
    outputEl.innerHTML = '<div style="font-size:13px;">'
      + '<div style="margin-bottom:10px;">No project is open. Select a folder to begin.</div>'
      + '<button id="routerOpenBtn" style="padding:7px 16px;background:var(--green);color:#fff;'
      + 'border:none;border-radius:3px;cursor:pointer;font-family:var(--font);font-size:13px;">'
      + 'Open Project Folder</button>'
      + '<div style="margin-top:8px;color:var(--text-dim);font-size:12px;">'
      + 'Or type <strong>Project: Open</strong> to select a folder.</div>'
      + '</div>';
    document.getElementById('input').value = '';

    // Wire up the button -- needs a user gesture to trigger folder picker
    requestAnimationFrame(() => {
      const btn = document.getElementById('routerOpenBtn');
      if (!btn) return;
      btn.addEventListener('click', async () => {
        btn.textContent = 'Opening...';
        btn.disabled = true;
        const dummyEl = document.createElement('div');
        if (window.COMMANDS && window.COMMANDS['project: open']) {
          await window.COMMANDS['project: open'].handler('', m => console.log(m), dummyEl);
        } else if (window.handleAccess) {
          await window.handleAccess(m => console.log(m));
        }
      });
    });
  }

  // ── Main entry point ───────────────────────────────────────────────────────
  // Returns true if handled, false to let normal AI chat take over.

  async function handleConversational(text, output, outputEl) {
    const projectOpen = !!(window.getRootHandle && window.getRootHandle());

    // ── Case 1: follow-up on already-loaded files ────────────────────────
    const ctx = window.routerContext;
    if (ctx && ctx.files && ctx.files.length > 0) {
      // Check if this is clearly a follow-up action on the loaded context
      const lower = text.toLowerCase();
      const isFollowUp = lower.match(/\b(explain|how|what|fix|bug|broken|review|audit|walk|describe|why|where)\b/);
      if (isFollowUp) {
        // Update lastReadFile for Code: commands
        window.lastReadFile = ctx.files[0];
        return await dispatchAction(text, ctx.files, output, outputEl);
      }
    }

    // ── Case 2: classify intent ──────────────────────────────────────────
    const intent = await classifyIntent(text);

    if (intent.type === 'open_project') {
      // Run Project: Open command directly rather than showing a card or falling to All Mode
      if (window.COMMANDS && window.COMMANDS['project: open']) {
        await window.COMMANDS['project: open'].handler('', output, outputEl);
      } else {
        output('Type Project: Open to select a folder.');
      }
      return true;
    }

    if (intent.type === 'chat') {
      return false; // fall through to normal AI
    }

    // ── Case 3: coding intent -- identify files ──────────────────────────
    if (!projectOpen) {
      output('No project open. Type Project: Open to select a folder.');
      return true;
    }

    const paths = await identifyFiles(intent.topic || text, output);

    if (!paths || paths.length === 0) {
      return false; // no files found -- let normal AI handle it
    }

    const handle = window.getRootHandle();
    const files  = await readFiles(paths, handle);

    if (files.length === 0) {
      return false;
    }

    // Store context for follow-up queries
    window.routerContext = { files, topic: intent.topic || text, action: intent.action };
    window.lastReadFile  = files[0];

    // Always present files first on the initial query -- let Boon decide what to do.
    // Auto-dispatch only happens on follow-up queries (when routerContext already set).
    presentFiles(files, intent.topic || text, outputEl);
    return true;
  }

  // ── Clear context on new chat ──────────────────────────────────────────────

  const _origClearHistory = window.clearHistory;
  window.clearHistory = function () {
    window.routerContext = null;
    if (_origClearHistory) _origClearHistory();
  };

  window.clearRouterContext = function () { window.routerContext = null; };

  // ── Expose ─────────────────────────────────────────────────────────────────

  window.handleConversational = handleConversational;

  // Default All Mode on -- active from session start.
  // Type Ask: All to toggle off once model preferences are established.
  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => {
      window.allModeActive = true;
      // Update the ALL MODE badge if it exists
      const badge = document.getElementById('allModeBadge');
      if (badge) badge.style.display = 'inline-block';
    }, 500); // after all.js has loaded
  });

})()
