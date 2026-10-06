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
import fs from 'fs';
import { PORT, FRONTEND_DIR, IS_VERCEL, START_TIME, CRON_SECRET, CRON_BUDGET_MS, BACKUP_DIR, KEYS } from './config.js';
import { authRouter, authGate, authEnabled } from './auth.js';
import { lastUpdated, appVersion } from './version.js';
import { lookupJson } from './bible.js';
import { supabase } from './db.js';
import { availableNames, modelStatus, syncRest } from './ai/cascade.js';
import { auditModels, probeModels } from './ai/audit.js';
import { chatTurn } from './chat.js';
import { geoFromHeaders, memoryStats } from './self.js';
import { startTrace, saveTrace, recentTraces, getTrace } from './trace.js';
import { getMessages } from './pcm/messages.js';
import { getActive, history, getState } from './pcm/memory.js';
import { saveProfile, PROFILE_MAX } from './pcm/profile.js';
import { getSettings, saveSettings } from './pcm/settings.js';
import { listTrash, trashStats, restoreTrash, deleteTrash, canMirror } from './pcm/backup.js';
import { housekeeping, storageReport } from './pcm/housekeeping.js';
import { listNotes, addNote, updateNote, setStatus } from './pcm/notes.js';
import { listDevNotes, addDevNote, updateDevNote, setDevNoteDone, removeDevNote } from './pcm/devnotes.js';
import { runMaintenance } from './pcm/maintain.js';
import { saveDoc, listDocs, deleteDoc } from './docs/store.js';
import { extractFromBuffer } from './docs/extract.js';
import { driveConfigured, browse, importFile, uploadToDrive, syncDrive, backfillFull } from './docs/drive.js';
import * as gAccount from './google.js';
import { listSources, addSource, updateSource, checkSource, removeSource, syncSources, serviceAccountEmail } from './docs/sources.js';

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

app.use(cors());
app.use(express.json({ limit: '20mb' }));

// Login (passkeys). Active only when SESSION_SECRET is set; see auth.js.
app.use(authRouter);
app.use(authGate);

// The Settings page carries its own version stamp, filled in here as it is served, so what you see is what was sent.
app.get('/settings.html', (req, res, next) => {
  try {
    const html = fs.readFileSync(path.join(FRONTEND_DIR, 'settings.html'), 'utf8')
      .replace(/__MOBIUS_VERSION__/g, appVersion() || '').replace(/__MOBIUS_UPDATED__/g, lastUpdated() || '');
    res.set('Cache-Control', 'no-store').type('html').send(html);
  } catch { next(); }
});

app.use(express.static(FRONTEND_DIR));

// ── Status & history ─────────────────────────────────────────────────────────
// Status. `cascade` feeds the header, so it is kept short; `latest` lets other devices notice new messages.
app.get('/api/status', async (req, res) => {
  const names = availableNames();
  const latest = (await getMessages(1))[0]?.created_at || null;
  res.json({
    ok: true, startTime: START_TIME, supabase: !!supabase, updated: lastUpdated(), version: appVersion(), latest,
    cascade: names.length > 3 ? [...names.slice(0, 3), `+${names.length - 3} more`] : names,
  });
});

