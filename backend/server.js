// Mobius — backend server
// Single conversational AI with memory, web search, and document recall
// Port 3005
//
// ── ARCHITECTURE MAP (read this before touching retrieval logic) ───────────
//
// Supabase tables (shared "dlbs" project, mobius_-prefixed):
//   mobius_messages   — every chat turn, raw. role/content/embedding/fts.
//   mobius_docs       — chunked text (500-600 chars, ~100 overlap) + embedding.
//                        Written two ways: saveDoc() below (direct upload,
//                        500-char chunks) and drive-indexer.mjs's syncDrive()
//                        (Drive sync, 600-char chunks). Same table, two
//                        producers, deliberately different chunk sizes —
//                        not a bug, just two paths that were never unified.
//   mobius_docs_full  — one row per file, whole raw text. This is what gets
//                        returned when a document is referenced by name
//                        (mode 2 below), so retrieval doesn't have to
//                        reassemble it from overlapping chunks.
//   mobius_topics     — RAKE-extracted keyphrases, one row per phrase, each
//                        pointing back to a source_table+source_id. No AI
//                        involved — pure text processing, always available
//                        regardless of Gemini quota.
//
// THREE-TIER RETRIEVAL (searchDocs / searchMessages, same pattern in both):
//   Tier 1 — semantic: embed the query, cosine-match against stored vectors
//            via match_mobius_docs/match_mobius_messages (pgvector RPCs).
//            Best quality, but Gemini's free-tier daily quota kills this
//            for the rest of the day once exhausted.
//   Tier 2 — keyword: Postgres full-text search (the `fts` generated
//            column + GIN index). Free, exact-ish word matching, no quota.
//   Tier 3 — topic: match query words against mobius_topics phrases via
//            searchTopics(). Coarsest, but catches vague queries ("these
//            documents") that have no distinctive words for tier 2 to grab.
//   Each tier only runs if the one before it returned nothing.
//
// THREE DOCUMENT-CONTEXT MODES per /api/chat request (see step 3 below):
//   Mode 1 — files attached to THIS message (req.body.docs) — full raw
//            text injected, no search needed, always wins if present.
//   Mode 2 — query names a specific archived file (findNamedDoc) — that
//            file's full text pulled from mobius_docs_full.
//   Mode 3 — neither of the above — three-tier chunk search (searchDocs)
//            against mobius_docs, returns only matching snippets.
//   If none of the three produce anything AND the message sounds like it
//   expects a file, the model is told explicitly to say so rather than
//   guess (see the fallback message right after mode 3).
//
// CHAT HISTORY — two separate mechanisms, not one:
//   - getHistory(60): the last 30 exchanges, sent in full, every request,
//     unconditionally. This is NOT search — it's just a fixed window.
//   - searchMessages(): a targeted three-tier search (above) for anything
//     OLDER than that window, run fresh every request against the
//     resolved query. Appended separately as "[Relevant past discussion]".
//
// EMBEDDING — always Gemini only (embedQuery/embedGemini). No cross-provider
// fallback: a Gemini vector and a Mistral vector at the same dimension are
// still not comparable, which was the root cause of a real outage earlier
// in this project. On a 429 (daily quota, not per-minute), embedQuery fails
// fast — retrying would just block the request until Vercel's timeout kills
// it, since quota doesn't clear in seconds.
// ─────────────────────────────────────────────────────────────────────────

import 'dotenv/config';
import express    from 'express';
import cors       from 'cors';
import path       from 'path';
import fs         from 'fs';
import { fileURLToPath } from 'url';
import { createClient }  from '@supabase/supabase-js';
import multer  from 'multer';
import { syncDrive, uploadToDrive, backfillFullDocs, getDriveClient, listFiles, extractText, DRIVE_FOLDER_ID } from './drive-indexer.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app  = express();
const PORT = process.env.PORT || 3005;
const START_TIME = Date.now();

