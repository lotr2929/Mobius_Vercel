// api/_exec.js
// Shared execution core -- imported by orchestrate.js and orchestrate-stream.js.
// Contains: CONFIG, TASK_AIS, raceAtLeast, eval helpers, runGate2.

'use strict';

const {
  askGroqCascade, askGeminiCascade, askMistralCascade,
  askOpenRouterCascade, askGeminiLite
} = require('./_ai.js');

// ── Configuration ─────────────────────────────────────────────────────────────
const CONFIG = {
  taskAICount:        5,
  evaluatorCount:     5,
  consensusThreshold: 90,
  consensusMajority:  3,
  sourceVoteMajority: 4,
  minConsensusSources:3,
  maxGate1Iterations: 3,
  maxGate2Iterations: 3,
  maxGate15Attempts:  2
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
    call: async (msgs) => { const r = await askGeminiLite(msgs); return { text: r.text, modelUsed: 'Gemini Lite' }; }
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

// ── Race helper: resolve with first `min` fulfilled results ──────────────────
function raceAtLeast(namedPromises, min, timeoutMs = 45000) {
  return new Promise(resolve => {
    const results = [];
    let done = false;
    let settled = 0;
    const finish = () => { if (!done) { done = true; resolve(results); } };
    const timer  = setTimeout(finish, timeoutMs);
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

// ── Evaluator helpers ─────────────────────────────────────────────────────────
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
  const msgs = [{ role: 'user', content: buildEvalPrompt(item, context) }];
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

async function evaluateItem(item, context) {
  const results = await Promise.allSettled(TASK_AIS.map(() => scoreItem(item, context)));
  return results.map((r, i) =>
    r.status === 'fulfilled' ? r.value
    : { accuracy: 15, relevance: 15, completeness: 15, clarity: 15, total: 60, reasoning: 'eval ' + i + ' failed' }
  );
}

function checkConsensus(scores) {
  const passing = scores.filter(s => s.total >= CONFIG.consensusThreshold);
  return {
    passed:    passing.length >= CONFIG.consensusMajority,
    passCount: passing.length,
    avgScore:  scores.reduce((a, s) => a + s.total, 0) / scores.length,
    scores
  };
}

// ── Gate 2: Answer Consensus ──────────────────────────────────────────────────
async function runGate2(query, synthesis, answers) {
  const log = [];
  for (let iter = 1; iter <= CONFIG.maxGate2Iterations; iter++) {
    const scores    = await evaluateItem(synthesis, 'Query: ' + query);
    const consensus = checkConsensus(scores);
    log.push({ iter, consensus });
    if (consensus.passed) {
      return { passed: true, iterations: iter, log, avgScore: consensus.avgScore, synthesis };
    }
    if (iter < CONFIG.maxGate2Iterations) {
      const feedback = scores.map((s, i) => `Evaluator ${i+1}: ${s.total}/100 -- ${s.reasoning}`).join('\n');
      try {
        const r = await askGeminiCascade([{
          role: 'user',
          content: `The following answer scored poorly (avg ${consensus.avgScore.toFixed(0)}/100). Rewrite it to score higher.\n\nFeedback:\n${feedback}\n\nOriginal answer:\n${synthesis}\n\nQuery: ${query}\n\nRewrite the answer only. No preamble.`
        }]);
        synthesis = r.text;
      } catch { /* keep existing */ }
    }
  }
  const fallback = answers[0]?.text || synthesis;
  return {
    passed: false, iterations: CONFIG.maxGate2Iterations, log,
    avgScore: log[log.length - 1]?.consensus?.avgScore || 0,
    synthesis: fallback, fallback: true,
    alternatives: answers.slice(0, 3).map(a => ({ label: a.aiLabel || a.label, text: a.text, score: a.avgScore }))
  };
}

module.exports = { CONFIG, TASK_AIS, raceAtLeast, evaluateItem, checkConsensus, runGate2 };
