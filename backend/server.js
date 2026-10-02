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
import { supabase } from './db.js';
import { availableNames } from './ai/cascade.js';
import { chatTurn } from './chat.js';
import { getMessages } from './pcm/messages.js';
import { getActive, getProposed, listActive, put, promote, discard, getState } from './pcm/memory.js';
import { runMaintenance } from './pcm/maintain.js';
import { saveDoc, listDocs, deleteDoc } from './docs/store.js';
import { extractFromBuffer } from './docs/extract.js';
import { driveConfigured, browse, importFile, uploadToDrive, syncDrive, backfillFull } from './docs/drive.js';

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.static(FRONTEND_DIR));

// ── Status & history ─────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({ ok: true, startTime: START_TIME, supabase: !!supabase, cascade: availableNames() });
});

app.get('/api/history', async (req, res) => {
  try {
    res.json({ messages: await getMessages(parseInt(req.query.limit) || 100) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Chat (Server-Sent Events) ────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { messages, query: q, docs } = req.body;
  const query = q || messages?.slice(-1)[0]?.content || '';
  if (!query) return res.status(400).json({ error: 'No query' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const send = obj => res.write('data: ' + JSON.stringify(obj) + '\n\n');

  const controller = new AbortController();
  res.on('close', () => { if (!res.writableEnded) controller.abort(); }); // client went away

  try {
    for await (const item of chatTurn({ query, docs, signal: controller.signal })) send(item);
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
  if (!supabase) return res.json({ ok: false, message: 'No Supabase connection' });
  const count = async (table, narrow = q => q) => {
    const { count: n, error } = await narrow(supabase.from(table).select('id', { count: 'exact', head: true }));
    return error ? null : n;
  };
  res.json({
    ok: true,
    messages:  { total: await count('mobius_messages'), unembedded: await count('mobius_messages', q => q.is('embedding', null)) },
    docChunks: { total: await count('mobius_docs'),     unembedded: await count('mobius_docs',     q => q.is('embedding', null)) },
    profile:   { active: !!(await getActive('profile')), proposed: !!(await getProposed('profile')) },
    weekDigest: !!(await getActive('week')),
    projects:  (await listActive('project')).map(p => p.key),
    lastMaintenance: await getState('last_maintenance'),
  });
});

// Run the memory jobs now. Locally unbounded; on Vercel time-boxed.
app.all('/api/pcm/maintain', async (req, res) => {
  res.json(await runMaintenance({ budgetMs: IS_VERCEL ? CRON_BUDGET_MS : Infinity }));
});

// The personal profile: weekly proposals wait here for approval.
app.get('/api/pcm/profile', async (req, res) => {
  res.json({
    active:   (await getActive('profile'))?.content || null,
    proposed: (await getProposed('profile'))?.content || null,
  });
});
app.post('/api/pcm/profile', async (req, res) => { // write the profile directly: { "content": "..." }
  const content = String(req.body?.content || '').trim();
  if (!content) return res.status(400).json({ error: 'No content' });
  try { await put('profile', 'main', { content: content.slice(0, 3000) }); res.json({ ok: true }); }
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
