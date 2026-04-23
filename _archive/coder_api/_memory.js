// api/_memory.js -- Mobius Memory System
// Connects to the Mobius General Supabase project.
// Env vars: GENERAL_SUPABASE_URL, GENERAL_SUPABASE_KEY, GEMINI_API_KEY
//
// Four tables:
//   memory_general -- raw write-only intake, never queried at runtime
//   memory_user    -- distilled user facts (preferences, working style)
//   memory_tools   -- distilled tool patterns and lessons
//   memory_project -- distilled project decisions and outcomes

const { createClient } = require('@supabase/supabase-js');

// Lazy-initialise -- prevents module-load crash if env vars are missing at startup.
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

// -- Generate embedding vector via Google text-embedding-004 -------------------
// Returns float array of 768 dimensions, or null on failure.

async function generateEmbedding(text) {
  try {
    const key = process.env.GEMINI_API_KEY;
    if (!key) return { value: null, error: 'GEMINI_API_KEY not set' };
    const res = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=' + key,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: { parts: [{ text }] }, outputDimensionality: 768 })
      }
    );
    const json = await res.json();
    if (!json?.embedding?.values) {
      const detail = (json?.error?.message || JSON.stringify(json).slice(0, 200));
      console.error('[Memory] generateEmbedding null -- HTTP', res.status, detail);
      return { value: null, error: 'HTTP ' + res.status + ': ' + detail };
    }
    // Supabase PostgREST requires vector as string "[x,y,z]" not raw array
    return { value: '[' + json.embedding.values.join(',') + ']', error: null };
  } catch (err) {
    console.error('[Memory] generateEmbedding exception:', err.message);
    return { value: null, error: err.message };
  }
}

// -- Write raw entry to memory_general -----------------------------------------

async function writeGeneral(userId, content, source, sessionId) {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: existing } = await db().from('memory_general')
      .select('id')
      .eq('user_id', userId)
      .eq('content', content)
      .gte('created_at', since)
      .limit(1);
    if (existing && existing.length > 0) {
      console.log('[Memory] writeGeneral skipped -- duplicate content within 24h');
      return true;
    }
    const { error } = await db().from('memory_general').insert([{
      user_id:    userId,
      content,
      source:     source    || null,
      session_id: sessionId || null,
      created_at: new Date().toISOString()
    }]);
    if (error) throw error;
    return true;
  } catch (err) {
    console.error('[Memory] writeGeneral failed:', err.message);
    return false;
  }
}

// -- Search working tables -- vector search with keyword fallback --------------
// Primary: cosine similarity via match_memories RPC (pgvector).
// Fallback: keyword overlap scoring if embedding unavailable.
// Returns a single string block, best matches first, capped at 5000 chars.

