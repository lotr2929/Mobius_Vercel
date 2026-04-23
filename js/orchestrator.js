// js/orchestrator.js
// Handles the Orch: command -- routes through the 5-AI consensus pipeline.
// Flow: Gate 1 -> Gate 1.5 -> [user selects sources] -> Execution -> Gate 2
// Supports up to ORCH_MAX_CYCLES full cycles (Gate 2 failure restarts Gate 1).

'use strict';

// ── Heartbeat ticker (shows elapsed time during server waits) ─────────────────
function startTicker(pid, phase) {
  const el = document.getElementById(pid);
  if (!el) return null;
  const start = Date.now();
  const ticker = document.createElement('div');
  ticker.className = 'orch-ticker';
  ticker.style.cssText = 'font-size:11px;padding:2px 0 2px 12px;color:var(--text-dim);font-style:italic;';
  el.appendChild(ticker);
  const id = setInterval(() => {
    const s = Math.floor((Date.now() - start) / 1000);
    ticker.textContent = '⋯ ' + phase + ' (' + s + 's elapsed)';
    el.scrollIntoView({ block: 'nearest' });
  }, 1000);
  return { id, ticker };
}

function stopTicker(handle) {
  if (!handle) return;
  clearInterval(handle.id);
  if (handle.ticker && handle.ticker.parentNode) handle.ticker.remove();
}

// ── SSE stream reader for Step 2 ─────────────────────────────────────────────
// Reads server-sent events from /orchestrate/stream and calls onEvent for each.
async function streamStep2(body, onEvent) {
  const res = await fetch('/orchestrate/stream', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body)
  });
  if (!res.ok) throw new Error('Stream endpoint returned HTTP ' + res.status);

  const reader  = res.body.getReader();
  const decoder = new TextDecoder();
  let   buffer  = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep partial line for next chunk
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try { onEvent(JSON.parse(line.slice(6))); } catch { /* skip malformed */ }
      }
    }
  }
}

// ── File reading helper ───────────────────────────────────────────────────────
function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = e => resolve(e.target.result);
    reader.onerror = () => reject(new Error('Could not read ' + file.name));
    reader.readAsText(file);
  });
}

// ── Right-panel content: individual task AI answers ───────────────────────────
function buildPanelContent(answers, gate2) {
  const md = window.markdownToHtml || (t => '<div style="white-space:pre-wrap">' + t.replace(/</g, '&lt;') + '</div>');
  const scoreColour = s => s >= 85 ? '#4a7c4e' : s >= 70 ? '#a06800' : '#8d3a3a';

  let html = '<div style="padding:10px 14px;font-family:var(--font);">';
  html += '<div style="font-size:11px;color:var(--text-dim);margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid var(--border);">'
    + (gate2.passed ? '✓ Consensus passed' : '⚠ Fallback') + ' — avg ' + gate2.avgScore.toFixed(0) + '/100 · '
    + (answers.length) + ' AI responses'
    + '</div>';

  answers.forEach((a, i) => {
    const col = scoreColour(a.avgScore);
    html += '<div style="margin-bottom:16px;border-bottom:1px solid var(--border);padding-bottom:14px;">';
    html += '<div style="font-size:11px;font-weight:bold;margin-bottom:6px;display:flex;justify-content:space-between;align-items:baseline;">';
    html += '<span style="color:var(--text);">' + (i + 1) + '. ' + (a.label || 'AI ' + (i+1)) + '</span>';
    html += '<span style="color:' + col + ';">' + a.avgScore.toFixed(0) + '/100 &nbsp;·&nbsp; <span style="color:var(--text-dim);font-weight:normal;">' + (a.model || '') + '</span></span>';
    html += '</div>';
    html += '<div class="chat-answer" style="font-size:13px;">' + md(a.text || '') + '</div>';
    html += '</div>';
  });
  html += '</div>';
  return html;
}

// ── Panel "preparing" placeholder ─────────────────────────────────────────────
function openPanelPreparing() {
  if (!window.panel) return;
  window.panel.open(
    'Task AI Responses',
    '<div style="padding:20px 14px;font-size:12px;color:var(--text-dim);">◌ Waiting for task AIs to complete…</div>',
    'html'
  );
}

