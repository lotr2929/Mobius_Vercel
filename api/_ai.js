async function askGroq(messages) {
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + process.env.GROQ_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages })
  });
  const data = await r.json();
  const content = data.choices?.[0]?.message?.content || data.choices?.[0]?.message?.reasoning_content;
  if (!content) throw new Error(JSON.stringify(data));
  if (content.includes('"error"')) {
    try {
      const parsed = JSON.parse(content);
      if (parsed.error) throw new Error(parsed.error.message || JSON.stringify(parsed.error));
    } catch {}
  }
  return content;
}

// ── Gemini model resolution ───────────────────────────────────────────────────
let _geminiModelCache = null;

async function resolveGeminiModel(key) {
  if (_geminiModelCache) return _geminiModelCache;
  try {
    const r = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models?key=' + key,
      { signal: AbortSignal.timeout(5000) }
    );
    const data = await r.json();
    const models = (data.models || [])
      .filter(m =>
        (m.supportedGenerationMethods || []).includes('generateContent') &&
        !m.name.includes('image') && !m.name.includes('tts') && !m.name.includes('live') &&
        !m.name.includes('embed') && !m.name.includes('robotics') &&
        !m.name.includes('computer-use') && !m.name.includes('research')
      )
      .map(m => m.name.replace('models/', ''));
    const pick =
      models.find(m => m === 'gemini-2.5-flash') ||
      models.find(m => m === 'gemini-2.5-pro') ||
      models.find(m => m.includes('flash') && !m.includes('preview') && !m.includes('lite')) ||
      models.find(m => m.includes('flash')) ||
      models.find(m => m.includes('pro') && !m.includes('preview')) ||
      models[0] || 'gemini-2.5-flash';
    console.log('[Mobius] Gemini model resolved:', pick, '(from', models.length, 'available)');
    _geminiModelCache = pick;
    return pick;
  } catch (err) {
    console.warn('[Mobius] Gemini model resolution failed, using fallback:', err.message);
    _geminiModelCache = 'gemini-2.5-flash';
    return _geminiModelCache;
  }
}

async function askGemini(messages, imageParts = []) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is not set on the server.');
  const model = await resolveGeminiModel(key);
  const contents = messages.map((m, i) => {
    const isLastUser = i === messages.length - 1 && m.role === 'user';
    const parts = [];
    if (isLastUser && imageParts.length > 0) parts.push(...imageParts);
    parts.push({ text: m.content });
    return { role: m.role === 'assistant' ? 'model' : 'user', parts };
  });
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + key;
  const r = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents })
  });
  const data = await r.json();
  if (data.error) {
    const msg = data.error.message || '';
    const retryMatch = msg.match(/retry(?:\s+in)?[:\s]+([\d.]+)\s*s/i);
    if (retryMatch) throw new Error('Gemini quota exceeded — retry in ' + Math.ceil(parseFloat(retryMatch[1])) + 's');
    throw new Error('Gemini error: ' + msg);
  }
  if (!data.candidates?.[0]) throw new Error('No candidates in Gemini response: ' + JSON.stringify(data));
  const text = data.candidates[0].content.parts[0].text;
  const usage = data.usageMetadata || {};
  return { text, tokensIn: usage.promptTokenCount || 0, tokensOut: usage.candidatesTokenCount || 0, modelUsed: model };
}

async function askGeminiLite(messages) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is not set on the server.');
  let model = 'gemini-2.5-flash-lite';
  try {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?key=' + key, { signal: AbortSignal.timeout(3000) });
    const data = await r.json();
    model = (data.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent') && m.name.includes('flash-lite'))
      .map(m => m.name.replace('models/', ''))
      .find(m => !m.includes('preview') && !m.includes('tts') && !m.includes('image')) || 'gemini-2.5-flash-lite';
  } catch { /* use fallback */ }
  const contents = messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
  const r = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + key,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents }) }
  );
  const data = await r.json();
  if (data.error) {
    const msg = data.error.message || '';
    const retryMatch = msg.match(/retry(?:\s+in)?[:\s]+([\d.]+)\s*s/i);
    if (retryMatch) throw new Error('Gemini Flash-Lite quota exceeded — retry in ' + Math.ceil(parseFloat(retryMatch[1])) + 's');
    throw new Error('Gemini Flash-Lite error: ' + msg);
  }
  if (!data.candidates?.[0]) throw new Error('No candidates from Gemini Flash-Lite');
  const text = data.candidates[0].content.parts[0].text;
  const usage = data.usageMetadata || {};
  return { text, tokensIn: usage.promptTokenCount || 0, tokensOut: usage.candidatesTokenCount || 0, modelUsed: 'Gemini: Flash-Lite' };
}

