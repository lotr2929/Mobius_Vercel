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

// ── Mobius mode (User vs Dev) ─────────────────────────────────────────────────
// Persisted in localStorage. Default is 'user' -- simple chat experience with
// auto-advance, no gates, clean prose synthesis, no pinging status messages.
// Dev Mode shows the full pipeline: source card, prompt approval, preview panel,
// eval card with Accept/Redo. Toggle by clicking the "Mobius_PWA" logo/title.
function getMobiusMode() {
  try { return localStorage.getItem('mobius_mode') === 'dev' ? 'dev' : 'user'; } catch { return 'user'; }
}

function setMobiusMode(mode) {
  try { localStorage.setItem('mobius_mode', mode === 'dev' ? 'dev' : 'user'); } catch {}
}

// Client-formatted current date in the user's local timezone. Sent to the server
// with every orchestrate request so Task AIs know exactly what "today" means --
// no more [Current Date/Time] placeholder ambiguity across models.
function todayFormatted() {
  return new Date().toLocaleDateString('en-GB', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });
}

// Perth-style short time -- e.g. "4:35pm" -- stamped on every Mobius response.
function timestampStr() {
  const d = new Date();
  let h   = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  const ampm = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return h + ':' + m + ampm;
}

// Expose for other scripts and for manual toggling from DevTools
window.getMobiusMode  = getMobiusMode;
window.setMobiusMode  = setMobiusMode;
window.timestampStr   = timestampStr;

