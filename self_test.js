// ── Mobius Self-Test ──────────────────────────────────────────────────────────
// Runs after every deployment to verify Mobius is behaving correctly.
// Tests routing, logging, fallbacks, and endpoint health.
//
// Usage:  node self_test.js
// From deploy.bat: called automatically after push
//
// Requires .env.local:
//   VERCEL_URL or BASE_URL  — live deployment URL
//   SUPABASE_URL            — for logging check
//   SUPABASE_KEY            — for logging check
//   MOBIUS_TEST_USER_ID     — userId for test calls (optional, skips auth tests if missing)

require('dotenv').config({ path: '.env.local' });
const https = require('https');
const http  = require('http');

const BASE_URL     = (process.env.VERCEL_URL || process.env.BASE_URL || 'https://mobius-vercel.vercel.app').replace(/\/$/, '');
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const TEST_USER_ID = process.env.MOBIUS_TEST_USER_ID || null;

// ── Helpers ───────────────────────────────────────────────────────────────────

async function req(url, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib    = parsed.protocol === 'https:' ? https : http;
    const opts   = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + (parsed.search || ''),
      method:   options.method || 'GET',
      headers:  options.headers || {}
    };
    const request = lib.request(opts, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    request.on('error', reject);
    request.setTimeout(20000, () => { request.destroy(); reject(new Error('timeout')); });
    if (body) request.write(typeof body === 'string' ? body : JSON.stringify(body));
    request.end();
  });
}

async function askMobius(query, files = [], askOverride = null) {
  if (!TEST_USER_ID) throw new Error('MOBIUS_TEST_USER_ID not set');
  const mobius_query = {
    ASK:          askOverride || 'groq',
    INSTRUCTIONS: 'Brief',
    HISTORY:      [],
    QUERY:        query,
    FILES:        files,
    CONTEXT:      null
  };
  const t0  = Date.now();
  const res = await req(BASE_URL + '/ask', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': 'mobius_user_id=' + TEST_USER_ID }
  }, { mobius_query, userId: TEST_USER_ID });
  return { ...res.body, latencyMs: Date.now() - t0, httpStatus: res.status };
}

// Tiny 10x10 red square PNG — hardcoded, no external deps, minimal quota cost
const RED_SQUARE_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFklEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==';

// ── Test runner ───────────────────────────────────────────────────────────────

const results = [];
let passed = 0;

