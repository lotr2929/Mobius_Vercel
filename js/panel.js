// ── js/panel.js ───────────────────────────────────────────────────────────────
// Right-side output panel. Handles code, file content, directory listings,
// and any structured output that shouldn't clutter the chat.
//
// Public API: window.panel.open(title, content, type)
//             window.panel.update(content)
//             window.panel.setTitle(title)
//             window.panel.append(content)
//             window.panel.close()
//             window.panel.isOpen()
//             window.panel.toggle()
// ─────────────────────────────────────────────────────────────────────────────

const Panel = (() => {

    let _el       = null;
    let _titleEl  = null;
    let _bodyEl   = null;
    let _type     = 'output';
    let _rawText  = '';

    // ── Panel history ─────────────────────────────────────────────────────────
    const _history = [];
    let   _histIdx = -1;

    function _pushHistory(title, content, type) {
        const last = _history[_history.length - 1];
        if (last && last.title === title && last.content === content) return;
        _history.push({ title, content, type });
        _histIdx = _history.length - 1;
        _updateNavBtns();
    }

    function _updateNavBtns() {
        const prev = document.getElementById('panelPrevBtn');
        const next = document.getElementById('panelNextBtn');
        const info = document.getElementById('panelHistInfo');
        if (!prev) return;
        prev.disabled = _histIdx <= 0;
        next.disabled = _histIdx >= _history.length - 1;
        prev.style.opacity = prev.disabled ? '0.3' : '1';
        next.style.opacity = next.disabled ? '0.3' : '1';
        if (info && _history.length > 1) {
            info.textContent = (_histIdx + 1) + '/' + _history.length;
            info.style.display = 'inline';
        } else if (info) {
            info.style.display = 'none';
        }
    }

    // ── Save button state helpers ──────────────────────────────────────────────

    function _setSaved() {
        const btn = document.getElementById('panelSaveBtn');
        if (!btn) return;
        btn.style.display      = 'inline-flex';
        btn.style.color        = 'var(--text-dim)';
        btn.style.border       = 'none';
        btn.style.borderRadius = '2px';
        btn.style.padding      = '2px 10px';
        btn.textContent        = 'Saved';
    }

    function _setUnsaved() {
        const btn = document.getElementById('panelSaveBtn');
        if (!btn) return;
        btn.style.display      = 'inline-flex';
        btn.style.color        = 'var(--green)';
        btn.style.border       = '1px solid var(--green)';
        btn.style.borderRadius = '2px';
        btn.style.padding      = '2px 10px';
        btn.textContent        = 'Save';
    }

    function _updateSaveBtn(content, type) {
        const btn = document.getElementById('panelSaveBtn');
        if (!btn) return;
        if (type === 'edit') {
            _setSaved(); // freshly loaded = saved state
        } else if (content) {
            btn.style.display  = 'inline-flex';
            btn.style.color    = 'var(--text-muted)';
            btn.style.border   = 'none';
            btn.style.padding  = '3px 8px';
            btn.textContent    = 'Save';
        } else {
            btn.style.display = 'none';
        }
    }

    // ── Bootstrap ─────────────────────────────────────────────────────────────

    function _init() {
        if (_el) return;
        _el = document.getElementById('right');
        if (!_el) return;

        _el.innerHTML = `
            <div id="panelBar">
                <button id="panelPrevBtn" class="panel-btn" title="Previous panel (&#8592;)" style="opacity:0.3;" disabled>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
                </button>
                <span id="panelHistInfo" style="display:none;font-size:10px;color:var(--text-dim);min-width:28px;text-align:center;"></span>
                <button id="panelNextBtn" class="panel-btn" title="Next panel (&#8594;)" style="opacity:0.3;" disabled>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
                </button>
                <div style="width:1px;height:14px;background:var(--border);margin:0 2px;"></div>
                <span id="panelTitle">Output</span>
                <span id="panelBadge" class="panel-badge"></span>
                <div style="flex:1"></div>
                <button id="panelSaveBtn" class="panel-btn" title="Save" style="font-size:12px;display:none;">Save</button>
                <button id="panelCopyBtn" class="panel-btn" title="Copy">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <rect x="9" y="9" width="13" height="13" rx="2"/>
                        <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
                    </svg>
                </button>
                <button id="panelCloseBtn" class="panel-btn" title="Close">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                </button>
            </div>
            <div id="panelBody"></div>
        `;

        _titleEl = document.getElementById('panelTitle');
        _bodyEl  = document.getElementById('panelBody');

        document.getElementById('panelCloseBtn').onclick = close;
        document.getElementById('panelCopyBtn').onclick  = _copy;

        document.getElementById('panelSaveBtn').onclick = () => {
            if (_type === 'edit' && window._panelFileHandle) {
                _saveFile();
            } else {
                _saveAs();
            }
        };

        document.getElementById('panelPrevBtn').onclick = () => {
            if (_histIdx > 0) { _histIdx--; _loadHistory(); }
        };
        document.getElementById('panelNextBtn').onclick = () => {
            if (_histIdx < _history.length - 1) { _histIdx++; _loadHistory(); }
        };
    }

    function _loadHistory() {
        const entry = _history[_histIdx];
        if (!entry) return;
        _titleEl.textContent = entry.title;
        const badge = document.getElementById('panelBadge');
        if (badge) { badge.textContent = entry.type; badge.className = 'panel-badge panel-badge-' + entry.type; }
        _render(entry.content, entry.type);
        _updateNavBtns();
    }

    // ── Rendering ─────────────────────────────────────────────────────────────

    function _render(content, type) {
        _rawText = content || '';
        _type    = type;

        _bodyEl.innerHTML = '';
        _bodyEl.className = 'panel-body panel-body-' + type;

        if (type === 'edit') {
            const ta = document.createElement('textarea');
            ta.id          = 'panelEditArea';
            ta.value       = content || '';
            ta.spellcheck  = false;
            ta.autocorrect = 'off';
            // Any keystroke switches button to unsaved state
            ta.addEventListener('input', _setUnsaved);
            _bodyEl.appendChild(ta);

        } else if (type === 'html') {
            const div = document.createElement('div');
            div.className = 'panel-html chat-answer';
            div.innerHTML = content || '';
            _bodyEl.appendChild(div);

        } else {
            const pre  = document.createElement('pre');
            const code = document.createElement('code');
            code.textContent = content || '';
            pre.appendChild(code);
            _bodyEl.appendChild(pre);
        }

        _updateSaveBtn(content, type);
    }

    async function _saveAs() {
        const content = document.getElementById('panelEditArea')?.value || _rawText;
        if (!content) return;
        const title = _titleEl?.textContent || 'output';
        const ext   = _type === 'code' ? '.js' : '.md';
        try {
            const fh = await window.showSaveFilePicker({
                suggestedName: title.replace(/[^\w\s-]/g, '').trim() + ext,
                types: [{ description: 'Text file', accept: { 'text/plain': ['.md', '.txt', '.js', '.html', '.py', '.json'] } }]
            });
            const w = await fh.createWritable();
            let toWrite = content;
            if (_type === 'html') {
                const tmp = document.createElement('div');
                tmp.innerHTML = content;
                toWrite = tmp.innerText || tmp.textContent || content;
            }
            await w.write(toWrite);
            await w.close();
            _setSaved();
        } catch (e) {
            if (e.name !== 'AbortError') console.error('[panel] Save failed:', e);
        }
    }

    function _copy() {
        const text = document.getElementById('panelEditArea')?.value || _rawText;
        navigator.clipboard.writeText(text).then(() => {
            const btn = document.getElementById('panelCopyBtn');
            const orig = btn.innerHTML;
            btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
            setTimeout(() => { btn.innerHTML = orig; }, 1500);
        }).catch(() => {});
    }

    async function _saveFile() {
        const content = document.getElementById('panelEditArea')?.value;
        if (content === undefined) return;
        if (window._panelFileHandle) {
            try {
                const writable = await window._panelFileHandle.createWritable();
                await writable.write(content);
                await writable.close();
                if (window._projectContext) {
                    const name = window._panelFileHandle.name;
                    if (name === '.brief') window._projectContext.brief = content;
                    if (name === '.slim')  window._projectContext.slim  = content;
                }
                _setSaved();
            } catch (err) {
                alert('Save failed: ' + err.message);
            }
        } else {
            _saveAs();
        }
    }

    // ── Public API ────────────────────────────────────────────────────────────

    function open(title, content, type = 'output') {
        _init();
        if (!_el) return;

        _titleEl.textContent = title || 'Output';

        const badge = document.getElementById('panelBadge');
        badge.textContent = type;
        badge.className   = 'panel-badge panel-badge-' + type;

        _render(content, type);
        _pushHistory(title || 'Output', content, type);

        document.body.classList.add('panel-open');
        _updateToggleBtn(true);
    }

    function update(content) {
        if (!_bodyEl) return;
        _render(content, _type);
    }

    function append(content) {
        if (!_bodyEl) return;
        _rawText += content;
        const pre = _bodyEl.querySelector('pre code');
        if (pre) pre.textContent = _rawText;
        else {
            const div = _bodyEl.querySelector('.panel-html');
            if (div) div.innerHTML += content;
        }
        _bodyEl.scrollTop = _bodyEl.scrollHeight;
    }

    function setTitle(title) {
        if (_titleEl) _titleEl.textContent = title;
    }

    function close() {
        document.body.classList.remove('panel-open');
        _updateToggleBtn(false);
        window._panelFileHandle = null;
    }

    function isOpen() {
        return document.body.classList.contains('panel-open');
    }

    function toggle() {
        isOpen() ? close() : open('Output', '', 'output');
    }

    function _updateToggleBtn(active) {
        const btn = document.getElementById('panelToggleBtn');
        if (btn) btn.classList.toggle('active', active);
    }

    return { open, update, append, setTitle, close, isOpen, toggle,
             getLastData: () => _history[_histIdx] || null };

})();

