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

async function askGemini(messages, imageParts = []) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is not set on the server.');
  const contents = messages.map((m, i) => {
    const isLastUser = i === messages.length - 1 && m.role === 'user';
    const parts = [];
    if (isLastUser && imageParts.length > 0) parts.push(...imageParts);
    parts.push({ text: m.content });
    return { role: m.role === 'assistant' ? 'model' : 'user', parts };
  });
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + key;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents })
  });
  const data = await r.json();
  if (data.error) throw new Error('Gemini API error: ' + data.error.message);
  if (!data.candidates?.[0]) throw new Error('No candidates in Gemini response: ' + JSON.stringify(data));
  return data.candidates[0].content.parts[0].text;
}

async function askMistral(messages) {
  const r = await fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + process.env.MISTRAL_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ model: 'codestral-latest', messages })
  });
  const data = await r.json();
  return data.choices?.[0]?.message?.content || JSON.stringify(data);
}

const MODEL_CHAIN = ['groq', 'gemini', 'mistral'];

async function askWithFallback(messages, imageParts = [], startModel = 'groq') {
  const startIdx = MODEL_CHAIN.indexOf(startModel);
  const chain = startIdx !== -1 ? MODEL_CHAIN.slice(startIdx) : MODEL_CHAIN;
  let lastErr = null;
  for (const model of chain) {
    try {
      let result;
      if (model === 'groq') result = await askGroq(messages);
      else if (model === 'gemini') result = await askGemini(messages, imageParts);
      else if (model === 'mistral') result = await askMistral(messages);
      const label = model === startModel ? model : model + ' (fallback from ' + startModel + ')';
      return { reply: result, modelUsed: label };
    } catch (err) {
      console.warn('[Mobius] ' + model + ' failed:', err.message);
      lastErr = err;
    }
  }
  throw lastErr || new Error('All models failed');
}

async function askWebSearch(messages) {
  const tavilyKey = process.env.TAVILY_API_KEY;
  if (!tavilyKey) throw new Error('TAVILY_API_KEY is not set on the server.');
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  const query = lastUserMsg ? lastUserMsg.content : '';
  const searchRes = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: tavilyKey, query, max_results: 5, include_answer: false })
  });
  const searchData = await searchRes.json();
  if (searchData.error) throw new Error('Tavily error: ' + searchData.error);
  const context = searchData.results
    .map((r, i) => `[${i + 1}] ${r.title}\n${r.content}\nSource: ${r.url}`)
    .join('\n\n');
  const augmented = messages.map((m, i) => {
    if (i === messages.length - 1 && m.role === 'user') {
      return {
        role: 'user',
        content: `Answer using web search results. Be concise and cite sources.\n\nQuestion: ${m.content}\n\nSearch Results:\n${context}`
      };
    }
    return m;
  });
  return await askWithFallback(augmented);
}

module.exports = {
  askGroq,
  askGemini,
  askMistral,
  askWithFallback,
  askWebSearch
};