const ORCH_MAX_CYCLES = 5;

// ── Progress display ──────────────────────────────────────────────────────────
function orchProgress(containerId, message, type = 'info') {
  const el = document.getElementById(containerId);
  if (!el) return;
  const colours = { info: 'var(--text-dim)', ok: 'var(--green)', warn: '#b8860b', err: 'var(--red)' };
  const icons   = { info: '◌', ok: '✓', warn: '⚠', err: '✗' };
  const line = document.createElement('div');
  line.style.cssText = 'font-size:12px;padding:2px 0;color:' + (colours[type] || colours.info);
  line.textContent = icons[type] + ' ' + message;
  el.appendChild(line);
  el.scrollIntoView({ block: 'nearest' });
}

// ── Shared file-upload section (used in both source card branches) ────────────
function buildFileUploadSection(uploadedFiles, onFilesChanged) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'margin-top:10px;padding-top:8px;border-top:1px solid var(--border);';

  const lbl = document.createElement('div');
  lbl.style.cssText = 'font-size:11px;color:var(--text-dim);margin-bottom:6px;';
  lbl.textContent = 'Or upload a file (txt, md, html, json, csv):';
  wrap.appendChild(lbl);

  const fileList = document.createElement('div');
  fileList.style.cssText = 'font-size:11px;color:var(--text);margin-bottom:4px;';
  wrap.appendChild(fileList);

  function refreshList() {
    fileList.innerHTML = '';
    uploadedFiles.forEach((f, i) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:2px 0;';
      const icon = document.createElement('span');
      icon.textContent = '📄 ' + f.name + ' (' + (f.content.length / 1024).toFixed(1) + ' KB)';
      icon.style.flex = '1';
      const del = document.createElement('button');
      del.textContent = '✕';
      del.style.cssText = 'background:transparent;border:none;color:var(--red);cursor:pointer;font-size:11px;';
      del.onclick = () => { uploadedFiles.splice(i, 1); refreshList(); onFilesChanged(); };
      row.appendChild(icon);
      row.appendChild(del);
      fileList.appendChild(row);
    });
  }

  const inp = document.createElement('input');
  inp.type   = 'file';
  inp.accept = '.txt,.md,.html,.htm,.json,.csv';
  inp.style.display = 'none';
  inp.multiple = true;
  inp.onchange = async () => {
    for (const file of Array.from(inp.files)) {
      try {
        const content = await readFileAsText(file);
        uploadedFiles.push({ name: file.name, content });
      } catch { /* skip unreadable files */ }
    }
    inp.value = '';
    refreshList();
    onFilesChanged();
  };
  wrap.appendChild(inp);

  const pickBtn = document.createElement('button');
  pickBtn.textContent = '+ Upload file';
  pickBtn.style.cssText = 'background:transparent;color:var(--accent);border:1px solid var(--accent);border-radius:3px;padding:3px 10px;cursor:pointer;font-size:11px;';
  pickBtn.onclick = () => inp.click();
  wrap.appendChild(pickBtn);

  return wrap;
}

