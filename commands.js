// ── Mobius Command Registry ───────────────────────────────────────────────────
// Client-side command handlers for colon-prefix commands.
// index.html calls detectCommand(text) and runCommand() to execute commands.
// Single-word commands (no colon) are also recognised.

// ── Model persistence ─────────────────────────────────────────────────────────

const MODEL_CHAIN = ['groq', 'gemini', 'mistral'];

function getLastModel() {
  return localStorage.getItem('mobius_last_model') || 'groq';
}

function setLastModel(model) {
  if (MODEL_CHAIN.includes(model)) {
    localStorage.setItem('mobius_last_model', model);
  }
}

function nextModelInChain(current) {
  const idx = MODEL_CHAIN.indexOf(current);
  if (idx === -1 || idx === MODEL_CHAIN.length - 1) return null;
  return MODEL_CHAIN[idx + 1];
}

// ── IndexedDB storage for folder handle ──────────────────────────────────────

const DB_NAME  = 'MobiusFS';
const DB_STORE = 'handles';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore(DB_STORE);
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = () => reject(req.error);
  });
}

async function saveHandle(handle) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).put(handle, 'rootHandle');
    tx.oncomplete = resolve;
    tx.onerror    = () => reject(tx.error);
  });
}

async function loadHandle() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(DB_STORE, 'readonly');
    const req = tx.objectStore(DB_STORE).get('rootHandle');
    req.onsuccess = () => resolve(req.result || null);
    req.onerror   = () => reject(req.error);
  });
}

async function clearHandle() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).delete('rootHandle');
    tx.oncomplete = resolve;
    tx.onerror    = () => reject(tx.error);
  });
}

// ── Access management ─────────────────────────────────────────────────────────

let rootHandle = null;

async function ensureAccess(output) {
  if (rootHandle) return true;
  try {
    const stored = await loadHandle();
    if (stored) {
      let perm = await stored.queryPermission({ mode: 'read' });
      if (perm !== 'granted') perm = await stored.requestPermission({ mode: 'read' });
      if (perm === 'granted') { rootHandle = stored; return true; }
    }
  } catch { /* fall through */ }
  output('No folder access granted. Running Access...');
  return await handleAccess(output);
}

// ── Date / Time / Location ────────────────────────────────────────────────────

function handleDate(args, output) {
  const now = new Date();
  const str = now.toLocaleDateString('en-AU', { weekday:'long', day:'numeric', month:'long', year:'numeric' });
  document.getElementById('input').value = '';
  output('📅 ' + str);
}

function handleTime(args, output) {
  const now = new Date();
  const str = now.toLocaleTimeString('en-AU', { hour:'numeric', minute:'2-digit', hour12:true });
  document.getElementById('input').value = '';
  output('🕐 ' + str);
}

async function handleLocation(args, output) {
  output('📍 Detecting location...');
  try {
    const res  = await fetch('https://ipapi.co/json/', { signal: AbortSignal.timeout(4000) });
    const data = await res.json();
    if (data.error) throw new Error(data.reason || 'Unknown error');
    document.getElementById('input').value = '';
    output('📍 ' + data.city + ', ' + data.region + ', ' + data.country_name + ' (' + data.country_code + ')\n🌐 IP: ' + data.ip + '\n🕐 Timezone: ' + data.timezone);
  } catch (err) {
    output('❌ Location unavailable: ' + err.message);
  }
}

// ── Google ────────────────────────────────────────────────────────────────────

async function handleGoogle(args, output) {
  const userId = getAuth('mobius_user_id');
  if (!userId) { output('❌ Not logged in.'); return; }
  output('🔍 Fetching Google account info...');
  try {
    const res  = await fetch('/api/google/info?userId=' + encodeURIComponent(userId));
    const data = await res.json();
    if (data.error) { output('❌ ' + data.error); return; }
    const lines = [
      '🔗 Google Account',
      'Name:  ' + data.name,
      'Email: ' + data.email,
    ];
    output(lines.join('\n'));
  } catch (err) {
    output('❌ Failed to fetch Google info: ' + err.message);
  }
}

// ── Device ────────────────────────────────────────────────────────────────────

async function handleDevice(args, output) {
  const ua  = navigator.userAgent;
  const nav = navigator;
  const lines = ['🖥️  Device Information'];

  let os =
    /Windows NT 10/.test(ua)   ? 'Windows 10/11' :
    /Windows NT 6\.3/.test(ua) ? 'Windows 8.1' :
    /Mac OS X/.test(ua)        ? 'macOS ' + (ua.match(/Mac OS X ([\d_]+)/)?.[1]?.replace(/_/g,'.') || '') :
    /Android/.test(ua)         ? 'Android ' + (ua.match(/Android ([\d.]+)/)?.[1] || '') :
    /iPhone|iPad/.test(ua)     ? 'iOS ' + (ua.match(/OS ([\d_]+)/)?.[1]?.replace(/_/g,'.') || '') :
    /Linux/.test(ua)           ? 'Linux' : 'Unknown';

  let arch = '';
  if (nav.userAgentData) {
    try {
      const hi = await nav.userAgentData.getHighEntropyValues(['architecture','bitness','platformVersion','model']);
      if (hi.architecture) arch = hi.architecture + (hi.bitness ? '-bit' : '');
      if (hi.model)        lines.push('Device model: ' + hi.model);
      if (/Windows/.test(os) && hi.platformVersion) {
        const major = parseInt(hi.platformVersion.split('.')[0]);
        if (major >= 13) os = 'Windows 11';
        else if (major > 0) os = 'Windows 10';
      }
    } catch { /* high entropy not granted */ }
  }
  lines.push('OS: ' + os);
  if (arch) lines.push('Architecture: ' + arch);

  const browser =
    /Edg\//.test(ua)     ? 'Edge '    + (ua.match(/Edg\/([\d.]+)/)?.[1]    || '') :
    /Chrome\//.test(ua)  ? 'Chrome '  + (ua.match(/Chrome\/([\d.]+)/)?.[1]  || '') :
    /Firefox\//.test(ua) ? 'Firefox ' + (ua.match(/Firefox\/([\d.]+)/)?.[1] || '') :
    /Safari\//.test(ua)  ? 'Safari '  + (ua.match(/Version\/([\d.]+)/)?.[1] || '') : 'Unknown';
  lines.push('Browser: ' + browser);

  const isMobile = /Mobi|Android|iPhone|iPad/.test(ua);
  const isTablet = /iPad|Tablet/.test(ua) || (isMobile && Math.min(screen.width, screen.height) > 600);
  lines.push('Device type: ' + (isTablet ? 'Tablet' : isMobile ? 'Mobile' : 'Desktop'));
  lines.push('Screen: ' + screen.width + '\xd7' + screen.height + ' (' + window.devicePixelRatio + '\xd7 DPR)');
  lines.push('Color depth: ' + screen.colorDepth + '-bit');
  lines.push('Orientation: ' + (screen.orientation?.type || 'unknown'));

  if (nav.hardwareConcurrency) lines.push('CPU cores: ' + nav.hardwareConcurrency);
  if (nav.deviceMemory)        lines.push('RAM: ~' + nav.deviceMemory + ' GB');

  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (gl) {
      const dbgInfo = gl.getExtension('WEBGL_debug_renderer_info');
      if (dbgInfo) {
        const vendor   = gl.getParameter(dbgInfo.UNMASKED_VENDOR_WEBGL);
        const renderer = gl.getParameter(dbgInfo.UNMASKED_RENDERER_WEBGL);
        if (vendor)   lines.push('GPU vendor: ' + vendor);
        if (renderer) lines.push('GPU: ' + renderer);
      }
    }
  } catch { /* unavailable */ }

  try {
    const est   = await navigator.storage.estimate();
    const used  = (est.usage / 1024 / 1024).toFixed(1);
    const quota = (est.quota / 1024 / 1024 / 1024).toFixed(2);
    lines.push('Storage used: ' + used + ' MB of ~' + quota + ' GB quota');
  } catch { /* unavailable */ }

  const conn = nav.connection || nav.mozConnection || nav.webkitConnection;
  if (conn) {
    if (conn.effectiveType) lines.push('Connection: ' + conn.effectiveType.toUpperCase());
    if (conn.downlink)      lines.push('Bandwidth: ~' + conn.downlink + ' Mbps');
    if (conn.rtt)           lines.push('Latency: ' + conn.rtt + ' ms');
  }

  lines.push('Language: ' + (nav.language || 'unknown'));
  lines.push('Dark mode: ' + (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'Yes' : 'No'));
  lines.push('Online: ' + (nav.onLine ? 'Yes' : 'No'));
  const hasTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0 || navigator.msMaxTouchPoints > 0;
  lines.push('Touch: ' + (hasTouch ? 'Yes (' + (navigator.maxTouchPoints || navigator.msMaxTouchPoints) + ' points)' : 'No'));

  document.getElementById('input').value = '';
  output(lines.join('\n'));
}

