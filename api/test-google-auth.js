const { google } = require('googleapis');

module.exports = async function handler(req, res) {
  try {
    console.log('Testing Google OAuth setup...');
    
    // Check environment variables
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const redirectUri = process.env.GOOGLE_REDIRECT_URI;
    
    console.log('Environment check:', {
      hasClientId: !!clientId,
      hasClientSecret: !!clientSecret,
      hasRedirectUri: !!redirectUri,
      redirectUri: redirectUri
    });
    
    if (!clientId || !clientSecret || !redirectUri) {
      return res.status(500).json({ 
        error: 'Missing environment variables',
        details: {
          hasClientId: !!clientId,
          hasClientSecret: !!clientSecret,
          hasRedirectUri: !!redirectUri
        }
      });
    }
    
    // Try to create OAuth client
    const oauth2Client = new google.auth.OAuth2(
      clientId,
      clientSecret,
      redirectUri
    );
    
    console.log('OAuth client created successfully');
    
    // Generate auth URL
    const scopes = [
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/tasks.readonly',
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/gmail.readonly'
    ];
    
    const url = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: scopes,
      prompt: 'consent'
    });
    
    console.log('Auth URL generated:', url.substring(0, 100) + '...');
    
    res.status(200).json({ 
      success: true,
      authUrl: url,
      message: 'Google OAuth setup is working - visit this URL to test'
    });
    
  } catch (err) {
    console.error('Google OAuth test error:', err);
    res.status(500).json({ 
      error: 'Google OAuth test failed',
      details: err.message 
    });
  }
};