// ── Keys ─────────────────────────────────────────────────────────────────────
const GEMINI_KEY   = process.env.GEMINI_API_KEY  || '';
const GROQ_KEY     = process.env.GROQ_API_KEY    || '';
const MISTRAL_KEY  = process.env.MISTRAL_API_KEY || '';
const CEREBRAS_KEY = process.env.CEREBRAS_API_KEY || '';
const TAVILY_KEY   = process.env.TAVILY_API_KEY  || '';
const SB_URL       = process.env.SUPABASE_URL    || '';
const SB_KEY       = process.env.SUPABASE_KEY    || '';
// Drive credentials: on Vercel there's no local file, so load from the
// GOOGLE_SERVICE_ACCOUNT_JSON env var (the service account JSON as one
// line). Locally, fall back to the gitignored file on disk.
function loadDriveCredentials() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    try { return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON); }
    catch (e) { console.warn('[drive] GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON:', e.message); return null; }
  }
  const localPath = path.join(__dirname, '../google-service-account.json');
  return fs.existsSync(localPath) ? localPath : null;
}
const GDRIVE_KEY = loadDriveCredentials(); // string path (local) or parsed object (Vercel), or null

// ── Supabase ──────────────────────────────────────────────────────────────────
const supabase = (SB_URL && SB_KEY) ? createClient(SB_URL, SB_KEY) : null;
if (!supabase) console.warn('[Mobius] No Supabase — running in local-only mode');

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, '../frontend')));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// ── System prompt ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are Mobius, a personal AI assistant for Boon Lay Ong (architect, Senior Lecturer at Curtin University Perth, inventor of Green Plot Ratio). You have access to the full conversation history and any documents Boon has uploaded.

Your purpose is simple: be the best thinking partner Boon has ever had. You follow his meandering thoughts, remember everything he tells you, connect ideas across conversations, and search the web when you need current information.

Behaviour:
- Always read the conversation history before responding — never ask for context already provided
- If a question requires current information, use web search
- If a question relates to uploaded documents, search them
- Be direct, concise, and intellectually honest
- Use British English
- Never pad responses with unnecessary preamble`;

// ── AI Cascade ────────────────────────────────────────────────────────────────
// Each provider streams tokens via SSE. Returns an async generator of token strings.

async function* streamGemini(messages, signal) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse&key=${GEMINI_KEY}`;
  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }]
  }));
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents, systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] }, generationConfig: { maxOutputTokens: 8192 } }),
    signal
  });
  if (!r.ok) { const e = await r.text(); throw new Error('Gemini HTTP ' + r.status + ': ' + e.slice(0,200)); }
  const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6).trim(); if (raw === '[DONE]') return;
      try {
        const obj = JSON.parse(raw);
        const token = obj.candidates?.[0]?.content?.parts?.[0]?.text;
        if (token) yield token;
      } catch {}
    }
  }
}

async function* streamGroq(messages, signal) {
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + GROQ_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages], stream: true, max_tokens: 8192 }),
    signal
  });
  if (!r.ok) { const e = await r.text(); throw new Error('Groq HTTP ' + r.status + ': ' + e.slice(0,200)); }
  yield* streamOpenAICompat(r);
}

async function* streamMistral(messages, signal) {
  const r = await fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + MISTRAL_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'mistral-small-latest', messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages], stream: true, max_tokens: 8192 }),
    signal
  });
  if (!r.ok) { const e = await r.text(); throw new Error('Mistral HTTP ' + r.status + ': ' + e.slice(0,200)); }
  yield* streamOpenAICompat(r);
}

async function* streamCerebras(messages, signal) {
  const r = await fetch('https://api.cerebras.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + CEREBRAS_KEY, 'Content-Type': 'application/json' },
    // gpt-oss-120b: llama-3.3-70b was deprecated on Cerebras's free tier; this is
    // the current larger production model there. Free tier has an 8K context cap.
    body: JSON.stringify({ model: 'gpt-oss-120b', messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages], stream: true, max_tokens: 4096 }),
    signal
  });
  if (!r.ok) { const e = await r.text(); throw new Error('Cerebras HTTP ' + r.status + ': ' + e.slice(0,200)); }
  yield* streamOpenAICompat(r);
}

async function* streamOpenAICompat(r) {
  const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop();
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6).trim(); if (raw === '[DONE]') return;
      try { const token = JSON.parse(raw).choices?.[0]?.delta?.content; if (token) yield token; } catch {}
    }
  }
}

// Main team: Gemini, Mistral, Cerebras — all genuinely free (no card required).
// Groq kept as fallback only, since its free-tier daily cap (1,000 req/day on
// 70B-class models) is tighter than the other three.
const CASCADE = [
  { key: 'gemini',   name: 'gemini-2.5-flash',     fn: streamGemini,   available: () => !!GEMINI_KEY },
  { key: 'mistral',  name: 'mistral-small',        fn: streamMistral,  available: () => !!MISTRAL_KEY },
  { key: 'cerebras', name: 'gpt-oss-120b (cerebras)', fn: streamCerebras, available: () => !!CEREBRAS_KEY },
  { key: 'groq',     name: 'llama-3.3-70b (groq)', fn: streamGroq,     available: () => !!GROQ_KEY },
];

