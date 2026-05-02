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

// ── Date helper ───────────────────────────────────────────────────────────────
// Mobius must never ship placeholder dates like [Current Date/Time] to the Task
// AIs -- different models resolve them to different training cutoffs.
// The client is expected to pass a pre-formatted `today` string (the user's local
// date, e.g. "Friday, 24 April 2026"). If absent, we fall back to server UTC.
function resolveToday(userToday) {
  if (userToday && typeof userToday === 'string' && userToday.length > 3) {
    return userToday;
  }
  return new Date().toLocaleDateString('en-GB', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC'
  }) + ' (UTC)';
}

// Regex safety net: scrubs common placeholder patterns from Conductor output and
// substitutes the actual date. Catches anything the LLM forgot to replace.
function scrubDatePlaceholders(text, today) {
  if (!text) return text;
  const patterns = [
    /\[\s*current\s+date[^\]]*\]/gi,
    /\[\s*today[^\]]*\]/gi,
    /\[\s*date\s*\/\s*time[^\]]*\]/gi,
    /\[\s*(?:the\s+)?current\s+(?:day|time|datetime)[^\]]*\]/gi,
    /\[\s*as\s+of\s+[^\]]*\]/gi,
    /\[\s*insert\s+date[^\]]*\]/gi,
    /\{\{\s*(?:date|today|now)[^}]*\}\}/gi,
  ];
  let cleaned = text;
  for (const re of patterns) cleaned = cleaned.replace(re, today);
  return cleaned;
}

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

// Build conversation context for Task AIs.
// ≤5 entries: formatted verbatim (oldest first, MOST RECENT flagged).
// >5 entries:  Conductor (Groq→Mistral) summarises all entries into one compact
//              paragraph so the prompt stays within context-window limits.
//              The most recent exchange is always appended verbatim for full fidelity.
async function buildHistoryContext(history) {
  if (!Array.isArray(history) || history.length === 0) return '';

  if (history.length <= 5) {
    const pairs = history.map((h, i) => {
      const isLast = i === history.length - 1;
      const tag    = isLast ? ' [IMMEDIATE CONTEXT]' : '';
      const q = String(h.q || '').slice(0, 400);
      const a = String(h.a || '').slice(0, isLast ? 2000 : 500);
      return '[1] Previous Query' + (i + 1) + tag + ': ' + q + '\n[2] Previous Response' + (i + 1) + tag + ': ' + a;
    }).join('\n\n');
    return '=== CONVERSATION BRIDGE ===\n' +
      'To maintain continuity, refer to the previous exchanges below. ' +
      'The new query [3] is often a direct follow-up to the most recent response [2].\n\n' +
      pairs + '\n' +
      '=== END CONVERSATION BRIDGE ===\n\n';
  }

  // >5 entries: Conductor summarises
  const allPairs = history.map((h, i) => {
    const q = String(h.q || '').slice(0, 300);
    const a = String(h.a || '').slice(0, 600);
    return 'User: ' + q + '\nAssistant (Mobius): ' + a;
  }).join('\n\n');

  const last = history[history.length - 1];
  const lastQ = String(last.q || '').slice(0, 400);
  const lastA = String(last.a || '').slice(0, 1500);

  let summary = '';
  const summaryPrompt =
    'You are the Conductor. Summarise the following chat history into one concise paragraph ' +
    '(max 150 words) capturing the key topics, decisions, and evolving focus. ' +
    'This paragraph will be shown to AI specialists so they understand the conversation background.\n\n' +
    'Chat history:\n' + allPairs + '\n\n' +
    'Respond with ONLY the summary paragraph. No preamble, no labels.';

  for (const askFn of [
    () => askGroqCascade([{ role: 'user', content: summaryPrompt }]),
    () => askMistralCascade([{ role: 'user', content: summaryPrompt }])
  ]) {
    try { const r = await askFn(); summary = (r.text || '').trim(); if (summary) break; }
    catch { /* try next */ }
  }

  // Fallback: could not summarise -- show last 5 verbatim
  if (!summary) return buildHistoryContext(history.slice(-5));

  return '=== CONVERSATION CONTEXT ===\n' +
    'Summary of prior conversation:\n' + summary + '\n\n' +
    'Most recent exchange [MOST RECENT]:\n' +
    'User: ' + lastQ + '\nAssistant (Mobius): ' + lastA + '\n' +
    '=== END CONVERSATION CONTEXT ===\n\n';
}

