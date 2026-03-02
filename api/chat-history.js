const { createClient } = require('@supabase/supabase-js');
const { getChatHistory } = require('./_supabase.js');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId is required' });

  const sessions = await getChatHistory(userId, 10000);
  res.status(200).json({ sessions });
};