async function searchMemory(userId, query) {
  try {
    const { value: embedding } = await generateEmbedding(query);

    if (embedding) {
      const { data, error } = await db().rpc('match_memories', {
        query_embedding: embedding,  // string "[x,y,z]" format required by PostgREST
        user_id_param:   userId,
        match_count:     15
      });
      if (error) throw error;
      if (data && data.length > 0) {
        // Group by table_name so each category header appears only once.
        // Prevents models from reading repeated [project] prefixes as separate context sections.
        const grouped = {};
        for (const r of data) {
          if (!grouped[r.table_name]) grouped[r.table_name] = [];
          grouped[r.table_name].push(r.content);
        }
        let total = 0;
        const lines = [];
        for (const [table, contents] of Object.entries(grouped)) {
          if (total >= 5000) break;
          const header = '[' + table + ']';
          lines.push(header);
          total += header.length + 1;
          for (const c of contents) {
            if (total >= 5000) break;
            lines.push(c);
            total += c.length + 1;
          }
        }
        return lines.join('\n');
      }
    }

    // Keyword fallback
    const words = (query || '').toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const [ur, tr, pr, mr] = await Promise.all([
      db().from('memory_user').select('id, content, tags, updated_at')
        .eq('user_id', userId).order('updated_at', { ascending: false }).limit(100),
      db().from('memory_tools').select('id, content, tags, updated_at')
        .eq('user_id', userId).order('updated_at', { ascending: false }).limit(100),
      db().from('memory_project').select('id, content, tags, project_ids, updated_at')
        .eq('user_id', userId).order('updated_at', { ascending: false }).limit(100),
      db().from('memory_mobius').select('id, content, tags, app_ids, updated_at')
        .eq('user_id', userId).order('updated_at', { ascending: false }).limit(100),
    ]);

    function score(row) {
      const text = (
        (row.content || '') + ' ' +
        (row.tags || []).join(' ') + ' ' +
        (row.project_ids || row.app_ids || []).join(' ')
      ).toLowerCase();
      return words.reduce((acc, w) => acc + (text.includes(w) ? 1 : 0), 0);
    }

    const all = [
      ...(ur.data || []).map(r => ({ ...r, _label: 'user'    })),
      ...(tr.data || []).map(r => ({ ...r, _label: 'tools'   })),
      ...(pr.data || []).map(r => ({ ...r, _label: 'project' })),
      ...(mr.data || []).map(r => ({ ...r, _label: 'mobius'  })),
    ]
    .map(r => ({ ...r, _score: score(r) }))
    .sort((a, b) => b._score - a._score || new Date(b.updated_at) - new Date(a.updated_at));

    let total = 0;
    const lines = [];
    for (const r of all) {
      if (total >= 5000) break;
      const line = '[' + r._label + '] ' + r.content;
      total += line.length + 1;
      lines.push(line);
    }
    return lines.join('\n');

  } catch (err) {
    console.error('[Memory] searchMemory failed:', err.message);
    return '';
  }
}

// -- View recent entries from all working tables --------------------------------

async function viewMemory(userId, limit) {
  limit = Math.min(limit || 15, 50);
  try {
    const [ur, tr, pr, mr] = await Promise.all([
      db().from('memory_user')
        .select('id, content, tags, updated_at')
        .eq('user_id', userId).order('updated_at', { ascending: false }).limit(limit),
      db().from('memory_tools')
        .select('id, content, tags, updated_at')
        .eq('user_id', userId).order('updated_at', { ascending: false }).limit(limit),
      db().from('memory_project')
        .select('id, content, tags, project_ids, file_refs, updated_at')
        .eq('user_id', userId).order('updated_at', { ascending: false }).limit(limit),
      db().from('memory_mobius')
        .select('id, content, tags, app_ids, file_refs, updated_at')
        .eq('user_id', userId).order('updated_at', { ascending: false }).limit(limit),
    ]);
    return {
      user:    ur.data || [],
      tools:   tr.data || [],
      project: pr.data || [],
      mobius:  mr.data || []
    };
  } catch (err) {
    console.error('[Memory] viewMemory failed:', err.message);
    return { user: [], tools: [], project: [] };
  }
}

// -- Write directly to a working table -----------------------------------------
// Generates embedding automatically on every write.

async function writeWorking(userId, table, content, tags, projectIds, fileRefs) {
  const valid = ['memory_user', 'memory_tools', 'memory_project', 'memory_mobius'];
  if (!valid.includes(table)) return false;
  try {
    // Exact string dedup
    const { data: existing } = await db().from(table)
      .select('id')
      .eq('user_id', userId)
      .eq('content', content)
      .limit(1);
    if (existing && existing.length > 0) {
      console.log('[Memory] writeWorking skipped -- exact duplicate in ' + table);
      return 'skipped';
    }
    // Generate embedding
    const { value: embedding } = await generateEmbedding(content);
    // Semantic dedup -- skip if a near-identical entry already exists (similarity >= 0.92)
    if (embedding) {
      try {
        const { data: similar } = await db().rpc('match_memories', {
          query_embedding: embedding,
          user_id_param:   userId,
          match_count:     1
        });
        if (similar && similar.length > 0 && similar[0].similarity >= 0.92) {
          console.log('[Memory] writeWorking skipped -- semantic duplicate (' + similar[0].similarity.toFixed(3) + '): ' + similar[0].content.slice(0, 60));
          return 'skipped';
        }
      } catch (dedupErr) {
        console.warn('[Memory] semantic dedup check failed (non-fatal):', dedupErr.message);
      }
    }
    const now = new Date().toISOString();
    const row = {
      user_id:    userId,
      content,
      tags:       tags || [],
      embedding:  embedding || null,
      created_at: now,
      updated_at: now
    };
    if (table === 'memory_project') {
      row.project_ids = projectIds || [];
      row.file_refs   = fileRefs   || [];
    }
    if (table === 'memory_mobius') {
      row.app_ids   = projectIds || [];
      row.file_refs = fileRefs   || [];
    }
    const { error } = await db().from(table).insert([row]);
    if (error) throw error;
    return true;
  } catch (err) {
    console.error('[Memory] writeWorking failed:', err.message);
    return false;
  }
}

