// ── api/data.js ───────────────────────────────────────────────────────────────
// GET  /api/chat-history       → action=history
// POST /upload                 → action=upload
// POST /api/knowledge/save     → action=knowledge-save
// GET  /api/knowledge/query    → action=knowledge-query
// POST /api/sessions/start     → action=sessions-start
// POST /api/sessions/end       → action=sessions-end
// GET  /api/sessions/last      → action=sessions-last
// POST /api/model-config/save  → action=model-config-save
// GET  /api/model-config/get   → action=model-config-get

const { createClient } = require('@supabase/supabase-js');
const { getChatHistory } = require('./_supabase.js');
const Busboy = require('busboy');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

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
      console.error('[Coder] Upload error:', err.message);
      return res.status(500).json({ error: 'Upload failed: ' + err.message });
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
        project:    project    || 'coder',
        domain:     domain     || 'coding',
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
      let q = supabase.from('knowledge').select('*').eq('user_id', userId)
        .order('created_at', { ascending: false }).limit(parseInt(limit) || 50);
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
        project:    project || 'coder',
        domain:     domain  || 'coding',
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
      let q = supabase.from('sessions').select('*').eq('user_id', userId)
        .eq('status', 'ended').order('ended_at', { ascending: false }).limit(1);
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
      let q = supabase.from('model_config').select('*').eq('user_id', userId)
        .eq('is_active', true).order('latency_ms', { ascending: true });
      if (capability) q = q.contains('capabilities', [capability]);
      const { data, error } = await q;
      if (error) throw error;
      return res.json({ models: data || [] });
    } catch (err) { return res.status(500).json({ error: err.message }); }
  }

  // ── brief-task-get ──────────────────────────────────────────────────────
  if (action === 'brief-task-get') {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    try {
      const { data, error } = await supabase
        .from('brief_tasks')
        .select('project, query, updated_at')
        .eq('user_id', userId)
        .single();
      if (error && error.code !== 'PGRST116') throw error; // PGRST116 = no rows found
      return res.json({ task: (data && data.query) ? data : null });
    } catch (err) { return res.status(500).json({ error: err.message }); }
  }

  // ── brief-task-set ──────────────────────────────────────────────────────
  if (action === 'brief-task-set') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const { userId, project, query } = req.body || {};
    if (!userId || !query) return res.status(400).json({ error: 'userId and query required' });
    try {
      const { error } = await supabase.from('brief_tasks').upsert({
        user_id:    userId,
        project:    project || '',
        query,
        updated_at: new Date().toISOString()
      }, { onConflict: 'user_id' });
      if (error) throw error;
      return res.json({ ok: true });
    } catch (err) { return res.status(500).json({ error: err.message }); }
  }

  // ── brief-task-clear ────────────────────────────────────────────────────
  if (action === 'brief-task-clear') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const { userId } = req.body || {};
    if (!userId) return res.status(400).json({ error: 'userId required' });
    try {
      const { error } = await supabase.from('brief_tasks').delete().eq('user_id', userId);
      if (error) throw error;
      return res.json({ ok: true });
    } catch (err) { return res.status(500).json({ error: err.message }); }
  }

  res.status(400).json({ error: 'Unknown action: ' + action });
};
