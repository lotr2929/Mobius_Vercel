const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      res.status(400).json({ error: 'Email and password required' });
      return;
    }
    if (password.length < 6) {
      res.status(400).json({ error: 'Password must be at least 6 characters' });
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

    const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
      email: email.trim(),
      password,
      options: { emailRedirectTo: undefined }
    });

    if (signUpError) {
      const msg = signUpError.message || '';
      if (msg.includes('already registered') || msg.includes('already exists')) {
        res.status(200).json({ error: 'That email is already registered. Try logging in.' });
        return;
      }
      console.warn('Signup failed:', signUpError.message);
      res.status(200).json({ error: signUpError.message });
      return;
    }

    if (!signUpData?.user) {
      res.status(200).json({ error: 'Sign up failed. Please try again.' });
      return;
    }

    // If Supabase requires email confirmation, user may not be able to sign in yet
    const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password
    });

    if (signInError) {
      // User created but needs to confirm email
      res.status(200).json({ needsConfirmation: true });
      return;
    }

    if (signInData?.user) {
      res.status(200).json({
        userId: signInData.user.id,
        username: signInData.user.email || email
      });
      return;
    }

    res.status(200).json({ needsConfirmation: true });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Sign up failed' });
  }
};