// -- Delete from a working table by full UUID ----------------------------------

async function deleteMemory(userId, id) {
  const tables = ['memory_user', 'memory_tools', 'memory_project', 'memory_mobius'];
  for (const table of tables) {
    try {
      const { data } = await db().from(table).select('id').eq('id', id).eq('user_id', userId).limit(1);
      if (data && data.length > 0) {
        const { error } = await db().from(table).delete().eq('id', id).eq('user_id', userId);
        if (error) throw error;
        return true;
      }
    } catch (err) {
      console.error('[Memory] deleteMemory error on ' + table + ':', err.message);
    }
  }
  return false;
}

// -- Distil: synthesise raw memory_general entries into working tables ---------
// Reads entries from the last 48h, sends batch to Gemini Lite for synthesis,
// writes results with embeddings to memory_user / memory_tools / memory_project.

async function distilMemory(userId, askGeminiLite, limit) {
  limit = Math.min(limit || 30, 50);
  try {
    const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const { data, error } = await db().from('memory_general')
      .select('id, content, source')
      .eq('user_id', userId)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw error;
    if (!data || data.length === 0) {
      return { distilled: 0, message: 'Nothing to distil in the last 48 hours.' };
    }

    const batch = data.map((r, i) => (i + 1) + '. ' + r.content).join('\n---\n');

    const prompt = `You are a memory distillation system for a software developer's coding assistant.

Your job is to extract useful, lasting facts from raw conversation fragments and store them cleanly.

Rules:
- Write each fact as a single, standalone declarative statement in your own words.
- Do NOT quote or closely paraphrase the original text. Synthesise the meaning.
- Each statement must make complete sense with zero surrounding context.
- Be specific and concrete -- avoid vague generalisations.
- If one entry contains multiple distinct facts, output one JSON object per fact.
- Discard conversational filler, greetings, and anything that is not a durable fact or decision.
- Max 150 characters per content string.

Classify each fact into one category:
- user: facts about the developer (name, preferences, working style, personal tools)
- tools: reusable technical lessons, patterns, or techniques that apply across projects
- project: decisions, bugs fixed, or architectural choices tied to a specific named project

For each fact output:
- content: the synthesised standalone statement (max 150 chars)
- table: "user" | "tools" | "project"
- tags: 3 to 5 lowercase single-word tags
- project_ids: array of project name strings if table is "project", else []

Entries:
${batch}

Respond ONLY with a valid JSON array. No markdown fences. No explanation.
Example:
[{"content":"Developer prefers British English in all written output","table":"user","tags":["preference","language","british"],"project_ids":[]},{"content":"Coplanar polygon reconstruction requires BFS flood-fill adjacency to separate surfaces correctly","table":"tools","tags":["geometry","bfs","polygon","threejs"],"project_ids":[]},{"content":"GPRTool uses Z-up coordinate system: X=East, Y=North, Z=Up -- matches AutoCAD and ArchiCAD","table":"project","tags":["coordinates","gpr","threejs","cad"],"project_ids":["GPRTool"]}]`;

    const result = await askGeminiLite([{ role: 'user', content: prompt }]);
    let entries;
    try {
      const clean = (result.text || '').replace(/```json|```/g, '').trim();
      entries = JSON.parse(clean);
    } catch {
      console.error('[Memory] distil parse failed. Raw:', (result.text || '').slice(0, 300));
      return { distilled: 0, message: 'Classification parse failed -- Gemini returned unexpected format.' };
    }

    let distilled = 0;
    let skipped = 0;
    for (const e of entries) {
      if (!e.content || !e.table) continue;
      const table = 'memory_' + e.table;
      const result = await writeWorking(userId, table, e.content, e.tags || [], e.project_ids || [], []);
      if (result === 'skipped') skipped++;
      else if (result) distilled++;
    }
    const skipNote = skipped > 0 ? ', ' + skipped + ' deduped' : '';
    return {
      distilled,
      skipped,
      message: data.length + ' raw records -- ' + distilled + ' new' + skipNote + '.'
    };
  } catch (err) {
    console.error('[Memory] distilMemory failed:', err.message);
    return { distilled: 0, message: 'Distil failed: ' + err.message };
  }
}

