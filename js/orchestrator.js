// js/orchestrator.js
// Handles the Orch: command -- routes through the 5-AI consensus pipeline.
// Flow: Gate 1 -> Gate 1.5 -> [user selects sources] -> Execution -> Gate 2

'use strict';

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

// ── Source selection card ─────────────────────────────────────────────────────
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

  const heading = document.createElement('div');
  heading.style.cssText = 'font-weight:bold;margin-bottom:8px;color:var(--text);';
  heading.textContent = 'Decision Point 2 — Select sources (' + sources.length + ' found):';
  card.appendChild(heading);

  const hint = document.createElement('div');
  hint.style.cssText = 'font-size:11px;color:var(--text-dim);margin-bottom:10px;';
  hint.textContent = 'Tick the sources you want the AIs to use. Recommended: 3-5.';
  card.appendChild(hint);

  const list = document.createElement('div');
  list.style.cssText = 'max-height:220px;overflow-y:auto;';

  const checkboxes = [];
  sources.forEach((src, i) => {
    const row = document.createElement('label');
    row.style.cssText = 'display:flex;align-items:flex-start;gap:8px;padding:5px 2px;cursor:pointer;border-bottom:1px solid var(--border);';
    const cb = document.createElement('input');
    cb.type    = 'checkbox';
    cb.checked = i < 5; // pre-tick first 5
    cb.style.cssText = 'margin-top:3px;flex-shrink:0;';
    checkboxes.push({ cb, src });
    const txt = document.createElement('span');
    const title = document.createElement('div');
    title.style.cssText = 'font-size:12px;color:var(--text);';
    title.textContent = src.title || src.url;
    const url = document.createElement('div');
    url.style.cssText = 'font-size:10px;color:var(--text-dim);word-break:break-all;';
    url.textContent = src.url !== 'no-search-available' ? src.url : '(model knowledge only)';
    txt.appendChild(title);
    txt.appendChild(url);
    row.appendChild(cb);
    row.appendChild(txt);
    list.appendChild(row);
  });
  card.appendChild(list);

  const footer = document.createElement('div');
  footer.style.cssText = 'display:flex;gap:8px;margin-top:10px;';

  const btn = document.createElement('button');
  btn.textContent = 'Continue with selected sources →';
  btn.style.cssText = [
    'background:var(--accent)',
    'color:#fff',
    'border:none',
    'border-radius:4px',
    'padding:6px 14px',
    'cursor:pointer',
    'font-size:12px'
  ].join(';');

  const skipBtn = document.createElement('button');
  skipBtn.textContent = 'Skip (no sources)';
  skipBtn.style.cssText = [
    'background:transparent',
    'color:var(--text-dim)',
    'border:1px solid var(--border)',
    'border-radius:4px',
    'padding:6px 10px',
    'cursor:pointer',
    'font-size:12px'
  ].join(';');

  btn.onclick = () => {
    const selected = checkboxes.filter(x => x.cb.checked).map(x => x.src);
    card.style.opacity = '0.5';
    btn.disabled = true; skipBtn.disabled = true;
    onConfirm(selected);
  };
  skipBtn.onclick = () => {
    card.style.opacity = '0.5';
    btn.disabled = true; skipBtn.disabled = true;
    onConfirm([]);
  };

  footer.appendChild(btn);
  footer.appendChild(skipBtn);
  card.appendChild(footer);
  return card;
}

