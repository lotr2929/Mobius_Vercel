// api/orchestrate.js
// POST /orchestrate  { step:1, query }
//   -> Gate 1 (prompt consensus) + Gate 1.5 (source consensus)
//   -> returns { query_id, consensus_prompt, sources, gate1, gate15 }
//
// POST /orchestrate  { step:2, query_id, query, consensus_prompt, selected_sources }
//   -> Execution (9 AIs answer) + Gate 2 (answer consensus)
//   -> returns { answer, citations, gate2, scores }

'use strict';

const { askGeminiCascade, askGoogleSearch } = require('./_ai.js');
const { supabase }                          = require('./_supabase.js');
const { CONFIG, TASK_AIS, raceAtLeast, evaluateItem, checkConsensus, runGate2 } = require('./_exec.js');

// ── Gate 1: Prompt Consensus ──────────────────────────────────────────────────
async function runGate1(query, previousFeedback = '') {
  const log = [];
  let bestPrompt = null;
  let bestScore = 0;
  const allCandidates = []; // collect across all iterations for alternatives

  for (let iter = 1; iter <= CONFIG.maxGate1Iterations; iter++) {
    const feedbackNote = previousFeedback
      ? '\n\nPrevious attempt feedback: ' + previousFeedback
      : '';

    // Step 1: All 5 task AIs generate a prompt in parallel
    const promptResults = await Promise.allSettled(
      TASK_AIS.map(ai => ai.call([{
        role: 'user',
        content: `${ai.persona}\n\nGenerate the BEST prompt to answer this query: "${query}"${feedbackNote}\n\nOutput ONLY the prompt text. No preamble, no explanation.`
      }]))
    );

    const prompts = promptResults.map((r, i) =>
      r.status === 'fulfilled'
        ? { aiId: TASK_AIS[i].id, text: r.value.text?.trim() || '', modelUsed: r.value.modelUsed }
        : { aiId: TASK_AIS[i].id, text: query, modelUsed: 'fallback' }
    ).filter(p => p.text.length > 10);

    // Step 2: Evaluate each prompt with all 5 evaluators in parallel
    const evalResults = await Promise.allSettled(
      prompts.map(p => evaluateItem(p.text, 'Query: ' + query))
    );

    const evaluated = prompts.map((p, i) => {
      const scores = evalResults[i].status === 'fulfilled' ? evalResults[i].value
        : Array(CONFIG.evaluatorCount).fill({ total: 50, reasoning: 'eval failed' });
      const consensus = checkConsensus(scores);
      return { ...p, scores, consensus };
    });

    // Find best prompt
    const best = evaluated.sort((a, b) => b.consensus.avgScore - a.consensus.avgScore)[0];
    if (best.consensus.avgScore > bestScore) {
      bestScore = best.consensus.avgScore;
      bestPrompt = best.text;
    }

    const iteration = { iter, prompts: evaluated.length, best: best.consensus };
    log.push(iteration);
    allCandidates.push(...evaluated);

    if (best.consensus.passed) {
      return { passed: true, prompt: best.text, iterations: iter, log, avgScore: best.consensus.avgScore };
    }

    // Build feedback for next iteration
    const failing = evaluated.filter(p => !p.consensus.passed);
    previousFeedback = `${failing.length}/${evaluated.length} prompts failed consensus (threshold ${CONFIG.consensusThreshold}). ` +
      `Best avg score: ${best.consensus.avgScore.toFixed(0)}. Common issue: ` +
      (best.consensus.scores[0]?.reasoning || 'unclear focus');
  }

  // Gate 1 failed -- build alternatives from top candidates, return best prompt anyway
  const alternatives = allCandidates
    .sort((a, b) => b.consensus.avgScore - a.consensus.avgScore)
    .slice(0, 4)
    .map(p => ({
      prompt:    p.text,
      aiId:      p.aiId,
      avgScore:  p.consensus.avgScore,
      passCount: p.consensus.passCount,
      reasoning: p.scores?.[0]?.reasoning || ''
    }));

  return {
    passed: false,
    prompt: bestPrompt || query,
    iterations: CONFIG.maxGate1Iterations,
    log,
    avgScore: bestScore,
    fallback: true,
    alternatives
  };
}

// ── Module-level source discovery (runs in parallel with Gate 1) ─────────────
function estimateAuthority(url) {
  if (/\.gov|\.edu/.test(url)) return 5;
  if (/\.org|wikipedia/.test(url)) return 4;
  if (/github|stackoverflow|docs\./.test(url)) return 4;
  return 3;
}

async function discoverSources(searchQuery) {
  try {
    const results = await askGoogleSearch(searchQuery, 10);
    return results.map(r => ({
      url: r.url, title: r.title, snippet: r.snippet,
      authority: estimateAuthority(r.url)
    }));
  } catch (err) {
    console.warn('[discoverSources] unavailable:', err.message);
    return [{ url: 'no-search-available', title: 'Search unavailable -- answer from model knowledge', snippet: '', authority: 2 }];
  }
}

