// ai/cascade.js — runs the free cloud models listed in models.js.
// Each model streams tokens; runCascade falls through to the next on failure, and a model that
// has just failed is skipped for a while instead of being retried on every message.

import { KEYS } from '../config.js';
import { BASE_PROMPT, UTILITY_PROMPT } from './prompt.js';
import { MODELS, modelByKey, orderFor } from './models.js';

export { parseAskPrefix } from './models.js';

// ── Transport ────────────────────────────────────────────────────────────────
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

const openAICompat = (label, url) => async function* (model, messages, signal, system) {
  const r = await post(url, { Authorization: 'Bearer ' + keyFor(model) }, {
    model: model.id, stream: true, max_tokens: model.maxTokens,
    messages: [{ role: 'system', content: system }, ...messages],
  }, signal, label);
  yield* sse(r, o => o.choices?.[0]?.delta?.content);
};

async function* streamGemini(model, messages, signal, system, images = []) {
  const contents = messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  // Images belong to the latest user turn.
  if (images.length && contents.length) {
    contents[contents.length - 1].parts.push(...images.map(i => ({ inlineData: { mimeType: i.mimeType, data: i.base64 } })));
  }
  const r = await post(
    `https://generativelanguage.googleapis.com/v1beta/models/${model.id}:streamGenerateContent?alt=sse&key=${KEYS.gemini}`,
    {},
    {
      contents,
      systemInstruction: { parts: [{ text: system }] },
      generationConfig: { maxOutputTokens: model.maxTokens },
    },
    signal, 'Gemini');
  yield* sse(r, o => (o.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join(''));
}

const PROVIDERS = {
  gemini:  { stream: streamGemini },
  groq:    { stream: openAICompat('Groq',    'https://api.groq.com/openai/v1/chat/completions') },
  mistral: { stream: openAICompat('Mistral', 'https://api.mistral.ai/v1/chat/completions') },
};
const keyFor = model => KEYS[model.provider] || '';

// ── What is usable right now ─────────────────────────────────────────────────
// Three reasons a model is skipped: no key for its provider, the audit found it retired,
// or it failed recently (resting).
const retired = new Set();    // keys the audit could not find at the provider
const downUntil = {};
const downWhy = {};

const configured = m => !!keyFor(m) && !retired.has(m.key);
const usable = key => { const m = modelByKey(key); return !!m && configured(m) && Date.now() >= (downUntil[key] || 0); };

function pickKeys(order) {
  const ok = order.filter(usable);
  return ok.length ? ok : order.filter(k => configured(modelByKey(k))); // all resting: try them anyway
}

// A minute after a rate limit, six hours after "payment required", "not found" or a bad key.
function markDown(key, err) {
  const status = Number((/HTTP (\d{3})/.exec(err.message) || [])[1]);
  downUntil[key] = Date.now() + ([401, 402, 403, 404].includes(status) ? 6 * 3600e3 : status === 429 ? 60e3 : 20e3);
  downWhy[key] = status ? `HTTP ${status}${status === 429 ? ' rate limit or quota' : status === 402 ? ' payment required' : status === 404 ? ' model not found' : ''}` : 'error or timeout';
}

export function setRetired(keys) { retired.clear(); keys.forEach(k => retired.add(k)); }

export const availableNames = () => orderFor('chat').filter(k => configured(modelByKey(k))).map(k => modelByKey(k).name);

// For the self-report and /api/models: one entry per model.
export const modelStatus = () => MODELS.map(m => ({
  key: m.key, name: m.name, id: m.id, provider: m.provider, tags: m.tags,
  state: !keyFor(m) ? 'no key' : retired.has(m.key) ? 'retired (not listed by the provider)'
       : Date.now() < (downUntil[m.key] || 0) ? `resting after a failure (${downWhy[m.key]})` : 'ready',
}));

// ── Fitting a prompt to a model ──────────────────────────────────────────────
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
// `only` forces one model; `task` (a tag such as 'code') tries models strong at it first.
// `images` ([{ mimeType, base64 }]) go to the Gemini models only, which are the ones here that can see.
export async function* runCascade(messages, { signal, system = BASE_PROMPT, only = null, task = null, images = [] } = {}) {
  if (only && !modelByKey(only)) { yield { event: 'error:unknown-model:' + only }; return; }
  const seeing = images.length > 0;
  if (seeing && only && modelByKey(only).provider !== 'gemini') { yield { event: 'error:cannot-see-images:' + modelByKey(only).name }; return; }
  const order = only ? [only] : pickKeys(orderFor('chat', task)).filter(k => !seeing || modelByKey(k).provider === 'gemini');
  for (const key of order) {
    const m = modelByKey(key);
    if (!keyFor(m)) {
      if (only) yield { event: 'error:not-configured:' + m.name };
      continue;
    }
    let started = false;
    try {
      yield { event: 'model:' + m.name };
      for await (const token of PROVIDERS[m.provider].stream(m, fit(normalise(messages), system, m.maxChars), signal, system, seeing ? images : [])) {
        started = true;
        yield token;
      }
      return;
    } catch (e) {
      if (signal?.aborted) return;
      if (started) throw e; // half an answer already went out; don't graft a second model onto it
      markDown(key, e);
      console.warn(`[cascade] ${m.name} failed: ${e.message} — trying next`);
      yield { event: 'fallback:' + m.name + ':' + e.message.slice(0, 80) };
      if (only) return;
    }
  }
  throw new Error('All models failed');
}

// ── One-shot call (routing, summarising) ─────────────────────────────────────
// Each model gets its own timeout; the first non-empty answer wins. role: 'quick' | 'deep'.
export async function askModel(prompt, { role = 'quick', timeoutMs = 25000, system = UTILITY_PROMPT } = {}) {
  let lastError;
  for (const key of pickKeys(orderFor(role))) {
    const m = modelByKey(key);
    if (!keyFor(m)) continue;
    try {
      let out = '';
      for await (const token of PROVIDERS[m.provider].stream(m, fit(normalise([{ role: 'user', content: prompt }]), system, m.maxChars), AbortSignal.timeout(timeoutMs), system)) out += token;
      if (out.trim()) return out.trim();
    } catch (e) {
      markDown(key, e);
      lastError = e;
    }
  }
  throw lastError || new Error('No AI model is configured');
}
