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

const { TASK_AIS, evaluateAnswers } = require('./_exec.js');

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

  const { query, approved_prompt, selected_sources } = req.body || {};
  if (!query || !approved_prompt) {
    emit({ type: 'error', message: 'Missing query or approved_prompt' });
    return res.end();
  }

  const sourceContext = (selected_sources || []).length > 0
    ? '\n\nReference these sources in your answer:\n' +
      selected_sources.map(s => '- ' + (s.title || s.url) + ': ' + s.url).join('\n')
    : '';

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
        ai.call([{ role: 'user', content:
          ai.persona + '\n\n' + approved_prompt + sourceContext + '\n\nQuery: ' + query
        }])
          .then(result => {
            if (!result || (result.text || '').length < 20) return;
            responses.push({ id: ai.id, label: ai.label, text: result.text, model: result.modelUsed || ai.id });
            emit({
              type:  'ai_response',
              label: ai.label,
              model: result.modelUsed || ai.id,
              text:  result.text.slice(0, 3000),
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

    emit({
      type:       'complete',
      answers:    responses.map(r => ({ label: r.label, model: r.model, text: r.text.slice(0, 3000) })),
      evaluation: evaluation
    });

  } catch (err) {
    console.error('[orchestrate-stream]', err.message);
    emit({ type: 'error', message: err.message });
  }

  res.end();
};
