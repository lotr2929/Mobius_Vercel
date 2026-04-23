// js/refine.js -- Query Refiner
// Detects ambiguous queries, rewrites them using prior context + project slim,
// identifies files to attach, shows preview before submitting to task AIs.
// Exposed: window.tryRefineQuery(query) -> { refined, files } or null

(function () {
  'use strict';

  // Phrases that signal the query references prior context
  const AMBIGUITY_PATTERNS = [
    /\bthe answer selected\b/i,
    /\bthe selected\b/i,
    /\bthe fix\b/i,
    /\bthat fix\b/i,
    /\bthe solution\b/i,
    /\bprevious(ly)?\b/i,
    /\bagreed\b/i,
    /\bthe code\b/i,
    /\bimplement.*changes?\b/i,
    /\bapply.*changes?\b/i,
    /\bbased on.*answer\b/i,
    /\bbased on.*above\b/i,
  ];

  function isAmbiguous(query) {
    return AMBIGUITY_PATTERNS.some(p => p.test(query));
  }

  async function callBriefAI(prompt) {
    // Route through existing /ask endpoint using gemini-lite (Brief AI model)
    const res = await fetch('/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gemini-lite', query: prompt }),
      signal: AbortSignal.timeout(20000)
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const d = await res.json();
    return d.reply || d.answer || '';
  }

  // Read a context file from the open project (e.g. _context/brief_benchmark_compass3d.md)
  async function readContextFile(relPath) {
    try {
      const root = window.getRootHandle && window.getRootHandle();
      if (!root) return '';
      const parts = relPath.split('/');
      const name  = parts.pop();
      let dir = root;
      for (const p of parts) dir = await dir.getDirectoryHandle(p);
      const fh   = await dir.getFileHandle(name);
      const file = await fh.getFile();
      return await file.text();
    } catch { return ''; }
  }

  async function tryRefineQuery(rawQuery) {
    if (!isAmbiguous(rawQuery)) return null;

    const prior = window._lastSelectedReply || '';
    const slim  = window._projectContext?.slim || '';
    const brief = window._projectContext?.brief || '';

    if (!prior && !slim && !brief) return null; // nothing to refine with

    // Load benchmark/context docs from project for richer refinement
    const [contextDoc, benchmarkDoc] = await Promise.all([
      readContextFile('_context/.context'),
      readContextFile('_context/brief_benchmark_compass3d.md'),
    ]);

    const prompt = [
      'You are a coding query refiner. Given a vague user query and prior context, produce:',
      '1. A precise, self-contained rewrite of the query with exact file paths, function names,',
      '   and specific changes needed (exact lines/code if available in the context below).',
      '2. A list of source files that must be read to answer the query.',
      '',
      'Respond ONLY in this exact JSON format (no markdown, no extra text):',
      '{"query":"...","files":["path/to/file.js"]}',
      '',
      '--- PRIOR SELECTED RESPONSE ---',
      prior ? prior.slice(0, 2000) : '(none)',
      '',
      '--- SESSION CONTEXT (.context) ---',
      contextDoc ? contextDoc.slice(0, 1000) : '(none)',
      '',
      '--- BENCHMARK / KNOWN FIX ---',
      benchmarkDoc ? benchmarkDoc.slice(0, 2000) : '(none)',
      '',
      '--- PROJECT BRIEF ---',
      brief ? brief.slice(0, 500) : '(none)',
      '',
      '--- PROJECT FILE LIST (slim) ---',
      slim ? slim.slice(0, 800) : '(none)',
      '',
      '--- USER QUERY ---',
      rawQuery,
    ].join('\n');

    try {
      const raw  = await callBriefAI(prompt);
      const json = raw.replace(/```json|```/g, '').trim();
      const obj  = JSON.parse(json);
      if (obj.query && Array.isArray(obj.files)) return obj;
    } catch (e) {
      console.warn('[refine] Failed to parse AI response:', e);
    }
    return null;
  }

  // Read a file from the open project folder by relative path
  async function readProjectFile(relPath) {
    const root = window.getRootHandle && window.getRootHandle();
    if (!root) return null;
    try {
      const parts = relPath.split('/');
      const name  = parts.pop();
      let   dir   = root;
      for (const p of parts) dir = await dir.getDirectoryHandle(p);
      const fh   = await dir.getFileHandle(name);
      const file = await fh.getFile();
      return { name, file };
    } catch { return null; }
  }

  // Auto-attach files to window._attachedFiles (used by all.js buildContext)
  async function attachFiles(filePaths) {
    const attached = [];
    for (const fp of filePaths) {
      const result = await readProjectFile(fp);
      if (result) attached.push(result.file);
    }
    if (attached.length) {
      window._attachedFiles = attached;
      window._attachedFile  = attached[0]; // backward compat
    }
    return attached;
  }

  window.tryRefineQuery = tryRefineQuery;
  window.attachProjectFiles = attachFiles;

})();
