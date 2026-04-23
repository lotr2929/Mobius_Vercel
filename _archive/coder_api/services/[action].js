// ── api/services/[action].js ──────────────────────────────────────────────────
// GET /api/services/status  → action=status
// Routed via vercel.json: /api/services/status -> /api/status (direct bypass)
// This file kept for potential future service actions.

// ── Status ping helpers ───────────────────────────────────────────────────────
// Gemini model resolution cached per cold start
let _statusGeminiModel = null;
let _statusGeminiName  = null;

const PING_MSG = [{ role: 'user', content: 'Reply with the single word: ok' }];

async function pingGroq() {
  const start = Date.now();
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.GROQ_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: PING_MSG, max_tokens: 5 })
  });
  const data = await r.json();
  if (!r.ok || data.error) throw new Error(data.error?.message || 'HTTP ' + r.status);
  if (!data.choices?.[0]?.message?.content) throw new Error('No content returned');
  return { ms: Date.now() - start };
}

async function pingGemini() {
  const start = Date.now();
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not set');
  if (!_statusGeminiModel) {
    const listRes  = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models?key=' + key,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!listRes.ok) throw new Error('Gemini API unreachable -- HTTP ' + listRes.status);
    const listData = await listRes.json();
    if (listData.error) throw new Error('Gemini API error: ' + listData.error.message);
    const models = (listData.models || []).filter(m =>
      (m.supportedGenerationMethods || []).includes('generateContent') &&
      !m.name.includes('image') && !m.name.includes('tts') &&
      !m.name.includes('live') && !m.name.includes('embed') &&
      !m.name.includes('robotics') && !m.name.includes('computer-use') &&
      !m.name.includes('research')
    );
    if (!models.length) throw new Error('Gemini: no generateContent models available');
    const pick =
      models.find(m => m.name.includes('gemini-2.5-flash') && !m.name.includes('preview') && !m.name.includes('lite')) ||
      models.find(m => m.name.includes('flash') && !m.name.includes('preview') && !m.name.includes('lite')) ||
      models.find(m => m.name.includes('flash')) ||
      models[0];
    _statusGeminiModel = pick.name.replace('models/', '');
    _statusGeminiName  = pick.displayName || _statusGeminiModel;
  }
  return { ms: Date.now() - start, modelId: _statusGeminiModel, displayName: _statusGeminiName };
}

async function pingMistral() {
  const start = Date.now();
  const key = process.env.MISTRAL_API_KEY;
  if (!key) throw new Error('MISTRAL_API_KEY not set');
  const r = await fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'codestral-latest', messages: PING_MSG, max_tokens: 5 })
  });
  const data = await r.json();
  if (!r.ok || data.error || data.message) throw new Error(data.error?.message || data.message || 'HTTP ' + r.status);
  if (!data.choices?.[0]?.message?.content) throw new Error('No content returned');
  return { ms: Date.now() - start };
}

async function pingGitHub() {
  const start = Date.now();
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN not set');
  const r = await fetch('https://models.inference.ai.azure.com/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o', messages: PING_MSG, max_tokens: 5 })
  });
  const data = await r.json();
  if (!r.ok || !data.choices?.[0]?.message?.content) throw new Error(data.error?.message || 'HTTP ' + r.status);
  return { ms: Date.now() - start };
}

const STATUS_MODELS = [
  { key: 'groq',    name: 'Groq Llama 3.3 70B', context: '128k tokens', ping: pingGroq    },
  { key: 'gemini',  name: 'Gemini 2.5 Flash',    context: '1M tokens',   ping: pingGemini  },
  { key: 'mistral', name: 'Mistral Codestral',    context: '256k tokens', ping: pingMistral },
  { key: 'github',  name: 'GitHub GPT-4o',        context: '128k tokens', ping: pingGitHub  },
];

// ── Handler ───────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  const { action } = req.query;

  if (action === 'status') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const results = await Promise.all(
      STATUS_MODELS.map(async m => {
        try {
          const result = await m.ping();
          const name = result.displayName || m.name;
          return { key: m.key, name, context: m.context, ok: true, ms: result.ms };
        } catch (err) {
          return { key: m.key, name: m.name, context: m.context, ok: false, error: err.message };
        }
      })
    );
    return res.json({ models: results });
  }

  res.status(400).json({ error: 'Unknown action: ' + action });
};