async function askMistral(messages) {
  const key = process.env.MISTRAL_API_KEY;
  if (!key) throw new Error('MISTRAL_API_KEY is not set on the server.');
  const r = await fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'codestral-latest', messages })
  });
  const data = await r.json();
  if (!r.ok || data.error || data.message)
    throw new Error('Mistral error: ' + (data.error?.message || data.message || 'HTTP ' + r.status));
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('Mistral returned no content: ' + JSON.stringify(data));
  return content;
}

async function askGitHub(messages) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is not set on the server.');
  const r = await fetch('https://models.inference.ai.azure.com/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o', messages })
  });
  const data = await r.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error(JSON.stringify(data));
  return content;
}

const MODEL_CHAIN        = ['gemini-lite', 'groq', 'mistral', 'github'];
const CODING_MODEL_CHAIN = ['gemini', 'gemini-lite', 'groq', 'mistral', 'github'];

const MODEL_FULL_NAMES = {
  groq:          'Groq Llama 3.3 70B',
  'gemini-lite': 'Gemini 2.5 Flash-Lite',
  gemini:        'Gemini 2.5 Flash',
  codestral:     'Mistral Codestral',
  mistral:       'Mistral Codestral',
  github:        'GitHub GPT-4o',
  ollama:        'Ollama (local)',
  qwen:          'Ollama Qwen 2.5 Coder',
  deepseek:      'Ollama DeepSeek R1 7B'
};

async function askWithFallback(messages, imageParts = [], startModel = 'gemini-lite', coding = false) {
  const chain = coding ? CODING_MODEL_CHAIN : MODEL_CHAIN;
  const startIdx = chain.indexOf(startModel);
  const runChain = startIdx !== -1 ? chain.slice(startIdx) : chain;
  const failedModels = [];
  let lastErr = null;
  for (const model of runChain) {
    try {
      let result;
      if (model === 'groq')             result = await askGroq(messages);
      else if (model === 'gemini-lite') result = await askGeminiLite(messages);
      else if (model === 'gemini')      result = await askGemini(messages, imageParts);
      else if (model === 'codestral' || model === 'mistral') result = await askMistral(messages);
      else if (model === 'github')      result = await askGitHub(messages);
      const fullName  = MODEL_FULL_NAMES[model] || model;
      const startName = MODEL_FULL_NAMES[startModel] || startModel;
      const label     = model === startModel ? fullName : fullName + ' (fallback from ' + startName + ')';
      if (result && typeof result === 'object' && result.text !== undefined) {
        return { reply: result.text, modelUsed: label, tokensIn: result.tokensIn, tokensOut: result.tokensOut, failedModels };
      }
      return { reply: result, modelUsed: label, failedModels };
    } catch (err) {
      console.warn('[Mobius] ' + model + ' failed:', err.message);
      failedModels.push({ model: MODEL_FULL_NAMES[model] || model, reason: err.message });
      lastErr = err;
    }
  }
  throw lastErr || new Error('All models failed');
}

// ── Ollama ────────────────────────────────────────────────────────────────────

let _ollamaModelCache = null;

