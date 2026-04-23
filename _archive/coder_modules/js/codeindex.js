// js/codeindex.js -- Code Index client
// Commands: Project: Index, Project: Index status, Project: Index clear
// Exposes: window.getCodeContext(query) for pre-query injection
// Two-stage RAG: file summaries (routing) + code chunks (actual code injection)

(function () {
  'use strict';

  // -- API helper ---------------------------------------------------------------

  async function idxAPI(sub, body) {
    const userId = window.getAuth ? window.getAuth('mobius_user_id') : null;
    const res = await fetch('/codeindex', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ sub, userId, ...body })
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  // -- File filter --------------------------------------------------------------

  const NAMED_FILES = ['vercel.json', 'mcp.json', 'package.json', 'CLAUDE.md'];
  const INDEX_EXTS  = ['js', 'html', 'md'];
  const SKIP_DIRS   = ['node_modules', 'backups', 'chats', '.git', '_debug'];

  function shouldIndex(name) {
    if (NAMED_FILES.includes(name)) return true;
    const ext = (name.split('.').pop() || '').toLowerCase();
    return INDEX_EXTS.includes(ext);
  }

  function shouldSkipDir(name) {
    return SKIP_DIRS.includes(name) || name.startsWith('.');
  }

  // -- Walk directory tree ------------------------------------------------------

  async function walkDir(dirHandle, basePath, files) {
    for await (const [name, handle] of dirHandle.entries()) {
      if (handle.kind === 'directory') {
        if (!shouldSkipDir(name)) await walkDir(handle, basePath + name + '/', files);
      } else if (handle.kind === 'file' && shouldIndex(name)) {
        files.push({ name, path: basePath + name, handle });
      }
    }
  }

  // -- Find file by name (recursive) -------------------------------------------
  // Exposed for use by memory.js Distil command.

  async function findFile(dirHandle, filename) {
    for await (const [name, handle] of dirHandle.entries()) {
      if (handle.kind === 'file' && name.toLowerCase() === filename.toLowerCase()) return handle;
      if (handle.kind === 'directory' && !shouldSkipDir(name)) {
        const found = await findFile(handle, filename);
        if (found) return found;
      }
    }
    return null;
  }
  window._findFileInProject = findFile;

  // -- parseChunks -------------------------------------------------------------
  // Client-side parser: splits a file into named chunks (functions / sections).
  // No server cost -- runs in the browser before sending to chunk-file.

  function parseChunks(content, filePath) {
    const ext    = (filePath.split('.').pop() || '').toLowerCase();
    const chunks = [];
    const lines  = content.split('\n');

    if (ext === 'js') {
      // Match top-level functions: function foo(, async function foo(,
      // export function foo(, export async function foo(,
      // const foo = function(, const foo = async (
      const funcPat = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(|^(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?(?:function|\()/;
      let current = null;
      let depth   = 0;

      for (let i = 0; i < lines.length; i++) {
        const line  = lines[i];
        const match = line.match(funcPat);

        if (match && depth === 0) {
          if (current) {
            current.endLine = i - 1;
            current.code    = lines.slice(current.startLine, i).join('\n');
            if (current.code.trim()) chunks.push(current);
          }
          current = { name: match[1] || match[2], type: 'function', startLine: i };
          depth   = 0;
        }

        if (current) {
          for (const ch of line) {
            if (ch === '{') depth++;
            else if (ch === '}') depth--;
          }
          if (depth === 0 && i > current.startLine) {
            current.endLine = i;
            current.code    = lines.slice(current.startLine, i + 1).join('\n');
            if (current.code.trim()) chunks.push(current);
            current = null;
          }
        }
      }
      if (current) {
        current.endLine = lines.length - 1;
        current.code    = lines.slice(current.startLine).join('\n');
        if (current.code.trim()) chunks.push(current);
      }

    } else if (ext === 'md') {
      let current = null;
      for (let i = 0; i < lines.length; i++) {
        const h = lines[i].match(/^#{1,3}\s+(.+)/);
        if (h) {
          if (current) {
            current.endLine = i - 1;
            current.code    = lines.slice(current.startLine, i).join('\n').slice(0, 2000);
            if (current.code.trim()) chunks.push(current);
          }
          current = { name: h[1].trim(), type: 'section', startLine: i };
        }
      }
      if (current) {
        current.endLine = lines.length - 1;
        current.code    = lines.slice(current.startLine).join('\n').slice(0, 2000);
        if (current.code.trim()) chunks.push(current);
      }

    } else {
      // HTML and others: one chunk per file, capped at 3000 chars
      chunks.push({
        name: filePath, type: 'file',
        startLine: 0, endLine: lines.length - 1,
        code: content.slice(0, 3000)
      });
    }

    return chunks;
  }

  // -- getCodeContext -----------------------------------------------------------
  // Two-stage RAG:
  //   Stage 1 -- file summaries (routing, ~90 tokens)
  //   Stage 2 -- chunk search  (actual code, ~750 tokens)

  window.getCodeContext = async function (query) {
    // Use _indexedProject if set (after explicit index run),
    // otherwise fall back to the open project handle name.
    // This means the index is used automatically after Project: Open
    // without needing to re-run Project: Index every session.
    let project = window._indexedProject;
    if (!project) {
      const h = window.getTargetHandle
        ? window.getTargetHandle()
        : (window.getRootHandle ? window.getRootHandle() : null);
      if (h) project = h.name;
    }
    if (!project || !query) return '';
    try {
      const [fileData, chunkData] = await Promise.all([
        idxAPI('index-search', { project, query }),
        idxAPI('chunk-search', { project, query })
      ]);

      const fileParts  = (fileData.files   || []).slice(0, 3)
        .map(f => '  [' + f.file_path + '] ' + (f.summary || ''));
      const chunkParts = (chunkData.chunks || [])
        .map(c => '// ' + c.file_path + ' -- ' + c.chunk_name
          + ' (line ' + c.start_line + ')\n' + c.code);

      const parts = [];
      if (fileParts.length)  parts.push('[Relevant files]\n'  + fileParts.join('\n'));
      if (chunkParts.length) parts.push('[Relevant code]\n'   + chunkParts.join('\n\n'));
      return parts.join('\n\n');
    } catch { return ''; }
  };

  // -- Project: Index -----------------------------------------------------------

  window.COMMANDS['project: index'] = {
    desc: 'Project: Index [status|clear] -- build or manage the semantic code index for the open project',
    handler: async function (args, output) {
      // Use rootHandle (set by Project: Open) -- the project being worked on.
      // coderRootHandle is Coder's own repo and must not be used here.
      const handle = window.getTargetHandle ? window.getTargetHandle() : (window.getRootHandle ? window.getRootHandle() : null);
      if (!handle) {
        output('No project open. Run Project: Open or Project: Home first, then Project: Index.');
        return;
      }

      const project = handle.name;
      const sub     = (args || '').trim().toLowerCase();

      // -- status ---------------------------------------------------------------
      if (sub === 'status') {
        output('Fetching index status for ' + project + '...');
        try {
          const data  = await idxAPI('index-list', { project });
          const files = data.files || [];
          if (!files.length) {
            output(project + ' has no code index. Run Project: Index to build it.');
            return;
          }
          const lines = files.map(f => '  ' + f.file_path + ' (' + (f.line_count || 0) + ' lines)');
          output(files.length + ' files indexed for ' + project + ':\n' + lines.join('\n'));
        } catch (err) { output('Error: ' + err.message); }
        return;
      }

      // -- clear ----------------------------------------------------------------
      if (sub === 'clear') {
        output('Clearing code index for ' + project + '...');
        try {
          await Promise.all([
            idxAPI('index-clear', { project }),
            idxAPI('chunk-clear', { project })
          ]);
          window._indexedProject = null;
          output('Code index and chunks cleared for ' + project + '.');
        } catch (err) { output('Error: ' + err.message); }
        return;
      }

      // -- full index -----------------------------------------------------------
      output('Scanning ' + project + ' for .js / .html / .md files...');
      const files = [];
      try {
        await walkDir(handle, '', files);
      } catch (err) {
        output('Error scanning directory: ' + err.message);
        return;
      }
      if (!files.length) { output('No indexable files found.'); return; }
      await _indexFiles(files, project, output);
    }
  };

  // -- Shared indexing loop (full or partial) -----------------------------------
  // Exposed as window.indexFileList for partial re-index from checkAndRestoreIndex.

  async function _indexFiles(files, project, output) {
    output('Indexing ' + files.length + ' file(s) for ' + project + '...\n(One Gemini call per file.)');
    let done = 0, failed = 0, chunksTotal = 0;
    const start = Date.now();
    for (const f of files) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(0);
      const n       = done + failed;
      const etaStr  = n > 0
        ? ' | ~' + Math.ceil(((Date.now() - start) / n) * (files.length - n) / 1000) + 's left'
        : '';
      output('(' + (n + 1) + '/' + files.length + ') ' + f.path + '  [' + elapsed + 's' + etaStr + ']');
      try {
        const file    = await f.handle.getFile();
        const content = await file.text();
        await idxAPI('index-file', { project, filePath: f.path, content, lineCount: content.split('\n').length });
        const chunks = parseChunks(content, f.path);
        if (chunks.length) {
          try { const r = await idxAPI('chunk-file', { project, filePath: f.path, chunks }); chunksTotal += r.stored || 0; }
          catch (ce) { console.warn('[Chunk] Failed:', f.path, ce.message); }
        }
        done++;
      } catch (e) { console.warn('[Index] Failed:', f.path, e.message); failed++; }
    }
    const secs = ((Date.now() - start) / 1000).toFixed(0);
    window._indexedProject = project;
    let msg = 'Done. ' + done + ' file(s) indexed in ' + secs + 's (' + chunksTotal + ' code chunks stored).';
    if (failed) msg += ' ' + failed + ' failed (see console).';
    output(msg);
  }

  window.indexFileList = _indexFiles;

})();
