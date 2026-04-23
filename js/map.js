// ── js/map.js ─────────────────────────────────────────────────────────────────────────────
// Browser module. Loaded by index.html after commands.js.
// Map:       walk rootHandle -> build project tree -> window.projectMap
// UpdateMap: full rebuild (File System Access API has no reliable delta)
// Self-registers into window.COMMANDS after commands.js loads.
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  const SKIP_DIRS = new Set([
    '.git', 'node_modules', '_debug', 'dist', 'build',
    '.next', '__pycache__', '.vercel', 'backups'
  ]);
  const TEXT_EXTS = new Set([
    '.js', '.ts', '.jsx', '.tsx', '.html', '.css', '.json',
    '.md', '.txt', '.py', '.sh', '.bat', '.ps1', '.env',
    '.yml', '.yaml', '.toml', '.svelte', '.vue', '.gitignore'
  ]);
  const MAX_DEPTH  = 5;
  const MAX_FILES  = 300;
  const HINT_LINES = 6;

  let fileCount   = 0;
  let lastMapTime = null;

  async function getHint(fileHandle) {
    try {
      const file = await fileHandle.getFile();
      if (file.size > 150000) return null;
      const lines = (await file.text()).split('\n').slice(0, HINT_LINES);
      for (const line of lines) {
        const t = line.trim();
        let hint = null;
        if (t.startsWith('//'))    hint = t.replace(/^\/\/\s*[-=*\u2500]+\s*/, '').replace(/^\/\/\s*/, '').trim();
        else if (t.startsWith('#'))     hint = t.replace(/^#+\s*/, '').trim();
        else if (t.startsWith('<!--')) hint = t.replace(/<!--\s*/, '').replace(/\s*-->.*/, '').trim();
        if (hint && hint.length >= 4 && hint.length <= 100 && !/^[-=*\u2500]+$/.test(hint)) return hint;
      }
    } catch {}
    return null;
  }

  async function buildTree(dirHandle, depth) {
    if (depth > MAX_DEPTH || fileCount >= MAX_FILES) return [];
    const entries = [];
    try {
      for await (const [name, handle] of dirHandle.entries()) {
        if (name.startsWith('.') && name !== '.env') continue;
        if (handle.kind === 'directory') {
          if (SKIP_DIRS.has(name)) continue;
          entries.push({ kind: 'dir', name, children: await buildTree(handle, depth + 1) });
        } else {
          fileCount++;
          const ext  = name.includes('.') ? '.' + name.split('.').pop().toLowerCase() : '';
          let size   = null;
          try { size = (await handle.getFile()).size; } catch {}
          entries.push({ kind: 'file', name, size, hint: TEXT_EXTS.has(ext) ? await getHint(handle) : null });
        }
      }
    } catch {}
    return entries.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  function formatSize(n) {
    if (!n)              return '';
    if (n < 1024)        return ' (' + n + ' B)';
    if (n < 1024 * 1024) return ' (' + (n / 1024).toFixed(1) + ' KB)';
    return ' (' + (n / (1024 * 1024)).toFixed(1) + ' MB)';
  }

  function renderTree(entries, indent) {
    const lines = [];
    for (const e of entries) {
      if (e.kind === 'dir') {
        lines.push(indent + '[dir]  ' + e.name + '/');
        if (e.children && e.children.length) lines.push(...renderTree(e.children, indent + '  '));
      } else {
        const hint = e.hint ? '  -- ' + e.hint : '';
        lines.push(indent + '[file] ' + e.name + formatSize(e.size) + hint);
      }
    }
    return lines;
  }

  // ── Slim map -- flat file index for AI context injection ───────────────────
  // One line per file: path  --  hint. Source files only. Target: <50 lines.
  // chats/ and docs/ excluded -- too noisy for context injection.

  const SLIM_EXTS = new Set(['.js', '.ts', '.html', '.css', '.py', '.json', '.md', '.bat', '.ps1']);
  const SLIM_SKIP = new Set(['.git', 'node_modules', '_debug', 'backups', '__pycache__', '.vercel', 'dist', 'build', 'lib', 'chats', 'docs']);

  function buildSlimMap(tree, rootName) {
    const lines = ['# ' + rootName + ' -- file index'];
    function walk(entries, prefix) {
      for (const e of entries) {
        if (e.kind === 'dir') {
          if (!SLIM_SKIP.has(e.name)) walk(e.children || [], prefix + e.name + '/');
        } else {
          const ext = e.name.includes('.') ? '.' + e.name.split('.').pop().toLowerCase() : '';
          if (SLIM_EXTS.has(ext)) {
            const hint = e.hint ? '  --  ' + e.hint : '';
            lines.push(prefix + e.name + hint);
          }
        }
      }
    }
    walk(tree, '');
    return lines.join('\n');
  }

  async function handleMap(args, output) {
    if (!window.ensureAccess || !window.getRootHandle) {
      output('Error: commands.js helpers not available.');
      return;
    }
    if (!await window.ensureAccess(output)) return;
    const handle = window.getRootHandle();
    if (!handle) { output('No folder open. Run Access: first.'); return; }

    const isUpdate = (args || '').trim().toLowerCase() === 'update';
    output((isUpdate ? 'Updating map' : 'Mapping') + ': ' + handle.name + '...');

    fileCount = 0;
    const t0   = Date.now();
    const tree = await buildTree(handle, 0);
    const ms   = Date.now() - t0;
    const now  = new Date().toLocaleString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });

    const mapText = [
      '# Project Map: ' + handle.name,
      'Generated: ' + now + '  (' + (ms / 1000).toFixed(1) + 's)',
      'Files:     ' + fileCount + (fileCount >= MAX_FILES ? '  [limit reached]' : ''),
      '',
      ...renderTree(tree, '')
    ].join('\n');

    window.projectMap     = mapText;
    window.projectMapRoot = handle.name;
    lastMapTime           = new Date();

    const slimText = buildSlimMap(tree, handle.name);
    try {
      const ctxDir2 = await handle.getDirectoryHandle('_context', { create: true });
      const sfh = await ctxDir2.getFileHandle('.slim', { create: true });
      const sw  = await sfh.createWritable(); await sw.write(slimText); await sw.close();
    } catch {}

    if (window._projectContext) { window._projectContext.map = mapText; window._projectContext.slim = slimText; }

    document.getElementById('input').value = '';

    try {
      const ctxDir = await handle.getDirectoryHandle('_context', { create: true });
      const fh = await ctxDir.getFileHandle('.map', { create: true });
      const w  = await fh.createWritable(); await w.write(mapText); await w.close();
    } catch {}

    if (window.panel) {
      window.panel.open('Map: ' + handle.name, mapText, 'output');
      output('Map ready -- ' + fileCount + ' files, ' + (ms / 1000).toFixed(1) + 's. Saved to _context/.map. See panel.');
    } else { output(mapText); }
  }

  async function handleUpdateMap(args, output) { await handleMap('update', output); }

  function register() {
    if (!window.COMMANDS) { setTimeout(register, 50); return; }
    window.COMMANDS['map']       = { handler: handleMap };
    window.COMMANDS['updatemap'] = { handler: handleUpdateMap };
  }
  register();

  window.getProjectMap     = function () { return window.projectMap     || null; };
  window.getProjectMapRoot = function () { return window.projectMapRoot || null; };
  window.getProjectMapTime = function () { return lastMapTime; };
  window.clearProjectMap   = function () { window.projectMap = null; window.projectMapRoot = null; lastMapTime = null; };

})();
