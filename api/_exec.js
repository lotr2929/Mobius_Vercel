const Groq = require('groq-sdk');
const MistralClient = require('@mistralai/mistralai');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const mistral = new MistralClient(process.env.MISTRAL_API_KEY);

const CONFIG = {
  raceMin: 1, // Minimum Specialists to wait for
  maxSources: 25,
  defaultModel: 'llama-3.1-70b-versatile'
};

const TASK_AIS = [
  { id: 'llama-3.1-70b-versatile', label: 'Search Specialist', persona: 'You are an expert at identifying high-value web search terms and investigative paths.' },
  { id: 'llama-3.1-8b-instant', label: 'Analytical Specialist', persona: 'You are an expert at breaking down complex requests into logical, verifiable sub-questions.' },
  { id: 'mixtral-8x7b-32768', label: 'Brief AI', persona: 'You are an expert at providing concise, factual syntheses of research findings.' },
  { id: 'gemma-7b-it', label: 'Fact Checker', persona: 'You are an expert at cross-referencing claims and identifying potential hallucinations.' },
  { id: 'mistral-large-latest', label: 'Executive Specialist', persona: 'You are an expert at summarizing diverse perspectives into a single, authoritative brief.' }
];

// ── AI Cascade Utilities ──────────────────────────────────────────────────────

async function askGroqCascade(messages, model = CONFIG.defaultModel) {
  try {
    const res = await groq.chat.completions.create({ model, messages, temperature: 0.1 });
    return { text: res.choices[0]?.message?.content || '', modelUsed: model };
  } catch (err) {
    console.error('[Groq Error]', err.message);
    throw err;
  }
}

async function askMistralCascade(messages, model = 'mistral-large-latest') {
  try {
    const res = await mistral.chat({ model, messages, temperature: 0.1 });
    return { text: res.choices[0]?.message?.content || '', modelUsed: model };
  } catch (err) {
    console.error('[Mistral Error]', err.message);
    throw err;
  }
}

async function raceAtLeast(promises, minCount) {
  return new Promise((resolve) => {
    let results = [];
    let count = 0;
    promises.forEach((p, i) => {
      p.then(val => {
        results[i] = { status: 'fulfilled', value: val };
      }).catch(err => {
        results[i] = { status: 'rejected', reason: err };
      }).finally(() => {
        count++;
        if (count >= minCount) resolve(results);
      });
    });
  });
}

// ── Point 1 & 2: Context Augmentation ──────────────────────────────────────────

