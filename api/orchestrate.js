// api/orchestrate.js
// POST /orchestrate  { step:1, query, feedback? }
//   Parallel: (A) 5 Task AIs suggest prompt rewrites + Brief AI synthesises
//             (B) Source discovery (placeholder -- returns empty until search integrated)
//   Returns: { query_id, suggestions, synthesised_prompt, sources }
//
// POST /orchestrate  { step:2, query_id, query, approved_prompt, selected_sources }
//   5 Task AIs answer, race on first 3 (max 2 min for all 5), evaluate, return summary
//   Returns: { answers, evaluation }

'use strict';

const { askTavilySearch, askGoogleSearch }                         = require('./_ai.js');
const { supabase }                                                 = require('./_supabase.js');
const { CONFIG, TASK_AIS, raceAtLeast, generatePromptSuggestions, evaluateAnswers } = require('./_exec.js');

// ── Source discovery ──────────────────────────────────────────────────────────
// Primary: Tavily /search (1,000 credits/mo free, renews monthly, no CC required).
//          Returns URLs + an LLM-summarised answer (free RAG grounding).
// Fallback: Gemini grounding (requires paid Gemini tier for reliable quota).
// Returns { urls, answer, webChunks, searchQueries, searchEntryPoint, modelUsed }.
// On failure returns the same shape with empty fields so callers never see undefined.
async function discoverSources(query) {
  try {
    return await askTavilySearch(query, 20);
  } catch (tvErr) {
    console.warn('[orchestrate] Tavily search failed:', tvErr.message);
  }
  try {
    return await askGoogleSearch(query, 20);
  } catch (err) {
    console.warn('[orchestrate] Gemini grounding fallback also failed:', err.message);
    return { urls: [], answer: '', webChunks: [], searchQueries: [], searchEntryPoint: '', modelUsed: null };
  }
}

// ── Execution ─────────────────────────────────────────────────────────────────
// Fire all 5 Task AIs with the approved prompt + ACTUAL CONTENT from selected sources.
// Race: proceed when raceMin respond; wait full timeout for the rest.
//
// Anti-hallucination design: Task AIs receive the full cleaned article text for each
// selected source, not just URL + title. This lets them quote and cite real content
// instead of fabricating based on URL patterns alone. Raw content is truncated per
// source to keep total prompt under ~12K tokens (safe for every model in the lineup).
async function runExecution(query, approvedPrompt, selectedSources) {
  // Per-source truncation budget. 3000 chars ≈ 750 tokens. With 5 sources that's
  // ~3750 tokens of RAG context -- comfortable even for the smallest Task AIs.
  const MAX_CHARS_PER_SOURCE = 3000;

  let sourceContext = '';
  if (selectedSources.length > 0) {
    sourceContext = '\n\n=== SOURCE MATERIAL ===\n' +
      'Base your answer strictly on the following sources. Quote and cite them by URL. ' +
      'If the sources do not contain the information needed, say so explicitly rather than guessing.\n\n' +
      selectedSources.map((s, i) => {
        const content = (s.raw_content || s.description || '').trim();
        const truncated = content.length > MAX_CHARS_PER_SOURCE
          ? content.slice(0, MAX_CHARS_PER_SOURCE) + '... [truncated]'
          : content;
        return '--- Source ' + (i + 1) + ': ' + (s.title || s.url) + ' ---\n' +
               'URL: ' + s.url + '\n' +
               (truncated ? '\n' + truncated + '\n' : '(no content available)\n');
      }).join('\n') +
      '\n=== END SOURCE MATERIAL ===\n';
  }

  const results = await raceAtLeast(
    TASK_AIS.map(ai => ({
      id:      ai.id,
      label:   ai.label,
      promise: ai.call([{ role: 'user', content:
        ai.persona + '\n\n' + approvedPrompt + sourceContext + '\n\nQuery: ' + query
      }])
    })),
    CONFIG.raceMin
  );

  return results
    .filter(r => r.value && (r.value.text || '').length > 20)
    .map(r => ({
      aiId:      r.id,
      aiLabel:   r.label,
      text:      r.value.text,
      modelUsed: r.value.modelUsed || r.id
    }));
}

// ── Supabase logging ──────────────────────────────────────────────────────────
async function logQuery(userId, query) {
  try {
    const { data, error } = await supabase.from('mobius_queries').insert([{
      user_id: userId || null,
      user_query: query,
      query_timestamp: new Date().toISOString(),
      final_status: 'in_progress'
    }]).select('query_id').single();
    if (error) throw error;
    return data.query_id;
  } catch { return null; }
}

// ── Main handler ──────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { step, query, feedback, approved_prompt, selected_sources, query_id } = req.body || {};
  const userId = (req.headers.cookie || '').split(';').map(c => c.trim())
    .find(c => c.startsWith('mobius_user_id='))?.split('=')[1] || req.body?.userId || null;

  if (!query) return res.status(400).json({ error: 'query is required' });

  // ── Step 1: Prompt suggestions + source discovery ────────────────────────────
  if (!step || step === 1) {
    const qId = await logQuery(userId, query);
    try {
      const [promptResult, grounding] = await Promise.all([
        generatePromptSuggestions(query, feedback || ''),
        discoverSources(query)
      ]);
      return res.json({
        query_id:           qId,
        suggestions:        promptResult.suggestions,
        synthesised_prompt: promptResult.synthesised,
        sources:            grounding.urls,           // array, back-compat with client
        grounding: {                                  // new -- richer grounding payload
          modelUsed:         grounding.modelUsed,
          answer:            grounding.answer,
          searchQueries:     grounding.searchQueries,
          searchEntryPoint:  grounding.searchEntryPoint,
          webChunks:         grounding.webChunks
        }
      });
    } catch (err) {
      console.error('[Orchestrate Step 1]', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // ── Step 2: Execution + evaluation (non-streaming fallback) ──────────────────
  if (step === 2) {
    if (!approved_prompt) return res.status(400).json({ error: 'approved_prompt required' });
    try {
      const answers    = await runExecution(query, approved_prompt, selected_sources || []);
      const evaluation = await evaluateAnswers(query, answers);
      try {
        await supabase.from('mobius_queries').update({
          gate1_best_prompt: approved_prompt,
          gate2_passed:      true,
          final_status:      'success'
        }).eq('query_id', query_id);
      } catch { /* non-fatal */ }
      return res.json({ answers, evaluation });
    } catch (err) {
      console.error('[Orchestrate Step 2]', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(400).json({ error: 'step must be 1 or 2' });
};
