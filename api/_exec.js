// api/_exec.js
// Shared execution core -- imported by orchestrate.js and orchestrate-stream.js.
// Exports: CONFIG, TASK_AIS, raceAtLeast, generatePromptSuggestions, evaluateAnswers

'use strict';

const {
  askGroqCascade, askGeminiCascade, askMistralCascade,
  askOpenRouterCascade, askGeminiLite
} = require('./_ai.js');

// ── Configuration ─────────────────────────────────────────────────────────────
const CONFIG = {
  taskAICount:       5,
  raceMin:           3,       // proceed when this many AIs have responded
  executionTimeout:  120000,  // 2 min -- wait for all 5, proceed on raceMin
  promptTimeout:     45000,   // 45s for prompt suggestion step
};

// ── 5 Task AI definitions ─────────────────────────────────────────────────────
const TASK_AIS = [
  {
    id: 'analyst', label: 'Analytical Specialist',
    persona: 'You are an analytical specialist. You break problems into components, identify patterns, and provide structured reasoning. Focus on logic, trade-offs, and evidence.',
    call: (msgs) => askGroqCascade(msgs)
  },
  {
    id: 'researcher', label: 'Research Specialist',
    persona: 'You are a research specialist. You draw on authoritative sources, cite evidence, and provide comprehensive background. Focus on accuracy and depth.',
    call: (msgs) => askGeminiCascade(msgs)
  },
  {
    id: 'technical', label: 'Technical Specialist',
    persona: 'You are a technical specialist. You focus on implementation details, practical constraints, and concrete solutions. Provide specific, actionable guidance.',
    call: (msgs) => askMistralCascade(msgs)
  },
  {
    id: 'critical', label: 'Critical Reviewer',
    persona: 'You are a critical reviewer. You identify weaknesses, edge cases, and unstated assumptions. Play devil\'s advocate. Focus on what could go wrong.',
    call: async (msgs) => {
      const r = await askGeminiLite(msgs);
      return { text: r.text, modelUsed: 'Gemini Lite' };
    }
  },
  {
    id: 'synthesiser', label: 'Synthesis Specialist',
    persona: 'You are a synthesis specialist. You integrate multiple perspectives, identify common ground, and produce clear, balanced, well-structured answers.',
    call: async (msgs) => {
      try { return await askOpenRouterCascade(msgs); }
      catch { return await askGroqCascade(msgs); }
    }
  }
];

// ── Race helper ───────────────────────────────────────────────────────────────
// Resolves with all results received within timeoutMs.
// Proceeds early once `min` results are in.
function raceAtLeast(namedPromises, min, timeoutMs = CONFIG.executionTimeout) {
  return new Promise(resolve => {
    const results = [];
    let done = false;
    let settled = 0;
    const finish = () => { if (!done) { done = true; resolve(results); } };
    const timer = setTimeout(finish, timeoutMs);
    namedPromises.forEach(({ id, label, promise }) => {
      promise
        .then(value => {
          if (!done) results.push({ id, label, value });
          if (results.length >= min) { clearTimeout(timer); finish(); }
        })
        .catch(() => {})
        .finally(() => {
          settled++;
          if (settled >= namedPromises.length) { clearTimeout(timer); finish(); }
        });
    });
  });
}

// ── Step A: Generate prompt suggestions ──────────────────────────────────────
// All 5 Task AIs suggest a rewritten prompt in parallel.
// Brief AI (Gemini) synthesises one combined prompt from all suggestions.
// Returns: { suggestions: [{id, label, model, text}], synthesised: string }

async function generatePromptSuggestions(query, feedback = '') {
  const feedbackNote = feedback
    ? '\n\nUser feedback on previous attempt: ' + feedback
    : '';

  // Each AI rewrites the query as a precise prompt; record time taken
  const rawResults = await Promise.allSettled(
    TASK_AIS.map(async ai => {
      const t0 = Date.now();
      const r  = await ai.call([{ role: 'user', content:
        ai.persona + '\n\nRewrite the following query as a clear, precise, well-structured prompt that will get the best answer from an AI. Output ONLY the improved prompt. No preamble, no explanation.\n\nQuery: "' + query + '"' + feedbackNote
      }]);
      return { ...r, ms: Date.now() - t0 };
    })
  );

  // Keep all 5 slots; failed/empty AIs show as such
  const suggestions = rawResults.map((r, i) => ({
    id:     TASK_AIS[i].id,
    label:  TASK_AIS[i].label,
    model:  r.status === 'fulfilled' ? (r.value.modelUsed || TASK_AIS[i].id) : 'no response',
    text:   r.status === 'fulfilled' ? (r.value.text || '').trim() : '',
    ms:     r.status === 'fulfilled' ? (r.value.ms || null) : null,
    failed: r.status !== 'fulfilled' || (r.value.text || '').trim().length < 10
  }));

  // Brief AI synthesises one best prompt
  const synthInput = suggestions.map((s, i) =>
    '[' + (i + 1) + '] ' + s.label + ':\n' + s.text
  ).join('\n\n');

  let synthesised = suggestions[0]?.text || query;
  try {
    const r = await askGeminiCascade([{ role: 'user', content:
      'You are the Brief AI. Below are ' + suggestions.length + ' rewritten prompts from different AI specialists for the same user query.\n\n' +
      'Original query: "' + query + '"\n\n' +
      'Specialist suggestions:\n' + synthInput + '\n\n' +
      'Produce ONE synthesised prompt that combines the strongest elements from all suggestions. ' +
      'Output ONLY the final prompt. No preamble, no labels, no explanation.' +
      (feedback ? '\n\nUser feedback to incorporate: ' + feedback : '')
    }]);
    synthesised = r.text.trim();
  } catch { /* keep first suggestion */ }

  return { suggestions, synthesised };
}