// "Ask: Mistral" / "Ask Groq:" / "ask gemini" at the start of a message forces
// that one model, skipping the rest of the cascade, so the person can get a
// second opinion on demand instead of whatever the cascade would pick.
function parseAskPrefix(query) {
  const m = query.match(/^ask:?\s*(gemini|groq|mistral|cerebras)\s*:?\s*/i);
  if (!m) return { forceProvider: null, cleanQuery: query };
  return { forceProvider: m[1].toLowerCase(), cleanQuery: query.slice(m[0].length).trim() };
}

async function* runCascade(messages, signal, forceProvider) {
  const providers = forceProvider ? CASCADE.filter(p => p.key === forceProvider) : CASCADE;
  if (forceProvider && !providers.length) {
    yield { event: 'error:unknown-model:' + forceProvider };
    return;
  }
  for (const provider of providers) {
    if (!provider.available()) {
      if (forceProvider) yield { event: 'error:not-configured:' + provider.name };
      continue;
    }
    try {
      yield { event: 'model:' + provider.name };
      yield* provider.fn(messages, signal);
      return;
    } catch (e) {
      console.warn(`[cascade] ${provider.name} failed: ${e.message} — trying next`);
      yield { event: 'fallback:' + provider.name + ':' + e.message.slice(0,80) };
      if (forceProvider) return; // explicit request for one model shouldn't silently fall through
    }
  }
  throw new Error('All cascade providers failed');
}

// ── Tavily web search ─────────────────────────────────────────────────────────
async function tavilySearch(query) {
  if (!TAVILY_KEY) return null;
  try {
    const r = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + TAVILY_KEY },
      body: JSON.stringify({ query, max_results: 5, search_depth: 'advanced', include_answer: true }),
      signal: AbortSignal.timeout(15000)
    });
    if (!r.ok) return null;
    const data = await r.json();
    const lines = ['[Web search results for: ' + query + ']'];
    if (data.answer) lines.push('Summary: ' + data.answer);
    for (const h of (data.results || []).slice(0, 5)) {
      lines.push('\n• ' + h.title + ' — ' + h.url);
      if (h.content) lines.push('  ' + h.content.slice(0, 300));
    }
    return lines.join('\n');
  } catch { return null; }
}

// ── Query preprocessing — resolve references against recent history ─────────
async function resolveQuery(userQuery, history) {
  const recent = history.slice(-6);
  if (!recent.length) return userQuery;
  const prompt = `Conversation so far:\n${recent.map(m => `${m.role}: ${m.content}`).join('\n')}\n\nLatest message: "${userQuery}"\n\nRewrite the latest message as a standalone, self-contained query that makes sense without the conversation above. Resolve any pronouns or vague references (it, that, this, the file, etc.) using the conversation context. If the latest message is already standalone, return it unchanged. Reply with ONLY the rewritten query, nothing else.`;
  try {
    let out = '';
    for await (const chunk of runCascade([{ role: 'user', content: prompt }], AbortSignal.timeout(8000))) {
      if (typeof chunk === 'string') out += chunk;
    }
    out = out.trim();
    return out || userQuery;
  } catch {
    return userQuery;
  }
}

// ── Needs-search detection ────────────────────────────────────────────────────
function needsSearch(query) {
  const q = query.toLowerCase();
  const signals = [
    /\b(latest|current|recent|today|now|2025|2026|this year|this week)\b/,
    /\b(news|price|weather|stock|rate|score|result|update|release)\b/,
    /\bwho is\b|\bwhat is\b|\bwhen did\b|\bwhere is\b/,
    /\b(search|look up|find out|check)\b/,
  ];
  return signals.some(r => r.test(q));
}

// ── History (Supabase + local fallback) ───────────────────────────────────────
// Messages stored as: { role, content, created_at }
// Each user+assistant pair = one exchange

// The "always included" half of chat memory — a fixed recency window, sent
// in full, every request, no filtering. See searchMessages() below for the
// other half (targeted search for anything older than this window).
async function getHistory(limit = 60) {
  if (supabase) {
    const { data, error } = await supabase
      .from('mobius_messages')
      .select('role, content, created_at, ai_provider, docs')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (!error && data) return data.reverse();
  }
  return [];
}

