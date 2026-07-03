// rake-index.mjs
// Extracts keywords/topics per chunk (mobius_docs) and per message
// (mobius_messages) using RAKE — no API calls, pure text processing.
// Writes to mobius_topics: term, score, source_table, source_id, filename.
// Requires mobius_topics to exist first (see migration SQL).
import { createClient } from '@supabase/supabase-js';
import rake from 'node-rake';

const MAX_TERMS_PER_ITEM = 8;

// node-rake throws (rather than returning []) on empty or punctuation-only
// text, so every call needs to be guarded.
function safeGenerate(text) {
  try {
    return rake.generate(text || '') || [];
  } catch {
    return [];
  }
}

// node-rake returns an array of phrase strings, already ranked highest-first —
// no numeric score is exposed, so rank position is used as a proxy: term 0
// scores MAX_TERMS_PER_ITEM, last scores 1.
function scoreByRank(terms) {
  return terms.slice(0, MAX_TERMS_PER_ITEM).map((term, i) => ({
    term, score: MAX_TERMS_PER_ITEM - i,
  }));
}

export async function rakeIndexDocs(supabaseUrl, supabaseKey) {
  const supabase = createClient(supabaseUrl, supabaseKey);
  let from = 0, processed = 0, termsWritten = 0;
  while (true) {
    const { data: rows, error } = await supabase
      .from('mobius_docs')
      .select('id, chunk, filename')
      .range(from, from + 499);
    if (error) { console.error('[rake-docs] fetch error:', error.message); break; }
    if (!rows?.length) break;

    const topicRows = [];
    for (const row of rows) {
      const terms = scoreByRank(safeGenerate(row.chunk));
      for (const t of terms) {
        topicRows.push({
          term: t.term, score: t.score,
          source_table: 'mobius_docs', source_id: row.id,
          filename: row.filename,
        });
      }
      processed++;
    }
    if (topicRows.length) {
      const { error: insErr } = await supabase.from('mobius_topics').insert(topicRows);
      if (insErr) console.warn('[rake-docs] insert error:', insErr.message);
      else termsWritten += topicRows.length;
    }
    from += 500;
    if (rows.length < 500) break;
  }
  console.log(`[rake-docs] done — ${processed} chunks processed, ${termsWritten} terms written`);
  return { processed, termsWritten };
}

export async function rakeIndexMessages(supabaseUrl, supabaseKey) {
  const supabase = createClient(supabaseUrl, supabaseKey);
  const { data: rows, error } = await supabase
    .from('mobius_messages')
    .select('id, content');
  if (error) { console.error('[rake-msgs] fetch error:', error.message); return { processed: 0, termsWritten: 0 }; }

  let processed = 0, termsWritten = 0;
  const topicRows = [];
  for (const row of rows || []) {
    const terms = scoreByRank(safeGenerate(row.content));
    for (const t of terms) {
      topicRows.push({
        term: t.term, score: t.score,
        source_table: 'mobius_messages', source_id: row.id,
        filename: null,
      });
    }
    processed++;
  }
  if (topicRows.length) {
    const { error: insErr } = await supabase.from('mobius_topics').insert(topicRows);
    if (insErr) console.warn('[rake-msgs] insert error:', insErr.message);
    else termsWritten = topicRows.length;
  }
  console.log(`[rake-msgs] done — ${processed} messages processed, ${termsWritten} terms written`);
  return { processed, termsWritten };
}
