// js/memory.js -- Mobius Memory System (client-side)
// Registers the Memory: command family.
// Exposes window.getMemoryContext(query) -- called by sendToAI before every query.
// Exposes window.autoExtractMemory(query, reply) -- called after every AI response.

(function () {
  'use strict';

  // ── API helper ───────────────────────────────────────────────────────────────

  async function memAPI(sub, body) {
    const userId = window.getAuth ? window.getAuth('mobius_user_id') : null;
    const res = await fetch('/memory', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ sub, userId, ...body })
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  // ── Context injection ────────────────────────────────────────────────────────
  // Called by sendToAI in commands.js before building the final query.
  // Returns a string block or '' -- never throws.

  window.getMemoryContext = async function (query) {
    try {
      const data = await memAPI('search', { query: query || '' });
      return data.result || '';
    } catch {
      return '';
    }
  };

  // ── Auto-extract ─────────────────────────────────────────────────────────────
  // Fire-and-forget after every AI response. Writes raw exchange to memory_general.
  // Distil pass later classifies it into working tables.

  window.autoExtractMemory = function (query, reply) {
    const userId = window.getAuth ? window.getAuth('mobius_user_id') : null;
    if (!userId) return;
    const content = 'Q: ' + (query || '').slice(0, 600) + '\nA: ' + (reply || '').slice(0, 1200);
    memAPI('write', { content, source: 'auto' }).catch(() => {});
  };

  // ── Helpers ──────────────────────────────────────────────────────────────────

  function showInPanel(title, html, outputEl) {
    if (window.panel) {
      window.panel.open(title, html, 'html');
      outputEl.classList.add('html-content');
      outputEl.innerHTML = '<span style="font-size:13px;color:var(--text-dim);">'
        + title + ' shown in panel.</span>';
    } else {
      outputEl.classList.add('html-content');
      outputEl.innerHTML = html;
    }
  }

  // -- Memory: View ------------------------------------------------------------
  // Renders as HTML string with data attributes, then attaches event delegation
  // after panel insert -- avoids the outerHTML-strips-listeners bug.
  // Buttons: edit (pencil/tick), copy UUID, delete.

  window.COMMANDS['memory: view'] = {
    desc: 'Memory: View [table|topic] -- show all, or filter by table name or keyword',
    handler: async function (args, output, outputEl) {
      const filter    = (args || '').trim().toLowerCase();
      const tableNames = ['user', 'tools', 'project', 'mobius'];
      const tableFilter = tableNames.includes(filter) ? filter : null;
      const keyword     = (!tableFilter && filter) ? filter : null;
      const title = filter ? 'Memory: View -- ' + filter : 'Memory: View';
      output('Loading memories...');
      try {
        const { user, tools, project, mobius } = await memAPI('view', {});
        const total = (user || []).length + (tools || []).length + (project || []).length + (mobius || []).length;
        // Get real counts from server (not capped by view limit)
        let realCounts = null;
        try { realCounts = await memAPI('count', {}); } catch {}
        const totalLabel = realCounts
          ? realCounts.total + ' total: ' + realCounts.user + ' user, ' + realCounts.tools + ' tools, ' + realCounts.project + ' project, ' + realCounts.mobius + ' mobius'
          : total + ' shown';
        const containerId = 'mem-view-' + Date.now();
        const titleWithCount = (filter ? 'Memory: View -- ' + filter : 'Memory: View') + ' (' + totalLabel + ')';
        const btnStyle = 'background:transparent;border:none;cursor:pointer;color:var(--text-dim);padding:2px 4px;flex-shrink:0;font-size:14px;line-height:1;';

        function applyFilter(entries, appKey) {
          if (tableFilter) return entries; // already section-filtered below
          if (!keyword) return entries;
          return entries.filter(function (e) {
            var hay = ((e.content || '') + ' ' + (e.tags || []).join(' ') + ' ' + ((e[appKey] || []).join(' '))).toLowerCase();
            return hay.includes(keyword);
          });
        }

        var sections = {
          user:    tableFilter && tableFilter !== 'user'    ? [] : applyFilter(user,           'project_ids'),
          tools:   tableFilter && tableFilter !== 'tools'   ? [] : applyFilter(tools,          'project_ids'),
          project: tableFilter && tableFilter !== 'project' ? [] : applyFilter(project,        'project_ids'),
          mobius:  tableFilter && tableFilter !== 'mobius'  ? [] : applyFilter(mobius || [],   'app_ids'),
        };

        function buildSection(label, entries, appKey, realTotal) {
          const shown = entries.length;
          const countStr = (realTotal && realTotal > shown) ? shown + ' of ' + realTotal : shown;
          let html = '<h3 style="margin:0 0 6px;color:var(--accent2);">' + esc(label) + ' (' + countStr + ')</h3>';
          if (!entries.length) {
            return html + '<p style="color:var(--text-dim);font-style:italic;margin:0 0 16px;">None yet.</p>';
          }
          html += '<ul style="list-style:none;padding:0;margin:0 0 20px;">';
          for (const e of entries) {
            const ids = e[appKey || 'project_ids'] || [];
            const proj = ids.length ? ' | ' + esc(ids.join(', ')) : '';
            const tags = esc((e.tags || []).join(', '));
            const safeContent = esc(e.content);
            html += '<li data-entry-id="' + e.id + '" style="padding:6px 0;border-bottom:1px solid var(--border);display:flex;align-items:flex-start;gap:8px;">'
              + '<div style="flex:1;min-width:0;">'
              + '<div class="mem-text" style="word-break:break-word;">' + safeContent + '</div>'
              + '<div style="font-size:11px;color:var(--text-dim);margin-top:2px;">' + tags + proj + '</div>'
              + '</div>'
              + '<button data-action="edit" data-id="' + e.id + '" title="Edit" style="' + btnStyle + '">&#9998;</button>'
              + '<button data-action="copy" data-id="' + e.id + '" title="Copy UUID" style="' + btnStyle + '">'
              + '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>'
              + '</button>'
              + '<button data-action="delete" data-id="' + e.id + '" title="Delete" style="' + btnStyle + '">&times;</button>'
              + '</li>';
          }
          html += '</ul>';
          return html;
        }

        const rc = realCounts || {};
        const summaryNote = rc.total
          ? '<div style="font-size:11px;color:var(--text-dim);margin-bottom:12px;">Showing top 15 per table.</div>'
          : '';
        const html = '<div id="' + containerId + '" style="padding:16px;font-size:13px;line-height:1.5;">'
          + summaryNote
          + buildSection('User', sections.user, 'project_ids', rc.user)
          + buildSection('Tools', sections.tools, 'project_ids', rc.tools)
          + buildSection('Project', sections.project, 'project_ids', rc.project)
          + buildSection('Mobius', sections.mobius, 'app_ids', rc.mobius)
          + '</div>';

        if (window.panel) {
          window.panel.open(titleWithCount, html, 'html');
          outputEl.classList.add('html-content');
          outputEl.innerHTML = '<span style="font-size:13px;color:var(--text-dim);">Memory: View shown in panel.</span>';
        } else {
          outputEl.classList.add('html-content');
          outputEl.innerHTML = html;
        }

        // Attach event delegation after panel renders.
        // Uses container ID so listener is scoped and never duplicated.
        setTimeout(function () {
          const container = document.getElementById(containerId);
          if (!container) return;
          container.addEventListener('click', async function (e) {
            const btn = e.target.closest('[data-action]');
            if (!btn) return;
            const action = btn.dataset.action;
            const id = btn.dataset.id;
            const li = btn.closest('li');

            if (action === 'copy') {
              navigator.clipboard.writeText(id).then(function () {
                btn.style.color = 'var(--green)';
                setTimeout(function () { btn.style.color = 'var(--text-dim)'; }, 1500);
              });
              return;
            }

            if (action === 'delete') {
              btn.disabled = true;
              btn.style.color = 'var(--red)';
              try {
                const r = await memAPI('delete', { id: id });
                if (r.ok) {
                  li.style.opacity = '0.3';
                  li.style.pointerEvents = 'none';
                  btn.textContent = '\u2713';
                } else {
                  btn.innerHTML = '!';
                  btn.disabled = false;
                }
              } catch {
                btn.innerHTML = '!';
                btn.disabled = false;
              }
              return;
            }

            if (action === 'edit') {
              const textDiv = li.querySelector('.mem-text');
              if (!textDiv) return;
              const current = textDiv.textContent;
              const ta = document.createElement('textarea');
              ta.value = current;
              ta.style.cssText = 'width:100%;font-size:13px;padding:4px;border:1px solid var(--accent2);background:var(--bg);color:var(--text);border-radius:3px;resize:vertical;min-height:60px;box-sizing:border-box;';
              textDiv.replaceWith(ta);
              ta.focus();
              btn.dataset.action = 'save';
              btn.innerHTML = '&#10003;';
              btn.style.color = 'var(--green)';
              return;
            }

            if (action === 'save') {
              const ta = li.querySelector('textarea');
              if (!ta) return;
              const newContent = ta.value.trim();
              if (!newContent) return;
              btn.disabled = true;
              try {
                const r = await memAPI('update', { id: id, content: newContent });
                if (r.ok) {
                  const newDiv = document.createElement('div');
                  newDiv.className = 'mem-text';
                  newDiv.style.wordBreak = 'break-word';
                  newDiv.textContent = newContent;
                  ta.replaceWith(newDiv);
                  btn.dataset.action = 'edit';
                  btn.innerHTML = '&#9998;';
                  btn.style.color = 'var(--text-dim)';
                } else {
                  btn.innerHTML = '!';
                }
              } catch {
                btn.innerHTML = '!';
              }
              btn.disabled = false;
              return;
            }
          });
        }, 150);

      } catch (err) { output('Error: ' + err.message); }
    }
  };

  // ── Memory: Add ──────────────────────────────────────────────────────────────

  window.COMMANDS['memory: add'] = {
    desc: 'Memory: Add [text] -- manually save a memory',
    handler: async function (args, output) {
      const text = (args || '').trim();
      if (!text) { output('Usage: Memory: Add [text to remember]'); return; }
      output('Saving...');
      try {
        const data = await memAPI('add', { content: text });
        const n = data.saved || 1;
        output('Saved ' + n + ' ' + (n === 1 ? 'memory' : 'memories') + (data.table ? ' -- classified as: ' + data.table : ' -- queued for distil') + '.');
      } catch (err) { output('Error: ' + err.message); }
    }
  };

  // ── Memory: Search ───────────────────────────────────────────────────────────

  window.COMMANDS['memory: search'] = {
    desc: 'Memory: Search [query] -- search across all memory tables',
    handler: async function (args, output, outputEl) {
      const text = (args || '').trim();
      if (!text) { output('Usage: Memory: Search [query]'); return; }
      output('Searching...');
      try {
        const data = await memAPI('search', { query: text });
        const result = data.result || '(no results)';
        const html = '<pre style="padding:16px;white-space:pre-wrap;font-size:13px;">'
          + esc(result) + '</pre>';
        showInPanel('Memory: Search', html, outputEl);
      } catch (err) { output('Error: ' + err.message); }
    }
  };

  // ── Memory: Distil ──────────────────────────────────────────────────────────
  // No args: distil last 48h from memory_general.
  // With filename arg: read file, chunk, write to memory_general, then distil.
  // Supported: .md .txt .js .html .css .json .csv .xml .py .docx .pdf .xlsx .xls

  // -- Lazy library loader ----------------------------------------------------
  async function loadScript(id, url) {
    if (document.getElementById(id)) return;
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.id = id; s.src = url;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('Failed to load ' + url)); };
      document.head.appendChild(s);
    });
  }

  // -- Text extraction by format ----------------------------------------------
  async function extractText(fileHandle, filename) {
    var ext  = (filename.split('.').pop() || '').toLowerCase();
    var file = await fileHandle.getFile();
    var TEXT_EXTS = ['md','txt','js','ts','jsx','tsx','html','css','json','csv','xml','py','yaml','yml'];
    if (TEXT_EXTS.includes(ext)) return file.text();

    if (ext === 'docx') {
      await loadScript('mammoth-cdn', 'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js');
      var ab = await file.arrayBuffer();
      var result = await mammoth.extractRawText({ arrayBuffer: ab });
      return result.value;
    }

    if (ext === 'pdf') {
      await loadScript('pdfjs-cdn', 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js');
      pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      var ab2 = await file.arrayBuffer();
      var pdf  = await pdfjsLib.getDocument({ data: ab2 }).promise;
      var text = '';
      for (var i = 1; i <= pdf.numPages; i++) {
        var page    = await pdf.getPage(i);
        var content = await page.getTextContent();
        text += content.items.map(function (item) { return item.str; }).join(' ') + '\n';
      }
      return text;
    }

    if (ext === 'xlsx' || ext === 'xls') {
      await loadScript('sheetjs-cdn', 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js');
      var ab3 = await file.arrayBuffer();
      var wb  = XLSX.read(ab3, { type: 'array' });
      var out = '';
      wb.SheetNames.forEach(function (name) {
        out += '## Sheet: ' + name + '\n';
        out += XLSX.utils.sheet_to_csv(wb.Sheets[name]) + '\n';
      });
      return out;
    }

    throw new Error('Unsupported format: .' + ext + '. Supported: .md .txt .js .html .css .json .csv .xml .py .docx .pdf .xlsx .xls');
  }

  // -- Chunk text into ~1500 char pieces --------------------------------------
  function chunkText(text, maxChars) {
    maxChars = maxChars || 1500;
    var chunks = [];
    var start  = 0;
    while (start < text.length) {
      var end = start + maxChars;
      if (end < text.length) {
        var breakAt = text.lastIndexOf('\n', end);
        if (breakAt > start + 400) { end = breakAt; }
        else {
          var dotAt = text.lastIndexOf('. ', end);
          if (dotAt > start + 400) end = dotAt + 1;
        }
      }
      var chunk = text.slice(start, end).trim();
      if (chunk.length > 80) chunks.push(chunk);
      start = end;
    }
    return chunks;
  }

  // -- Get file handle: search open project first, else file picker -----------
  async function getFileHandle(filename) {
    const projectHandle = window.getTargetHandle ? window.getTargetHandle() : (window.getRootHandle ? window.getRootHandle() : null);
    if (projectHandle && window._findFileInProject) {
      var found = await window._findFileInProject(projectHandle, filename);
      if (found) return found;
    }
    // Fall back to file picker
    if (window.showOpenFilePicker) {
      var picks = await window.showOpenFilePicker({ multiple: false });
      return picks[0];
    }
    throw new Error('File not found and file picker unavailable.');
  }

  window.COMMANDS['memory: distil'] = {
    desc: 'Memory: Distil [filename] -- distil memory_general (no arg) or read a file and distil it',
    handler: async function (args, output) {
      var filename = (args || '').trim();

      // -- No arg: standard pipeline -------------------------------------------
      if (!filename) {
        output('Distilling last 48h from memory_general... (may take 10-20 seconds)');
        try {
          var data = await memAPI('distil', {});
          output(data.message || (data.distilled + ' entries distilled.'));
        } catch (err) { output('Error: ' + err.message); }
        return;
      }

      // -- File arg: read, chunk, write to memory_general, distil --------------
      output('Reading ' + filename + '...');
      var fileHandle;
      try {
        fileHandle = await getFileHandle(filename);
      } catch (err) {
        output('Could not open file: ' + err.message);
        return;
      }

      var text;
      try {
        text = await extractText(fileHandle, fileHandle.name || filename);
      } catch (err) {
        output('Could not extract text: ' + err.message);
        return;
      }

      if (!text || text.trim().length < 50) {
        output('File appears to be empty or could not be read.');
        return;
      }

      var chunks = chunkText(text);
      output('Extracted ' + chunks.length + ' chunks from ' + (fileHandle.name || filename) + '. Writing to memory_general...');

      var written = 0;
      for (var i = 0; i < chunks.length; i++) {
        try {
          await memAPI('write', { content: chunks[i], source: fileHandle.name || filename });
          written++;
        } catch (e) {
          console.warn('[Distil] chunk write failed:', e.message);
        }
      }

      output(written + '/' + chunks.length + ' chunks written. Distilling... (may take 10-20 seconds)');
      try {
        var result = await memAPI('distil', {});
        output(result.message || (result.distilled + ' facts distilled from ' + (fileHandle.name || filename) + '.'));
      } catch (err) { output('Distil error: ' + err.message); }
    }
  };

  // ── Memory: Delete ───────────────────────────────────────────────────────────

  window.COMMANDS['memory: delete'] = {
    desc: 'Memory: Delete [uuid] -- delete a memory by ID',
    handler: async function (args, output) {
      const id = (args || '').trim();
      if (!id) { output('Usage: Memory: Delete [uuid]'); return; }
      output('Deleting...');
      try {
        const data = await memAPI('delete', { id });
        output(data.ok ? 'Deleted.' : 'Not found or permission denied.');
      } catch (err) { output('Error: ' + err.message); }
    }
  };

  // -- Memory: Embed -----------------------------------------------------------
  // Client-side loop -- fetches list of un-embedded rows, then calls embed-one
  // per row. Each server call handles exactly one row, never hits Vercel 10s limit.

  window.COMMANDS['memory: vectorise'] = {
    desc: 'Memory: Vectorise -- generate and store vectors for all un-vectorised rows',
    handler: async function (args, output) {
      output('Fetching rows to embed...');
      try {
        const listData = await memAPI('embed-list', {});
        const rows = listData.rows || [];
        if (rows.length === 0) {
          output('All rows already embedded.');
          return;
        }
        let done = 0;
        let failed = 0;
        let firstError = null;
        for (const row of rows) {
          output('Embedding ' + (done + failed + 1) + ' / ' + rows.length + '...');
          try {
            const r = await memAPI('embed-one', { id: row.id, table: row.table, content: row.content });
            if (r.ok) { done++; } else { failed++; if (!firstError) firstError = r.error || 'unknown'; }
          } catch (e) {
            failed++;
            if (!firstError) firstError = e.message;
          }
        }
        output('Verifying in Supabase...');
        let remaining = 0;
        let totalVectors = 0;
        try {
          const verify = await memAPI('embed-list', {});
          remaining = (verify.rows || []).length;
          const counts = await memAPI('count', {});
          totalVectors = counts.total || 0;
          if (counts.total) {
            const breakdown = ' (user: ' + counts.user + ', tools: ' + counts.tools + ', project: ' + counts.project + ', mobius: ' + counts.mobius + ')';
            totalVectors = counts.total + breakdown;
          }
        } catch {}
        let msg = 'Done -- ' + done + ' embedded';
        if (failed) msg += ', ' + failed + ' failed';
        msg += '. Supabase check: ' + (remaining === 0 ? 'all vectors confirmed.' : remaining + ' rows still missing embeddings.');
        if (totalVectors) msg += ' Total in database: ' + totalVectors + ' rows.';
        if (firstError) msg += ' First error: ' + firstError;
        output(msg);
      } catch (err) { output('Error: ' + err.message); }
    }
  };

  // -- Memory: Clean ------------------------------------------------------------

  window.COMMANDS['memory: clean'] = {
    desc: 'Memory: Clean -- remove duplicate memories (coming soon)',
    handler: async function (args, output) {
      output('Memory: Clean is not yet implemented. Use Memory: View + Memory: Delete for now.');
    }
  };

})();
