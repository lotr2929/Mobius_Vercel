// js/orchestrator.js
// Mobius orchestration UI.
//
// Protocol:
//   Step 1  -- 5 Task AIs suggest prompt rewrites (parallel with source search)
//              Right panel: all 5 suggestions
//              Left panel:  source card -> synthesised prompt -> Approve / Edit / Redo
//   Step 2  -- 5 Task AIs answer with approved prompt + selected sources
//              Right panel: answers stream in as each AI responds
//              Left panel:  annotated evaluation summary -> Accept / Edit prompt & redo
//
// Panel discipline:
//   LEFT  (chat)    -- Boon's input, Mobius status/decisions, cards, summaries
//   RIGHT (preview) -- Task AI prompt suggestions and Task AI answers (all content)

'use strict';

// ── Utilities ─────────────────────────────────────────────────────────────────

function orchLog(pid, message, type = 'info') {
  const el = document.getElementById(pid);
  if (!el) return;
  const colours = { info: 'var(--text-dim)', ok: 'var(--green)', warn: '#b8860b', err: 'var(--red)' };
  const icons   = { info: '◌', ok: '✓', warn: '⚠', err: '✗' };
  const line    = document.createElement('div');
  line.style.cssText = 'font-size:12px;padding:2px 0;color:' + (colours[type] || colours.info);
  line.textContent   = icons[type] + ' ' + message;
  el.appendChild(line);
  el.scrollIntoView({ block: 'nearest' });
}

function startTicker(pid, phase) {
  const el = document.getElementById(pid);
  if (!el) return null;
  const start  = Date.now();
  const ticker = document.createElement('div');
  ticker.className  = 'orch-ticker';
  ticker.style.cssText = 'font-size:11px;padding:2px 0 2px 12px;color:var(--text-dim);font-style:italic;';
  el.appendChild(ticker);
  const id = setInterval(() => {
    const s = Math.floor((Date.now() - start) / 1000);
    ticker.textContent = '⋯ ' + phase + ' (' + s + 's)';
    el.scrollIntoView({ block: 'nearest' });
  }, 1000);
  return { id, ticker };
}

function stopTicker(h) {
  if (!h) return;
  clearInterval(h.id);
  if (h.ticker && h.ticker.parentNode) h.ticker.remove();
}

// SSE stream reader
async function streamStep2(body, onEvent) {
  const res = await fetch('/orchestrate/stream', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error('Stream returned HTTP ' + res.status);
  const reader  = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try { onEvent(JSON.parse(line.slice(6))); } catch { /* skip malformed */ }
      }
    }
  }
}

// ── Right panel builders ──────────────────────────────────────────────────────

function buildSuggestionsPanel(suggestions) {
  const md = window.markdownToHtml || (t => '<div style="white-space:pre-wrap">' + t.replace(/</g,'&lt;') + '</div>');
  let html = '<div style="padding:10px 14px;font-family:var(--font);">';
  html += '<div style="font-size:11px;color:var(--text-dim);margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid var(--border);">Task AI prompt suggestions — ' + suggestions.length + ' specialists</div>';
  suggestions.forEach((s, i) => {
    const timing = s.ms ? ' · ' + (s.ms / 1000).toFixed(1) + 's' : '';
    const failed = s.failed || !s.text;
    html += '<div style="margin-bottom:16px;padding-bottom:14px;border-bottom:1px solid var(--border);">';
    html += '<div style="font-size:11px;font-weight:bold;color:var(--text-dim);margin-bottom:4px;">'
      + (i + 1) + '. ' + s.label
      + '<span style="font-weight:normal;margin-left:6px;">[' + (s.model || s.id) + ']</span>'
      + (timing ? '<span style="color:var(--text-dim);margin-left:6px;">' + timing + '</span>' : '')
      + (failed ? '<span style="color:var(--red);margin-left:6px;">no response</span>' : '')
      + '</div>';
    if (!failed) {
      html += '<div style="font-size:13px;color:var(--text);line-height:1.5;padding:6px 8px;background:var(--surface2);border-radius:3px;font-style:italic;">'
        + s.text.replace(/</g,'&lt;').replace(/\n/g,'<br>') + '</div>';
    }
    html += '</div>';
  });
  html += '</div>';
  return html;
}