async function test(name, fn) {
  const t0 = Date.now();
  try {
    const msg = await fn();
    const ms  = Date.now() - t0;
    results.push({ name, ok: true, skipped: false, ms, msg: msg || '' });
    passed++;
  } catch (err) {
    const ms      = Date.now() - t0;
    const skipped = err.message.startsWith('SKIPPED');
    results.push({ name, ok: skipped, skipped, ms, msg: err.message });
    if (skipped) passed++; // skipped tests do not count as failures
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

async function runTests() {
  console.log('\n' + '━'.repeat(54));
  console.log('  Mobius Self-Test — ' + new Date().toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' }));
  console.log('  ' + BASE_URL);
  console.log('━'.repeat(54));

  // Test 1 — Simple query → Groq
  await test('Simple query → Groq', async () => {
    if (!TEST_USER_ID) throw new Error('SKIPPED — MOBIUS_TEST_USER_ID not set');
    const r = await askMobius('Reply with the single word: hello');
    if (r.httpStatus !== 200) throw new Error('HTTP ' + r.httpStatus);
    if (!r.reply) throw new Error('No reply');
    const model = (r.modelUsed || '').toLowerCase();
    if (!model.includes('groq') && !model.includes('llama')) {
      throw new Error('Routing: simple query → ' + r.modelUsed + ' (expected Groq)');
    }
    return r.modelUsed + ' (' + r.latencyMs + 'ms)';
  });

  // Test 2 — Complex query → Flash-Lite
  await test('Complex query → Flash-Lite', async () => {
    if (!TEST_USER_ID) throw new Error('SKIPPED — MOBIUS_TEST_USER_ID not set');
    const longQuery = 'Analyse the geopolitical implications of artificial intelligence development on international trade relationships, supply chains, and economic power structures. Consider how differing national AI strategies between the United States, China, and the European Union are reshaping multilateral agreements, technology export controls, semiconductor access, and digital sovereignty frameworks. Provide a structured evaluation framework covering at least four dimensions including economic, political, technological, and security considerations, with concrete examples from the past five years.';
    // This query is >500 chars and contains analysis keywords — scores 2+ and should hit Flash-Lite threshold (score >=2 for moderate queries)
    const r = await askMobius(longQuery);
    if (r.httpStatus !== 200) throw new Error('HTTP ' + r.httpStatus);
    if (!r.reply) throw new Error('No reply');
    const model = (r.modelUsed || '').toLowerCase();
    if (!model.includes('lite') && !model.includes('flash-lite')) {
      throw new Error('Routing: complex query → ' + r.modelUsed + ' (expected Flash-Lite)');
    }
    return r.modelUsed + ' (' + r.latencyMs + 'ms)';
  });

  // Test 3 — Image → Gemini Flash
  await test('Image → Gemini Flash', async () => {
    if (!TEST_USER_ID) throw new Error('SKIPPED — MOBIUS_TEST_USER_ID not set');
    const files = [{ name: 'test.png', mimeType: 'image/png', base64: RED_SQUARE_PNG, size: 68 }];
    const r = await askMobius('What colour is the main shape in this image?', files);
    if (r.httpStatus !== 200) throw new Error('HTTP ' + r.httpStatus);
    if (!r.reply) throw new Error('No reply');
    const model = (r.modelUsed || '').toLowerCase();
    if (!model.includes('gemini') && !model.includes('flash')) {
      throw new Error('Routing: image → ' + r.modelUsed + ' (expected Gemini Flash)');
    }
    if (model.includes('lite')) {
      throw new Error('Routing: image → Flash-Lite instead of Flash (vision requires full Flash)');
    }
    if (!model.includes('gemini') && !model.includes('flash')) {
      // Fallback occurred — Gemini unavailable, but routing attempted correctly
      return r.modelUsed + ' (fallback — Gemini Flash unavailable) (' + r.latencyMs + 'ms)';
    }
    return r.modelUsed + ' (' + r.latencyMs + 'ms)';
  });

  // Test 4 — Knowledge table logging
  await test('Knowledge table logging', async () => {
    if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('SKIPPED — Supabase env vars not set');
    if (!TEST_USER_ID) throw new Error('SKIPPED — MOBIUS_TEST_USER_ID not set');
    // Wait a moment for async logging to complete
    await new Promise(r => setTimeout(r, 2000));
    const since = new Date(Date.now() - 60000).toISOString();
    const res = await req(
      SUPABASE_URL + '/rest/v1/knowledge?user_id=eq.' + TEST_USER_ID + '&type=eq.model_event&created_at=gte.' + since + '&limit=1',
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY } }
    );
    if (res.status !== 200) throw new Error('Supabase returned HTTP ' + res.status);
    const rows = Array.isArray(res.body) ? res.body : [];
    if (rows.length === 0) throw new Error('No model_event logged in last 60s — logging broken');
    return rows.length + ' event(s) logged';
  });

  // Test 5 — Auth endpoint health
  await test('Auth endpoint', async () => {
    const res = await req(BASE_URL + '/auth/google/status?userId=self_test');
    if (res.status !== 200) throw new Error('HTTP ' + res.status);
    if (typeof res.body?.connected !== 'boolean') throw new Error('Unexpected response: ' + JSON.stringify(res.body));
    return 'HTTP 200 OK';
  });

  // Test 6 — Data endpoint health
  await test('Data endpoint (chat history)', async () => {
    if (!TEST_USER_ID) throw new Error('SKIPPED — MOBIUS_TEST_USER_ID not set');
    const res = await req(BASE_URL + '/api/chat-history?userId=' + TEST_USER_ID);
    if (res.status !== 200) throw new Error('HTTP ' + res.status);
    if (!Array.isArray(res.body?.sessions)) throw new Error('Unexpected response shape');
    return 'HTTP 200 OK';
  });

  // Test 7 — Services status (at least 2 of 4 models online)
  await test('Services status (≥2 models online)', async () => {
    const res = await req(BASE_URL + '/api/services/status');
    if (res.status !== 200) throw new Error('HTTP ' + res.status);
    const models  = res.body?.models || [];
    const online  = models.filter(m => m.ok);
    const summary = models.map(m => (m.ok ? '✅' : '❌') + ' ' + m.name).join('  ');
    if (online.length < 2) throw new Error(online.length + '/4 models online — ' + summary);
    return online.length + '/4 online — ' + summary;
  });

  // ── Results ───────────────────────────────────────────────────────────────
  console.log('');
  for (const r of results) {
    const icon = r.skipped ? '  ⏭ ' : r.ok ? '  ✅' : '  ❌';
    console.log(icon + ' Test ' + (results.indexOf(r) + 1) + ' — ' + r.name);
    if (r.msg) console.log('     ' + r.msg);
  }

  console.log('\n' + '━'.repeat(54));
  const total   = results.length;
  const skipped  = results.filter(r => r.skipped).length;
  const failed   = results.filter(r => !r.ok && !r.skipped).length;
  const ran      = total - skipped;
  if (failed === 0) {
    const skipNote = skipped > 0 ? '  (' + skipped + ' skipped — set MOBIUS_TEST_USER_ID to run all)' : '';
    console.log('  ' + (ran - failed) + '/' + ran + ' passed. ✅ Mobius is healthy.' + skipNote);
  } else {
    console.log('  ' + (ran - failed) + '/' + ran + ' passed. ❌ ' + failed + ' failure(s).');
    console.log('  Review failures before proceeding.');
    console.log('  Rollback: git revert HEAD && deploy.bat');
  }
  console.log('━'.repeat(54) + '\n');

  // Log test run to knowledge table
  if (SUPABASE_URL && SUPABASE_KEY && TEST_USER_ID) {
    const now = new Date().toISOString();
    await req(
      SUPABASE_URL + '/rest/v1/knowledge',
      {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': 'Bearer ' + SUPABASE_KEY,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal'
        }
      },
      {
        user_id:    TEST_USER_ID,
        project:    'mobius',
        domain:     'management',
        type:       'test_event',
        tags:       ['self_test', failed === 0 ? 'pass' : 'fail'],
        content:    passed + '/' + total + ' tests passed on ' + new Date().toLocaleString('en-AU'),
        context:    { passed, failed, total, results: results.map(r => ({ name: r.name, ok: r.ok, msg: r.msg })) },
        created_at: now,
        updated_at: now
      }
    ).catch(() => {}); // never crash on log failure
  }

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('\n❌ Self-test crashed:', err.message);
  process.exit(1);
});
