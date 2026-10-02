// Mobius — backend server (port 3005). Routes only; the work lives in the modules:
//   chat.js          one chat turn
//   ai/              the free-model cascade and system prompt
//   pcm/             Persistent Contextual Memory: routing, recall, assembly, maintenance
//   docs/            document store, extraction, Google Drive
//   web.js           Tavily search
// The /api/* contract below is what frontend/index.html expects — keep it stable.

import express from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import { PORT, FRONTEND_DIR, IS_VERCEL, START_TIME, CRON_SECRET, CRON_BUDGET_MS, KEYS } from './config.js';
import { authRouter, authGate, authEnabled } from './auth.js';
import { lastUpdated } from './version.js';
import { supabase } from './db.js';
import { availableNames, modelStatus } from './ai/cascade.js';
import { auditModels, probeModels } from './ai/audit.js';
import { chatTurn } from './chat.js';
import { geoFromHeaders, memoryStats } from './self.js';
import { startTrace, saveTrace, recentTraces, getTrace } from './trace.js';
import { getMessages } from './pcm/messages.js';
import { getActive, getProposed, put, promote, discard, history } from './pcm/memory.js';
import { listNotes, addNote, updateNote, setStatus } from './pcm/notes.js';
import { runMaintenance } from './pcm/maintain.js';
import { saveDoc, listDocs, deleteDoc } from './docs/store.js';
import { extractFromBuffer } from './docs/extract.js';
import { driveConfigured, browse, importFile, uploadToDrive, syncDrive, backfillFull } from './docs/drive.js';

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

app.use(cors());
app.use(express.json({ limit: '20mb' }));

// Login (passkeys). Active only when SESSION_SECRET is set; see auth.js.
app.use(authRouter);
app.use(authGate);

app.use(express.static(FRONTEND_DIR));

// ── Status & history ─────────────────────────────────────────────────────────
// Status. `cascade` feeds the header, so it is kept short; `latest` lets other devices notice new messages.
app.get('/api/status', async (req, res) => {
  const names = availableNames();
  const latest = (await getMessages(1))[0]?.created_at || null;
  res.json({
    ok: true, startTime: START_TIME, supabase: !!supabase, updated: lastUpdated(), latest,
    cascade: names.length > 3 ? [...names.slice(0, 3), `+${names.length - 3} more`] : names,
  });
});

