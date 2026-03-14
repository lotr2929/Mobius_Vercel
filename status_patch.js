
// ── Status: models ────────────────────────────────────────────────────────────
async function handleStatusModels(args, output, outputEl) {
  output('🔍 Pinging all cloud AI models…');

  let data;
  try {
    const res = await fetch('/api/services/status');
    data = await res.json();
  } catch (err) {
    output('❌ Could not reach status endpoint: ' + err.message);
    return;
  }
  if (data.error) { output('❌ ' + data.error); return; }

  const lines = ['Cloud AI Models\n'];
  for (const m of data.models) {
    lines.push((m.ok ? '✅' : '❌') + '  ' + m.name + (m.ok ? '  ·  ' + m.ms + 'ms' : '  ·  ' + m.error));
    lines.push('     Context: ' + m.context + '  |  ' + m.note);
    lines.push('');
  }

  lines.push('Local AI Models\n');
  try {
    const r = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(4000) });
    if (r.ok) {
      const od = await r.json();
      const pulled = (od.models || []).map(m => m.name);
      const qwen     = pulled.find(n => n.includes('qwen'));
      const deepseek = pulled.find(n => n.includes('deepseek'));
      lines.push((qwen     ? '✅' : '⚠️') + '  Ollama Qwen 2.5 Coder 7B   ·  Context: 128k  |  Fast local coding');
      if (!qwen)     lines.push('     Not pulled — run: ollama pull qwen2.5-coder:7b');
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

  if (outputEl) { outputEl.style.whiteSpace = 'pre'; outputEl.textContent = lines.join('\n'); }
  else output(lines.join('\n'));
}

// Register Status: models as a sub-command of the existing Status: handler
const _origHandleStatus = COMMANDS['status']?.handler;
COMMANDS['status'] = {
  requiresAccess: false, isAI: false,
  handler: async function(args, output, outputEl) {
    const sub = (args || '').trim().toLowerCase();
    if (sub === 'models') return handleStatusModels(args, output, outputEl);
    if (_origHandleStatus) return _origHandleStatus(args, output, outputEl);
    output('Usage: Status: (no arg) or Status: models');
  }
};
