// ── js/all.js ─────────────────────────────────────────────────────────────────
// Ask: All -- fires the query to all cloud models simultaneously.
// Ask: All (no args) -- toggles All Mode on/off.
// Ask: All [query]   -- one-shot (works whether mode is on or off).
// Category classified by Gemini Lite in the same parallel batch.
// Each response has 👍 (win + select) / 👎 (loss only) voting.
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  const CLOUD_MODELS = [
    { key: 'gemini-cascade',      name: 'Gemini',      stable: 'Google'     },
    { key: 'groq-cascade',        name: 'Groq',        stable: 'Groq'       },
    { key: 'mistral-cascade',     name: 'Mistral',     stable: 'Mistral'    },
    { key: 'cerebras-cascade',    name: 'Cerebras',    stable: 'Cerebras'   },
    { key: 'openrouter-cascade',  name: 'OpenRouter',  stable: 'OpenRouter' },
    { key: 'github',              name: 'GitHub',      stable: 'GitHub'     },
    { key: 'groq-qwq',            name: 'QwQ',         stable: 'Groq'       },
    { key: 'deepseek-cloud',      name: 'DeepSeek V3', stable: 'DeepSeek'   },
    { key: 'deepseek-r1',         name: 'DeepSeek R1', stable: 'DeepSeek'   },
  ];

  function getModelsToUse() {
    return CLOUD_MODELS; // all 5 stables, always
  }

  const CATEGORIES = ['Write', 'Fix', 'Understand', 'Debug', 'Plan', 'Brief'];

  // ── All Mode toggle ────────────────────────────────────────────────────────

  window.allModeActive = false;

  function setAllMode(on) {
    window.allModeActive = on;
    const badge = document.getElementById('allModeBadge');
    if (badge) badge.style.display = on ? 'inline' : 'none';
  }

  function toggleAllMode(output) {
    setAllMode(!window.allModeActive);
    output(window.allModeActive
      ? 'All Mode ON -- every query goes to all 5 cloud models. Click the badge or type Ask: All to turn off.'
      : 'All Mode OFF -- queries route to last used model.');
    document.getElementById('input').value = '';
  }

  window.toggleAllMode = function() { setAllMode(!window.allModeActive); };

  // ── Context builder ────────────────────────────────────────────────────────
  // Returns { contextQuery, brief } -- brief is logged; contextQuery is sent to AI.

  async function buildContext(userQuery) {
    // ── Protocol brief short-circuit ──────────────────────────────────────
    // When Brief: Protocol has assembled a schema brief, Task AIs receive ONLY
    // that brief -- no memory dump, no slim, no raw code. Zero noise.
    if (window.lastReadFile && window.lastReadFile.path === '[Protocol Brief]') {
      const brief = window.lastReadFile.content;
      return { contextQuery: brief + '\n\n' + userQuery, brief };
    }
    const parts = [];
    // Memory context -- same path as commands.js sendToAI
    if (window.getMemoryContext) {
      try {
        const _mem = await window.getMemoryContext(userQuery);
        if (_mem) parts.push('[Memory]\n' + _mem);
      } catch { /* never block */ }
    }
    const ctx   = window._projectContext;
    if (ctx) {
      if (ctx.brief)   parts.push('[Project]\n'         + ctx.brief);
      if (ctx.slim)    parts.push('[Files]\n'           + ctx.slim);
      if (ctx.context) parts.push('[Session Context]\n' + ctx.context);
    }
    // Prior selected response -- compact chat history for Brief Protocol
    if (window._lastSelectedReply) {
      parts.push('[Prior Selected Response]\n' + window._lastSelectedReply);
    }
    if (window.lastReadFile && window.lastReadFile.content) {
      const c = window.lastReadFile.content;
      parts.push('[File: ' + window.lastReadFile.path + ']\n'
        + (c.length > 8000 ? c.slice(0, 8000) + '\n...[truncated]' : c));
    }
    if (window.getCodeContext) {
      try {
        const _code = await window.getCodeContext(userQuery);
        if (_code) parts.unshift(_code);
      } catch { /* never block */ }
    }
    const brief       = parts.join('\n\n');
    const contextQuery = brief ? brief + '\n\n' + userQuery : userQuery;
    return { contextQuery, brief };
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  function fmtMs(ms) {
    if (ms < 1000) return ms + 'ms';
    const s = Math.floor(ms / 1000), r = ms % 1000;
    return r > 0 ? s + 's ' + r + 'ms' : s + 's';
  }

  function makeRow(container, modelKey, label) {
    const wrap = document.createElement('div');
    wrap.id = 'allrow-' + modelKey;
    wrap.style.cssText = 'margin-bottom:14px;border-left:3px solid var(--border2);'
      + 'padding-left:12px;transition:opacity 0.3s,border-left-color 0.3s;';

    const topLine = document.createElement('div');
    topLine.style.cssText = 'font-size:12px;color:var(--text);font-weight:bold;'
      + 'margin-bottom:6px;display:flex;align-items:center;gap:8px;';
    // Underlined model name at top of each response for easy scanning
    topLine.innerHTML = '<span style="text-decoration:underline;">' + label + '</span>';

    const voteWrap = document.createElement('span');
    voteWrap.id = 'votes-' + modelKey;
    voteWrap.style.display = 'none';

    function voteBtn(emoji, title) {
      const btn = document.createElement('button');
      btn.textContent = emoji;
      btn.title = title;
      btn.style.cssText = 'background:transparent;border:none;cursor:pointer;font-size:13px;'
        + 'padding:0 3px;opacity:0.55;line-height:1;transition:opacity 0.15s;';
      btn.onmouseenter = () => { btn.style.opacity = '1'; };
      btn.onmouseleave = () => { btn.style.opacity = '0.55'; };
      return btn;
    }

    const upBtn = voteBtn('\uD83D\uDC4D', 'Good response -- record win, select this model');
    const dnBtn = voteBtn('\uD83D\uDC4E', 'Poor response -- record loss');
    voteWrap.appendChild(upBtn);
    voteWrap.appendChild(dnBtn);
    topLine.appendChild(voteWrap);

    const body = document.createElement('div');
    body.style.cssText = 'font-size:13px;color:var(--text-dim);font-style:italic;';
    body.textContent = 'waiting...';

    const timing = document.createElement('div');
    timing.style.cssText = 'font-size:11px;color:var(--text-dim);margin-top:3px;';

    wrap.appendChild(topLine);
    wrap.appendChild(body);
    wrap.appendChild(timing);
    container.appendChild(wrap);

    return { wrap, body, timing, voteWrap, upBtn, dnBtn };
  }

  // ── Classification ─────────────────────────────────────────────────────────

  async function classifyQuery(query, userId) {
    const prompt = 'Classify this query in one word. '
      + 'Choose from: Write, Fix, Understand, Debug, Plan, Brief, General. '
      + 'Reply with ONLY the one word, nothing else. Query: ' + query;
    try {
      const res  = await fetch('/ask', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: prompt, model: 'gemini-lite', userId })
      });
      const data = await res.json();
      const raw  = (data.reply || data.answer || '').trim();
      const word = raw.split(/\s/)[0].replace(/[^a-zA-Z]/g, '');
      return CATEGORIES.includes(word) ? word : 'General';
    } catch { return 'General'; }
  }

  // ── runAllModels ───────────────────────────────────────────────────────────

  const md = window.markdownToHtml || (t => '<div class="chat-answer">' + t.replace(/\n/g,'<br>') + '</div>');

  async function runAllModels(query, output, outputEl, panelMode = false) {
    const userId = window.getAuth ? window.getAuth('mobius_user_id') : null;
    const { contextQuery, brief } = await buildContext(query);

    let container;
    if (panelMode && window.panel) {
      window.panel.open('All Mode', '<div id="allModeRows" style="padding:16px;"></div>', 'html');
      await new Promise(r => requestAnimationFrame(r));
      container = document.getElementById('allModeRows');
      if (!container) container = outputEl;
      outputEl.classList.add('html-content');
      outputEl.innerHTML = '<span style="font-size:12px;color:var(--text-dim);font-style:italic;">'
        + 'All Mode \u2192 see panel \u2192</span>';
    } else {
      container = outputEl;
      outputEl.classList.add('html-content');
      outputEl.innerHTML = '';
    }

    if (!panelMode || !window.panel) {
      const hdr = document.createElement('div');
      hdr.style.cssText = 'font-weight:bold;font-size:14px;margin-bottom:2px;';
      hdr.textContent   = 'Ask: All';
      container.appendChild(hdr);
    }

    const catBadge = document.createElement('div');
    catBadge.style.cssText = 'font-size:11px;color:var(--text-dim);margin-bottom:10px;font-style:italic;';
    catBadge.textContent   = 'Classifying...';
    container.appendChild(catBadge);

    const rows        = getModelsToUse().map(m => ({ m, ...makeRow(container, m.key, m.name) }));
    let currentCategory = 'General';
    const logEntries  = [];
    let   pendingCount = rows.length;

    // Record when task queries fire (used by Brief AI for timing display)
    window.allModeQueryStart = Date.now();

    classifyQuery(query, userId).then(cat => {
      currentCategory = cat;
      catBadge.textContent   = 'Category: ' + cat;
      catBadge.style.fontStyle = 'normal';
    });

    rows.forEach(({ m, wrap, body, timing, voteWrap, upBtn, dnBtn }, rowIdx) => {
      setTimeout(() => {
        const start = Date.now();
        let replyText = '';
        body.textContent = 'asking...';

        fetch('/ask', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ query: contextQuery, model: m.key, userId })
        })
        .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(data => {
          if (data.error) throw new Error(data.error);
          const ms  = Date.now() - start;
          replyText = data.reply || data.answer || '';
          body.style.fontStyle = 'normal';
          body.style.color     = 'var(--text)';
          body.classList.add('html-content');
          body.innerHTML     = md(replyText);
          timing.textContent = (data.modelUsed || m.name) + ' \u00b7 ' + fmtMs(ms);
          voteWrap.style.display = 'inline';

          // Use m.name (clean cascade label) not data.modelUsed -- fallback chain names
          // like 'Codestral (fallback from Groq)(fallback from Gemini)' break evaluator aggregation
          logEntries.push({ model: m.name, content: replyText });
          if (window.Scores) window.Scores.recordLatency(m.key, ms);
          pendingCount--;
          if (pendingCount === 0) {
            window.allModeResponsesIn = Date.now();
            if (window.appendToLog) window.appendToLog(query, logEntries, 'all', brief).catch(() => {});
            if (window.autoEvaluate) window.autoEvaluate(query, logEntries, brief, currentCategory).catch(() => {});
          }

          upBtn.onclick = () => {
            if (window.Scores) window.Scores.recordWin(m.key, currentCategory);
            wrap.style.borderLeftColor = '#4a7c4e';
            wrap.style.borderLeftWidth = '4px';
            upBtn.style.opacity = '1';
            upBtn.disabled = true;
            dnBtn.disabled = true;
            rows.forEach(r => {
              if (r.m.key !== m.key) {
                r.wrap.style.opacity = '0.3';
                if (r.upBtn) r.upBtn.disabled = true;
                if (r.dnBtn) r.dnBtn.disabled = true;
              }
            });
            if (window.addToHistory) window.addToHistory(query, replyText);
            if (window.setLastModel) window.setLastModel(m.key);
            document.getElementById('input').value = '';
            document.getElementById('input').focus();
          };

          dnBtn.onclick = () => {
            if (window.Scores) window.Scores.recordLoss(m.key, currentCategory);
            wrap.style.borderLeftColor = '#8d3a3a';
            dnBtn.style.opacity = '1';
            dnBtn.disabled = true;
          };
        })
        .catch(err => {
          body.style.fontStyle = 'normal';
          body.style.color     = 'var(--red)';
          body.textContent     = 'Error: ' + err.message;
          timing.textContent   = fmtMs(Date.now() - start);
          logEntries.push({ model: m.name, content: '[Error: ' + err.message + ']' });
          pendingCount--;
          if (pendingCount === 0) {
            window.allModeResponsesIn = Date.now();
            if (window.appendToLog) window.appendToLog(query, logEntries, 'all', brief).catch(() => {});
            if (window.autoEvaluate) window.autoEvaluate(query, logEntries, brief, currentCategory).catch(() => {});
          }
        });
      }, rowIdx * 200);
    });

    document.getElementById('input').value = '';
  }

  // ── Ask: All handler ───────────────────────────────────────────────────────

  async function handleAskAll(args, output, outputEl) {
    if (!args.trim()) {
      toggleAllMode(output);
      return;
    }
    const usePanel = !!(window.panel);
    await runAllModels(args.trim(), output, outputEl, usePanel);
  }

  window.runAllModels = runAllModels;

  function register() {
    if (!window.COMMANDS) { setTimeout(register, 50); return; }
    window.COMMANDS['ask: all'] = {
      handler: handleAskAll,
      family:  'ask',
      desc:    'All cloud models simultaneously -- no args toggles All Mode on/off'
    };
  }
  register();

})();