// ── Gate 1.5: Source Consensus ────────────────────────────────────────────────
// preSources: if provided (from parallel discovery), skip initial fetch
async function runGate15(query, consensusPrompt, preSources) {

  // Vote: each task AI ranks the sources in parallel
  async function voteSources(sources, q) {
    const sourceList = sources.map((s, i) => `[${i}] ${s.title} (${s.url})`).join('\n');
    const voteResults = await Promise.allSettled(
      TASK_AIS.map(ai => ai.call([{
        role: 'user',
        content: `${ai.persona}\n\nQuery: "${q}"\n\nWhich of these sources are RELEVANT? Reply with ONLY a JSON array of index numbers.\n\n${sourceList}`
      }]))
    );

    const votes = new Array(sources.length).fill(0);
    for (const r of voteResults) {
      if (r.status !== 'fulfilled') continue;
      try {
        const text = r.value.text || '';
        const nums = JSON.parse(text.match(/\[[\d,\s]+\]/)?.[0] || '[]');
        for (const n of nums) { if (n >= 0 && n < sources.length) votes[n]++; }
      } catch { /* skip malformed vote */ }
    }
    return votes;
  }

  // Attempt 1 -- use pre-discovered sources if available, else fetch now
  const sources1 = (preSources && preSources.length > 0) ? preSources : await discoverSources(consensusPrompt);
  const votes1   = await voteSources(sources1, query);
  const consensus1 = sources1.filter((_, i) => votes1[i] >= CONFIG.sourceVoteMajority);
  const partial1   = sources1.filter((_, i) => votes1[i] >= 2 && votes1[i] < CONFIG.sourceVoteMajority);

  if (consensus1.length >= CONFIG.minConsensusSources) {
    return { passed: true, attempt: 1, sources: consensus1, allSources: consensus1.concat(partial1), votes: votes1 };
  }

  // Attempt 2 -- discover new sources targeting gaps
  const gapContext = 'Previous sources lacked consensus. Query: ' + query + '. Find different, authoritative sources.';
  const sources2 = await discoverSources(gapContext);
  const combined  = [...partial1, ...sources1.filter((_, i) => votes1[i] >= 1), ...sources2];
  const votes2    = await voteSources(combined, query);
  const consensus2 = combined.filter((_, i) => votes2[i] >= CONFIG.sourceVoteMajority);

  return {
    passed: consensus2.length >= CONFIG.minConsensusSources,
    attempt: 2,
    sources: consensus2.length >= CONFIG.minConsensusSources ? consensus2 : combined.slice(0, 5),
    allSources: combined,
    votes: votes2
  };
}

// ── Steps 6-9: Execution + Synthesis ─────────────────────────────────────────
async function runExecution(query, consensusPrompt, selectedSources, uploadedFiles) {
  const sourceContext = selectedSources.length > 0
    ? '\n\nUse these sources in your answer:\n' + selectedSources.map(s => `- ${s.title}: ${s.url}`).join('\n')
    : '';
  const fileContext = (uploadedFiles || []).length > 0
    ? '\n\nUploaded documents to reference:\n' + uploadedFiles.map(f => `--- ${f.name} ---\n${(f.content || '').slice(0, 4000)}`).join('\n\n')
    : '';

  // Step 6: Fire all 5 task AIs simultaneously; take the first 3 that respond
  // (raceAtLeast avoids waiting for a slow AI to unblock the whole pipeline)
  const raceResults = await raceAtLeast(
    TASK_AIS.map(ai => ({
      id:      ai.id,
      label:   ai.label,
      promise: ai.call([{
        role:    'user',
        content: ai.persona + '\n\n' + consensusPrompt + sourceContext + fileContext + '\n\nQuery: ' + query
      }])
    })),
    3   // synthesise as soon as 3 of 5 respond
  );

  const answers = raceResults
    .filter(r => r.value && (r.value.text || '').length > 20)
    .map(r => ({
      aiId:      r.id,
      aiLabel:   r.label,
      text:      r.value.text,
      modelUsed: r.value.modelUsed || r.id,
      failed:    false
    }));

  // Step 8: Evaluate all answers with all evaluators in parallel
  const evalMatrix = await Promise.allSettled(
    answers.map(a => evaluateItem(a.text, 'Query: ' + query))
  );

  const scoredAnswers = answers.map((a, i) => {
    const scores = evalMatrix[i].status === 'fulfilled' ? evalMatrix[i].value
      : Array(CONFIG.evaluatorCount).fill({ total: 50 });
    return { ...a, scores, avgScore: scores.reduce((s, e) => s + e.total, 0) / scores.length };
  }).sort((a, b) => b.avgScore - a.avgScore);

  // Step 9: Brief AI synthesises best elements
  const topAnswers = scoredAnswers.slice(0, 3);
  const synthPrompt = `You are the Brief AI synthesiser. Combine the best elements of these answers into ONE cohesive, well-structured response. Remove redundancy. Maintain any citations.\n\n` +
    topAnswers.map((a, i) => `=== Answer ${i+1} (avg score: ${a.avgScore.toFixed(0)}) [${a.aiLabel}] ===\n${a.text}`).join('\n\n');

  let synthesis;
  try {
    const r = await askGeminiCascade([{ role: 'user', content: synthPrompt }]);
    synthesis = r.text;
  } catch {
    synthesis = topAnswers[0]?.text || 'No answer generated.';
  }

  return { answers: scoredAnswers, synthesis };
}

