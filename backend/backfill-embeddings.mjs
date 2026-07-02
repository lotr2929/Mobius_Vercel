// backfill-embeddings.mjs
// Resumable: embeds any mobius_docs rows where embedding is null.
// Gemini-only (no cross-provider fallback — Gemini/Mistral vectors are
// not comparable even at matching dimensions). Safe to re-run if it stops
// partway — it always picks up wherever "embedding is null" left off.
// Run with: node backend\backfill-embeddings.mjs   (from project root)

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_KEY;
const GEMINI_KEY = process.env.GEMINI_API_KEY;

const supabase = createClient(SB_URL, SB_KEY);

async function embedGemini(text) {
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${GEMINI_KEY}`,
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
  const data = await r.json();
  return data.embedding?.values || null;
}

async function embedWithRetry(text, retries = 5) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const result = await embedGemini(text);
      if (result) return result;
    } catch (e) {
      const isRateLimit = /429/.test(e.message);
      const wait = isRateLimit ? 20000 * (attempt + 1) : 3000 * (attempt + 1);
      console.warn(`  attempt ${attempt + 1}/${retries} failed: ${e.message} — waiting ${wait}ms`);
      if (attempt < retries - 1) await new Promise(r => setTimeout(r, wait));
    }
  }
  return null; // give up on this row after all retries; leaves embedding null for next run
}

async function fetchBatch(table, limit = 200) {
  const { data, error } = await supabase
    .from(table)
    .select('id, chunk:content')
    .is('embedding', null)
    .limit(limit);
  return { data, error };
}

async function backfillTable(table, textColumn) {
  let totalDone = 0, totalFailed = 0;
  while (true) {
    const { data: rows, error } = await supabase
      .from(table)
      .select(`id, ${textColumn}`)
      .is('embedding', null)
      .limit(200);

    if (error) { console.error(`[${table}]`, error.message); break; }
    if (!rows || rows.length === 0) break;

    console.log(`[${table}] batch of ${rows.length} (remaining unknown until next check)`);

    for (const row of rows) {
      const text = row[textColumn] || '';
      if (!text.trim()) { totalFailed++; continue; }

      const embedding = await embedWithRetry(text);
      if (embedding) {
        await supabase.from(table)
          .update({ embedding, embedding_provider: 'gemini' })
          .eq('id', row.id);
        totalDone++;
        if (totalDone % 25 === 0) console.log(`  [${table}] embedded so far: ${totalDone}`);
      } else {
        totalFailed++;
        console.warn(`  [${table}] id=${row.id} gave up after retries — left null for next run`);
      }
      await new Promise(r => setTimeout(r, 200)); // pace requests, avoid hammering rate limit
    }
  }
  console.log(`[${table}] done — embedded: ${totalDone}, gave up: ${totalFailed}`);
  return { totalDone, totalFailed };
}

async function main() {
  if (!GEMINI_KEY) { console.error('GEMINI_API_KEY missing from .env'); return; }

  console.log('=== Backfilling mobius_docs ===');
  await backfillTable('mobius_docs', 'chunk');

  console.log('\n=== Backfilling mobius_messages ===');
  await backfillTable('mobius_messages', 'content');

  console.log('\nAll done.');
}

main();