// ── Access ────────────────────────────────────────────────────────────────────

async function handleAccess(output) {
  if (!('showDirectoryPicker' in window)) {
    output('❌ File System Access API not supported. Use Chrome or Edge on desktop/Android.');
    return false;
  }
  try {
    rootHandle = null;
    await clearHandle();
    const handle = await window.showDirectoryPicker({ mode: 'read' });
    rootHandle = handle;
    await saveHandle(handle);
    document.getElementById('input').value = '';
    const entries = [];
    for await (const [name, h] of handle.entries()) {
      entries.push((h.kind === 'directory' ? '📁' : '📄') + ' ' + name);
    }
    entries.sort();
    output('✅ Access granted to: ' + handle.name + '\n\n📁 Contents (' + entries.length + ' items):\n' + entries.join('\n'));
    return true;
  } catch (err) {
    if (err.name !== 'AbortError') output('❌ Access denied: ' + err.message);
    else output('❌ Folder selection cancelled.');
    return false;
  }
}

// ── Find (with Ext:, From:, To: sub-args) ────────────────────────────────────

function parseNaturalDate(str) {
  if (!str) return null;
  const s   = str.trim().toLowerCase();
  const now = new Date();
  if (s === 'today')      { const d = new Date(now); d.setHours(0,0,0,0); return d; }
  if (s === 'yesterday')  { const d = new Date(now); d.setDate(d.getDate()-1); d.setHours(0,0,0,0); return d; }
  if (s === 'last week')  { const d = new Date(now); d.setDate(d.getDate()-7); d.setHours(0,0,0,0); return d; }
  if (s === 'last month') { const d = new Date(now); d.setMonth(d.getMonth()-1); d.setHours(0,0,0,0); return d; }
  if (s === 'last year')  { const d = new Date(now); d.setFullYear(d.getFullYear()-1); d.setHours(0,0,0,0); return d; }
  const parsed = new Date(str);
  return isNaN(parsed) ? null : parsed;
}

function parseFindArgs(raw) {
  const subArgPattern = /\b(Ext|From|To):\s*/gi;
  const parts  = {};
  const tokens = raw.split(subArgPattern);
  parts.name = tokens[0].trim().toLowerCase();
  for (let i = 1; i < tokens.length; i += 2) {
    const key = tokens[i].toLowerCase();
    const val = (tokens[i+1] || '').trim();
    if (key === 'ext')  parts.ext  = val.replace(/^\./, '').toLowerCase();
    if (key === 'from') parts.from = parseNaturalDate(val);
    if (key === 'to')   parts.to   = parseNaturalDate(val);
  }
  if (parts.to) { parts.to = new Date(parts.to); parts.to.setHours(23,59,59,999); }
  return parts;
}

async function handleFind(args, output) {
  if (!await ensureAccess(output)) return;
  if (!args.trim()) { output('Usage: Find: filename [Ext: pdf] [From: last month] [To: today]'); return; }

  const { name, ext, from, to } = parseFindArgs(args);
  if (!name) { output('Usage: Find: filename [Ext: pdf] [From: last month] [To: today]'); return; }

  let desc = 'Searching "' + rootHandle.name + '" for "' + name + '"';
  if (ext)  desc += ' [.' + ext + ']';
  if (from) desc += ' [from ' + from.toLocaleDateString('en-AU') + ']';
  if (to)   desc += ' [to ' + to.toLocaleDateString('en-AU') + ']';
  output('🔍 ' + desc + '...');

  const results = [];
  await searchDirectory(rootHandle, name, ext || null, from || null, to || null, results, '');
  document.getElementById('input').value = '';

  if (results.length === 0) {
    output('No matches found for "' + name + '".');
  } else {
    output('Found ' + results.length + ' result(s):\n' + results.join('\n'));
  }
}

async function searchDirectory(dirHandle, query, ext, from, to, results, path) {
  for await (const [name, handle] of dirHandle.entries()) {
    const fullPath  = path ? path + '/' + name : name;
    const nameLower = name.toLowerCase();

    if (!nameLower.includes(query)) {
      if (handle.kind === 'directory' && results.length < 200) {
        try { await searchDirectory(handle, query, ext, from, to, results, fullPath); } catch { /* skip */ }
      }
      continue;
    }

    if (ext && handle.kind === 'file') {
      const dotIdx  = nameLower.lastIndexOf('.');
      const fileExt = dotIdx !== -1 ? nameLower.slice(dotIdx + 1) : '';
      if (fileExt !== ext) continue;
    }

    if ((from || to) && handle.kind === 'file') {
      try {
        const file     = await handle.getFile();
        const modified = new Date(file.lastModified);
        if (from && modified < from) continue;
        if (to   && modified > to)   continue;
      } catch { /* skip if unreadable */ }
    }

    results.push((handle.kind === 'directory' ? '📁' : '📄') + ' ' + fullPath);

    if (handle.kind === 'directory' && results.length < 200) {
      try { await searchDirectory(handle, query, ext, from, to, results, fullPath); } catch { /* skip */ }
    }
  }
}

// ── List ──────────────────────────────────────────────────────────────────────

async function handleList(args, output) {
  if (!await ensureAccess(output)) return;
  const entries = [];
  for await (const [name, handle] of rootHandle.entries()) {
    entries.push((handle.kind === 'directory' ? '📁' : '📄') + ' ' + name);
  }
  entries.sort();
  document.getElementById('input').value = '';
  output('📁 "' + rootHandle.name + '" (' + entries.length + ' items):\n' + entries.join('\n'));
}

// ── Focus ─────────────────────────────────────────────────────────────────────
// Focus: filename   — search whole Drive, show clickable list, copy chosen file to Mobius folder
// Focus: add text   — append text to the Mobius copy, do NOT send to AI
// Focus: update     — write Mobius copy back to the original file
// Focus: end        — detach file

let focusFile = null; // { id, name, mimeType, content, folderId, originalId }

// Expose for index.html to attach file to mobius_query FILES
window.getFocusFile = () => focusFile;

// Called when user clicks a file in the Focus search results list
window.focusSelectFile = async function(file, folderId, outputEl) {
  const userId = getAuth('mobius_user_id');
  try {
    if (file.inMobius) {
      // Already in Mobius folder — read directly, no copy needed
      outputEl.textContent = '📥 Loading "' + file.name + '"...';
      const res  = await fetch('/api/focus/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, fileId: file.id, mimeType: file.mimeType })
      });
      const data = await res.json();
      if (data.error) { outputEl.textContent = '❌ Read failed: ' + data.error; return; }
      focusFile = { id: file.id, name: file.name, mimeType: file.mimeType, content: data.content, folderId, originalId: null, path: file.path || null };
    } else {
      // Outside Mobius — copy in
      outputEl.textContent = '📋 Copying "' + file.name + '" to Mobius folder...';
      const res  = await fetch('/api/focus/copy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, fileId: file.id, mimeType: file.mimeType, filename: file.name, folderId })
      });
      const data = await res.json();
      if (data.error) { outputEl.textContent = '❌ Copy failed: ' + data.error; return; }
      focusFile = { id: data.copy.id, name: data.copy.name, mimeType: 'text/plain', content: data.copy.content, folderId, originalId: file.id, path: file.path || null };
    }
    const md = window.markdownToHtml || (t => t.replace(/\n/g, '<br>'));
    outputEl.classList.add('html-content');
    outputEl.innerHTML =
      '🟢 Focused on: <strong>' + focusFile.name + '</strong>' +
      (focusFile.path ? ' — <span style="font-size:12px;color:#8d7c64;">Path: ' + focusFile.path + '</span>' : '') + '<br>' +
      (focusFile.content ? '📝 Current content:<br>' + md(focusFile.content) : '📄 File is empty.') + '<br><br>' +
      'File will be attached to all AI queries this session.<br>' +
      'Use "Focus: add [text]" to append entries.<br>' +
      (focusFile.originalId ? 'Use "Focus: update" to write back to the original.<br>' : '') +
      'Use "Focus: end" to detach.';
  } catch (err) { outputEl.textContent = '❌ ' + err.message; }
};

