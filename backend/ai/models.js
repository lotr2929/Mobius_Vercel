
// ai/models.js — the model registry: every model Mobius can use, in one place.
// To add, remove or re-rank a model, edit this list only; cascade.js, the audit and the
// self-report all read from it.
//
//   key       short handle, used by "Ask: <key>" and in logs
//   name      what the UI shows
//   provider  which API serves it (see PROVIDERS in cascade.js)
//   id        the provider's model id. Prefer "-latest" aliases where offered: they follow new
//             releases on their own.
//   tags      what it is good at, so work can be steered to the best-in-class model later
//             (general, reasoning, code, fast, long-context, multilingual)
//   vision    true if it accepts images (checked 3 Oct 2026: the Gemini models, qwen3.8-27b and ministral-14b; the gpt-oss models are text-only)
//   trains    true if the free tier may use prompts to train the provider's models (Google outside the EU/UK, Mistral's free mode, NVIDIA's
//             trial terms forbid personal data); false for Groq, whose stated policy is not to train on API data (verify before relying on it).
//             A message starting "Private:" is answered only by models with trains === false.
//   weak      a small model: its answer is badged with a warning in the app, because a stronger one was unavailable
//   maxChars  most prompt text we send it (free-tier context / tokens-per-minute limits)
//   rank      position in each role, lower = tried first; omit a role to exclude the model from it
//               chat   answering Boon
//               quick  small utility calls (routing): fast first
//               deep   big summarising jobs: large context first
//               learn  deciding what is worth remembering from a message: sound judgement, quick
//               vision when an image is attached: only models that can see it, in this order
//   ask       extra words that work after "Ask:" to force this model
//
// Free-tier reality (checked 4 Oct 2026): Gemini Pro models, Mistral Small/Medium/Magistral/Large and Cerebras are not
// usable on these free keys. Free-tier limits are counted PER MODEL, so each extra Gemini Flash version is a further
// quota (on 4 Oct the 3.8 and 3.7 allowances were spent while 3.6, 3.5, 3.5-lite and 3-flash-preview still answered).
// Order of the chat role, on purpose: the strongest models first, the small ones (ministral, gpt-oss-20b) only as a
// last resort, because a small model once answered an old question from the memory block instead of Boon's message.
// NVIDIA NIM (build.nvidia.com) needs NVIDIA_API_KEY; without it those models are simply skipped. Its free endpoints are
// "trial use only": no personal or confidential data, by NVIDIA's own terms. Run `npm run models -- --probe` to re-check.

