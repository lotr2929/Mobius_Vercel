// api/orchestrate-stream.js
// SSE endpoint for Step 2 execution.
// Fires all 5 Task AIs with the user-approved prompt.
// Streams each AI response to the client as it arrives.
// After race resolves, evaluates all responses and emits annotated summary.
//
// POST /orchestrate/stream { query, query_id, approved_prompt, selected_sources }
//
// SSE event types:
//   start        -- pipeline initiated
//   ai_response  -- one Task AI's answer arrived {label, model, text, count}
//   race_complete -- raceMin responses received {count, message}
//   eval_start   -- evaluation beginning
//   summary      -- annotated evaluation {scores, summary}
//   complete     -- full payload {answers, evaluation}
//   error        -- fatal error

'use strict';

const { TASK_AIS, evaluateAnswers, buildTaskPrompt, buildUserAnswer } = require('./_exec.js');
const { logTaskResponses }                           = require('./orchestrate.js');
const { supabase }                                   = require('./_supabase.js');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  // SSE headers
  res.setHeader('Content-Type',      'text/event-stream');
  res.setHeader('Cache-Control',     'no-cache, no-transform');
  res.setHeader('Connection',        'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  function emit(data) {
    if (!res.writableEnded) res.write('data: ' + JSON.stringify(data) + '\n\n');
  }

  const { query, query_id, approved_prompt, selected_sources, today, mode } = req.body || {};
  if (!query || !approved_prompt) {
    emit({ type: 'error', message: 'Missing query or approved_prompt' });
    return res.end();
  }

  // Prompt-building logic lives in _exec.js/buildTaskPrompt -- shared with
  // orchestrate.js so the streaming and non-streaming paths always use the
  // same grounding / anti-hallucination instructions.
  const srcs = Array.isArray(selected_sources) ? selected_sources : [];

  // Diagnostic: confirm whether raw_content actually reached Step 2. If the
  // sample prompt is tiny, either no sources were selected OR the client
  // stripped raw_content before re-sending. Task AIs will hallucinate in
  // that case.
  const withRaw = srcs.filter(s => (s.raw_content || '').length > 0).length;
  const samplePrompt = buildTaskPrompt(TASK_AIS[0].persona, approved_prompt, query, srcs, today);
  console.log('[orchestrate-stream] sources: ' + srcs.length + ' total, '
    + withRaw + ' with raw_content, prompt: ' + samplePrompt.length + ' chars'
    + (today ? ', today=' + today : ''));

  try {
    emit({ type: 'start', message: 'Firing ' + TASK_AIS.length + ' Task AIs with approved prompt...' });

    const responses = [];

    // Fire all 5; resolve on first 3 or after 2 min timeout
    await new Promise(resolveRace => {
      let settled = 0;
      let done    = false;
      const RACE_MIN = 3;
      const timer = setTimeout(() => { if (!done) { done = true; resolveRace(); } }, 120000);

      TASK_AIS.forEach(ai => {
        const t0 = Date.now();
        ai.call([{ role: 'user',
          content: buildTaskPrompt(ai.persona, approved_prompt, query, srcs, today)
        }])
          .then(result => {
            if (!result || (result.text || '').length < 20) return;
            const ms = Date.now() - t0;
            responses.push({ id: ai.id, label: ai.label, text: result.text, model: result.modelUsed || ai.id, ms });
            emit({
              type:  'ai_response',
              label: ai.label,
              model: result.modelUsed || ai.id,
              text:  result.text,
              ms,
              count: responses.length,
              total: TASK_AIS.length
            });
            if (responses.length >= RACE_MIN && !done) {
              done = true;
              clearTimeout(timer);
              resolveRace();
            }
          })
          .catch(() => {})
          .finally(() => {
            settled++;
            if (settled >= TASK_AIS.length && !done) {
              done = true;
              clearTimeout(timer);
              resolveRace();
            }
          });
      });
    });

    if (responses.length === 0) throw new Error('All Task AIs failed to respond');

    emit({
      type:    'race_complete',
      count:   responses.length,
      message: responses.length + ' of ' + TASK_AIS.length + ' Task AIs responded'
    });

    // Evaluate all responses and generate annotated summary
    emit({ type: 'eval_start', message: 'Evaluating responses...' });

    const evaluation = await evaluateAnswers(query,
      responses.map(r => ({ aiLabel: r.label, modelUsed: r.model, text: r.text }))
    );

    emit({ type: 'summary', scores: evaluation.scores, summary: evaluation.summary });

    // User Mode: produce a clean prose synthesis (no AI-agreement annotations,
    // no dev-style "Key Points / Differences / Concerns" structure). This adds
    // one extra LLM call (~3-5s on Groq) but gives the user a polished answer.
    let userAnswer = null;
    if (mode === 'user') {
      try {
        userAnswer = await buildUserAnswer(query, approved_prompt, srcs,
          responses.map(r => ({ aiLabel: r.label, text: r.text })),
          today);
      } catch (err) {
        console.warn('[orchestrate-stream] buildUserAnswer failed:', err.message);
      }
    }

    emit({
      type:        'complete',
      answers:     responses.map(r => ({ label: r.label, model: r.model, text: r.text, ms: r.ms })),
      evaluation:  evaluation,
      user_answer: userAnswer   // null in Dev Mode; clean prose in User Mode
    });

    // Persist all 5 Task AI answers + evaluation scores to Supabase for later review.
    // Fire-and-forget: happens after 'complete' is emitted so the user sees results
    // immediately regardless of DB latency or failure.
    await logTaskResponses(query_id, 'execution', responses, evaluation);

    // Persist the final User Mode synthesis to mobius_queries.final_answer so
    // the complete exchange (query + final answer as the user saw it) lives in
    // one row. Needed for the future user-profile summariser. Non-fatal.
    if (query_id) {
      try {
        await supabase.from('mobius_queries').update({
          final_answer: userAnswer || null,
          final_status: 'success'
        }).eq('query_id', query_id);
      } catch (err) {
        console.warn('[orchestrate-stream] final_answer persist failed:', err.message);
      }
    }

  } catch (err) {
    console.error('[orchestrate-stream]', err.message);
    emit({ type: 'error', message: err.message });
  }

  res.end();
};
