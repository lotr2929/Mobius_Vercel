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
  const models = [
    { id: 'llama3.3-70b', label: 'Cerebras Llama 3.3 70B' },
    { id: 'llama3.1-8b',  label: 'Cerebras Llama 3.1 8B'  },
  ];
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
  const models = [
    { id: 'meta-llama/llama-3.3-70b-instruct:free', label: 'OpenRouter: Llama 3.3 70B' },
    { id: 'qwen/qwen-2.5-72b-instruct:free',        label: 'OpenRouter: Qwen 2.5 72B'  },
    { id: 'mistralai/mistral-7b-instruct:free',     label: 'OpenRouter: Mistral 7B'    },
    { id: 'google/gemini-2.0-flash-exp:free',       label: 'OpenRouter: Gemini 2.0'    },
  ];
  let lastErr;
  for (const m of models) {
    try {
      const result = await askOpenRouter(messages, m.id);
      // Show actual model selected by OpenRouter (especially useful for openrouter/free)
      const shortName = result.modelUsed.split('/').pop().replace(':free', '') || m.label;
      const modelUsed = result.modelUsed !== m.id
        ? 'OpenRouter: ' + shortName
        : m.label;
      return { text: result.content, modelUsed };
    } catch (e) { lastErr = e; console.warn('[OpenRouter cascade] ' + m.id + ' failed:', e.message); }
  }
  throw lastErr || new Error('All OpenRouter models failed');
}

// ── Within-stable cascade functions ───────────────────────────────────────────

async function askGroqCascade(messages) {
  const models = [
    { id: 'llama-3.3-70b-versatile', label: 'Groq: Llama 3.3 70B' },
    { id: 'qwen-qwq-32b',            label: 'Groq: Qwen QwQ 32B'  },
    { id: 'llama-3.1-8b-instant',    label: 'Groq: Llama 3.1 8B'  },
  ];
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('GROQ_API_KEY not configured.');
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
  const models = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];
  let lastErr;
  for (const model of models) {
    try {
      const contents = messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
      const r = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + key,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents }) }
      );
      const data = await r.json();
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
  const models = [
    { id: 'codestral-latest',     label: 'Mistral: Codestral'  },
    { id: 'mistral-small-latest', label: 'Mistral: Small'       },
    { id: 'open-mistral-nemo',    label: 'Mistral: Nemo'        },
  ];
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

// ── Google Custom Search ──────────────────────────────────────────────────────
// Requires GOOGLE_API_KEY and GOOGLE_CSE_ID env vars.
// Returns array of { title, url, snippet } objects.

// ── Google Search via Gemini grounding ───────────────────────────────────────
// Uses Gemini's built-in Google Search tool -- no CSE or separate API key needed.
// Returns array of { title, url, snippet } from grounding metadata.

async function askGoogleSearch(query, numResults = 10) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not configured.');

  const model = 'gemini-2.0-flash';
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + key;

  const body = {
    contents: [{ role: 'user', parts: [{ text: 'Find the best sources for: ' + query + '\n\nList the top ' + numResults + ' most authoritative sources with their URLs.' }] }],
    tools: [{ google_search: {} }]
  };

  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  });
  const data = await r.json();
  if (data.error) throw new Error('Gemini Search error: ' + data.error.message);

  // Extract sources from grounding metadata
  const chunks = data.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  const sources = chunks
    .filter(c => c.web?.uri)
    .map(c => ({
      title:   c.web.title   || c.web.uri,
      url:     c.web.uri,
      snippet: ''
    }));

  // If grounding returned sources, use them; otherwise parse from text
  if (sources.length > 0) return sources.slice(0, numResults);

  // Fallback: extract URLs from response text
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const urlMatches = text.match(/https?:\/\/[^\s\)\"\']+/g) || [];
  return [...new Set(urlMatches)].slice(0, numResults).map(u => ({ title: u, url: u, snippet: '' }));
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
  askGoogleSearch,
  MODEL_FULL_NAMES,
  MODEL_CHAIN,
  CODING_MODEL_CHAIN
};
