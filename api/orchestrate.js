// api/orchestrate.js
// POST /orchestrate  { step:1, query }
//   -> Gate 1 (prompt consensus) + Gate 1.5 (source consensus)
//   -> returns { query_id, consensus_prompt, sources, gate1, gate15 }
//
// POST /orchestrate  { step:2, query_id, query, consensus_prompt, selected_sources }
//   -> Execution (9 AIs answer) + Gate 2 (answer consensus)
//   -> returns { answer, citations, gate2, scores }

'use strict';

const {
  askGroqCascade, askGeminiCascade, askMistralCascade,
  askOpenRouterCascade, askGeminiLite, askWebSearch
} = require('./_ai.js');
const { supabase } = require('./_supabase.js');

// ── Configuration ─────────────────────────────────────────────────────────────
const CONFIG = {
  taskAICount:        5,
  evaluatorCount:     5,
  consensusThreshold: 90,     // score >= 90 to pass
  consensusMajority:  3,      // 3/5 must pass
  sourceVoteMajority: 4,      // 4/5 votes = consensus source
  minConsensusSources:3,
  maxGate1Iterations: 3,
  maxGate2Iterations: 3,
  maxGate15Attempts:  2
};

// ── 5 Task AI definitions (specialist persona + model) ────────────────────────
const TASK_AIS = [
  {
    id: 'analyst',
    label: 'Analytical Specialist',
    persona: 'You are an analytical specialist. You break problems into components, identify patterns, and provide structured reasoning. Focus on logic, trade-offs, and evidence.',
    call: (msgs) => askGroqCascade(msgs)
  },
  {
    id: 'researcher',
    label: 'Research Specialist',
    persona: 'You are a research specialist. You draw on authoritative sources, cite evidence, and provide comprehensive background. Focus on accuracy and depth.',
    call: (msgs) => askGeminiCascade(msgs)
  },
  {
    id: 'technical',
    label: 'Technical Specialist',
    persona: 'You are a technical specialist. You focus on implementation details, practical constraints, and concrete solutions. Provide specific, actionable guidance.',
    call: (msgs) => askMistralCascade(msgs)
  },
  {
    id: 'critical',
    label: 'Critical Reviewer',
    persona: 'You are a critical reviewer. You identify weaknesses, edge cases, and unstated assumptions. Play devil\'s advocate. Focus on what could go wrong.',
    call: async (msgs) => { const r = await askGeminiLite(msgs); return { text: r.text, modelUsed: 'Gemini Lite' }; }
  },
  {
    id: 'synthesiser',
    label: 'Synthesis Specialist',
    persona: 'You are a synthesis specialist. You integrate multiple perspectives, identify common ground, and produce clear, balanced, well-structured answers.',
    call: (msgs) => askOpenRouterCascade(msgs)
  }
];

// ── Evaluator scoring prompt ──────────────────────────────────────────────────
function buildEvalPrompt(item, context) {
  return `You are an expert evaluator. Score the following on a scale of 1-100.

CONTEXT: ${context}

ITEM TO EVALUATE:
${item}

Score across 4 dimensions (each 0-25):
- Accuracy (0-25): Factually correct, no hallucinations
- Relevance (0-25): Directly addresses the query
- Completeness (0-25): Covers the key aspects
- Clarity (0-25): Well-structured and easy to understand

Respond with ONLY a JSON object, no markdown:
{"accuracy":N,"relevance":N,"completeness":N,"clarity":N,"total":N,"reasoning":"one sentence"}`;
}

