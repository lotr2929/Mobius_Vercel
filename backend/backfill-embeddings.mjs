// backfill-embeddings.mjs
// Resumable: embeds any mobius_docs / mobius_messages rows where embedding is null.
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

const TABLES = [
  { table: 'mobius_docs', textColumn: 'chunk' },
  { table: 'mobius_messages', textColumn: 'content' },
];

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

// Retries only genuine transient errors. A 429 means the daily quota is
// exhausted — that won't clear in seconds, so retrying with backoff just
// wastes minutes per row once the cap is hit. Fails fast on 429 instead,
// same fix already applied to embedQuery() in server.js and embedText() in
// drive-indexer.mjs.
async function embedWithRetry(text, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const result = await embedGemini(text);
      if (result) return result;
    } catch (e) {
      if (/429/.test(e.message)) return 'QUOTA_EXHAUSTED';
      console.warn(`  attempt ${attempt + 1}/${retries} failed: ${e.message}`);
      if (attempt < retries - 1) await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  return null; // give up on this row after all retries; leaves embedding null for next run
}

async function getCounts(table) {
  const { count: embedded } = await supabase
    .from(table).select('id', { count: 'exact', head: true }).not('embedding', 'is', null);
  const { count: notEmbedded } = await supabase
    .from(table).select('id', { count: 'exact', head: true }).is('embedding', null);
  return { embedded: embedded ?? 0, total: (embedded ?? 0) + (notEmbedded ?? 0) };
}

const fmt = n => n.toLocaleString();

function printSummaryLine(table, embedded, total) {
  console.log(`${table.padEnd(16)} ${fmt(embedded)}/${fmt(total)}`);
}

// embeddedSoFar/total tracks the TRUE cumulative count (rows already
// embedded before this run + rows embedded during this run) — never resets
// to zero at the start of a run.
async function backfillTable(table, textColumn, embeddedSoFar, total) {
  let quotaExhausted = false;

  while (true) {
    const { data: rows, error } = await supabase
      .from(table)
      .select(`id, ${textColumn}`)
      .is('embedding', null)
      .limit(200);

    if (error) { console.error(`[${table}]`, error.message); break; }
    if (!rows || rows.length === 0) break;

    let doneThisPass = 0;
    for (const row of rows) {
      const text = row[textColumn] || '';
      if (!text.trim()) { continue; }

      const embedding = await embedWithRetry(text);
      if (embedding === 'QUOTA_EXHAUSTED') {
        quotaExhausted = true;
        break; // stop working through this batch right away — no point burning more calls
      }
      if (embedding) {
        await supabase.from(table)
          .update({ embedding, embedding_provider: 'gemini' })
          .eq('id', row.id);
        embeddedSoFar++; doneThisPass++;
      } else {
        process.stdout.write('\n');
        console.warn(`  [${table}] id=${row.id} gave up after retries — left null for next run`);
      }
      process.stdout.write(`\r  ${table.padEnd(16)} ${fmt(embeddedSoFar)}/${fmt(total)}   `);
      await new Promise(r => setTimeout(r, 200)); // pace requests, avoid hammering rate limit
    }

    if (quotaExhausted) { process.stdout.write('\n'); break; }

    // A full pass with zero successes (and no quota flag) means every
    // remaining row is genuinely bad text — refetching them again would
    // just repeat the same failures forever. Stop here.
    if (doneThisPass === 0) {
      console.log(`\n[${table}] no progress this pass — stopping (all remaining rows failed).`);
      break;
    }
  }
  return { embeddedSoFar, quotaExhausted };
}

async function main() {
  if (!GEMINI_KEY) { console.error('GEMINI_API_KEY missing from .env'); return; }

  const counts = {};
  console.log('Starting point:');
  for (const { table } of TABLES) {
    counts[table] = await getCounts(table);
    printSummaryLine(table, counts[table].embedded, counts[table].total);
  }
  console.log('');

  let quotaHit = false;
  for (const { table, textColumn } of TABLES) {
    if (quotaHit) break; // same daily quota covers all tables — don't bother attempting
    const { embedded, total } = counts[table];
    if (embedded >= total) { console.log(`[${table}] already complete.\n`); continue; }

    console.log(`=== Backfilling ${table} ===`);
    const result = await backfillTable(table, textColumn, embedded, total);
    counts[table].embedded = result.embeddedSoFar;
    if (result.quotaExhausted) quotaHit = true;
    console.log('');
  }

  console.log(quotaHit ? 'GEMINI QUOTA EXHAUSTED — stopped. Final counts:' : 'All done. Final counts:');
  for (const { table } of TABLES) {
    printSummaryLine(table, counts[table].embedded, counts[table].total);
  }
}

main();