// ── Supabase logging ──────────────────────────────────────────────────────────
async function logQuery(userId, query) {
  try {
    const { data, error } = await supabase.from('mobius_queries').insert([{
      user_id: userId || null, user_query: query, query_timestamp: new Date().toISOString(), final_status: 'in_progress'
    }]).select('query_id').single();
    if (error) throw error;
    return data.query_id;
  } catch { return null; }
}

async function updateQueryStatus(queryId, updates) {
  if (!queryId) return;
  try {
    await supabase.from('mobius_queries').update({ ...updates, total_iterations: (updates.gate1_iterations || 0) + (updates.gate2_iterations || 0) }).eq('query_id', queryId);
  } catch { /* non-fatal */ }
}

// ── Main handler ──────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const cookieHeader = req.headers.cookie || '';
  const userId = cookieHeader.split(';').map(c => c.trim())
    .find(c => c.startsWith('mobius_user_id='))?.split('=')[1] || req.body?.userId || null;

  const { step, query, consensus_prompt, selected_sources, uploaded_files, query_id } = req.body || {};

  if (!query) return res.status(400).json({ error: 'query is required' });

  // ── Step 1: Gate 1 + Gate 1.5 ───────────────────────────────────────────────
  if (!step || step === 1) {
    const qId = await logQuery(userId, query);

    try {
      // Gate 1 + source discovery run IN PARALLEL (saves ~5-10 seconds)
      const [gate1Result, preDiscovered] = await Promise.all([
        runGate1(query, ''),
        discoverSources(query)
      ]);

      let gate1 = gate1Result;
      let consensusPrompt = gate1.prompt;
      let gate15 = await runGate15(query, consensusPrompt, preDiscovered);

      // Gate 1.5 failed: retry Gate 1 once with tighter prompt, re-discover sources
      if (!gate15.passed) {
        const retried = await runGate1(query, 'Source consensus failed. Make the prompt more specific and unambiguous.');
        gate1 = { ...retried, gate15Retry: true };
        consensusPrompt = gate1.prompt;
        gate15 = { ...(await runGate15(query, consensusPrompt, null)), gate1Retried: true };
      } else {
        gate1.gate15Retry   = false;
        gate15.gate1Retried = false;
      }

      await updateQueryStatus(qId, {
        gate1_iterations:    gate1.iterations,
        gate1_passed:        gate1.passed,
        gate1_best_prompt:   consensusPrompt,
        gate1_best_prompt_score: gate1.avgScore
      });

      return res.json({
        query_id:         qId,
        consensus_prompt: consensusPrompt,
        sources:          gate15.sources,
        all_sources:      gate15.allSources,
        gate1: {
          passed:     gate1.passed,
          iterations: gate1.iterations,
          avgScore:   gate1.avgScore,
          fallback:   gate1.fallback || false
        },
        gate15: {
          passed:  gate15.passed,
          attempt: gate15.attempt
        }
      });
    } catch (err) {
      console.error('[Orchestrate] Step 1 error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // ── Step 2: Execution + Gate 2 ───────────────────────────────────────────────
  if (step === 2) {
    if (!consensus_prompt) return res.status(400).json({ error: 'consensus_prompt required for step 2' });
    const sources = selected_sources || [];

    try {
      // Execute
      const execution = await runExecution(query, consensus_prompt, sources, uploaded_files || []);

      // Gate 2
      const gate2 = await runGate2(query, execution.synthesis, execution.answers);

      await updateQueryStatus(query_id, {
        gate2_iterations:     gate2.iterations,
        gate2_passed:         gate2.passed,
        gate2_final_answer:   gate2.synthesis,
        gate2_final_score:    gate2.avgScore,
        answers_generated:    execution.answers.length,
        user_selected_sources: sources.map(s => s.url),
        final_status: gate2.passed ? 'success' : 'alternatives_shown'
      });

      return res.json({
        answer:       gate2.synthesis,
        citations:    sources,
        gate2: {
          passed:     gate2.passed,
          iterations: gate2.iterations,
          avgScore:   gate2.avgScore,
          fallback:   gate2.fallback || false
        },
        alternatives: gate2.alternatives || [],
        scores: execution.answers.map(a => ({
          label:    a.aiLabel,
          model:    a.modelUsed,
          avgScore: a.avgScore
        })),
        answers: execution.answers.map(a => ({
          label:    a.aiLabel,
          model:    a.modelUsed,
          avgScore: a.avgScore,
          text:     a.text.slice(0, 3000)
        }))
      });
    } catch (err) {
      console.error('[Orchestrate] Step 2 error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(400).json({ error: 'step must be 1 or 2' });
};
