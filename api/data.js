// ── api/data.js ───────────────────────────────────────────────────────────────
// MEMORY — all Supabase reads/writes, file ops, sync, upload
//
// GET  /api/chat-history        → action=history
// GET  /api/sync/status         → action=sync-status
// POST /api/sync                → action=sync
// POST /upload                  → action=upload
// POST /api/focus/find          → action=focus-find
// POST /api/focus/read          → action=focus-read
// POST /api/focus/copy          → action=focus-copy
// POST /api/focus/create        → action=focus-create
// POST /api/focus/append        → action=focus-append
// POST /api/focus/update-original → action=focus-update-original
// POST /api/focus/create-or-update → action=focus-create-or-update
// POST /api/knowledge/save      → action=knowledge-save
// GET  /api/knowledge/query     → action=knowledge-query
// POST /api/sessions/start      → action=sessions-start
// POST /api/sessions/end        → action=sessions-end
// GET  /api/sessions/last       → action=sessions-last
// POST /api/model-config/save   → action=model-config-save
// GET  /api/model-config/get    → action=model-config-get

const { createClient } = require('@supabase/supabase-js');
const { getChatHistory } = require('./_supabase.js');
const { google }         = require('googleapis');
const {
  getGoogleClient,
  writeDriveFileContent,
  findDriveFile,
  createDriveFile,
  copyToMobiusFolder,
  readDriveFileContent,
  updateOriginalFile
} = require('../google_api.js');
const Busboy = require('busboy');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ── Sync helpers ──────────────────────────────────────────────────────────────

async function getConnectedLabels(userId) {
  const { data } = await supabase
    .from('google_tokens')
    .select('label, email')
    .eq('user_id', userId);
  return data || [];
}

async function writeIndexFile(userId, filename, content) {
  const found = await findDriveFile(userId, filename);
  const exactMatch = (found.files || []).find(f => f.name === filename && f.inMobius)
                  || (found.files || []).find(f => f.name === filename);
  if (exactMatch) {
    await writeDriveFileContent(userId, exactMatch.id, content);
    return exactMatch.id;
  }
  const newFile = await createDriveFile(userId, filename, found.folderId);
  await writeDriveFileContent(userId, newFile.id, content);
  return newFile.id;
}

async function updateSyncMeta(userId, label, type) {
  await supabase.from('sync_meta').upsert({
    user_id: userId, label, type,
    synced_at: new Date().toISOString()
  }, { onConflict: 'user_id, label, type' });
}

async function syncCalendars(userId, since) {
  const accounts = await getConnectedLabels(userId);
  const lines = ['# calendar.index', '# Generated: ' + new Date().toLocaleString('en-AU'), '# Format: [label] start → end | title', ''];
  for (const { label, email } of accounts) {
    try {
      const client   = await getGoogleClient(userId, label);
      const calendar = google.calendar({ version: 'v3', auth: client });
      const timeMin  = since ? new Date(since).toISOString() : new Date().toISOString();
      const timeMax  = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();
      const res = await calendar.events.list({ calendarId: 'primary', timeMin, timeMax, singleEvents: true, orderBy: 'startTime', maxResults: 250 });
      const events = res.data.items || [];
      lines.push('## ' + label + ' (' + email + ') — ' + events.length + ' events');
      for (const e of events) {
        const start = e.start?.dateTime || e.start?.date || '';
        const end   = e.end?.dateTime   || e.end?.date   || '';
        lines.push('[' + label + '] ' + start + ' → ' + end + ' | ' + (e.summary || '(no title)') + (e.location ? ' @ ' + e.location : ''));
      }
      lines.push('');
      await updateSyncMeta(userId, label, 'calendar');
    } catch (err) { lines.push('## ' + label + ' — ERROR: ' + err.message); lines.push(''); }
  }
  await writeIndexFile(userId, 'calendar.index', lines.join('\n'));
  return { ok: true, events: lines.length };
}