async function scoreItem(item, context) {
  const prompt = buildEvalPrompt(item, context);
  const msgs = [{ role: 'user', content: prompt }];
  // Use fast model for scoring -- Gemini Lite
  try {
    const r = await askGeminiLite(msgs);
    const parsed = JSON.parse((r.text || '').replace(/```json|```/g, '').trim());
    return {
      accuracy:     Math.min(25, Math.max(0, parsed.accuracy     || 0)),
      relevance:    Math.min(25, Math.max(0, parsed.relevance    || 0)),
      completeness: Math.min(25, Math.max(0, parsed.completeness || 0)),
      clarity:      Math.min(25, Math.max(0, parsed.clarity      || 0)),
      total:        Math.min(100, Math.max(0, parsed.total       || 0)),
      reasoning:    parsed.reasoning || ''
    };
  } catch {
    // Fallback: ask for just a number
    try {
      const fb = await askGroqCascade([{ role: 'user', content: 'Score 1-100: ' + item.slice(0, 200) + '\n\nContext: ' + context.slice(0, 100) + '\n\nRespond with ONLY a number.' }]);
      const n = parseInt((fb.text || '50').match(/\d+/)?.[0] || '50', 10);
      const q = Math.floor(Math.min(100, Math.max(1, n)) / 4);
      return { accuracy: q, relevance: q, completeness: q, clarity: q, total: n, reasoning: 'fallback score' };
    } catch {
      return { accuracy: 15, relevance: 15, completeness: 15, clarity: 15, total: 60, reasoning: 'eval failed' };
    }
  }
}

// Score an item with all 5 evaluators in parallel
async function evaluateItem(item, context) {
  const results = await Promise.allSettled(
    TASK_AIS.map(() => scoreItem(item, context))
  );
  return results.map((r, i) =>
    r.status === 'fulfilled' ? r.value
    : { accuracy: 15, relevance: 15, completeness: 15, clarity: 15, total: 60, reasoning: 'eval ' + i + ' failed' }
  );
}

function checkConsensus(scores) {
  const passing = scores.filter(s => s.total >= CONFIG.consensusThreshold);
  return {
    passed: passing.length >= CONFIG.consensusMajority,
    passCount: passing.length,
    avgScore: scores.reduce((a, s) => a + s.total, 0) / scores.length,
    scores
  };
}

// ── Gate 1: Prompt Consensus ──────────────────────────────────────────────────
async function runGate1(query, previousFeedback = '') {
  const log = [];
  let bestPrompt = null;
  let bestScore = 0;

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

    if (best.consensus.passed) {
      return { passed: true, prompt: best.text, iterations: iter, log, avgScore: best.consensus.avgScore };
    }

    // Build feedback for next iteration
    const failing = evaluated.filter(p => !p.consensus.passed);
    previousFeedback = `${failing.length}/${evaluated.length} prompts failed consensus (threshold ${CONFIG.consensusThreshold}). ` +
      `Best avg score: ${best.consensus.avgScore.toFixed(0)}. Common issue: ` +
      (best.consensus.scores[0]?.reasoning || 'unclear focus');
  }

  // Gate 1 failed -- return best prompt found anyway
  return {
    passed: false,
    prompt: bestPrompt || query,
    iterations: CONFIG.maxGate1Iterations,
    log,
    avgScore: bestScore,
    fallback: true
  };
}

