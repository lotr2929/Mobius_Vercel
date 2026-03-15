// ── api/services/[action].js ──────────────────────────────────────────────────
// SERVICES — all external service management and health checks
//
// GET  /api/google/accounts    → action=accounts
// GET  /api/google/info        → action=info
// POST /api/google/disconnect  → action=disconnect
// POST /api/dropbox            → action=dropbox
// POST /api/dropbox/list       → action=dropbox-list
// GET  /api/services/status    → action=status

const { createClient }       = require('@supabase/supabase-js');
const { getGoogleAccountInfo, writeDriveFileContent, findDriveFile, createDriveFile } = require('../../google_api.js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ── Dropbox helpers ───────────────────────────────────────────────────────────

async function getDropboxToken(userId) {
  const { data } = await supabase
    .from('dropbox_tokens')
    .select('access_token, refresh_token, expiry_date')
    .eq('user_id', userId)
    .single();
  if (!data) throw new Error('Dropbox not connected.');
  const expiresAt = data.expiry_date || 0;
  if (data.refresh_token && Date.now() > expiresAt - 5 * 60 * 1000) {
    const refreshRes = await fetch('https://api.dropboxapi.com/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token', refresh_token: data.refresh_token,
        client_id: process.env.DROPBOX_APP_KEY, client_secret: process.env.DROPBOX_APP_SECRET
      })
    });
    const refreshed = await refreshRes.json();
    if (refreshed.access_token) {
      const newExpiry = Date.now() + (refreshed.expires_in || 14400) * 1000;
      await supabase.from('dropbox_tokens').upsert(
        { user_id: userId, access_token: refreshed.access_token, expiry_date: newExpiry },
        { onConflict: 'user_id' }
      );
      return refreshed.access_token;
    }
  }
  return data.access_token;
}

async function listAllDropboxFiles(accessToken) {
  const files = [];
  async function fetchPage(cursor) {
    const url  = cursor
      ? 'https://api.dropboxapi.com/2/files/list_folder/continue'
      : 'https://api.dropboxapi.com/2/files/list_folder';
    const body = cursor
      ? JSON.stringify({ cursor })
      : JSON.stringify({ path: '', recursive: true, limit: 2000 });
    const res  = await fetch(url, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
      body
    });
    return await res.json();
  }
  let result = await fetchPage(null);
  while (true) {
    for (const entry of result.entries || []) {
      if (entry['.tag'] === 'file') {
        files.push({
          name: entry.name, path: entry.path_display,
          modified: entry.client_modified || entry.server_modified || '',
          size: entry.size || 0
        });
      }
    }
    if (!result.has_more) break;
    result = await fetchPage(result.cursor);
  }
  return files;
}

async function writeIndexFile(userId, filename, content) {
  const found = await findDriveFile(userId, filename);
  const exactMatch = (found.files || []).find(f => f.name === filename && f.inMobius)
                  || (found.files || []).find(f => f.name === filename);
  if (exactMatch) {
    await writeDriveFileContent(userId, exactMatch.id, content);
    return exactMatch.id;
  }
  const newFile = await createDriveFile(userId, filename, found.folderId);
  await writeDriveFileContent(userId, newFile.id, content);
  return newFile.id;
}

// ── Status ping helpers ───────────────────────────────────────────────────────
// Gemini model resolution cached per cold start — avoids repeated model list queries
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

  // Use cached model resolution — only queries Google once per cold start
  let model       = _statusGeminiModel;
  let displayName = _statusGeminiName;

  if (!model) {
    model       = 'gemini-2.5-flash';
    displayName = 'Gemini 2.5 Flash';
    try {
      const listRes  = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models?key=' + key,
        { signal: AbortSignal.timeout(5000) }
      );
      const listData = await listRes.json();
      const models   = (listData.models || [])
        .filter(m =>
          (m.supportedGenerationMethods || []).includes('generateContent') &&
          !m.name.includes('image') && !m.name.includes('tts') &&
          !m.name.includes('live') && !m.name.includes('embed') &&
          !m.name.includes('robotics') && !m.name.includes('computer-use') &&
          !m.name.includes('research')
        );
      const pick =
        models.find(m => m.name.includes('gemini-2.5-flash') && !m.name.includes('preview') && !m.name.includes('lite')) ||
        models.find(m => m.name.includes('flash') && !m.name.includes('preview') && !m.name.includes('lite')) ||
        models.find(m => m.name.includes('flash')) ||
        models[0];
      if (pick) {
        model       = pick.name.replace('models/', '');
        displayName = pick.displayName || model;
      }
    } catch { /* use fallback */ }
    _statusGeminiModel = model;
    _statusGeminiName  = displayName;
  }

  const r = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + key,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Reply with the single word: ok' }] }] })
    }
  );
  const data = await r.json();
  if (data.error) throw new Error(data.error.message);
  if (!data.candidates?.[0]) throw new Error('No candidates returned');
  return { ms: Date.now() - start, modelId: model, displayName };
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
  { key: 'groq',    name: 'Groq Llama 3.3 70B',  context: '128k tokens', ping: pingGroq    },
  { key: 'gemini',  name: 'Gemini 2.5 Flash',      context: '1M tokens',   ping: pingGemini  },
  { key: 'mistral', name: 'Mistral Codestral',      context: '256k tokens', ping: pingMistral },
  { key: 'github',  name: 'GitHub GPT-4o',          context: '128k tokens', ping: pingGitHub  },
];

