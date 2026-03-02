const { supabase } = require('../../_supabase.js');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { userId } = req.query;
  if (!userId) return res.status(200).json({ connected: false });

  try {
    const { data } = await supabase
      .from('google_tokens')
      .select('user_id')
      .eq('user_id', userId)
      .single();
    res.status(200).json({ connected: !!data });
  } catch (err) {
    res.status(200).json({ connected: false });
  }
};
