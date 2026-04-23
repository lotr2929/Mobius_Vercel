// js/startup.js -- Auto-restore coderRootHandle from IndexedDB on startup.
// Reads /mcp.json for config and session_task.
// On load: silently restores home handle if permission is 'granted'.
// Also silently restores project handle (saved by commands.js) after app ready.
// Fires session_task query automatically -- no button, no coderRootHandle check.
// I (Claude Desktop) write session_task.query to mcp.json between sessions.
// Boon refreshes Coder -- query fires, logs to chats/, I read via MCP to verify.

(function () {
  'use strict';

  const IDB_DB    = 'mobius';
  const IDB_STORE = 'handles';

  function openIDB() {
    return new Promise(function (resolve, reject) {
      const req = indexedDB.open(IDB_DB, 1);
      req.onupgradeneeded = function (e) { e.target.result.createObjectStore(IDB_STORE); };
      req.onsuccess       = function (e) { resolve(e.target.result); };
      req.onerror         = function (e) { reject(e.target.error); };
    });
  }

  async function idbGet(key) {
    const db = await openIDB();
    return new Promise(function (resolve, reject) {
      const tx  = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = function (e) { resolve(e.target.result); };
      req.onerror   = function (e) { reject(e.target.error); };
    });
  }

  async function idbSet(key, value) {
    const db = await openIDB();
    return new Promise(function (resolve, reject) {
      const tx  = db.transaction(IDB_STORE, 'readwrite');
      const req = tx.objectStore(IDB_STORE).put(value, key);
      req.onsuccess = function () { resolve(true); };
      req.onerror   = function (e) { reject(e.target.error); };
    });
  }

  function makeStamp() {
    const now = new Date();
    const pad = function (n) { return String(n).padStart(2, '0'); };
    return now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate())
      + '-' + pad(now.getHours()) + pad(now.getMinutes());
  }

  window.storeCoderHandle = async function (handle) {
    try {
      const cfg = window._mcpConfig;
      if (!cfg) return;
      await idbSet(cfg.idb_key, handle);
      console.log('[startup] coderRootHandle stored in IndexedDB');
    } catch (err) { console.warn('[startup] Could not store handle:', err.message); }
  };

  window.regrantCoderHandle = async function () {
    const handle = window._pendingCoderHandle;
    if (!handle) return false;
    try {
      const perm = await handle.requestPermission({ mode: 'readwrite' });
      if (perm === 'granted') {
        window.coderRootHandle    = handle;
        window.coderSessionStamp  = makeStamp();
        window._pendingCoderHandle = null;
        try { const cfg = window._mcpConfig || {}; await handle.getDirectoryHandle(cfg.chats || 'chats', { create: true }); } catch {}
        console.log('[startup] coderRootHandle re-granted');
        return true;
      }
    } catch (err) { console.warn('[startup] Re-grant failed:', err.message); }
    return false;
  };

  // -- Silent restore of home handle -------------------------------------------

  async function tryRestore(cfg) {
    try {
      const handle = await idbGet(cfg.idb_key);
      if (!handle) return null;
      const perm = await handle.queryPermission({ mode: 'readwrite' });
      if (perm === 'granted') return handle;
      if (perm === 'prompt') { window._pendingCoderHandle = handle; console.log('[startup] Home handle needs re-grant'); }
      return null;
    } catch (err) { console.warn('[startup] Restore failed:', err.message); return null; }
  }

  // -- Silent restore of project handle ----------------------------------------
  // commands.js saves the project handle in DB 'MobiusCoderFS', key 'rootHandle'.
  // Called AFTER app-ready (inside fireSessionTask) so commands.js is loaded.

  async function tryRestoreProject() {
    try {
      const db = await new Promise(function (resolve, reject) {
        const req = indexedDB.open('MobiusCoderFS', 1);
        req.onupgradeneeded = function () {};
        req.onsuccess = function (e) { resolve(e.target.result); };
        req.onerror   = function (e) { reject(e.target.error); };
      });
      const handle = await new Promise(function (resolve) {
        try {
          const tx = db.transaction('handles', 'readonly');
          const r  = tx.objectStore('handles').get('rootHandle');
          r.onsuccess = function () { resolve(r.result || null); };
          r.onerror   = function () { resolve(null); };
        } catch { resolve(null); }
      });
      if (!handle) return false;
      const perm = await handle.queryPermission({ mode: 'readwrite' });
      if (perm !== 'granted') { console.log('[startup] Project handle needs re-grant (' + perm + ')'); return false; }
      if (window.ensureAccess) await window.ensureAccess(function () {}, true);
      const h = window.getRootHandle && window.getRootHandle();
      if (h) {
        console.log('[startup] Project restored silently: ' + h.name);
        if (window.setupProjectContext) await window.setupProjectContext(h, function () {}).catch(function () {});
        return true;
      }
      return false;
    } catch (err) { console.warn('[startup] Project restore failed:', err.message); return false; }
  }

  // -- Silent restore of project handle ----------------------------------------
  // commands.js saves the project handle in DB 'MobiusCoderFS', key 'rootHandle'.
  // queryPermission is silent -- Edge/Chrome preserve permissions within a session.
  // Called AFTER app-ready (inside fireSessionTask) so commands.js is loaded.

  async function tryRestoreProject() {
    try {
      const db = await new Promise(function (resolve, reject) {
        const req = indexedDB.open('MobiusCoderFS', 1);
        req.onupgradeneeded = function () { /* DB created by commands.js -- no stores needed here */ };
        req.onsuccess = function (e) { resolve(e.target.result); };
        req.onerror   = function (e) { reject(e.target.error); };
      });
      const handle = await new Promise(function (resolve) {
        try {
          const tx = db.transaction('handles', 'readonly');
          const r  = tx.objectStore('handles').get('rootHandle');
          r.onsuccess = function () { resolve(r.result || null); };
          r.onerror   = function () { resolve(null); };
        } catch { resolve(null); }
      });
      if (!handle) return false;
      const perm = await handle.queryPermission({ mode: 'readwrite' });
      if (perm !== 'granted') {
        console.log('[startup] Project handle needs re-grant (' + perm + ')');
        return false;
      }
      // Restore via commands.js ensureAccess (loads from IDB, finds granted)
      if (window.ensureAccess) await window.ensureAccess(function () {}, true);
      const h = window.getRootHandle && window.getRootHandle();
      if (h) {
        console.log('[startup] Project restored silently: ' + h.name);
        if (window.setupProjectContext) {
          await window.setupProjectContext(h, function () {}).catch(function () {});
          console.log('[startup] Project context loaded for: ' + h.name);
        }
        return true;
      }
      return false;
    } catch (err) {
      console.warn('[startup] Project restore failed:', err.message);
      return false;
    }
  }

  // -- Fire session task -------------------------------------------------------
  // Waits for app ready, restores project handle silently, fires query.

  async function fireSessionTask(task) {
    if (!task || !task.query) return;

    // Wait for app ready (commands.js + all modules loaded)
    await new Promise(function (resolve) {
      var t = setInterval(function () {
        if (window.COMMANDS && window.runAllModels && document.getElementById('input')) { clearInterval(t); resolve(); }
      }, 100);
      setTimeout(function () { clearInterval(t); resolve(); }, 12000);
    });
    await new Promise(function (r) { setTimeout(r, 800); });

    // Silently restore project handle -- runs here because commands.js is now loaded
    const projectRestored = await tryRestoreProject();
    if (!projectRestored) {
      console.log('[startup] Project handle not restored -- session task may need Project: Open first');
    }

    // Enable All Mode if requested
    if (task.all_mode && window.toggleAllMode) {
      if (!window.allModeActive) window.toggleAllMode(function () {});
    }

    // Set indexed project name for RAG even without file access
    if (task.project) {
      window._indexedProject = task.project;
      if (window.updateTargetBadge) window.updateTargetBadge();
    }

    // Fire via input field -- same dispatch path as manual typing
    var inp = document.getElementById('input');
    if (!inp) return;
    inp.value = task.query;
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    console.log('[startup] session task fired: ' + task.query.slice(0, 60));
  }

  // -- Main init ---------------------------------------------------------------

  async function init() {
    try {
      const res = await fetch('/mcp.json');
      if (!res.ok) return;
      const cfg = await res.json();
      window._mcpConfig = cfg;
      const handle = await tryRestore(cfg);
      if (handle) {
        window.coderRootHandle   = handle;
        window.coderSessionStamp = makeStamp();
        try { await handle.getDirectoryHandle(cfg.chats || 'chats', { create: true }); } catch {}
        console.log('[startup] Home restored: ' + handle.name);
      }

      if (cfg.brief_eval_always) window.briefEvalAlways = true;

      // Fire session task -- project handle restore happens inside after app-ready wait
      if (cfg.session_task && cfg.session_task.query) {
        fireSessionTask(cfg.session_task).catch(e => console.warn('[startup] task failed:', e.message));
      }
    } catch (err) { console.warn('[startup] init failed:', err.message); }
  }

  if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', init); }
  else { init(); }

})();
