// ai/cascade.js — the free cloud model stack: Gemini 2.5 Flash → Mistral Small →
// Cerebras gpt-oss-120b → Groq gpt-oss-120b.
// Each provider streams tokens; runCascade falls through on failure.

import { KEYS } from '../config.js';
import { BASE_PROMPT, UTILITY_PROMPT } from './prompt.js';

// ── Plumbing ─────────────────────────────────────────────────────────────────
async function post(url, headers, body, signal, label) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal,
  });
  if (!r.ok) throw new Error(`${label} HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r;
}

// Read an SSE response and yield the text each event carries (pick() extracts it).
async function* sse(r, pick) {
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) return;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6).trim();
      if (raw === '[DONE]') return;
      try {
        const token = pick(JSON.parse(raw));
        if (token) yield token;
      } catch { /* ignore keep-alives and partial frames */ }
    }
  }
}

function openAICompat({ label, url, key, model, maxTokens }) {
  return async function* (messages, signal, system) {
    const r = await post(url, { Authorization: 'Bearer ' + key }, {
      model, stream: true, max_tokens: maxTokens,
      messages: [{ role: 'system', content: system }, ...messages],
    }, signal, label);
    yield* sse(r, o => o.choices?.[0]?.delta?.content);
  };
}

// ── Providers ────────────────────────────────────────────────────────────────
// maxChars is the most prompt text (system + messages) we will send that provider.
const PROVIDERS = {
  gemini: {
    name: 'gemini-2.5-flash',
    maxChars: 300000,
    available: () => !!KEYS.gemini,
    stream: async function* (messages, signal, system) {
      const r = await post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse&key=${KEYS.gemini}`,
        {},
        {
          contents: messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
          systemInstruction: { parts: [{ text: system }] },
          generationConfig: { maxOutputTokens: 8192 },
        },
        signal, 'Gemini');
      yield* sse(r, o => (o.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join(''));
    },
  },
  mistral: {
    name: 'mistral-small',
    maxChars: 90000,
    available: () => !!KEYS.mistral,
    stream: openAICompat({ label: 'Mistral', url: 'https://api.mistral.ai/v1/chat/completions', key: KEYS.mistral, model: 'mistral-small-latest', maxTokens: 8192 }),
  },
  cerebras: {
    name: 'gpt-oss-120b (cerebras)',
    maxChars: 14000, // free tier: 8K-token context shared by prompt and reply
    available: () => !!KEYS.cerebras,
    stream: openAICompat({ label: 'Cerebras', url: 'https://api.cerebras.ai/v1/chat/completions', key: KEYS.cerebras, model: 'gpt-oss-120b', maxTokens: 3000 }),
  },
  groq: {
    name: 'gpt-oss-120b (groq)', // llama-3.3-70b-versatile was retired by Groq
    maxChars: 22000, // free tier: ~12K tokens per minute
    available: () => !!KEYS.groq,
    stream: openAICompat({ label: 'Groq', url: 'https://api.groq.com/openai/v1/chat/completions', key: KEYS.groq, model: 'openai/gpt-oss-120b', maxTokens: 4096 }),
  },
};

// A provider that just failed is skipped for a while instead of being retried on every message:
// a minute after a rate limit, six hours after "payment required" / "model not found" / bad key.
const downUntil = {};
const downWhy = {};
const usable = key => PROVIDERS[key].available() && Date.now() >= (downUntil[key] || 0);

function pickKeys(order) {
  const ok = order.filter(usable);
  return ok.length ? ok : order.filter(k => PROVIDERS[k].available()); // all resting: try them anyway
}

function markDown(key, err) {
  const status = Number((/HTTP (\d{3})/.exec(err.message) || [])[1]);
  downUntil[key] = Date.now() + ([401, 402, 403, 404].includes(status) ? 6 * 3600e3 : status === 429 ? 60e3 : 20e3);
  downWhy[key] = status ? `HTTP ${status}${status === 429 ? ' rate limit or quota' : status === 402 ? ' payment required' : status === 404 ? ' model not found' : ''}` : 'error or timeout';
}

// For Mobius's self-report: which models are usable right now.
export const providerStatus = () => ORDER.chat.map(k => {
  const p = PROVIDERS[k];
  if (!p.available()) return `${p.name}: not configured`;
  return Date.now() < (downUntil[k] || 0) ? `${p.name}: resting after a failure (${downWhy[k]})` : `${p.name}: ready`;
});

