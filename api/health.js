module.exports = async function handler(req, res) {
  let supabase = 'unchecked';
  let supabaseDetail = '';

  try {
    const url = process.env.MOBIUS_SUPABASE_URL + '/rest/v1/conversations?select=id&limit=1';

    // Log what we're actually fetching
    console.log('[health] MOBIUS_SUPABASE_URL:', JSON.stringify(process.env.MOBIUS_SUPABASE_URL));
    console.log('[health] MOBIUS_SUPABASE_PUBLISHABLE_KEY length:', process.env.MOBIUS_SUPABASE_PUBLISHABLE_KEY?.length);
    console.log('[health] Fetching:', url);

    const r = await fetch(url, {
      headers: {
        apikey: process.env.MOBIUS_SUPABASE_PUBLISHABLE_KEY,
        Authorization: 'Bearer ' + process.env.MOBIUS_SUPABASE_PUBLISHABLE_KEY
      },
      signal: AbortSignal.timeout(6000)
    });

    console.log('[health] Supabase status:', r.status);
    supabase = (r.ok || r.status === 406) ? 'ok' : 'error';
    supabaseDetail = 'HTTP ' + r.status;

  } catch(e) {
    console.error('[health] Supabase fetch error:', e.message, e.cause?.message, e.cause?.code);
    supabase = 'error';
    supabaseDetail = e.message + (e.cause ? ' | cause: ' + e.cause.message : '');
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).json({ ok: true, timestamp: new Date().toISOString(), supabase, supabaseDetail });
};