function buildAnswersPanel(answers, inProgress) {
  const md = window.markdownToHtml || (t => '<div style="white-space:pre-wrap">' + t.replace(/</g,'&lt;') + '</div>');
  let html = '<div style="padding:10px 14px;font-family:var(--font);">';
  html += '<div style="font-size:11px;color:var(--text-dim);margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid var(--border);">'
    + 'Task AI answers — ' + answers.length + ' received' + (inProgress ? ' (waiting for more…)' : '') + '</div>';
  answers.forEach((a, i) => {
    const score  = a.avgScore ? ' · ' + a.avgScore.toFixed(0) + '/100' : '';
    const timing = a.ms      ? ' · ' + (a.ms / 1000).toFixed(1) + 's' : '';
    html += '<div style="margin-bottom:16px;padding-bottom:14px;border-bottom:1px solid var(--border);">';
    html += '<div style="font-size:11px;font-weight:bold;color:var(--text-dim);margin-bottom:4px;">'
      + (i + 1) + '. ' + (a.label || 'AI ' + (i+1))
      + '<span style="font-weight:normal;margin-left:6px;">[' + (a.model || '') + ']</span>'
      + (timing ? '<span style="color:var(--text-dim);margin-left:4px;">' + timing + '</span>' : '')
      + (score  ? '<span style="color:var(--green);margin-left:4px;">' + score + '</span>' : '')
      + '</div>';
    html += '<div class="chat-answer" style="font-size:13px;">' + md(a.text || '') + '</div>';
    html += '</div>';
  });
  if (inProgress) {
    html += '<div style="font-size:12px;color:var(--text-dim);font-style:italic;padding:8px 0;">Waiting for remaining Task AIs…</div>';
  }
  html += '</div>';
  return html;
}

// ── Source selection card ─────────────────────────────────────────────────────

function buildSourceCard(sources, onConfirm) {
  const card = document.createElement('div');
  card.style.cssText = 'background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:12px 14px;margin:8px 0;font-size:13px;';

  const realSources  = (sources || []).filter(s => s.url && s.url !== 'no-search-available');
  const searchFailed = realSources.length === 0;

  const heading = document.createElement('div');
  heading.style.cssText = 'font-weight:bold;margin-bottom:8px;color:var(--text);font-size:13px;';
  heading.textContent = searchFailed
    ? 'Sources — Search unavailable'
    : 'Select sources (' + realSources.length + ' found)';
  card.appendChild(heading);

  const manualList = [];

  if (searchFailed) {
    const warn = document.createElement('div');
    warn.style.cssText = 'font-size:12px;color:#a06800;margin-bottom:10px;';
    warn.textContent = '⚠ Web search not yet configured. Paste URLs manually or skip.';
    card.appendChild(warn);
  }

  // Manual URL entry (available in both branches)
  const urlContainer = document.createElement('div');
  urlContainer.style.cssText = 'margin-bottom:8px;';
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
      row.appendChild(lbl); row.appendChild(del);
      urlContainer.appendChild(row);
    });
  }

  const inputRow = document.createElement('div');
  inputRow.style.cssText = 'display:flex;gap:6px;margin-bottom:8px;';
  const urlInput = document.createElement('input');
  urlInput.type = 'text'; urlInput.placeholder = 'Paste a URL...';
  urlInput.style.cssText = 'flex:1;font-size:12px;padding:4px 8px;border:1px solid var(--border);border-radius:3px;background:var(--surface);color:var(--text);font-family:var(--font);';
  const addBtn = document.createElement('button');
  addBtn.textContent = 'Add';
  addBtn.style.cssText = 'background:var(--accent);color:#fff;border:none;border-radius:3px;padding:4px 10px;cursor:pointer;font-size:12px;';
  addBtn.onclick = () => {
    const v = urlInput.value.trim();
    if (v && /^https?:\/\//.test(v)) { manualList.push(v); urlInput.value = ''; renderUrls(); }
    else { urlInput.style.border = '1px solid var(--red)'; setTimeout(() => { urlInput.style.border = '1px solid var(--border)'; }, 1500); }
  };
  urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addBtn.click(); } });
  inputRow.appendChild(urlInput); inputRow.appendChild(addBtn);
  card.appendChild(inputRow);

  // Checkboxes for discovered sources
  const checkboxes = [];
  if (!searchFailed) {
    const list = document.createElement('div');
    list.style.cssText = 'max-height:180px;overflow-y:auto;margin-bottom:8px;';
    realSources.forEach((src, i) => {
      const row = document.createElement('label');
      row.style.cssText = 'display:flex;align-items:flex-start;gap:8px;padding:4px 2px;cursor:pointer;border-bottom:1px solid var(--border);';
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = i < 5;
      cb.style.cssText = 'margin-top:3px;flex-shrink:0;';
      checkboxes.push({ cb, src });
      const txt = document.createElement('div');
      const title = document.createElement('div');
      title.style.cssText = 'font-size:12px;color:var(--text);';
      title.textContent = src.title || src.url;
      const url = document.createElement('div');
      url.style.cssText = 'font-size:10px;color:var(--text-dim);word-break:break-all;';
      url.textContent = src.url;
      txt.appendChild(title); txt.appendChild(url);
      row.appendChild(cb); row.appendChild(txt);
      list.appendChild(row);
    });
    card.appendChild(list);
  }

  const footer = document.createElement('div');
  footer.style.cssText = 'display:flex;gap:8px;margin-top:6px;';
  const contBtn = document.createElement('button');
  contBtn.textContent = 'Continue →';
  contBtn.style.cssText = 'background:var(--accent);color:#fff;border:none;border-radius:4px;padding:5px 14px;cursor:pointer;font-size:12px;';
  const skipBtn = document.createElement('button');
  skipBtn.textContent = 'Skip sources';
  skipBtn.style.cssText = 'background:transparent;color:var(--text-dim);border:1px solid var(--border);border-radius:4px;padding:5px 10px;cursor:pointer;font-size:12px;';
  contBtn.onclick = () => {
    const checked = checkboxes.filter(x => x.cb.checked).map(x => x.src);
    const manual  = manualList.map(url => ({ url, title: url, snippet: '' }));
    card.style.opacity = '0.5'; contBtn.disabled = true; skipBtn.disabled = true;
    onConfirm([...checked, ...manual]);
  };
  skipBtn.onclick = () => {
    card.style.opacity = '0.5'; contBtn.disabled = true; skipBtn.disabled = true;
    onConfirm([]);
  };
  footer.appendChild(contBtn); footer.appendChild(skipBtn);
  card.appendChild(footer);
  return card;
}