async function saveMessage(role, content, opts = {}) {
  if (supabase) {
    const embedding = await embedQuery(content);
    await supabase.from('mobius_messages').insert({
      role, content, embedding,
      embedding_provider: embedding ? 'gemini' : null,
      ai_provider: opts.model || null,
      docs: opts.docs && opts.docs.length ? opts.docs : null,
      created_at: new Date().toISOString(),
    });
  }
}

// Book-index-style fallback: matches query words against RAKE-extracted
// topic phrases (mobius_topics), no embedding or exact-phrase FTS required.
// Coarser than both, but works even when a query has no distinctive
// tsvector-matchable phrasing (e.g. "these documents", "5 more files").
async function searchTopics(query, sourceTable, limit = 5) {
  if (!supabase) return [];
  const words = (query.toLowerCase().match(/[a-z0-9]{3,}/g) || []).slice(0, 6);
  if (!words.length) return [];
  const orExpr = words.map(w => `term.ilike.%${w}%`).join(',');
  const { data, error } = await supabase
    .from('mobius_topics')
    .select('source_id, score')
    .eq('source_table', sourceTable)
    .or(orExpr)
    .order('score', { ascending: false })
    .limit(limit * 4);
  if (error || !data?.length) return [];
  const seen = new Set(); const ids = [];
  for (const row of data) {
    if (seen.has(row.source_id)) continue;
    seen.add(row.source_id); ids.push(row.source_id);
    if (ids.length >= limit) break;
  }
  return ids;
}

// The "targeted search" half of chat memory — anything older than
// getHistory()'s window, found fresh each request. Three-tier fallback,
// same shape as searchDocs() below.
async function searchMessages(query) {
  if (!supabase) return [];
  // Tier 1: semantic
  const queryEmbedding = await embedQuery(query);
  if (queryEmbedding) {
    const { data, error } = await supabase.rpc('match_mobius_messages', {
      query_embedding: queryEmbedding,
      match_count: 8,
      match_threshold: 0.5,
    });
    if (!error && data?.length) return data;
  }
  // Tier 2: keyword (mobius_messages.fts)
  const { data: ftsData } = await supabase
    .from('mobius_messages')
    .select('id, role, content, created_at')
    .textSearch('content', query.split(' ').join(' & '), { type: 'plain' })
    .limit(8);
  if (ftsData?.length) return ftsData;

  // Tier 3: topic phrase match
  const topicIds = await searchTopics(query, 'mobius_messages', 8);
  if (topicIds.length) {
    const { data: topicData } = await supabase
      .from('mobius_messages')
      .select('id, role, content, created_at')
      .in('id', topicIds);
    if (topicData?.length) return topicData;
  }
  return [];
}

// ── Document store — three-tier search, same pattern as searchMessages() ────
// ── Embedding — Gemini only, 1024-dim. No cross-provider fallback; see the
// note on embedQuery() below for why. ───────────────────────────────────────
async function embedGemini(text) {
  if (!GEMINI_KEY) return null;
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

// Gemini-only — no cross-provider fallback (Gemini/Mistral vectors are not
// comparable even at matching dimensions, which was the root cause of the
// retrieval breakage). Used on the LIVE request path (chat, upload, search),
// so this must fail fast: a 429 means the daily quota is exhausted and won't
// clear in seconds, so retrying just blocks the user's request until Vercel's
// function timeout kills it. Only retry once, briefly, for genuine transient
// errors (not quota).
async function embedQuery(text) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await embedGemini(text);
      if (result) return result;
    } catch (e) {
      if (/429/.test(e.message)) {
        console.warn('[embed] gemini quota exhausted — skipping embedding for this request');
        return null; // fail fast, don't retry a daily quota error
      }
      console.warn(`[embed] gemini-embedding-001 failed (attempt ${attempt + 1}/2): ${e.message}`);
      if (attempt === 0) await new Promise(r => setTimeout(r, 1000));
    }
  }
  return null;
}

