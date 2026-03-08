const { google } = require('googleapis');
const { supabase } = require('../../_supabase.js');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );

    const scopes = [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/tasks',
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile'
    ];

    // Pack userId + returnTo into state so callback can redirect correctly
    const returnTo = req.query.returnTo || process.env.BASE_URL || '';
    const label = req.query.label || 'personal';
    const state = JSON.stringify({ userId: req.query.userId || '', returnTo, label });

    const url = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: scopes,
      prompt: 'consent',
      state
    });

    res.redirect(url);
  } catch (err) {
    console.error('Google auth error:', err);
    res.status(500).json({ error: 'Failed to initiate Google auth' });
  }
};