async function handleFocus(args, output, outputEl) {
  const userId = getAuth('mobius_user_id');
  if (!userId) { output('❌ Not logged in.'); return; }

  const trimmed = args.trim();

  // Focus: end
  if (trimmed.toLowerCase() === 'end') {
    focusFile = null;
    document.getElementById('input').value = '';
    output('🔴 Focus ended. File detached from queries.');
    return;
  }

  // Focus: update — write Mobius copy back to original
  if (trimmed.toLowerCase() === 'update') {
    if (!focusFile) { output('❌ No file in focus.'); return; }
    if (!focusFile.originalId) { output('❌ No original file to update (file was created in Mobius folder).'); return; }
    output('🔄 Updating original file...');
    try {
      const res  = await fetch('/api/focus/update-original', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, originalFileId: focusFile.originalId, content: focusFile.content })
      });
      const data = await res.json();
      if (data.error) { output('❌ Update failed: ' + data.error); return; }
      document.getElementById('input').value = '';
      output('✅ Original file updated successfully.');
    } catch (err) { output('❌ ' + err.message); }
    return;
  }

  // Focus: add [text] — append to Mobius copy in memory, then write full content to Drive
  // Supports: 'add some text' or 'add\nmultiline text'
  if (trimmed.toLowerCase().startsWith('add') && (trimmed.length === 3 || trimmed[3] === ' ' || trimmed[3] === '\n')) {
    if (!focusFile) { output('❌ No file in focus. Use Focus: filename first.'); return; }
    const text = trimmed.slice(3).replace(/^[\s\n]+/, '');
    if (!text) { output('Usage: Focus: add [your text here]'); return; }
    output('💾 Saving to "' + focusFile.name + '"...');
    try {
      // Build updated content in memory first
      const timestamp = new Date().toLocaleString('en-AU');
      const updated = (focusFile.content ? focusFile.content + '\n\n' : '') + '[' + timestamp + ']\n' + text;
      const res = await fetch('/api/focus/append', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, fileId: focusFile.id, content: updated })
      });
      const data = await res.json();
      if (data.error) { output('❌ Save failed: ' + data.error); return; }
      focusFile.content = updated;
      document.getElementById('input').value = '';
      output('✅ Saved to "' + focusFile.name + '".');
    } catch (err) { output('❌ ' + err.message); }
    return;
  }

  // Focus: filename — search whole Drive
  const filename = trimmed;
  if (!filename) { output('Usage: Focus: filename  |  Focus: add [text]  |  Focus: update  |  Focus: end'); return; }

  output('🔍 Searching Drive for "' + filename + '"...');

  try {
    const findRes  = await fetch('/api/focus/find', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, filename })
    });
    const findData = await findRes.json();
    if (findData.error) { output('❌ ' + findData.error); return; }

    if (findData.files.length === 0) {
      // Not found — create new in Mobius folder
      output('📄 Not found. Creating "' + filename + '.md" in Mobius folder...');
      const createRes  = await fetch('/api/focus/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, filename, folderId: findData.folderId })
      });
      const createData = await createRes.json();
      if (createData.error) { output('❌ ' + createData.error); return; }
      focusFile = { id: createData.file.id, name: createData.file.name, mimeType: 'text/plain', content: '', folderId: findData.folderId, originalId: null };
      document.getElementById('input').value = '';
      if (outputEl) {
        outputEl.classList.add('html-content');
        outputEl.innerHTML = '🟢 Focused on new file: <strong>' + focusFile.name + '</strong><br>📄 File is empty.<br><br>Use "Focus: add [text]" to add content.<br>Use "Focus: end" to detach.';
      }
      return;
    }

    if (findData.files.length === 1) {
      await window.focusSelectFile(findData.files[0], findData.folderId, outputEl);
      document.getElementById('input').value = '';
      return;
    }

    // Multiple matches — show clickable list
    document.getElementById('input').value = '';
    if (outputEl) {
      outputEl.innerHTML = '📋 Found ' + findData.files.length + ' files. Tap to select:<br><br>' +
        findData.files.map((f, i) => {
          const safeId = 'focus-file-' + i;
          const label = f.inMobius ? '📂 ' : '📄 '; // folder icon = already in Mobius
          return '<div id="' + safeId + '" style="cursor:pointer;padding:6px 10px;margin-bottom:4px;background:#ede5d4;border:1px solid #c9bfae;border-radius:1px;" ' +
            'onmouseover="this.style.background=\'#d9cfbc\'" onmouseout="this.style.background=\'#ede5d4\'" ' +
            'onclick="window.focusSelectFile(' + JSON.stringify(f).replace(/"/g, '&quot;') + ', \'' + findData.folderId + '\', document.getElementById(\'' + safeId + '\').closest(\'.mq-block\'))">' +
            label + f.name + (f.path ? ' <span style="font-size:11px;color:#8d7c64;">— Path: ' + f.path + '</span>' : '') + '</div>';
        }).join('');
    }
  } catch (err) { output('❌ ' + err.message); }
}

// ── New Chat ─────────────────────────────────────────────────────────────────

async function handleNew(args, output) {
  if (window.newChat) {
    window.newChat(args);
  } else {
    output('❌ newChat not available.');
  }
}

// ── Code Mode ────────────────────────────────────────────────────────────────

const CODE_EXCLUDE = new Set(['node_modules', '.git', '.vercel', '.aider.tags.cache.v4', 'documents']);
const REPO_EXTS    = new Set(['js', 'html']);

let codeSession = null; // { projectName, mapContent, repoContent, auditContent }

// Expose for index.html to check coding mode
window.getCodeSession = () => codeSession;

// ── Shared: save content to Google Drive Mobius folder ────────────────────────
async function saveToMobiusDrive(userId, filename, content, output) {
  try {
    output('💾 Saving ' + filename + ' to Drive...');
    const res  = await fetch('/api/focus/create-or-update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, filename, content })
    });
    const data = await res.json();
    if (data.error) { output('⚠️  Drive save failed: ' + data.error); return false; }
    output('✅ Saved to Drive: ' + filename);
    return true;
  } catch (err) {
    output('⚠️  Drive save failed: ' + err.message);
    return false;
  }
}

// ── Shared: offer download link ───────────────────────────────────────────────
function offerDownload(outputEl, filename, content) {
  const blob = new Blob([content], { type: 'text/plain' });
  const url  = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href     = url;
  link.download = filename;
  link.textContent = '⬇️  Download ' + filename;
  link.style.cssText = 'display:block; margin-top:8px; color:#4a7c4e; font-weight:bold; cursor:pointer;';
  link.onclick = () => setTimeout(() => URL.revokeObjectURL(url), 5000);
  outputEl.appendChild(link);
}