// ── Synthesised prompt approval card ─────────────────────────────────────────
// Shows the synthesised prompt in an editable textarea.
// Returns a Promise that resolves with { action: 'approve'|'redo', prompt, feedback }

function buildPromptApprovalCard(synthesisedPrompt, onDecision) {
  const card = document.createElement('div');
  card.style.cssText = 'background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:12px 14px;margin:8px 0;font-size:13px;';

  const heading = document.createElement('div');
  heading.style.cssText = 'font-weight:bold;margin-bottom:6px;color:var(--text);';
  heading.textContent = 'Synthesised Prompt — review before executing';
  card.appendChild(heading);

  const hint = document.createElement('div');
  hint.style.cssText = 'font-size:11px;color:var(--text-dim);margin-bottom:8px;';
  hint.textContent = 'Edit the prompt below if needed, then approve. Or ask the AIs to redo with your feedback.';
  card.appendChild(hint);

  // Editable prompt
  const textarea = document.createElement('textarea');
  textarea.value = synthesisedPrompt;
  textarea.style.cssText = [
    'width:100%', 'min-height:80px', 'max-height:200px',
    'font-size:13px', 'padding:8px', 'border:1px solid var(--border)',
    'border-radius:3px', 'background:var(--surface)', 'color:var(--text)',
    'font-family:var(--font)', 'resize:vertical', 'line-height:1.5',
    'box-sizing:border-box'
  ].join(';');
  card.appendChild(textarea);

  // Redo feedback input (hidden until Redo is clicked)
  const redoSection = document.createElement('div');
  redoSection.style.display = 'none';
  redoSection.style.cssText = 'margin-top:8px;';
  const redoLabel = document.createElement('div');
  redoLabel.style.cssText = 'font-size:11px;color:var(--text-dim);margin-bottom:4px;';
  redoLabel.textContent = 'Feedback for AIs (what to improve):';
  const redoInput = document.createElement('input');
  redoInput.type = 'text'; redoInput.placeholder = 'e.g. "Focus more on practical steps..."';
  redoInput.style.cssText = 'width:100%;font-size:12px;padding:5px 8px;border:1px solid var(--border);border-radius:3px;background:var(--surface);color:var(--text);font-family:var(--font);box-sizing:border-box;';
  redoSection.appendChild(redoLabel); redoSection.appendChild(redoInput);
  card.appendChild(redoSection);

  const footer = document.createElement('div');
  footer.style.cssText = 'display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;';

  const approveBtn = document.createElement('button');
  approveBtn.textContent = '✓ Approve & execute';
  approveBtn.style.cssText = 'background:var(--green);color:#fff;border:none;border-radius:4px;padding:6px 14px;cursor:pointer;font-size:12px;font-family:var(--font);';

  const redoBtn = document.createElement('button');
  redoBtn.textContent = '↩ Redo with AIs';
  redoBtn.style.cssText = 'background:transparent;color:var(--accent2);border:1px solid var(--border2);border-radius:4px;padding:6px 12px;cursor:pointer;font-size:12px;font-family:var(--font);';

  approveBtn.onclick = () => {
    const prompt = textarea.value.trim() || synthesisedPrompt;
    card.style.opacity = '0.5';
    approveBtn.disabled = true; redoBtn.disabled = true;
    onDecision({ action: 'approve', prompt });
  };

  redoBtn.onclick = () => {
    if (redoSection.style.display === 'none') {
      // First click: show feedback input
      redoSection.style.display = '';
      redoBtn.textContent = '↩ Send feedback & redo';
      redoInput.focus();
    } else {
      // Second click: submit
      card.style.opacity = '0.5';
      approveBtn.disabled = true; redoBtn.disabled = true;
      onDecision({ action: 'redo', feedback: redoInput.value.trim() });
    }
  };

  footer.appendChild(approveBtn); footer.appendChild(redoBtn);
  card.appendChild(footer);
  return card;
}