// ── Source selection card (Decision Point 2) ──────────────────────────────────
function buildSourceCard(sources, onConfirm) {
  const card = document.createElement('div');
  card.style.cssText = [
    'background:var(--surface2)',
    'border:1px solid var(--border)',
    'border-radius:6px',
    'padding:12px 14px',
    'margin:10px 0',
    'font-size:13px'
  ].join(';');

  const uploadedFiles = []; // shared across both branches

  // Detect empty RAG (all sources are placeholder)
  const realSources  = sources.filter(s => s.url && s.url !== 'no-search-available');
  const searchFailed = realSources.length === 0;

  const heading = document.createElement('div');
  heading.style.cssText = 'font-weight:bold;margin-bottom:8px;color:var(--text);';
  heading.textContent = searchFailed
    ? 'Decision Point 2 — Source search unavailable'
    : 'Decision Point 2 — Select sources (' + sources.length + ' found):';
  card.appendChild(heading);

  if (searchFailed) {
    // ── Empty RAG: show warning and manual URL entry ──────────────────────
    const warn = document.createElement('div');
    warn.style.cssText = 'font-size:12px;color:#a06800;margin-bottom:10px;';
    warn.textContent = '⚠ Web search returned no results. You can enter URLs manually, upload a file, or proceed on model knowledge only.';
    card.appendChild(warn);

    // Manual URL list
    const manualList = [];
    const urlContainer = document.createElement('div');
    urlContainer.style.cssText = 'margin-bottom:10px;';
    card.appendChild(urlContainer);

    function renderUrls() {
      urlContainer.innerHTML = '';
      manualList.forEach((url, i) => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:3px 0;font-size:12px;';
        const lbl = document.createElement('span');
        lbl.style.cssText = 'flex:1;color:var(--text);word-break:break-all;';
        lbl.textContent = url;
        const del = document.createElement('button');
        del.textContent = '✕';
        del.style.cssText = 'background:transparent;border:none;color:var(--red);cursor:pointer;font-size:11px;';
        del.onclick = () => { manualList.splice(i, 1); renderUrls(); };
        row.appendChild(lbl);
        row.appendChild(del);
        urlContainer.appendChild(row);
      });
    }

    const inputRow = document.createElement('div');
    inputRow.style.cssText = 'display:flex;gap:6px;margin-bottom:8px;';
    const urlInput = document.createElement('input');
    urlInput.type        = 'text';
    urlInput.placeholder = 'Paste a URL and press Add...';
    urlInput.style.cssText = [
      'flex:1',
      'font-size:12px',
      'padding:4px 8px',
      'border:1px solid var(--border)',
      'border-radius:3px',
      'background:var(--surface)',
      'color:var(--text)',
      'font-family:var(--font)'
    ].join(';');
    const addUrlBtn = document.createElement('button');
    addUrlBtn.textContent = 'Add';
    addUrlBtn.style.cssText = 'background:var(--accent);color:#fff;border:none;border-radius:3px;padding:4px 10px;cursor:pointer;font-size:12px;';
    addUrlBtn.onclick = () => {
      const v = urlInput.value.trim();
      if (v && /^https?:\/\//.test(v)) { manualList.push(v); urlInput.value = ''; renderUrls(); }
      else { urlInput.style.border = '1px solid var(--red)'; setTimeout(() => { urlInput.style.border = '1px solid var(--border)'; }, 1500); }
    };
    urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addUrlBtn.click(); } });
    inputRow.appendChild(urlInput);
    inputRow.appendChild(addUrlBtn);
    card.appendChild(inputRow);

    // File upload
    card.appendChild(buildFileUploadSection(uploadedFiles, () => {}));

    const footer = document.createElement('div');
    footer.style.cssText = 'display:flex;gap:8px;margin-top:8px;';
    const contBtn = document.createElement('button');
    contBtn.textContent = 'Continue →';
    contBtn.style.cssText = 'background:var(--accent);color:#fff;border:none;border-radius:4px;padding:6px 14px;cursor:pointer;font-size:12px;';
    const skipBtn = document.createElement('button');
    skipBtn.textContent = 'Skip (model knowledge only)';
    skipBtn.style.cssText = 'background:transparent;color:var(--text-dim);border:1px solid var(--border);border-radius:4px;padding:6px 10px;cursor:pointer;font-size:12px;';
    contBtn.onclick = () => {
      const selected = manualList.map(url => ({ url, title: url, snippet: '' }));
      card.style.opacity = '0.5';
      contBtn.disabled = true; skipBtn.disabled = true;
      onConfirm(selected, uploadedFiles);
    };
    skipBtn.onclick = () => {
      card.style.opacity = '0.5';
      contBtn.disabled = true; skipBtn.disabled = true;
      onConfirm([], uploadedFiles);
    };
    footer.appendChild(contBtn);
    footer.appendChild(skipBtn);
    card.appendChild(footer);
    return card;
  }

  // ── Normal source selection ───────────────────────────────────────────────
  const hint = document.createElement('div');
  hint.style.cssText = 'font-size:11px;color:var(--text-dim);margin-bottom:10px;';
  hint.textContent = 'Tick the sources you want the AIs to use. Recommended: 3-5.';
  card.appendChild(hint);

  const list = document.createElement('div');
  list.style.cssText = 'max-height:220px;overflow-y:auto;';

  const checkboxes = [];
  realSources.forEach((src, i) => {
    const row = document.createElement('label');
    row.style.cssText = 'display:flex;align-items:flex-start;gap:8px;padding:5px 2px;cursor:pointer;border-bottom:1px solid var(--border);';
    const cb = document.createElement('input');
    cb.type    = 'checkbox';
    cb.checked = i < 5;
    cb.style.cssText = 'margin-top:3px;flex-shrink:0;';
    checkboxes.push({ cb, src });
    const txt = document.createElement('span');
    const title = document.createElement('div');
    title.style.cssText = 'font-size:12px;color:var(--text);';
    title.textContent = src.title || src.url;
    const url = document.createElement('div');
    url.style.cssText = 'font-size:10px;color:var(--text-dim);word-break:break-all;';
    url.textContent = src.url;
    txt.appendChild(title);
    txt.appendChild(url);
    row.appendChild(cb);
    row.appendChild(txt);
    list.appendChild(row);
  });
  card.appendChild(list);

  // File upload (also available when real sources are found)
  card.appendChild(buildFileUploadSection(uploadedFiles, () => {}));

  const footer = document.createElement('div');
  footer.style.cssText = 'display:flex;gap:8px;margin-top:10px;';
  const btn = document.createElement('button');
  btn.textContent = 'Continue with selected sources →';
  btn.style.cssText = 'background:var(--accent);color:#fff;border:none;border-radius:4px;padding:6px 14px;cursor:pointer;font-size:12px;';
  const skipBtn = document.createElement('button');
  skipBtn.textContent = 'Skip (no sources)';
  skipBtn.style.cssText = 'background:transparent;color:var(--text-dim);border:1px solid var(--border);border-radius:4px;padding:6px 10px;cursor:pointer;font-size:12px;';
  btn.onclick = () => {
    const selected = checkboxes.filter(x => x.cb.checked).map(x => x.src);
    card.style.opacity = '0.5';
    btn.disabled = true; skipBtn.disabled = true;
    onConfirm(selected, uploadedFiles);
  };
  skipBtn.onclick = () => {
    card.style.opacity = '0.5';
    btn.disabled = true; skipBtn.disabled = true;
    onConfirm([], uploadedFiles);
  };
  footer.appendChild(btn);
  footer.appendChild(skipBtn);
  card.appendChild(footer);
  return card;
}