async function resolveOllamaModel() {
  if (_ollamaModelCache) return _ollamaModelCache;
  try {
    const r = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(3000) });
    const data = await r.json();
    const pulled = (data.models || []).map(m => m.name);
    if (pulled.length === 0) throw new Error('No models installed');
    const pick =
      pulled.find(m => m.includes('qwen') && m.includes('coder')) ||
      pulled.find(m => m.includes('deepseek')) ||
      pulled.find(m => m.includes('coder')) ||
      pulled[0];
    console.log('[Mobius] Ollama model resolved:', pick, '(from', pulled.length, 'installed)');
    _ollamaModelCache = pick;
    return pick;
  } catch (err) {
    console.warn('[Mobius] Ollama model resolution failed:', err.message);
    _ollamaModelCache = 'qwen2.5-coder:7b';
    return _ollamaModelCache;
  }
}

async function askOllama(messages, model) {
  const resolvedModel = model || await resolveOllamaModel();
  const r = await fetch('http://localhost:11434/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: resolvedModel, messages })
  });
  const data = await r.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error(JSON.stringify(data));
  return content;
}

async function askWebSearch(messages, depth = 1) {
  const tavilyKey = process.env.TAVILY_API_KEY;
  if (!tavilyKey) throw new Error('TAVILY_API_KEY is not set on the server.');
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  const query = lastUserMsg ? lastUserMsg.content : '';
  const searchDepth = depth === 1 ? 'basic' : 'advanced';
  const maxResults  = depth === 1 ? 5 : depth === 2 ? 8 : 12;
  const searchRes = await fetch('https://api.tavily.com/search', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: tavilyKey, query, search_depth: searchDepth, max_results: maxResults,
      include_answer: depth >= 2, include_raw_content: depth >= 3
    })
  });
  const searchData = await searchRes.json();
  if (searchData.error) throw new Error('Tavily: ' + (searchData.error.message || JSON.stringify(searchData.error)));
  if (!Array.isArray(searchData.results) || searchData.results.length === 0)
    throw new Error('Tavily returned no results');
  let context = searchData.results.map((r, i) => {
    const raw = depth >= 3 && r.raw_content ? '\nFull content: ' + r.raw_content.slice(0, 1500) : '';
    return `[${i+1}] ${r.title}\n${r.content}${raw}\nSource: ${r.url}`;
  }).join('\n\n');
  if (depth >= 2 && searchData.answer) context = 'Tavily summary: ' + searchData.answer + '\n\n' + context;
  const augmented = messages.map((m, i) =>
    i === messages.length - 1 && m.role === 'user'
      ? { role: 'user', content: 'Answer using the web search results below.\n\nQuestion: ' + m.content + '\n\nSearch Results:\n' + context }
      : m
  );
  return await askWithFallback(augmented);
}

// ── Cerebras cascade ──────────────────────────────────────────────────────────
// Tries larger model first, falls back within stable before giving up.

async function askCerebras(messages, model = 'llama3.3-70b') {
  const key = process.env.CEREBRAS_API_KEY;
  if (!key) throw new Error('CEREBRAS_API_KEY not configured.');
  const r = await fetch('https://api.cerebras.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, max_tokens: 4096 }),
    signal: AbortSignal.timeout(30000)
  });
  const data = await r.json();
  if (!r.ok) throw new Error('Cerebras error: ' + (data.message || data.error?.message || 'HTTP ' + r.status));
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('Cerebras returned no content');
  return content;
}

async function askCerebrasCascade(messages) {
  const models = await resolveCerebrasCascade();
  let lastErr;
  for (const m of models) {
    try {
      const text = await askCerebras(messages, m.id);
      return { text, modelUsed: m.label };
    } catch (e) { lastErr = e; console.warn('[Cerebras cascade] ' + m.id + ' failed:', e.message); }
  }
  throw lastErr || new Error('All Cerebras models failed');
}

// ── DeepSeek cloud ────────────────────────────────────────────────────────────

async function askDeepSeekCloud(messages, model = 'deepseek-chat') {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error('DEEPSEEK_API_KEY not configured.');
  const r = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages }), signal: AbortSignal.timeout(60000)
  });
  const data = await r.json();
  if (!r.ok) throw new Error('DeepSeek error: ' + (data.error?.message || 'HTTP ' + r.status));
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('DeepSeek returned no content');
  return content;
}

// ── OpenRouter cascade ────────────────────────────────────────────────────────
// Tries multiple free models within OpenRouter before giving up.