// ── Handler ───────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  const { action } = req.query;

  // ── status — GET /api/services/status ─────────────────────────────────────
  if (action === 'status') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const results = await Promise.all(
      STATUS_MODELS.map(async m => {
        try {
          const result = await m.ping();
          // Use provider-supplied display name when available (e.g. Gemini resolves dynamically)
          const name = result.displayName || m.name;
          return { key: m.key, name, context: m.context, ok: true, ms: result.ms };
        } catch (err) {
          return { key: m.key, name: m.name, context: m.context, ok: false, error: err.message };
        }
      })
    );
    return res.json({ models: results });
  }

  // ── accounts — GET /api/google/accounts ──────────────────────────────────
  if (action === 'accounts') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    try {
      const { data, error } = await supabase
        .from('google_tokens').select('label, email').eq('user_id', userId).order('label');
      if (error) throw error;
      return res.json({ accounts: data || [] });
    } catch (err) { return res.status(500).json({ error: err.message }); }
  }

  // ── info — GET /api/google/info ───────────────────────────────────────────
  if (action === 'info') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    try {
      const info = await getGoogleAccountInfo(userId);
      return res.json({ connected: true, ...info });
    } catch (err) { return res.status(200).json({ connected: false, error: err.message }); }
  }

  // ── disconnect — POST /api/google/disconnect ──────────────────────────────
  if (action === 'disconnect') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const { userId, label } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId required' });
    if (!label)  return res.status(400).json({ error: 'label required' });
    if (!['personal','family','work'].includes(label)) return res.status(400).json({ error: 'Invalid label' });
    try {
      const { error } = await supabase.from('google_tokens').delete().eq('user_id', userId).eq('label', label);
      if (error) throw error;
      return res.json({ ok: true, label });
    } catch (err) { return res.status(500).json({ error: err.message }); }
  }

  // ── dropbox — POST /api/dropbox ───────────────────────────────────────────
  if (action === 'dropbox') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const { userId } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId required' });
    try {
      const accessToken = await getDropboxToken(userId);
      const files       = await listAllDropboxFiles(accessToken);
      const lines = [
        '# dropbox.index', '# Generated: ' + new Date().toLocaleString('en-AU'),
        '# Format: modified | size | path', '# Total: ' + files.length + ' files', ''
      ];
      for (const f of files) {
        lines.push(f.modified + ' | ' + (f.size > 0 ? (f.size / 1024).toFixed(1) + ' KB' : '—') + ' | ' + f.path);
      }
      await writeIndexFile(userId, 'dropbox.index', lines.join('\n'));
      await supabase.from('sync_meta').upsert(
        { user_id: userId, label: 'dropbox', type: 'dropbox', synced_at: new Date().toISOString() },
        { onConflict: 'user_id, label, type' }
      );
      return res.json({ ok: true, files: files.length });
    } catch (err) {
      console.error('Dropbox sync error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // ── dropbox-list — POST /api/dropbox/list ────────────────────────────────
  if (action === 'dropbox-list') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const { userId, path: folderPath } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId required' });
    try {
      const accessToken = await getDropboxToken(userId);
      const r    = await fetch('https://api.dropboxapi.com/2/files/list_folder', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: folderPath || '', recursive: false })
      });
      const data = await r.json();
      if (data.error_summary) throw new Error(data.error_summary);
      const entries = (data.entries || []).map(e => ({ name: e.name, type: e['.tag'], path: e.path_display }));
      return res.json({ ok: true, entries });
    } catch (err) { return res.status(500).json({ error: err.message }); }
  }

  res.status(400).json({ error: 'Unknown action: ' + action });
};
