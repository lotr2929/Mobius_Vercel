// ── api/services/status.js ────────────────────────────────────────────────────
// GET /api/services/status
// Pings each cloud AI model with a minimal message and returns pass/fail.

const PING_MESSAGES = [{ role: 'user', content: 'Reply with the single word: ok' }];

async function pingGroq() {
  const start = Date.now();
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + process.env.GROQ_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: PING_MESSAGES, max_tokens: 5 })
  });
  const data = await r.json();
  if (!r.ok || data.error) throw new Error(data.error?.message || 'HTTP ' + r.status);
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('No content returned');
  return { ms: Date.now() - start };
}

async function pingGemini() {
  const start = Date.now();
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not set');
  const r = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + key,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Reply with the single word: ok' }] }] })
    }
  );
  const data = await r.json();
  if (data.error) throw new Error(data.error.message);
  if (!data.candidates?.[0]) throw new Error('No candidates returned');
  return { ms: Date.now() - start };
}

async function pingMistral() {
  const start = Date.now();
  const key = process.env.MISTRAL_API_KEY;
  if (!key) throw new Error('MISTRAL_API_KEY not set');
  const r = await fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'codestral-latest', messages: PING_MESSAGES, max_tokens: 5 })
  });
  const data = await r.json();
  if (!r.ok || data.error || data.message) throw new Error(data.error?.message || data.message || 'HTTP ' + r.status);
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('No content returned');
  return { ms: Date.now() - start };
}

async function pingGitHub() {
  const start = Date.now();
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN not set');
  const r = await fetch('https://models.inference.ai.azure.com/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o', messages: PING_MESSAGES, max_tokens: 5 })
  });
  const data = await r.json();
  if (!r.ok || !data.choices?.[0]?.message?.content) throw new Error(data.error?.message || 'HTTP ' + r.status);
  return { ms: Date.now() - start };
}

const MODELS = [
  {
    key:     'groq',
    name:    'Groq Llama 3.3 70B',
    context: '128k tokens',
    note:    'Fast general-purpose · rate-limited on free tier',
    ping:    pingGroq
  },
  {
    key:     'gemini',
    name:    'Gemini 2.5 Flash',
    context: '1M tokens',
    note:    'Best for long docs & images · daily quota limit',
    ping:    pingGemini
  },
  {
    key:     'mistral',
    name:    'Mistral Codestral',
    context: '256k tokens',
    note:    'Code specialist (80+ languages) · weaker general knowledge',
    ping:    pingMistral
  },
  {
    key:     'github',
    name:    'GitHub GPT-4o',
    context: '128k tokens',
    note:    'Strong all-rounder · low rate limits (preview)',
    ping:    pingGitHub
  }
];

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const results = await Promise.all(
    MODELS.map(async m => {
      try {
        const { ms } = await m.ping();
        return { key: m.key, name: m.name, context: m.context, note: m.note, ok: true, ms };
      } catch (err) {
        return { key: m.key, name: m.name, context: m.context, note: m.note, ok: false, error: err.message };
      }
    })
  );

  res.json({ models: results });
};
