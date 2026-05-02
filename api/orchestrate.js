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

const { askTavilySearch, askGoogleSearch, askGeminiLite, askGroqCascade }   = require('./_ai.js');
const { supabase }                                                 = require('./_supabase.js');
const { CONFIG, TASK_AIS, raceAtLeast, generatePromptSuggestions, evaluateAnswers, buildTaskPrompt } = require('./_exec.js');

// ── Source discovery ──────────────────────────────────────────────────────────
// Primary: Tavily /search (1,000 credits/mo free, renews monthly, no CC required).
//          Returns URLs + an LLM-summarised answer (free RAG grounding).
// Fallback: Gemini grounding (requires paid Gemini tier for reliable quota).
// Returns { urls, answer, webChunks, searchQueries, searchEntryPoint, modelUsed }.
// On failure returns the same shape with empty fields so callers never see undefined.
// ── Web search gate ───────────────────────────────────────────────────────────
// Decides whether the query actually requires live web sources, or whether the
// Task AIs can answer from training data + conversation context alone. A small
// fast model (Gemini Lite, Groq fallback) returns strict JSON {needs_web, reason}.
// Skip triggers: conversational replies, opinions, creative writing, pure code
// questions, follow-ups that only reference the prior answer.
// Fire triggers: current events, prices/stats, post-cutoff facts, named
// entities whose status may have changed, "latest/recent/today/now".
// Defaults to TRUE on any failure -- safer to over-search than under-inform.
async function shouldSearchWeb(query, history, lastResponse) {
  const recentContext = Array.isArray(history) && history.length
    ? history.slice(-2).map(h => '[1] Previous Query: ' + String(h.q || '').slice(0, 200) + '\n[2] Previous Response: ' + String(h.a || '').slice(0, 800)).join('\n\n')
    : '(no prior context)';
  const prompt =
    'You are a router. Decide if this user query REQUIRES live web search or can ' +
    'be answered from general knowledge + conversation context alone.\n\n' +
    'Recent queries (for context):\n' + recentContext + '\n\n' +
    'Last response excerpt:\n' + String(lastResponse || '(none)').slice(0, 600) + '\n\n' +
    'NEW query: "' + query + '"\n\n' +
    'Respond with strict JSON, no preamble, no markdown:\n' +
    '{"needs_web": true|false, "reason": "<one short sentence>"}\n\n' +
    'needs_web = TRUE for: current events, today\'s prices, latest news, sports ' +
    'scores, named people/companies/products whose status may have changed, ' +
    'facts that post-date early 2025, explicit recent dates.\n' +
    'needs_web = FALSE for: conversational replies, opinions, creative writing, ' +
    'pure code/algorithm questions, timeless concepts, follow-ups asking to ' +
    'rephrase/expand/explain the PREVIOUS answer, clarifications.';

  for (const askFn of [
    () => askGeminiLite([{ role: 'user', content: prompt }]),
    () => askGroqCascade([{ role: 'user', content: prompt }])
  ]) {
    try {
      const r = await askFn();
      const text = (r.text || '').trim();
      const m = text.match(/\{[\s\S]*\}/);
      if (m) {
        const parsed = JSON.parse(m[0]);
        if (typeof parsed.needs_web === 'boolean') {
          console.log('[web-gate] needs_web=' + parsed.needs_web + ' -- ' + String(parsed.reason || '').slice(0, 100));
          return parsed.needs_web;
        }
      }
    } catch { /* try fallback */ }
  }
  console.warn('[web-gate] no decisive response, defaulting to needs_web=true');
  return true;
}

async function discoverSources(query, history = [], lastResponse = '') {
  // Gate: skip web search when the query doesn't warrant it (saves Tavily
  // credits and avoids grounding irrelevant pages for conversational replies).
  try {
    const needsWeb = await shouldSearchWeb(query, history, lastResponse);
    if (!needsWeb) {
      return { urls: [], answer: '', webChunks: [], searchQueries: [], searchEntryPoint: '', modelUsed: 'skipped (gate)' };
    }
  } catch (gateErr) {
    console.warn('[orchestrate] web-gate failed, defaulting to search:', gateErr.message);
  }
  try {
    return await askTavilySearch(query, 25);
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
// Prompt-building logic is shared with orchestrate-stream.js via buildTaskPrompt
// in _exec.js -- keep them in sync by editing that single function.
async function runExecution(query, approvedPrompt, selectedSources, today, relevantHistory = '') {
  const results = await raceAtLeast(
    TASK_AIS.map(ai => ({
      id:      ai.id,
      label:   ai.label,
      promise: ai.call([{ role: 'user',
        content: buildTaskPrompt(ai.persona, approvedPrompt, query, selectedSources, today, relevantHistory)
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

// Persist every Task AI response (both Step 1 suggestions AND Step 6 answers) so
// they can be reviewed later in Supabase. Fire-and-forget: DB failure warns but
// does not break the user-facing response.
//   phase = 'suggestion' (Step 1 prompt rewrites) | 'execution' (Step 6 answers)
//   evaluation is optional; included rows get score_total + score_note populated
async function logTaskResponses(queryId, phase, responses, evaluation = null) {
  if (!queryId || !Array.isArray(responses) || responses.length === 0) return;
  try {
    const rows = responses.map((r, i) => ({
      query_id:    queryId,
      phase,
      ai_id:       r.id      || r.aiId     || null,
      ai_label:    r.label   || r.aiLabel  || null,
      model_used:  r.model   || r.modelUsed || null,
      text:        r.text    || '',
      failed:      Boolean(r.failed) || !(r.text && r.text.length > 0),
      ms:          r.ms      || null,
      score_total: evaluation?.scores?.[i]?.score?.total ?? null,
      score_note:  evaluation?.scores?.[i]?.score?.note  ?? null
    }));
    const { error } = await supabase.from('mobius_task_responses').insert(rows);
    if (error) throw error;
    console.log('[logTaskResponses] ' + phase + ': saved ' + rows.length + ' rows for query ' + queryId);
  } catch (err) {
    console.warn('[logTaskResponses] failed (' + phase + '):', err.message);
  }
}

// ── Main handler ──────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { step, query, feedback, approved_prompt, selected_sources, query_id, today, history, last_response, relevant_history } = req.body || {};
  const userId = (req.headers.cookie || '').split(';').map(c => c.trim())
    .find(c => c.startsWith('mobius_user_id='))?.split('=')[1] || req.body?.userId || null;

  if (!query) return res.status(400).json({ error: 'query is required' });

  // ── Step 1: Prompt suggestions + source discovery ────────────────────────────
  if (!step || step === 1) {
    const qId = await logQuery(userId, query);
    try {
      const promptResult = await generatePromptSuggestions(query, feedback || '', today, history || [], last_response || '');
      const grounding    = await discoverSources(promptResult.synthesised || query, history || [], last_response || '');

      // Persist the 5 prompt-rewrite suggestions for later review
      await logTaskResponses(qId, 'suggestion', promptResult.suggestions || []);

      return res.json({
        query_id:           qId,
        suggestions:        promptResult.suggestions,
        synthesised_prompt: promptResult.synthesised,
        relevant_history:   promptResult.relevant_history,
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
      const answers    = await runExecution(query, approved_prompt, selected_sources || [], today, relevant_history);
      const evaluation = await evaluateAnswers(query, answers);

      // Persist the 5 Task AI answers with their evaluation scores
      await logTaskResponses(query_id, 'execution', answers, evaluation);

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

// Named export so orchestrate-stream.js can import logTaskResponses for Step 2 logging
module.exports.logTaskResponses = logTaskResponses;