// Inject the Mode toggle INTO the logo title. Default (User Mode) shows
// "Mobius_PWA". Dev Mode shows "Mobius_PWA[Dev]" where [Dev] is a small
// superscript at 40% height. Click the whole title to toggle.
(function initModeToggle() {
  function install() {
    // Remove any old standalone button from an earlier deploy
    const oldBtn = document.getElementById('mobius-mode-toggle');
    if (oldBtn) oldBtn.remove();

    const h1 = document.querySelector('#header h1');
    if (!h1) {
      console.warn('[Mobius] #header h1 not found -- Mode toggle will not render');
      return;
    }

    h1.style.cursor = 'pointer';
    h1.title = 'Click to switch between User (simple chat) and Dev (full pipeline) modes';

    let devSuffix = h1.querySelector('.mode-dev-suffix');
    if (!devSuffix) {
      devSuffix = document.createElement('span');
      devSuffix.className = 'mode-dev-suffix';
      devSuffix.textContent = '[Dev]';
      devSuffix.style.cssText = 'font-size:40%;vertical-align:top;opacity:0.7;margin-left:3px;font-weight:normal;';
      h1.appendChild(devSuffix);
    }

    const render = () => {
      devSuffix.style.display = (getMobiusMode() === 'dev') ? 'inline' : 'none';
    };

    h1.onclick = () => {
      setMobiusMode(getMobiusMode() === 'user' ? 'dev' : 'user');
      render();
    };
    render();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
  else install();
})();

// Greeting banner: shown on first load in User Mode when the chat panel is empty.
// Uses the chat-query class so it visually matches the format of a user's own
// messages -- bold and prominent. Picks a time-appropriate opener from a roster
// of friendly, conversational lines (never fires on mode toggle mid-conversation).
(function initGreeting() {
  function install() {
    if (getMobiusMode() !== 'user') return;
    const panel = document.getElementById('chatPanel');
    if (!panel) return;
    // Remove any startupPanel the connectivity script may have left behind
    const leftover = document.getElementById('startupPanel');
    if (leftover) leftover.remove();
    if (panel.children.length > 0) return;

    const hour = new Date().getHours();
    const bucket =
      hour < 5  ? 'late'      :
      hour < 12 ? 'morning'   :
      hour < 17 ? 'afternoon' :
      hour < 22 ? 'evening'   : 'late';

    const greetings = {
      morning: [
        'Good morning. Ready when you are.',
        "Morning. What's on your mind?",
        'Good morning. Where shall we start?',
        'Morning. What can I help you with?',
        'Good morning. What would you like to look into?'
      ],
      afternoon: [
        'Good afternoon. How can I help?',
        'Good afternoon. What would you like to explore?',
        "Afternoon. What's on your mind?",
        'Hi there. What can I dig into for you?',
        'Good afternoon. Ready when you are.'
      ],
      evening: [
        'Good evening. What can I help you find?',
        "Evening. What's on your mind?",
        'Hi there. How can I help tonight?',
        'Good evening. Where shall we start?',
        'Good evening. Ready when you are.'
      ],
      late: [
        'Still at it? Happy to help.',
        "Burning the midnight oil? What's up?",
        "Late night — what's on your mind?",
        'Hi. What can I dig into for you?',
        'Still going? What shall we look at?'
      ]
    };

    const pool = greetings[bucket];
    const msg  = pool[Math.floor(Math.random() * pool.length)];

    const entry = document.createElement('div');
    entry.className = 'chat-entry';

    const greeting = document.createElement('div');
    greeting.className = 'chat-query';
    greeting.textContent = msg;
    entry.appendChild(greeting);

    const ts = document.createElement('div');
    ts.style.cssText = 'font-size:10px;color:var(--text-dim);margin-top:2px;';
    ts.textContent = timestampStr();
    entry.appendChild(ts);

    panel.appendChild(entry);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
  else install();
})();

// Friendly, human thinking indicator for User Mode. Picks 3 random phrases
// from the pool and rotates through them every 6 seconds while Mobius works.
// Replaces the impersonal "⋯" ticker from Dev Mode.
const USER_MODE_THINKING_PHRASES = [
  'Let me think about this…',
  'Looking into it…',
  'Gathering my thoughts…',
  'Reading through what I\'ve found…',
  'Putting this together…',
  'Just a moment…',
  'Checking the details…',
  'Working on it…',
  'Digging in…',
  'Sifting through the sources…',
  'Weighing things up…',
  'Almost there…'
];

function startUserModeTicker(elId) {
  const el = document.getElementById(elId);
  if (!el) return null;
  // Pick 3 distinct phrases and cycle through them
  const shuffled = USER_MODE_THINKING_PHRASES.slice().sort(() => Math.random() - 0.5);
  const queue    = shuffled.slice(0, 3);

  const ticker = document.createElement('div');
  ticker.style.cssText = 'font-size:13px;padding:8px 0 4px 0;color:var(--text-muted);font-style:italic;';
  ticker.textContent = queue[0];
  el.appendChild(ticker);

  let idx = 0;
  const id = setInterval(() => {
    idx = (idx + 1) % queue.length;
    ticker.textContent = queue[idx];
    el.scrollIntoView({ block: 'nearest' });
  }, 6000);

  return { id, ticker };
}

// Render "Sources" block (top 5) + timestamp + thumbs rating under a User Mode answer.
function renderUserModeMeta(container, selectedSources) {
  const srcs = (selectedSources || []).slice(0, 5);
  if (srcs.length > 0) {
    const refs = document.createElement('div');
    refs.style.cssText = 'margin-top:14px;padding-top:8px;border-top:1px solid var(--border);font-size:11px;color:var(--text-dim);';
    const h = document.createElement('div');
    h.style.cssText = 'font-weight:bold;margin-bottom:4px;color:var(--text-muted);';
    h.textContent = 'Sources';
    refs.appendChild(h);
    srcs.forEach((s, i) => {
      const row = document.createElement('div');
      row.style.cssText = 'margin:2px 0;line-height:1.4;';
      const title = String(s.title || s.url).slice(0, 90);
      row.innerHTML = (i + 1) + '. <a href="' + s.url + '" target="_blank" rel="noopener" style="color:var(--accent2);text-decoration:none;">' + title.replace(/</g, '&lt;') + '</a>';
      refs.appendChild(row);
    });
    container.appendChild(refs);
  }

  // Bottom row: timestamp (left) + thumbs (right)
  const metaRow = document.createElement('div');
  metaRow.style.cssText = 'margin-top:10px;display:flex;align-items:center;justify-content:space-between;';

  const ts = document.createElement('div');
  ts.style.cssText = 'font-size:10px;color:var(--text-dim);';
  ts.textContent = timestampStr();
  metaRow.appendChild(ts);

  const rating = document.createElement('div');
  rating.style.cssText = 'display:flex;gap:4px;';
  let chosen = null;
  const mk = (emoji, vote, tip) => {
    const b = document.createElement('button');
    b.textContent = emoji;
    b.title = tip;
    b.style.cssText = 'background:transparent;border:1px solid transparent;border-radius:3px;padding:2px 8px;cursor:pointer;font-size:14px;line-height:1;transition:all 0.15s;';
    b.onmouseenter = () => { if (!chosen) b.style.background = 'var(--surface2)'; };
    b.onmouseleave = () => { if (!chosen) b.style.background = 'transparent'; };
    b.onclick = () => {
      if (chosen) return;
      chosen = vote;
      b.style.background    = 'var(--surface2)';
      b.style.borderColor   = 'var(--accent2)';
      console.log('[Mobius rating]', vote);
      // TODO: POST to /rate endpoint once implemented (ratings table is a follow-up)
    };
    return b;
  };
  rating.appendChild(mk('👍', 'up',   'Helpful'));
  rating.appendChild(mk('👎', 'down', 'Not helpful'));
  metaRow.appendChild(rating);
  container.appendChild(metaRow);
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
    // Bulk actions: Select all / Top 5 / Clear
    const bulkRow = document.createElement('div');
    bulkRow.style.cssText = 'display:flex;gap:6px;margin-bottom:6px;';
    const mkBulkBtn = (label, handler) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = 'background:transparent;border:1px solid var(--border);color:var(--text-dim);border-radius:3px;padding:2px 10px;cursor:pointer;font-size:11px;font-family:var(--font);';
      b.onclick = (e) => { e.preventDefault(); handler(); };
      return b;
    };
    bulkRow.appendChild(mkBulkBtn('Select all', () => checkboxes.forEach(x => x.cb.checked = true)));
    bulkRow.appendChild(mkBulkBtn('Top 5',      () => checkboxes.forEach((x, i) => x.cb.checked = i < 5)));
    bulkRow.appendChild(mkBulkBtn('Clear',      () => checkboxes.forEach(x => x.cb.checked = false)));
    card.appendChild(bulkRow);

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
  heading.textContent = 'Synthesised Sub-Questions — review before executing';
  card.appendChild(heading);

  const hint = document.createElement('div');
  hint.style.cssText = 'font-size:11px;color:var(--text-dim);margin-bottom:8px;';
  hint.textContent = 'Mobius converted your query into 4-5 specific sub-questions that the Task AIs will answer using the selected sources. Edit if needed, then approve.';
  card.appendChild(hint);

  // Editable prompt
  const textarea = document.createElement('textarea');
  textarea.value = synthesisedPrompt;
  textarea.style.cssText = [
    'width:100%', 'min-height:140px', 'max-height:320px',
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

  // Mode gate: 'user' hides panels + gates, 'dev' shows everything (default)
  const userMode = getMobiusMode() === 'user';

  // Open right panel with placeholder immediately (Dev Mode only -- User Mode
  // keeps the interface single-panel for a ChatGPT-like feel)
  if (!userMode && window.panel) window.panel.open('Mobius — Task AI Suggestions', '<div style="padding:20px 14px;font-size:12px;color:var(--text-dim);">◌ Generating prompt suggestions…</div>', 'html');

  // ── STEP 1: Prompt suggestions + source discovery ──────────────────────────
  async function runStep1(feedback) {
    if (!userMode) log('Step 1 — generating prompt suggestions and searching for sources…');
    const ticker = userMode
      ? startUserModeTicker(pid)
      : startTicker(pid, 'Task AIs rewriting prompt');
    let data1;
    try {
      const res = await fetch('/orchestrate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ step: 1, query, feedback: feedback || '', today: todayFormatted() })
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      data1 = await res.json();
    } catch (err) {
      stopTicker(ticker);
      log(userMode ? 'Something went wrong.' : ('Step 1 error: ' + err.message), 'err');
      return;
    }
    stopTicker(ticker);

    const suggestions = data1.suggestions || [];
    const sources     = data1.sources     || [];

    if (!userMode) {
      log(suggestions.length + ' prompt suggestions received', 'ok');
      if (sources.length > 0) log(sources.length + ' sources found', 'ok');
      else log('No sources found — you can add URLs manually', 'warn');

      // Right panel: show all 5 prompt suggestions (Dev Mode only)
      if (window.panel) {
        window.panel.open('Task AI Prompt Suggestions', buildSuggestionsPanel(suggestions), 'html');
      }
    }

    // User Mode: auto-pass ALL available sources (up to 20) to Task AIs, auto-approve prompt, proceed silently
    if (userMode) {
      const autoSources = sources.slice(0, 20);
      return runStep2(data1.query_id, data1.synthesised_prompt || query, autoSources);
    }

    // Dev Mode: show source card → prompt approval card
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
    if (!userMode) log('Step 2 — firing 5 Task AIs…');

    // Right panel: reset to "answers" mode with placeholder (Dev Mode only)
    if (!userMode && window.panel) {
      window.panel.open('Task AI Answers', '<div style="padding:20px 14px;font-size:12px;color:var(--text-dim);">◌ Task AIs answering…</div>', 'html');
    }

    // Thinking indicator: Dev Mode shows a labelled "⋯ Task AIs answering (Ns)"
    // ticker, User Mode cycles through 3 random friendly phrases every 6s.
    const ticker = userMode
      ? startUserModeTicker(pid)
      : startTicker(pid, 'Task AIs answering');
    const panelAnswers = [];

    try {
      await streamStep2(
        {
          query, query_id: queryId,
          approved_prompt: approvedPrompt,
          selected_sources: selectedSources,
          today: todayFormatted(),
          mode:  userMode ? 'user' : 'dev'
        },
        (event) => {
          switch (event.type) {
            case 'start':
              if (!userMode) log(event.message, 'info');
              break;

            case 'ai_response':
              // User Mode collects silently; Dev Mode logs + streams to right panel
              panelAnswers.push({ label: event.label, model: event.model, text: event.text });
              if (!userMode) {
                stopTicker(ticker);
                log(event.label + ' responded [' + event.model + '] (' + event.count + '/' + event.total + ')', 'ok');
                if (window.panel) window.panel.open('Task AI Answers', buildAnswersPanel(panelAnswers, true), 'html');
              }
              break;

            case 'race_complete':
              if (!userMode) log(event.message, 'info');
              break;

            case 'eval_start':
              if (!userMode) log(event.message, 'info');
              break;

            case 'summary':
              if (!userMode && window.panel && event.scores) {
                const scored = panelAnswers.map((a, i) => ({
                  ...a, avgScore: event.scores[i] ? event.scores[i].score.total : null
                }));
                window.panel.open('Task AI Answers', buildAnswersPanel(scored, false), 'html');
              }
              break;

            case 'complete': {
              stopTicker(ticker);

              if (userMode) {
                // User Mode: render the clean prose synthesis (user_answer).
                // Fall back to evaluation.summary only if server failed to produce user_answer.
                const md = window.markdownToHtml || (t => '<div style="white-space:pre-wrap">' + String(t).replace(/</g, '&lt;') + '</div>');
                const answerText = event.user_answer || event.evaluation?.summary || 'No answer available.';

                const answerEl = document.createElement('div');
                answerEl.className = 'chat-answer html-content';
                answerEl.style.cssText = 'margin-top:10px;font-size:13px;line-height:1.55;';
                answerEl.innerHTML = md(answerText);
                container.appendChild(answerEl);

                // Sources (top 5), timestamp, thumbs up/down
                renderUserModeMeta(container, selectedSources);

                chatPanel.scrollTop = chatPanel.scrollHeight;
              } else {
                // Dev Mode: populate right panel + show eval card with Accept/Redo
                if (window.panel && event.answers) {
                  const scored = event.answers.map((a, i) => ({
                    ...a, avgScore: event.evaluation?.scores?.[i]?.score?.total || null
                  }));
                  window.panel.open('Task AI Answers', buildAnswersPanel(scored, false), 'html');
                }
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
              }
              break;
            }

            case 'error':
              stopTicker(ticker);
              log(userMode ? 'Something went wrong.' : ('Error: ' + event.message), 'err');
              break;
          }
        }
      );
    } catch (err) {
      stopTicker(ticker);
      log(userMode ? 'Something went wrong.' : ('Step 2 error: ' + err.message), 'err');
    }
  }

  // ── Kick off ───────────────────────────────────────────────────────────────
  try {
    await runStep1('');
  } catch (err) {
    log('Orchestration error: ' + err.message, 'err');
  }
};
