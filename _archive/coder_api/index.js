// api/index.js -- Code Index handler
// Semantic index of source files for project-aware AI context.
// Tables: code_index (file summaries), code_chunks (function-level code) in General Supabase.
// Sub-actions: index-file, index-search, index-list, index-clear,
//              chunk-file, chunk-search, chunk-clear

const { createClient } = require('@supabase/supabase-js');
const { askGeminiLite } = require('./_ai.js');

let _db = null;
function db() {
  if (!_db) {
    const url = process.env.GENERAL_SUPABASE_URL;
    const key = process.env.GENERAL_SUPABASE_KEY;
    if (!url || !key) throw new Error('GENERAL_SUPABASE_URL or GENERAL_SUPABASE_KEY not set.');
    _db = createClient(url, key);
  }
  return _db;
}

async function generateEmbedding(text) {
  try {
    const key = process.env.GEMINI_API_KEY;
    if (!key) return null;
    const res = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=' + key,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: { parts: [{ text }] }, outputDimensionality: 768 })
      }
    );
    const json = await res.json();
    if (!json?.embedding?.values) return null;
    return '[' + json.embedding.values.join(',') + ']';
  } catch { return null; }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { sub, userId: bodyUserId, project, filePath, content, lineCount, query, chunks } = req.body || {};
  const cookieHeader  = req.headers.cookie || '';
  const cookieUserId  = cookieHeader.split(';').map(c => c.trim())
    .find(c => c.startsWith('mobius_user_id='))?.split('=')[1] || null;
  const userId = cookieUserId || bodyUserId || process.env.MOBIUS_TEST_USER_ID || '22008c93-c79b-491d-b3c1-efa194c0c871';

  try {

    // -- index-file: summarise one file and store with embedding -----------------
    if (sub === 'index-file') {
      if (!project || !filePath || !content) {
        return res.status(400).json({ ok: false, error: 'project, filePath, and content are required' });
      }

      const prompt = 'Analyse this source file and respond ONLY with valid JSON (no markdown):\n'
        + '{"summary":"1-2 sentences on what this file does","symbols":["key function/class names max 10"],"dependencies":["relative imports only max 8"]}\n\n'
        + 'File: ' + filePath + '\n---\n' + content.slice(0, 4000);

      let summary      = filePath;
      let symbols      = [];
      let dependencies = [];

      try {
        const r  = await askGeminiLite([{ role: 'user', content: prompt }]);
        const parsed = JSON.parse((r.text || '').replace(/```json|```/g, '').trim());
        if (parsed.summary)      summary      = parsed.summary;
        if (parsed.symbols)      symbols      = parsed.symbols;
        if (parsed.dependencies) dependencies = parsed.dependencies;
      } catch (e) {
        console.warn('[Index] Gemini parse failed for', filePath, ':', e.message);
      }

      const embedding = await generateEmbedding(summary + ' ' + symbols.join(' '));

      const { error } = await db().from('code_index').upsert([{
        user_id:      userId,
        project,
        file_path:    filePath,
        summary,
        symbols,
        dependencies,
        line_count:   lineCount || 0,
        embedding:    embedding || null,
        indexed_at:   new Date().toISOString()
      }], { onConflict: 'user_id,project,file_path' });

      if (error) throw error;
      return res.json({ ok: true, summary });
    }

    // -- index-search: hybrid search -- filename-direct first, then vector ----
    if (sub === 'index-search') {
      if (!project || !query) return res.json({ files: [] });

      // Extract any filenames mentioned in the query (e.g. 'js/codeindex.js', 'log.js')
      const fnPat = /\b([\w\-\/]+\.(?:js|html|md|json|css|ts))\b/gi;
      const mentioned = [];
      let fm;
      while ((fm = fnPat.exec(query)) !== null) mentioned.push(fm[1].split('/').pop());

      // Direct filename lookup for each mentioned file
      const direct = [];
      for (const base of mentioned) {
        const { data } = await db().from('code_index')
          .select('file_path, summary, symbols')
          .eq('user_id', userId).eq('project', project)
          .ilike('file_path', '%' + base + '%').limit(2);
        (data || []).forEach(r => { if (!direct.find(d => d.file_path === r.file_path)) direct.push(r); });
      }

      // Vector search to fill remaining slots
      const embedding = await generateEmbedding(query);
      let vector = [];
      if (embedding) {
        const { data } = await db().rpc('search_code_index', {
          query_embedding: embedding, user_id_param: userId,
          project_param: project, match_count: 5
        });
        vector = (data || []).filter(r => !direct.find(d => d.file_path === r.file_path));
      } else if (!direct.length) {
        const { data } = await db().from('code_index')
          .select('file_path, summary, symbols')
          .eq('user_id', userId).eq('project', project)
          .order('indexed_at', { ascending: false }).limit(5);
        vector = data || [];
      }

      return res.json({ files: [...direct, ...vector].slice(0, 5) });
    }

    // -- index-list: all files for a project --------------------------------------
    if (sub === 'index-list') {
      const q = db().from('code_index')
        .select('file_path, summary, line_count, indexed_at')
        .eq('user_id', userId)
        .order('file_path', { ascending: true });
      if (project) q.eq('project', project);
      const { data, error } = await q;
      if (error) throw error;
      return res.json({ files: data || [] });
    }

    // -- index-clear: delete all entries for a project ----------------------------
    if (sub === 'index-clear') {
      if (!project) return res.status(400).json({ ok: false, error: 'project is required' });
      const { error } = await db().from('code_index')
        .delete().eq('user_id', userId).eq('project', project);
      if (error) throw error;
      return res.json({ ok: true });
    }

    // -- chunk-file: store pre-parsed function chunks with embeddings ---------------
    if (sub === 'chunk-file') {
      if (!project || !filePath || !chunks?.length)
        return res.status(400).json({ ok: false, error: 'project, filePath, chunks required' });

      let stored = 0;
      for (const chunk of chunks) {
        const embedText = chunk.name + ' ' + chunk.code.slice(0, 300);
        const embedding = await generateEmbedding(embedText);
        const { error } = await db().from('code_chunks').upsert([{
          user_id:    userId,
          project,
          file_path:  filePath,
          chunk_name: chunk.name,
          chunk_type: chunk.type || 'function',
          code:       chunk.code,
          start_line: chunk.startLine || 0,
          end_line:   chunk.endLine   || 0,
          embedding:  embedding || null,
          indexed_at: new Date().toISOString()
        }], { onConflict: 'user_id,project,file_path,chunk_name' });
        if (!error) stored++;
        else console.warn('[Chunk] upsert error for', chunk.name, ':', error.message);
      }
      return res.json({ ok: true, stored });
    }

    // -- chunk-search: three-stage hybrid retrieval ----------------------------
    // Stage 1: function name lookup -- finds the exact function asked about
    // Stage 2: file-scoped vector search -- most relevant chunks from mentioned files
    // Stage 3: global vector search -- anything else semantically similar
    if (sub === 'chunk-search') {
      if (!project || !query) return res.json({ chunks: [] });

      const seen = (arr, r) => arr.find(d => d.file_path === r.file_path && d.chunk_name === r.chunk_name);
      const add  = (arr, rows) => (rows || []).forEach(r => { if (!seen(arr, r)) arr.push(r); });
      const results = [];

      // Extract filenames mentioned in query (e.g. 'commands.js')
      const filePat = /\b([\w\-\/]+\.(?:js|html|md|json|css|ts))\b/gi;
      const fileNames = [];
      let fm;
      while ((fm = filePat.exec(query)) !== null) fileNames.push(fm[1].split('/').pop());

      // Extract camelCase function names mentioned in query (e.g. 'sendToAI', 'getCodeContext')
      // Pattern: starts lowercase, contains at least one uppercase letter, length >= 4
      const camelPat = /\b([a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*)\b/g;
      const fnNames = [];
      let cm;
      while ((cm = camelPat.exec(query)) !== null) {
        if (cm[1].length >= 4) fnNames.push(cm[1]);
      }

      // Stage 1: look up specific function names by chunk_name
      // If a filename was also mentioned, restrict to that file for precision
      for (const name of fnNames) {
        let q2 = db().from('code_chunks')
          .select('file_path, chunk_name, chunk_type, code, start_line')
          .eq('user_id', userId).eq('project', project)
          .ilike('chunk_name', '%' + name + '%');
        if (fileNames.length) q2 = q2.ilike('file_path', '%' + fileNames[0] + '%');
        const { data } = await q2.limit(2);
        add(results, data);
      }

      // Stage 2: file-scoped vector search -- most relevant chunks from mentioned files
      // Uses vector similarity restricted to the mentioned file so we get relevant,
      // not just insertion-order, chunks from that file
      const embedding = await generateEmbedding(query);
      if (embedding && fileNames.length) {
        // Get top vector matches globally, then filter to mentioned file
        const { data: vecData } = await db().rpc('search_code_chunks', {
          query_embedding: embedding, user_id_param: userId,
          project_param: project, match_count: 15
        });
        const fileScoped = (vecData || []).filter(r =>
          fileNames.some(fn => r.file_path && r.file_path.toLowerCase().includes(fn.replace('.js','')))
        );
        add(results, fileScoped);
      }

      // Stage 3: global vector search for remaining slots
      if (results.length < 5 && embedding) {
        const { data: vecData } = await db().rpc('search_code_chunks', {
          query_embedding: embedding, user_id_param: userId,
          project_param: project, match_count: 5
        });
        add(results, vecData);
      }

      return res.json({ chunks: results.slice(0, 5) });
    }

    // -- chunk-clear: delete all chunks for a project ----------------------------
    if (sub === 'chunk-clear') {
      if (!project) return res.status(400).json({ ok: false, error: 'project required' });
      const { error } = await db().from('code_chunks')
        .delete().eq('user_id', userId).eq('project', project);
      if (error) throw error;
      return res.json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown sub-action: ' + sub });

  } catch (err) {
    console.error('[Index] handler error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