async function askOpenRouter(messages, model = 'meta-llama/llama-3.3-70b-instruct:free') {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY not configured.');
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json',
      'HTTP-Referer': 'https://mobius-pwa.vercel.app', 'X-Title': 'Mobius'
    },
    body: JSON.stringify({ model, messages }), signal: AbortSignal.timeout(60000)
  });
  const data = await r.json();
  if (!r.ok) throw new Error('OpenRouter error: ' + (data.error?.message || 'HTTP ' + r.status));
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('OpenRouter returned no content');
  // Capture the actual model OpenRouter selected (critical for openrouter/free auto-routing)
  const actualModel = data.model || model;
  return { content, modelUsed: actualModel };
}

async function askOpenRouterCascade(messages) {
  // OpenRouter free-tier SKUs churn frequently -- hardcoded lists go stale in weeks.
  // openrouter/free is a smart router that auto-selects from currently-working free models.
  // Fallback pins a still-available free model in case the router itself errors.
  const models = [
    { id: 'openrouter/free',                        label: 'OpenRouter: Free Router'  },
    { id: 'meta-llama/llama-3.3-70b-instruct:free', label: 'OpenRouter: Llama 3.3 70B' },
  ];
  let lastErr;
  for (const m of models) {
    try {
      const result = await askOpenRouter(messages, m.id);
      // openrouter/free will return the actually-selected model in modelUsed
      const shortName = result.modelUsed.split('/').pop().replace(':free', '') || m.label;
      const modelUsed = result.modelUsed !== m.id
        ? 'OpenRouter: ' + shortName
        : m.label;
      return { text: result.content, modelUsed };
    } catch (e) { lastErr = e; console.warn('[OpenRouter cascade] ' + m.id + ' failed:', e.message); }
  }
  throw lastErr || new Error('All OpenRouter models failed');
}

// ── Gemini helpers: retry-delay parsing + 429 backoff ────────────────────────
// Gemini returns 429 with a structured retryDelay field in error.details (e.g. "58s")
// plus the same info in error.message. Parse either. Backoff is capped so we don't
// exceed Vercel's 10s function timeout -- if the required wait is longer, fail fast
// with a clear error so the user knows to retry in N seconds.

const GEMINI_BACKOFF_MAX_MS = 2000;

function parseGeminiRetryDelay(data) {
  const details = data?.error?.details || [];
  for (const d of details) {
    if ((d['@type'] || '').includes('RetryInfo') && d.retryDelay) {
      const m = String(d.retryDelay).match(/^(\d+\.?\d*)s?$/);
      if (m) return parseFloat(m[1]);
    }
  }
  const msg = data?.error?.message || '';
  const m = msg.match(/retry in (\d+\.?\d*)\s*s/i);
  return m ? parseFloat(m[1]) : null;
}

async function geminiPost(url, body, fetchTimeoutMs = 12000) {
  const opts = {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
    signal:  AbortSignal.timeout(fetchTimeoutMs)
  };
  let r = await fetch(url, opts);
  let data = await r.json();

  // 429 with a parseable retry delay: backoff once if within our budget
  if ((r.status === 429 || data?.error?.code === 429)) {
    const retrySec = parseGeminiRetryDelay(data);
    if (retrySec && retrySec * 1000 <= GEMINI_BACKOFF_MAX_MS) {
      const waitMs = Math.ceil(retrySec * 1000) + 300;
      console.log('[Mobius] Gemini 429 -- backing off ' + waitMs + 'ms then retrying...');
      await new Promise(res => setTimeout(res, waitMs));
      r = await fetch(url, opts);
      data = await r.json();
    } else if (retrySec) {
      console.log('[Mobius] Gemini 429 -- retry delay ' + retrySec + 's exceeds backoff budget; failing fast');
    }
  }
  return data;
}

// ── Model catalogue resolvers ────────────────────────────────────────────────
// Each provider's /models endpoint is fetched once per serverless cold start
// (~5 min warm TTL on Vercel). We pick by capability PATTERN, not hardcoded version,
// so new model releases are picked up automatically without code changes.
//
// Hardcoded fallback lists are last-resort only -- used only if /models is unreachable.
// The fallbacks themselves use pattern-stable IDs ("-latest" aliases where available).