export const MODELS = [
  { key: 'gemini',    name: 'gemini-3.8-flash',          provider: 'gemini',  trains: true, id: 'gemini-3.8-flash', vision: true,
    tags: ['general', 'reasoning', 'long-context'], maxChars: 300000, maxTokens: 8192,
    rank: { chat: 1, quick: 8, deep: 1, learn: 9, vision: 9 }, ask: ['flash'] },

  { key: 'gemini37',  name: 'gemini-3.7-flash',          provider: 'gemini',  trains: true, id: 'gemini-3.7-flash', vision: true,
    tags: ['general', 'reasoning', 'long-context'], maxChars: 300000, maxTokens: 8192,
    rank: { chat: 2, quick: 7, deep: 2, learn: 2, vision: 1 }, ask: ['flash-3.7'] },

  { key: 'gemini36',  name: 'gemini-3.6-flash',          provider: 'gemini',  trains: true, id: 'gemini-3.6-flash', vision: true,
    tags: ['general', 'reasoning', 'long-context'], maxChars: 300000, maxTokens: 8192,
    rank: { chat: 3, deep: 3, learn: 3, vision: 2 }, ask: ['flash-3.6'] },

  { key: 'gemini35',  name: 'gemini-3.5-flash',          provider: 'gemini',  trains: true, id: 'gemini-3.5-flash', vision: true,
    tags: ['general', 'reasoning', 'long-context'], maxChars: 300000, maxTokens: 8192,
    rank: { chat: 4, deep: 4, learn: 5, vision: 3 }, ask: ['flash-3.5'] },

  { key: 'gptoss',    name: 'gpt-oss-120b (groq)',       provider: 'groq',    trains: false, id: 'openai/gpt-oss-120b',
    tags: ['reasoning', 'general', 'code'], maxChars: 22000, maxTokens: 4096,
    rank: { chat: 5, quick: 4, deep: 9, learn: 1 }, ask: ['gpt-oss', 'groq', 'gpt'] },

  { key: 'gemini3p',  name: 'gemini-3-flash-preview',    provider: 'gemini',  trains: true, id: 'gemini-3-flash-preview', vision: true,
    tags: ['general', 'reasoning', 'long-context'], maxChars: 300000, maxTokens: 8192,
    rank: { chat: 6, deep: 5, vision: 5 }, ask: ['flash-3'] },

  { key: 'qwen',      name: 'qwen3.8-27b (groq)',        provider: 'groq',    trains: false, id: 'qwen/qwen3.8-27b', vision: true,
    tags: ['general', 'code', 'multilingual', 'fast'], maxChars: 22000, maxTokens: 4096,
    rank: { chat: 7, quick: 1, deep: 10, learn: 4, vision: 4 }, ask: ['qwen'] },

  // NVIDIA NIM: needs NVIDIA_API_KEY. Reasoning models, so they get a larger output allowance (thinking shares it).
  // Tried live on 4 Oct 2026: nemotron-3-ultra and -super answer in about a second; glm-5.3-flash in about 13 s;
  // deepseek-v4.1-flash in about 36 s (too slow for chat); kimi-k3, glm-5.3 and gemma-4-31b timed out at 60 s;
  // kimi-k2.6, mistral-large and llama-3.1-nemotron-ultra are "not found for account"; MiniMax M3 and gpt-oss-120b are not on the list.
  { key: 'nemotron',  name: 'nemotron-3-ultra (nvidia)', provider: 'nvidia',  trains: true, id: 'nvidia/nemotron-3-ultra-550b-a55b',
    tags: ['general', 'reasoning', 'long-context'], maxChars: 90000, maxTokens: 8192,
    rank: { chat: 8, deep: 13 }, ask: ['nemotron', 'ultra'] },

  { key: 'glm53f',    name: 'glm-5.3-flash (nvidia)',    provider: 'nvidia',  trains: true, id: 'z-ai/glm-5.3-flash',
    tags: ['general', 'reasoning', 'code'], maxChars: 90000, maxTokens: 8192,
    rank: { chat: 12 }, ask: ['glm'] },

  { key: 'lite35',    name: 'gemini-3.5-flash-lite',     provider: 'gemini',  trains: true, id: 'gemini-3.5-flash-lite', vision: true,
    tags: ['fast', 'long-context'], maxChars: 300000, maxTokens: 8192,
    rank: { chat: 10, quick: 2, deep: 7, learn: 6, vision: 6 }, ask: ['flash-lite-3.5'] },

  { key: 'lite',      name: 'gemini-3.1-flash-lite',     provider: 'gemini',  trains: true, id: 'gemini-3.1-flash-lite', vision: true,
    tags: ['fast', 'long-context'], maxChars: 300000, maxTokens: 8192,
    rank: { chat: 11, quick: 3, deep: 6, learn: 7, vision: 7 }, ask: ['flash-lite'] },

  { key: 'nemosuper', name: 'nemotron-3-super (nvidia)', provider: 'nvidia',  trains: true, id: 'nvidia/nemotron-3-super-120b-a12b',
    tags: ['general', 'reasoning'], maxChars: 90000, maxTokens: 8192,
    rank: { chat: 9, deep: 14 }, ask: ['nemotron-super'] },

  { key: 'ministral', name: 'ministral-14b (mistral)',   provider: 'mistral', trains: true, weak: true, id: 'ministral-14b-latest', vision: true,
    tags: ['general', 'fast'], maxChars: 90000, maxTokens: 4096,
    rank: { chat: 14, quick: 6, deep: 8, learn: 8, vision: 8 }, ask: ['mistral'] },

  { key: 'gemini25',  name: 'gemini-2.5-flash',          provider: 'gemini',  trains: true, id: 'gemini-2.5-flash', vision: true,
    tags: ['general', 'long-context'], maxChars: 300000, maxTokens: 8192,
    rank: { chat: 15, deep: 11, learn: 11 }, ask: ['flash-2.5'] },

  { key: 'lite25',    name: 'gemini-2.5-flash-lite',     provider: 'gemini',  trains: true, id: 'gemini-2.5-flash-lite', vision: true,
    tags: ['fast', 'long-context'], maxChars: 300000, maxTokens: 8192,
    rank: { quick: 5 }, ask: ['flash-lite-2.5'] },

  // Gemma 4 runs on the same Google key with a far larger free allowance (about 14,400 requests a day),
  // but is slow, so it is only tried for images, and last. Not used for ordinary chat.
  { key: 'gemma26',   name: 'gemma-4-26b (google)',      provider: 'gemini',  trains: true, id: 'gemma-4-26b-a4b-it', vision: true,
    tags: ['general', 'fast'], maxChars: 120000, maxTokens: 4096,
    rank: { vision: 10 }, ask: ['gemma'] },

  { key: 'gemma31',   name: 'gemma-4-31b (google)',      provider: 'gemini',  trains: true, id: 'gemma-4-31b-it', vision: true,
    tags: ['general'], maxChars: 120000, maxTokens: 4096,
    rank: { vision: 11 }, ask: ['gemma-31b'] },

  { key: 'gptoss20',  name: 'gpt-oss-20b (groq)',        provider: 'groq',    trains: false, weak: true, id: 'openai/gpt-oss-20b',
    tags: ['fast', 'reasoning'], maxChars: 22000, maxTokens: 4096,
    rank: { chat: 16, quick: 9, deep: 12, learn: 10 }, ask: ['gpt-oss-20b'] },

  { key: 'codestral', name: 'codestral (mistral)',       provider: 'mistral', trains: true, weak: true, id: 'codestral-latest',
    tags: ['code'], maxChars: 90000, maxTokens: 4096,
    rank: { chat: 17 }, ask: [] },
];