// ── Answer display ────────────────────────────────────────────────────────────
function buildAnswerCard(answer, citations, gate2, scores) {
  const card = document.createElement('div');
  card.style.cssText = 'margin:8px 0;';

  // Gate 2 status badge
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

  // Answer text
  const answerEl = document.createElement('div');
  answerEl.className = 'mq-block';
  answerEl.textContent = answer;
  card.appendChild(answerEl);

  // Citations
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

  // Scores breakdown (collapsed by default)
  if (scores && scores.length > 0) {
    const toggle = document.createElement('div');
    toggle.style.cssText = 'font-size:10px;color:var(--text-dim);cursor:pointer;margin-top:8px;user-select:none;';
    toggle.textContent = '▸ Show AI scores';
    const scoreTable = document.createElement('div');
    scoreTable.style.display = 'none';
    scoreTable.style.cssText = 'margin-top:4px;font-size:10px;';
    scores.forEach(s => {
      const row = document.createElement('div');
      row.style.cssText = 'color:var(--text-muted);padding:1px 0;';
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
window.runOrchestrator = async function(query, chatPanel) {
  // Create a dedicated container for this orchestration run
  const container = document.createElement('div');
  container.className = 'chat-entry';
  container.style.cssText = 'border-left:3px solid var(--accent);padding-left:10px;';

  const queryLabel = document.createElement('div');
  queryLabel.className = 'chat-query';
  queryLabel.textContent = 'Orch: ' + query;
  container.appendChild(queryLabel);

  const progressBox = document.createElement('div');
  progressBox.id = 'orch-progress-' + Date.now();
  progressBox.style.cssText = 'margin:6px 0;';
  container.appendChild(progressBox);

  chatPanel.appendChild(container);
  chatPanel.scrollTop = chatPanel.scrollHeight;

  const pid = progressBox.id;
  const log = (msg, type) => orchProgress(pid, msg, type);

  try {
    // ── Step 1 ────────────────────────────────────────────────────────────────
    log('Gate 1 — generating consensus prompt...');
    const step1 = await fetch('/orchestrate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ step: 1, query })
    });
    if (!step1.ok) throw new Error('Step 1 failed: ' + step1.status);
    const data1 = await step1.json();

    const g1 = data1.gate1;
    log('Gate 1 ' + (g1.passed ? 'passed' : 'fallback') + ' — ' + g1.avgScore.toFixed(0) + '/100 avg, ' + g1.iterations + ' iteration(s)', g1.passed ? 'ok' : 'warn');
    log('Gate 1.5 — ' + (data1.gate15.passed ? 'source consensus reached' : 'partial sources') + ' (attempt ' + data1.gate15.attempt + ')', data1.gate15.passed ? 'ok' : 'warn');
    log('Found ' + (data1.sources || []).length + ' source(s). Awaiting your selection...');

    // ── Decision Point 2: Source selection ────────────────────────────────────
    const sources = data1.all_sources || data1.sources || [];
    await new Promise(resolve => {
      const card = buildSourceCard(sources, async (selected) => {
        log('Sources confirmed (' + selected.length + ' selected). Running execution...', 'info');

        try {
          // ── Step 2 ──────────────────────────────────────────────────────────
          const step2 = await fetch('/orchestrate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              step:             2,
              query,
              query_id:         data1.query_id,
              consensus_prompt: data1.consensus_prompt,
              selected_sources: selected
            })
          });
          if (!step2.ok) throw new Error('Step 2 failed: ' + step2.status);
          const data2 = await step2.json();

          const g2 = data2.gate2;
          log('Execution complete — ' + (data2.scores || []).length + ' AI answer(s) generated', 'ok');
          log('Gate 2 ' + (g2.passed ? 'passed' : 'fallback') + ' — ' + g2.avgScore.toFixed(0) + '/100 avg, ' + g2.iterations + ' iteration(s)', g2.passed ? 'ok' : 'warn');

          // Render answer
          const answerCard = buildAnswerCard(data2.answer, data2.citations, g2, data2.scores);
          container.appendChild(answerCard);
          chatPanel.scrollTop = chatPanel.scrollHeight;

          // Decision Point 3: Accept / Reject
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
            if (fb) { document.getElementById('input').value = 'Orch: ' + fb; document.getElementById('input').focus(); }
          };
          dpRow.appendChild(acceptBtn);
          dpRow.appendChild(rejectBtn);
          container.appendChild(dpRow);
          chatPanel.scrollTop = chatPanel.scrollHeight;

        } catch (err) {
          log('Step 2 error: ' + err.message, 'err');
        }
        resolve();
      });
      container.appendChild(card);
      chatPanel.scrollTop = chatPanel.scrollHeight;
    });

  } catch (err) {
    log('Orchestration error: ' + err.message, 'err');
  }
};
