// pcm/embed.js — Gemini embeddings (gemini-embedding-001, 1024-dim). Gemini only:
// vectors from different providers are not comparable even at the same dimension.
import { KEYS } from '../config.js';
import { sleep } from '../util.js';

let cooldownUntil = 0; // set after a 429 so one exhausted quota doesn't stall every request

async function embedRaw(text) {
  if (!KEYS.gemini) return null;
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${KEYS.gemini}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'models/gemini-embedding-001',
        content: { parts: [{ text: text.slice(0, 8000) }] },
        outputDimensionality: 1024,
      }),
    }
  );
  if (!r.ok) throw new Error('Gemini embed HTTP ' + r.status);
  return (await r.json()).embedding?.values || null;
}

// Live request path: fail fast. A 429 means the daily quota is gone; retrying
// only blocks the user, so back off for a minute and let callers fall back to
// keyword search.
export async function embedQuery(text) {
  if (Date.now() < cooldownUntil) return null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const v = await embedRaw(text);
      if (v) return v;
    } catch (e) {
      if (/429/.test(e.message)) { cooldownUntil = Date.now() + 60000; return null; }
      console.warn(`[embed] attempt ${attempt + 1}/2 failed: ${e.message}`);
      if (attempt === 0) await sleep(1000);
    }
  }
  return null;
}

// Background / bulk path: wait out per-minute rate limits.
export async function embedPatient(text, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const v = await embedRaw(text);
      if (v) return v;
    } catch (e) {
      console.warn(`[embed] attempt ${attempt + 1}/${retries} failed: ${e.message}`);
      if (attempt < retries - 1) await sleep(/429/.test(e.message) ? 15000 * (attempt + 1) : 2000 * (attempt + 1));
    }
  }
  return null;
}