async function searchDocs(query) {
  if (!supabase) return '';
  // Tier 1: semantic
  const queryEmbedding = await embedQuery(query);
  if (!queryEmbedding) {
    // Tier 2: keyword (mobius_docs.fts)
    const { data } = await supabase
      .from('mobius_docs')
      .select('filename, chunk')
      .textSearch('chunk', query.split(' ').join(' & '), { type: 'plain' })
      .limit(5);
    if (data?.length) return data.map(d => `[${d.filename}]: ${d.chunk}`).join('\n\n');

    // Tier 3: topic phrase match
    const topicIds = await searchTopics(query, 'mobius_docs', 5);
    if (topicIds.length) {
      const { data: topicData } = await supabase
        .from('mobius_docs')
        .select('filename, chunk')
        .in('id', topicIds);
      if (topicData?.length) return topicData.map(d => `[${d.filename}]: ${d.chunk}`).join('\n\n');
    }
    return '';
  }
  const { data, error } = await supabase.rpc('match_mobius_docs', {
    query_embedding: queryEmbedding,
    match_count: 5,
    match_threshold: 0.5,
  });
  if (error || !data?.length) return '';
  return data.map(d => `[${d.filename}]: ${d.chunk}`).join('\n\n');
}

// Direct-upload ingestion path (500-char chunks, 100 overlap) — the OTHER
// producer of mobius_docs rows besides drive-indexer.mjs's syncDrive()
// (which uses 600-char chunks for Drive files). Called from
// /api/docs/upload, below. Embeds synchronously per chunk on the way in;
// chunks still get inserted even if embedding fails (embedding: null).
async function saveDoc(filename, text) {
  if (!supabase) return;
  // Full raw text, stored once per filename — this is what gets returned
  // when the paper is referenced by name later (mode 2), not the chunks.
  await supabase.from('mobius_docs_full').upsert({ filename, content: text, updated_at: new Date().toISOString() });

  const chunks = [];
  const size = 500; const overlap = 100;
  for (let i = 0; i < text.length; i += size - overlap) {
    chunks.push(text.slice(i, i + size));
  }
  const rows = [];
  for (const chunk of chunks) {
    const embedding = await embedQuery(chunk);
    rows.push({ filename, chunk, embedding, embedding_provider: embedding ? 'gemini' : null, created_at: new Date().toISOString() });
  }
  await supabase.from('mobius_docs').insert(rows);
}

