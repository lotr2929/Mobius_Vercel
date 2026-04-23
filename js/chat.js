// ── js/chat.js ────────────────────────────────────────────────────────────────
// Chat: family -- session management, history, planning, diary.
// Aliases: new, history kept for backward compatibility.
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ── Chat: New ─────────────────────────────────────────────────────────────

  async function handleChatNew(args, output) {
    if (window.clearHistory) window.clearHistory();
    if (window.newChat) window.newChat(args);
    else {
      document.getElementById('chatPanel').innerHTML = '';
      document.getElementById('input').value = '';
      output('New chat started.');
    }
  }

  // ── Chat: History ─────────────────────────────────────────────────────────

  async function handleChatHistory(args, output, outputEl) {
    const userId = window.getAuth ? window.getAuth('mobius_user_id') : null;
    if (!userId) { output('Not logged in. History requires a user account.'); return; }
    output('Loading history...');
    try {
      const res  = await fetch('/api/data?action=history&userId=' + encodeURIComponent(userId));
      const data = await res.json();
      if (data.error) { output('Error: ' + data.error); return; }
      if (!data.sessions || data.sessions.length === 0) { output('No history yet.'); return; }
      outputEl.classList.add('html-content');
      outputEl.innerHTML = '<div style="font-weight:bold;font-size:14px;margin-bottom:8px;">Chat History</div>'
        + data.sessions.map(s =>
          '<div style="margin-bottom:10px;padding-bottom:10px;border-bottom:1px solid var(--border);">'
          + '<div style="font-size:12px;color:var(--text-dim);">'
          + new Date(s.started_at).toLocaleString('en-AU') + ' &middot; ' + s.messages.length + ' messages</div>'
          + '<div style="font-weight:bold;margin:2px 0;">' + esc((s.title || '(untitled)').slice(0, 80)) + '</div>'
          + s.messages.slice(0, 2).map(m =>
            '<div style="font-size:12px;color:var(--text-muted);margin-left:8px;">Q: ' + esc(m.question.slice(0, 100)) + '</div>'
          ).join('')
          + '</div>'
        ).join('');
      document.getElementById('input').value = '';
    } catch (err) {
      output('Failed: ' + err.message);
    }
  }

  // ── Chat: Log ─────────────────────────────────────────────────────────────
  // Reads _context/log_summary.md from the opened project folder.

  async function handleChatLog(args, output, outputEl) {
    const handle = window.getRootHandle ? window.getRootHandle() : null;
    if (!handle) {
      output('No folder open. Run Project: Open first, then Chat: Log.');
      return;
    }
    output('Reading log summary...');
    try {
      let logDir, logFile;
      for await (const [name, h] of handle.entries()) {
        if (name === '_context' && h.kind === 'directory') { logDir = h; break; }
      }
      if (logDir) {
        for await (const [name, h] of logDir.entries()) {
          if (name === 'log_summary.md' && h.kind === 'file') { logFile = h; break; }
        }
      }
      if (!logFile) {
        output('_context/log_summary.md not found.\nRun Chat: End at the end of a session to generate it.');
        return;
      }
      const content = await (await logFile.getFile()).text();
      document.getElementById('input').value = '';
      if (window.panel) {
        window.panel.open('Log Summary', content, 'output');
        output('Log summary loaded -- see panel');
      } else {
        output(content);
      }
    } catch (err) {
      output('Failed: ' + err.message);
    }
  }

  // ── Chat: Diary ───────────────────────────────────────────────────────────
  // Fetches recent dev_diary entries from Supabase (stub -- needs API endpoint).

  async function handleChatDiary(args, output, outputEl) {
    outputEl.classList.add('html-content');
    outputEl.innerHTML = '<div style="font-size:13px;">'
      + '<div style="font-weight:bold;margin-bottom:6px;">Chat: Diary -- not yet available</div>'
      + '<div style="color:var(--text-muted);">The diary endpoint has not been built yet for mobius.</div>'
      + '<div style="margin-top:8px;">Use <strong>Chat: Log</strong> to view recent session summaries from the open project.</div>'
      + '</div>';
    document.getElementById('input').value = '';
  }

  // ── Chat: Plan ────────────────────────────────────────────────────────────
  // AI reads CLAUDE.md + log_summary (if available), recommends next task.

  async function handleChatPlan(args, output, outputEl) {
    output('Building context...');

    let claudeMd    = '';
    let logSummary  = '';
    const handle    = window.getRootHandle ? window.getRootHandle() : null;

    if (handle) {
      try {
        // Read _context/CLAUDE.md
        for await (const [name, h] of handle.entries()) {
          if (name === '_context' && h.kind === 'directory') {
            for await (const [fname, fh] of h.entries()) {
              if (fname === 'CLAUDE.md') claudeMd   = await (await fh.getFile()).text();
              if (fname === 'log_summary.md') logSummary = await (await fh.getFile()).text();
            }
            break;
          }
        }
      } catch { /* skip */ }
    }

    const devguide = (args || '').trim();

    const prompt = [
      'You are a coding assistant helping a developer plan their next task.',
      '',
      claudeMd   ? 'Project context (CLAUDE.md):\n' + claudeMd.slice(0, 1500) : '',
      logSummary ? 'Recent activity (log_summary.md):\n' + logSummary.slice(0, 1000) : '',
      devguide   ? 'Additional context from developer:\n' + devguide : '',
      '',
      'Based on the above, what is the most logical next task to work on?',
      'Be specific. Name files, commands, or features. Keep the response to 150 words.'
    ].filter(Boolean).join('\n');

    await window.sendToAI('gemini-lite', [{ role: 'user', content: prompt }], output, outputEl);
  }

  // ── Chat: End ─────────────────────────────────────────────────────────────
  // Writes a session summary to the diary and updates log_summary.md.
  // Groq reads the session and produces a summary; Mobius writes it.

  async function handleChatEnd(args, output, outputEl) {
    output('Writing session summary...');

    const handle = window.getRootHandle ? window.getRootHandle() : null;

    // Read last log summary for context
    let prevLog = '';
    if (handle) {
      try {
        for await (const [name, h] of handle.entries()) {
          if (name === '_context' && h.kind === 'directory') {
            for await (const [fname, fh] of h.entries()) {
              if (fname === 'log_summary.md') prevLog = await (await fh.getFile()).text();
            }
          }
        }
      } catch { /* skip */ }
    }

    const notes = (args || '').trim();

    const prompt = [
      'You are writing a session log summary for a developer. Be concise -- under 200 words.',
      'Format:',
      '',
      'Last updated: [today\'s date]',
      '',
      'Recent activity:',
      '- [file/feature]: [what changed]',
      '',
      'Known fragile areas:',
      '- [any fragility noted]',
      '',
      'Last deploy: [status]',
      '',
      prevLog ? 'Previous log:\n' + prevLog.slice(0, 800) : '',
      notes   ? 'Developer notes for this session:\n' + notes : 'No specific notes provided.',
      '',
      'Write an updated log_summary.md based on the above.'
    ].filter(Boolean).join('\n');

    try {
      const res  = await fetch('/ask', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ query: prompt, model: 'groq', userId: window.getAuth ? window.getAuth('mobius_user_id') : null })
      });
      const data    = await res.json();
      const summary = (data.reply || data.answer || '').trim();

      if (!summary) { output('No summary generated.'); return; }

      // Write to _context/log_summary.md if folder is open
      let wrote = false;
      if (handle) {
        try {
          let ctxDir = null;
          for await (const [name, h] of handle.entries()) {
            if (name === '_context' && h.kind === 'directory') { ctxDir = h; break; }
          }
          if (!ctxDir) ctxDir = await handle.getDirectoryHandle('_context', { create: true });
          const fh = await ctxDir.getFileHandle('log_summary.md', { create: true });
          const w  = await fh.createWritable();
          await w.write(summary);
          await w.close();
          wrote = true;
        } catch { /* fall through */ }
      }

      document.getElementById('input').value = '';
      if (window.panel) {
        window.panel.open('Session Summary', summary, 'output');
        output('Session summary written'
          + (wrote ? ' to _context/log_summary.md' : ' (panel only -- no folder open)')
          + ' -- see panel');
      } else {
        output(summary);
      }
    } catch (err) {
      output('End session failed: ' + err.message);
    }
  }

  // ── Chat: Date / Time (utility) ────────────────────────────────────────────

  function handleChatDate(args, output) {
    output(new Date().toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }));
    document.getElementById('input').value = '';
  }

  function handleChatTime(args, output) {
    output(new Date().toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit', hour12: true }));
    document.getElementById('input').value = '';
  }

  // ── Self-register ──────────────────────────────────────────────────────────

  function register() {
    if (!window.COMMANDS) { setTimeout(register, 50); return; }
    window.COMMANDS['chat: new']     = { handler: handleChatNew,     family: 'chat', desc: 'Start a new chat session, clear history'        };
    window.COMMANDS['chat: history'] = { handler: handleChatHistory, family: 'chat', desc: 'View past sessions from Supabase'               };
    window.COMMANDS['chat: log']     = { handler: handleChatLog,     family: 'chat', desc: 'Show _context/log_summary.md from open project' };
    window.COMMANDS['chat: diary']   = { handler: handleChatDiary,   family: 'chat', desc: 'Fetch recent dev diary entries from Supabase'   };
    window.COMMANDS['chat: plan']    = { handler: handleChatPlan,    family: 'chat', desc: 'AI recommends next task from project context'   };
    window.COMMANDS['chat: end']     = { handler: handleChatEnd,     family: 'chat', desc: 'Write session summary, update log_summary.md'   };
    window.COMMANDS['chat: date']    = { handler: handleChatDate,    family: 'chat', desc: 'Show current date'                             };
    window.COMMANDS['chat: time']    = { handler: handleChatTime,    family: 'chat', desc: 'Show current time'                             };
    // Backward-compatible aliases
    window.COMMANDS['new']     = { handler: handleChatNew,     family: 'chat', desc: 'alias -- Chat: New'     };
    window.COMMANDS['history'] = { handler: handleChatHistory, family: 'chat', desc: 'alias -- Chat: History' };
    window.COMMANDS['date']    = { handler: handleChatDate,    family: 'chat', desc: 'alias -- Chat: Date'    };
    window.COMMANDS['time']    = { handler: handleChatTime,    family: 'chat', desc: 'alias -- Chat: Time'    };
  }
  register();

})();
