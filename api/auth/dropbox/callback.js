// ── api/auth/dropbox/callback.js ──────────────────────────────────────────────
// GET /auth/dropbox/callback
// Handles Dropbox OAuth callback, exchanges code for tokens, stores in Supabase

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { code, state: rawState } = req.query;
  if (!code) return res.status(400).json({ error: 'Authorization code required' });

  let userId = '', returnTo = process.env.BASE_URL || '';
  try {
    const parsed = JSON.parse(rawState);
    userId   = parsed.userId   || '';
    returnTo = parsed.returnTo || returnTo;
  } catch {
    userId = rawState || '';
  }

  if (!userId) return res.status(400).json({ error: 'No userId in state' });

  try {
    // Exchange code for tokens
    const tokenRes = await fetch('https://api.dropboxapi.com/oauth2/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({
        code,
        grant_type:    'authorization_code',
        client_id:     process.env.DROPBOX_APP_KEY,
        client_secret: process.env.DROPBOX_APP_SECRET,
        redirect_uri:  process.env.DROPBOX_REDIRECT_URI
      })
    });

    const tokens = await tokenRes.json();
    if (tokens.error) throw new Error(tokens.error_description || tokens.error);

    // Store tokens in Supabase
    const { error: upsertError } = await supabase.from('dropbox_tokens').upsert({
      user_id:       userId,
      access_token:  tokens.access_token,
      refresh_token: tokens.refresh_token || null,
      expiry_date:   tokens.expires_in
        ? Date.now() + tokens.expires_in * 1000
        : null
    }, { onConflict: 'user_id' });

    if (upsertError) throw new Error('Failed to save tokens: ' + upsertError.message);

    res.redirect(returnTo + '?dropbox_connected=true');
  } catch (err) {
    console.error('Dropbox callback error:', err.message);
    res.status(500).json({ error: err.message });
  }
};
