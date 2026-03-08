// ── api/auth/dropbox/index.js ─────────────────────────────────────────────────
// GET /auth/dropbox
// Redirects user to Dropbox OAuth consent page

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const userId   = req.query.userId   || '';
  const returnTo = req.query.returnTo || process.env.BASE_URL || '';

  if (!userId) return res.status(400).json({ error: 'userId required' });

  const state = JSON.stringify({ userId, returnTo });

  const params = new URLSearchParams({
    client_id:         process.env.DROPBOX_APP_KEY,
    redirect_uri:      process.env.DROPBOX_REDIRECT_URI,
    response_type:     'code',
    state,
    token_access_type: 'offline'  // requests refresh_token
  });

  res.redirect('https://www.dropbox.com/oauth2/authorize?' + params.toString());
};