app.get('/api/history', async (req, res) => {
  try {
    res.json({ messages: await getMessages(parseInt(req.query.limit) || 100) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Models ───
app.get('/api/models', async (req, res) => { await syncRest(); res.json({ models: modelStatus() }); });
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
// Images arrive as base64 from the browser (already shrunk there). Keep a few valid ones only.
const MAX_IMAGES = 4;
const cleanImages = list => (Array.isArray(list) ? list : [])
  .filter(i => i && typeof i.base64 === 'string' && /^image\/(jpeg|png|webp|gif|heic|heif)$/i.test(i.mimeType || ''))
  .slice(0, MAX_IMAGES)
  .map(i => ({ base64: i.base64, mimeType: i.mimeType.toLowerCase() }));

app.post('/api/chat', async (req, res) => {
  const { messages, query: q, docs, client, images, viewing } = req.body;
  const query = q || messages?.slice(-1)[0]?.content || '';
  if (!query) return res.status(400).json({ error: 'No query' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const send = obj => res.write('data: ' + JSON.stringify(obj) + '\n\n');

  const controller = new AbortController();
  res.on('close', () => { if (!res.writableEnded) controller.abort(); }); // client went away

  try {
    for await (const item of chatTurn({ query, docs, images: cleanImages(images), client, geo: geoFromHeaders(req.headers), viewing: (typeof viewing === 'number' || (typeof viewing === 'string' && viewing.length <= 64)) ? viewing : null, signal: controller.signal })) send(item);
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
  try { await deleteDoc(decodeURIComponent(req.params.filename)); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); } // nothing is deleted if it could not be backed up first
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
// The Drive folder named in config, then every folder linked in Settings. `budgetMs` bounds the linked ones.
async function runDriveSync(budgetMs = 30000) {
  if (syncRunning || !supabase || !driveConfigured()) return null;
  syncRunning = true;
  try {
    const base = await syncDrive();
    const linked = await syncSources({ budgetMs: IS_VERCEL ? budgetMs : Infinity });
    return { ...base, linked };
  }
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

// ── Linked folders (Settings → Linked folders) ──────────────────────────────
// A Bible passage for the pop-up that opens when a reference in the chat is clicked.
app.get('/api/bible', async (req, res) => {
  try { res.json(await lookupJson(req.query.ref, req.query.t)); }
  catch (e) { res.status(500).json({ error: String(e.message).slice(0, 200) }); }
});

app.get('/api/sources', async (req, res) => {
  try { res.json({ sources: await listSources(), serviceAccount: serviceAccountEmail(), driveReady: driveConfigured(), google: await gAccount.status(req) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/sources', async (req, res) => { // { url, label?, maxFiles? }
  try { res.json({ ok: true, source: await addSource(req.body || {}) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.put('/api/sources/:id', async (req, res) => {
  try { await updateSource(Number(req.params.id), req.body || {}); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/sources/sync', async (req, res) => { // read new files now (bounded, so a big Drive is read over several presses)
  if (syncRunning) return res.json({ ok: false, message: 'A sync is already running.' });
  try { res.json({ ok: true, report: await runDriveSync(40000) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/sources/:id/check', async (req, res) => {
  try { res.json({ ok: true, source: await checkSource(Number(req.params.id)) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/sources/:id', async (req, res) => { // ?docs=1 also removes the documents it brought in (to the backup)
  try { res.json({ ok: true, ...(await removeSource(Number(req.params.id), { withDocs: req.query.docs === '1' })) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ── Connect my Google account (Settings → Linked folders) ───────────────────
app.get('/api/google/status', async (req, res) => {
  try { res.json(await gAccount.status(req)); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/google/client-file', async (req, res) => { // { text }: the client_secret_….json Google lets you download
  try { await gAccount.saveClientJson(req, String(req.body?.text || '')); res.json({ ok: true, status: await gAccount.status(req) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/google/credentials', async (req, res) => { // { clientId, clientSecret }: typed in by hand instead
  try { await gAccount.saveCredentials(req.body?.clientId, req.body?.clientSecret); res.json({ ok: true, status: await gAccount.status(req) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/google/connect', async (req, res) => { // sends the browser to Google's own sign-in page
  try { res.redirect(await gAccount.startAuth(req)); }
  catch (e) { res.redirect('/settings.html?google=error&msg=' + encodeURIComponent(e.message) + (e.fix ? '&fix=' + e.fix : '')); }
});
// Google sends the browser back here, at Mobius's own address or at the address the earlier version registered
// (which may be on another host, so the page to return to comes from the one-time state, never from the request).
const googleCallback = async (req, res) => {
  const state = String(req.query.state || '');
  const home = (await gAccount.originForState(state).catch(() => null)) || '';
  try {
    if (req.query.error) throw new Error(req.query.error === 'access_denied' ? 'You did not approve the connection, so nothing was connected.' : 'Google said: ' + req.query.error);
    await gAccount.finishAuth(req, String(req.query.code || ''), state);
    res.redirect(home + '/settings.html?google=connected');
  } catch (e) { res.redirect(home + '/settings.html?google=error&msg=' + encodeURIComponent(e.message)); }
};
app.get('/api/google/callback', googleCallback);
const earlierPath = gAccount.earlierCallbackPath();
if (earlierPath && earlierPath !== '/api/google/callback') app.get(earlierPath, googleCallback);
app.post('/api/google/disconnect', async (req, res) => {
  try { await gAccount.disconnect(); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/google/folders', async (req, res) => { // for "Browse my Drive": ?parent=root | shared | <folder id>
  try { res.json({ folders: await gAccount.listFolders(String(req.query.parent || 'root')) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

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

// The personal profile (edited in Settings). Mobius updates it weekly and uses the update at once;
// the previous version is kept. One over the size limit is condensed by a model, not refused.
app.get('/api/pcm/profile', async (req, res) => {
  const [active, versions, lastAuto, editedAt] = await Promise.all([getActive('profile'), history('profile'), getState('profile_last'), getState('profile_edited_at')]);
  res.json({
    content: active?.content || '', updatedAt: active?.updated_at || null,
    lastAutoUpdate: lastAuto || null, lastEditedByYou: editedAt || null,
    versions: versions.map(v => ({ content: v.content, at: v.created_at })),
    max: PROFILE_MAX,
  });
});
app.post('/api/pcm/profile', async (req, res) => { // save the profile: { "content": "..." }
  try { res.json({ ok: true, ...(await saveProfile(req.body?.content, { manual: true })) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ── Settings page ───
app.get('/api/settings', async (req, res) => {
  const [settings, hk, backup] = await Promise.all([getSettings(), getState('housekeeping'), trashStats()]);
  res.json({
    settings,
    models: modelStatus(),
    storage: hk?.report?.storage || (supabase ? await storageReport() : null),
    housekeeping: hk ? { at: hk.at, report: hk.report } : null,
    backup: { dir: BACKUP_DIR, writesToFolder: canMirror(), ...backup },
  });
});
app.post('/api/settings', async (req, res) => {
  try { res.json({ ok: true, settings: await saveSettings(req.body) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/housekeeping/run', async (req, res) => res.json(await housekeeping()));

app.get('/api/backup', async (req, res) => res.json({ items: await listTrash(100) }));
app.post('/api/backup/:id/restore', async (req, res) => {
  try { res.json({ ok: true, ...(await restoreTrash(Number(req.params.id))) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/backup/:id', async (req, res) => {
  try { await deleteTrash(Number(req.params.id)); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// Development notes: Boon's own to-do list for Mobius, for the next session at the laptop.
app.get('/api/devnotes', async (req, res) => res.json(await listDevNotes()));
app.post('/api/devnotes', async (req, res) => {
  try { res.json({ ok: true, id: await addDevNote(req.body?.content) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.put('/api/devnotes/:id', async (req, res) => {
  try { await updateDevNote(Number(req.params.id), req.body?.content); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/devnotes/:id/:action', async (req, res) => { // action: done | reopen
  const { id, action } = req.params;
  if (!['done', 'reopen'].includes(action)) return res.status(400).json({ error: 'Unknown action' });
  try { await setDevNoteDone(Number(id), action === 'done', req.body?.result); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/devnotes/:id', async (req, res) => {
  try { await removeDevNote(Number(req.params.id)); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
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
  try { out.drive = (await runDriveSync(15000)) || { skipped: true }; }
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
