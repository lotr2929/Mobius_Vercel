// ── js/protocol.js ───────────────────────────────────────────────────────────
// Brief: Protocol [query]
// 8-step pipeline that builds a structured coder_brief before firing All Mode.
//
// Steps:
//   A  Visual understanding  -- Gemini vision describes attached screenshots
//   B  File identification   -- fast AI + RAG identifies relevant files/functions
//   C  Code retrieval        -- getCodeContext (Supabase RAG)
//   D  Context retrieval     -- .brief TEMPLATE + getMemoryContext
//   E  Root cause analysis   -- DeepSeek R1 (fallback: Groq)
//   F  Brief assembly        -- deterministic concatenation
//
// Usage:
//   1. Attach screenshots via paperclip button or Ctrl+V paste
//   2. Type: Brief: Protocol [raw query]
//   3. Wait for Steps A-F -- assembled brief shown + injected into next query
//   4. Type: Ask: All [query]  (or it auto-fires if All Mode is on)
//
// Image storage: window._protocolImages = [{name, mimeType, base64, dataUrl}]
// Brief injection: window.lastReadFile is set so all.js picks it up automatically
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  window._protocolImages = window._protocolImages || [];


  // ── AI call helper ─────────────────────────────────────────────────────────
  // Uses mobius_query format when images present (required for FILES support).
  // Falls back to simple format for text-only calls.

  async function aiCall(query, model, images, timeoutMs) {
    const userId = (window.getAuth && window.getAuth('mobius_user_id')) || null;
    const body   = { userId };
    if (images && images.length) {
      body.mobius_query = {
        ASK: model, INSTRUCTIONS: 'Debug', HISTORY: [], QUERY: query,
        FILES: images.map(img => ({ name: img.name, mimeType: img.mimeType, base64: img.base64 }))
      };
    } else {
      body.query = query;
      body.model = model;
    }
    const res = await fetch('/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body:   JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs || 30000)
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return data.reply || data.answer || '';
  }

  // ── Read .brief TEMPLATE from open project ─────────────────────────────────

  async function readBriefTemplate() {
    try {
      const root = window.getRootHandle && window.getRootHandle();
      if (!root) return '';
      const ctxDir = await root.getDirectoryHandle('_context');
      const fh     = await ctxDir.getFileHandle('.brief');
      const text   = await (await fh.getFile()).text();
      const idx    = text.indexOf('---TEMPLATE---');
      return idx !== -1 ? text.slice(idx + 14).trim() : text.trim();
    } catch { return ''; }
  }

  // ── Get shallow file listing of open project ───────────────────────────────

  async function getProjectFileList() {
    try {
      const root = window.getRootHandle && window.getRootHandle();
      if (!root) return '';
      const files = [];
      for await (const [name, h] of root.entries()) {
        if (h.kind === 'file') {
          files.push(name);
        } else if (['js', 'api', 'app'].includes(name)) {
          try {
            const sub = await root.getDirectoryHandle(name);
            for await (const [sn] of sub.entries()) files.push(name + '/' + sn);
          } catch { /* skip */ }
        }
      }
      return files.slice(0, 80).join(', ');
    } catch { return ''; }
  }


  // ── Read last evaluation winner answer from chat log ──────────────────────
  // Looks in coderRootHandle/chats/ for the most recently modified chat-*.md,
  // finds the last WINNER line, extracts that model's full answer.
  // Returns { winner, answer } or null.

  async function getLastEvalAnswer() {
    try {
      const coderRoot = window.coderRootHandle;
      if (!coderRoot) return null;
      const chatsDir = await coderRoot.getDirectoryHandle('chats');
      let latestFile = null, latestTime = 0;
      for await (const [name, h] of chatsDir.entries()) {
        if (h.kind === 'file' && name.startsWith('chat-') && name.endsWith('.md')) {
          const f = await h.getFile();
          if (f.lastModified > latestTime) { latestTime = f.lastModified; latestFile = f; }
        }
      }
      if (!latestFile) return null;
      const text = await latestFile.text();

      // Find last WINNER line
      const winnerMatches = [...text.matchAll(/^WINNER:\s*(\S+)/mg)];
      if (!winnerMatches.length) return null;
      const winnerMatch = winnerMatches[winnerMatches.length - 1];
      const winnerName  = winnerMatch[1].replace(/[()].*/g, '').trim();

      // Find last ### WinnerName block before the WINNER line
      const beforeWinner  = text.slice(0, winnerMatch.index);
      const headerPattern = new RegExp('###\\s+' + winnerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\n', 'g');
      let lastHeader = null, hm;
      while ((hm = headerPattern.exec(beforeWinner)) !== null) lastHeader = hm;
      if (!lastHeader) return null;

      const answerStart = lastHeader.index + lastHeader[0].length;
      const rest        = beforeWinner.slice(answerStart);
      const endMatch    = rest.match(/\n(?:###|---|##\s)/);
      const answer      = (endMatch ? rest.slice(0, endMatch.index) : rest).trim();

      return answer ? { winner: winnerName, answer: answer.slice(0, 3000) } : null;
    } catch { return null; }
  }

  // ── Step status renderer ───────────────────────────────────────────────────

  function renderSteps(steps, outputEl) {
    if (!outputEl) return;
    const esc  = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const icon = s => s === 'done' ? '<span style="color:#4a8a4a;">&#10003;</span>'
                    : s === 'running' ? '<span style="color:#a06800;">&#8987;</span>'
                    : '<span style="color:var(--text-dim);">&#9675;</span>';
    outputEl.classList.add('html-content');
    outputEl.innerHTML =
      '<div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;'
      + 'color:var(--text-dim);margin-bottom:6px;">Brief: Protocol</div>'
      + steps.map(s =>
          '<div style="display:flex;gap:6px;padding:2px 0;font-size:12px;">'
          + icon(s.status) + ' <span>' + esc(s.label) + '</span></div>'
        ).join('');
  }

  // ── Main handler ───────────────────────────────────────────────────────────

  async function handleBriefProtocol(args, output, outputEl) {
    const rawQuery = args.trim();
    if (!rawQuery) {
      output('Usage: Brief: Protocol [your query]\nAttach screenshots first via the paperclip button or Ctrl+V.');
      return;
    }

    const images    = window._protocolImages || [];
    const hasImages = images.length > 0;

    const steps = [
      { label: 'A: Visual understanding'  + (hasImages ? ' (' + images.length + ' image' + (images.length > 1 ? 's' : '') + ')' : ' -- no images'), status: hasImages ? 'pending' : 'skip' },
      { label: 'B: File identification',    status: 'pending' },
      { label: 'C: Code retrieval (RAG)',   status: 'pending' },
      { label: 'D: Context (.brief + memory)', status: 'pending' },
      { label: 'E: ReAct distil loop (up to 5 iterations)', status: 'pending' },
      { label: 'F: Schema brief assembly',                   status: 'pending' },
    ];

    renderSteps(steps, outputEl);

    let visualContext = '';
    let codeContext   = '';
    let memContext    = '';
    let briefTemplate = '';
    let rootCause     = '';
    let fileIds       = '';

    try {

      // ── STEP A: Visual understanding ──────────────────────────────────────
      if (hasImages) {
        steps[0].status = 'running'; renderSteps(steps, outputEl);
        const vPrompt =
          'You are describing screenshots to help a developer understand a bug.\n'
          + 'For each screenshot:\n'
          + '1. Identify the UI element (widget, panel, component)\n'
          + '2. Describe its exact appearance -- shape, orientation, labels, text, colours\n'
          + '3. Describe anything wrong: distorted, mirrored, viewed from behind, clipped, inverted\n'
          + '   NOTE: "seen from behind" means you can see the BACK face of a 2D element -- '
          + 'the image appears as a mirror of normal (left-right swapped), not rotated 180 degrees.\n'
          + '4. Compare screenshots if multiple are provided\n'
          + 'Be precise. Use directional terms (top, bottom, left, right, clockwise, anticlockwise).\n\n'
          + 'User query context: "' + rawQuery + '"';
        try {
          visualContext = await aiCall(vPrompt, 'gemini', images, 35000);
          steps[0].status = 'done';
        } catch (e) {
          visualContext = '[Vision call failed: ' + e.message + ']';
          steps[0].status = 'done';
        }
      } else {
        steps[0].status = 'skip';
      }
      renderSteps(steps, outputEl);


      // ── STEP B: File identification ───────────────────────────────────────
      steps[1].status = 'running'; renderSteps(steps, outputEl);
      const funcsCtx = window._projectContext && window._projectContext.funcs
        ? window._projectContext.funcs.slice(0, 4000) : null;
      if (funcsCtx || fileList) {
        const fPrompt = funcsCtx
          ? 'Given this bug report, identify the most relevant files and functions.\n'
            + 'Reply with ONLY a JSON array: ["file/path:functionName", ...]\nMax 5 items. No markdown.\n\n'
            + 'Bug: "' + rawQuery + '"\n'
            + (visualContext && !visualContext.startsWith('[Vision') ? 'Visual symptom: ' + visualContext.slice(0, 350) + '\n' : '')
            + 'Function index:\n' + funcsCtx
          : 'Given this bug report, which files and functions are most likely responsible?\n'
            + 'Reply with ONLY a JSON array: ["file/path:functionName", ...]\nMax 5 items. No markdown.\n\n'
            + 'Bug: "' + rawQuery + '"\n'
            + (visualContext && !visualContext.startsWith('[Vision') ? 'Visual symptom: ' + visualContext.slice(0, 350) + '\n' : '')
            + 'Project files: ' + fileList;
        try {
          const raw    = await aiCall(fPrompt, 'gemini-lite', null, 15000);
          const clean  = raw.replace(/```json|```/g, '').trim();
          const m      = clean.match(/\[[\s\S]*\]/);
          const parsed = m ? JSON.parse(m[0]) : null;
          if (Array.isArray(parsed)) fileIds = parsed.join(', ');
        } catch { /* non-critical */ }
      }
      steps[1].status = 'done'; renderSteps(steps, outputEl);

      // ── STEP C: Code retrieval (RAG) ──────────────────────────────────────
      steps[2].status = 'running'; renderSteps(steps, outputEl);
      if (window.getCodeContext) {
        const searchQ = rawQuery + (visualContext && !visualContext.startsWith('[Vision') ? '\n' + visualContext.slice(0, 300) : '');
        codeContext = await window.getCodeContext(searchQ).catch(() => '');
      }
      steps[2].status = 'done'; renderSteps(steps, outputEl);

      // ── STEP D: Context retrieval ─────────────────────────────────────────
      steps[3].status = 'running'; renderSteps(steps, outputEl);
      briefTemplate = await readBriefTemplate();
      if (window.getMemoryContext) {
        memContext = await window.getMemoryContext(rawQuery).catch(() => '');
      }
      const evalResult = await getLastEvalAnswer();
      steps[3].status = 'done'; renderSteps(steps, outputEl);

      // ── STEP E: ReAct distil loop ────────────────────────────────────────
      // Brief AI iterates Thought -> Action -> Observation up to MAX_REACT times.
      // Each Action fetches a targeted code chunk. Loop exits when root cause found.
      // All fetched chunks are accumulated -- each iteration builds on the last.
      steps[4].status = 'running'; renderSteps(steps, outputEl);

      const MAX_REACT   = 5;
      const CHUNK_CHARS = 1600; // per-fetch budget (~400 tokens)
      const reactTrace  = [];
      const fetchedChunks = codeContext ? [codeContext.slice(0, CHUNK_CHARS)] : [];

      const reactSeed =
        'Bug: "' + rawQuery + '"\n'
        + (visualContext && !visualContext.startsWith('[Vision')
            ? 'Visual evidence: ' + visualContext.slice(0, 400) + '\n' : '')
        + (fileIds ? 'Suspected: ' + fileIds + '\n' : '')
        + (window._protocolRetryContext
            ? 'Prior attempt failed:\n' + window._protocolRetryContext.slice(0, 400) + '\nAdjust approach.\n'
            : '');

      function buildReactPrompt(accumulatedCode) {
        return 'You are diagnosing a code bug step by step.\n\n'
          + reactSeed
          + (accumulatedCode ? 'Code evidence so far:\n' + accumulatedCode.slice(0, 4000) + '\n\n' : '')
          + (reactTrace.length ? 'Previous reasoning:\n' + reactTrace.slice(-2).join('\n---\n').slice(0, 600) + '\n\n' : '')
          + 'Respond in EXACTLY this format (no extra text):\n'
          + 'THOUGHT: [what you observe and what more you need to confirm]\n'
          + 'ACTION: search | done\n'
          + 'QUERY: [10-word max search term -- or blank if ACTION is done]\n'
          + 'DIAGNOSIS: [3 sentences, file+function+exact issue -- ONLY when ACTION is done]\n';
      }

      for (let _i = 0; _i < MAX_REACT; _i++) {
        try {
          const accCode = fetchedChunks.join('\n---\n');
          const raw     = await aiCall(buildReactPrompt(accCode), 'gemini-lite', null, 20000);
          reactTrace.push(raw);
          const action  = ((raw.match(/^ACTION:\s*(\S+)/im) || [])[1] || '').toLowerCase();
          const query   = ((raw.match(/^QUERY:\s*(.+?)$/im) || [])[1] || '').trim();
          const diag    = ((raw.match(/^DIAGNOSIS:\s*([\s\S]+?)(?=\n[A-Z]+:|$)/im) || [])[1] || '').trim();
          if (action === 'done' || diag) { rootCause = diag || reactTrace.slice(-1)[0]; break; }
          if (query && window.getCodeContext) {
            const chunk = await window.getCodeContext(query).catch(() => '');
            if (chunk) fetchedChunks.push(chunk.slice(0, CHUNK_CHARS));
          }
        } catch { break; }
      }
      // Fallback: single-shot if ReAct produced nothing
      if (!rootCause && codeContext) {
        try {
          rootCause = await aiCall(
            'Root cause in 3 sentences (file, function, exact issue):\n\n'
            + 'Bug: "' + rawQuery + '"\n\n' + codeContext.slice(0, 3000),
            'groq', null, 20000
          );
        } catch { /* silent */ }
      }
      steps[4].status = 'done'; renderSteps(steps, outputEl);

      // ── STEP F: Schema brief assembly ────────────────────────────────────
      // Produces a structured brief (~300-500 tokens) for Task AIs.
      // Task AIs receive ONLY this brief -- no raw context dump.
      steps[5].status = 'running'; renderSteps(steps, outputEl);

      const qLow     = rawQuery.toLowerCase();
      const taskType = (qLow.includes('fix') || qLow.includes('resolve') || qLow.includes('bug'))
                       ? 'fix'
                       : (qLow.includes('diagnos') || qLow.includes('what') || qLow.includes('why'))
                       ? 'diagnose' : 'fix';
      const firstFileFn = (fileIds.split(',')[0] || '').trim();
      const firstFile   = firstFileFn.split(':')[0] || 'unknown';
      const firstFn     = firstFileFn.split(':')[1] || 'unknown';
      // Best code: prefer freshest fetched chunk; fall back to initial RAG result
      const bestCode    = fetchedChunks.length > 1
                          ? fetchedChunks.slice(1).join('\n---\n').slice(0, 1200)
                          : (fetchedChunks[0] || '').slice(0, 1200);
      const symptomText = (visualContext && !visualContext.startsWith('[Vision'))
                          ? visualContext.slice(0, 200) : rawQuery.slice(0, 200);
      const criterion   = taskType === 'diagnose'
                          ? 'Response names exact file, function, and variable/line causing the symptom.'
                          : 'Response contains a corrected code block that directly addresses the ROOT_CAUSE above.';

      const assembledBrief = [
        briefTemplate ? briefTemplate.slice(0, 300) : '',
        'TASK: '              + taskType,
        'FILE: '              + firstFile,
        'FUNCTION: '          + firstFn,
        'SYMPTOM:\n'          + symptomText,
        'ROOT_CAUSE:\n'       + (rootCause || 'See RELEVANT_CODE below.').slice(0, 500),
        'RELEVANT_CODE:\n'    + bestCode,
        evalResult            ? 'PRIOR_ANALYSIS (' + evalResult.winner + '):\n' + evalResult.answer : '',
        'SUCCESS_CRITERION: ' + criterion,
        'QUERY: '             + rawQuery,
        memContext            ? 'MEMORY:\n' + memContext.slice(0, 300) : '',
      ].filter(Boolean).join('\n\n');

      steps[5].status = 'done'; renderSteps(steps, outputEl);

      // ── Inject into next query via lastReadFile ────────────────────────────
      window.lastReadFile = { path: '[Protocol Brief]', content: assembledBrief };

      // ── Auto-fire Ask: All ─────────────────────────────────────────────────
      // No user action needed -- pipeline fires Task AIs automatically.
      // Brief is already injected above; buildContext() short-circuit ensures
      // Task AIs receive only the schema brief.
      const _autoOutput = output;
      const _autoEl     = outputEl;
      if (window.runAllModels) {
        setTimeout(async () => {
          try {
            await window.runAllModels(rawQuery, _autoOutput, _autoEl, false);
          } catch (e) { console.warn('[protocol] auto Ask: All failed:', e.message); }
        }, 300);
      }


      // ── Render final result ────────────────────────────────────────────────
      const wordCount = assembledBrief.split(/\s+/).length;
      const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      const stepsHtml = steps.map(s =>
        '<div style="display:flex;gap:6px;padding:2px 0;font-size:12px;">'
        + (s.status === 'skip'
            ? '<span style="color:var(--text-dim);">-</span>'
            : '<span style="color:#4a8a4a;">&#10003;</span>')
        + ' <span style="color:' + (s.status === 'skip' ? 'var(--text-dim)' : 'var(--text)') + ';">'
        + esc(s.label) + '</span></div>'
      ).join('');

      const infoLine = [
        wordCount + ' words',
        hasImages ? images.length + ' image' + (images.length > 1 ? 's' : '') + ' described' : null,
        fileIds   ? 'files: ' + esc(fileIds.slice(0, 80)) + (fileIds.length > 80 ? '...' : '') : null,
        rootCause ? 'root cause identified' : null,
      ].filter(Boolean).join(' \u00b7 ');

      outputEl.classList.add('html-content');
      outputEl.innerHTML =
        '<div style="font-size:11px;text-transform:uppercase;letter-spacing:.06em;'
        + 'color:var(--text-dim);margin-bottom:6px;">Brief: Protocol</div>'
        + stepsHtml
        + '<div style="margin:8px 0 4px;font-size:12px;color:var(--text-dim);">' + infoLine + '</div>'
        + '<details style="margin-top:4px;">'
        + '<summary style="font-size:12px;cursor:pointer;color:var(--green);">&#9654; View assembled brief</summary>'
        + '<pre style="font-size:11px;white-space:pre-wrap;margin-top:6px;padding:8px;'
        + 'background:var(--surface);border:1px solid var(--border);border-radius:3px;'
        + 'max-height:300px;overflow:auto;">'
        + esc(assembledBrief.slice(0, 4000)) + (assembledBrief.length > 4000 ? '\n...[truncated]' : '')
        + '</pre></details>'
        + '<div style="margin-top:8px;font-size:12px;color:#4a8a4a;">'
        + '&#10003; Brief assembled \u2014 firing all models now...'
        + '</div>';

      document.getElementById('input').value = '';

    } catch (err) {
      outputEl.classList.add('html-content');
      outputEl.innerHTML = '<div style="color:var(--red);font-size:12px;">Brief: Protocol failed at step '
        + (steps.findIndex(s => s.status === 'running') + 1) + ': ' + err.message + '</div>';
    }
  }


  // ── Image attachment support ───────────────────────────────────────────────

  function renderImageStrip() {
    const images = window._protocolImages || [];
    let strip    = document.getElementById('proto-img-strip');

    if (!images.length) {
      if (strip) strip.style.display = 'none';
      const btn = document.getElementById('addBtn');
      if (btn) btn.classList.remove('active-up');
      return;
    }

    if (!strip) {
      strip = document.createElement('div');
      strip.id = 'proto-img-strip';
      strip.style.cssText = 'display:flex;gap:6px;padding:4px 0 2px;flex-wrap:wrap;align-items:center;';
      const inputArea = document.getElementById('inputArea');
      const textarea  = document.getElementById('input');
      if (inputArea && textarea) inputArea.insertBefore(strip, textarea);
    }

    strip.style.display = 'flex';
    strip.innerHTML = images.map((img, i) =>
      '<div style="position:relative;width:44px;height:44px;'
      + 'border:1px solid var(--border);border-radius:3px;overflow:hidden;flex-shrink:0;">'
      + '<img src="' + img.dataUrl + '" style="width:100%;height:100%;object-fit:cover;" title="' + img.name + '">'
      + '<button onclick="window._removeProtocolImage(' + i + ')" '
      + 'style="position:absolute;top:0;right:0;background:rgba(0,0,0,.65);color:#fff;'
      + 'border:none;font-size:9px;cursor:pointer;padding:1px 3px;line-height:1.2;">&#x2715;</button>'
      + '</div>'
    ).join('')
    + '<span style="font-size:11px;color:var(--text-dim);">'
    + images.length + ' image' + (images.length > 1 ? 's' : '') + ' attached</span>';

    const btn = document.getElementById('addBtn');
    if (btn) btn.classList.add('active-up');
  }

  window._removeProtocolImage = function (idx) {
    if (window._protocolImages) {
      window._protocolImages.splice(idx, 1);
      renderImageStrip();
    }
  };

  function addProtocolImage(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = e => {
        const dataUrl = e.target.result;
        const base64  = dataUrl.split(',')[1];
        const mimeType = file.type || 'image/png';
        const name     = file.name || ('image-' + Date.now() + '.png');
        window._protocolImages.push({ name, mimeType, base64, dataUrl });
        renderImageStrip();
        resolve();
      };
      reader.onerror = () => reject(new Error('File read failed'));
      reader.readAsDataURL(file);
    });
  }


  // ── Wire addBtn + paste ────────────────────────────────────────────────────

  function initImageSupport() {
    // Hidden file input for picker
    let fileInput = document.getElementById('proto-file-input');
    if (!fileInput) {
      fileInput = document.createElement('input');
      fileInput.id       = 'proto-file-input';
      fileInput.type     = 'file';
      fileInput.accept   = 'image/*';
      fileInput.multiple = true;
      fileInput.style.display = 'none';
      document.body.appendChild(fileInput);
    }

    // Wire addBtn click -> file picker
    const addBtn = document.getElementById('addBtn');
    if (addBtn && !addBtn._protocolWired) {
      addBtn._protocolWired = true;
      addBtn.addEventListener('click', e => { e.preventDefault(); fileInput.click(); });
      addBtn.title = 'Attach images (or Ctrl+V to paste screenshot)';
    }

    // File picker change -> load images
    if (!fileInput._protocolWired) {
      fileInput._protocolWired = true;
      fileInput.addEventListener('change', async () => {
        for (const file of Array.from(fileInput.files || [])) {
          if (file.type.startsWith('image/')) await addProtocolImage(file).catch(() => {});
        }
        fileInput.value = '';
      });
    }

    // Paste screenshot from clipboard (Ctrl+V into textarea)
    const textarea = document.getElementById('input');
    if (textarea && !textarea._protocolPasteWired) {
      textarea._protocolPasteWired = true;
      textarea.addEventListener('paste', async e => {
        const items = Array.from(e.clipboardData?.items || []);
        const imgs  = items.filter(it => it.type.startsWith('image/'));
        if (!imgs.length) return;
        e.preventDefault();
        for (const item of imgs) {
          const file = item.getAsFile();
          if (file) await addProtocolImage(file).catch(() => {});
        }
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initImageSupport);
  } else {
    setTimeout(initImageSupport, 400);
  }

  // ── Self-register ──────────────────────────────────────────────────────────

  function register() {
    if (!window.COMMANDS) { setTimeout(register, 50); return; }
    window.COMMANDS['brief: protocol'] = {
      handler: handleBriefProtocol,
      family:  'brief',
      desc:    'Build structured brief from query + images (Steps A-F pipeline). Attach screenshots first.'
    };
    window.COMMANDS['brief: clear images'] = {
      handler: async (_, output) => {
        window._protocolImages = [];
        renderImageStrip();
        output('Attached images cleared.');
        document.getElementById('input').value = '';
      },
      family: 'brief',
      desc: 'Clear all attached images'
    };
    // Expose for auto-routing from sendToLastModel
    window.handleBriefProtocol = handleBriefProtocol;
  }
  register();

})();
