// -- js/project.js --â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Project: family -- open folder, list, find, map, scan, read, parse, brief, slim, funcs.
// Aliases: access, find, list kept for backward compatibility.
// --â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

(function () {
  'use strict';

  const SKIP_DIRS  = new Set(['.git', 'node_modules', '_debug', 'dist', 'build', '.next', '.vercel', 'backups', '__pycache__']);
  const TEXT_EXTS  = new Set(['.js', '.ts', '.jsx', '.tsx', '.html', '.css', '.json', '.md', '.txt', '.py', '.sh', '.bat', '.ps1', '.env', '.yml', '.yaml', '.toml', '.svelte', '.vue']);
  const PARSE_EXTS = new Set(['.js', '.ts', '.jsx', '.tsx', '.html', '.css', '.py', '.sh', '.bat']);

  async function _openInEditPanel(handle, filename, title) {
    try {
      const ctxDir  = await handle.getDirectoryHandle('_context', { create: true });
      const fh      = await ctxDir.getFileHandle(filename, { create: true });
      const content = await (await fh.getFile()).text();
      window._panelFileHandle = fh;
      if (window.panel) window.panel.open(title, content, 'edit');
    } catch (err) { console.error('[panel] could not open ' + filename, err); }
  }

  async function handleProjectHome(args, output) {
    try {
      const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
      window.coderRootHandle = handle;
      if (window.storeCoderHandle) await window.storeCoderHandle(handle);
      try { await handle.getDirectoryHandle('chats', { create: true }); } catch {}
      const now = new Date(); const pad = n => String(n).padStart(2, '0');
      const stamp = now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) + '-' + pad(now.getHours()) + pad(now.getMinutes());
      window.coderSessionStamp = stamp;
      output('Coder home set: ' + handle.name + '. Stored for next session. Log: chats/chat-' + stamp + '.md');
      if (window.updateTargetBadge) window.updateTargetBadge();
    } catch (err) { if (err.name !== 'AbortError') output('Error: ' + err.message); }
  }

  function handleProjectClose(args, output) {
    const handle = window.getRootHandle ? window.getRootHandle() : null;
    const name   = handle ? handle.name : null;
    if (window.clearRootHandle) window.clearRootHandle();
    window._projectContext = null; window.lastReadFile = null; window._indexedProject = null; window._targetMode = 'home';
    if (window.updateTargetBadge) window.updateTargetBadge();
    output(name ? name + ' closed. Target reset to Home.' : 'No project was open.');
  }

  const IDX_EXTS  = new Set(['js', 'html', 'md']);
  const IDX_NAMED = new Set(['vercel.json', 'mcp.json', 'package.json', 'CLAUDE.md']);
  const IDX_SKIP  = new Set(['node_modules', 'backups', 'chats', '.git', '_debug']);

  async function checkAndRestoreIndex(handle, output) {
    const project = handle.name; const userId = window.getAuth ? window.getAuth('mobius_user_id') : null;
    const dots = ['   ', '.  ', '.. ', '...']; let dotIdx = 0; let ticker = null;
    function startTicker(msg) { dotIdx = 0; output(msg + dots[dotIdx]); ticker = setInterval(() => { dotIdx = (dotIdx+1)%dots.length; output(msg + dots[dotIdx]); }, 400); }
    function stopTicker() { if (ticker) { clearInterval(ticker); ticker = null; } }
    startTicker('Checking index for ' + project);
    let indexedFiles = [];
    try { const res = await fetch('/codeindex', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sub: 'index-list', userId, project }) }); indexedFiles = (await res.json()).files || []; } catch {}
    stopTicker();
    if (indexedFiles.length === 0) { output('No index found for ' + project + '. Building now...'); const idxCmd = window.COMMANDS && window.COMMANDS['project: index']; if (idxCmd) await idxCmd.handler('', output); return; }
    const indexMap = new Map(indexedFiles.map(f => [f.file_path, new Date(f.indexed_at).getTime()]));
    const stale = []; let scanned = 0; startTicker('Scanning files');
    async function walkForStale(dirHandle, basePath) {
      for await (const [name, h] of dirHandle.entries()) {
        if (h.kind === 'directory') { if (!IDX_SKIP.has(name) && !name.startsWith('.')) await walkForStale(h, basePath + name + '/'); }
        else if (h.kind === 'file') {
          const ext = (name.split('.').pop() || '').toLowerCase();
          if (IDX_NAMED.has(name) || IDX_EXTS.has(ext)) {
            scanned++; if (scanned % 10 === 0) { stopTicker(); startTicker('Scanning files (' + scanned + ' checked)'); }
            try { const file = await h.getFile(); if (!(indexMap.get(basePath+name)) || file.lastModified > indexMap.get(basePath+name)) stale.push({ name, path: basePath+name, handle: h }); } catch {}
          }
        }
      }
    }
    try { await walkForStale(handle, ''); } catch {}
    stopTicker();
    if (stale.length > 0) {
      output(stale.length + ' file(s) changed. Re-indexing changed files only...');
      if (window.indexFileList) await window.indexFileList(stale, project, output);
      else { const idxCmd = window.COMMANDS && window.COMMANDS['project: index']; if (idxCmd) await idxCmd.handler('', output); }
    }
    else { output('Index up to date. ' + indexedFiles.length + ' files ready.'); window._indexedProject = project; }
  }

  async function handleProjectOpen(args, output) {
    const ok = await window.handleAccess(output); if (!ok) return;
    const handle = window.getRootHandle();
    const listing = window._lastAccessListing || ('Access granted: ' + handle.name);
    await setupProjectContext(handle, msg => output(listing + '\n\n' + msg));
    window._targetMode = 'project'; if (window.updateTargetBadge) window.updateTargetBadge();
    await checkAndRestoreIndex(handle, output);
    // Auto-run Setup to ensure context files are current -- silent after open
    output('Running context setup for ' + handle.name + '...');
    await handleProjectSetup('', output, null);
  }

  async function handleProjectList(args, output) {
    if (!await window.ensureAccess(output)) return;
    const handle = window.getRootHandle(); const entries = [];
    for await (const [name, h] of handle.entries()) entries.push((h.kind === 'directory' ? '\uD83D\uDCC1' : '\uD83D\uDCC4') + ' ' + name);
    entries.sort(); document.getElementById('input').value = '';
    const text = handle.name + ' (' + entries.length + ' items):\n' + entries.join('\n');
    if (window.panel) { window.panel.open(handle.name, text, 'output'); output('Listed ' + entries.length + ' items -- see panel'); } else output(text);
  }

  async function handleProjectFind(args, output) {
    if (!await window.ensureAccess(output)) return;
    if (!args.trim()) { output('Usage: Project: Find [filename or keyword]'); return; }
    const query = args.trim().toLowerCase(); const handle = window.getRootHandle(); const results = [];
    async function search(dirHandle, path) {
      for await (const [name, h] of dirHandle.entries()) {
        if (SKIP_DIRS.has(name)) continue;
        const fullPath = path ? path + '/' + name : name;
        if (name.toLowerCase().includes(query)) results.push((h.kind === 'directory' ? '\uD83D\uDCC1' : '\uD83D\uDCC4') + ' ' + fullPath);
        if (h.kind === 'directory' && results.length < 300) { try { await search(h, fullPath); } catch {} }
      }
    }
    output('Searching...'); await search(handle, ''); document.getElementById('input').value = '';
    const text = results.length ? 'Found ' + results.length + ' result(s) for "' + query + '":\n' + results.join('\n') : 'No matches for "' + query + '".';
    if (window.panel && results.length) { window.panel.open('Find: ' + query, text, 'output'); output('Found ' + results.length + ' result(s) -- see panel'); } else output(text);
  }

  async function handleProjectMap(args, output, outputEl) { const c = window.COMMANDS && window.COMMANDS['map']; if (c) return await c.handler(args||'', output, outputEl); output('Map module not loaded.'); }
  async function handleProjectScan(args, output, outputEl) { const c = window.COMMANDS && window.COMMANDS['updatemap']; if (c) return await c.handler(args||'', output, outputEl); output('Map module not loaded.'); }

  async function handleProjectRead(args, output, outputEl) {
    if (!await window.ensureAccess(output)) return;
    if (!args.trim()) { output('Usage: Project: Read [filename or path]'); return; }
    const target = args.trim().replace(/\\/g, '/'); const handle = window.getRootHandle();
    output('Reading ' + target + '...');
    try {
      const parts = target.split('/'); let current = handle; let found = false;
      for (const part of parts) { found = false; for await (const [name, h] of current.entries()) { if (name === part) { current = h; found = true; break; } } if (!found) break; }
      if (!found || current.kind !== 'file') { output('File not found: ' + target); return; }
      const content = await (await current.getFile()).text();
      window.lastReadFile = { path: target, content }; document.getElementById('input').value = '';
      if (window.panel) { const ext = target.split('.').pop().toLowerCase(); const type = ['js','ts','html','css','json','py','sh','bat','ps1'].includes(ext) ? 'code' : 'output'; window.panel.open('Read: ' + target, content, type); output('Read ' + target + ' (' + content.length + ' chars) -- see panel'); }
      else output(content);
    } catch (err) { output('Read failed: ' + err.message); }
  }

  // -- generateProjectBrief --â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Hybrid brief: Gemini infers what it can from code/docs, [FILL IN] marks
  // the rest. Opens immediately in panel for user to complete.
  // Sections Gemini fills:  What this is, Current focus, Key constraints
  // Sections always [FILL IN]: Deployment, Off-limits, Known issues

  async function generateProjectBrief(handle, output) {
    output('Generating .brief for ' + handle.name + '...');
    const ctx = window._projectContext; const project = handle.name; const sources = [];
    if (ctx && ctx.claude) sources.push('CLAUDE.md:\n' + ctx.claude.slice(0, 1500));
    if (ctx && ctx.map)    sources.push('File map (first 60 lines):\n' + ctx.map.split('\n').slice(0, 60).join('\n'));
    if (ctx && ctx.slim)   sources.push('File index:\n' + ctx.slim.slice(0, 800));
    try {
      const devDir  = await handle.getDirectoryHandle('_dev');
      const guideFh = await devDir.getFileHandle('_dev_guide.md');
      sources.push('Dev guide:\n' + (await (await guideFh.getFile()).text()).slice(0, 2500));
    } catch { /* proceed without */ }

    // Ask Gemini only for the three inferrable sections.
    // Output format: three clearly labelled blocks, no markdown headers.
    const prompt = 'Analyse this project and output EXACTLY three labelled blocks. '  
      + 'No preamble, no markdown, no extra text.\n\n'
      + 'WHAT_THIS_IS: (2-3 sentences: what the project does, tech stack, deployment)\n'
      + 'CURRENT_FOCUS: (1-2 sentences: what is actively being built or changed)\n'
      + 'KEY_CONSTRAINTS: (3-5 short bullet points starting with - : runtime rules, language rules, key conventions inferred from the code and docs)\n\n'
      + (sources.length ? sources.join('\n\n') : 'No documentation available -- infer from the project name: ' + project);

    let whatThisIs  = '[FILL IN: what the project does, tech stack, deployment]';
    let currentFocus = '[FILL IN: what is actively being built or debugged]';
    let keyConstraints = '- [FILL IN]\n- [FILL IN]';

    if (sources.length) {
      try {
        const res  = await fetch('/ask', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ query: prompt, model: 'gemini', userId: window.getAuth ? window.getAuth('mobius_user_id') : null })
        });
        const data = await res.json();
        const raw  = (data.reply || data.answer || '').trim();
        if (raw) {
          const extract = (key) => {
            const m = raw.match(new RegExp(key + ':\\s*([\\s\\S]*?)(?=\\n[A-Z_]+:|$)'));
            return m ? m[1].trim() : null;
          };
          whatThisIs     = extract('WHAT_THIS_IS')    || whatThisIs;
          currentFocus   = extract('CURRENT_FOCUS')   || currentFocus;
          keyConstraints = extract('KEY_CONSTRAINTS') || keyConstraints;
        }
      } catch { /* use placeholders */ }
    }

    // Assemble the full brief -- [FILL IN] sections are always hardcoded
    const templateFooter =
      '\n\n---TEMPLATE---\n'
      + 'You are a coding assistant for ' + project + ' (browser PWA, vanilla JS, Vercel).\n'
      + 'Source truth: treat injected [Relevant code] chunks as ground truth -- never invent function or variable names not shown there.\n'
      + 'Answer format: always reference the exact file path and function name. For fixes, show the exact lines to change.\n'
      + 'Task routing: Fix/Debug -> propose exact line diffs with file path. Explain -> cite specific functions from source. Plan -> reference existing architecture.\n'
      + 'Runtime check: any response using require(), TypeScript syntax, or npm imports is wrong for this project.';

    const finalText =
      '# ' + project + ' -- Project Brief\n\n'
      + '## What this is\n' + whatThisIs + '\n\n'
      + '## Deployment\n'
      + '- Live URL: [FILL IN]\n'
      + '- Vercel project: [FILL IN]\n'
      + '- Supabase project: [FILL IN]\n'
      + '- Key env vars: [FILL IN e.g. SUPABASE_URL, SUPABASE_KEY, API keys]\n\n'
      + '## Current focus\n' + currentFocus + '\n\n'
      + '## Key constraints\n' + keyConstraints + '\n\n'
      + '## Off-limits\n'
      + '- [FILL IN: data or files that must never be sent to external APIs or logged]\n\n'
      + '## Known issues\n'
      + '(none yet)'
      + templateFooter;

    try {
      const ctxDir = await handle.getDirectoryHandle('_context', { create: true });
      const fh     = await ctxDir.getFileHandle('.brief', { create: true });
      const w      = await fh.createWritable();
      await w.write(finalText);
      await w.close();
      if (window._projectContext) window._projectContext.brief = finalText;
      return finalText;
    } catch (err) {
      output('Failed to write .brief: ' + err.message);
      return null;
    }
  }

  async function handleProjectBrief(args, output) {
    if (!await window.ensureAccess(output)) return;
    const handle = window.getRootHandle(); const arg = (args || '').trim();
    if (arg && arg !== 'generate' && arg !== 'regenerate') {
      try { const ctxDir = await handle.getDirectoryHandle('_context', { create: true }); const fh = await ctxDir.getFileHandle('.brief', { create: true }); const w = await fh.createWritable(); await w.write(arg); await w.close(); if (window._projectContext) window._projectContext.brief = arg; }
      catch (err) { output('Failed to save brief: ' + err.message); return; }
    }
    const noExisting = !window._projectContext || !window._projectContext.brief;
    if (arg === 'generate' || arg === 'regenerate' || (!arg && noExisting)) {
      const generated = await generateProjectBrief(handle, output);
      if (!generated) return;
      if (window.appendToLog) window.appendToLog('Project: Brief -- generated for ' + handle.name, [{ model: 'Gemini', content: generated }], 'single', '').catch(() => {});
    }
    await _openInEditPanel(handle, '.brief', 'Brief: ' + handle.name);
    output((noExisting ? 'Brief generated' : 'Brief open') + ' in panel -- edit and Save to update.');
  }

  async function handleProjectSlim(args, output) {
    if (!await window.ensureAccess(output)) return;
    const handle = window.getRootHandle(); const arg = args.trim(); const ctx = window._projectContext;
    if (arg) { if (!ctx || !ctx.map) { output('No map loaded. Run Project: Map first.'); return; } await generateSlimFromMap(handle, ctx.map, handle.name, arg); await _openInEditPanel(handle, '.slim', 'Slim: ' + handle.name); output('Slim header saved -- see panel.'); return; }
    if (!ctx || !ctx.map) { output('No map loaded. Run Project: Map first.'); return; }
    const existingHeader = (() => { if (!ctx.slim) return null; const sep = ctx.slim.indexOf('\n---'); return sep !== -1 ? ctx.slim.slice(0, sep).trimEnd() : null; })();
    if (!ctx.slim || !existingHeader) { output('Generating slim...'); const header = await generateTechStackHeader(handle); await generateSlimFromMap(handle, ctx.map, handle.name, header || ''); }
    await _openInEditPanel(handle, '.slim', 'Slim: ' + handle.name);
    output('Slim open in panel -- edit and click Save to update.');
  }

  async function handleProjectParse(args, output, outputEl) {
    if (!await window.ensureAccess(output)) return;
    const handle = window.getRootHandle();
    output('Scanning functions for missing descriptions...');

    const JS_EXTS2    = new Set(['.js', '.ts', '.jsx', '.tsx', '.html']);
    const SKIP_FILES2 = new Set(['three.module.js', 'OrbitControls.js', 'mammoth.min.js', 'pdf.min.js', 'xlsx.full.min.js']);
    const MAX_SIZE2   = 80 * 1024;
    const FUNC_RE2    = /^[ \t]*(?:export[ \t]+)?(?:async[ \t]+)?function[ \t]+(\w+)[ \t]*\(([^)\/\n]*)\)/mg;

    const now2   = new Date();
    const stamp2 = now2.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })
                 + '  ' + now2.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit', hour12: true });
    const funcsLines = ['# ' + handle.name + ' -- function index', '# Generated: ' + stamp2, ''];
    const written = [], failed = [];
    let totalAdded = 0;

    async function processFile(fileHandle, filePath) {
      const fname2 = filePath.split('/').pop();
      if (SKIP_FILES2.has(fname2)) return;
      const file = await fileHandle.getFile();
      if (file.size > MAX_SIZE2) return;
      const content = await file.text();
      const lines   = content.split('\n');
      FUNC_RE2.lastIndex = 0;
      const functions = [];
      let m2;
      while ((m2 = FUNC_RE2.exec(content)) !== null) {
        const lineIdx     = content.slice(0, m2.index).split('\n').length - 1;
        const rawParams   = m2[2].split('{')[0].trim();
        const cleanParams = rawParams
          ? rawParams.split(',').map(p => p.trim().split(/[=\s]/)[0]).filter(p => p && !p.includes('/')).join(', ')
          : '';
        functions.push({ name: m2[1], params: cleanParams, lineIdx });
      }
      if (!functions.length) return;

      const undocumented = [];
      const funcDescs    = {};
      for (const fn of functions) {
        let commentText = null;
        for (let i = fn.lineIdx - 1; i >= Math.max(0, fn.lineIdx - 4); i--) {
          const l = (lines[i] || '').trim();
          if (!l) continue;
          if (l.startsWith('//') || l.startsWith('*') || l.startsWith('/*') || l.startsWith('/**'))
            commentText = l.replace(/^\/\/+\s*/, '').replace(/^\/\*+\s*/, '').replace(/\*\/\s*$/, '').trim();
          break;
        }
        if (commentText) funcDescs[fn.name] = commentText;
        else undocumented.push(fn);
      }

      if (undocumented.length) {
        const snippets = undocumented.map(fn =>
          '  ' + fn.name + '(' + fn.params + '):\n'
          + lines.slice(fn.lineIdx, fn.lineIdx + 6).join('\n')
        ).join('\n\n');
        const prompt =
          'Write a one-line description for each JavaScript function below.\n'
          + 'Output ONLY valid JSON: {"functionName": "does X in plain English", ...}\n'
          + 'No preamble, no markdown fences.\n\n'
          + 'File: ' + filePath + '\n\n' + snippets;
        try {
          const res     = await fetch('/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: prompt, model: 'groq', userId: window.getAuth ? window.getAuth('mobius_user_id') : null }) });
          const rawDesc = ((await res.json()).reply || '').trim().replace(/```json|```/g, '');
          const mapM    = rawDesc.match(/\{[\s\S]*\}/);
          const descMap = mapM ? JSON.parse(mapM[0]) : {};
          Object.assign(funcDescs, descMap);
          const newLines = [...lines];
          const sorted   = [...undocumented].sort((a, b) => b.lineIdx - a.lineIdx);
          for (const fn of sorted) {
            const desc   = descMap[fn.name] || ('handles ' + fn.name);
            funcDescs[fn.name] = funcDescs[fn.name] || desc;
            const indent = ((lines[fn.lineIdx] || '').match(/^(\s*)/) || ['', ''])[1];
            newLines.splice(fn.lineIdx, 0, indent + '// ' + desc);
          }
          totalAdded += undocumented.length;
          const debugDir = await handle.getDirectoryHandle('_debug', { create: true });
          const fixDir   = await debugDir.getDirectoryHandle('fix',   { create: true });
          const fnameFix = filePath.replace(/\//g, '__');
          const fhFix    = await fixDir.getFileHandle(fnameFix, { create: true });
          const wFix     = await fhFix.createWritable();
          await wFix.write(newLines.join('\n')); await wFix.close();
          written.push({ to: filePath, count: undocumented.length });
        } catch (e) { failed.push(filePath + ': ' + e.message); }
      }

      funcsLines.push('## ' + filePath + '  (' + (file.size / 1024).toFixed(0) + ' KB)');
      for (const fn of functions) {
        const desc = funcDescs[fn.name];
        funcsLines.push('  ' + fn.name + '(' + fn.params + ')' + (desc ? '  --  ' + desc : ''));
      }
      funcsLines.push('');
    }

    async function walkParse(dirHandle, basePath) {
      for await (const [name, h] of dirHandle.entries()) {
        if (name.startsWith('.') || SKIP_DIRS.has(name)) continue;
        const fullPath = basePath ? basePath + '/' + name : name;
        if (h.kind === 'directory') { await walkParse(h, fullPath); }
        else {
          const ext = name.includes('.') ? '.' + name.split('.').pop().toLowerCase() : '';
          if (JS_EXTS2.has(ext)) { try { await processFile(h, fullPath); } catch (e2) { failed.push(fullPath); } }
        }
      }
    }
    await walkParse(handle, '');

    if (funcsLines.length > 3) {
      try {
        const ctxDir = await handle.getDirectoryHandle('_context', { create: true });
        const fhF    = await ctxDir.getFileHandle('.funcs', { create: true });
        const wF     = await fhF.createWritable();
        await wF.write(funcsLines.join('\n')); await wF.close();
        if (window._projectContext) window._projectContext.funcs = funcsLines.join('\n');
      } catch (eF) { failed.push('.funcs: ' + eF.message); }
    }

    document.getElementById('input').value = '';
    const totalFns = funcsLines.filter(l => l.startsWith('  ')).length;
    if (outputEl) {
      outputEl.classList.add('html-content');
      outputEl.innerHTML =
        '<div style="font-size:13px;">'
        + '<div style="font-weight:bold;margin-bottom:8px;">Parse complete</div>'
        + '<div>' + totalAdded + ' description(s) added across ' + written.length + ' file(s) -- see _debug/fix/</div>'
        + (written.length ? '<ul style="margin:4px 0 8px 18px;padding:0;">' + written.map(w => '<li style="margin:2px 0;">' + esc(w.to) + ' (' + w.count + ' added)</li>').join('') + '</ul>' : '')
        + '<div>.funcs updated -- ' + totalFns + ' function(s) indexed.</div>'
        + (failed.length ? '<div style="color:var(--red);margin-top:4px;">Failed: ' + failed.join(', ') + '</div>' : '')
        + '<div style="margin-top:8px;color:var(--text-dim);">Review in _debug/fix/, then run <strong>Debug: Promote CONFIRM</strong> for each.</div>'
        + '</div>';
    } else {
      output('Parse complete. ' + totalAdded + ' description(s) added. .funcs updated (' + totalFns + ' functions).' + (failed.length ? ' Failed: ' + failed.join(', ') : ''));
    }
  }

  function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  // -- setupProjectContext --â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  const MAP_STALE_DAYS = 1;

  async function setupProjectContext(handle, output) {
    window._projectContext = { name: handle.name, claude: null, map: null, slim: null, brief: null, context: null, funcs: null };
    try { for await (const [name, h] of handle.entries()) { if (name === 'CLAUDE.md' && h.kind === 'file') { window._projectContext.claude = await (await h.getFile()).text(); break; } } } catch {}
    let mapFile = null, slimFile = null;
    try {
      const ctxDir = await handle.getDirectoryHandle('_context');
      for await (const [name, h] of ctxDir.entries()) {
        if (name === '.brief'   && h.kind === 'file') window._projectContext.brief   = await (await h.getFile()).text();
        if (name === '.context' && h.kind === 'file') window._projectContext.context = await (await h.getFile()).text();
        if (name === '.funcs'   && h.kind === 'file') window._projectContext.funcs   = await (await h.getFile()).text();
        if (name === '.slim'    && h.kind === 'file') { slimFile = await h.getFile(); window._projectContext.slim = await slimFile.text(); }
        if (name === '.map'     && h.kind === 'file') { mapFile  = await h.getFile(); window._projectContext.map  = await mapFile.text(); }
      }
    } catch {}
    let mapStatus;
    if (!mapFile) { mapStatus = 'Map: not found'; }
    else {
      const ageDays = Math.floor((Date.now() - mapFile.lastModified) / 86400000);
      const lines   = window._projectContext.map.split('\n').length;
      let stale = false;
      const SRC_EXTS  = new Set(['.js','.html','.css','.py','.json']);
      const SKIP_CTX  = new Set(['.git','node_modules','_debug','backups','__pycache__','.vercel','lib','dist','lai','_archive','projects','textures','images','assets']);
      const SCAN_DIRS = new Set(['app','js','src','api']);
      async function scanNewer(dir, depth) {
        if (depth > 2 || stale) return;
        for await (const [n, h] of dir.entries()) {
          if (stale) return;
          if (h.kind === 'file') { const ext = n.includes('.') ? '.' + n.split('.').pop().toLowerCase() : ''; if (SRC_EXTS.has(ext)) { try { if ((await h.getFile()).lastModified > mapFile.lastModified) stale = true; } catch {} } }
          else if (h.kind === 'directory' && !SKIP_CTX.has(n) && !n.startsWith('.')) { if (depth > 0 || SCAN_DIRS.has(n)) { try { await scanNewer(h, depth + 1); } catch {} } }
        }
      }
      try { await scanNewer(handle, 0); } catch {}
      mapStatus = (stale || ageDays >= MAP_STALE_DAYS) ? 'Map: outdated (' + (ageDays === 0 ? 'today' : ageDays + 'd') + ', ' + lines + ' lines)' : 'Map: loaded (' + (ageDays === 0 ? 'today' : ageDays + 'd') + ', ' + lines + ' lines)';
    }
    let slimStatus;
    if (!slimFile) slimStatus = 'Slim: not found';
    else if (mapFile && slimFile.lastModified < mapFile.lastModified) slimStatus = 'Slim: outdated';
    else slimStatus = window._projectContext.slim.includes('\n---') ? 'Slim: loaded' : 'Slim: no tech stack header';
    const briefStatus = window._projectContext.brief ? 'Brief: ready' : 'Brief: not found';
    let funcsStatus = 'Funcs: not found';
    try {
      const ctxDir2 = await handle.getDirectoryHandle('_context');
      for await (const [name, h] of ctxDir2.entries()) {
        if (name === '.funcs' && h.kind === 'file') { const f = await h.getFile(); const ageDays = Math.floor((Date.now() - f.lastModified) / 86400000); funcsStatus = 'Funcs: ready (' + (ageDays === 0 ? 'today' : ageDays + 'd') + ')'; break; }
      }
    } catch {}
    output(mapStatus + '. ' + slimStatus + '. ' + briefStatus + '. ' + funcsStatus + '.');
  }

  // -- generateFuncs --â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  async function generateFuncs(handle, output) {
    output('Rebuilding .funcs from source comments in ' + handle.name + '...');
    const JS_EXTS    = new Set(['.js', '.ts', '.jsx', '.tsx', '.html']);
    const SKIP_DIRS  = new Set(['.git', 'node_modules', '_debug', 'backups', '__pycache__',
                                 'lib', 'dist', 'build', '.vercel', 'lai', '_archive']);
    // Skip known third-party library files by name regardless of location
    const SKIP_FILES = new Set(['three.module.js', 'OrbitControls.js', 'mammoth.min.js',
                                 'pdf.min.js', 'xlsx.full.min.js']);
    const MAX_SIZE   = 80 * 1024; // skip files over 80 KB -- libraries are large
    // Multiline + line-anchor regex: only matches function declarations at the start of a
    // line (after optional whitespace), never inside string literals or comment lines.
    // [^)\/\n]* in params: bans / (blocks // comments) and newlines from params.
    const FUNC_RE    = /^[ \t]*(?:export[ \t]+)?(?:async[ \t]+)?function[ \t]+(\w+)[ \t]*\(([^)\/\n]*)\)/mg;
    const sections   = [];
    async function scanFile(fileHandle, path) {
      const name   = path.split('/').pop();
      if (SKIP_FILES.has(name)) return;
      const ext    = path.includes('.') ? '.' + path.split('.').pop().toLowerCase() : '';
      if (!JS_EXTS.has(ext)) return;
      const file = await fileHandle.getFile();
      if (file.size > MAX_SIZE) return;
      const content = await file.text();
      const lines   = content.split('\n');
      FUNC_RE.lastIndex = 0;
      const funcs = [];
      let m;
      while ((m = FUNC_RE.exec(content)) !== null) {
        const nm = m[1];
        if (!nm || nm === 'function') continue;
        const lineIdx     = content.slice(0, m.index).split('\n').length - 1;
        const rawParams   = m[2].split('{')[0].trim();
        const cleanParams = rawParams
          ? rawParams.split(',').map(p => p.trim().split(/[=\s]/)[0]).filter(p => p && !p.includes('/')).join(', ')
          : '';
        let desc = '';
        for (let i = lineIdx - 1; i >= Math.max(0, lineIdx - 4); i--) {
          const l = (lines[i] || '').trim(); if (!l) continue;
          if (l.startsWith('//') || l.startsWith('*') || l.startsWith('/*'))
            desc = l.replace(/^\/\/+\s*/, '').replace(/^\/\*+\s*/, '').replace(/\*\/\s*$/, '').trim();
          break;
        }
        funcs.push(nm + '(' + cleanParams + ')' + (desc ? '  --  ' + desc : ''));
      }
      if (funcs.length > 0) sections.push({ path, sizeKB: (file.size / 1024).toFixed(0), funcs });
    }
    async function walk(dirHandle, basePath) {
      for await (const [name, h] of dirHandle.entries()) {
        if (SKIP_DIRS.has(name) || name.startsWith('.')) continue;
        const fullPath = basePath ? basePath + '/' + name : name;
        if (h.kind === 'directory') await walk(h, fullPath);
        else { try { await scanFile(h, fullPath); } catch {} }
      }
    }
    await walk(handle, '');
    if (!sections.length) { output('No functions found.'); return null; }
    const now = new Date();
    const stamp = now.toLocaleDateString('en-AU', { day:'numeric', month:'short', year:'numeric' }) + '  ' + now.toLocaleTimeString('en-AU', { hour:'numeric', minute:'2-digit', hour12:true });
    const lines = ['# ' + handle.name + ' -- function index', '# Generated: ' + stamp, ''];
    sections.sort((a, b) => a.path.localeCompare(b.path));
    for (const s of sections) { lines.push('## ' + s.path + '  (' + s.sizeKB + ' KB)'); s.funcs.forEach(f => lines.push('  ' + f)); lines.push(''); }
    const text = lines.join('\n');
    try {
      const ctxDir = await handle.getDirectoryHandle('_context', { create: true });
      const fh = await ctxDir.getFileHandle('.funcs', { create: true }); const w = await fh.createWritable(); await w.write(text); await w.close();
      const total = sections.reduce((a, s) => a + s.funcs.length, 0);
      if (window._projectContext) window._projectContext.funcs = text;
      output('.funcs rebuilt -- ' + sections.length + ' files, ' + total + ' functions. See panel.');
      if (window.panel) window.panel.open('.funcs', text, 'output'); return text;
    } catch (err) { output('Error writing .funcs: ' + err.message); return null; }
  }

  async function handleProjectFuncs(args, output) {
    if (!await window.ensureAccess(output)) return;
    const handle = window.getRootHandle(); const arg = (args || '').trim();
    if (!arg || arg === 'regenerate') { await generateFuncs(handle, output); return; }
    await _openInEditPanel(handle, '.funcs', 'Funcs: ' + handle.name); output('Funcs open in panel.');
  }

  async function generateTechStackHeader(handle) {
    try {
      const devDir = await handle.getDirectoryHandle('_dev'); const guideFh = await devDir.getFileHandle('_dev_guide.md');
      const guideText = (await (await guideFh.getFile()).text()).slice(0, 3000);
      const prompt = 'Extract the tech stack and key architecture facts from this developer guide.\nOutput 4-6 short plain-text lines. No headers, no markdown, no bullet points.\nEach line = one complete fact. Example: "Stack: HTML/CSS/JS, Three.js, Vercel/GitHub. No npm."\n\n' + guideText;
      const res  = await fetch('/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: prompt, model: 'gemini-lite' }) });
      return ((await res.json()).reply || '').trim();
    } catch { return ''; }
  }

  async function generateSlimFromMap(handle, mapText, rootName, headerText) {
    const SLIM_EXTS = new Set(['.js','.ts','.html','.css','.py','.json','.md','.bat','.ps1']);
    const lines = mapText.split('\n'); const index = ['# ' + rootName + ' -- file index']; const dirStack = [];
    for (const line of lines) {
      const dirM  = line.match(/^(\s*)\[dir\]\s+(.+?)\/\s*$/);
      const fileM = line.match(/^(\s*)\[file\]\s+(\S+)(?:\s+\([^)]+\))?(?:\s+--\s+(.+))?\s*$/);
      if (dirM) { const depth = Math.floor(dirM[1].length / 2); dirStack.length = depth; dirStack.push(dirM[2].trim()); }
      else if (fileM) {
        const fileDepth = Math.floor(fileM[1].length / 2); dirStack.length = fileDepth;
        const name = fileM[2].trim(); const hint = fileM[3] ? fileM[3].trim() : '';
        const ext = name.includes('.') ? '.' + name.split('.').pop().toLowerCase() : '';
        if (SLIM_EXTS.has(ext)) index.push([...dirStack, name].join('/') + (hint ? '  --  ' + hint : ''));
      }
    }
    const header = (headerText || '').trim();
    const slimText = header ? header + '\n\n---\n' + index.join('\n') : index.join('\n');
    try {
      const ctxDir = await handle.getDirectoryHandle('_context', { create: true });
      const fh = await ctxDir.getFileHandle('.slim', { create: true }); const w = await fh.createWritable(); await w.write(slimText); await w.close();
      window._projectContext.slim = slimText; console.log('[context] .slim written (' + (index.length - 1) + ' files)');
    } catch {}
  }

  // -- Project: Setup --â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Runs all context generation steps in sequence, no gates, fully automatic.
  // Sequence: Map: â†’ Project: Slim â†’ Project: Brief â†’ Project: Funcs â†’ Project: Parse
  // Writes a summary at the end. Designed for session_task auto-fire.

  async function handleProjectSetup(args, output, outputEl) {
    if (!await window.ensureAccess(output)) return;
    const handle  = window.getRootHandle();
    const project = handle.name;
    const results = [];

    output('Project: Setup starting for ' + project + '...');

    // Helper: run a registered command and capture its output
    async function run(cmdKey, cmdArgs, label) {
      const cmd = window.COMMANDS && window.COMMANDS[cmdKey];
      if (!cmd) { results.push('  SKIP ' + label + ' (command not loaded)'); return; }
      output('Running ' + label + '...');
      const msgs = [];
      const cap  = msg => { msgs.push(msg); output(msg); };
      try {
        await cmd.handler(cmdArgs || '', cap, outputEl);
        results.push('  OK   ' + label);
      } catch (err) {
        results.push('  FAIL ' + label + ': ' + err.message);
      }
    }

    // 1. Map
    await run('map', '', 'Map:');
    // Reload map into context so Slim can use it
    if (window._projectContext) {
      try {
        const ctxDir = await handle.getDirectoryHandle('_context');
        for await (const [name, h] of ctxDir.entries()) {
          if (name === '.map') {
            window._projectContext.map = await (await h.getFile()).text();
            break;
          }
        }
      } catch { /* best-effort */ }
    }

    // 2. Slim
    await run('project: slim', '', 'Project: Slim');

    // 3. Brief -- always regenerate so [FILL IN] scaffold is current
    await run('project: brief', 'regenerate', 'Project: Brief');

    // 4. Parse -- scans all functions, generates descriptions, writes .funcs as side effect
    await run('project: parse', '', 'Project: Parse');

    // Summary
    const summary = ['', '-- Setup complete for ' + project + ' --', ...results].join('\n');
    output(summary);

    if (window.appendToLog) {
      window.appendToLog('Project: Setup -- ' + project, [{ model: 'Coder', content: summary }], 'single', '').catch(() => {});
    }
  }

  // -- Self-register --â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  function register() {
    if (!window.COMMANDS) { setTimeout(register, 50); return; }
    window.COMMANDS['project: home']  = { handler: handleProjectHome,  family: 'project', desc: 'Set Coder home folder -- enables chat logging and self-development' };
    window.COMMANDS['project: open']  = { handler: handleProjectOpen,  family: 'project', desc: 'Open a project folder to work on' };
    window.COMMANDS['project: close'] = { handler: handleProjectClose, family: 'project', desc: 'Close the open project and reset target to Home' };
    window.COMMANDS['project: list']  = { handler: handleProjectList,  family: 'project', desc: 'List files in the root of the opened folder' };
    window.COMMANDS['project: find']  = { handler: handleProjectFind,  family: 'project', desc: 'Search files by name or keyword'             };
    window.COMMANDS['project: map']   = { handler: handleProjectMap,   family: 'project', desc: 'Build annotated file tree of the project'    };
    window.COMMANDS['project: scan']  = { handler: handleProjectScan,  family: 'project', desc: 'Rebuild map after file changes'               };
    window.COMMANDS['project: read']  = { handler: handleProjectRead,  family: 'project', desc: 'Read a specific file into context'            };
    window.COMMANDS['project: brief'] = { handler: handleProjectBrief, family: 'project', desc: 'View/edit brief. Auto-generates if missing. Project: Brief regenerate to force rebuild.' };
    window.COMMANDS['project: slim']  = { handler: handleProjectSlim,  family: 'project', desc: 'Generate or view the slim context file'       };
    window.COMMANDS['project: parse'] = { handler: handleProjectParse, family: 'project', desc: 'Find files missing headers, write them'       };
    window.COMMANDS['project: funcs'] = { handler: handleProjectFuncs, family: 'project', desc: 'Generate function index (.funcs) for the open project' };
    window.COMMANDS['project: setup'] = { handler: handleProjectSetup, family: 'project', desc: 'Run all context generation steps in sequence (Map, Slim, Brief, Funcs, Parse)' };
    window.COMMANDS['access'] = { handler: handleProjectOpen,  family: 'project', desc: 'alias -- Project: Open'  };
    window.COMMANDS['list']   = { handler: handleProjectList,  family: 'project', desc: 'alias -- Project: List'  };
    window.COMMANDS['find']   = { handler: handleProjectFind,  family: 'project', desc: 'alias -- Project: Find'  };
    window.setupProjectContext = setupProjectContext;
  }
  register();

})();