window.panel = Panel;

// ── Resizable divider ─────────────────────────────────────────────────────────

(function initResizer() {
    const divider = document.createElement('div');
    divider.id = 'panelDivider';
    divider.style.cssText = [
        'width:5px',
        'flex-shrink:0',
        'cursor:col-resize',
        'background:transparent',
        'transition:background 0.15s',
        'z-index:10',
        'display:none'
    ].join(';');
    divider.addEventListener('mouseenter', () => { divider.style.background = 'var(--border2)'; });
    divider.addEventListener('mouseleave', () => { divider.style.background = 'transparent'; });

    function inject() {
        const workspace = document.getElementById('workspace');
        const right     = document.getElementById('right');
        if (!workspace || !right) return;
        workspace.insertBefore(divider, right);
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', inject);
    } else {
        inject();
    }

    const observer = new MutationObserver(() => {
        divider.style.display = document.body.classList.contains('panel-open') ? 'block' : 'none';
    });
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });

    let dragging    = false;
    let startX      = 0;
    let startLeftW  = 0;
    let startRightW = 0;

    divider.addEventListener('mousedown', e => {
        const left  = document.getElementById('left');
        const right = document.getElementById('right');
        if (!left || !right) return;
        dragging    = true;
        startX      = e.clientX;
        startLeftW  = left.getBoundingClientRect().width;
        startRightW = right.getBoundingClientRect().width;
        document.body.style.cursor     = 'col-resize';
        document.body.style.userSelect = 'none';
        e.preventDefault();
    });

    document.addEventListener('mousemove', e => {
        if (!dragging) return;
        const left  = document.getElementById('left');
        const right = document.getElementById('right');
        if (!left || !right) return;
        const dx       = e.clientX - startX;
        const newLeft  = Math.max(200, startLeftW + dx);
        const newRight = Math.max(200, startRightW - dx);
        left.style.flex   = 'none';
        left.style.width  = newLeft + 'px';
        right.style.width = newRight + 'px';
    });

    document.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        document.body.style.cursor     = '';
        document.body.style.userSelect = '';
    });

}());
