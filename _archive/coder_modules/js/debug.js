// ── js/debug.js ───────────────────────────────────────────────────────────────
// Debug: pipeline -- structured 5-step fault resolution.
// State held in window.debugState between steps.
//
// Step 1  Debug: [error]      Triage (Groq) -- identify files, classify fault
// Step 2  Debug: Diagnose     Deep diagnosis (Gemini) -- read files, find root cause
// Step 3  Debug: Propose      Propose fix (Gemini) -- plain English fix plan
// Step 4  Debug: Sandbox      Write fix to _debug/fix/ (Codestral) -- real files untouched
// Step 5  Debug: Promote      Promote to real file -- requires CONFIRM
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  // ── State ─────────────────────────────────────────────────────────────────

  function initState(errorText) {
    window.debugState = {
      step:         1,
      errorText:    errorText,
      triage:       null,
      fileContents: {},
      diagnosis:    null,
      proposal:     null,
      sandbox:      null
    };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  async function readFile(relPath) {
    const handle = window.getRootHandle ? window.getRootHandle() : null;
    if (!handle) return null;
    try {
      const parts = relPath.replace(/\\/g, '/').split('/');
      let current = handle;
      for (const part of parts) {
        let found = false;
        for await (const [name, h] of current.entries()) {
          if (name === part) { current = h; found = true; break; }
        }
        if (!found) return null;
      }
      if (current.kind !== 'file') return null;
      return await (await current.getFile()).text();
    } catch { return null; }
  }

  async function writeFile(relPath, content, createIfMissing) {
    const handle = window.getRootHandle ? window.getRootHandle() : null;
    if (!handle) return false;
    try {
      const parts = relPath.replace(/\\/g, '/').split('/');
      let current = handle;
      for (let i = 0; i < parts.length - 1; i++) {
        current = await current.getDirectoryHandle(parts[i], { create: createIfMissing });
      }
      const fh = await current.getFileHandle(parts[parts.length - 1], { create: createIfMissing });
      const w  = await fh.createWritable();
      await w.write(content);
      await w.close();
      return true;
    } catch { return false; }
  }

  function parseJSON(text) {
    try {
      const clean = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      return JSON.parse(clean);
    } catch { return null; }
  }

  function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function stepBar(current) {
    const steps = ['Triage', 'Diagnose', 'Propose', 'Sandbox', 'Promote'];
    return steps.map((label, i) => {
      const n   = i + 1;
      const col = n < current ? '#4a7c4e' : n === current ? '#a06800' : '#8d7c64';
      const dot = n < current ? '&#x2713;' : n === current ? '&#x25B6;' : '&#x25CB;';
      return '<span style="color:' + col + ';margin-right:12px;font-size:12px;">'
        + dot + ' ' + label + '</span>';
    }).join('');
  }

  function card(step, title, bodyHtml, nextHint) {
    return '<div style="font-size:13px;">'
      + '<div style="margin-bottom:8px;">' + stepBar(step) + '</div>'
      + '<div style="font-weight:bold;margin-bottom:8px;">' + title + '</div>'
      + bodyHtml
      + (nextHint ? '<div style="margin-top:10px;color:var(--text-dim);">' + nextHint + '</div>' : '')
      + '</div>';
  }

  // ── Step 1: Debug: [error] -- Triage ─────────────────────────────────────

  async function handleDebug(args, output, outputEl) {
    if (!args.trim()) {
      output('Usage: Debug: [paste error message and/or describe the problem]');
      return;
    }

    initState(args.trim());

    const logSummary = await readFile('_context/log_summary.md');

    const prompt = 'You are triaging a bug. Respond ONLY with valid JSON, no markdown fences.\n\n'
      + 'Error:\n' + args.trim()
      + (logSummary ? '\n\nRecent activity (log_summary):\n' + logSummary.slice(0, 1000) : '')
      + '\n\nRespond with:\n'
      + '{"type":"logic|syntax|runtime|config|network|unknown",'
      + '"files":["file1.js"],'
      + '"confidence":"high|medium|low",'
      + '"knownPattern":false,'
      + '"summary":"one sentence plain English cause"}';

    output('Triaging...');
    try {
      const res  = await fetch('/ask', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: prompt, model: 'groq', userId: window.getAuth('mobius_user_id') })
      });
      const data   = await res.json();
      const triage = parseJSON(data.reply || data.answer || '');

      if (!triage) {
        outputEl.classList.add('html-content');
        outputEl.innerHTML = card(1, 'Triage -- raw response',
          '<pre style="font-size:12px;white-space:pre-wrap;">' + esc(data.reply || '') + '</pre>',
          'Could not parse as JSON. Paste the error again or try Ask: Groq to inspect manually.');
        return;
      }

      window.debugState.triage = triage;
      window.debugState.step   = 2;

      const files = (triage.files || []).map(f => '<code>' + esc(f) + '</code>').join(', ') || 'none identified';
      outputEl.classList.add('html-content');
      outputEl.innerHTML = card(1, 'Triage complete',
        '<div><strong>Summary:</strong> ' + esc(triage.summary) + '</div>'
        + '<div style="margin-top:4px;"><strong>Type:</strong> ' + esc(triage.type)
        + ' &nbsp;|&nbsp; <strong>Confidence:</strong> ' + esc(triage.confidence) + '</div>'
        + '<div style="margin-top:4px;"><strong>Files:</strong> ' + files + '</div>',
        'Correct the file list above if needed, then type <strong>Debug: Diagnose</strong>.');
      document.getElementById('input').value = '';
    } catch (err) {
      output('Triage failed: ' + err.message);
    }
  }

  // ── Step 2: Debug: Diagnose ───────────────────────────────────────────────

  async function handleDebugDiagnose(args, output, outputEl) {
    if (!window.debugState || !window.debugState.triage) {
      output('Run Debug: [error] first to triage the problem.');
      return;
    }

    const triage = window.debugState.triage;
    output('Reading files...');

    const fileContents = {};
    for (const f of (triage.files || [])) {
      const content = await readFile(f);
      if (content) fileContents[f] = content;
    }
    window.debugState.fileContents = fileContents;

    const fileBlock = Object.entries(fileContents)
      .map(([name, c]) => '// ' + name + '\n' + c.slice(0, 3000))
      .join('\n\n---\n\n') || 'No file contents available.';

    const prompt = 'You are diagnosing a bug. Respond ONLY with valid JSON, no markdown fences.\n\n'
      + 'Triage: ' + JSON.stringify(triage) + '\n\n'
      + 'Error: ' + window.debugState.errorText + '\n\n'
      + 'Files:\n' + fileBlock + '\n\n'
      + 'Respond with:\n'
      + '{"rootCause":"exact description",'
      + '"file":"filename.js",'
      + '"lineHint":"line number or description",'
      + '"confidence":"high|medium|low",'
      + '"explanation":"plain English for the developer"}';

    output('Diagnosing...');
    try {
      const res      = await fetch('/ask', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: prompt, model: 'gemini', userId: window.getAuth('mobius_user_id') })
      });
      const data      = await res.json();
      const diagnosis = parseJSON(data.reply || data.answer || '');

      if (!diagnosis) {
        outputEl.classList.add('html-content');
        outputEl.innerHTML = card(2, 'Diagnosis -- raw response',
          '<pre style="font-size:12px;white-space:pre-wrap;">' + esc(data.reply || '') + '</pre>', '');
        return;
      }

      window.debugState.diagnosis = diagnosis;
      window.debugState.step      = 3;

      outputEl.classList.add('html-content');
      outputEl.innerHTML = card(2, 'Diagnosis complete',
        '<div><strong>Root cause:</strong> ' + esc(diagnosis.rootCause) + '</div>'
        + '<div style="margin-top:4px;"><strong>File:</strong> <code>' + esc(diagnosis.file) + '</code>'
        + ' &nbsp;|&nbsp; <strong>Where:</strong> ' + esc(diagnosis.lineHint) + '</div>'
        + '<div style="margin-top:4px;"><strong>Explanation:</strong> ' + esc(diagnosis.explanation) + '</div>'
        + '<div style="margin-top:4px;"><strong>Confidence:</strong> ' + esc(diagnosis.confidence) + '</div>',
        'Type <strong>Debug: Propose</strong> to continue.');
      document.getElementById('input').value = '';
    } catch (err) {
      output('Diagnosis failed: ' + err.message);
    }
  }

  // ── Step 3: Debug: Propose ────────────────────────────────────────────────

  async function handleDebugPropose(args, output, outputEl) {
    if (!window.debugState || !window.debugState.diagnosis) {
      output('Run Debug: Diagnose first.');
      return;
    }

    const diagnosis   = window.debugState.diagnosis;
    const fileContent = (window.debugState.fileContents || {})[diagnosis.file] || '';

    const prompt = 'You are proposing a code fix. Respond ONLY with valid JSON, no markdown fences.\n\n'
      + 'Diagnosis: ' + JSON.stringify(diagnosis) + '\n\n'
      + (fileContent ? 'File (' + diagnosis.file + '):\n' + fileContent.slice(0, 3000) + '\n\n' : '')
      + 'Respond with:\n'
      + '{"changes":["change 1","change 2"],'
      + '"filesAffected":["file.js"],'
      + '"risk":"low|medium|high",'
      + '"summary":"plain English description of the fix"}';

    output('Proposing fix...');
    try {
      const res      = await fetch('/ask', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: prompt, model: 'gemini', userId: window.getAuth('mobius_user_id') })
      });
      const data     = await res.json();
      const proposal = parseJSON(data.reply || data.answer || '');

      if (!proposal) {
        outputEl.classList.add('html-content');
        outputEl.innerHTML = card(3, 'Proposal -- raw response',
          '<pre style="font-size:12px;white-space:pre-wrap;">' + esc(data.reply || '') + '</pre>', '');
        return;
      }

      window.debugState.proposal = proposal;
      window.debugState.step     = 4;

      const changes = (proposal.changes || [])
        .map(c => '<li style="margin:2px 0;">' + esc(c) + '</li>').join('');

      outputEl.classList.add('html-content');
      outputEl.innerHTML = card(3, 'Proposal ready',
        '<div><strong>Summary:</strong> ' + esc(proposal.summary) + '</div>'
        + '<div style="margin-top:6px;"><strong>Changes:</strong>'
        + '<ul style="margin:4px 0 4px 18px;padding:0;">' + changes + '</ul></div>'
        + '<div><strong>Files:</strong> '
        + esc((proposal.filesAffected || []).join(', ')) + '</div>'
        + '<div style="margin-top:4px;"><strong>Risk:</strong> ' + esc(proposal.risk) + '</div>',
        'Type <strong>Debug: Sandbox</strong> to write the fix to _debug/fix/ (real files untouched).');
      document.getElementById('input').value = '';
    } catch (err) {
      output('Proposal failed: ' + err.message);
    }
  }

  // ── Step 4: Debug: Sandbox ────────────────────────────────────────────────

  async function handleDebugSandbox(args, output, outputEl) {
    if (!window.debugState || !window.debugState.proposal) {
      output('Run Debug: Propose first.');
      return;
    }

    const proposal    = window.debugState.proposal;
    const diagnosis   = window.debugState.diagnosis;
    const targetFile  = diagnosis.file;
    const fileContent = (window.debugState.fileContents || {})[targetFile] || '';

    const prompt = 'You are writing a code fix. Output ONLY the complete fixed file content. '
      + 'No explanation. No markdown fences. No truncation.\n\n'
      + 'Proposal: ' + JSON.stringify(proposal) + '\n\n'
      + 'Current file (' + targetFile + '):\n' + fileContent + '\n\n'
      + 'Write the complete fixed ' + targetFile + ':';

    output('Writing fix...');
    try {
      const res  = await fetch('/ask', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: prompt, model: 'mistral', userId: window.getAuth('mobius_user_id') })
      });
      const data         = await res.json();
      const rawContent   = data.reply || data.answer || '';
      const fixedContent = rawContent
        .replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '').trim();

      window.debugState.sandbox = { file: targetFile, content: fixedContent };
      window.debugState.step    = 5;

      // Write to _debug/fix/[filename]
      const sandboxPath = '_debug/fix/' + targetFile.split('/').pop();
      const wrote       = await writeFile(sandboxPath, fixedContent, true);

      if (wrote) {
        outputEl.classList.add('html-content');
        outputEl.innerHTML = card(4, 'Sandbox complete',
          '<div>Fix written to <code>' + esc(sandboxPath) + '</code></div>'
          + '<div style="margin-top:4px;">Real file <strong>' + esc(targetFile) + '</strong> is untouched.</div>',
          'Type <strong>Debug: Promote CONFIRM</strong> to overwrite the real file.');
      } else {
        // No folder access -- show in panel
        if (window.panel) window.panel.open('Sandbox: ' + targetFile, fixedContent, 'code');
        outputEl.classList.add('html-content');
        outputEl.innerHTML = card(4, 'Sandbox complete (panel only)',
          '<div>Could not write to _debug/fix/ (no folder open). Fix shown in panel.</div>'
          + '<div style="margin-top:4px;">Review the panel, copy manually to <strong>'
          + esc(targetFile) + '</strong> when ready.</div>', '');
      }
      document.getElementById('input').value = '';
    } catch (err) {
      output('Sandbox failed: ' + err.message);
    }
  }

  // ── Step 5: Debug: Promote ────────────────────────────────────────────────

  async function handleDebugPromote(args, output, outputEl) {
    if (!window.debugState || !window.debugState.sandbox) {
      output('Run Debug: Sandbox first.');
      return;
    }

    const { file, content } = window.debugState.sandbox;

    if ((args || '').trim().toUpperCase() !== 'CONFIRM') {
      outputEl.classList.add('html-content');
      outputEl.innerHTML = card(5, '&#x26A0; Promote -- confirm required',
        '<div style="color:var(--red);margin-bottom:6px;">This will overwrite: <strong>'
        + esc(file) + '</strong></div>'
        + '<div>Ensure <strong>Deploy: Backup</strong> has run this session before promoting.</div>',
        'Type <strong>Debug: Promote CONFIRM</strong> (in capitals) to proceed.');
      document.getElementById('input').value = '';
      return;
    }

    if (!window.getRootHandle || !window.getRootHandle()) {
      output('No folder open. Run Project: Open first.');
      return;
    }

    output('Promoting ' + file + '...');
    try {
      const wrote = await writeFile(file, content, false);
      if (!wrote) throw new Error('Write failed -- file may not exist at this path');

      window.debugState.step = 6;

      outputEl.classList.add('html-content');
      outputEl.innerHTML = card(5, '&#x2705; Promoted',
        '<div><strong>' + esc(file) + '</strong> has been updated.</div>',
        'Run <strong>Deploy: Commit</strong> then <strong>Deploy: Push</strong> to ship.');
      document.getElementById('input').value = '';
    } catch (err) {
      output('Promote failed: ' + err.message);
    }
  }

  // ── Self-register ──────────────────────────────────────────────────────────

  function register() {
    if (!window.COMMANDS) { setTimeout(register, 50); return; }
    window.COMMANDS['debug']           = { handler: handleDebug,          family: 'debug', desc: 'Step 1 -- triage error (Groq)',               needs: [],            produces: ['triage'],    gate: true  };
    window.COMMANDS['debug: diagnose'] = { handler: handleDebugDiagnose,  family: 'debug', desc: 'Step 2 -- diagnose affected files (Gemini)',   needs: ['triage'],    produces: ['diagnosis'], gate: true  };
    window.COMMANDS['debug: propose']  = { handler: handleDebugPropose,   family: 'debug', desc: 'Step 3 -- propose fix in plain English',       needs: ['diagnosis'], produces: ['proposal'],  gate: true  };
    window.COMMANDS['debug: sandbox']  = { handler: handleDebugSandbox,   family: 'debug', desc: 'Step 4 -- write fix to _debug/fix/ only',      needs: ['proposal'],  produces: ['sandbox'],   gate: false };
    window.COMMANDS['debug: promote']  = { handler: handleDebugPromote,   family: 'debug', desc: 'Step 5 -- promote to real file (CONFIRM)',     needs: ['sandbox'],   produces: [],            gate: true  };
  }
  register();

  window.getDebugState   = function () { return window.debugState || null; };
  window.clearDebugState = function () { window.debugState = null; };

})();
