// js/log.js -- Session log writer
// Appends all AI responses to chats/chat-TIMESTAMP.md in Coder's home folder.
// Requires Project: Home to be run once per session (sets coderRootHandle).
// Falls back to rootHandle/_context/chat.md if coderRootHandle not set.
// Claude Desktop reads chats/ via MCP to review model performance.
// Format: one file per session, timestamped, appends -- never overwrites.

(function () {
  'use strict';

  const CTX_DIR  = '_context';

  // -- Helpers -----------------------------------------------------------------

  function timestamp() {
    return new Date().toLocaleString('en-AU', {
      weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true
    });
  }

  async function writeToHandle(dirHandle, filename, content) {
    try {
      const fh = await dirHandle.getFileHandle(filename, { create: true });
      const w  = await fh.createWritable();
      await w.write(content);
      await w.close();
      return true;
    } catch (e) { console.error('[log] writeToHandle failed:', e); return false; }
  }

  async function readFromHandle(dirHandle, filename) {
    try {
      const fh   = await dirHandle.getFileHandle(filename, { create: false });
      const file = await fh.getFile();
      return await file.text();
    } catch { return null; }
  }

  // -- Main append function ----------------------------------------------------
  // query   : string -- the user's input
  // entries : string (single) OR array of { model, content } (All Mode)
  // source  : 'single' | 'all' | 'router'
  // brief   : string (optional) -- context injected before the query

  async function appendToLog(query, entries, source, brief) {
    let logDir  = null;
    let logFile = null;
    let projectName = 'Coder';

    // Primary: coderRootHandle + chats/ folder (set by Project: Home)
    if (window.coderRootHandle) {
      try {
        logDir  = await window.coderRootHandle.getDirectoryHandle('chats', { create: true });
        const stamp = window.coderSessionStamp || 'session';
        logFile = 'chat-' + stamp + '.md';
        projectName = window.coderRootHandle.name;
      } catch { logDir = null; }
    }

    // Fallback: rootHandle + _context/chat.md (legacy, project open)
    if (!logDir) {
      const root = window.getRootHandle && window.getRootHandle();
      if (!root) return;
      try {
        logDir  = await root.getDirectoryHandle(CTX_DIR, { create: true });
        logFile = 'chat.md';
        projectName = window._projectContext
          ? (window.getProjectMapRoot ? window.getProjectMapRoot() : root.name)
          : root.name;
      } catch { return; }
    }

    const existing = await readFromHandle(logDir, logFile);

    // Initialise file header if new
    let content = existing;
    if (!content) {
      content = '# Session Log -- ' + projectName + '\n'
        + '_Written by mobius. Read by Claude Desktop via MCP._\n\n';
    }

    // Build entry
    const ts = timestamp();
    let entry = '---\n\n## ' + ts + '\n**Q:** ' + query + '\n\n';

    // Log injected brief so Claude Desktop can verify what models actually saw
    if (brief && brief.trim()) {
      const charCount = brief.length;
      const tokEst    = Math.round(charCount / 4);
      const preview   = charCount > 1200 ? brief.slice(0, 1200) + '\n...[truncated]' : brief;
      entry += '**Brief injected (~' + tokEst + ' tokens):**\n```\n' + preview + '\n```\n\n';
    }

    if (source === 'router') {
      entry += '_' + String(entries) + '_\n\n';
    } else if (source === 'all' && Array.isArray(entries)) {
      for (const e of entries) {
        entry += '### ' + e.model + '\n' + e.content + '\n\n';
      }
    } else {
      const e = Array.isArray(entries) ? entries[0] : entries;
      if (e && e.model) {
        entry += '**' + e.model + ':** ' + e.content + '\n\n';
      } else {
        entry += String(entries) + '\n\n';
      }
    }

    const wrote = await writeToHandle(logDir, logFile, content + entry);
    if (wrote) console.log('[log] Appended to ' + logFile);
  }

  // -- Expose ------------------------------------------------------------------

  window.appendToLog = appendToLog;

})();