// -- Count rows in all working tables -----------------------------------------
// Returns real COUNT(*) per table, not capped by viewMemory limit.

async function countMemory(userId) {
  const tables = ['memory_user', 'memory_tools', 'memory_project', 'memory_mobius'];
  const counts = {};
  let total = 0;
  for (const table of tables) {
    try {
      const { count, error } = await db().from(table)
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId);
      if (error) throw error;
      const n = count || 0;
      counts[table.replace('memory_', '')] = n;
      total += n;
    } catch (err) {
      console.error('[Memory] countMemory error on ' + table + ':', err.message);
      counts[table.replace('memory_', '')] = 0;
    }
  }
  counts.total = total;
  return counts;
}

// -- List all rows needing embedding (embedding = null) -----------------------
// Returns flat array of { id, table, content } for client-side loop.

async function embedList(userId) {
  const tables = ['memory_user', 'memory_tools', 'memory_project', 'memory_mobius'];
  const rows = [];
  for (const table of tables) {
    try {
      const { data, error } = await db().from(table)
        .select('id, content')
        .eq('user_id', userId)
        .is('embedding', null)
        .limit(100);
      if (error) throw error;
      for (const row of (data || [])) {
        rows.push({ id: row.id, table, content: row.content });
      }
    } catch (err) {
      console.error('[Memory] embedList error on ' + table + ':', err.message);
    }
  }
  return rows;
}

// -- Embed a single row by ID -------------------------------------------------
// Called per-row from the client loop -- guaranteed to finish within 2s.

async function embedOne(userId, id, table, content) {
  try {
    const { value: embedding, error: embedErr } = await generateEmbedding(content);
    if (!embedding) return { ok: false, error: 'generateEmbedding failed: ' + embedErr };
    const { data: updated, error } = await db().from(table).update({
      embedding,
      updated_at: new Date().toISOString()
    }).eq('id', id).eq('user_id', userId).select('id');
    if (error) throw error;
    if (!updated || updated.length === 0) {
      console.warn('[Memory] embedOne: update matched 0 rows -- id:', id, 'userId:', userId);
      return { ok: false, error: 'update matched 0 rows' };
    }
    return { ok: true };
  } catch (err) {
    console.error('[Memory] embedOne failed:', err.message);
    return { ok: false, error: err.message };
  }
}

// -- Update content of a working table entry by UUID --------------------------
// Re-generates embedding for the new content.

async function updateMemory(userId, id, content) {
  const tables = ['memory_user', 'memory_tools', 'memory_project', 'memory_mobius'];
  for (const table of tables) {
    try {
      const { data } = await db().from(table).select('id').eq('id', id).eq('user_id', userId).limit(1);
      if (data && data.length > 0) {
        const { value: embedding } = await generateEmbedding(content);
        const { error } = await db().from(table).update({
          content,
          embedding: embedding || null,
          updated_at: new Date().toISOString()
        }).eq('id', id).eq('user_id', userId);
        if (error) throw error;
        return true;
      }
    } catch (err) {
      console.error('[Memory] updateMemory error on ' + table + ':', err.message);
    }
  }
  return false;
}

module.exports = {
  writeGeneral,
  searchMemory,
  viewMemory,
  writeWorking,
  deleteMemory,
  distilMemory,
  countMemory,
  updateMemory,
  embedList,
  embedOne
};