// ── Gate 1 alternatives panel (shown when Gate 1 fails on last cycle) ─────────
function buildAlternativesPanel(alternatives, onSelect) {
  const card = document.createElement('div');
  card.style.cssText = [
    'background:var(--surface2)',
    'border:1px solid var(--border)',
    'border-radius:6px',
    'padding:12px 14px',
    'margin:10px 0',
    'font-size:13px'
  ].join(';');

  const heading = document.createElement('div');
  heading.style.cssText = 'font-weight:bold;margin-bottom:4px;color:var(--text);';
  heading.textContent = 'Gate 1 — Prompt consensus failed. Choose an approach:';
  card.appendChild(heading);

  const hint = document.createElement('div');
  hint.style.cssText = 'font-size:11px;color:var(--text-dim);margin-bottom:10px;';
  hint.textContent = 'Click the prompt that best fits your intent, or submit a new query.';
  card.appendChild(hint);

  alternatives.forEach((alt, i) => {
    const row = document.createElement('div');
    row.style.cssText = [
      'border:1px solid var(--border)',
      'border-radius:4px',
      'padding:8px 10px',
      'margin-bottom:8px',
      'cursor:pointer'
    ].join(';');

    const label = document.createElement('div');
    label.style.cssText = 'font-size:11px;font-weight:bold;color:var(--text-dim);margin-bottom:3px;';
    label.textContent = 'Approach ' + String.fromCharCode(65 + i)
      + '  (score: ' + alt.avgScore.toFixed(0) + '/100'
      + (alt.passCount ? ', ' + alt.passCount + '/5 passed' : '') + ')';

    const text = document.createElement('div');
    text.style.cssText = 'font-size:12px;color:var(--text);margin-bottom:3px;';
    text.textContent = alt.prompt;

    const why = document.createElement('div');
    why.style.cssText = 'font-size:11px;color:var(--text-dim);font-style:italic;';
    why.textContent = alt.reasoning ? 'Note: ' + alt.reasoning : '';

    row.appendChild(label);
    row.appendChild(text);
    if (alt.reasoning) row.appendChild(why);

    row.onmouseover = () => { row.style.background = 'var(--surface)'; };
    row.onmouseout  = () => { row.style.background = ''; };
    row.onclick = () => {
      card.style.opacity = '0.5';
      onSelect(alt.prompt);
    };
    card.appendChild(row);
  });

  const skipBtn = document.createElement('button');
  skipBtn.textContent = 'Submit a new query instead';
  skipBtn.style.cssText = [
    'background:transparent',
    'color:var(--text-dim)',
    'border:1px solid var(--border)',
    'border-radius:4px',
    'padding:5px 10px',
    'cursor:pointer',
    'font-size:11px',
    'margin-top:4px'
  ].join(';');
  skipBtn.onclick = () => { card.style.opacity = '0.5'; onSelect(null); };
  card.appendChild(skipBtn);

  return card;
}

