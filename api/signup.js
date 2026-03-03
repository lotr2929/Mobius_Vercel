const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    return res.status(405).end(JSON.stringify({ error: 'Method not allowed' }));
  }

  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).end(JSON.stringify({ error: 'Username and password are required' }));
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_KEY
    );

    const { data, error } = await supabase.auth.signUp({
      email: username,
      password: password
    });

    if (error || !data.user) {
      return res.status(400).end(JSON.stringify({ error: error?.message || 'Signup failed' }));
    }

    // Also insert into custom users table so google_tokens foreign key works
    const { supabase: db } = require('./_supabase.js');
    await db.from('users').upsert({
      id: data.user.id,
      username: data.user.email,
      password: password
    }, { onConflict: 'id' });

    return res.status(200).end(JSON.stringify({
      userId: data.user.id,
      username: data.user.email,
      message: 'User created successfully'
    }));

  } catch (err) {
    console.error('Signup error:', err);
    return res.status(500).end(JSON.stringify({ error: 'Signup failed', details: err.message }));
  }
};
