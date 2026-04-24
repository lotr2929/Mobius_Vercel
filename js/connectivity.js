// ── js/connectivity.js ────────────────────────────────────────────────────────
// Startup self-check.
// PING DISABLED during development -- shows "mobius ready" immediately.
// To re-enable: set PING_ENABLED = true below.

const Connectivity = (() => {

    const PING_ENABLED = true;

    let panelEl = null;

    async function run() {
        const chatPanel = document.getElementById('chatPanel');
        if (!chatPanel) return;

        // Always show minimal ready line when ping is disabled
        if (!PING_ENABLED) {
            const el = document.createElement('div');
            el.id = 'startupPanel';
            el.style.cssText = 'font-size:12px;color:var(--text-dim);padding:4px 10px 8px;';
            el.textContent = 'Mobius ready \u2014 ' + new Date().toLocaleTimeString('en-AU', { hour:'numeric', minute:'2-digit', hour12:true });
            chatPanel.insertBefore(el, chatPanel.firstChild);
            return;
        }

        // Skip ping if already checked within 2 hours
        const COOLDOWN_MS = 2 * 60 * 60 * 1000;
        const lastCheck   = parseInt(localStorage.getItem('mc_connectivity_ts') || '0');
        if (Date.now() - lastCheck < COOLDOWN_MS) {
            const el = document.createElement('div');
            el.id = 'startupPanel';
            el.style.cssText = 'font-size:12px;color:var(--text-dim);padding:4px 10px 8px;';
            el.textContent = 'Mobius ready \u2014 ' + new Date().toLocaleTimeString('en-AU', { hour:'numeric', minute:'2-digit', hour12:true });
            chatPanel.insertBefore(el, chatPanel.firstChild);
            return;
        }
        localStorage.setItem('mc_connectivity_ts', String(Date.now()));

        panelEl = document.createElement('div');
        panelEl.id = 'startupPanel';
        panelEl.style.cssText = [
            'background:var(--surface)',
            'border:1px solid var(--border)',
            'border-radius:1px',
            'padding:10px 14px',
            'margin-bottom:16px',
            'font-size:13px',
            'font-family:var(--font)',
        ].join(';');

        const title = document.createElement('div');
        title.style.cssText = 'font-weight:bold;color:var(--text);margin-bottom:8px;cursor:pointer;display:flex;align-items:center;justify-content:space-between;';
        title.innerHTML = '<span>Mobius ready \u2014 ' + new Date().toLocaleTimeString('en-AU', { hour:'numeric', minute:'2-digit', hour12:true }) + '</span>'
            + '<span id="panelToggle" style="color:var(--text-dim);display:flex;align-items:center;">' + chevronUp() + '</span>';
        title.onclick = () => collapse();
        panelEl.appendChild(title);

        const rows = document.createElement('div');
        rows.id = 'startupRows';
        panelEl.appendChild(rows);

        chatPanel.insertBefore(panelEl, chatPanel.firstChild);

        const checks = [
            { key: 'network',  label: 'Network',    fn: checkNetwork  },
            { key: 'vercel',   label: 'Vercel API', fn: checkVercel   },
            { key: 'supabase', label: 'Supabase',   fn: checkSupabase },
            { key: 'cloud',    label: 'Cloud AI',   fn: checkCloudAI  },
        ];

        const rowEls = {};
        for (const c of checks) {
            const row = createRow(c.label, 'checking', []);
            rows.appendChild(row);
            rowEls[c.key] = row;
        }

        const results = {};
        await Promise.all(checks.map(async c => {
            try {
                const result = await c.fn();
                updateRow(rowEls[c.key], result.status, result.items || [], result.detail || '');
                results[c.key] = result;
            } catch {
                updateRow(rowEls[c.key], 'fail', [], 'error');
                results[c.key] = { status: 'fail', items: [] };
            }
        }));

        // Update statusDot based on task AI health (5 task AIs required)
        const taskAINames = ['Analyst AI', 'Critical AI', 'Researcher AI', 'Technical AI', 'Synthesiser AI'];
        const cloudItems  = (results.cloud && results.cloud.items) || [];
        const taskItems   = cloudItems.filter(i => i.note && taskAINames.includes(i.note));
        const okCount     = taskItems.filter(i => i.ok).length;
        const dot = document.getElementById('statusDot');
        if (dot) {
            if (taskItems.length === 0) {
                dot.style.background = '#a06800'; dot.title = 'Task AI status unknown';
            } else if (okCount === taskItems.length) {
                dot.style.background = '#4a7c4e'; dot.title = 'All ' + okCount + ' task AIs ready';
            } else if (okCount > 0) {
                dot.style.background = '#a06800'; dot.title = okCount + '/' + taskItems.length + ' task AIs ready';
            } else {
                dot.style.background = '#8d3a3a'; dot.title = 'Task AIs unavailable';
            }
        }
    }

    function createRow(label, status, items) {
        const row = document.createElement('div');
        row.className = 'check-row';
        row.style.cssText = 'padding:3px 0;border-bottom:1px solid var(--border);';
        row.innerHTML = renderRowHtml(label, status, items, '');
        return row;
    }

    function updateRow(row, status, items, detail) {
        if (!row) return;
        row.innerHTML = renderRowHtml(
            row.querySelector('.check-label')?.textContent || '',
            status, items, detail
        );
    }

    function renderRowHtml(label, status, items, detail) {
        const icon  = iconHtml(status);
        const color = detailColor(status);
        let html = '<div style="display:flex;align-items:baseline;gap:8px;font-size:13px;">'
            + icon
            + '<span class="check-label" style="flex:1;color:var(--text);">' + esc(label) + '</span>'
            + (detail ? '<span style="color:' + color + ';font-weight:bold;">' + esc(detail) + '</span>' : '')
            + '</div>';
        if (items && items.length > 0) {
            html += '<div style="padding-left:26px;margin-top:2px;">';
            for (const item of items) {
                const ic = item.ok ? '\u2705' : '\u274c';
                html += '<div style="font-size:12px;color:var(--text-muted);padding:1px 0;">'
                    + ic + ' '
                    + '<span style="color:var(--text-muted);">' + esc(item.provider) + '</span>'
                    + ' \u2014 '
                    + '<span style="color:var(--text);">' + esc(item.model) + '</span>'
                    + (item.note ? ' <span style="color:var(--text-dim);font-style:italic;">(' + esc(item.note) + ')</span>' : '')
                    + '</div>';
            }
            html += '</div>';
        }
        return html;
    }

    function iconHtml(status) {
        const icons = { ok:'&#x2705;', fail:'&#x274C;', warn:'&#x26A0;&#xFE0F;', checking:'&#x23F3;' };
        return '<span class="check-icon" style="width:18px;text-align:center;flex-shrink:0;">' + (icons[status] || icons.checking) + '</span>';
    }

    function detailColor(status) {
        if (status === 'ok')   return '#4a7c4e';
        if (status === 'fail') return '#8d3a3a';
        if (status === 'warn') return '#a06800';
        return '#8d7c64';
    }

    function collapse() {
        if (!panelEl) return;
        const rows   = document.getElementById('startupRows');
        const toggle = document.getElementById('panelToggle');
        if (!rows || !toggle) return;
        if (rows.style.display === 'none') {
            rows.style.display = '';
            toggle.innerHTML = chevronUp();
        } else {
            rows.style.display = 'none';
            toggle.innerHTML = chevronDown();
        }
    }

    function chevronUp() {
        return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>';
    }
    function chevronDown() {
        return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
    }

    async function checkNetwork() {
        return navigator.onLine
            ? { status:'ok',   items:[], detail:'online' }
            : { status:'fail', items:[], detail:'offline' };
    }

    async function checkVercel() {
        try {
            const res  = await fetch('/api/health', { signal: AbortSignal.timeout(5000) });
            const data = await res.json();
            return data.ok
                ? { status:'ok',   items:[], detail:'reachable' }
                : { status:'fail', items:[], detail:'unhealthy' };
        } catch {
            return { status:'fail', items:[], detail:'unreachable' };
        }
    }

    async function checkSupabase() {
        try {
            const res  = await fetch('/api/health', { signal: AbortSignal.timeout(6000) });
            const data = await res.json();
            if (data.supabase === 'ok')    return { status:'ok',   items:[], detail:'connected' };
            if (data.supabase === 'error') return { status:'warn', items:[], detail: data.supabaseDetail || 'error' };
            return { status:'warn', items:[], detail:'unchecked' };
        } catch {
            return { status:'warn', items:[], detail:'unavailable' };
        }
    }

    async function checkCloudAI() {
        try {
            const res  = await fetch('/api/services/status', { signal: AbortSignal.timeout(12000) });
            if (!res.ok) return { status:'warn', items:[], detail:'check failed' };
            const data = await res.json();
            const raw  = data.models || [];
            if (raw.length === 0) return { status:'warn', items:[], detail:'no models' };
            const display = {
                'Groq Llama 3.3':              { provider:'Groq',       model:'Llama 3.3 70B',          role:'Analyst AI'       },
                'Google - Gemini 2.5 Flash-Lite':{ provider:'Google',   model:'Gemini 2.5 Flash-Lite',  role:'Critical AI'      },
                'Google - Gemini 2.5 Flash':   { provider:'Google',     model:'Gemini 2.5 Flash',        role:'Researcher AI'    },
                'Codestral (Mistral AI)':       { provider:'Mistral AI', model:'Codestral',               role:'Technical AI'     },
                'GPT-4o (GitHub AI)':           { provider:'GitHub AI',  model:'GPT-4o (Azure)',          role:'General'          },
                'OpenRouter':                   { provider:'OpenRouter', model:'Llama 3.3 70B (free)',   role:'Synthesiser AI'   },
            };
            const items = raw.map(m => {
                const d = display[m.name] || { provider: m.name, model: '', role: '' };
                return { ok: m.ok, provider: d.provider, model: d.model, note: d.role || undefined };
            });
            const allOk = items.every(i => i.ok);
            const anyOk = items.some(i => i.ok);
            return { status: allOk ? 'ok' : anyOk ? 'warn' : 'fail', items, detail: '' };
        } catch {
            return { status:'warn', items:[], detail:'unavailable' };
        }
    }

    window.addEventListener('online',  () => { if (typeof updateStatusDot === 'function') updateStatusDot(); });
    window.addEventListener('offline', () => { if (typeof updateStatusDot === 'function') updateStatusDot(); });

    return { run, collapse };

})();

document.addEventListener('DOMContentLoaded', () => {
    localStorage.removeItem('mc_connectivity_ts'); // always re-ping on fresh load
    setTimeout(() => Connectivity.run(), 300);
});