// ── Evaluation summary card ───────────────────────────────────────────────────
// Shows annotated summary + score table.
// Returns a Promise that resolves with { action: 'accept'|'redo', prompt? }

function buildEvalCard(summary, scores, approvedPrompt, onDecision) {
  const card = document.createElement('div');
  card.style.cssText = 'background:var(--surface2);border:1px solid var(--border);border-radius:6px;padding:12px 14px;margin:8px 0;font-size:13px;';

  const heading = document.createElement('div');
  heading.style.cssText = 'font-weight:bold;margin-bottom:8px;color:var(--text);';
  heading.textContent = 'Evaluation Summary';
  card.appendChild(heading);

  // Annotated summary text -- rendered as markdown
  const md = window.markdownToHtml || (t => '<div style="white-space:pre-wrap">' + t.replace(/</g,'&lt;') + '</div>');
  const summaryEl = document.createElement('div');
  summaryEl.className = 'chat-answer';
  summaryEl.style.cssText = 'font-size:13px;margin-bottom:10px;';
  summaryEl.innerHTML = md(summary).replace('<div class="chat-answer">', '<div>');
  card.appendChild(summaryEl);

  // Score table
  if (scores && scores.length > 0) {
    const scoreBar = document.createElement('div');
    scoreBar.style.cssText = 'font-size:11px;color:var(--text-dim);padding:6px 0;border-top:1px solid var(--border);border-bottom:1px solid var(--border);margin-bottom:10px;display:flex;flex-wrap:wrap;gap:8px;';
    scores.forEach(s => {
      const total = s.score ? s.score.total : (s.total || 0);
      const col   = total >= 80 ? '#4a7c4e' : total >= 65 ? '#a06800' : '#8d3a3a';
      const pill  = document.createElement('span');
      pill.style.cssText = 'white-space:nowrap;';
      pill.innerHTML = '<strong style="color:var(--text);">' + (s.label || s.model) + '</strong>'
        + ' <span style="color:' + col + ';">' + total + '/100</span>';
      if (s.score && s.score.note) {
        pill.title = s.score.note;
      }
      scoreBar.appendChild(pill);
    });
    card.appendChild(scoreBar);
  }

  // Edit prompt & redo section (hidden until button clicked)
  const redoSection = document.createElement('div');
  redoSection.style.display = 'none';
  redoSection.style.cssText = 'margin-bottom:10px;';
  const redoLabel = document.createElement('div');
  redoLabel.style.cssText = 'font-size:11px;color:var(--text-dim);margin-bottom:4px;';
  redoLabel.textContent = 'Edit the prompt to get better answers:';
  const redoTextarea = document.createElement('textarea');
  redoTextarea.value = approvedPrompt;
  redoTextarea.style.cssText = 'width:100%;min-height:70px;max-height:160px;font-size:12px;padding:6px 8px;border:1px solid var(--border);border-radius:3px;background:var(--surface);color:var(--text);font-family:var(--font);resize:vertical;line-height:1.4;box-sizing:border-box;margin-top:4px;';
  redoSection.appendChild(redoLabel); redoSection.appendChild(redoTextarea);
  card.appendChild(redoSection);

  const footer = document.createElement('div');
  footer.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;';

  const acceptBtn = document.createElement('button');
  acceptBtn.textContent = '✓ Accept';
  acceptBtn.style.cssText = 'background:var(--green);color:#fff;border:none;border-radius:4px;padding:5px 14px;cursor:pointer;font-size:12px;font-family:var(--font);';

  const redoBtn = document.createElement('button');
  redoBtn.textContent = '✎ Edit prompt & redo';
  redoBtn.style.cssText = 'background:transparent;color:var(--accent2);border:1px solid var(--border2);border-radius:4px;padding:5px 12px;cursor:pointer;font-size:12px;font-family:var(--font);';

  acceptBtn.onclick = () => {
    card.style.opacity = '0.5'; acceptBtn.disabled = true; redoBtn.disabled = true;
    onDecision({ action: 'accept' });
  };

  redoBtn.onclick = () => {
    if (redoSection.style.display === 'none') {
      redoSection.style.display = '';
      redoBtn.textContent = '↩ Resubmit with edited prompt';
      redoTextarea.focus();
    } else {
      const edited = redoTextarea.value.trim() || approvedPrompt;
      card.style.opacity = '0.5'; acceptBtn.disabled = true; redoBtn.disabled = true;
      onDecision({ action: 'redo', prompt: edited });
    }
  };

  footer.appendChild(acceptBtn); footer.appendChild(redoBtn);
  card.appendChild(footer);
  return card;
}

