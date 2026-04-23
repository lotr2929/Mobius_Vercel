// api/health.js: Checks the health and connectivity of the Supabase instance.
module.exports = async function handler(req, res) {
  let supabase = 'unchecked';
  let supabaseDetail = '';

  try {
    const url = process.env.SUPABASE_URL + '/rest/v1/conversations?select=id&limit=1';

    // Log what we're actually fetching
    console.log('[health] SUPABASE_URL:', JSON.stringify(process.env.SUPABASE_URL));
    console.log('[health] SUPABASE_KEY length:', process.env.SUPABASE_KEY?.length);
    console.log('[health] Fetching:', url);

    const r = await fetch(url, {
      headers: {
        apikey: process.env.SUPABASE_KEY,
        Authorization: 'Bearer ' + process.env.SUPABASE_KEY
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
