// ── api/status.js ─────────────────────────────────────────────────────────────
// GET /api/services/status — pings all cloud AI models
// No Google/Dropbox dependencies

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const t0 = Date.now();

  async function ping(name, fn) {
    try { const ok = await fn(); return { name, ok, ms: Date.now() - t0 }; }
    catch(e) { return { name, ok: false, error: e.message }; }
  }

  const results = await Promise.all([
    ping('Groq Llama 3.3', async () => {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + process.env.GROQ_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: [{ role:'user', content:'hi' }], max_tokens: 1 }),
        signal: AbortSignal.timeout(8000)
      });
      return r.ok || r.status === 400;
    }),
    ping('Google - Gemini 2.5 Flash-Lite', async () => {
      const r = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite?key=' + process.env.GEMINI_API_KEY,
        { signal: AbortSignal.timeout(8000) }
      );
      return r.ok;
    }),
    ping('Google - Gemini 2.5 Flash', async () => {
      const r = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models?key=' + process.env.GEMINI_API_KEY,
        { signal: AbortSignal.timeout(8000) }
      );
      return r.ok;
    }),
    ping('Codestral (Mistral AI)', async () => {
      const r = await fetch('https://api.mistral.ai/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + process.env.MISTRAL_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'codestral-latest', messages: [{ role:'user', content:'hi' }], max_tokens: 1 }),
        signal: AbortSignal.timeout(8000)
      });
      return r.ok || r.status === 400 || r.status === 422;
    }),
    ping('GPT-4o (GitHub AI)', async () => {
      const token = process.env.GITHUB_TOKEN;
      if (!token) return false;
      const r = await fetch('https://models.inference.ai.azure.com/chat/completions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-4o', messages: [{ role:'user', content:'hi' }], max_tokens: 1 }),
        signal: AbortSignal.timeout(8000)
      });
      return r.ok || r.status === 400;
    }),
    ping('OpenRouter', async () => {
      const key = process.env.OPENROUTER_API_KEY;
      if (!key) return false;
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'mistralai/mistral-7b-instruct', messages: [{ role:'user', content:'hi' }], max_tokens: 1 }),
        signal: AbortSignal.timeout(8000)
      });
      return r.ok || r.status === 400 || r.status === 422;
    }),
  ]);

  return res.status(200).json({ models: results });
};
