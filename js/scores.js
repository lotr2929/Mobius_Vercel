// ── js/scores.js ──────────────────────────────────────────────────────────────
// Model score tracking for Ask: All voting.
// Scores stored in localStorage under 'mobius-scores'.
// Public API: window.Scores.recordWin(modelKey, category)
//             window.Scores.recordLoss(modelKey, category)
//             window.Scores.getLeaderboard(category)
//             window.Scores.clear()
// Command: Ask: Scores [category] -- show leaderboard in panel
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  const STORE_KEY = 'mobius-scores';

  const MODEL_LABELS = {
    'gemini-cascade':     'Gemini 2.5 Flash',
    'groq-cascade':       'Groq Llama 3.3 70B',
    'mistral-cascade':    'Codestral',
    'cerebras-cascade':   'Cerebras',
    'openrouter-cascade': 'OpenRouter',
  };

  const ALL_CATEGORIES = ['Write', 'Fix', 'Understand', 'Debug', 'Plan', 'Brief', 'General'];

  // ── Storage ────────────────────────────────────────────────────────────────

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  }

  function save(data) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(data)); } catch { /* quota */ }
  }

  function recordVote(modelKey, category, type) {
    const data = load();
    const cat  = category || 'General';
    if (!data[cat])           data[cat] = {};
    if (!data[cat][modelKey]) data[cat][modelKey] = { wins: 0, losses: 0, latencies: [] };
    if (type === 'win')  data[cat][modelKey].wins++;
    else                 data[cat][modelKey].losses++;
    save(data);
  }

  function recordLatency(modelKey, ms) {
    const data = load();
    const cat  = 'General';
    if (!data[cat])           data[cat] = {};
    if (!data[cat][modelKey]) data[cat][modelKey] = { wins: 0, losses: 0, latencies: [] };
    const lats = data[cat][modelKey].latencies || [];
    lats.push(ms);
    if (lats.length > 20) lats.splice(0, lats.length - 20); // keep last 20
    data[cat][modelKey].latencies = lats;
    save(data);
  }

  function getAvgLatency(modelKey) {
    const data = load();
    const lats = [];
    for (const cat of Object.keys(data)) {
      const entry = data[cat][modelKey];
      if (entry && entry.latencies) lats.push(...entry.latencies);
    }
    if (!lats.length) return null;
    return Math.round(lats.reduce((a, b) => a + b, 0) / lats.length);
  }

  function getLeaderboard(category) {
    const data = load();
    const keys = Object.keys(MODEL_LABELS);

    if (category && category !== 'All') {
      const catData = data[category] || {};
      return keys.map(k => ({
        key:    k,
        name:   MODEL_LABELS[k] || k,
        wins:   (catData[k] || {}).wins   || 0,
        losses: (catData[k] || {}).losses || 0,
      })).sort((a, b) => b.wins - a.wins || a.losses - b.losses);
    }

    // Aggregate across all categories
    return keys.map(k => {
      let wins = 0, losses = 0;
      for (const c of Object.keys(data)) {
        wins   += (data[c][k] || {}).wins   || 0;
        losses += (data[c][k] || {}).losses || 0;
      }
      return { key: k, name: MODEL_LABELS[k] || k, wins, losses };
    }).sort((a, b) => b.wins - a.wins || a.losses - b.losses);
  }

  // ── Leaderboard renderer ───────────────────────────────────────────────────

  function renderLeaderboard(board, title, total) {
    let html = '<div style="font-weight:bold;font-size:14px;margin-bottom:10px;">' + title + '</div>';

    for (const m of board) {
      const scored = m.wins + m.losses;
      const pct    = scored > 0 ? Math.round(m.wins / scored * 100) : 0;
      const bar    = Math.min(100, pct);
      html += '<div style="padding:6px 0;border-bottom:1px solid var(--border);">'
        + '<div style="display:flex;align-items:baseline;gap:8px;margin-bottom:4px;">'
        + '<span style="flex:1;font-size:13px;font-weight:bold;">' + m.name + '</span>'
        + '<span style="color:#4a7c4e;font-size:12px;">' + m.wins + 'W</span>'
        + '<span style="color:#8d3a3a;font-size:12px;margin-left:4px;">' + m.losses + 'L</span>'
        + '<span style="color:var(--text-dim);font-size:11px;margin-left:6px;min-width:28px;text-align:right;">'
        + (scored > 0 ? pct + '%' : '--') + '</span>'
        + (() => { const avg = getAvgLatency(m.key); return avg ? '<span style="color:var(--text-dim);font-size:11px;margin-left:6px;">' + (avg >= 1000 ? (avg/1000).toFixed(1) + 's' : avg + 'ms') + '</span>' : ''; })()
        + '</div>'
        + '<div style="height:4px;background:var(--border);border-radius:2px;overflow:hidden;">'
        + '<div style="height:100%;background:#4a7c4e;width:' + bar + '%;border-radius:2px;"></div>'
        + '</div>'
        + '</div>';
    }

    if (total > 0) {
      html += '<div style="font-size:11px;color:var(--text-dim);margin-top:8px;">'
        + total + ' total votes recorded</div>';
    }

    return html;
  }

  // ── Ask: Scores handler ────────────────────────────────────────────────────

  async function handleAskScores(args, output, outputEl) {
    const data = load();

    if (Object.keys(data).length === 0) {
      output('No votes recorded yet.\nUse Ask: All to compare models and cast votes.');
      return;
    }

    const cat   = args.trim() || 'All';
    const board = getLeaderboard(cat === 'All' ? null : cat);
    const total = board.reduce((s, m) => s + m.wins + m.losses, 0);

    // Category breakdown section
    const activeCats = ALL_CATEGORIES.filter(c => data[c]);

    let html = renderLeaderboard(board, 'Model Scores -- ' + cat, total);

    // Per-category breakdown if showing All
    if (cat === 'All' && activeCats.length > 1) {
      html += '<div style="font-size:11px;color:var(--text-dim);text-transform:uppercase;'
        + 'letter-spacing:0.08em;margin:14px 0 6px;">Breakdown by category</div>';

      for (const c of activeCats) {
        const cBoard = getLeaderboard(c);
        const leader = cBoard[0];
        if (!leader || leader.wins + leader.losses === 0) continue;
        html += '<div style="font-size:13px;padding:3px 0;border-bottom:1px solid var(--border);'
          + 'display:flex;gap:8px;">'
          + '<span style="min-width:90px;color:var(--text-muted);">' + c + '</span>'
          + '<span style="color:var(--text);">' + leader.name + '</span>'
          + '<span style="color:#4a7c4e;margin-left:auto;">' + leader.wins + 'W / ' + leader.losses + 'L</span>'
          + '</div>';
      }
    }

    // Show available categories as filter hints
    if (activeCats.length > 0) {
      html += '<div style="font-size:11px;color:var(--text-dim);margin-top:10px;">'
        + 'Filter by category: '
        + activeCats.map(c => '<code>Ask: Scores ' + c + '</code>').join(' &nbsp; ')
        + '</div>';
    }

    if (window.panel) {
      window.panel.open('Scores', html, 'html');
      output('Scores loaded -- see panel');
    } else {
      outputEl.classList.add('html-content');
      outputEl.innerHTML = html;
    }
    document.getElementById('input').value = '';
  }

  // ── Self-register ──────────────────────────────────────────────────────────

  function register() {
    if (!window.COMMANDS) { setTimeout(register, 50); return; }
    window.COMMANDS['ask: scores'] = {
      handler: handleAskScores,
      family:  'ask',
      desc:    'Model win/loss leaderboard by category'
    };
  }
  register();

  // ── Public API ─────────────────────────────────────────────────────────────
  window.Scores = {
    recordWin:      (key, cat) => recordVote(key, cat, 'win'),
    recordLoss:     (key, cat) => recordVote(key, cat, 'loss'),
    recordLatency:  (key, ms)  => recordLatency(key, ms),
    getAvgLatency:  (key)      => getAvgLatency(key),
    getLeaderboard: (cat)      => getLeaderboard(cat),
    clear:          ()         => { try { localStorage.removeItem(STORE_KEY); } catch {} },
    ALL_CATEGORIES
  };

})();