// ── Main orchestrator entry point ─────────────────────────────────────────────
// container  -- the mq-block div from handleAsk (left panel content area)
// chatPanel  -- the #chatPanel scrollable div
// Called by commands.js sendToLastModel

window.runOrchestrator = async function(query, chatPanel, reuseOutputEl) {

  // Set up left-panel container
  let container;
  if (reuseOutputEl) {
    container = reuseOutputEl;
    container.classList.add('html-content');
  } else {
    container = document.createElement('div');
    container.className = 'chat-entry html-content';
    const qLabel = document.createElement('div');
    qLabel.className = 'chat-query';
    qLabel.textContent = query;
    container.appendChild(qLabel);
    chatPanel.appendChild(container);
  }

  // Set model badge to show Brief AI during orchestration
  if (window.updateModelBadge) window.updateModelBadge('Groq: Llama 3.3 70B');

  // Progress log box
  const logBox = document.createElement('div');
  logBox.id = 'orch-log-' + Date.now();
  logBox.style.cssText = 'margin:6px 0;';
  container.appendChild(logBox);
  chatPanel.scrollTop = chatPanel.scrollHeight;

  const pid = logBox.id;
  const log = (msg, type) => orchLog(pid, msg, type);

  // Open right panel with placeholder immediately
  if (window.panel) window.panel.open('Mobius — Task AI Suggestions', '<div style="padding:20px 14px;font-size:12px;color:var(--text-dim);">◌ Generating prompt suggestions…</div>', 'html');

  // ── STEP 1: Prompt suggestions + source discovery ──────────────────────────
  async function runStep1(feedback) {
    log('Step 1 — generating prompt suggestions and searching for sources…');
    const ticker = startTicker(pid, 'Task AIs rewriting prompt');
    let data1;
    try {
      const res = await fetch('/orchestrate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ step: 1, query, feedback: feedback || '' })
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      data1 = await res.json();
    } catch (err) {
      stopTicker(ticker);
      log('Step 1 error: ' + err.message, 'err');
      return;
    }
    stopTicker(ticker);

    const suggestions = data1.suggestions || [];
    const sources     = data1.sources     || [];
    log(suggestions.length + ' prompt suggestions received', 'ok');
    if (sources.length > 0) log(sources.length + ' sources found', 'ok');
    else log('No sources found — you can add URLs manually', 'warn');

    // Right panel: show all 5 prompt suggestions
    if (window.panel) {
      window.panel.open('Task AI Prompt Suggestions', buildSuggestionsPanel(suggestions), 'html');
    }

    // Left panel: source card -> then prompt approval card
    return new Promise(resolve => {
      const sourceCard = buildSourceCard(sources, async (selectedSources) => {
        log('Sources confirmed (' + selectedSources.length + ' selected). Review synthesised prompt.', 'info');

        // Show synthesised prompt approval card
        const promptCard = buildPromptApprovalCard(data1.synthesised_prompt || query, async (decision) => {
          if (decision.action === 'redo') {
            log('Redoing prompt suggestions with your feedback…', 'warn');
            resolve(runStep1(decision.feedback));
          } else {
            log('Prompt approved. Executing with ' + selectedSources.length + ' source(s).', 'ok');
            resolve(runStep2(data1.query_id, decision.prompt, selectedSources));
          }
        });
        container.appendChild(promptCard);
        chatPanel.scrollTop = chatPanel.scrollHeight;
      });
      container.appendChild(sourceCard);
      chatPanel.scrollTop = chatPanel.scrollHeight;
    });
  }

  // ── STEP 2: Execution + evaluation ────────────────────────────────────────
  async function runStep2(queryId, approvedPrompt, selectedSources) {
    log('Step 2 — firing 5 Task AIs…');

    // Right panel: reset to "answers" mode with placeholder
    if (window.panel) {
      window.panel.open('Task AI Answers', '<div style="padding:20px 14px;font-size:12px;color:var(--text-dim);">◌ Task AIs answering…</div>', 'html');
    }

    const ticker = startTicker(pid, 'Task AIs answering');
    const panelAnswers = []; // accumulates as SSE events arrive

    try {
      await streamStep2(
        { query, query_id: queryId, approved_prompt: approvedPrompt, selected_sources: selectedSources },
        (event) => {
          switch (event.type) {
            case 'start':
              log(event.message, 'info');
              break;

            case 'ai_response':
              stopTicker(ticker);
              log(event.label + ' responded [' + event.model + '] (' + event.count + '/' + event.total + ')', 'ok');
              panelAnswers.push({ label: event.label, model: event.model, text: event.text });
              if (window.panel) window.panel.open('Task AI Answers', buildAnswersPanel(panelAnswers, true), 'html');
              break;

            case 'race_complete':
              log(event.message, 'info');
              break;

            case 'eval_start':
              log(event.message, 'info');
              break;

            case 'summary':
              // Update panel with scores
              if (window.panel && event.scores) {
                const scored = panelAnswers.map((a, i) => ({
                  ...a, avgScore: event.scores[i] ? event.scores[i].score.total : null
                }));
                window.panel.open('Task AI Answers', buildAnswersPanel(scored, false), 'html');
              }
              break;

            case 'complete': {
              stopTicker(ticker);
              // Final panel population
              if (window.panel && event.answers) {
                const scored = event.answers.map((a, i) => ({
                  ...a, avgScore: event.evaluation?.scores?.[i]?.score?.total || null
                }));
                window.panel.open('Task AI Answers', buildAnswersPanel(scored, false), 'html');
              }
              // Show eval card in left panel
              const evalCard = buildEvalCard(
                event.evaluation?.summary || 'No summary available.',
                event.evaluation?.scores  || [],
                approvedPrompt,
                (decision) => {
                  if (decision.action === 'redo') {
                    log('Rerunning with edited prompt…', 'warn');
                    runStep2(queryId, decision.prompt, selectedSources);
                  } else {
                    log('Accepted. Submit a new query when ready.', 'ok');
                  }
                }
              );
              container.appendChild(evalCard);
              chatPanel.scrollTop = chatPanel.scrollHeight;
              break;
            }

            case 'error':
              stopTicker(ticker);
              log('Error: ' + event.message, 'err');
              break;
          }
        }
      );
    } catch (err) {
      stopTicker(ticker);
      log('Step 2 error: ' + err.message, 'err');
    }
  }

  // ── Kick off ───────────────────────────────────────────────────────────────
  try {
    await runStep1('');
  } catch (err) {
    log('Orchestration error: ' + err.message, 'err');
  }
};