// ── Gate 2 alternative answers panel (shown when Gate 2 fails on last cycle) ──
function buildAlternativeAnswersPanel(alternatives) {
  const card = document.createElement('div');
  card.style.cssText = [
    'background:var(--surface2)',
    'border:1px solid var(--border)',
    'border-radius:6px',
    'padding:12px 14px',
    'margin:10px 0',
    'font-size:13px'
  ].join(';');

  const heading = document.createElement('div');
  heading.style.cssText = 'font-weight:bold;margin-bottom:4px;color:var(--text);';
  heading.textContent = 'Gate 2 — Answer consensus failed. Best alternatives:';
  card.appendChild(heading);

  const hint = document.createElement('div');
  hint.style.cssText = 'font-size:11px;color:var(--text-dim);margin-bottom:10px;';
  hint.textContent = 'The AIs disagreed after ' + ORCH_MAX_CYCLES + ' full cycles. These are the top individual answers.';
  card.appendChild(hint);

  (alternatives || []).forEach((alt, i) => {
    const section = document.createElement('div');
    section.style.cssText = [
      'border:1px solid var(--border)',
      'border-radius:4px',
      'padding:8px 10px',
      'margin-bottom:8px'
    ].join(';');

    const label = document.createElement('div');
    label.style.cssText = 'font-size:11px;font-weight:bold;color:var(--text-dim);margin-bottom:5px;';
    label.textContent = 'Answer ' + (i + 1) + ' — ' + (alt.label || '') + '  (score: ' + (alt.score || 0).toFixed(0) + '/100)';

    const text = document.createElement('div');
    text.className = 'mq-block';
    text.style.cssText = 'font-size:13px;';
    text.textContent = alt.text || '';

    section.appendChild(label);
    section.appendChild(text);
    card.appendChild(section);
  });

  return card;
}