// ── Code: scan — static analysis engine (no AI) ────────────────────────────────
async function generateScan(projectHandle, projectName, output) {
  output('🔬 Scanning ' + projectName + ' for issues...');

  const findings = []; // { severity, file, line, code, issue }
  const allFunctions = {}; // fname -> [files] for duplicate detection
  const allExports   = {}; // fname -> file
  const allImports   = new Set(); // all imported names across project

  // Known secret prefixes
  const SECRET_PATTERNS = [
    /['"`][A-Za-z0-9_\-]{20,}['"`]/,  // long opaque strings
    /sk-[A-Za-z0-9]{20,}/,
    /AIza[A-Za-z0-9_\-]{30,}/,
    /ghp_[A-Za-z0-9]{30,}/,
    /Bearer\s+[A-Za-z0-9_\-\.]{20,}/
  ];

  function flag(severity, file, lineNum, codeLine, issue) {
    findings.push({ severity, file, line: lineNum, code: codeLine.trim(), issue });
  }

  async function scanFile(handle, relPath) {
    let text = '';
    try { const f = await handle.getFile(); text = await f.text(); } catch { return; }
    const lines = text.split('\n');

    // Track function names for duplicate detection
    const fnPat = /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/;
    const arPat = /^\s*(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?\(/;
    for (const line of lines) {
      let fm = line.match(fnPat) || line.match(arPat);
      if (fm) {
        const fn = fm[1];
        if (!allFunctions[fn]) allFunctions[fn] = [];
        allFunctions[fn].push(relPath);
      }
    }

    // Track exports
    const expPat = /module\.exports\s*=\s*\{([^}]+)\}/;
    const expMatch = text.match(expPat);
    if (expMatch) {
      expMatch[1].split(',').map(s => s.trim().split(':')[0].trim()).filter(Boolean)
        .forEach(name => { allExports[name] = relPath; });
    }

    // Track imports
    const reqPat = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    let rm;
    while ((rm = reqPat.exec(text)) !== null) allImports.add(rm[1]);

    // Per-line checks
    let inMultiComment = false;
    let fnStartLine    = -1;
    let fnBraceDepth   = 0;
    let fnLineCount    = 0;
    let currentFn      = '';
    let braceDepth     = 0;

    for (let i = 0; i < lines.length; i++) {
      const line    = lines[i];
      const trimmed = line.trim();
      const lineNum = i + 1;

      // Track multi-line comments
      if (trimmed.startsWith('/*')) inMultiComment = true;
      if (inMultiComment) { if (trimmed.includes('*/')) inMultiComment = false; continue; }
      if (trimmed.startsWith('//')) continue;

      // console.log left in
      if (/console\.log\(/.test(trimmed)) {
        flag('LOW', relPath, lineNum, trimmed, 'console.log left in production code');
      }

      // TODO/FIXME/HACK comments
      if (/\/\/.*\b(TODO|FIXME|HACK|XXX)\b/i.test(trimmed)) {
        const tag = trimmed.match(/\b(TODO|FIXME|HACK|XXX)\b/i)[1].toUpperCase();
        flag('LOW', relPath, lineNum, trimmed, tag + ' comment unresolved');
      }

      // Hardcoded secrets
      for (const pat of SECRET_PATTERNS) {
        if (pat.test(trimmed) && !/process\.env/.test(trimmed) && !/\/\//.test(trimmed.slice(0, trimmed.search(pat)))) {
          flag('HIGH', relPath, lineNum, trimmed, 'Possible hardcoded secret or token');
          break;
        }
      }

      // await without try/catch — look for bare await not inside a try block
      if (/\bawait\s+\w/.test(trimmed)) {
        // Check if this line is inside a try block by scanning back
        let inTry = false;
        let depth = 0;
        for (let j = i; j >= Math.max(0, i - 30); j--) {
          const prev = lines[j].trim();
          depth += (prev.match(/\}/g) || []).length;
          depth -= (prev.match(/\{/g) || []).length;
          if (depth < 0 && /\btry\b/.test(prev)) { inTry = true; break; }
          if (depth < 0) break;
        }
        if (!inTry) flag('MED', relPath, lineNum, trimmed, 'await not wrapped in try/catch');
      }

      // Empty catch blocks
      if (/catch\s*(\(.*\))?\s*\{\s*\}/.test(trimmed) || /catch\s*(\(.*\))?\s*\{\s*\/\*.*\*\/\s*\}/.test(trimmed)) {
        flag('MED', relPath, lineNum, trimmed, 'Empty or suppressed catch block');
      }

      // Route handlers with no auth check (req.body used, no userId/token nearby)
      if (/app\.(post|put|delete|patch)\s*\(/.test(trimmed)) {
        const routeBlock = lines.slice(i, Math.min(i + 20, lines.length)).join('\n');
        if (/req\.body/.test(routeBlock) && !/userId|token|auth|bearer|session/i.test(routeBlock)) {
          flag('MED', relPath, lineNum, trimmed, 'Route modifies data but no auth check found in first 20 lines');
        }
      }

      // Function length tracking
      const isFnStart = /^\s*(?:async\s+)?function\s+\w+|^\s*(?:export\s+)?const\s+\w+\s*=\s*(?:async\s+)?\(/.test(line);
      if (isFnStart) {
        currentFn   = (line.match(/function\s+(\w+)/) || line.match(/const\s+(\w+)/))?.[1] || '?';
        fnStartLine = lineNum;
        fnBraceDepth = braceDepth;
        fnLineCount  = 0;
      }
      if (fnStartLine > -1) {
        fnLineCount++;
        braceDepth += (line.match(/\{/g) || []).length;
        braceDepth -= (line.match(/\}/g) || []).length;
        if (braceDepth <= fnBraceDepth && fnLineCount > 5) {
          if (fnLineCount > 80) flag('MED', relPath, fnStartLine, 'function ' + currentFn, 'Function is ' + fnLineCount + ' lines — consider splitting');
          fnStartLine = -1; fnLineCount = 0;
        }
      } else {
        braceDepth += (line.match(/\{/g) || []).length;
        braceDepth -= (line.match(/\}/g) || []).length;
      }
    }
  }

  async function walkDir(dirHandle, pathPrefix) {
    for await (const [name, handle] of dirHandle.entries()) {
      if (CODE_EXCLUDE.has(name)) continue;
      const relPath = pathPrefix ? pathPrefix + '/' + name : name;
      if (handle.kind === 'directory') { await walkDir(handle, relPath); continue; }
      const ext = name.split('.').pop().toLowerCase();
      if (!REPO_EXTS.has(ext)) continue;
      await scanFile(handle, relPath);
    }
  }

  try {
    await walkDir(projectHandle, '');
  } catch (err) {
    output('❌ Scan error: ' + err.message);
    return null;
  }

  // Cross-file: duplicate function names
  for (const [fname, files] of Object.entries(allFunctions)) {
    if (files.length > 1) {
      findings.push({ severity: 'MED', file: files.join(' + '), line: '-', code: 'function ' + fname, issue: 'Duplicate function name across files' });
    }
  }

  // Sort: HIGH first, then MED, then LOW
  const order = { HIGH: 0, MED: 1, LOW: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);

  return findings;
}

// ── Code: repo — recursive JS/HTML parser ────────────────────────────────────
async function generateRepo(projectHandle, projectName, output, outputEl) {
  output('🔍 Scanning ' + projectName + ' files...');

  const sections = [];

  async function scanDir(dirHandle, pathPrefix) {
    const entries = [];
    for await (const [name, handle] of dirHandle.entries()) {
      entries.push([name, handle]);
    }
    entries.sort((a, b) => a[0].localeCompare(b[0]));

    for (const [name, handle] of entries) {
      if (CODE_EXCLUDE.has(name)) continue; 
      const relPath = pathPrefix ? pathPrefix + '/' + name : name;

      if (handle.kind === 'directory') {
        await scanDir(handle, relPath);
        continue;
      }

      const ext = name.split('.').pop().toLowerCase();
      if (!REPO_EXTS.has(ext)) continue;

      let text = '';
      try {
        const file = await handle.getFile();
        text = await file.text();
      } catch { continue; }

      const lines  = [];
      const seen   = new Set();

      // [F] function declarations: function foo(...)
      const fnDeclPat = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*?)\)/gm;
      let m;
      while ((m = fnDeclPat.exec(text)) !== null) {
        const fname = m[1];
        if (!seen.has('F:' + fname)) {
          seen.add('F:' + fname);
          const pos      = text.lastIndexOf('\n', m.index - 1);
          const prev     = text.lastIndexOf('\n', pos - 1);
          const prevLine = text.slice(prev + 1, pos).trim();
          const comment  = prevLine.startsWith('//') ? ' \u2014 ' + prevLine.slice(2).trim() : '';
          lines.push('[F] ' + fname + '(' + m[2].replace(/\s+/g, ' ').trim() + ')' + comment);
        }
      }

      // [F] arrow functions at start of line: const foo = (async)? (...) =>
      const arrowPat = /^(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?\(([^)]*)\)\s*=>/gm;
      while ((m = arrowPat.exec(text)) !== null) {
        const fname = m[1];
        if (!seen.has('F:' + fname)) {
          seen.add('F:' + fname);
          const pos      = text.lastIndexOf('\n', m.index - 1);
          const prev     = text.lastIndexOf('\n', pos - 1);
          const prevLine = text.slice(prev + 1, pos).trim();
          const comment  = prevLine.startsWith('//') ? ' \u2014 ' + prevLine.slice(2).trim() : '';
          lines.push('[F] ' + fname + '(' + m[2].replace(/\s+/g, ' ').trim() + ')' + comment);
        }
      }

      // [E] process.env references
      const envPat = /process\.env\.([A-Z0-9_]+)/g;
      const envVars = new Set();
      let em;
      while ((em = envPat.exec(text)) !== null) envVars.add(em[1]);
      for (const v of [...envVars].sort()) lines.push('[E] ' + v);

      // [>] require/import — skip template literals and expressions
      const reqPat = /require\s*\(\s*['"]([^'"]+)['"]\s*\)|from\s+['"]([^'"]+)['"]/g;
      const deps   = new Set();
      let rm;
      while ((rm = reqPat.exec(text)) !== null) {
        const dep = (rm[1] || rm[2] || '').trim();
        if (!dep || dep.startsWith('+') || dep.includes('${') || dep.startsWith('node_modules')) continue;
        deps.add(dep);
      }
      for (const d of [...deps].sort()) lines.push('[>] ' + d);

      // [<] module.exports
      const expPat = /module\.exports\s*=\s*\{([^}]+)\}/;
      const expMatch = expPat.exec(text);
      if (expMatch) {
        const exported = expMatch[1].split(',').map(s => s.trim().split(':')[0].trim()).filter(Boolean);
        if (exported.length) lines.push('[<] exports: ' + exported.join(', '));
      }

      // [R] Express routes
      const routePat = /app\.(post|get|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]/g;
      let route;
      while ((route = routePat.exec(text)) !== null) {
        const rkey = 'R:' + route[1] + route[2];
        if (!seen.has(rkey)) { seen.add(rkey); lines.push('[R] ' + route[1].toUpperCase() + ' ' + route[2]); }
      }

      if (lines.length) {
        sections.push('## ' + relPath + '\n' + lines.join('\n'));
      }
    }
  }

  try {
    await scanDir(projectHandle, '');
  } catch (err) {
    output('❌ Scan error: ' + err.message);
    return null;
  }

  const timestamp  = new Date().toLocaleString('en-AU');
  const repoContent = '# ' + projectName + ' — Code Index\n' +
    '# Generated: ' + timestamp + '\n\n' +
    sections.join('\n\n');

  return repoContent;
}

async function handleCode(args, output, outputEl) {
  const trimmed = args.trim();
  const lower   = trimmed.toLowerCase();
  const userId  = getAuth('mobius_user_id');

  // Code: end
  if (lower === 'end') {
    codeSession = null;
    document.getElementById('input').value = '';
    updateCodeBadge();
    output('🔴 Code mode ended.');
    return;
  }

  // Code: show — display loaded context summary
  if (lower === 'show') {
    if (!codeSession) { output('❌ No active code session. Use Code: [projectname] first.'); return; }
    const parts = ['📋 Code session: ' + codeSession.projectName];
    if (codeSession.mapContent)   parts.push('\n── .map ────────────────────\n'   + codeSession.mapContent);
    if (codeSession.repoContent)  parts.push('\n── .repo ───────────────────\n'  + codeSession.repoContent);
    if (codeSession.auditContent) parts.push('\n── .audit ──────────────────\n' + codeSession.auditContent);
    output(parts.join('\n'));
    return;
  }

  // Code: repo — generate .repo file
  if (lower === 'repo') {
    if (!codeSession) { output('❌ No active code session. Use Code: [projectname] first.'); return; }

    // Switch outputEl to append mode
    outputEl.classList.add('html-content');
    outputEl.innerHTML = '';
    const append = msg => {
      const line = document.createElement('div');
      line.textContent = msg;
      outputEl.appendChild(line);
    };

    const repoContent = await generateRepo(codeSession.projectHandle, codeSession.projectName, append, outputEl);
    if (!repoContent) return;
    const repoName = codeSession.projectName.toLowerCase().replace(/[^a-z0-9_]/g, '_') + '.repo';
    codeSession.repoContent = repoContent;
    codeSession.repoGeneratedAt = Date.now();
    const sectionCount = (repoContent.match(/^## /gm) || []).length;
    append('✅ .repo generated — ' + sectionCount + ' files, ' + repoContent.length + ' chars');
    offerDownload(outputEl, repoName, repoContent);
    await saveToMobiusDrive(userId, repoName, repoContent, append);
    document.getElementById('input').value = '';
    return;
  }

  // Code: map — AI-generated project overview from .repo
  if (lower === 'map') {
    if (!codeSession) { output('❌ No active code session. Use Code: [projectname] first.'); return; }

    outputEl.classList.add('html-content');
    outputEl.innerHTML = '';
    const append = msg => { const d = document.createElement('div'); d.textContent = msg; outputEl.appendChild(d); };

    // Check repo freshness — prompt if missing or stale (>5 mins)
    const FIVE_MINS = 5 * 60 * 1000;
    const repoAge   = codeSession.repoGeneratedAt ? (Date.now() - codeSession.repoGeneratedAt) : Infinity;
    const repoStale = !codeSession.repoContent || repoAge > FIVE_MINS;

    if (repoStale) {
      const reason = !codeSession.repoContent ? 'No .repo found in this session.' : '.repo is more than 5 minutes old.';
      const prompt = document.createElement('div');
      prompt.style.cssText = 'margin-bottom:10px; color:#4a3728;';
      prompt.textContent = '⚠️  ' + reason + ' Generate a fresh .repo before mapping?';
      outputEl.appendChild(prompt);

      const yesBtn = document.createElement('button');
      yesBtn.textContent = '✅ Yes — run Code: repo first';
      yesBtn.style.cssText = 'margin-right:8px; padding:4px 12px; background:#4a7c4e; color:#fff; border:none; border-radius:2px; cursor:pointer; font-family:inherit; font-size:13px;';

      const noBtn = document.createElement('button');
      noBtn.textContent = '⏭️ Use existing';
      noBtn.style.cssText = 'padding:4px 12px; background:#8d7c64; color:#fff; border:none; border-radius:2px; cursor:pointer; font-family:inherit; font-size:13px;';

      noBtn.onclick = () => { outputEl.innerHTML = ''; runMap(); };
      yesBtn.onclick = async () => {
        outputEl.innerHTML = '';
        const repoContent = await generateRepo(codeSession.projectHandle, codeSession.projectName, append, outputEl);
        if (!repoContent) return;
        const repoName = codeSession.projectName.toLowerCase().replace(/[^a-z0-9_]/g, '_') + '.repo';
        codeSession.repoContent = repoContent;
        codeSession.repoGeneratedAt = Date.now();
        append('✅ .repo done — ' + repoContent.length + ' chars');
        offerDownload(outputEl, repoName, repoContent);
        await saveToMobiusDrive(userId, repoName, repoContent, append);
        runMap();
      };

      outputEl.appendChild(yesBtn);
      outputEl.appendChild(noBtn);
      document.getElementById('input').value = '';

      // Register Esc handler for global Esc support
      window._escHandler = () => {
        outputEl.innerHTML = '❌ Cancelled.';
        document.getElementById('input').value = '';
      };
      return;
    }

    runMap();

    async function runMap() {
      window._escHandler = null; // clear any pending Esc handler
      if (!codeSession.repoContent) { append('❌ No .repo available. Run Code: repo first.'); return; }
      append('🗺️  Generating map for ' + codeSession.projectName + '...');

    const mapPrompt = 'You are a senior software architect. Analyse this code index and produce a concise project map.\n\n' +
      'Structure your response with these exact sections:\n' +
      '# ' + codeSession.projectName + ' — Project Map\n\n' +
      '## Purpose\nOne paragraph: what this project does and who it is for.\n\n' +
      '## Architecture\nHow the project is structured — frontend, backend, APIs, data flow. Be specific about files and their roles.\n\n' +
      '## Key Files\nList the most important files and one sentence on what each does.\n\n' +
      '## Data Flow\nHow a typical request moves through the system end-to-end.\n\n' +
      '## External Dependencies\nAPIs, services, and environment variables the project relies on.\n\n' +
      '## Notes\nAny notable patterns, risks, or things a new developer should know.\n\n' +
      '---\nCODE INDEX:\n' + codeSession.repoContent;

    try {
      const res  = await fetch('/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mobius_query: { ASK: 'gemini', INSTRUCTIONS: 'Long', HISTORY: [], QUERY: mapPrompt, FILES: [], CONTEXT: 'None' }, userId })
      });
      const data = await res.json();
      if (data.error) { append('❌ AI error: ' + data.error); return; }
      const mapName = codeSession.projectName.toLowerCase().replace(/[^a-z0-9_]/g, '_') + '.map';
      codeSession.mapContent = data.reply;
      append('✅ .map generated — ' + data.reply.length + ' chars');
      offerDownload(outputEl, mapName, data.reply);
      await saveToMobiusDrive(userId, mapName, data.reply, append);
    } catch (err) { append('❌ ' + err.message); }
    document.getElementById('input').value = '';
    } // end runMap
    return;
  }

  // Code: scan — fast static analysis, no AI
  if (lower === 'scan') {
    if (!codeSession) { output('❌ No active code session. Use Code: [projectname] first.'); return; }

    outputEl.classList.add('html-content');
    outputEl.innerHTML = '';
    const append = msg => { const d = document.createElement('div'); d.textContent = msg; outputEl.appendChild(d); };

    const findings = await generateScan(codeSession.projectHandle, codeSession.projectName, append);
    if (!findings) return;

    document.getElementById('input').value = '';

    if (findings.length === 0) {
      append('✅ No issues found. Code looks clean.');
      return;
    }

    const high = findings.filter(f => f.severity === 'HIGH');
    const med  = findings.filter(f => f.severity === 'MED');
    const low  = findings.filter(f => f.severity === 'LOW');
    append('📊 ' + findings.length + ' issue(s) found — HIGH: ' + high.length + '  MED: ' + med.length + '  LOW: ' + low.length);
    append('');

    for (const f of findings) {
      const icon = f.severity === 'HIGH' ? '🔴' : f.severity === 'MED' ? '🟡' : '⚪';
      append(icon + ' [' + f.severity + '] ' + f.file + ':' + f.line);
      append('   └ ' + f.issue);
      append('   │ ' + f.code.slice(0, 80) + (f.code.length > 80 ? '…' : ''));
      append('');
    }

    // Store scan findings for potential audit escalation
    codeSession.scanFindings = findings;

    // Offer AI escalation button
    const btn = document.createElement('button');
    btn.textContent = '🧠 Ask AI about these findings (Code: audit)';
    btn.style.cssText = 'margin-top:10px; padding:6px 14px; background:#4a7c4e; color:#fff; border:none; border-radius:2px; cursor:pointer; font-family:inherit; font-size:13px;';
    btn.onclick = () => {
      document.getElementById('input').value = 'Code: audit';
      document.getElementById('input').focus();
    };
    outputEl.appendChild(btn);
    return;
  }

  // Code: audit — deep scan, present findings, user selects one, AI analyses it
  if (lower === 'audit') {
    if (!codeSession) { output('❌ No active code session. Use Code: [projectname] first.'); return; }

    outputEl.classList.add('html-content');
    outputEl.innerHTML = '';
    const append = msg => { const d = document.createElement('div'); d.textContent = msg; outputEl.appendChild(d); };
    append('🔎 Running deep scan for ' + codeSession.projectName + '...');

    // Phase 1: deep static scan (same engine as scan, but also catches deeper issues)
    const findings = await generateScan(codeSession.projectHandle, codeSession.projectName, append);
    if (!findings) return;

    document.getElementById('input').value = '';

    if (findings.length === 0) {
      append('✅ No issues found. Code is clean.');
      return;
    }

    const high = findings.filter(f => f.severity === 'HIGH');
    const med  = findings.filter(f => f.severity === 'MED');
    const low  = findings.filter(f => f.severity === 'LOW');

    // Phase 2: present findings as a clickable list — user picks one to escalate
    const summary = document.createElement('div');
    summary.style.cssText = 'font-weight:bold; margin-bottom:10px; color:#4a3728;';
    summary.textContent = '📊 ' + findings.length + ' issue(s) found — HIGH: ' + high.length + '  MED: ' + med.length + '  LOW: ' + low.length;
    outputEl.appendChild(summary);

    const instruction = document.createElement('div');
    instruction.style.cssText = 'font-size:12px; color:#8d7c64; margin-bottom:10px;';
    instruction.textContent = 'Click a finding to ask Gemini for an explanation and fix. One at a time.';
    outputEl.appendChild(instruction);

    // Store file contents cache for context extraction
    const fileCache = {};
    async function getFileLines(relPath) {
      if (fileCache[relPath]) return fileCache[relPath];
      try {
        // Walk project handle to find the file
        async function findFile(dirHandle, parts) {
          const [head, ...rest] = parts;
          for await (const [name, handle] of dirHandle.entries()) {
            if (name !== head) continue;
            if (rest.length === 0 && handle.kind === 'file') {
              const f = await handle.getFile();
              const text = await f.text();
              fileCache[relPath] = text.split('\n');
              return fileCache[relPath];
            }
            if (handle.kind === 'directory') return findFile(handle, rest);
          }
          return null;
        }
        const parts = relPath.split('/');
        return await findFile(codeSession.projectHandle, parts);
      } catch { return null; }
    }

    // Exposed handler for finding click
    window._auditSelectFinding = async function(index, btnEl) {
      const f = findings[index];
      btnEl.textContent = '⏳ Asking Gemini...';
      btnEl.disabled = true;

      // Extract ~15 lines of context around the problem line
      let codeContext = f.code;
      if (typeof f.line === 'number') {
        const fileLines = await getFileLines(f.file);
        if (fileLines) {
          const start = Math.max(0, f.line - 8);
          const end   = Math.min(fileLines.length, f.line + 8);
          codeContext = fileLines.slice(start, end)
            .map((l, i) => (start + i + 1) + (start + i + 1 === f.line ? ' ▶ ' : '   ') + l)
            .join('\n');
        }
      }

      // Build full findings summary for context
      const allFindingsSummary = findings.map((x, i) =>
        (i + 1) + '. [' + x.severity + '] ' + x.file + ':' + x.line + ' — ' + x.issue
      ).join('\n');

      const prompt =
        'You are a senior software engineer reviewing a real project.\n' +
        'A static analysis scan found the following issues across the codebase:\n\n' +
        'ALL FINDINGS:\n' + allFindingsSummary + '\n\n' +
        'The developer wants to address this specific issue first:\n\n' +
        'FILE: ' + f.file + '\n' +
        'LINE: ' + f.line + '\n' +
        'SEVERITY: ' + f.severity + '\n' +
        'ISSUE: ' + f.issue + '\n\n' +
        'CODE CONTEXT (line ' + f.line + ' marked with ▶):\n' +
        '```\n' + codeContext + '\n```\n\n' +
        'Before suggesting a fix: consider whether any of the other findings are related to this issue ' +
        'or point to a deeper underlying problem. If so, flag it.\n' +
        'Then either: (a) confirm the straightforward fix and provide corrected code for this location only, ' +
        'or (b) recommend a better approach if one exists — and explain the trade-off.\n' +
        'Do not refactor beyond what is needed to address this issue.';

      try {
        const res  = await fetch('/ask', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mobius_query: { ASK: 'gemini', INSTRUCTIONS: 'Long', HISTORY: [], QUERY: prompt, FILES: [], CONTEXT: 'None' }, userId: getAuth('mobius_user_id') })
        });
        const data = await res.json();
        if (data.error) { btnEl.textContent = '❌ AI error: ' + data.error; btnEl.disabled = false; return; }

        // Show AI response below the button
        const respDiv = document.createElement('div');
        respDiv.style.cssText = 'margin-top:8px; padding:8px; background:#f5eedd; border:1px solid #c9bfae; border-radius:1px; font-size:13px; white-space:pre-wrap; color:#2a2a2a;';
        respDiv.textContent = data.reply;
        btnEl.parentNode.insertBefore(respDiv, btnEl.nextSibling);
        btnEl.textContent = '✅ Done — click again to re-ask';
        btnEl.disabled = false;
      } catch (err) {
        btnEl.textContent = '❌ ' + err.message;
        btnEl.disabled = false;
      }
    };

    // Render each finding as a clickable card
    for (let i = 0; i < findings.length; i++) {
      const f    = findings[i];
      const icon = f.severity === 'HIGH' ? '🔴' : f.severity === 'MED' ? '🟡' : '⚪';
      const card = document.createElement('div');
      card.style.cssText = 'margin-bottom:8px; padding:8px 10px; background:#ede5d4; border:1px solid #c9bfae; border-radius:1px; font-size:13px;';
      card.innerHTML =
        '<div style="font-weight:bold; margin-bottom:2px;">' + icon + ' [' + f.severity + '] ' + f.file + ':' + f.line + '</div>' +
        '<div style="color:#4a3728; margin-bottom:4px;">' + f.issue + '</div>' +
        '<div style="font-family:monospace; font-size:11px; color:#8d7c64; margin-bottom:6px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">' +
          f.code.slice(0, 80) + (f.code.length > 80 ? '…' : '') + '</div>';
      const btn = document.createElement('button');
      btn.textContent = '🧠 Ask Gemini to fix this';
      btn.style.cssText = 'padding:4px 10px; background:#4a7c4e; color:#fff; border:none; border-radius:2px; cursor:pointer; font-family:inherit; font-size:12px;';
      btn.onclick = (function(idx, b) { return () => window._auditSelectFinding(idx, b); })(i, btn);
      card.appendChild(btn);
      outputEl.appendChild(card);
    }
    return;
  }

  // Code: all — run repo, map, audit in sequence
  if (lower === 'all') {
    if (!codeSession) { output('❌ No active code session. Use Code: [projectname] first.'); return; }

    outputEl.classList.add('html-content');
    outputEl.innerHTML = '';
    const append = msg => { const d = document.createElement('div'); d.textContent = msg; outputEl.appendChild(d); };
    append('⚙️  Running Code: all for ' + codeSession.projectName + '...');

    // Step 1: repo
    append('\n── Step 1/3: repo ──');
    const repoContent = await generateRepo(codeSession.projectHandle, codeSession.projectName, append, outputEl);
    if (!repoContent) { append('❌ repo failed. Stopping.'); return; }
    const baseName  = codeSession.projectName.toLowerCase().replace(/[^a-z0-9_]/g, '_');
    codeSession.repoContent = repoContent;
    append('✅ .repo done — ' + repoContent.length + ' chars');
    offerDownload(outputEl, baseName + '.repo', repoContent);
    await saveToMobiusDrive(userId, baseName + '.repo', repoContent, append);

    // Step 2: map
    append('\n── Step 2/3: map ──');
    try {
      const mapPrompt = 'You are a senior software architect. Analyse this code index and produce a concise project map.\n\n' +
        '# ' + codeSession.projectName + ' — Project Map\n\n## Purpose\n## Architecture\n## Key Files\n## Data Flow\n## External Dependencies\n## Notes\n\n---\nCODE INDEX:\n' + repoContent;
      const mr = await fetch('/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mobius_query: { ASK: 'gemini', INSTRUCTIONS: 'Long', HISTORY: [], QUERY: mapPrompt, FILES: [], CONTEXT: 'None' }, userId }) });
      const md = await mr.json();
      if (md.error) { append('❌ map error: ' + md.error); }
      else {
        codeSession.mapContent = md.reply;
        append('✅ .map done — ' + md.reply.length + ' chars');
        offerDownload(outputEl, baseName + '.map', md.reply);
        await saveToMobiusDrive(userId, baseName + '.map', md.reply, append);
      }
    } catch (err) { append('❌ map: ' + err.message); }

    // Step 3: audit
    append('\n── Step 3/3: audit ──');
    try {
      const auditPrompt = 'You are a senior software engineer conducting a code audit. Analyse this code index and produce a concise audit report.\n\n' +
        '# ' + codeSession.projectName + ' — Audit Report\n\n## Summary\n## Strengths\n## Issues\n## Improvements\n## Security\n## Missing\n\n---\nCODE INDEX:\n' + repoContent;
      const ar = await fetch('/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mobius_query: { ASK: 'gemini', INSTRUCTIONS: 'Long', HISTORY: [], QUERY: auditPrompt, FILES: [], CONTEXT: 'None' }, userId }) });
      const ad = await ar.json();
      if (ad.error) { append('❌ audit error: ' + ad.error); }
      else {
        codeSession.auditContent = ad.reply;
        append('✅ .audit done — ' + ad.reply.length + ' chars');
        offerDownload(outputEl, baseName + '.audit', ad.reply);
        await saveToMobiusDrive(userId, baseName + '.audit', ad.reply, append);
      }
    } catch (err) { append('❌ audit: ' + err.message); }

    append('\n✅ Code: all complete.');
    document.getElementById('input').value = '';
    return;
  }

  // Code: status — snapshot current session state to Drive
  if (lower === 'status') {
    if (!codeSession) { output('❌ No active code session. Use Code: [projectname] first.'); return; }

    outputEl.classList.add('html-content');
    outputEl.innerHTML = '';
    const append = msg => { const d = document.createElement('div'); d.textContent = msg; outputEl.appendChild(d); };
    append('📌 Saving status for ' + codeSession.projectName + '...');

    const now     = new Date().toLocaleString('en-AU');
    const baseName = codeSession.projectName.toLowerCase().replace(/[^a-z0-9_]/g, '_');
    const statusContent =
      '# ' + codeSession.projectName + ' — Session Status\n' +
      '# Saved: ' + now + '\n\n' +
      '## Loaded\n' +
      (codeSession.mapContent   ? '✅ .map loaded (' + codeSession.mapContent.length + ' chars)\n'   : '⚠️  .map not loaded\n') +
      (codeSession.repoContent  ? '✅ .repo loaded (' + codeSession.repoContent.length + ' chars)\n' : '⚠️  .repo not loaded\n') +
      (codeSession.auditContent ? '✅ .audit loaded (' + codeSession.auditContent.length + ' chars)\n': '⚠️  .audit not loaded\n') +
      '\n## What was done\n(fill in manually or ask AI to summarise)\n\n' +
      '## What is next\n(fill in manually or ask AI to suggest)\n';

    const statusName = baseName + '.status';
    offerDownload(outputEl, statusName, statusContent);
    await saveToMobiusDrive(userId, statusName, statusContent, append);
    append('✅ Status saved as ' + statusName);
    document.getElementById('input').value = '';
    return;
  }

  // Code: [projectname] — search for matching folders, show selection list
  const projectName = trimmed;
  if (!projectName) {
    output('Usage: Code: [projectname]  |  Code: repo  |  Code: map  |  Code: scan  |  Code: audit  |  Code: all  |  Code: status  |  Code: show  |  Code: end');
    return;
  }

  output('🔍 Select the folder containing "' + projectName + '"...');

  // Always open a fresh picker for Code: — independent of rootHandle
  let pickedHandle;
  try {
    pickedHandle = await window.showDirectoryPicker({ mode: 'read' });
  } catch (err) {
    if (err.name !== 'AbortError') output('❌ Access denied: ' + err.message);
    else output('❌ Cancelled.');
    return;
  }

  const searchLower = projectName.toLowerCase();

  // Case 1: selected folder IS the project
  if (pickedHandle.name.toLowerCase() === searchLower) {
    document.getElementById('input').value = '';
    await codeSelectFolder({ name: pickedHandle.name, relPath: pickedHandle.name, handle: pickedHandle }, projectName, outputEl);
    return;
  }

  // Case 2: search one level deep inside selected folder
  const matches = [];
  for await (const [name, handle] of pickedHandle.entries()) {
    if (handle.kind !== 'directory') continue;
    if (CODE_EXCLUDE.has(name)) continue;
    if (name.toLowerCase().includes(searchLower)) {
      matches.push({ name, relPath: name, handle });
    }
  }

  // Case 3: exact match found — use directly without showing list
  const exact = matches.filter(m => m.name.toLowerCase() === searchLower);
  if (exact.length === 1) {
    document.getElementById('input').value = '';
    await codeSelectFolder(exact[0], projectName, outputEl);
    return;
  }

  document.getElementById('input').value = '';

  // Build selection list
  if (outputEl) {
    outputEl.classList.add('html-content');
    let html = '<div style="font-size:13px;color:#4a3728;margin-bottom:8px;">'
      + '📁 Folders matching "' + projectName + '" — click to select:</div>';

    if (matches.length === 0) {
      html += '<div style="color:#8d7c64;margin-bottom:8px;">No matching folders found.</div>';
    } else {
      matches.forEach((m, i) => {
        const id = 'code-folder-' + i;
        html += '<div id="' + id + '" style="cursor:pointer;padding:6px 10px;margin-bottom:4px;'
          + 'background:#ede5d4;border:1px solid #c9bfae;border-radius:1px;"'
          + ' onmouseover="this.style.background=\'#d9cfbc\'"'
          + ' onmouseout="this.style.background=\'#ede5d4\'"'
          + ' onclick="window.codeSelectFolderByIndex(' + i + ', document.getElementById(\'' + id + '\').closest(\'.mq-block\'))">'    
          + '📁 ' + m.relPath + '</div>';
      });
    }

    // Create new folder option
    html += '<div id="code-create" style="cursor:pointer;padding:6px 10px;margin-bottom:4px;'
      + 'background:#e8f0e8;border:1px solid #4a7c4e;border-radius:1px;color:#4a7c4e;"'
      + ' onmouseover="this.style.background=\'#d4e8d4\'"'
      + ' onmouseout="this.style.background=\'#e8f0e8\'"'
      + ' onclick="window.codeCreateFolder(\'' + projectName + '\', document.getElementById(\'code-create\').closest(\'.mq-block\'))">'    
      + '➕ Create new folder: ' + projectName + '</div>';

    // Cancel option
    html += '<div style="cursor:pointer;padding:6px 10px;margin-bottom:4px;'
      + 'background:#f5eedd;border:1px solid #c9bfae;border-radius:1px;color:#8d7c64;"'
      + ' onmouseover="this.style.background=\'#ede5d4\'"'
      + ' onmouseout="this.style.background=\'#f5eedd\'"'
      + ' onclick="this.closest(\'.mq-block\').innerHTML=\'❌ Cancelled.\'">'    
      + '✕ Cancel</div>';

    outputEl.innerHTML = html;

    // Store matches for click handler
    window._codeFolderMatches = matches;
    window._codeFolderProjectName = projectName;
  }
}

// Internal handler — called directly or from click list
async function codeSelectFolder(m, projectName, outputEl) {
  const userId = getAuth('mobius_user_id');
  if (!m) return;

  outputEl.classList.add('html-content');
  outputEl.innerHTML = '⏳ Loading ' + m.relPath + '...';

  const baseName  = projectName.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  const mapName   = baseName + '.map';
  const repoName  = baseName + '.repo';
  const auditName = baseName + '.audit';

  async function findDocFile(dirHandle, filename, depth) {
    if (depth > 3) return null;
    for await (const [name, handle] of dirHandle.entries()) {
      if (handle.kind === 'file' && name.toLowerCase() === filename) {
        const file = await handle.getFile();
        return { content: await file.text(), date: new Date(file.lastModified) };
      }
      if (handle.kind === 'directory' && name.toLowerCase() === 'documents') {
        const found = await findDocFile(handle, filename, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  let mapResult, repoResult, auditResult;
  try {
    [mapResult, repoResult, auditResult] = await Promise.all([
      findDocFile(m.handle, mapName,   0),
      findDocFile(m.handle, repoName,  0),
      findDocFile(m.handle, auditName, 0)
    ]);
  } catch (err) {
    outputEl.innerHTML = '❌ Error reading files: ' + err.message;
    return;
  }

  codeSession = {
    projectName,
    projectHandle: m.handle,
    mapContent:    mapResult   ? mapResult.content   : null,
    repoContent:   repoResult  ? repoResult.content  : null,
    auditContent:  auditResult ? auditResult.content : null
  };

  updateCodeBadge();

  const fmt = d => d.toLocaleString('en-AU', { day:'numeric', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
  const lines = [
    '🟢 Code mode: ' + projectName + ' (' + m.relPath + ')',
    mapResult   ? '✅ ' + mapName   + ' — ' + fmt(mapResult.date)   : '⚠️  ' + mapName   + ' — not found',
    repoResult  ? '✅ ' + repoName  + ' — ' + fmt(repoResult.date)  : '⚠️  ' + repoName  + ' — not found',
    auditResult ? '✅ ' + auditName + ' — ' + fmt(auditResult.date) : '⚠️  ' + auditName + ' — not found',
    '',
    'AI queries use Code mode with project context.',
    'Commands: Code: repo  |  Code: map  |  Code: audit  |  Code: all  |  Code: show  |  Code: end'
  ];
  outputEl.classList.remove('html-content');
  outputEl.textContent = lines.join('\n');
}

// Called when user clicks a folder in the selection list
window.codeSelectFolderByIndex = async function(index, outputEl) {
  await codeSelectFolder(window._codeFolderMatches[index], window._codeFolderProjectName, outputEl);
};

// Called when user clicks Create new folder
window.codeCreateFolder = async function(projectName, outputEl) {
  outputEl.textContent = '📁 To create a new project folder, navigate to your projects directory and create "' + projectName + '" manually, then run Code: ' + projectName + ' again.';
};

function updateCodeBadge() {
  let badge = document.getElementById('codeBadge');
  if (!badge) {
    badge = document.createElement('span');
    badge.id = 'codeBadge';
    badge.style.cssText = 'font-size:12px; color:#fff; background:#4a7c4e; padding:2px 8px; border-radius:2px; margin-left:8px; font-family:inherit;';
    const h1 = document.querySelector('h1');
    if (h1) h1.parentNode.insertBefore(badge, h1.nextSibling);
  }
  if (codeSession) {
    badge.textContent = '⌨ ' + codeSession.projectName;
    badge.style.display = 'inline';
  } else {
    badge.style.display = 'none';
  }
}

// ── Chat History ──────────────────────────────────────────────────────────────

async function handleChatHistory(args, output) {
  output('Loading chat history...');
  try {
    const userId = localStorage.getItem('mobius_user_id');
    const res    = await fetch('/api/chat-history?userId=' + userId);
    const data   = await res.json();
    if (window.renderChatHistoryList) {
      document.getElementById('input').value = '';
      window.renderChatHistoryList(data.sessions || []);
    } else {
      output('Error: renderChatHistoryList not available.');
    }
  } catch (err) {
    output('Error loading chat history: ' + err.message);
  }
}

// ── Command registry ──────────────────────────────────────────────────────────

const COMMANDS = {
  'date':     { requiresAccess: false, isAI: false, handler: handleDate },
  'time':     { requiresAccess: false, isAI: false, handler: handleTime },
  'location': { requiresAccess: false, isAI: false, handler: handleLocation },
  'device':   { requiresAccess: false, isAI: false, handler: handleDevice },
  'google':   { requiresAccess: false, isAI: false, handler: handleGoogle },
  'access':   { requiresAccess: false, isAI: false, handler: function(args, out) { return handleAccess(out); } },
  'find':     { requiresAccess: true,  isAI: false, handler: handleFind },
  'list':     { requiresAccess: true,  isAI: false, handler: handleList },
  'history':  { requiresAccess: false, isAI: false, handler: handleChatHistory },
  'new':      { requiresAccess: false, isAI: false, handler: handleNew },
  'focus':    { requiresAccess: false, isAI: false, handler: handleFocus },
  'code':     { requiresAccess: false, isAI: false, handler: handleCode },
  'ask':      { requiresAccess: false, isAI: true },
};

// Commands that work as a single word with no colon needed
const SINGLE_WORD_COMMANDS = new Set(['date','time','location','device','access','list','history','google']);

// ── Public API (called by index.html) ─────────────────────────────────────────

function detectCommand(text) {
  const trimmed = text.trim();
  const lower   = trimmed.toLowerCase();

  // Single-word shortcut — no whitespace, no colon required
  if (SINGLE_WORD_COMMANDS.has(lower) && !/\s/.test(trimmed)) {
    return { command: lower, args: '' };
  }

  // Standard colon-prefix
  const match = trimmed.match(/^(\w+):\s*([\s\S]*)/);
  if (!match) return null;
  const command = match[1].toLowerCase();
  if (!COMMANDS[command]) return null;
  return { command, args: match[2].trim() };
}

async function runCommand(command, args, outputFn, outputEl) {
  const cmd = COMMANDS[command];
  if (!cmd || cmd.isAI) return false;
  await cmd.handler(args, outputFn, outputEl);
  return true;
}

// Returns the model for the current Ask and updates saved default if explicit.
function getAskModel(text) {
  const match = text.match(/^Ask:\s*(\w+)/i);
  if (match) {
    const model = match[1].toLowerCase();
    if (MODEL_CHAIN.includes(model)) {
      setLastModel(model);
      return model;
    }
  }
  return getLastModel();
}