// Order matters. Answers lead with Gemini. Quick utility calls (routing) lead with
// the fast providers to keep Gemini's daily quota for answers and embeddings.
export const ORDER = {
  chat:  ['gemini', 'mistral', 'cerebras', 'groq'],
  quick: ['cerebras', 'mistral', 'groq', 'gemini'],
  deep:  ['gemini', 'mistral', 'groq', 'cerebras'],
};

export const availableNames = () => ORDER.chat.filter(k => PROVIDERS[k].available()).map(k => PROVIDERS[k].name);

// "Ask: Mistral …" forces one model so Boon can get a second opinion on demand.
export function parseAskPrefix(query) {
  const m = query.match(/^ask:?\s*(gemini|groq|mistral|cerebras)\s*:?\s*/i);
  if (!m) return { forceProvider: null, cleanQuery: query };
  return { forceProvider: m[1].toLowerCase(), cleanQuery: query.slice(m[0].length).trim() };
}

// ── Fitting a prompt to a provider ───────────────────────────────────────────
// Providers reject consecutive same-role turns and a non-user first turn.
function normalise(messages) {
  const out = [];
  for (const m of messages) {
    if (!m.content) continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += '\n\n' + m.content;
    else out.push({ role: m.role, content: m.content });
  }
  while (out.length > 1 && out[0].role !== 'user') out.shift();
  return out;
}

// Drop the oldest turns first; if the final turn alone is still too big, trim its
// middle (the head holds the memory context, the tail holds the user's question).
function fit(messages, system, maxChars) {
  const budget = Math.max(2000, maxChars - system.length);
  const msgs = messages.map(m => ({ ...m }));
  const size = () => msgs.reduce((n, m) => n + m.content.length, 0);
  while (msgs.length > 1 && size() > budget) msgs.shift();
  while (msgs.length > 1 && msgs[0].role !== 'user') msgs.shift();
  if (size() > budget) {
    const last = msgs[msgs.length - 1];
    const tail = Math.min(2500, Math.floor(budget * 0.3));
    const head = budget - tail - 40;
    last.content = last.content.slice(0, head) + '\n[…trimmed to fit this model…]\n' + last.content.slice(-tail);
  }
  return msgs;
}

// ── Streaming a chat answer ──────────────────────────────────────────────────
// Yields token strings and { event } objects (model:, fallback:, error:).
export async function* runCascade(messages, { signal, system = BASE_PROMPT, only = null } = {}) {
  if (only && !PROVIDERS[only]) { yield { event: 'error:unknown-model:' + only }; return; }
  for (const key of only ? [only] : pickKeys(ORDER.chat)) {
    const p = PROVIDERS[key];
    if (!p.available()) {
      if (only) yield { event: 'error:not-configured:' + p.name };
      continue;
    }
    let started = false;
    try {
      yield { event: 'model:' + p.name };
      for await (const token of p.stream(fit(normalise(messages), system, p.maxChars), signal, system)) {
        started = true;
        yield token;
      }
      return;
    } catch (e) {
      if (signal?.aborted) return;
      if (started) throw e; // half an answer already went out; don't graft a second model onto it
      markDown(key, e);
      console.warn(`[cascade] ${p.name} failed: ${e.message} — trying next`);
      yield { event: 'fallback:' + p.name + ':' + e.message.slice(0, 80) };
      if (only) return;
    }
  }
  throw new Error('All cascade providers failed');
}

// ── One-shot call (routing, summarising) ─────────────────────────────────────
// Each provider gets its own timeout; the first non-empty answer wins.
export async function askModel(prompt, { order = ORDER.quick, timeoutMs = 25000, system = UTILITY_PROMPT } = {}) {
  let lastError;
  for (const key of pickKeys(order)) {
    const p = PROVIDERS[key];
    if (!p.available()) continue;
    try {
      let out = '';
      for await (const token of p.stream(fit(normalise([{ role: 'user', content: prompt }]), system, p.maxChars), AbortSignal.timeout(timeoutMs), system)) out += token;
      if (out.trim()) return out.trim();
    } catch (e) {
      markDown(key, e);
      lastError = e;
    }
  }
  throw lastError || new Error('No AI provider is configured');
}