// ── Gate 1.5: Source Consensus ────────────────────────────────────────────────
async function runGate15(query, consensusPrompt) {
  // Brief AI discovers sources via Tavily web search
  async function discoverSources(searchQuery) {
    try {
      const r = await askWebSearch(
        [{ role: 'user', content: searchQuery }], 2
      );
      // Parse source URLs from Tavily response -- extract cited sources
      const sources = [];
      const lines = (r.reply || '').split('\n');
      let idx = 0;
      for (const line of lines) {
        const urlMatch = line.match(/https?:\/\/[^\s\)]+/);
        if (urlMatch) {
          sources.push({
            url:        urlMatch[0],
            title:      line.replace(urlMatch[0], '').replace(/[\[\]]/g, '').trim() || 'Source ' + (idx + 1),
            snippet:    '',
            authority:  estimateAuthority(urlMatch[0])
          });
          idx++;
          if (idx >= 20) break;
        }
      }
      return sources.length > 0 ? sources : [{ url: 'web-search', title: 'Web search results', snippet: r.reply?.slice(0, 300) || '', authority: 3 }];
    } catch {
      return [];
    }
  }

  function estimateAuthority(url) {
    if (/\.gov|\.edu/.test(url)) return 5;
    if (/\.org|wikipedia/.test(url)) return 4;
    if (/github|stackoverflow|docs\./.test(url)) return 4;
    return 3;
  }

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

  // Attempt 1
  const sources1 = await discoverSources(consensusPrompt);
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
async function runExecution(query, consensusPrompt, selectedSources) {
  const sourceContext = selectedSources.length > 0
    ? '\n\nUse these sources in your answer:\n' + selectedSources.map(s => `- ${s.title}: ${s.url}`).join('\n')
    : '';

  // Step 6: All 5 task AIs answer in parallel
  const answerResults = await Promise.allSettled(
    TASK_AIS.map(ai => ai.call([{
      role: 'user',
      content: ai.persona + '\n\n' + consensusPrompt + sourceContext + '\n\nQuery: ' + query
    }]))
  );

  const answers = answerResults.map((r, i) => ({
    aiId:      TASK_AIS[i].id,
    aiLabel:   TASK_AIS[i].label,
    text:      r.status === 'fulfilled' ? (r.value.text || '') : '',
    modelUsed: r.status === 'fulfilled' ? (r.value.modelUsed || TASK_AIS[i].id) : 'failed',
    failed:    r.status === 'rejected'
  })).filter(a => !a.failed && a.text.length > 20);

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

// ── Gate 2: Answer Consensus ──────────────────────────────────────────────────
async function runGate2(query, synthesis, answers) {
  const log = [];

  for (let iter = 1; iter <= CONFIG.maxGate2Iterations; iter++) {
    const scores = await evaluateItem(synthesis, 'Query: ' + query);
    const consensus = checkConsensus(scores);
    log.push({ iter, consensus });

    if (consensus.passed) {
      return { passed: true, iterations: iter, log, avgScore: consensus.avgScore, synthesis };
    }

    if (iter < CONFIG.maxGate2Iterations) {
      // Rewrite synthesis with feedback
      const feedback = scores.map((s, i) => `Evaluator ${i+1}: ${s.total}/100 — ${s.reasoning}`).join('\n');
      try {
        const r = await askGeminiCascade([{
          role: 'user',
          content: `The following answer scored poorly (avg ${consensus.avgScore.toFixed(0)}/100). Rewrite it to score higher.\n\nFeedback:\n${feedback}\n\nOriginal answer:\n${synthesis}\n\nQuery: ${query}\n\nRewrite the answer only. No preamble.`
        }]);
        synthesis = r.text;
      } catch { /* keep existing synthesis */ }
    }
  }

  // Gate 2 failed — return best answer from execution as fallback
  const fallback = answers[0]?.text || synthesis;
  return {
    passed: false, iterations: CONFIG.maxGate2Iterations, log,
    avgScore: log[log.length - 1]?.consensus?.avgScore || 0,
    synthesis: fallback, fallback: true,
    alternatives: answers.slice(0, 3).map(a => ({ label: a.aiLabel, text: a.text, score: a.avgScore }))
  };
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

  const { step, query, consensus_prompt, selected_sources, query_id } = req.body || {};

  if (!query) return res.status(400).json({ error: 'query is required' });

  // ── Step 1: Gate 1 + Gate 1.5 ───────────────────────────────────────────────
  if (!step || step === 1) {
    const qId = await logQuery(userId, query);

    try {
      // Gate 1
      const gate1 = await runGate1(query);
      const consensusPrompt = gate1.prompt;

      // Gate 1.5
      const gate15 = await runGate15(query, consensusPrompt);

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
      const execution = await runExecution(query, consensus_prompt, sources);

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
        }))
      });
    } catch (err) {
      console.error('[Orchestrate] Step 2 error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(400).json({ error: 'step must be 1 or 2' });
};