let _groqCache          = null;
let _mistralCache       = null;
let _cerebrasCache      = null;
let _geminiCascadeCache = null;
let _groundingCache     = null;

async function resolveGroqCascade() {
  if (_groqCache) return _groqCache;
  const fallback = [
    { id: 'llama-3.3-70b-versatile', label: 'Groq: Llama 3.3 70B' },
    { id: 'llama-3.1-8b-instant',    label: 'Groq: Llama 3.1 8B'  },
  ];
  try {
    const r = await fetch('https://api.groq.com/openai/v1/models', {
      headers: { 'Authorization': 'Bearer ' + process.env.GROQ_API_KEY },
      signal:  AbortSignal.timeout(5000)
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    const ids  = (data.data || []).map(m => m.id).filter(Boolean);

    // Sort descending so newest llama-3.3 > llama-3.1 etc.
    const versatile = ids.filter(id => /llama.*versatile$/i.test(id)).sort().reverse();
    const reasoning = ids.filter(id => /(qwq|deepseek|kimi)/i.test(id) && !/(guard|whisper|tts)/i.test(id)).sort().reverse();
    const instant   = ids.filter(id => /llama.*instant$/i.test(id)).sort().reverse();

    const picks = [];
    if (versatile[0]) picks.push({ id: versatile[0], label: 'Groq: ' + versatile[0] });
    if (reasoning[0]) picks.push({ id: reasoning[0], label: 'Groq: ' + reasoning[0] });
    if (instant[0])   picks.push({ id: instant[0],   label: 'Groq: ' + instant[0]   });
    if (!picks.length) throw new Error('no usable Groq models matched');

    console.log('[Mobius] Groq cascade resolved:', picks.map(p => p.id).join(', '));
    _groqCache = picks;
    return picks;
  } catch (err) {
    console.warn('[Mobius] Groq /models fetch failed, using fallback:', err.message);
    _groqCache = fallback;
    return fallback;
  }
}

async function resolveMistralCascade() {
  if (_mistralCache) return _mistralCache;
  // Use Mistral's "-latest" aliases (they always point at the newest stable).
  // Order matters: Mobius queries are general research, so prefer the general
  // model over the coding specialist. Codestral is kept as a fallback for the
  // rare case Mistral Small is down -- even a code model is better than no
  // answer at all.
  const preferred = [
    { id: 'mistral-small-latest', label: 'Mistral: Small'     },
    { id: 'open-mistral-nemo',    label: 'Mistral: Nemo'      },
    { id: 'codestral-latest',     label: 'Mistral: Codestral' },
  ];
  try {
    const r = await fetch('https://api.mistral.ai/v1/models', {
      headers: { 'Authorization': 'Bearer ' + process.env.MISTRAL_API_KEY },
      signal:  AbortSignal.timeout(5000)
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    const available = new Set((data.data || []).map(m => m.id));
    const picks = preferred.filter(p => available.has(p.id));
    if (!picks.length) throw new Error('none of preferred Mistral aliases available');
    console.log('[Mobius] Mistral cascade resolved:', picks.map(p => p.id).join(', '));
    _mistralCache = picks;
    return picks;
  } catch (err) {
    console.warn('[Mobius] Mistral /models fetch failed, using fallback:', err.message);
    _mistralCache = preferred;
    return preferred;
  }
}

async function resolveCerebrasCascade() {
  if (_cerebrasCache) return _cerebrasCache;
  const fallback = [
    { id: 'llama3.3-70b', label: 'Cerebras Llama 3.3 70B' },
    { id: 'llama3.1-8b',  label: 'Cerebras Llama 3.1 8B'  },
  ];
  try {
    const r = await fetch('https://api.cerebras.ai/v1/models', {
      headers: { 'Authorization': 'Bearer ' + process.env.CEREBRAS_API_KEY },
      signal:  AbortSignal.timeout(5000)
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    const ids  = (data.data || []).map(m => m.id).filter(Boolean);

    const big   = ids.filter(id => /llama.*70b/i.test(id)).sort().reverse();
    const small = ids.filter(id => /llama.*8b/i.test(id)).sort().reverse();

    const picks = [];
    if (big[0])   picks.push({ id: big[0],   label: 'Cerebras: ' + big[0]   });
    if (small[0]) picks.push({ id: small[0], label: 'Cerebras: ' + small[0] });
    if (!picks.length) throw new Error('no usable Cerebras models matched');

    console.log('[Mobius] Cerebras cascade resolved:', picks.map(p => p.id).join(', '));
    _cerebrasCache = picks;
    return picks;
  } catch (err) {
    console.warn('[Mobius] Cerebras /models fetch failed, using fallback:', err.message);
    _cerebrasCache = fallback;
    return fallback;
  }
}

async function resolveGeminiCascadeModels() {
  if (_geminiCascadeCache) return _geminiCascadeCache;
  const fallback = ['gemini-2.5-flash', 'gemini-2.5-pro'];
  try {
    const r = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models?key=' + process.env.GEMINI_API_KEY,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    const models = (data.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => m.name.replace('models/', ''))
      .filter(n => !/(image|tts|live|embed|robotics|computer-use|research)/i.test(n));

    // Prefer newest flash (not lite/preview), then newest pro, then newest flash-preview
    const flash        = models.filter(n => n.includes('flash') && !n.includes('lite') && !n.includes('preview')).sort().reverse();
    const pro          = models.filter(n => n.includes('pro') && !n.includes('preview')).sort().reverse();
    const flashPreview = models.filter(n => n.includes('flash') && n.includes('preview') && !n.includes('lite')).sort().reverse();

    const picks = [flash[0], pro[0], flashPreview[0]].filter(Boolean).slice(0, 3);
    if (!picks.length) throw new Error('no usable Gemini cascade models matched');

    console.log('[Mobius] Gemini cascade resolved:', picks.join(', '));
    _geminiCascadeCache = picks;
    return picks;
  } catch (err) {
    console.warn('[Mobius] Gemini /models fetch failed, using fallback:', err.message);
    _geminiCascadeCache = fallback;
    return fallback;
  }
}

async function resolveGroundingModel() {
  if (_groundingCache) return _groundingCache;
  const fallback = 'gemini-3-flash-preview';
  try {
    const r = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models?key=' + process.env.GEMINI_API_KEY,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    const models = (data.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => m.name.replace('models/', ''))
      .filter(n => n.includes('flash') && !/(lite|tts|image|embed|live)/i.test(n));

    // Prefer Gemini 3.x flash (newest with grounding), then 2.5 flash
    const gen3  = models.filter(n => /^gemini-3/.test(n)).sort().reverse();
    const gen25 = models.filter(n => /^gemini-2\.5/.test(n)).sort().reverse();
    const pick  = gen3[0] || gen25[0] || fallback;

    console.log('[Mobius] Grounding model resolved:', pick);
    _groundingCache = pick;
    return pick;
  } catch (err) {
    console.warn('[Mobius] Grounding model resolution failed, using fallback:', err.message);
    _groundingCache = fallback;
    return fallback;
  }
}

// ── Within-stable cascade functions ───────────────────────────────────────────

async function askGroqCascade(messages) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('GROQ_API_KEY not configured.');
  const models = await resolveGroqCascade();
  let lastErr;
  for (const m of models) {
    try {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: m.id, messages }), signal: AbortSignal.timeout(20000)
      });
      const data = await r.json();
      const content = data.choices?.[0]?.message?.content || data.choices?.[0]?.message?.reasoning_content;
      if (!content) { lastErr = new Error('empty response'); continue; }
      return { text: content, modelUsed: m.label };
    } catch (e) { lastErr = e; console.warn('[Groq cascade] ' + m.id + ' failed:', e.message); }
  }
  throw lastErr || new Error('All Groq models failed');
}

async function askGeminiCascade(messages) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not configured.');
  const models = await resolveGeminiCascadeModels();
  let lastErr;
  for (const model of models) {
    try {
      const contents = messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
      const url  = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + key;
      const data = await geminiPost(url, { contents });
      if (data.error) { lastErr = new Error(data.error.message); continue; }
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) { lastErr = new Error('empty response'); continue; }
      return { text, modelUsed: 'Gemini: ' + model.replace('gemini-', '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) };
    } catch (e) { lastErr = e; console.warn('[Gemini cascade] ' + model + ' failed:', e.message); }
  }
  throw lastErr || new Error('All Gemini models failed');
}

async function askMistralCascade(messages) {
  const key = process.env.MISTRAL_API_KEY;
  if (!key) throw new Error('MISTRAL_API_KEY not configured.');
  const models = await resolveMistralCascade();
  let lastErr;
  for (const m of models) {
    try {
      const r = await fetch('https://api.mistral.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: m.id, messages }), signal: AbortSignal.timeout(30000)
      });
      const data = await r.json();
      if (!r.ok || data.error || data.message) { lastErr = new Error(data.error?.message || data.message || 'HTTP ' + r.status); continue; }
      const content = data.choices?.[0]?.message?.content;
      if (!content) { lastErr = new Error('empty response'); continue; }
      return { text: content, modelUsed: m.label };
    } catch (e) { lastErr = e; console.warn('[Mistral cascade] ' + m.id + ' failed:', e.message); }
  }
  throw lastErr || new Error('All Mistral models failed');
}

