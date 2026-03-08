const { google } = require('googleapis');
const { supabase } = require('../../_supabase.js');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { code, state: rawState } = req.query;
    if (!code) return res.status(400).json({ error: 'Authorization code is required' });

    // Unpack state — supports both new JSON format and legacy plain userId string
    let userId = '', returnTo = process.env.BASE_URL || '', label = 'personal';
    try {
      const parsed = JSON.parse(rawState);
      userId   = parsed.userId   || '';
      returnTo = parsed.returnTo || returnTo;
      label    = parsed.label    || 'personal';
    } catch {
      userId = rawState || ''; // legacy fallback
    }

    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );

    const { tokens } = await oauth2Client.getToken(code);

    // Fetch user email using access token directly
    const userinfoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: 'Bearer ' + tokens.access_token }
    });
    const userInfo = await userinfoRes.json();

    // Save tokens to Supabase for Google API use
    if (userId) {
      const { error: upsertError } = await supabase.from('google_tokens').upsert({
        user_id: userId,
        label,
        email: userInfo.email,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expiry_date: tokens.expiry_date
      }, { onConflict: 'user_id, label' });
      if (upsertError) {
        console.error('Supabase upsert error:', upsertError);
        return res.status(500).json({ error: 'Failed to save tokens: ' + upsertError.message, userId, hasAccessToken: !!tokens.access_token });
      }
    } else {
      console.error('No userId in state parameter');
      return res.status(400).json({ error: 'No userId provided in OAuth state' });
    }

    if (!returnTo) throw new Error('BASE_URL environment variable is not set.');
    res.redirect(`${returnTo}?google_email=${encodeURIComponent(userInfo.email)}`);
  } catch (err) {
    console.error('Google callback error:', err);
    res.status(500).json({ error: 'Failed to complete Google auth' });
  }
};
