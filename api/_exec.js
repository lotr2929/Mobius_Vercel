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

async function generatePromptSuggestions(query, feedback = '', userToday = null) {
  const today = resolveToday(userToday);
  const feedbackNote = feedback
    ? '\n\nUser feedback on previous attempt: ' + feedback
    : '';

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
        'Convert the user\'s query below into a structured set of 4 to 5 clear, specific sub-questions ' +
        'that an AI can answer precisely using authoritative source material.\n\n' +
        'Each sub-question must be:\n' +
        '  - Specific enough to elicit a concrete, factual answer (not vague commentary)\n' +
        '  - Answerable from current web sources\n' +
        '  - Self-contained (can be understood and answered on its own)\n' +
        '  - Non-redundant with the others (no two questions ask the same thing)\n' +
        '  - If the question involves "today", "current", "now", or "this week", use the actual date above -- do NOT write placeholders like [Current Date/Time], [today], or [as of today].\n\n' +
        'Output ONLY the numbered sub-questions, one per line. Nothing else -- no preamble, ' +
        'no explanation, no headers, no summary.\n\n' +
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
  for (const askFn of [
    () => askGroqCascade([{ role: 'user', content:
      'You are the Conductor. Today\'s date is ' + today + '.\n\n' +
      'Below are sub-question sets proposed by 5 AI specialists for the same user query. ' +
      'Synthesise them into ONE canonical set of 4 to 5 numbered sub-questions.\n\n' +
      'Original query: "' + query + '"\n\n' +
      'Specialist sub-question sets:\n' + synthInput + '\n\n' +
      'The synthesised set must:\n' +
      '  - Cover the strongest and most important questions across all specialists\n' +
      '  - Collapse overlapping or redundant questions into single, clearer ones\n' +
      '  - Keep each question specific, answerable from source material, and self-contained\n' +
      '  - Contain 4 or 5 questions total -- not more, not fewer\n' +
      '  - Use the actual date "' + today + '" wherever the question references "today", "current", or "now". Do NOT emit placeholders like [Current Date/Time], [today], or [Date].\n\n' +
      'Output ONLY the numbered sub-questions, one per line. Nothing else -- no preamble, ' +
      'no labels, no explanation, no summary.' +
      (feedback ? '\n\nUser feedback to incorporate: ' + feedback : '')
    }]),
    () => askMistralCascade([{ role: 'user', content:
      'You are the Conductor. Today\'s date is ' + today + '. Synthesise these 5 specialist sub-question sets into ONE canonical set of 4 to 5 numbered sub-questions.\n\n' +
      'Original query: "' + query + '"\n\nSpecialist sets:\n' + synthInput + '\n\n' +
      'Cover the strongest questions, collapse redundancy, keep each specific and self-contained. ' +
      'Use the actual date above, never placeholders like [Current Date/Time]. ' +
      'Output ONLY the numbered sub-questions, nothing else.'
    }])
  ]) {
    try { const r = await askFn(); synthesised = r.text.trim(); break; }
    catch { /* try next */ }
  }

  // Regex safety net: replace any remaining [Current Date/Time]-style placeholders
  synthesised = scrubDatePlaceholders(synthesised, today);

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

function buildTaskPrompt(persona, approvedPrompt, query, selectedSources, userToday) {
  const today = resolveToday(userToday);
  const srcs = Array.isArray(selectedSources) ? selectedSources : [];

  // Scrub any placeholder dates that slipped through the Conductor, and also from
  // the approved prompt (in case the user hand-edited it with a placeholder).
  const cleanPrompt = scrubDatePlaceholders(approvedPrompt, today);

  if (srcs.length === 0) {
    return persona + '\n\n' +
      'Today\'s date is ' + today + '.\n\n' +
      cleanPrompt + '\n\nQuestion: ' + query;
  }

  const sourceBlock = srcs.map((s, i) => {
    const content = (s.raw_content || s.description || '').trim();
    const truncated = content.length > MAX_CHARS_PER_SOURCE
      ? content.slice(0, MAX_CHARS_PER_SOURCE) + '... [truncated]'
      : content;
    return '--- Source ' + (i + 1) + ': ' + (s.title || s.url) + ' ---\n' +
           'URL: ' + s.url + '\n' +
           (truncated ? '\n' + truncated + '\n' : '(no content available)\n');
  }).join('\n');

  return persona + '\n\n' +
    'Today\'s date is ' + today + '.\n\n' +
    '=== SOURCE MATERIAL ===\n' +
    sourceBlock +
    '\n=== END SOURCE MATERIAL ===\n\n' +
    'CRITICAL INSTRUCTIONS — follow these strictly:\n' +
    '1. Use ONLY the SOURCE MATERIAL above. Do NOT draw on your training data, prior knowledge, or memory.\n' +
    '2. Every specific fact, number, date, name, or quantity MUST come directly from the sources. Cite the source URL in parentheses immediately after the fact.\n' +
    '3. If a required fact is NOT present in the sources, write: "The provided sources do not specify [X]." Do NOT substitute values from training data. Do NOT guess. Do NOT output placeholder text such as [X,XXX.XX] or [bullish/bearish] -- if the data is absent, state that plainly.\n' +
    '4. If the sources conflict, surface the conflict explicitly and attribute each value to its source URL.\n' +
    '5. Answer EACH numbered sub-question below in order, using a matching numbered heading. Keep each answer self-contained and grounded in the sources.\n' +
    '6. If the sources are insufficient to answer a specific sub-question, say so for that sub-question and move on -- do not pad with generic commentary.\n' +
    '7. Any reference to "today", "current", "now", or "this week" in the sub-questions refers to ' + today + '. Do not substitute other dates.\n\n' +
    'Using only the data provided above, address the following sub-questions:\n\n' +
    cleanPrompt + '\n\n' +
    'Original user query (for reference): "' + query + '"';
}

module.exports = { CONFIG, TASK_AIS, raceAtLeast, generatePromptSuggestions, evaluateAnswers, buildTaskPrompt, buildUserAnswer, resolveToday };

// ── User Mode synthesis ──────────────────────────────────────────────────────
// Produces ONE cohesive prose answer from the 5 Task AI responses. Unlike the
// Dev Mode evaluation summary (which includes [3/3 agree] annotations and
// "Key Points / Differences / Concerns / Overall" structure), this output is
// a clean, natural answer with inline URL citations -- no mention of AIs, no
// voting annotations. Called only when the client sends mode='user'.
async function buildUserAnswer(query, approvedPrompt, selectedSources, answers, userToday) {
  const today = resolveToday(userToday);
  const srcs  = (selectedSources || []).slice(0, 20);

  const sourcesList = srcs.map((s, i) =>
    '[' + (i + 1) + '] ' + (s.title || s.url) + ' -- ' + s.url
  ).join('\n');

  const answersSection = (answers || []).map((a, i) =>
    'Specialist ' + (i + 1) + ':\n' + (a.text || '(no answer)')
  ).join('\n\n---\n\n');

  const prompt =
    "Today's date is " + today + ".\n\n" +
    "You are Mobius, a careful research assistant. Below are findings from 5 specialists who each addressed the user's question using the provided sources. Your job is to synthesise ONE clear, cohesive answer for the user.\n\n" +
    "User's question: \"" + query + "\"\n\n" +
    "Sub-questions investigated:\n" + approvedPrompt + "\n\n" +
    "Specialist findings:\n" + answersSection + "\n\n" +
    "Sources consulted:\n" + sourcesList + "\n\n" +
    "INSTRUCTIONS:\n" +
    "1. Write ONE continuous, natural answer. Use headings only if the topic genuinely needs them -- prefer flowing prose.\n" +
    "2. NEVER mention that multiple AIs or specialists were consulted. NEVER use annotations like [3/3 agree], [AI 1 said], or specialist names.\n" +
    "3. Where a specific fact comes from a source, cite the URL inline in parentheses, e.g. (https://example.com). Be concise with citations.\n" +
    "4. If findings conflict, state the uncertainty in plain language without naming who said what.\n" +
    "5. If the sources were thin on a particular point, say so briefly. Do not pad with generic commentary or training-data speculation.\n" +
    "6. Write as a knowledgeable human would -- natural tone, clear structure, no meta-commentary.\n" +
    "7. Do NOT include a 'Sources' or 'References' list at the end -- the interface will render that separately.\n\n" +
    "Your answer:";

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