async function augmentQueryWithContext(query, history = [], lastResponse = '') {
  if (!history || history.length === 0) {
    return { isContextual: false, contextBlock: '', enrichedQuery: query, rationale: 'Standalone query.' };
  }

  const prompt = 
    'You are the Context Augmenter for Mobius.\n\n' +
    'CHAT HISTORY:\n' + (Array.isArray(history) ? history.join('\n') : history) + '\n\n' +
    'PREVIOUS RESPONSE:\n' + lastResponse + '\n\n' +
    'USER QUERY: "' + query + '"\n\n' +
    'TASK:\n' +
    '1. Is this query standalone or contextual?\n' +
    '2. If contextual, extract the EXACT FACTS, ENTITIES, or LISTS from the history that make this query meaningful.\n' +
    '3. Formulate an ENRICHED QUERY that prepends this context.\n\n' +
    'Respond ONLY with valid JSON:\n' +
    '{\n' +
    '  "isContextual": true,\n' +
    '  "contextBlock": "Facts extracted...",\n' +
    '  "enrichedQuery": "[CONTEXT: ...] Original Query",\n' +
    '  "rationale": "I extracted these facts because..."\n' +
    '}';

  try {
    const r = await askGroqCascade([{ role: 'user', content: prompt }]);
    const clean = (r.text || '').replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (err) {
    return { isContextual: false, contextBlock: '', enrichedQuery: query, rationale: 'Bypassed augmentation.' };
  }
}

// ── Point 3: Specialist Prompt Development ─────────────────────────────────────

async function generatePromptSuggestions(enrichedQuery, feedback = '', userToday = null) {
  const today = resolveToday(userToday);
  const feedbackNote = feedback ? '\n\nUSER FEEDBACK ON PREVIOUS DRAFT: "' + feedback + '"' : '';

  const rawResults = await Promise.allSettled(
    TASK_AIS.slice(0, 5).map(async (ai) => {
      const t0 = Date.now();
      const r = await askGroqCascade([{ role: 'user', content:
        ai.persona + '\n\n' +
        'Today\'s date is ' + today + '.\n\n' +
        'ENRICHED QUERY: "' + enrichedQuery + '"' + feedbackNote + '\n\n' +
        'TASK: Break this query down into 4-5 tactical research sub-questions. Respond ONLY with the questions.'
      }], ai.id);
      return { ...r, ms: Date.now() - t0 };
    })
  );

  const suggestions = rawResults.map((r, i) => ({
    id: TASK_AIS[i].id,
    label: TASK_AIS[i].label,
    text: r.status === 'fulfilled' ? (r.value.text || '').trim() : ''
  }));

  const synthInput = suggestions.map(s => s.label + ':\n' + s.text).join('\n\n');
  const conductorPrompt =
    'You are the Conductor. Synthesise the Specialist proposals into ONE research mission.\n\n' +
    'ENRICHED QUERY: "' + enrichedQuery + '"\n\n' +
    'SPECIALIST PROPOSALS:\n' + synthInput + '\n\n' +
    'TASK:\n' +
    '1. Synthesise into ONE canonical research prompt.\n' +
    '2. Provide a RATIONALE explaining the choice.\n\n' +
    'Respond ONLY with valid JSON:\n' +
    '{\n' +
    '  "synthesised": "1. ...\\n2. ...",\n' +
    '  "rationale": "Reasoning..."\n' +
    '}';

  try {
    const r = await askGroqCascade([{ role: 'user', content: conductorPrompt }]);
    const clean = (r.text || '').replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    return { suggestions, synthesised: parsed.synthesised, rationale: parsed.rationale };
  } catch {
    return { suggestions, synthesised: enrichedQuery, rationale: 'Auto-fallback to enriched query.' };
  }
}

// ── Answering & Synthesis ─────────────────────────────────────────────────────

function buildTaskPrompt(persona, query, srcs, userToday = null) {
  const today = resolveToday(userToday);
  return persona + '\n\n' +
    'Today\'s date is ' + today + '.\n\n' +
    'MISSION: ' + query + '\n\n' +
    'SOURCE MATERIAL:\n' +
    srcs.map((s, i) => '[' + (i + 1) + '] ' + s.title + '\nURL: ' + s.url + '\nContent: ' + (s.raw_content || s.snippet)).join('\n\n') + '\n\n' +
    'Answer the mission using ONLY the sources provided. Cite URLs in parentheses.';
}

async function buildUserAnswer(query, srcs, answers, userToday = null) {
  const today = resolveToday(userToday);
  const prompt = 
    'You are Mobius. Synthesise the following research findings into a single prose answer.\n\n' +
    'USER BRIEF: ' + query + '\n\n' +
    'FINDINGS:\n' + answers.map(a => a.aiLabel + ':\n' + a.text).join('\n\n---\n\n') + '\n\n' +
    'Cite sources [N] and provide a direct answer.';

  const r = await askGroqCascade([{ role: 'user', content: prompt }]);
  return scrubDatePlaceholders(r.text, today);
}

function scrubDatePlaceholders(text, today) {
  return text.replace(/\[Current Date\/Time\]/gi, today);
}

function resolveToday(userToday) {
  if (userToday) return userToday;
  const d = new Date();
  return d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

module.exports = { 
  CONFIG, TASK_AIS, askGroqCascade, askMistralCascade, raceAtLeast,
  augmentQueryWithContext, generatePromptSuggestions, buildTaskPrompt, buildUserAnswer 
};