// ── Step B: Evaluate answers ──────────────────────────────────────────────────
// Scores each answer independently, then asks Brief AI to produce an
// annotated summary showing agreement, disagreement, and hallucination flags.
//
// Returns: {
//   scores:  [{ label, model, total, note }],
//   summary: string  -- annotated text with inline attribution
// }

async function scoreOne(text, query) {
  const prompt =
    'Score this AI answer 0-100.\n\nQuery: "' + query + '"\n\nAnswer:\n' + text.slice(0, 2000) + '\n\n' +
    'Score on 4 dimensions (each 0-25): accuracy, relevance, completeness, clarity.\n' +
    'Respond ONLY with valid JSON, no markdown:\n{"accuracy":N,"relevance":N,"completeness":N,"clarity":N,"total":N,"note":"one sentence"}';

  // Try Gemini Lite first, fall back to Groq
  for (const askFn of [
    () => askGeminiLite([{ role: 'user', content: prompt }]),
    () => askGroqCascade([{ role: 'user', content: prompt }])
  ]) {
    try {
      const r      = await askFn();
      const parsed = JSON.parse((r.text || '').replace(/```json|```/g, '').trim());
      return {
        accuracy:     Math.min(25, Math.max(0, +parsed.accuracy     || 0)),
        relevance:    Math.min(25, Math.max(0, +parsed.relevance    || 0)),
        completeness: Math.min(25, Math.max(0, +parsed.completeness || 0)),
        clarity:      Math.min(25, Math.max(0, +parsed.clarity      || 0)),
        total:        Math.min(100, Math.max(0, +parsed.total       || 0)),
        note:         parsed.note || ''
      };
    } catch { /* try next */ }
  }
  return { accuracy: 15, relevance: 15, completeness: 15, clarity: 15, total: 60, note: 'eval failed' };
}

async function evaluateAnswers(query, answers) {
  // Score all answers in parallel
  const scoreResults = await Promise.allSettled(answers.map(a => scoreOne(a.text, query)));
  const scores = answers.map((a, i) => ({
    label: a.aiLabel || a.label,
    model: a.modelUsed || a.id || '',
    score: scoreResults[i].status === 'fulfilled'
      ? scoreResults[i].value
      : { accuracy: 15, relevance: 15, completeness: 15, clarity: 15, total: 60, note: 'eval failed' }
  }));

  // Brief AI produces annotated comparison summary
  const answersForBrief = scores.map((s, i) =>
    '=== ' + s.label + ' [' + s.model + ', score: ' + s.score.total + '/100] ===\n' +
    (answers[i].text || '').slice(0, 1500)
  ).join('\n\n');

  const summaryPrompt =
    'You are the Brief AI evaluator. Compare these ' + scores.length + ' answers to the same query and produce an annotated evaluation summary.\n\n' +
    'Query: "' + query + '"\n\n' + answersForBrief + '\n\n' +
    'Format the summary as sections with bullet points:\n\n' +
    '## Key Points\n' +
    '- Each agreed point. After each point add [N/' + scores.length + ' agree: names]\n\n' +
    '## Differences\n' +
    '- Each difference. Show which AI said what. Use ⚡ CONFLICT if directly contradictory.\n\n' +
    '## Concerns\n' +
    '- Gaps, weak arguments, or single-AI claims. Mark single-AI unverified claims with ⚠ VERIFY.\n\n' +
    '## Overall\n' +
    '- One sentence consensus statement.\n\n' +
    'Be concise and substantive. Omit any section that has nothing to report.';

  let summary = 'Evaluation summary unavailable.';
  for (const askFn of [
    () => askGeminiCascade([{ role: 'user', content: summaryPrompt }]),
    () => askGroqCascade([{ role: 'user', content: summaryPrompt }])
  ]) {
    try { const r = await askFn(); summary = r.text.trim(); break; }
    catch { /* try next */ }
  }

  return { scores, summary };
}

module.exports = { CONFIG, TASK_AIS, raceAtLeast, generatePromptSuggestions, evaluateAnswers };
