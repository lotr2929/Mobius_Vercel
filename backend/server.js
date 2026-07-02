// Mobius — backend server
// Single conversational AI with memory, web search, and document recall
// Port 3005

import 'dotenv/config';
import express    from 'express';
import cors       from 'cors';
import path       from 'path';
import fs         from 'fs';
import { fileURLToPath } from 'url';
import { createClient }  from '@supabase/supabase-js';
import multer  from 'multer';
import crypto  from 'crypto';
import { syncDrive, uploadToDrive } from './drive-indexer.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app  = express();
const PORT = process.env.PORT || 3005;
const START_TIME = Date.now();

// ── Keys ─────────────────────────────────────────────────────────────────────
const GEMINI_KEY   = process.env.GEMINI_API_KEY  || '';
const GROQ_KEY     = process.env.GROQ_API_KEY    || '';
const MISTRAL_KEY  = process.env.MISTRAL_API_KEY || '';
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

const CASCADE = [
  { name: 'gemini-2.5-flash',       fn: streamGemini,  available: () => !!GEMINI_KEY },
  { name: 'llama-3.3-70b (groq)',   fn: streamGroq,    available: () => !!GROQ_KEY   },
  { name: 'mistral-small',          fn: streamMistral, available: () => !!MISTRAL_KEY },
];

async function* runCascade(messages, signal) {
  for (const provider of CASCADE) {
    if (!provider.available()) continue;
    try {
      yield { event: 'model:' + provider.name };
      yield* provider.fn(messages, signal);
      return;
    } catch (e) {
      console.warn(`[cascade] ${provider.name} failed: ${e.message} — trying next`);
      yield { event: 'fallback:' + provider.name + ':' + e.message.slice(0,80) };
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

async function getHistory(limit = 60) {
  if (supabase) {
    const { data, error } = await supabase
      .from('mobius_messages')
      .select('role, content, created_at')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (!error && data) return data.reverse();
  }
  return [];
}

async function saveMessage(role, content) {
  if (supabase) {
    const embedding = await embedQuery(content);
    await supabase.from('mobius_messages').insert({
      role, content, embedding,
      embedding_provider: embedding ? 'gemini' : null,
      created_at: new Date().toISOString(),
    });
  }
}

async function searchMessages(query) {
  if (!supabase) return [];
  const queryEmbedding = await embedQuery(query);
  if (!queryEmbedding) return [];
  const { data, error } = await supabase.rpc('match_mobius_messages', {
    query_embedding: queryEmbedding,
    match_count: 8,
    match_threshold: 0.5,
  });
  if (error || !data?.length) return [];
  return data;
}

// ── Document store (semantic search via embeddings) ──────────────────────────
// ── Embedding cascade — Gemini first, Mistral fallback on failure/429 ───────
// Both pinned to 1024-dim so vectors are interchangeable in the same column.
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
  const queryEmbedding = await embedQuery(query);
  if (!queryEmbedding) {
    // fallback to keyword search if embedding fails
    const { data, error } = await supabase
      .from('mobius_docs')
      .select('filename, chunk')
      .textSearch('chunk', query.split(' ').join(' & '), { type: 'plain' })
      .limit(5);
    if (error || !data?.length) return '';
    return data.map(d => `[${d.filename}]: ${d.chunk}`).join('\n\n');
  }
  const { data, error } = await supabase.rpc('match_mobius_docs', {
    query_embedding: queryEmbedding,
    match_count: 5,
    match_threshold: 0.5,
  });
  if (error || !data?.length) return '';
  return data.map(d => `[${d.filename}]: ${d.chunk}`).join('\n\n');
}

async function saveDoc(filename, text) {
  if (!supabase) return;
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
  const userQuery = query || clientMessages?.slice(-1)[0]?.content || '';
  if (!userQuery) return res.status(400).json({ error: 'No query' });

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

    // 3. Document search
    let docContext = '';
    const docResult = await searchDocs(resolvedQuery);
    if (docResult) docContext = '\n\n[Relevant documents]\n' + docResult;

    // 3b. Older relevant chat history beyond the recency window
    const recentIds = new Set(history.map(m => m.created_at));
    const relevantMsgs = await searchMessages(resolvedQuery);
    const olderRelevant = relevantMsgs.filter(m => !recentIds.has(m.created_at));
    if (olderRelevant.length) {
      docContext += '\n\n[Relevant past discussion]\n' +
        olderRelevant.map(m => `${m.role}: ${m.content}`).join('\n\n');
    }

    // 4. Build messages for AI
    const messages = [
      ...history,
      ...(searchContext || docContext ? [{
        role: 'user',
        content: `[Context for your response]\n${searchContext}${docContext}\n\n[User message]\n${userQuery}`
      }] : [{
        role: 'user',
        content: userQuery
      }])
    ];

    // 5. Save user message to history
    await saveMessage('user', userQuery);

    // 6. Stream response
    let full = '';
    const controller = new AbortController();
    req.on('close', () => controller.abort());

    for await (const chunk of runCascade(messages, controller.signal)) {
      if (typeof chunk === 'string') {
        full += chunk;
        send({ token: chunk });
      } else if (chunk.event) {
        send({ event: chunk.event });
      }
    }

    // 7. Save assistant response
    await saveMessage('assistant', full);

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

    res.json({ ok: true, filename, chars: text.length, drive: driveResult });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// List documents
app.get('/api/docs', async (req, res) => {
  if (!supabase) return res.json({ docs: [] });
  const { data } = await supabase
    .from('mobius_docs')
    .select('filename, created_at')
    .order('created_at', { ascending: false });
  const seen = new Set();
  const docs = (data || []).filter(d => { if (seen.has(d.filename)) return false; seen.add(d.filename); return true; });
  res.json({ docs });
});

// Delete document
app.delete('/api/docs/:filename', async (req, res) => {
  if (!supabase) return res.json({ ok: false });
  await supabase.from('mobius_docs').delete().eq('filename', decodeURIComponent(req.params.filename));
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
    const result = await syncDrive(GDRIVE_KEY, SB_URL, SB_KEY, GEMINI_KEY, MISTRAL_KEY);
    console.log('[drive] Sync result:', result);
  } catch (e) {
    console.error('[drive] Sync error:', e.message);
  } finally { syncRunning = false; }
});

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
      result.drive = await syncDrive(GDRIVE_KEY, SB_URL, SB_KEY, GEMINI_KEY, MISTRAL_KEY);
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
    const result = await syncDrive(GDRIVE_KEY, SB_URL, SB_KEY, GEMINI_KEY, MISTRAL_KEY);
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
