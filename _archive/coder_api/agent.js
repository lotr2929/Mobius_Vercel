// ── api/agent.js ──────────────────────────────────────────────────────────────
// POST /agent?action=think  — Gemini tool loop call
// POST /agent?action=commit — commit a file to the dev branch
// POST /agent?action=merge  — merge dev → main

const REPO = 'lotr2929/Mobius_Vercel';

// ── GitHub helpers ────────────────────────────────────────────────────────────

async function githubGet(path) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/${path}`, {
    headers: {
      Authorization: 'Bearer ' + process.env.GITHUB_PAT,
      Accept: 'application/vnd.github+json'
    }
  });
  const data = await r.json();
  if (!r.ok) throw new Error('GitHub GET ' + path + ' failed: ' + (data.message || r.status));
  return data;
}

async function githubPost(path, body) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/${path}`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + process.env.GITHUB_PAT,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const data = await r.json();
  if (!r.ok) throw new Error('GitHub POST ' + path + ' failed: ' + (data.message || r.status));
  return data;
}

async function githubPut(path, body) {
  const r = await fetch(`https://api.github.com/repos/${REPO}/${path}`, {
    method: 'PUT',
    headers: {
      Authorization: 'Bearer ' + process.env.GITHUB_PAT,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const data = await r.json();
  if (!r.ok) throw new Error('GitHub PUT ' + path + ' failed: ' + (data.message || r.status));
  return data;
}

// ── action=think — Gemini tool loop ──────────────────────────────────────────

async function handleThink(req, res) {
  const { messages, tools } = req.body || {};
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array required' });
  }

  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: 'GEMINI_API_KEY not set' });

  let model = 'gemini-2.5-flash';
  try {
    const r    = await fetch('https://generativelanguage.googleapis.com/v1beta/models?key=' + key,
      { signal: AbortSignal.timeout(4000) });
    const data = await r.json();
    const pick = (data.models || [])
      .filter(m =>
        (m.supportedGenerationMethods || []).includes('generateContent') &&
        m.name.includes('flash') &&
        !m.name.includes('lite') &&
        !m.name.includes('image') &&
        !m.name.includes('tts') &&
        !m.name.includes('live')
      )
      .map(m => m.name.replace('models/', ''))
      .find(m => !m.includes('preview')) || 'gemini-2.5-flash';
    model = pick;
  } catch { /* use fallback */ }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const body = { contents: messages };
  if (tools && tools.length > 0) body.tools = tools;

  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await r.json();

  if (data.error) {
    return res.status(502).json({ error: 'Gemini error: ' + (data.error.message || JSON.stringify(data.error)) });
  }
  if (!data.candidates?.[0]) {
    return res.status(502).json({ error: 'No candidates from Gemini: ' + JSON.stringify(data) });
  }

  return res.status(200).json({ candidate: data.candidates[0], model });
}

// ── action=commit — write a file to the dev branch ───────────────────────────

async function handleCommit(req, res) {
  const { path, content, message } = req.body || {};
  if (!path || !content || !message) {
    return res.status(400).json({ error: 'path, content, and message are required' });
  }
  if (!process.env.GITHUB_PAT) {
    return res.status(500).json({ error: 'GITHUB_PAT not set' });
  }

  let devExists = true;
  try {
    await githubGet('git/ref/heads/dev');
  } catch {
    devExists = false;
  }

  if (!devExists) {
    const mainRef = await githubGet('git/ref/heads/main');
    const mainSha = mainRef.object.sha;
    await githubPost('git/refs', { ref: 'refs/heads/dev', sha: mainSha });
  }

  let sha;
  try {
    const existing = await githubGet('contents/' + path + '?ref=dev');
    sha = existing.sha;
  } catch {
    sha = undefined;
  }

  const body = { message, content, branch: 'dev' };
  if (sha) body.sha = sha;

  const result = await githubPut('contents/' + path, body);

  return res.status(200).json({
    ok: true,
    commitUrl: result.commit?.html_url || null,
    sha: result.content?.sha || null
  });
}

// ── action=merge — merge dev into main ───────────────────────────────────────

async function handleMerge(req, res) {
  const { message } = req.body || {};
  if (!process.env.GITHUB_PAT) {
    return res.status(500).json({ error: 'GITHUB_PAT not set' });
  }

  const commitMessage = message || 'Code: agent - merge dev into main';

  try {
    const result = await githubPost('merges', {
      base: 'main',
      head: 'dev',
      commit_message: commitMessage
    });
    return res.status(200).json({ ok: true, sha: result.sha, mergeUrl: result.html_url || null });
  } catch (err) {
    if (err.message.includes('204') || err.message.includes('No Content')) {
      return res.status(200).json({ ok: true, alreadyUpToDate: true });
    }
    throw err;
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action } = req.query;

  try {
    if (action === 'think')  return await handleThink(req, res);
    if (action === 'commit') return await handleCommit(req, res);
    if (action === 'merge')  return await handleMerge(req, res);
    return res.status(400).json({ error: 'Unknown action: ' + action });
  } catch (err) {
    console.error('[Mobius] agent/' + action + ' error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