// ── Answer display ────────────────────────────────────────────────────────────
function buildAnswerCard(answer, citations, gate2, scores) {
  const card = document.createElement('div');
  card.style.cssText = 'margin:8px 0;';

  const badge = document.createElement('div');
  badge.style.cssText = [
    'display:inline-block',
    'font-size:10px',
    'padding:2px 7px',
    'border-radius:10px',
    'margin-bottom:8px',
    gate2.passed
      ? 'background:#d4edda;color:#2a6035;'
      : 'background:#fff3cd;color:#856404;'
  ].join(';');
  badge.textContent = gate2.passed
    ? '✓ Consensus passed (' + gate2.avgScore.toFixed(0) + '/100, ' + gate2.iterations + ' iter)'
    : '⚠ Fallback answer (no consensus after ' + gate2.iterations + ' iter)';
  card.appendChild(badge);

  const answerEl = document.createElement('div');
  answerEl.className = 'mq-block';
  answerEl.textContent = answer;
  card.appendChild(answerEl);

  const realCitations = (citations || []).filter(c => c.url && c.url !== 'no-search-available');
  if (realCitations.length > 0) {
    const citTitle = document.createElement('div');
    citTitle.style.cssText = 'font-size:11px;font-weight:bold;color:var(--text-dim);margin-top:10px;margin-bottom:4px;';
    citTitle.textContent = 'Sources used:';
    card.appendChild(citTitle);
    realCitations.forEach((c, i) => {
      const cit = document.createElement('div');
      cit.style.cssText = 'font-size:11px;color:var(--text-dim);padding:1px 0;';
      cit.innerHTML = '[' + (i + 1) + '] <a href="' + c.url + '" target="_blank" style="color:var(--accent)">'
        + (c.title || c.url) + '</a>';
      card.appendChild(cit);
    });
  }

  if (scores && scores.length > 0) {
    const toggle = document.createElement('div');
    toggle.style.cssText = 'font-size:10px;color:var(--text-dim);cursor:pointer;margin-top:8px;user-select:none;';
    toggle.textContent = '▸ Show AI scores';
    const scoreTable = document.createElement('div');
    scoreTable.style.display = 'none';
    scores.forEach(s => {
      const row = document.createElement('div');
      row.style.cssText = 'font-size:10px;color:var(--text-muted);padding:1px 0;';
      row.textContent = s.label + ' [' + s.model + ']: ' + s.avgScore.toFixed(0) + '/100';
      scoreTable.appendChild(row);
    });
    toggle.onclick = () => {
      const open = scoreTable.style.display !== 'none';
      scoreTable.style.display = open ? 'none' : 'block';
      toggle.textContent = (open ? '▸' : '▾') + ' Show AI scores';
    };
    card.appendChild(toggle);
    card.appendChild(scoreTable);
  }

  return card;
}