// ── Tavily search ────────────────────────────────────────────────────────────
// Tavily /search endpoint: AI-optimised web search purpose-built for RAG/agents.
// Free tier: 1,000 credits/month, renews monthly, NO credit card required.
//
// Settings below = 2 credits/request (advanced + raw content). At 1,000 credits/mo
// that's ~500 Mobius queries/month. Justification for each parameter:
//   - search_depth: 'advanced'   => deeper retrieval, better URL ranking (+1 credit)
//   - include_raw_content: true  => full cleaned article text, NOT just ~200 char
//                                   snippets. This is what prevents Task AIs from
//                                   hallucinating in Step 6 -- they need real source
//                                   material to quote from. No extra credit cost.
//   - include_answer: true       => LLM-synthesised summary of top results.
//                                   Free bonus, comparable to Gemini grounding's
//                                   grounded answer.
//
// Docs: https://docs.tavily.com/documentation/api-reference/endpoint/search
// Response: { answer, results: [{ title, url, content, raw_content, score }, ...] }

async function askTavilySearch(query, numResults = 20) {
  const key = process.env.TAVILY_API_KEY;
  if (!key) throw new Error('TAVILY_API_KEY not configured.');

  const r = await fetch('https://api.tavily.com/search', {
    method:  'POST',
    headers: {
      'Authorization': 'Bearer ' + key,
      'Content-Type':  'application/json'
    },
    body: JSON.stringify({
      query,
      max_results:        numResults,
      search_depth:       'advanced',
      include_answer:     true,
      include_raw_content: true
    }),
    signal: AbortSignal.timeout(30000)   // advanced + raw content can take longer
  });

  const data = await r.json();
  if (!r.ok) {
    const msg = data?.detail || data?.error || data?.message || ('HTTP ' + r.status);
    console.warn('[Mobius] Tavily search failed:', msg);
    throw new Error('Tavily: ' + msg);
  }

  const results = Array.isArray(data.results) ? data.results : [];
  const urls = results
    .filter(item => item.url)
    .slice(0, numResults)
    .map(item => ({
      title:       item.title   || item.url,
      url:         item.url,
      description: item.content || '',          // short snippet for list display
      raw_content: item.raw_content || '',      // full cleaned article for Task AI RAG
      score:       item.score   || 0
    }));

  const answer = typeof data.answer === 'string' ? data.answer : '';
  const totalRawKB = Math.round(urls.reduce((a, u) => a + (u.raw_content?.length || 0), 0) / 1024);

  console.log('[Mobius] Tavily advanced: returned ' + urls.length + ' URLs, '
    + (answer ? answer.length + ' char answer' : 'no answer') + ', '
    + totalRawKB + 'KB raw content'
    + ' for "' + query.slice(0, 60) + '"');

  return {
    modelUsed:        'Tavily Search (Advanced)',
    urls,
    answer,                        // LLM-summarised overview across all results
    webChunks:        results,     // full Tavily result objects
    searchQueries:    [query],
    searchEntryPoint: ''
  };
}

