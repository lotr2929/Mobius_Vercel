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

    const { data, error } = await supabase.auth.signInWithPassword({
      email: username,
      password: password
    });

    if (error || !data.user) {
      return res.status(401).end(JSON.stringify({ error: 'Invalid username or password' }));
    }

    return res.status(200).end(JSON.stringify({
      userId: data.user.id,
      username: data.user.email,
      message: 'Login successful'
    }));

  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).end(JSON.stringify({ error: 'Login failed', details: err.message }));
  }
};
