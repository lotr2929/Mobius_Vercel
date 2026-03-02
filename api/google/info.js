const { getGoogleAccountInfo } = require('../../google_api.js');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId is required' });

  try {
    const info = await getGoogleAccountInfo(userId);
    res.json({ connected: true, ...info });
  } catch (err) {
    res.status(200).json({ connected: false, error: err.message });
  }
};
