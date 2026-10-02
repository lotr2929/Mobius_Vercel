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
//   maxChars  most prompt text we send it (free-tier context / tokens-per-minute limits)
//   rank      position in each role, lower = tried first; omit a role to exclude the model from it
//               chat   answering Boon
//               quick  small utility calls (routing): fast first
//               deep   big summarising jobs: large context first
//               learn  deciding what is worth remembering from a message: sound judgement, quick
//   ask       extra words that work after "Ask:" to force this model
//
// Free-tier reality (checked 2 Oct 2026): Gemini Pro models, Mistral Small/Medium/Magistral and
// Cerebras are not available on these free keys. Free-tier limits are per model, so two Gemini
// Flash versions give twice the quota of one. Run `npm run models -- --probe` to re-check.

export const MODELS = [
  { key: 'gemini',    name: 'gemini-3.8-flash',          provider: 'gemini',  id: 'gemini-3.8-flash',
    tags: ['general', 'reasoning', 'long-context'], maxChars: 300000, maxTokens: 8192,
    rank: { chat: 1, quick: 6, deep: 1, learn: 6 }, ask: ['flash'] },

  { key: 'gptoss',    name: 'gpt-oss-120b (groq)',       provider: 'groq',    id: 'openai/gpt-oss-120b',
    tags: ['reasoning', 'general', 'code'], maxChars: 22000, maxTokens: 4096,
    rank: { chat: 2, quick: 3, deep: 5, learn: 1 }, ask: ['gpt-oss', 'groq', 'gpt'] },

  { key: 'gemini37',  name: 'gemini-3.7-flash',          provider: 'gemini',  id: 'gemini-3.7-flash',
    tags: ['general', 'reasoning', 'long-context'], maxChars: 300000, maxTokens: 8192,
    rank: { chat: 3, quick: 5, deep: 2, learn: 2 }, ask: ['flash-3.7'] },

  { key: 'qwen',      name: 'qwen3.8-27b (groq)',        provider: 'groq',    id: 'qwen/qwen3.8-27b',
    tags: ['general', 'code', 'multilingual', 'fast'], maxChars: 22000, maxTokens: 4096,
    rank: { chat: 4, quick: 1, deep: 6, learn: 3 }, ask: ['qwen'] },

  { key: 'ministral', name: 'ministral-14b (mistral)',   provider: 'mistral', id: 'ministral-14b-latest',
    tags: ['general', 'fast'], maxChars: 90000, maxTokens: 4096,
    rank: { chat: 5, quick: 4, deep: 4, learn: 5 }, ask: ['mistral'] },

  { key: 'lite',      name: 'gemini-3.1-flash-lite',     provider: 'gemini',  id: 'gemini-3.1-flash-lite',
    tags: ['fast', 'long-context'], maxChars: 300000, maxTokens: 8192,
    rank: { chat: 6, quick: 2, deep: 3, learn: 4 }, ask: ['flash-lite'] },

  { key: 'gptoss20',  name: 'gpt-oss-20b (groq)',        provider: 'groq',    id: 'openai/gpt-oss-20b',
    tags: ['fast', 'reasoning'], maxChars: 22000, maxTokens: 4096,
    rank: { chat: 7, quick: 7, deep: 7, learn: 7 }, ask: ['gpt-oss-20b'] },

  { key: 'codestral', name: 'codestral (mistral)',       provider: 'mistral', id: 'codestral-latest',
    tags: ['code'], maxChars: 90000, maxTokens: 4096,
    rank: { chat: 8 }, ask: [] },
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
