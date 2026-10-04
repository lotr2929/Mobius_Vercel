// ai/audit.js — keeps the model stack honest. Free tiers change without notice (Groq retired
// Llama 3.3, Cerebras and Mistral closed models to free keys), so this checks the registry
// against what each provider actually offers:
//   • is every registered model still listed?  (if not, it is marked retired and skipped)
//   • which newer models have appeared that the registry does not know about?
// Listing models costs no generation quota. `probe: true` also makes a tiny live call per
// model, which is the only way to learn whether a free key may really use it.
import { KEYS } from '../config.js';
import { MODELS } from './models.js';
import { setRetired } from './cascade.js';
import { setState, getState } from '../pcm/memory.js';

const LISTERS = {
  async gemini() {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${KEYS.gemini}`, { signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return (await r.json()).models.filter(m => (m.supportedGenerationMethods || []).includes('generateContent')).map(m => m.name.replace(/^models\//, ''));
  },
  async groq() {
    const r = await fetch('https://api.groq.com/openai/v1/models', { headers: { Authorization: 'Bearer ' + KEYS.groq }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return (await r.json()).data.map(m => m.id);
  },
  async mistral() {
    const r = await fetch('https://api.mistral.ai/v1/models', { headers: { Authorization: 'Bearer ' + KEYS.mistral }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return (await r.json()).data.filter(m => m.capabilities?.completion_chat).map(m => m.id);
  },
  async nvidia() {
    const r = await fetch('https://integrate.api.nvidia.com/v1/models', { headers: { Authorization: 'Bearer ' + KEYS.nvidia }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return (await r.json()).data.map(m => m.id);
  },
};

// Which unregistered ids look like chat models worth a look.
const WORTHY = {
  gemini:  id => /^gemini-[\d.]+-(flash|pro)(-lite)?(-preview)?(-\d+)?$/.test(id) || /^gemini-(flash|pro)(-lite)?-latest$/.test(id),
  groq:    id => !/whisper|orpheus|guard|safeguard|tts|allam/.test(id),
  mistral: id => /^(mistral|ministral|magistral|codestral|devstral)-.*latest$/.test(id),
  nvidia:  id => /(nemotron-3|minimax-m3|gpt-oss|kimi|deepseek-v4|glm-5|qwen3\.[5-9]|mistral-large|gemma-4)/i.test(id) && !/embed|rerank|guard|reward|vl|parse|safety|translate/i.test(id),
};

export async function auditModels() {
  const report = { checkedAt: new Date().toISOString(), providers: {}, retired: [], candidates: {} };
  for (const provider of Object.keys(LISTERS)) {
    if (!KEYS[provider]) { report.providers[provider] = 'no key'; continue; }
    try {
      const ids = new Set(await LISTERS[provider]());
      report.providers[provider] = `${ids.size} models listed`;
      for (const m of MODELS.filter(x => x.provider === provider)) if (!ids.has(m.id)) report.retired.push(m.key);
      const known = new Set(MODELS.map(m => m.id));
      report.candidates[provider] = [...ids].filter(id => !known.has(id) && WORTHY[provider](id)).sort();
    } catch (e) {
      report.providers[provider] = 'could not list: ' + e.message; // leave its models as they were
    }
  }
  // Only models whose provider answered can be called retired.
  setRetired(report.retired);
  try { await setState('model_audit', report); } catch { /* table may not exist yet */ }
  return report;
}

// A fresh process (e.g. a cold serverless start) has not run the audit itself; it learns the
// last result from the database once.
let restored;
export function restoreAudit() {
  restored ||= getState('model_audit').then(r => { if (Array.isArray(r?.retired)) setRetired(r.retired); }).catch(() => {});
  return restored;
}

// A tiny live call for each registered model: does the key really have access right now?
export async function probeModels() {
  const out = [];
  for (const m of MODELS) {
    const t0 = Date.now();
    const key = KEYS[m.provider];
    if (!key) { out.push({ key: m.key, ok: false, note: 'no key' }); continue; }
    try {
      let r;
      if (m.provider === 'gemini') {
        r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m.id}:generateContent?key=${key}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(40000),
          body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Reply with the single word OK' }] }], generationConfig: { maxOutputTokens: 200 } }),
        });
      } else {
        const url = m.provider === 'groq' ? 'https://api.groq.com/openai/v1/chat/completions' : 'https://api.mistral.ai/v1/chat/completions';
        r = await fetch(url, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(40000),
          body: JSON.stringify({ model: m.id, messages: [{ role: 'user', content: 'Reply with the single word OK' }], max_tokens: 200 }),
        });
      }
      out.push({ key: m.key, ok: r.ok, ms: Date.now() - t0, note: r.ok ? 'ok' : `HTTP ${r.status}` });
    } catch (e) {
      out.push({ key: m.key, ok: false, ms: Date.now() - t0, note: e.message.slice(0, 60) });
    }
  }
  return out;
}