// Does the query name a specific archived document? Simple heuristic: strip
// extension/punctuation from each known filename and check if a meaningful
// chunk of it appears in the query text. Used to decide mode 3 (retrieve the
// whole document) vs mode 2 (topic-based chunk search).
async function findNamedDoc(query) {
  if (!supabase) return null;
  const { data } = await supabase.from('mobius_docs_full').select('filename');
  if (!data?.length) return null;
  const q = query.toLowerCase();
  for (const { filename } of data) {
    const stem = filename.replace(/\.(pdf|txt|md|docx?|csv|json|js|py)$/i, '')
      .replace(/[_-]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
    if (stem.length > 6 && q.includes(stem)) return filename;
    // also try a looser match: most of the significant words present, in order
    const words = stem.split(' ').filter(w => w.length > 3);
    if (words.length >= 2 && words.every(w => q.includes(w))) return filename;
  }
  return null;
}

async function getFullDoc(filename) {
  if (!supabase) return null;
  const { data } = await supabase.from('mobius_docs_full').select('content').eq('filename', filename).maybeSingle();
  return data?.content || null;
}

// Cerebras's free tier caps context at 8K tokens total (system + history +
// injected doc + response), so any raw document injected into the prompt
// needs a hard ceiling regardless of which provider ends up serving this
// request — otherwise a big paper silently breaks whichever model is picked.
const MAX_DOC_INJECT_CHARS = 20000;
function capText(text) {
  if (text.length <= MAX_DOC_INJECT_CHARS) return text;
  return text.slice(0, MAX_DOC_INJECT_CHARS) + '\n\n[...truncated — document is longer than fits in this context window...]';
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Status
app.get('/api/status', (req, res) => {
  res.json({
    ok: true,
    startTime: START_TIME,
    supabase: !!supabase,
    cascade: CASCADE.filter(p => p.available()).map(p => p.name)
  });
});

// History for UI
app.get('/api/history', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const messages = await getHistory(limit);
    res.json({ messages });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Main chat endpoint — streams SSE
app.post('/api/chat', async (req, res) => {
  const { messages: clientMessages, query } = req.body;
  const rawQuery = query || clientMessages?.slice(-1)[0]?.content || '';
  if (!rawQuery) return res.status(400).json({ error: 'No query' });
  const { forceProvider, cleanQuery } = parseAskPrefix(rawQuery);
  const userQuery = cleanQuery || rawQuery; // if someone just types "Ask: Mistral" alone, don't blank the query

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const send = obj => res.write('data: ' + JSON.stringify(obj) + '\n\n');

  try {
    // 1. Load history from Supabase
    const history = await getHistory(60);

    // 1b. Resolve query against recent history (fixes "it"/"that" references)
    const resolvedQuery = await resolveQuery(userQuery, history);

    // 2. Web search if needed
    let searchContext = '';
    if (needsSearch(resolvedQuery) && TAVILY_KEY) {
      send({ event: 'searching web...' });
      const result = await tavilySearch(resolvedQuery);
      if (result) searchContext = result;
    }

    // 3. Document context — three modes, in priority order:
    //    (1) just-attached files this turn -> raw full text, no search needed
    //    (2) query names a specific archived paper -> retrieve that whole doc
    //    (3) query references a topic, no paper named -> chunk-based semantic search
    let docContext = '';
    const attachedDocs = Array.isArray(req.body.docs) ? req.body.docs.filter(d => d?.text) : [];
    if (attachedDocs.length) {
      docContext = '\n\n[Attached document(s) — full text — CONFIRM RECEIPT: start your reply by explicitly listing these exact filenames as received before addressing the user\'s message]\n' +
        attachedDocs.map(d => `--- ${d.filename} ---\n${capText(d.text)}`).join('\n\n');
    } else {
      const namedFile = await findNamedDoc(resolvedQuery);
      if (namedFile) {
        const fullText = await getFullDoc(namedFile);
        if (fullText) docContext = `\n\n[Archived document: ${namedFile} — full text]\n` + capText(fullText);
      } else {
        const docResult = await searchDocs(resolvedQuery);
        if (docResult) docContext = '\n\n[Relevant documents]\n' + docResult;
      }
      // Nothing attached this turn AND search/named-lookup found nothing —
      // if the message reads like it expects files, say so plainly instead
      // of letting the model guess or hallucinate receipt.
      if (!docContext && /\b(file|document|paper|upload|attach)/i.test(userQuery)) {
        docContext = '\n\n[No documents were attached to this message, and no matching document was found by search either. Tell the user plainly that nothing was received with THIS message and ask them to re-attach.]';
      }
    }

    // 3b. Older relevant chat history beyond the recency window
    const recentIds = new Set(history.map(m => m.created_at));
    const relevantMsgs = await searchMessages(resolvedQuery);
    const olderRelevant = relevantMsgs.filter(m => !recentIds.has(m.created_at));
    if (olderRelevant.length) {
      docContext += '\n\n[Relevant past discussion]\n' +
        olderRelevant.map(m => `${m.role}: ${m.content}`).join('\n\n');
    }

    // 4. Build messages for AI (strip UI-only fields like ai_provider/docs —
    //    providers reject message objects with unexpected keys)
    const messages = [
      ...history.map(m => ({ role: m.role, content: m.content })),
      ...(searchContext || docContext ? [{
        role: 'user',
        content: `[Context for your response]\n${searchContext}${docContext}\n\n[User message]\n${userQuery}`
      }] : [{
        role: 'user',
        content: userQuery
      }])
    ];

    // 5. Save user message to history (with filenames of anything attached this turn)
    await saveMessage('user', userQuery, { docs: attachedDocs.map(d => d.filename) });

    // 6. Stream response
    let full = '';
    let usedModel = '';
    const controller = new AbortController();
    req.on('close', () => controller.abort());

    for await (const chunk of runCascade(messages, controller.signal, forceProvider)) {
      if (typeof chunk === 'string') {
        full += chunk;
        send({ token: chunk });
      } else if (chunk.event) {
        if (chunk.event.startsWith('model:')) usedModel = chunk.event.slice(6);
        send({ event: chunk.event });
      }
    }

    // 7. Save assistant response (with which model actually answered)
    await saveMessage('assistant', full, { model: usedModel });

    res.write('data: [DONE]\n\n');
    res.end();

    // 8. Quietly top up any backlog of un-embedded older messages (non-blocking)
    backfillMessageEmbeddings(3).catch(() => {});

  } catch (e) {
    console.error('[chat]', e.message);
    send({ error: e.message });
    res.write('data: [DONE]\n\n');
    res.end();
  }
});

// Document upload
app.post('/api/docs/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  try {
    const filename = req.file.originalname;
    let text = '';
    if (req.file.mimetype === 'text/plain' || filename.endsWith('.md')) {
      text = req.file.buffer.toString('utf8');
    } else if (filename.endsWith('.pdf')) {
      const pdfParse = (await import('pdf-parse')).default;
      const data = await pdfParse(req.file.buffer);
      text = data.text;
    } else if (filename.endsWith('.docx')) {
      const mammoth = (await import('mammoth')).default;
      const data = await mammoth.extractRawText({ buffer: req.file.buffer });
      text = data.value;
    } else {
      text = req.file.buffer.toString('utf8');
    }
    await saveDoc(filename, text);

    // Also push the original file into the Mobius Drive folder
    let driveResult = null;
    if (!!GDRIVE_KEY) {
      try {
        driveResult = await uploadToDrive(GDRIVE_KEY, req.file.buffer, filename, req.file.mimetype);
      } catch (e) {
        console.warn('[upload] Drive push failed:', e.message);
      }
    }

    res.json({ ok: true, filename, chars: text.length, text, drive: driveResult });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Browse the Mobius Drive folder — lists files via the existing service
// account (no separate OAuth/Picker setup needed). Frontend shows this as
// a pickable list; selecting a file calls /api/drive/import below.
app.get('/api/drive/browse', async (req, res) => {
  if (!GDRIVE_KEY) return res.status(400).json({ error: 'Drive not configured' });
  try {
    const drive = getDriveClient(GDRIVE_KEY);
    const files = await listFiles(drive, DRIVE_FOLDER_ID);
    res.json({ ok: true, files: files.map(f => ({ id: f.id, name: f.path, mimeType: f.mimeType, modifiedTime: f.modifiedTime })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Import one file chosen from the Drive browse list — downloads the whole
// file, extracts text (same extractText() used by the background sync),
// and saves it via saveDoc() so it behaves exactly like a device upload
// (attached to the next message + queued for indexing).
app.post('/api/drive/import', async (req, res) => {
  if (!GDRIVE_KEY) return res.status(400).json({ error: 'Drive not configured' });
  const { fileId, filename } = req.body || {};
  if (!fileId) return res.status(400).json({ error: 'No fileId' });
  try {
    const drive = getDriveClient(GDRIVE_KEY);
    const text = await extractText(drive, { id: fileId, mimeType: req.body.mimeType });
    await saveDoc(filename, text);
    res.json({ ok: true, filename, chars: text.length, text });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// List documents — reads from mobius_docs_full (one row per file, so this
// can't silently truncate the way querying mobius_docs's chunks did) and
// attaches an embedding-completeness count per file so the UI can show
// which files are actually searchable yet vs still pending.
app.get('/api/docs', async (req, res) => {
  if (!supabase) return res.json({ docs: [] });
  const { data: files } = await supabase
    .from('mobius_docs_full')
    .select('filename, updated_at')
    .order('updated_at', { ascending: false });
  if (!files?.length) return res.json({ docs: [] });

  const { data: chunkStats } = await supabase
    .from('mobius_docs')
    .select('filename, embedding_provider')
    .in('filename', files.map(f => f.filename));
  const statsByFile = {};
  for (const row of chunkStats || []) {
    const s = statsByFile[row.filename] || (statsByFile[row.filename] = { total: 0, embedded: 0 });
    s.total++;
    if (row.embedding_provider) s.embedded++;
  }

  const docs = files.map(f => ({
    filename: f.filename,
    created_at: f.updated_at,
    chunks: statsByFile[f.filename]?.total || 0,
    embedded: statsByFile[f.filename]?.embedded || 0,
  }));
  res.json({ docs });
});

// Delete document
app.delete('/api/docs/:filename', async (req, res) => {
  if (!supabase) return res.json({ ok: false });
  const filename = decodeURIComponent(req.params.filename);
  await supabase.from('mobius_docs').delete().eq('filename', filename);
  await supabase.from('mobius_docs_full').delete().eq('filename', filename);
  res.json({ ok: true });
});

// ── Google Drive sync ─────────────────────────────────────────────────────────
let syncRunning = false;

app.post('/api/drive/sync', async (req, res) => {
  if (syncRunning) return res.json({ ok: false, message: 'Sync already running' });
  if (!supabase) return res.json({ ok: false, message: 'No Supabase connection' });
  if (!!!GDRIVE_KEY) return res.json({ ok: false, message: 'Service account key not found' });
  syncRunning = true;
  res.json({ ok: true, message: 'Sync started' });
  try {
    const result = await syncDrive(GDRIVE_KEY, SB_URL, SB_KEY, GEMINI_KEY);
    console.log('[drive] Sync result:', result);
  } catch (e) {
    console.error('[drive] Sync error:', e.message);
  } finally { syncRunning = false; }
});

// One-time backfill for the mobius_docs_full table (pre-existing Drive
// files that were chunked before that table existed). Text extraction only,
// no embedding calls — safe to run regardless of Gemini quota state.
async function handleBackfillFull(req, res) {
  if (!supabase) return res.json({ ok: false, message: 'No Supabase connection' });
  if (!GDRIVE_KEY) return res.json({ ok: false, message: 'Service account key not found' });
  try {
    const result = await backfillFullDocs(GDRIVE_KEY, SB_URL, SB_KEY);
    res.json({ ok: true, ...result });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
}
app.post('/api/drive/backfill-full', handleBackfillFull);
app.get('/api/drive/backfill-full', handleBackfillFull); // GET too, so it can be triggered by just visiting the URL

app.get('/api/drive/status', (req, res) => {
  res.json({ running: syncRunning, keyExists: !!GDRIVE_KEY });
});

// ── Daily cron (Vercel Hobby: once/day max) ───────────────────────────────────
// Syncs Drive for new/changed files, and tops up any un-embedded chat
// messages. Bulk doc backfill after a purge is still run locally via
// backend\backfill-embeddings.mjs — this route just keeps steady-state
// memory current once that's caught up.
app.get('/api/cron/sync', async (req, res) => {
  if (process.env.CRON_SECRET) {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ ok: false, message: 'unauthorized' });
    }
  }
  if (!supabase) return res.json({ ok: false, message: 'no Supabase connection' });

  const result = {};
  try {
    if (!!GDRIVE_KEY && !syncRunning) {
      syncRunning = true;
      result.drive = await syncDrive(GDRIVE_KEY, SB_URL, SB_KEY, GEMINI_KEY);
      syncRunning = false;
    } else {
      result.drive = { skipped: true, reason: syncRunning ? 'already running' : 'no key' };
    }
  } catch (e) {
    syncRunning = false;
    result.driveError = e.message;
  }

  try {
    result.messages = await backfillMessageEmbeddings(20);
  } catch (e) {
    result.messagesError = e.message;
  }

  res.json({ ok: true, ...result });
});

// ── Auto-sync every 6 hours ───────────────────────────────────────────────────
async function backfillMessageEmbeddings(limit = 3) {
  if (!supabase) return { embedded: 0, failed: 0 };
  const { data: rows, error } = await supabase
    .from('mobius_messages')
    .select('id, content')
    .is('embedding', null)
    .limit(limit);
  if (error || !rows?.length) return { embedded: 0, failed: 0 };

  let embedded = 0, failed = 0;
  for (const row of rows) {
    try {
      const embedding = await embedQuery(row.content || '');
      if (!embedding) { failed++; continue; }
      await supabase.from('mobius_messages').update({ embedding, embedding_provider: 'gemini' }).eq('id', row.id);
      embedded++;
    } catch {
      failed++;
    }
  }
  return { embedded, failed };
}

async function autoSync() {
  if (!supabase || !!!GDRIVE_KEY || syncRunning) return;
  syncRunning = true;
  try {
    const result = await syncDrive(GDRIVE_KEY, SB_URL, SB_KEY, GEMINI_KEY);
    console.log('[drive] Auto-sync:', result);
  } catch (e) {
    console.error('[drive] Auto-sync error:', e.message);
  } finally { syncRunning = false; }
}

// Serve index.html for all other routes (PWA)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// Local dev only — on Vercel the app is invoked per-request via the
// exported handler below; app.listen()/setInterval() timers do not
// persist between serverless invocations, so autoSync there runs via
// the /api/cron/sync route (see vercel.json "crons") instead.
if (process.env.VERCEL !== '1') {
  app.listen(PORT, async () => {
    console.log(`\nMobius v1.0 → http://localhost:${PORT}`);
    console.log(`Supabase  : ${supabase ? 'connected' : 'offline (local mode)'}`);
    console.log(`AI cascade: ${CASCADE.filter(p=>p.available()).map(p=>p.name).join(' → ') || 'none configured'}`);
    console.log(`Tavily    : ${TAVILY_KEY ? 'enabled' : 'disabled'}`);
    console.log(`Drive key : ${!!GDRIVE_KEY ? 'found' : 'NOT FOUND'}`);
    // Initial sync on startup, then every 6 hours (local dev only)
    setTimeout(autoSync, 10000);
    setInterval(autoSync, 6 * 60 * 60 * 1000);
  });
}

export default app;
