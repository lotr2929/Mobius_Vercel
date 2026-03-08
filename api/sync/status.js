// ── api/sync/status.js ────────────────────────────────────────────────────────
// GET /api/sync/status?userId=...
// Returns all sync_meta rows for a user — last synced timestamps per label/type

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  try {
    const { data, error } = await supabase
      .from('sync_meta')
      .select('label, type, synced_at')
      .eq('user_id', userId)
      .order('label')
      .order('type');

    if (error) throw error;
    res.json({ status: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
