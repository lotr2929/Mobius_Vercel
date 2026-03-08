// ── api/google/accounts.js ────────────────────────────────────────────────────
// GET /api/google/accounts?userId=...
// Returns all connected Google accounts (label + email) for a user

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  try {
    const { data, error } = await supabase
      .from('google_tokens')
      .select('label, email')
      .eq('user_id', userId)
      .order('label');

    if (error) throw error;
    res.json({ accounts: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