async function generatePromptSuggestions(query, feedback = '', userToday = null, history = [], lastResponse = '') {
  const today = resolveToday(userToday);
  const feedbackNote = feedback
    ? '\n\nUser feedback on previous attempt: ' + feedback
    : '';
  const historyBlock = await buildHistoryContext(history);

  // Each AI decomposes the vague query into 4-5 specific sub-questions that can
  // be answered precisely from source material. Structured questions force
  // structured answers and reduce hand-wavy commentary in Step 2.
  // Today's date is injected so sub-questions can use concrete dates instead of
  // placeholders like [Current Date/Time] that different models resolve differently.
  const rawResults = await Promise.allSettled(
    TASK_AIS.map(async ai => {
      const t0 = Date.now();
      const r  = await ai.call([{ role: 'user', content:
        ai.persona + '\n\n' +
        'Today\'s date is ' + today + '.\n\n' +
        historyBlock +
        'TASK:\n' +
        'Synthesise the new query [3] into a self-referential Semantic Bridge using the History Context [1] and the Previous Response [2].\n\n' +
        'Formulate your proposal as:\n' +
        '[1] CONTEXT: (Distilled intent)\n' +
        '[2] ANCHOR: (Verbatim key points from last response)\n' +
        '[3] PROMPT: (4-5 sub-questions resolving all references)\n\n' +
        'The sub-questions must be self-contained but explicitly reference [2].\n\n' +
        'STEP-BY-STEP RESOLUTION:\n' +
        '1. Look at the CONVERSATION BRIDGE. Identify the previous query [1] and the previous response [2].\n' +
        '2. The new query [3] is a follow-up. Resolve all references in [3] (e.g. "your list", "those", "him") using the data in [2].\n' +
        '3. Formulate 4 to 5 sub-questions that specifically reference the entities found in [2].\n\n' +
        'CRITICAL - SELF-REFERENTIAL PROMPT:\n' +
        '  - The resulting sub-questions should be self-contained but framed as: "Based on the list in [2], compare X and Y..."\n' +
        '  - Ensure "your list" is replaced with "the list of [Entity Name] provided in [2]".\n\n' +
        'Each sub-question must also be:\n' +
        '  - Specific enough to elicit a concrete, factual answer (not vague commentary)\n' +
        '  - Answerable from current web sources\n' +
        '  - Non-redundant with the others\n' +
        '  - Use the actual date above -- do NOT write placeholders like [Current Date/Time].\n\n' +
        'Output ONLY the numbered sub-questions, one per line. Nothing else.\n\n' +
        'Query: "' + query + '"' + feedbackNote
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

  // Conductor (Groq) synthesises one best set of sub-questions from all 5 proposals
  const synthInput = suggestions.map((s, i) =>
    '[' + (i + 1) + '] ' + s.label + (s.failed ? ' [no response]' : '') + ':\n' + (s.text || '(none)')
  ).join('\n\n');

  let synthesised = suggestions.find(s => !s.failed)?.text || query;
  let relevantHistory = '';

  const conductorPrompt =
    'You are the Conductor. Today\'s date is ' + today + '.\n\n' +
    historyBlock +
    'Below are sub-question sets proposed by 5 AI specialists for the same user query.\n\n' +
    'Original query: "' + query + '"\n\n' +
    'Specialist [1]/[2]/[3] proposals:\n' + synthInput + '\n\n' +
    'Your task:\n' +
    '1. Evaluate the Specialist proposals for clarity and context resolution.\n' +
    '2. Rewrite and synthesise them into ONE canonical [1], [2], and [3] Semantic Bridge.\n' +
    '3. Ensure [3] is a perfectly clear set of sub-questions that Tavily can use for web search.\n\n' +
    'Respond ONLY with valid JSON in this format:\n' +
    '{"synthesised": "1. Question...\\n2. Question...", "relevant_history": "[1] CONTEXT...\\n[2] ANCHOR..."}';

  for (const askFn of [
    () => askGroqCascade([{ role: 'user', content: conductorPrompt }]),
    () => askMistralCascade([{ role: 'user', content: conductorPrompt }])
  ]) {
    try {
      const r = await askFn();
      const clean = (r.text || '').replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(clean);
      if (parsed.synthesised) {
        // SECOND PASS: Refinement & Clarity Check
        const refinementPrompt =
          'You are the Prompt Reviewer. Review the Semantic Bridge below.\n\n' +
          '[1] CONTEXTUAL GROUNDING:\n' + (parsed.relevant_history || 'n/a') + '\n\n' +
          '[2] PREVIOUS RESPONSE:\n'    + (lastResponse || 'n/a') + '\n\n' +
          '[3] NEW PROMPT (DRAFT):\n'    + parsed.synthesised + '\n\n' +
          'TASK:\n' +
          'Is the DRAFT prompt [3] completely clear and self-contained? Does it explicitly resolve references to "your list" or "those items" using the data in [2]?\n' +
          'If yes, return the DRAFT exactly as is. If no, provide a REFINED version of the sub-questions that is perfectly clear.\n\n' +
          'Output ONLY the refined sub-questions, nothing else.';

        const refined = await askGroqCascade([{ role: 'user', content: refinementPrompt }]);
        if (refined && refined.text && refined.text.length > 20) {
          parsed.synthesised = refined.text.trim();
        }
        
        synthesised     = parsed.synthesised.trim();
        relevantHistory = parsed.relevant_history || '';
        break;
      }
    } catch { /* try next */ }
  }

  // Regex safety net: replace any remaining [Current Date/Time]-style placeholders
  synthesised = scrubDatePlaceholders(synthesised, today);

  return { suggestions, synthesised, relevant_history: relevantHistory };
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

  // Conductor: Groq → Mistral fallback
  for (const askFn of [
    () => askGroqCascade([{ role: 'user', content: prompt }]),
    () => askMistralCascade([{ role: 'user', content: prompt }])
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

  // Conductor: Groq → Mistral fallback
  let summary = 'Evaluation summary unavailable.';
  for (const askFn of [
    () => askGroqCascade([{ role: 'user', content: summaryPrompt }]),
    () => askMistralCascade([{ role: 'user', content: summaryPrompt }])
  ]) {
    try { const r = await askFn(); summary = r.text.trim(); break; }
    catch { /* try next */ }
  }

  return { scores, summary };
}

// ── Task AI prompt builder ────────────────────────────────────────────────────
// Builds the full prompt a Task AI sees when answering in Step 2.
//
// Structure (when sources are provided):
//   persona → SOURCE MATERIAL block → CRITICAL INSTRUCTIONS → question
//
// Design choices that fight hallucination:
//   - Sources come BEFORE the instructions so the AI absorbs the data first.
//   - Instructions come AFTER the data but BEFORE the question, so they govern
//     how the AI treats the following question. Models weight recent tokens
//     more heavily -- instructions adjacent to the question are most obeyed.
//   - Explicit "say the sources do not specify X rather than guessing" is the
//     specific wording that stops small models from substituting training
//     data for missing facts.
//   - Per-source content truncated so the total prompt fits comfortably in
//     any Task AI's context window.
//
// When no sources are selected, falls back to persona + approved prompt (no
// grounding block, no instructions -- the AI uses training knowledge).

const MAX_CHARS_PER_SOURCE = 3000;

// ── buildTaskPrompt ───────────────────────────────────────────────────────────
// Formats the full prompt for the Task AIs in Step 2.
// Implements the [1] Context, [2] Response, [3] Prompt "Semantic Bridge".

function buildTaskPrompt(persona, approvedPrompt, query, srcs, userToday = null, relevantHistory = '', lastQuery = '', lastResponse = '') {
  const today = resolveToday(userToday);
  const cleanPrompt = scrubDatePlaceholders(approvedPrompt, today);

  const bridge = [
    relevantHistory ? '[1] CONTEXTUAL GROUNDING:\n' + relevantHistory : '',
    lastResponse    ? '[2] PREVIOUS RESPONSE:\n'    + lastResponse    : '',
    cleanPrompt     ? '[3] NEW PROMPT:\n'           + cleanPrompt     : ''
  ].filter(Boolean).join('\n\n');

  return persona + '\n\n' +
    'Today\'s date is ' + today + '.\n\n' +
    '=== SEMANTIC BRIDGE ===\n' +
    bridge + '\n' +
    '=== END SEMANTIC BRIDGE ===\n\n' +
    '=== SOURCE MATERIAL ===\n' +
    srcs.map((s, i) =>
      '[' + (i + 1) + '] Title: ' + (s.title || s.name || 'Untitled') + '\n' +
      'URL: ' + (s.url || 'n/a') + '\n' +
      'Content: ' + (s.raw_content || s.snippet || s.description || '(no content)')
    ).join('\n\n') + '\n\n' +
    'MISSION:\n' +
    '1. Use the SEMANTIC BRIDGE and the SOURCE MATERIAL above to address the sub-questions in [3].\n' +
    '2. [1] provides distilled context, [2] is the verbatim anchor, and [3] is your current mission.\n' +
    '3. Every specific fact, number, date, name, or quantity MUST come directly from the sources or the bridge. Cite the source URL or [2] in parentheses.\n' +
    '4. If a required fact is NOT present, state that plainly. Do NOT guess.\n\n' +
    'Address the sub-questions in [3] now:';
}

module.exports = { CONFIG, TASK_AIS, raceAtLeast, generatePromptSuggestions, evaluateAnswers, buildTaskPrompt, buildUserAnswer, conductorQualityGate, resolveToday };

// ── Conductor quality gate ────────────────────────────────────────────────────
// Reviews evaluation scores + summary and decides if the answer is good enough.
// Fast-path: clearly good (avg>=75, 0 flags) or clearly bad (avg<40) skip LLM.
// Middle range: Conductor (Groq->Mistral) makes the call and suggests revised
// sub-questions if failing. Called from orchestrate-stream.js after evaluateAnswers().
// Returns { pass, reason, revised_prompt? }
async function conductorQualityGate(query, evaluation) {
  const scores   = evaluation.scores || [];
  const summary  = evaluation.summary || '';
  const avg      = scores.length
    ? Math.round(scores.reduce((s, e) => s + (e.score?.total || 0), 0) / scores.length)
    : 0;
  const flagCount = (summary.match(/⚡\s*CONFLICT|⚠\s*VERIFY/g) || []).length;

  if (avg >= 75 && flagCount === 0)
    return { pass: true, reason: 'Avg ' + avg + '/100, no flags' };
  if (avg < 40)
    return { pass: false, reason: 'Avg score too low (' + avg + '/100)', revised_prompt: null };

  const scoresText = scores.map(s => (s.label || '') + ': ' + (s.score?.total || 0) + '/100').join(', ');
  const prompt =
    'You are the Conductor evaluating answer quality.\n\n' +
    'Query: "' + query + '"\n' +
    'Scores: ' + scoresText + '\nAverage: ' + avg + '/100\n' +
    'CONFLICT/VERIFY flags in summary: ' + flagCount + '\n\n' +
    'Summary excerpt:\n' + summary.slice(0, 600) + '\n\n' +
    'Decide if this answer quality is sufficient to present to the user.\n' +
    'Pass if: average >= 65, no major factual CONFLICTS, answers address the query.\n' +
    'Fail if: average < 55, significant CONFLICT flags, or answers clearly miss the query.\n\n' +
    'If failing, provide revised sub-questions that would produce better answers.\n\n' +
    'Respond ONLY with valid JSON, no markdown:\n' +
    '{"pass":true,"reason":"one sentence","revised_prompt":null}\n' +
    'or\n' +
    '{"pass":false,"reason":"one sentence","revised_prompt":"revised sub-questions here"}';

  for (const askFn of [
    () => askGroqCascade([{ role: 'user', content: prompt }]),
    () => askMistralCascade([{ role: 'user', content: prompt }])
  ]) {
    try {
      const r      = await askFn();
      const parsed = JSON.parse((r.text || '').replace(/```json|```/g, '').trim());
      if (typeof parsed.pass === 'boolean') {
        return {
          pass:           parsed.pass,
          reason:         String(parsed.reason || '').slice(0, 200),
          revised_prompt: parsed.revised_prompt || null
        };
      }
    } catch { /* try next */ }
  }
  // Fallback: threshold only
  return {
    pass:           avg >= 65 && flagCount <= 3,
    reason:         'Conductor eval failed; threshold avg=' + avg + ' flags=' + flagCount,
    revised_prompt: null
  };
}

// ── User Mode synthesis ──────────────────────────────────────────────────────
// Produces ONE cohesive prose answer from the 5 Task AI responses. Unlike the
// Dev Mode evaluation summary (which includes [3/3 agree] annotations and
// "Key Points / Differences / Concerns / Overall" structure), this output is
// a clean, natural answer with inline URL citations -- no mention of AIs, no
// voting annotations. Called only when the client sends mode='user'.
// ── buildUserAnswer ──────────────────────────────────────────────────────────
// Final synthesis step for User Mode.

async function buildUserAnswer(query, approvedPrompt, srcs, answers, userToday = null, relevantHistory = '', lastQuery = '', lastResponse = '') {
  const today = resolveToday(userToday);
  const bridge = [
    relevantHistory ? '[1] CONTEXTUAL GROUNDING:\n' + relevantHistory : '',
    lastResponse    ? '[2] PREVIOUS RESPONSE:\n'    + lastResponse    : '',
    approvedPrompt  ? '[3] NEW PROMPT:\n'           + approvedPrompt  : ''
  ].filter(Boolean).join('\n\n');

  const prompt =
    'You are Mobius, a concise, high-integrity AI orchestration engine.\n\n' +
    '=== SEMANTIC BRIDGE ===\n' +
    bridge + '\n' +
    '=== END SEMANTIC BRIDGE ===\n\n' +
    '=== SOURCE MATERIAL ===\n' +
    srcs.map((s, i) => '[' + (i + 1) + '] ' + (s.title || s.name || 'Untitled') + ' (' + (s.url || 'n/a') + ')').join('\n') + '\n\n' +
    '=== TASK AI RESPONSES ===\n' +
    (answers || []).map(a => a.aiLabel + ':\n' + (a.text || '(no answer)')).join('\n\n---\n\n') + '\n\n' +
    'MISSION:\n' +
    'Synthesise the Task AI responses into a single, clean prose answer for the user query [3].\n' +
    '- Use [1] for context and [2] as your previous anchor.\n' +
    '- Maintain the persona of Mobius: authoritative, factual, and minimal.\n' +
    '- Cite sources using [N] or [2] as appropriate.\n' +
    '- Output ONLY the final answer in markdown. No chatter.';

  for (const askFn of [
    () => askGroqCascade([{ role: 'user', content: prompt }]),
    () => askMistralCascade([{ role: 'user', content: prompt }])
  ]) {
    try {
      const r     = await askFn();
      const clean = scrubDatePlaceholders((r.text || '').trim(), today);
      if (clean.length > 20) return clean;
    } catch { /* try next */ }
  }

  // Fallback: longest Task AI response (scrubbed)
  const best = (answers || [])
    .filter(a => (a.text || '').length > 50)
    .sort((a, b) => (b.text || '').length - (a.text || '').length)[0];
  return scrubDatePlaceholders(
    best?.text || 'I could not produce an answer from the available sources.',
    today
  );
}
