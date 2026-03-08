// ── api/google/disconnect.js ──────────────────────────────────────────────────
// POST /api/google/disconnect
// Removes Google tokens for a specific label (personal / family / work)
// Body: { userId, label }

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { userId, label } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'userId required' });
  if (!label)  return res.status(400).json({ error: 'label required' });

  const VALID = ['personal', 'family', 'work'];
  if (!VALID.includes(label)) return res.status(400).json({ error: 'Invalid label' });

  try {
    const { error } = await supabase
      .from('google_tokens')
      .delete()
      .eq('user_id', userId)
      .eq('label', label);

    if (error) throw error;
    res.json({ ok: true, label });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
