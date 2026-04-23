// api/orchestrate-stream.js
// SSE endpoint for Step 2 execution.
// Fires all 5 task AIs simultaneously and streams each response to the client
// as it arrives, rather than waiting for all to complete.
//
// POST /orchestrate/stream  { query, consensus_prompt, selected_sources, uploaded_files, query_id }
//
// SSE event types:
//   start | ai_response | race_complete | eval_score | synthesis_start
//   synthesis_done | gate2_start | gate2_result | answer | error

'use strict';

const { TASK_AIS, evaluateItem, runGate2 } = require('./_exec.js');
const { askGeminiCascade }                 = require('./_ai.js');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  // ── SSE headers ───────────────────────────────────────────────────────────
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx/proxy buffering
  res.flushHeaders();

  function emit(data) {
    if (!res.writableEnded) res.write('data: ' + JSON.stringify(data) + '\n\n');
  }

  const { query, consensus_prompt, selected_sources, uploaded_files } = req.body || {};

  if (!query || !consensus_prompt) {
    emit({ type: 'error', message: 'Missing query or consensus_prompt' });
    return res.end();
  }

  try {
    const sourceContext = (selected_sources || []).length > 0
      ? '\n\nUse these sources:\n' + selected_sources.map(s => `- ${s.title}: ${s.url}`).join('\n')
      : '';
    const fileContext = (uploaded_files || []).length > 0
      ? '\n\nUploaded documents:\n' + uploaded_files.map(f => `--- ${f.name} ---\n${(f.content || '').slice(0, 4000)}`).join('\n\n')
      : '';

    emit({ type: 'start', message: 'Firing all ' + TASK_AIS.length + ' task AIs simultaneously...' });

    // ── Fire all AIs; resolve as soon as 3 respond ────────────────────────
    const responses = [];

    await new Promise(resolveRace => {
      let settled = 0;
      let done    = false;
      const timer = setTimeout(() => { if (!done) { done = true; resolveRace(); } }, 50000);

      TASK_AIS.forEach(ai => {
        const content = ai.persona + '\n\n' + consensus_prompt + sourceContext + fileContext + '\n\nQuery: ' + query;
        ai.call([{ role: 'user', content }])
          .then(result => {
            if (done) return;
            responses.push({ id: ai.id, label: ai.label, text: result.text || '', model: result.modelUsed || ai.id });
            emit({
              type:  'ai_response',
              label: ai.label,
              model: result.modelUsed || ai.id,
              text:  (result.text || '').slice(0, 3000),
              count: responses.length
            });
            if (responses.length >= 3) { done = true; clearTimeout(timer); resolveRace(); }
          })
          .catch(() => { /* skip failed AI */ })
          .finally(() => {
            settled++;
            if (settled >= TASK_AIS.length && !done) { done = true; clearTimeout(timer); resolveRace(); }
          });
      });
    });

    if (responses.length === 0) throw new Error('All task AIs failed to respond');

    emit({ type: 'race_complete', count: responses.length,
           message: responses.length + '/' + TASK_AIS.length + ' AIs responded -- evaluating...' });

    // ── Evaluate responses in parallel; emit each score as it arrives ─────
    const evalPromises = responses.map(async (r, i) => {
      const scores  = await evaluateItem(r.text, 'Query: ' + query);
      const avg     = scores.reduce((s, e) => s + e.total, 0) / scores.length;
      emit({ type: 'eval_score', label: r.label, avgScore: parseFloat(avg.toFixed(1)), index: i });
      return { ...r, scores, avgScore: avg };
    });

    const scoredAnswers = (await Promise.all(evalPromises)).sort((a, b) => b.avgScore - a.avgScore);

    // ── Synthesis ─────────────────────────────────────────────────────────
    const topN = Math.min(3, scoredAnswers.length);
    emit({ type: 'synthesis_start', message: 'Synthesising best elements from top ' + topN + ' answers...' });

    const synthPrompt = 'You are the Brief AI synthesiser. Combine the best elements into ONE cohesive, well-structured response. Remove redundancy. Maintain any citations.\n\n'
      + scoredAnswers.slice(0, topN).map((a, i) =>
          `=== Answer ${i+1} (avg ${a.avgScore.toFixed(0)}) [${a.label}] ===\n${a.text}`
        ).join('\n\n');

    let synthesis;
    try {
      const r = await askGeminiCascade([{ role: 'user', content: synthPrompt }]);
      synthesis = r.text;
    } catch {
      synthesis = scoredAnswers[0]?.text || 'No answer generated.';
    }
    emit({ type: 'synthesis_done' });

    // ── Gate 2 ────────────────────────────────────────────────────────────
    emit({ type: 'gate2_start', message: 'Gate 2 -- evaluating answer consensus...' });
    const gate2 = await runGate2(query, synthesis, scoredAnswers);
    emit({ type: 'gate2_result', passed: gate2.passed,
           avgScore: parseFloat(gate2.avgScore.toFixed(1)), iterations: gate2.iterations });

    // ── Final answer package ──────────────────────────────────────────────
    emit({
      type:         'answer',
      answer:       gate2.synthesis,
      citations:    selected_sources || [],
      alternatives: gate2.alternatives || [],
      gate2:        { passed: gate2.passed, avgScore: gate2.avgScore,
                      iterations: gate2.iterations, fallback: gate2.fallback || false },
      scores:       scoredAnswers.map(a => ({ label: a.label, model: a.model, avgScore: a.avgScore })),
      answers:      scoredAnswers.map(a => ({ label: a.label, model: a.model,
                                              avgScore: a.avgScore, text: a.text.slice(0, 3000) }))
    });

  } catch (err) {
    console.error('[orchestrate-stream] error:', err.message);
    emit({ type: 'error', message: err.message });
  }

  res.end();
};