// ── Main orchestrator entry point ─────────────────────────────────────────────
// reuseOutputEl: if passed (from sendToLastModel), the orchestrator writes into
// the existing chat entry instead of creating a duplicate container.
window.runOrchestrator = async function(query, chatPanel, reuseOutputEl) {
  let container;

  if (reuseOutputEl) {
    // Reuse the existing mq-block element from handleAsk
    container = reuseOutputEl;
    container.classList.add('html-content');
    container.style.cssText += ';border-left:3px solid var(--accent);padding-left:10px;';
  } else {
    // Standalone mode -- create our own entry (e.g. called from session task)
    container = document.createElement('div');
    container.className = 'chat-entry';
    container.style.cssText = 'border-left:3px solid var(--accent);padding-left:10px;';
    const queryLabel = document.createElement('div');
    queryLabel.className = 'chat-query';
    queryLabel.textContent = query;
    container.appendChild(queryLabel);
    chatPanel.appendChild(container);
    chatPanel.scrollTop = chatPanel.scrollHeight;
  }

  const progressBox = document.createElement('div');
  progressBox.id = 'orch-progress-' + Date.now();
  progressBox.style.cssText = 'margin:6px 0;';
  container.appendChild(progressBox);
  if (!reuseOutputEl) chatPanel.scrollTop = chatPanel.scrollHeight;

  const pid = progressBox.id;
  const log = (msg, type) => orchProgress(pid, msg, type);

  let cycleCount = 0;

  // Open right panel immediately with a placeholder
  openPanelPreparing();

  // ── Single cycle: Gate 1 + Gate 1.5 + source selection + Gate 2 ────────────
  async function runCycle() {
    cycleCount++;
    if (cycleCount > 1) {
      log('--- Cycle ' + cycleCount + ' / ' + ORCH_MAX_CYCLES + ' --- restarting from Gate 1', 'warn');
    }

    // ── Step 1: Gate 1 + Gate 1.5 (Gate 1 + source discovery run in parallel) ─
    log('Gate 1 — generating consensus prompt + source discovery in parallel...');
    const ticker1 = startTicker(pid, 'Gate 1 + source discovery');
    let step1Res;
    try {
      step1Res = await fetch('/orchestrate', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ step: 1, query, cycle: cycleCount })
      });
      if (!step1Res.ok) throw new Error('HTTP ' + step1Res.status);
    } catch (err) {
      stopTicker(ticker1);
      log('Step 1 error: ' + err.message, 'err');
      return;
    }
    stopTicker(ticker1);
    const data1 = await step1Res.json();
    const g1    = data1.gate1;

    // Gate 1 status line
    const g1Label = g1.passed ? 'passed' : (g1.gate15Retry ? 'fallback (retried for Gate 1.5)' : 'fallback');
    log('Gate 1 ' + g1Label + ' — ' + g1.avgScore.toFixed(0) + '/100 avg, ' + g1.iterations + ' iteration(s)', g1.passed ? 'ok' : 'warn');
    const g15Label = data1.gate15.passed ? 'source consensus reached' : 'partial sources';
    log('Gate 1.5 — ' + g15Label + ' (attempt ' + data1.gate15.attempt + (data1.gate15.gate1Retried ? ', Gate 1 retried' : '') + ')', data1.gate15.passed ? 'ok' : 'warn');

    // Show the curated consensus prompt so you can see what the AIs agreed on
    const promptPreview = (data1.consensus_prompt || '').slice(0, 140);
    log('Prompt: "' + promptPreview + (data1.consensus_prompt.length > 140 ? '…' : '') + '"', 'info');

    // Gate 1 failed AND we are on the last allowed cycle -- show alternatives
    if (!g1.passed && g1.alternatives && g1.alternatives.length > 0 && cycleCount >= ORCH_MAX_CYCLES) {
      log('Gate 1 failed after max cycles — choose an approach or submit a new query', 'warn');
      const chosenPrompt = await new Promise(resolve => {
        const panel = buildAlternativesPanel(g1.alternatives, resolve);
        container.appendChild(panel);
        chatPanel.scrollTop = chatPanel.scrollHeight;
      });
      if (!chosenPrompt) {
        log('No alternative selected. Stopping.', 'warn');
        return;
      }
      // Override the prompt with the user's choice and continue
      data1.consensus_prompt = chosenPrompt;
    }

    log('Found ' + (data1.all_sources || data1.sources || []).length + ' source(s). Awaiting your selection...');
    const sources = data1.all_sources || data1.sources || [];

    // ── Decision Point 2: source selection + Step 2 ──────────────────────────
    return new Promise(resolve => {
      const card = buildSourceCard(sources, async (selected, uploadedFiles) => {
        log('Sources confirmed (' + selected.length + ' selected' + (uploadedFiles.length ? ', ' + uploadedFiles.length + ' file(s)' : '') + '). Firing 5 task AIs — synthesising on first 3 responses...', 'info');
        if (window.panel) window.panel.setTitle('Task AIs — responding…');

        // ── Live panel state (updated as SSE events arrive) ────────────────
        const panelState = []; // { label, model, text, avgScore }
        let data2 = null;

        function refreshPanel(gate2Status) {
          if (!window.panel) return;
          const g2Preview = gate2Status || { passed: false, avgScore: 0, iterations: 0 };
          window.panel.update(buildPanelContent(panelState, g2Preview));
        }

        const ticker2 = startTicker(pid, 'task AIs answering');

        try {
          await streamStep2(
            { query, query_id: data1.query_id, consensus_prompt: data1.consensus_prompt,
              selected_sources: selected, uploaded_files: uploadedFiles },
            (event) => {
              switch (event.type) {
                case 'start':
                  log(event.message, 'info');
                  break;
                case 'ai_response':
                  stopTicker(ticker2); // first response = stop "answering" ticker
                  log(event.label + ' responded [' + event.model + '] (' + event.count + '/' + 5 + ')', 'ok');
                  panelState.push({ label: event.label, model: event.model, text: event.text, avgScore: 0 });
                  refreshPanel();
                  break;
                case 'race_complete':
                  log(event.message, 'info');
                  break;
                case 'eval_score': {
                  const entry = panelState.find(a => a.label === event.label);
                  if (entry) entry.avgScore = event.avgScore;
                  log(event.label + ' scored ' + event.avgScore.toFixed(0) + '/100', 'info');
                  refreshPanel();
                  break;
                }
                case 'synthesis_start':
                  log(event.message, 'info');
                  break;
                case 'synthesis_done':
                  log('Synthesis complete', 'ok');
                  break;
                case 'gate2_start':
                  log(event.message, 'info');
                  break;
                case 'gate2_result':
                  log('Gate 2 ' + (event.passed ? 'passed' : 'failed') + ' — ' + event.avgScore.toFixed(0) + '/100 avg, ' + event.iterations + ' iter', event.passed ? 'ok' : 'warn');
                  refreshPanel({ passed: event.passed, avgScore: event.avgScore, iterations: event.iterations });
                  break;
                case 'answer':
                  data2 = {
                    answer:       event.answer,
                    citations:    event.citations,
                    alternatives: event.alternatives || [],
                    gate2:        event.gate2,
                    scores:       event.scores,
                    answers:      event.answers
                  };
                  // Final panel population with full scored answers
                  if (window.panel && event.answers) {
                    window.panel.open('Task AI Responses', buildPanelContent(event.answers, event.gate2), 'html');
                  }
                  break;
                case 'error':
                  log('Stream error: ' + event.message, 'err');
                  break;
              }
            }
          );
        } catch (err) {
          stopTicker(ticker2);
          log('Step 2 error: ' + err.message, 'err');
          resolve();
          return;
        }
        stopTicker(ticker2);

        if (!data2) { log('No answer received — check server logs', 'err'); resolve(); return; }

        const g2 = data2.gate2;

        // ── Gate 2 failed -- restart or show alternatives ─────────────────
        if (!g2.passed) {
          if (cycleCount < ORCH_MAX_CYCLES) {
            log('Gate 2 consensus failed — restarting from Gate 1...', 'warn');
            resolve(runCycle()); // next cycle
            return;
          }
          // Max cycles reached -- show best alternatives and stop
          log('Max cycles (' + ORCH_MAX_CYCLES + ') reached. Showing best alternative answers.', 'warn');
          if (g2.alternatives && g2.alternatives.length > 0) {
            const altPanel = buildAlternativeAnswersPanel(g2.alternatives);
            container.appendChild(altPanel);
            chatPanel.scrollTop = chatPanel.scrollHeight;
          }
          resolve();
          return;
        }

        // ── Gate 2 passed -- populate right panel then render answer ─────────
        if (window.panel && data2.answers && data2.answers.length > 0) {
          window.panel.open('Task AI Responses', buildPanelContent(data2.answers, g2), 'html');
        }
        const answerCard = buildAnswerCard(data2.answer, data2.citations, g2, data2.scores);
        container.appendChild(answerCard);
        chatPanel.scrollTop = chatPanel.scrollHeight;

        // ── Decision Point 3: Accept / Reject ────────────────────────────
        const dpRow = document.createElement('div');
        dpRow.style.cssText = 'display:flex;gap:8px;margin-top:8px;';

        const acceptBtn = document.createElement('button');
        acceptBtn.textContent = '✓ Accept';
        acceptBtn.style.cssText = 'background:var(--green);color:#fff;border:none;border-radius:4px;padding:5px 12px;cursor:pointer;font-size:12px;';

        const rejectBtn = document.createElement('button');
        rejectBtn.textContent = '✗ Reject & refine';
        rejectBtn.style.cssText = 'background:transparent;color:var(--red);border:1px solid var(--red);border-radius:4px;padding:5px 12px;cursor:pointer;font-size:12px;';

        acceptBtn.onclick = () => { dpRow.remove(); log('Answer accepted.', 'ok'); };
        rejectBtn.onclick = () => {
          dpRow.remove();
          const fb = prompt('What was wrong? Your feedback becomes a new query:');
          if (fb) {
            document.getElementById('input').value = 'Orch: ' + fb;
            document.getElementById('input').focus();
          }
        };

        dpRow.appendChild(acceptBtn);
        dpRow.appendChild(rejectBtn);
        container.appendChild(dpRow);
        chatPanel.scrollTop = chatPanel.scrollHeight;
        resolve();
      });

      container.appendChild(card);
      chatPanel.scrollTop = chatPanel.scrollHeight;
    });
  }

  // ── Kick off first cycle ──────────────────────────────────────────────────
  try {
    await runCycle();
  } catch (err) {
    log('Orchestration error: ' + err.message, 'err');
  }
};
