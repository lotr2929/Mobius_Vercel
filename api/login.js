const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      res.status(400).json({ error: 'Username and password required' });
      return;
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_KEY;
    if (!supabaseUrl || !supabaseKey) {
      console.error('SUPABASE_URL or SUPABASE_KEY not set');
      res.status(500).json({ error: 'Server misconfiguration' });
      return;
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    const { data, error } = await supabase
      .from('users')
      .select('id, username')
      .eq('username', username.trim())
      .eq('password', password)
      .single();

    if (error || !data) {
      res.status(200).json({}); // Return empty to show "Invalid username or password"
      return;
    }

    res.status(200).json({
      userId: data.id,
      username: data.username
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
};