export const modelByKey = key => MODELS.find(m => m.key === key);

// Models for a role, best first. If `tag` is given, models carrying it come first (e.g. 'code').
export function orderFor(role, tag = null) {
  const inRole = MODELS.filter(m => m.rank?.[role] != null).sort((a, b) => a.rank[role] - b.rank[role]);
  if (!tag) return inRole.map(m => m.key);
  return [...inRole.filter(m => m.tags.includes(tag)), ...inRole.filter(m => !m.tags.includes(tag))].map(m => m.key);
}

// "Ask: Qwen ..." / "ask gemini:" at the start of a message forces one model.
const ASK_WORDS = MODELS.flatMap(m => [[m.key, m.key], ...m.ask.map(a => [a, m.key])]).sort((a, b) => b[0].length - a[0].length);
const ASK_RE = new RegExp('^ask:?\\s*(' + ASK_WORDS.map(([w]) => w.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')).join('|') + ')(?![\\w.-])\\s*:?\\s*', 'i');

export function parseAskPrefix(query) {
  const m = query.match(ASK_RE);
  if (!m) return { forceProvider: null, cleanQuery: query };
  const word = m[1].toLowerCase();
  return { forceProvider: ASK_WORDS.find(([w]) => w === word)[1], cleanQuery: query.slice(m[0].length).trim() };
}

export const askKeywords = () => MODELS.map(m => m.ask[0] || m.key);