// ── Google Search via Gemini grounding ───────────────────────────────────────
// Uses Gemini's built-in Google Search tool -- no CSE needed.
// Free tier: gemini-3-flash-preview (~500 grounded req/day).
// Returns: URLs + the grounded answer text + web chunks (for RAG) + search queries
// + Google-required search-entry-point HTML (TOS display requirement).
//
// Prompt shape MATTERS: asking for "a list of sources" lets the model prose-list from
// memory without invoking Search. Asking for a researched answer forces tool invocation.
//
// NO CASCADE: deliberately does not fall back to gemini-2.5-flash because that model
// shares a rate-limit pool with the Researcher Task AI and Critical Reviewer, which fire
// in parallel during orchestration. Cascading onto 2.5-flash multiplied quota pressure
// and caused the actual failure seen in Vercel logs 24 Apr 2026.

async function askGoogleSearch(query, numResults = 20) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not configured.');

  const prompt =
    'Research this question using up-to-date web sources, then answer it concisely (2-3 paragraphs). ' +
    'Cite the most authoritative sources available.\n\nQuestion: ' + query;

  // Resolver picks the newest grounding-capable Flash model. Backoff wrapper handles
  // transient 429s up to 2s (anything longer fails fast with a clear retry-in-Xs message).
  const model = await resolveGroundingModel();
  const url   = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + key;

  let data;
  try {
    data = await geminiPost(url, {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      tools:    [{ google_search: {} }]
    }, 20000);
  } catch (err) {
    console.warn('[Mobius] Grounding fetch failed (' + model + '):', err.message);
    throw new Error(model + ' fetch: ' + err.message);
  }

  if (data.error) {
    const retrySec = parseGeminiRetryDelay(data);
    const suffix = retrySec ? ' (retry in ' + Math.ceil(retrySec) + 's)' : '';
    console.warn('[Mobius] Grounding API error (' + model + '):', data.error.message + suffix);
    throw new Error(model + ': ' + data.error.message + suffix);
  }

  const cand = data.candidates?.[0];
  const gm   = cand?.groundingMetadata || {};

  // Grounded answer text -- the RAG payload, usable as [Background] for downstream Task AIs
  const answer = (cand?.content?.parts || [])
    .map(p => p.text || '').filter(Boolean).join('\n').trim();

  // URLs + titles from grounding chunks, deduplicated, capped to numResults
  const chunks = gm.groundingChunks || [];
  const seen   = new Set();
  const urls   = [];
  for (const c of chunks) {
    if (!c.web?.uri || seen.has(c.web.uri)) continue;
    seen.add(c.web.uri);
    urls.push({ title: c.web.title || c.web.uri, url: c.web.uri });
    if (urls.length >= numResults) break;
  }

  console.log('[Mobius] Grounding: ' + model + ' returned ' + urls.length + ' URLs, '
    + (answer ? answer.length + ' chars answer' : 'no answer') + ', '
    + (gm.webSearchQueries || []).length + ' search queries');

  return {
    modelUsed:        model,
    urls,
    answer,
    webChunks:        chunks,                                    // full chunks for RAG
    searchQueries:    gm.webSearchQueries || [],                 // what Gemini typed into Google
    searchEntryPoint: gm.searchEntryPoint?.renderedContent || '' // Google TOS display HTML
  };
}

module.exports = {
  askGroq,
  askGeminiLite,
  askGemini,
  askMistral,
  askGitHub,
  askOllama,
  askCerebras,
  askDeepSeekCloud,
  askOpenRouter,
  askGroqCascade,
  askGeminiCascade,
  askMistralCascade,
  askCerebrasCascade,
  askOpenRouterCascade,
  askWithFallback,
  askWebSearch,
  askTavilySearch,
  askGoogleSearch,
  MODEL_FULL_NAMES,
  MODEL_CHAIN,
  CODING_MODEL_CHAIN
};