async function syncEmails(userId, since) {
  const accounts = await getConnectedLabels(userId);
  const lines = ['# email.index', '# Generated: ' + new Date().toLocaleString('en-AU'), '# Format: [label] date | from | subject', ''];
  for (const { label, email } of accounts) {
    try {
      const client = await getGoogleClient(userId, label);
      const gmail  = google.gmail({ version: 'v1', auth: client });
      let q = 'is:unread';
      if (since) q += ' after:' + Math.floor(new Date(since).getTime() / 1000);
      const listRes  = await gmail.users.messages.list({ userId: 'me', maxResults: 100, q });
      const messages = listRes.data.messages || [];
      lines.push('## ' + label + ' (' + email + ') — ' + messages.length + ' unread');
      const details = await Promise.all(messages.map(m => gmail.users.messages.get({ userId: 'me', id: m.id, format: 'metadata', metadataHeaders: ['Subject', 'From', 'Date'] })));
      for (const d of details) {
        const h = d.data.payload?.headers || [];
        lines.push('[' + label + '] ' + (h.find(x => x.name === 'Date')?.value || '') + ' | ' + (h.find(x => x.name === 'From')?.value || '(unknown)') + ' | ' + (h.find(x => x.name === 'Subject')?.value || '(no subject)'));
      }
      lines.push('');
      await updateSyncMeta(userId, label, 'email');
    } catch (err) { lines.push('## ' + label + ' — ERROR: ' + err.message); lines.push(''); }
  }
  await writeIndexFile(userId, 'email.index', lines.join('\n'));
  return { ok: true, messages: lines.length };
}

async function syncDrive(userId, since) {
  const accounts = await getConnectedLabels(userId);
  const lines = ['# drive.index', '# Generated: ' + new Date().toLocaleString('en-AU'), '# Format: [label] modified | name', ''];
  for (const { label, email } of accounts) {
    try {
      const client = await getGoogleClient(userId, label);
      const drive  = google.drive({ version: 'v3', auth: client });
      let q = "trashed = false and mimeType != 'application/vnd.google-apps.folder'";
      if (since) q += " and modifiedTime > '" + new Date(since).toISOString() + "'";
      const res   = await drive.files.list({ q, fields: 'files(id, name, mimeType, modifiedTime)', orderBy: 'modifiedTime desc', pageSize: 500 });
      const files = res.data.files || [];
      lines.push('## ' + label + ' (' + email + ') — ' + files.length + ' files');
      for (const f of files) lines.push('[' + label + '] ' + (f.modifiedTime || '') + ' | ' + f.name);
      lines.push('');
      await updateSyncMeta(userId, label, 'drive');
    } catch (err) { lines.push('## ' + label + ' — ERROR: ' + err.message); lines.push(''); }
  }
  await writeIndexFile(userId, 'drive.index', lines.join('\n'));
  return { ok: true, files: lines.length };
}

async function syncAll(userId, since) {
  const [calendars, emails, drive] = await Promise.allSettled([
    syncCalendars(userId, since),
    syncEmails(userId, since),
    syncDrive(userId, since)
  ]);
  return {
    calendars: calendars.status === 'fulfilled' ? calendars.value : { ok: false, error: calendars.reason?.message },
    emails:    emails.status    === 'fulfilled' ? emails.value    : { ok: false, error: emails.reason?.message },
    drive:     drive.status     === 'fulfilled' ? drive.value     : { ok: false, error: drive.reason?.message }
  };
}

