// _archive/coder_modules/js/archived_functions.js
// Functions removed from active Mobius JS modules.
// Kept for reference -- not loaded by index.html.
// ─────────────────────────────────────────────────────────────────────────────

// ── From commands.js: classifyTaskType ────────────────────────────────────────
// Fast keyword classifier that mapped task intent to a model stable.
// Replaced by runOrchestrator -- all queries now go through the pipeline.

function classifyTaskType(text) {
  const t = text.toLowerCase();
  if (/\b(fix|bug|error|broken|wrong|crash|fail|exception|not working|undefined|null ref)\b/.test(t)) return 'groq-cascade';
  if (/\b(explain|how does|what does|what is|describe|walk me|walk through|understand)\b/.test(t)) return 'gemini-lite';
  if (/\b(review|audit|check|assess|quality|issues|problems with|look at)\b/.test(t)) return 'gemini-cascade';
  if (/\b(plan|architect|design|strategy|approach|should i|best way|how to|recommend)\b/.test(t)) return 'gemini-cascade';
  if (/\b(write|create|implement|build|generate|add a function|add a class|refactor)\b/.test(t)) return 'mistral-cascade';
  return null;
}

// ── From connectivity.js: checkOllama ────────────────────────────────────────
// Checks local Ollama instance. Removed from startup checks -- Mobius is
// cloud-only. Re-add to the checks[] array in Connectivity.run() to restore.

async function checkOllama() {
  const endpoints = ['http://localhost:3000/ollama/api/tags', 'http://localhost:11434/api/tags'];
  for (const url of endpoints) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) continue;
      const data   = await res.json();
      const models = (data.models || []);
      if (models.length === 0) return { status: 'warn', items: [], detail: 'Ollama running -- no models loaded' };
      const items = models.map(m => {
        const base = m.name.split(':')[0];
        const tag  = m.name.includes(':') ? m.name.split(':')[1] : '';
        let provider = 'Ollama';
        if (base.includes('qwen'))     provider = 'Alibaba (Qwen)';
        if (base.includes('deepseek')) provider = 'DeepSeek';
        if (base.includes('llama'))    provider = 'Meta';
        if (base.includes('mistral'))  provider = 'Mistral AI';
        if (base.includes('gemma'))    provider = 'Google';
        if (base.includes('phi'))      provider = 'Microsoft';
        return { ok: true, provider, model: base + (tag ? ':' + tag : '') };
      });
      return { status: 'ok', items, detail: '' };
    } catch { continue; }
  }
  return { status: 'warn', items: [], detail: 'Ollama not running' };
}
