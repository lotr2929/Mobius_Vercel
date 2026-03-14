async function handleFocusPulse(args, output, outputEl) {
  if (args.trim()) return handleFocus(args, output, outputEl);
  return handleFocusQuery(args, output, outputEl);
}
function handleCodePulse(args, output, outputEl) {
  if (args.trim()) return handleCode(args, output, outputEl);
  return handleCodeQuery(args, output, outputEl);
}
function handleMobiusPulse(args, output, outputEl) {
  if (args.trim()) return handleMobius(args, output, outputEl);
  return handleMobiusQuery(args, output, outputEl);
}

// ── Status: models ────────────────────────────────────────────────────────────
async function handleStatusModels(args, output, outputEl) {
  output('🔍 Pinging all cloud AI models…');

  let res, data;
  try {
    res  = await fetch('/api/services/status');
    data = await res.json();
  } catch (err) {
    output('❌ Could not reach /api/services/status: ' + err.message);
    return;
  }

  if (data.error) { output('❌ ' + data.error); return; }

  const lines = ['Cloud AI Models\n'];
  for (const m of data.models) {
    const status = m.ok
      ? '✅  ' + m.name + '  ·  ' + m.ms + 'ms'
      : '❌  ' + m.name + '  ·  ' + m.error;
    lines.push(status);
    lines.push('     Context: ' + m.context + '  |  ' + m.note);
    lines.push('');
  }

  // Local models — check Ollama directly from client
  lines.push('Local AI Models\n');
  try {
    const ollamaRes = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(4000) });
    if (ollamaRes.ok) {
      const od = await ollamaRes.json();
      const pulled = (od.models || []).map(m => m.name);
      const qwen     = pulled.find(n => n.includes('qwen'));
      const deepseek = pulled.find(n => n.includes('deepseek'));
      lines.push((qwen     ? '✅' : '⚠️') + '  Ollama Qwen 2.5 Coder 7B   ·  Context: 128k  |  Fast local coding');
      if (!qwen) lines.push('     Not pulled — run: ollama pull qwen2.5-coder:7b');
      lines.push('');
      lines.push((deepseek ? '✅' : '⚠️') + '  Ollama DeepSeek R1 7B       ·  Context: 64k   |  Local reasoning');
      if (!deepseek) lines.push('     Not pulled — run: ollama pull deepseek-r1:7b');
    } else {
      lines.push('⚠️  Ollama not running  ·  Start with start-ollama.bat');
    }
  } catch {
    lines.push('⚠️  Ollama not running  ·  Start with start-ollama.bat');
  }
  lines.push('');
  lines.push('ℹ️  WebLLM Qwen 2.5 Coder 1.5B  ·  Context: ~4k  |  Browser offline fallback');

  if (outputEl) {
    outputEl.style.whiteSpace = 'pre';
    outputEl.textContent = lines.join('\n');
  } else {
    output(lines.join('\n'));
  }
}

async function handleStatus(args, output, outputEl) {
  const sub = args.trim().toLowerCase();
  if (!sub || sub === 'models') return handleStatusModels(args, output, outputEl);
  output('Unknown Status: command. Try: Status: models');
}

// ── Register all commands ─────────────────────────────────────────────────────
Object.assign(COMMANDS, {
  // ? = contextual help cards
  'mobius?':  { requiresAccess: false, isAI: false, handler: handleMobiusHelp },
  'google?':  { requiresAccess: false, isAI: false, handler: handleGoogleHelp },
  'dropbox?': { requiresAccess: false, isAI: false, handler: handleDropboxHelp },
  'code?':    { requiresAccess: false, isAI: false, handler: handleCodeHelp },
  'focus?':   { requiresAccess: false, isAI: false, handler: handleFocusHelp },
  'sync?':    { requiresAccess: false, isAI: false, handler: handleSyncHelp },
  // base commands: no-arg = pulse, with-arg = action (via pulse wrappers)
  'google':   { requiresAccess: false, isAI: false, handler: handleGooglePulse },
  'dropbox':  { requiresAccess: false, isAI: false, handler: handleDropboxPulse },
  'sync':     { requiresAccess: false, isAI: false, handler: handleSyncPulse },
  'focus':    { requiresAccess: false, isAI: false, handler: handleFocusPulse },
  'code':     { requiresAccess: false, isAI: false, handler: handleCodePulse },
  'mobius':   { requiresAccess: false, isAI: false, handler: handleMobiusPulse },
  // status
  'status':   { requiresAccess: false, isAI: false, handler: handleStatus },
  // memory commands
  'remember': { requiresAccess: false, isAI: false, handler: handleRemember },
  'forget':   { requiresAccess: false, isAI: false, handler: handleForget },
  'amend':    { requiresAccess: false, isAI: false, handler: handleAmend },
  'review':   { requiresAccess: false, isAI: false, handler: handleReview },
  'refine':   { requiresAccess: false, isAI: false, handler: handleRefine },
});

// ── Patch detectCommand to handle ? suffix and new single-word commands ───────
const _detectCommandOrig = detectCommand;
window._detectCommandPatched = true;

// Re-export detectCommand with ? support baked in
// (overrides the function in the same script scope via reassignment is not possible in strict mode,
//  so we patch the exported reference used by index.html — see runCommand which calls COMMANDS directly)
// The ? commands are registered in COMMANDS above with their full key (e.g. 'mobius?')
// detectCommand already handles colon-prefix; we extend it here for ? suffix:
const _origDetect = detectCommand;
function detectCommandExtended(text) {
  const trimmed = text.trim();
  // ? suffix pulse commands: Mobius? Google? Code? Focus? Dropbox? Sync?
  const qMatch = trimmed.match(/^(\w+)\?$/);
  if (qMatch) {
    const cmd = qMatch[1].toLowerCase() + '?';
    if (COMMANDS[cmd]) return { command: cmd, args: '' };
  }
  return _origDetect(text);
}
// Expose for index.html
window.detectCommandExtended = detectCommandExtended;