// ── Handler ───────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  const { action } = req.query;

  // ── history ───────────────────────────────────────────────────────────────
  if (action === 'history') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId is required' });
    const sessions = await getChatHistory(userId, 10000);
    return res.status(200).json({ sessions });
  }

  // ── sync-status ───────────────────────────────────────────────────────────
  if (action === 'sync-status') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    try {
      const { data, error } = await supabase
        .from('sync_meta').select('label, type, synced_at')
        .eq('user_id', userId).order('label').order('type');
      if (error) throw error;
      return res.json({ status: data || [] });
    } catch (err) { return res.status(500).json({ error: err.message }); }
  }

  // ── sync ──────────────────────────────────────────────────────────────────
  if (action === 'sync') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const { userId, type, since } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId required' });
    try {
      let result;
      if      (type === 'calendars') result = await syncCalendars(userId, since);
      else if (type === 'emails')    result = await syncEmails(userId, since);
      else if (type === 'drive')     result = await syncDrive(userId, since);
      else                           result = await syncAll(userId, since);
      return res.json({ ok: true, type: type || 'all', result });
    } catch (err) {
      console.error('Sync error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // ── upload ────────────────────────────────────────────────────────────────
  if (action === 'upload') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    try {
      const contentType = req.headers['content-type'] || '';
      if (!contentType.includes('multipart/form-data')) {
        return res.status(400).json({ error: 'Expected multipart/form-data' });
      }
      const busboy = Busboy({ headers: req.headers });
      const chunks = [];
      let filename = 'upload';
      let mimeType = 'application/octet-stream';
      await new Promise((resolve, reject) => {
        busboy.on('file', (fieldname, file, info) => {
          filename = info.filename || 'upload';
          mimeType = info.mimeType || 'application/octet-stream';
          file.on('data', chunk => chunks.push(chunk));
        });
        busboy.on('finish', resolve);
        busboy.on('error', reject);
        req.pipe(busboy);
      });
      const buffer = Buffer.concat(chunks);
      const base64 = buffer.toString('base64');
      return res.status(200).json({ name: filename, mimeType, base64, size: buffer.length });
    } catch (err) {
      console.error('Upload error:', err.message);
      return res.status(500).json({ error: 'Upload failed: ' + err.message });
    }
  }

  // ── Focus actions ─────────────────────────────────────────────────────────
  if (action && action.startsWith('focus-')) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const { userId, filename, content, fileId, mimeType, folderId, originalFileId } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId is required' });
    const focusAction = action.slice(6); // strip 'focus-' prefix
    try {
      switch (focusAction) {
        case 'find': {
          if (!filename) return res.status(400).json({ error: 'filename required' });
          return res.json(await findDriveFile(userId, filename));
        }
        case 'read': {
          if (!fileId) return res.status(400).json({ error: 'fileId required' });
          const result = await readDriveFileContent(userId, fileId, mimeType || 'text/plain');
          return res.json({ content: result });
        }
        case 'copy': {
          if (!fileId) return res.status(400).json({ error: 'fileId required' });
          return res.json({ copy: await copyToMobiusFolder(userId, fileId, mimeType, filename, folderId) });
        }
        case 'create': {
          if (!filename) return res.status(400).json({ error: 'filename required' });
          const focusFilename = /\.[a-z0-9]+$/i.test(filename) ? filename : filename + '.md';
          return res.json({ file: await createDriveFile(userId, focusFilename, folderId) });
        }
        case 'append': {
          if (!fileId || !content) return res.status(400).json({ error: 'fileId and content required' });
          await writeDriveFileContent(userId, fileId, content);
          return res.json({ ok: true });
        }
        case 'update-original': {
          if (!originalFileId) return res.status(400).json({ error: 'originalFileId required' });
          await updateOriginalFile(userId, originalFileId, content);
          return res.json({ ok: true });
        }
        case 'create-or-update': {
          if (!filename || !content) return res.status(400).json({ error: 'filename and content required' });
          const found = await findDriveFile(userId, filename);
          if (found.files && found.files.length > 0) {
            const existing = found.files.find(f => f.inMobius) || found.files[0];
            await writeDriveFileContent(userId, existing.id, content);
            return res.json({ ok: true, action: 'updated', fileId: existing.id });
          }
          const newFile = await createDriveFile(userId, filename, found.folderId);
          await writeDriveFileContent(userId, newFile.id, content);
          return res.json({ ok: true, action: 'created', fileId: newFile.id });
        }
        default:
          return res.status(400).json({ error: 'Unknown focus action: ' + focusAction });
      }
    } catch (err) {
      console.error('Focus error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // ── knowledge-save ────────────────────────────────────────────────────────
  if (action === 'knowledge-save') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const { userId, project, domain, type: recType, tags, content, context, session_id } = req.body || {};
    if (!userId || !content) return res.status(400).json({ error: 'userId and content required' });
    try {
      const { data, error } = await supabase.from('knowledge').insert([{
        user_id:    userId,
        project:    project    || 'general',
        domain:     domain     || 'personal',
        type:       recType    || 'note',
        tags:       tags       || [],
        content,
        context:    context    || null,
        session_id: session_id || null
      }]).select('id').single();
      if (error) throw error;
      return res.json({ ok: true, id: data.id });
    } catch (err) { return res.status(500).json({ error: err.message }); }
  }

  // ── knowledge-query ───────────────────────────────────────────────────────
  if (action === 'knowledge-query') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const { userId, project, type: recType, tags, limit } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    try {
      let q = supabase.from('knowledge').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(parseInt(limit) || 50);
      if (project) q = q.eq('project', project);
      if (recType) q = q.eq('type', recType);
      if (tags)    q = q.contains('tags', tags.split(','));
      const { data, error } = await q;
      if (error) throw error;
      return res.json({ records: data || [] });
    } catch (err) { return res.status(500).json({ error: err.message }); }
  }

  // ── sessions-start ────────────────────────────────────────────────────────
  if (action === 'sessions-start') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const { userId, sessionId, project, domain } = req.body || {};
    if (!userId || !sessionId) return res.status(400).json({ error: 'userId and sessionId required' });
    try {
      const { error } = await supabase.from('sessions').upsert({
        id:         sessionId,
        user_id:    userId,
        project:    project || 'general',
        domain:     domain  || 'personal',
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        status:     'active'
      }, { onConflict: 'id' });
      if (error) throw error;
      return res.json({ ok: true });
    } catch (err) { return res.status(500).json({ error: err.message }); }
  }

  // ── sessions-end ──────────────────────────────────────────────────────────
  if (action === 'sessions-end') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const { userId, sessionId, summary_det } = req.body || {};
    if (!userId || !sessionId) return res.status(400).json({ error: 'userId and sessionId required' });
    try {
      const { error } = await supabase.from('sessions').update({
        ended_at:           new Date().toISOString(),
        updated_at:         new Date().toISOString(),
        status:             'ended',
        summary_det:        summary_det || null,
        pending_ai_summary: true
      }).eq('id', sessionId).eq('user_id', userId);
      if (error) throw error;
      return res.json({ ok: true });
    } catch (err) { return res.status(500).json({ error: err.message }); }
  }

  // ── sessions-last ─────────────────────────────────────────────────────────
  if (action === 'sessions-last') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const { userId, project } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    try {
      let q = supabase.from('sessions').select('*').eq('user_id', userId).eq('status', 'ended').order('ended_at', { ascending: false }).limit(1);
      if (project) q = q.eq('project', project);
      const { data, error } = await q;
      if (error) throw error;
      return res.json({ session: data?.[0] || null });
    } catch (err) { return res.status(500).json({ error: err.message }); }
  }

  // ── model-config-save ─────────────────────────────────────────────────────
  if (action === 'model-config-save') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const { userId, provider, model_id, display_name, capabilities, context_window, is_active, latency_ms } = req.body || {};
    if (!userId || !provider || !model_id) return res.status(400).json({ error: 'userId, provider, model_id required' });
    try {
      const { error } = await supabase.from('model_config').upsert({
        user_id:        userId,
        provider,
        model_id,
        display_name:   display_name  || model_id,
        capabilities:   capabilities  || [],
        context_window: context_window || null,
        is_active:      is_active !== false,
        latency_ms:     latency_ms    || null,
        last_checked:   new Date().toISOString()
      }, { onConflict: 'user_id, provider, model_id' });
      if (error) throw error;
      return res.json({ ok: true });
    } catch (err) { return res.status(500).json({ error: err.message }); }
  }

  // ── model-config-get ──────────────────────────────────────────────────────
  if (action === 'model-config-get') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const { userId, capability } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    try {
      let q = supabase.from('model_config').select('*').eq('user_id', userId).eq('is_active', true).order('latency_ms', { ascending: true });
      if (capability) q = q.contains('capabilities', [capability]);
      const { data, error } = await q;
      if (error) throw error;
      return res.json({ models: data || [] });
    } catch (err) { return res.status(500).json({ error: err.message }); }
  }

  res.status(400).json({ error: 'Unknown action: ' + action });
};