app.get('/api/history', async (req, res) => {
  try {
    res.json({ messages: await getMessages(parseInt(req.query.limit) || 100) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Models ───
app.get('/api/models', (req, res) => res.json({ models: modelStatus() }));
app.all('/api/models/audit', async (req, res) => {          // ?probe=1 also makes one tiny live call per model
  const report = await auditModels();
  res.json(req.query.probe ? { ...report, probe: await probeModels() } : report);
});

// ── Debugging ───
const traceLine = t => ({ id: t.id, at: t.created_at, kind: t.kind, query: t.data.query, model: t.data.model, plan: t.data.plan, marks: t.data.marks, error: t.data.error, answer: t.data.answer_head?.slice(0, 160) });
app.get('/api/debug/traces', async (req, res) => {
  const rows = await recentTraces(parseInt(req.query.n) || 5, req.query.kind || null);
  res.json({ traces: rows.map(traceLine) });
});
app.get('/api/debug/trace/:id', async (req, res) => res.json((await getTrace(req.params.id)) || { error: 'not found' }));

// Errors the browser hits are reported here, so they land in the same record as the server's.
app.post('/api/debug/client', async (req, res) => {
  const b = req.body || {};
  const cut = (s, n) => String(s ?? '').slice(0, n);
  await saveTrace(startTrace('client', { message: cut(b.message, 400), source: cut(b.source, 200), stack: cut(b.stack, 1500), page: cut(b.page, 100), client: b.client || null }));
  res.json({ ok: true });
});

// ── Chat (Server-Sent Events) ────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { messages, query: q, docs, client } = req.body;
  const query = q || messages?.slice(-1)[0]?.content || '';
  if (!query) return res.status(400).json({ error: 'No query' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const send = obj => res.write('data: ' + JSON.stringify(obj) + '\n\n');

  const controller = new AbortController();
  res.on('close', () => { if (!res.writableEnded) controller.abort(); }); // client went away

  try {
    for await (const item of chatTurn({ query, docs, client, geo: geoFromHeaders(req.headers), signal: controller.signal })) send(item);
  } catch (e) {
    console.error('[chat]', e.message);
    send({ error: e.message });
  }
  res.write('data: [DONE]\n\n');
  res.end();
});

// ── Documents ────────────────────────────────────────────────────────────────
app.post('/api/docs/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  try {
    const filename = req.file.originalname;
    const text = await extractFromBuffer(req.file.buffer, filename, req.file.mimetype);
    await saveDoc(filename, text);

    let drive = null;
    if (driveConfigured()) {
      try { drive = await uploadToDrive(req.file.buffer, filename, req.file.mimetype); }
      catch (e) { console.warn('[upload] Drive push failed:', e.message); }
    }
    res.json({ ok: true, filename, chars: text.length, text, drive });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/docs', async (req, res) => {
  try { res.json({ docs: await listDocs() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/docs/:filename', async (req, res) => {
  await deleteDoc(decodeURIComponent(req.params.filename));
  res.json({ ok: true });
});

// ── Google Drive ─────────────────────────────────────────────────────────────
app.get('/api/drive/browse', async (req, res) => {
  if (!driveConfigured()) return res.status(400).json({ error: 'Drive not configured' });
  try { res.json({ ok: true, files: await browse() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Import one file picked in the UI: behaves like a device upload (attached to the next message).
app.post('/api/drive/import', async (req, res) => {
  if (!driveConfigured()) return res.status(400).json({ error: 'Drive not configured' });
  const { fileId, filename, mimeType } = req.body || {};
  if (!fileId) return res.status(400).json({ error: 'No fileId' });
  try {
    const text = await importFile(fileId, mimeType);
    await saveDoc(filename, text);
    res.json({ ok: true, filename, chars: text.length, text });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

let syncRunning = false;
async function runDriveSync() {
  if (syncRunning || !supabase || !driveConfigured()) return null;
  syncRunning = true;
  try { return await syncDrive(); }
  finally { syncRunning = false; }
}

app.post('/api/drive/sync', (req, res) => {
  if (syncRunning) return res.json({ ok: false, message: 'Sync already running' });
  if (!supabase) return res.json({ ok: false, message: 'No Supabase connection' });
  if (!driveConfigured()) return res.json({ ok: false, message: 'Service account key not found' });
  res.json({ ok: true, message: 'Sync started' });
  runDriveSync().then(r => console.log('[drive] sync:', r)).catch(e => console.error('[drive] sync error:', e.message));
});

app.get('/api/drive/status', (req, res) => res.json({ running: syncRunning, keyExists: driveConfigured() }));

async function handleBackfillFull(req, res) {
  if (!supabase || !driveConfigured()) return res.json({ ok: false, message: 'Drive or database not configured' });
  try { res.json({ ok: true, ...(await backfillFull()) }); }
  catch (e) { res.status(500).json({ ok: false, message: e.message }); }
}
app.all('/api/drive/backfill-full', handleBackfillFull);

// ── Memory (PCM) ─────────────────────────────────────────────────────────────
app.get('/api/pcm/status', async (req, res) => {
  const stats = await memoryStats();
  res.json(stats ? { ok: true, ...stats } : { ok: false, message: 'No Supabase connection' });
});

// Run the memory jobs now. Locally unbounded; on Vercel time-boxed.
app.all('/api/pcm/maintain', async (req, res) => {
  res.json(await runMaintenance({ budgetMs: IS_VERCEL ? CRON_BUDGET_MS : Infinity }));
});

// The personal profile (edited on the Memory page, /profile.html). Weekly proposals wait here for approval.
const PROFILE_MAX = 3000; // what is sent to the model with every message
app.get('/api/pcm/profile', async (req, res) => {
  const [active, proposed, versions] = await Promise.all([getActive('profile'), getProposed('profile'), history('profile')]);
  res.json({
    active: active?.content || null, activeAt: active?.updated_at || null,
    proposed: proposed?.content || null, proposedAt: proposed?.created_at || null,
    versions: versions.map(v => ({ content: v.content, at: v.created_at })),
    max: PROFILE_MAX,
  });
});
app.post('/api/pcm/profile', async (req, res) => { // save the profile: { "content": "..." }
  const content = String(req.body?.content || '').trim();
  if (!content) return res.status(400).json({ error: 'The profile cannot be empty' });
  if (content.length > PROFILE_MAX) return res.status(400).json({ error: `Too long: ${content.length} of ${PROFILE_MAX} characters` });
  try { await put('profile', 'main', { content }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.all('/api/pcm/profile/approve', async (req, res) => {
  try { res.json({ ok: !!(await promote('profile')) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.all('/api/pcm/profile/reject', async (req, res) => {
  try { await discard('profile'); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Notes (same things the chat commands do: "Remember ...", "Forget #14", "Save 14", "Drop 15").
const NOTE_ACTIONS = { forget: 'forgotten', save: 'active', drop: 'rejected' };
app.get('/api/pcm/notes', async (req, res) => {
  const all = await listNotes();
  res.json({ active: all.filter(n => n.status === 'active'), suggested: all.filter(n => n.status === 'proposed') });
});
app.post('/api/pcm/notes', async (req, res) => {
  const content = String(req.body?.content || '').trim();
  if (!content) return res.status(400).json({ error: 'A note cannot be empty' });
  try { res.json({ ok: true, ...(await addNote(content, { source: 'asked', status: 'active' })) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/pcm/notes/:id', async (req, res) => {
  try { await updateNote(Number(req.params.id), req.body?.content); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/pcm/notes/:id/:action', async (req, res) => {
  const status = NOTE_ACTIONS[req.params.action];
  if (!status) return res.status(400).json({ error: 'Unknown action' });
  try { await setStatus([Number(req.params.id)], status); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Daily cron (Vercel) ──────────────────────────────────────────────────────
app.get('/api/cron/daily', async (req, res) => {
  if (CRON_SECRET && req.headers.authorization !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, message: 'unauthorized' });
  }
  if (!supabase) return res.json({ ok: false, message: 'no Supabase connection' });
  const out = {};
  try { out.drive = (await runDriveSync()) || { skipped: true }; }
  catch (e) { out.driveError = e.message; }
  out.memory = await runMaintenance({ budgetMs: CRON_BUDGET_MS });
  res.json({ ok: true, ...out });
});

// Anything else is the PWA.
app.get('*', (req, res) => res.sendFile(path.join(FRONTEND_DIR, 'index.html')));

// ── Local server only ────────────────────────────────────────────────────────
// On Vercel the app is invoked per request and timers don't persist; the cron route covers it there.
if (!IS_VERCEL) {
  app.listen(PORT, () => {
    console.log(`\nMobius → http://localhost:${PORT}`);
    console.log(`Supabase  : ${supabase ? 'connected' : 'offline'}`);
    console.log(`AI cascade: ${availableNames().join(' → ') || 'none configured'}`);
    console.log(`Tavily    : ${KEYS.tavily ? 'enabled' : 'disabled'}`);
    console.log(`Drive     : ${driveConfigured() ? 'configured' : 'NOT configured'}`);
    console.log(`Login     : ${authEnabled ? 'passkeys required' : 'off (open)'}`);

    // Drive sync 10 s after start, memory upkeep 60 s after, then both every 6 hours.
    const drive = () => runDriveSync().then(r => r && console.log('[drive] auto-sync:', r)).catch(e => console.error('[drive]', e.message));
    const memory = () => runMaintenance().then(r => console.log('[pcm] maintenance:', JSON.stringify(r))).catch(e => console.error('[pcm]', e.message));
    setTimeout(drive, 10000);
    setTimeout(memory, 60000);
    setInterval(drive, 6 * 3600 * 1000);
    setInterval(memory, 6 * 3600 * 1000);
  });
}

export default app;
