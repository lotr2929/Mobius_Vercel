// ── js/brief.js ──────────────────────────────────────────────────────────────
// Brief AI -- automatic evaluation of All Mode responses.
//
// Evaluation uses 5 separate criteria to prevent holistic score collapse:
//   accuracy     (1-5): does the response match what the SOURCE CODE actually does?
//   hallucination (1-5): invented code? 5=clean, 1=fabricated (INVERTED -- high is good)
//   relevance    (1-5): answers THIS query specifically?
//   specificity  (1-5): references actual code vs generic advice?
//   completeness (1-5): did it cover ALL parts of the query and ALL relevant code sections?
//   total = sum of 5, max 25. Recalculated client-side (don't trust AI maths).
//   winner = highest total.
//
// Hallucination detection: the injected brief is the source of truth.
// Any function name in a response not found in the brief is flagged.
// If H score <= 2, the model is highlighted red regardless of total.
//
// Loop:
//   Claude Desktop writes query to mcp.json
//   Boon deploys + refreshes
//   All Mode fires, 5 models respond
//   Brief AI evaluates, shows ranked results in chat, saves to chat.md
//   Claude Desktop reads chat.md, adjusts next query, writes to mcp.json
//   Boon deploys + refreshes
//
// Commands:
//   Brief: Start [problem]  -- create 4-step plan, write step 1 to mcp.json
//   Brief: Status           -- show current plan progress
//   Brief: Stop             -- disable auto-eval for this session
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  window.briefModeActive = false;

  const PLAN_FILE = 'brief_plan.json';
  const CTX_DIR   = '_context';

  // ── Auto-activate ─────────────────────────────────────────────────────────

  async function autoActivate() {
    await new Promise(r => setTimeout(r, 2000));
    const plan = await readPlan();
    if (plan && !plan.done) {
      window.briefModeActive = true;
      console.log('[brief] auto-activated: step ' + plan.currentStep + '/' + plan.steps.length);
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoActivate);
  } else {
    autoActivate();
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  function stableKeyFromName(name) {
    if (!name) return null;
    const n = name.toLowerCase();
    if (n.includes('gemini') && n.includes('lite')) return 'gemini-lite';
    if (n.includes('gemini'))   return 'gemini-cascade';
    if (n.includes('groq'))     return 'groq-cascade';
    if (n.includes('codestral') || (n.includes('mistral') && !n.includes('openrouter'))) return 'mistral-cascade';
    if (n.includes('cerebras')) return 'cerebras-cascade';
    return 'openrouter-cascade';
  }

  // ── Plan persistence ──────────────────────────────────────────────────────

  async function readPlan() {
    try {
      const root = window.coderRootHandle;
      if (root) {
        const ctx  = await root.getDirectoryHandle(CTX_DIR);
        const fh   = await ctx.getFileHandle(PLAN_FILE);
        const plan = JSON.parse(await (await fh.getFile()).text());
        localStorage.setItem('mc_brief_plan', JSON.stringify(plan));
        return plan;
      }
    } catch { /* fall through */ }
    try {
      const cached = localStorage.getItem('mc_brief_plan');
      return cached ? JSON.parse(cached) : null;
    } catch { return null; }
  }

  async function writePlan(plan) {
    try { localStorage.setItem('mc_brief_plan', JSON.stringify(plan)); } catch { /* quota */ }
    try {
      const root = window.coderRootHandle;
      if (!root) return;
      const ctx = await root.getDirectoryHandle(CTX_DIR, { create: true });
      const fh  = await ctx.getFileHandle(PLAN_FILE, { create: true });
      const w   = await fh.createWritable();
      await w.write(JSON.stringify(plan, null, 2) + '\n');
      await w.close();
    } catch (err) { console.warn('[brief] writePlan failed:', err.message); }
  }

  // ── Write next query to mcp.json ──────────────────────────────────────────

  async function writeMcpTask(query, project) {
    try {
      const root = window.coderRootHandle;
      if (!root) return false;
      const fh      = await root.getFileHandle('mcp.json');
      const current = JSON.parse(await (await fh.getFile()).text());
      current.session_task = {
        project: project || current.session_task?.project || window._indexedProject || '',
        query
      };
      const w = await fh.createWritable();
      await w.write(JSON.stringify(current, null, 2) + '\n');
      await w.close();
      return true;
    } catch { return false; }
  }

  // ── Deterministic pre-screening ─────────────────────────────────────────
  // Extracts function CALLS (name followed by '(') from each response.
  // Checks whether each function name appears in the brief (source of truth).
  // Returns a list of unverified function names per model.
  // This is factual, not AI judgment -- Coder checks, Brief AI scores.
  //
  // Note: new variable names in new code are NOT flagged (only function calls).
  // A function call like getChatFileHandle() is a claim about existing API.
  // A variable like const filenameResults = [] is new code, not a claim.

  // Node.js patterns that are wrong in a browser PWA
  const NODE_PATTERNS = [
    { re: /\brequire\s*\(/, label: 'require()' },
    { re: /\breadFileSync\b/, label: 'readFileSync' },
    { re: /\bwriteFileSync\b/, label: 'writeFileSync' },
    { re: /\bfs\./, label: 'fs.*' },
    { re: /\bpath\.join\b/, label: 'path.join' },
    { re: /\b__dirname\b/, label: '__dirname' },
    { re: /\bprocess\.env\b/, label: 'process.env' },
    { re: /\bmodule\.exports\b/, label: 'module.exports' },
    { re: /from\s+['"](node:|fs|path|os|crypto|stream)/, label: 'Node built-in import' },
  ];

  // TypeScript syntax patterns wrong in a vanilla JS project
  const TS_PATTERNS = [
    { re: /:\s*(string|number|boolean|void|any|never|unknown)\b/, label: 'TypeScript type annotation' },
    { re: /Promise<[^>]+>/, label: 'TypeScript Promise<T>' },
    { re: /\binterface\s+\w/, label: 'TypeScript interface' },
    { re: /\btype\s+\w+\s*=/, label: 'TypeScript type alias' },
    { re: /<[A-Z][A-Za-z]+>\s*\(/, label: 'TypeScript generic call' },
    { re: /as\s+[A-Z][A-Za-z]+\b/, label: 'TypeScript type cast' },
  ];

  // Known safe APIs -- these are real, don't flag as unverified
  const KNOWN_APIS = new Set([
    // Supabase client
    'from','select','insert','update','delete','upsert','rpc','eq','neq',
    'gt','lt','gte','lte','like','ilike','match','in','is','not','or','and',
    'single','maybeSingle','limit','range','order','filter','textSearch',
    // Browser/DOM
    'getElementById','querySelector','querySelectorAll','addEventListener',
    'removeEventListener','getAttribute','setAttribute','appendChild',
    'createElement','classList','style','dispatchEvent','scrollTo',
    // File System Access API
    'showDirectoryPicker','getFileHandle','getDirectoryHandle','createWritable',
    'requestPermission','queryPermission','entries',
    // Fetch / Promise
    'then','catch','finally','resolve','reject','all','race','json','text','blob',
    // Common utilities
    'trim','toLowerCase','toUpperCase','toString','toFixed','toISOString',
    'hasOwnProperty','keys','values','entries','assign','freeze',
    'stringify','parse','log','warn','error','info','debug',
    // Array methods already in builtins but worth repeating
    'flat','flatMap','findIndex','indexOf','lastIndexOf','fill','copyWithin',
    // String methods
    'padStart','padEnd','repeat','matchAll','replaceAll','at',
    // indexedDB
    'open','transaction','objectStore','put','get','getAll','createIndex',
    // Additional DOM / browser APIs commonly appearing in technical prose
    'elements','comment','needle','close','write','read','matches','closest',
    'contains','cloneNode','removeChild','insertBefore','replaceChild',
    'getContext','requestAnimationFrame','cancelAnimationFrame',
    'getBoundingClientRect','getComputedStyle','offsetWidth','offsetHeight',
    'focus','blur','click','submit','reset','checkValidity','setCustomValidity',
    // mobius project functions -- real functions, never flag as hallucinated
    'getMemoryContext','getCodeContext','autoEvaluate','autoExtractMemory',
    'buildContext','sendToAI','runAllModels','appendToLog',
    'getAuth','setLastModel','getLastModel','addToHistory',
    'getTargetHandle','getRootHandle','markdownToHtml',
    'recordWin','recordLoss','recordLatency',
  ]);

  function _preScreenResponses(valid, briefText) {
    return valid.map(e => {
      const text = String(e.content);

      // 1. Detect function calls not in brief -- but only if NOT defined in the same response
      //    (distinguishes new proposed functions from claims about existing API)
      const calls = new Set();
      const callRegex = /\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g;
      const defRegex  = /(?:function|async function)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g;
      const defined   = new Set();
      let m;
      while ((m = defRegex.exec(text)) !== null) defined.add(m[1]);
      while ((m = callRegex.exec(text)) !== null) {
        const name = m[1];
        if (name.length < 4) continue;
        const builtins = new Set(['function','async','await','return','throw','catch','const','let','var','if','for','while','switch','console','Promise','Array','Object','JSON','Math','String','Number','Boolean','Date','Map','Set','fetch','setTimeout','parseInt','parseFloat','encodeURIComponent','decodeURIComponent','filter','forEach','reduce','includes','startsWith','endsWith','slice','split','join','replace','push','find','sort','some','every']);
        if (builtins.has(name)) continue;
        if (KNOWN_APIS.has(name)) continue;  // real library API, not a hallucination
        if (!defined.has(name)) calls.add(name);
      }
      const unverified = [];
      calls.forEach(fn => {
        if (!briefText.includes(fn)) unverified.push(fn + '()');
      });

      // 2. Detect Node.js patterns (wrong runtime for this browser PWA)
      const nodeIssues = NODE_PATTERNS.filter(p => p.re.test(text)).map(p => p.label);

      // 3. Detect TypeScript syntax (wrong language for this vanilla JS project)
      const tsIssues = TS_PATTERNS.filter(p => p.re.test(text)).map(p => p.label);

      return { model: e.model, calls: Array.from(calls), unverified, nodeIssues, tsIssues };
    });
  }

  // ── Auto-evaluation ───────────────────────────────────────────────────────
  // Called from all.js after all 5 responses arrive.

  window.autoEvaluate = async function (query, logEntries, brief, category) {
    // Determine which criteria apply based on task category
    // Generative tasks (Write/Fix/Debug) get a 6th criterion: Code Correctness
    // Explanation tasks (Understand/Plan/Brief/General) use 5 criteria
    const cat = (category || 'General').trim();
    const isGenerative = ['Write', 'Fix', 'Debug'].includes(cat);
    const MAX_SCORE = isGenerative ? 30 : 25;
    // Evaluate if: (a) briefModeActive with active plan, OR (b) briefEvalAlways is set
    // briefEvalAlways always ON -- evaluation fires for every All Mode query
    window.briefEvalAlways = true;
    const plan = await readPlan();
    const hasActivePlan = plan && !plan.done;

    if (!window.briefModeActive && !window.briefEvalAlways) return;
    if (window.briefModeActive && !hasActivePlan && !window.briefEvalAlways) return;

    const valid  = logEntries.filter(e => !String(e.content).startsWith('[Error'));
    const failed = logEntries.filter(e =>  String(e.content).startsWith('[Error'));

    if (!valid.length) { console.warn('[brief] no valid responses to evaluate'); return; }

    // ── Timing setup ──────────────────────────────────────────────────────
    const evalStart = Date.now();
    const taskMs    = (window.allModeResponsesIn && window.allModeQueryStart)
                      ? window.allModeResponsesIn - window.allModeQueryStart : null;
    function fmtMs(ms) {
      if (!ms) return '?';
      return ms < 1000 ? ms + 'ms' : (ms / 1000).toFixed(1) + 's';
    }

    // ── Status element -- shown immediately so user knows eval is running ──
    const chatPanel = document.getElementById('chatPanel');
    let statusEl = null;
    if (chatPanel) {
      statusEl = document.createElement('div');
      statusEl.className = 'chat-entry';
      statusEl.style.cssText = 'border-left:3px solid #a06800;padding:6px 0 4px 10px;'
        + 'margin:8px 0 4px;font-size:12px;color:var(--text-dim);';
      statusEl.innerHTML = '<span style="font-size:11px;text-transform:uppercase;'
        + 'letter-spacing:0.06em;">Brief AI</span>'
        + (taskMs ? ' \u00b7 task models: ' + fmtMs(taskMs) : '')
        + '<br>\u231B Sending responses to 9 evaluators...';
      chatPanel.appendChild(statusEl);
      chatPanel.scrollTop = chatPanel.scrollHeight;
    }
    let evalReturned = 0;
    function updateStatus(msg) {
      if (!statusEl || !statusEl.parentNode) return;
      statusEl.innerHTML = '<span style="font-size:11px;text-transform:uppercase;'
        + 'letter-spacing:0.06em;">Brief AI</span>'
        + (taskMs ? ' \u00b7 task models: ' + fmtMs(taskMs) : '')
        + '<br>' + msg;
      if (chatPanel) chatPanel.scrollTop = chatPanel.scrollHeight;
    }

    // The brief is the SOURCE OF TRUTH for hallucination detection.
    // Any function name in a response not found here is potentially invented.
    // Use more of the brief when it contains actual code (the [Relevant code] section)
    // This gives the evaluator enough source code to verify accuracy properly
    const briefSnippet = brief ? String(brief).slice(0, 2500) : '(no source code was injected)';

    // Deterministic pre-screen: extract function calls from each response,
    // check which ones exist in the brief. AI judges quality; Coder checks facts.
    const prescreened = _preScreenResponses(valid, briefSnippet);

    // Cross-response consensus: function names used by 3+ models are likely real
    // This is deterministic -- Coder counts, Brief AI judges
    const allCalls = prescreened.map(p => p.calls).flat();
    const callCount = {};
    allCalls.forEach(fn => { callCount[fn] = (callCount[fn] || 0) + 1; });
    const consensusFns = new Set(Object.keys(callCount).filter(fn => callCount[fn] >= 3));

    const responseText = valid
      .map(e => {
        const ps = prescreened.find(p => p.model === e.model);
        const tags = [];
        const verifiedByConsensus = ps ? ps.unverified.filter(fn => consensusFns.has(fn.replace('()',''))) : [];
        const trulyUnverified    = ps ? ps.unverified.filter(fn => !consensusFns.has(fn.replace('()',''))) : [];
        if (trulyUnverified.length)          tags.push('[CODER: unverified calls (not in context, not consensus): ' + trulyUnverified.join(', ') + ']');
        if (verifiedByConsensus.length)      tags.push('[CODER: consensus calls (3+ models agree, likely real): ' + verifiedByConsensus.join(', ') + ']');
        if (ps && ps.nodeIssues.length)      tags.push('[CODER: Node.js in browser PWA -- WRONG RUNTIME: ' + ps.nodeIssues.join(', ') + ']');
        if (ps && ps.tsIssues.length)        tags.push('[CODER: TypeScript in vanilla JS -- WRONG LANGUAGE: ' + ps.tsIssues.join(', ') + ']');
        return '[' + e.model + ']:\n' + String(e.content).slice(0, 1200).trim()
          + (tags.length ? '\n' + tags.join('\n') : '');
      })
      .join('\n\n---\n\n');

    // PROJECT CONTEXT injected so Brief AI knows what it's evaluating.
    // This is deterministic -- does not depend on what the RAG returns.
    const projectCtx =
      'PROJECT: mobius -- browser PWA, vanilla JavaScript (NO TypeScript, NO Node.js, NO React).\n'
      + 'Serverless API routes in /api/ (Vercel functions). Supabase for DB. File System Access API for local disk.\n'
      + 'Any response using require(), readFileSync, TypeScript syntax, or Node.js built-ins is INCORRECT for this project.\n';

    // Evaluation prompt: 4 criteria scored SEPARATELY to prevent holistic collapse.
    // Hallucination is scored inverted (5=clean, 1=fabricated) and is highest priority.
    // The brief is referenced as source of truth for hallucination check.
    const evalPrompt =
      'You are evaluating AI responses to a coding question.\n'
      + 'Reply ONLY with valid JSON. No markdown, no explanation outside the JSON.\n\n'
      + projectCtx + '\n'
      + '=== SOURCE OF TRUTH (context injected into the models) ===\n'
      + briefSnippet + '\n'
      + '=== END SOURCE OF TRUTH ===\n\n'
      + 'QUERY: "' + query.slice(0, 300) + '"\n\n'
      + 'RESPONSES:\n' + responseText + '\n\n'
      + 'SCORING INSTRUCTIONS:\n'
      + 'Score each model on ' + (isGenerative ? 'SIX' : 'FIVE') + ' criteria independently. Do not let one criterion influence another.\n\n'
      + '1. accuracy (1-5): Does the response correctly describe what the SOURCE CODE above ACTUALLY DOES?\n'
      + '   STEP 1: Find the relevant function or logic in the SOURCE OF TRUTH above.\n'
      + '   STEP 2: Note EXACTLY what the code does -- variable names, call ORDER, conditions, return values.\n'
      + '   STEP 3: Check whether the response matches that code, including the SEQUENCE of operations.\n'
      + '   STEP 4: Find the EXACT line from SOURCE OF TRUTH that best confirms your score.\n'
      + '   5=matches source code exactly including correct sequence of calls\n'
      + '   4=mostly matches, minor omission or slight imprecision\n'
      + '   3=partially correct, or source code not available to verify\n'
      + '   2=contradicts the source -- wrong order, wrong variables, wrong logic\n'
      + '   1=completely wrong, invents behaviour not shown in source code\n'
      + '   NOTE: Getting the ORDER wrong is an accuracy failure -- score 2 or below.\n'
      + '   REQUIRED: "code_quote" field must contain the exact line from SOURCE OF TRUTH confirming your score.\n'
      + '   If you cannot find a matching line, accuracy CANNOT be higher than 3. Write "no source available" in code_quote.\n\n'
      + '2. hallucination (1-5, INVERTED -- 5 is best):\n'
      + '   Did the model claim EXISTING API functions that are NOT in SOURCE OF TRUTH?\n'
      + '   NOTE: new variable names introduced in new code are NOT hallucinations -- only function calls matter.\n'
      + '   USE THE [CODER: ...] tags above as your primary signal -- these are factual checks, not AI judgment.\n'
      + '   [CODER: Node.js patterns] and [CODER: TypeScript syntax] tags = WRONG for this project, penalise heavily (H:1 or H:2).\n'
      + '   [CODER: unverified function calls] = suspicious but may be new proposed code -- penalise moderately.\n'
      + '   5=nothing wrong  3=minor issues  1=core answer uses wrong runtime/language or fabricated API\n'
      + '   list every problematic item in hallucinated_items array.\n\n'
      + '3. relevance (1-5): Does it answer THIS specific query, not a related one?\n'
      + '   5=directly answers  3=partially answers  1=answers a different question\n\n'
      + '4. specificity (1-5): Does it reference actual code vs generic advice?\n'
      + '   5=references specific functions/logic from context  1=generic advice only\n\n'
      + '5. completeness (1-5): Did the response cover ALL parts of the query AND all relevant code in SOURCE OF TRUTH?\n'
      + '   STEP 1: List every sub-question in the query (e.g. "how does X work", "show code for Y", "does it do Z").\n'
      + '   STEP 2: List every distinct code block or section in SOURCE OF TRUTH relevant to the query.\n'
      + '   STEP 3: Count how many of each the response actually addressed.\n'
      + '   5=addressed every sub-question and every relevant code section from SOURCE OF TRUTH\n'
      + '   4=missed 1 minor sub-question or code section\n'
      + '   3=missed 1-2 significant sections -- answer is correct but incomplete\n'
      + '   2=answered less than half the query, missed major sections\n'
      + '   1=barely addresses the query\n'
      + '   CRITICAL: A response that is accurate but incomplete MUST score low here.\n'
      + '   Example: source shows 4 context sections, response covers 2 -- score C:2 regardless of accuracy.\n\n'
      + (isGenerative
        ? '6. codeCorrectness (1-5): Is the PROPOSED CODE syntactically and logically correct for this project?\n'
          + '   This criterion applies because this is a Write/Fix/Debug task -- the model must produce working code.\n'
          + '   5=code is syntactically correct, logically sound, and would run without errors in this browser PWA\n'
          + '   4=mostly correct, minor issue that is easily fixed\n'
          + '   3=partially correct, has a logical flaw or missing piece but the approach is right\n'
          + '   2=code has significant errors -- wrong API, wrong structure, would fail at runtime\n'
          + '   1=code is fundamentally broken or not provided when required\n'
          + '   NOTE: only score code the model PROPOSES as a solution, not code it quotes from SOURCE OF TRUTH.\n\n'
        : '')
      + 'CONSENSUS RULE: If a function name appears in 3+ responses, treat it as likely real (raise H score).\n'
      + 'If a name appears in only 1 response and is not in SOURCE OF TRUTH, it is probably invented (lower H score).\n\n'
      + 'TIEBREAKER: When two or more models have the same total score, rank higher the one that:\n'
      + '  - Quotes or references specific variable names from the SOURCE CODE (not just generic patterns)\n'
      + '  - Identifies edge cases or important details not explicitly asked about\n'
      + '  - Gives the most actionable answer (could implement it directly from the response)\n\n'
      + 'JSON format (scores for ALL models, sorted by total descending):\n'
      + '{"scores":['
      + '{"model":"exact name","accuracy":4,"code_quote":"exact line from SOURCE OF TRUTH","hallucination":3,"relevance":5,"specificity":4,"completeness":3,'
      + (isGenerative ? '"codeCorrectness":4,' : '')
      + '"total":' + MAX_SCORE + ',"hallucinated_items":["functionName()"],"comment":"one sentence"}'
      + '],'
      + '"winner":"model name with highest total",'
      + '"winner_reason":"one sentence -- why this model gave the best answer",'
      + '"synthesis":"two sentences -- what is the correct answer to the query",'
      + '"confidence":"high|medium|low"}';

    // ── Multi-evaluator: fire all 5 models as evaluators in parallel ──────
    try {
    // Scores are averaged across all evaluators that return valid JSON.
    // This surfaces evaluator biases and identifies which models are best at evaluation.

    const EVAL_MODELS = ['groq', 'gemini', 'codestral', 'openrouter', 'cerebras', 'github', 'groq-qwq', 'deepseek-cloud', 'deepseek-r1'];

    const evalResults = await Promise.allSettled(
      EVAL_MODELS.map(async (model) => {
        const result = await fetch('/ask', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: evalPrompt, model, userId: window.getAuth('mobius_user_id') }),
          signal: AbortSignal.timeout(25000)
        }).then(r => r.json());
        evalReturned++;
        updateStatus('\u231B ' + evalReturned + '/' + EVAL_MODELS.length + ' evaluators responded...');
        return result;
      })
    );

    // Parse each evaluator's JSON response
    const parsedEvals = [];
    for (let i = 0; i < evalResults.length; i++) {
      if (evalResults[i].status !== 'fulfilled') continue;
      const data = evalResults[i].value;
      const raw  = (data.reply || '').replace(/```json[\s\S]*?```/g, m => m.slice(7, -3)).replace(/```/g, '').trim();
      try {
        const parsed = JSON.parse(raw);
        if (parsed.scores && parsed.scores.length) {
          parsedEvals.push({ evaluator: EVAL_MODELS[i], eval: parsed });
        }
      } catch { console.warn('[brief] ' + EVAL_MODELS[i] + ' eval failed to parse'); }
    }

    if (!parsedEvals.length) throw new Error('All evaluators failed to return valid JSON');
    console.log('[brief] ' + parsedEvals.length + '/' + EVAL_MODELS.length + ' evaluators returned valid scores');

    // Aggregate scores across all evaluators
    // scoreMap: taskModel -> { accuracy:[], hallucination:[], relevance:[], specificity:[], halluItems: Set, votes: [] }
    const scoreMap = {};
    const winnerVotes = {};

    for (const { evaluator, eval: ev } of parsedEvals) {
      // Track winner votes -- normalise name against known task models
      if (ev.winner) {
        const knownModels2 = valid.map(e => e.model);
        let normWinner = ev.winner;
        for (const km of knownModels2) {
          if (km === ev.winner) { normWinner = km; break; }
          const a = km.toLowerCase(), b = ev.winner.toLowerCase();
          if (a.includes(b) || b.includes(a)) { normWinner = km; break; }
          const lastA = a.split(/[:\s]+/).pop();
          const lastB = b.split(/[:\s]+/).pop();
          if (lastA && lastB && lastA === lastB) { normWinner = km; break; }
        }
        winnerVotes[normWinner] = (winnerVotes[normWinner] || 0) + 1;
      }

      for (const s of (ev.scores || [])) {
        if (!s.model) continue;
        // Normalise model name -- evaluators sometimes truncate or rephrase names
        // Match against known task model names using fuzzy containment
        const knownModels = valid.map(e => e.model);
        let normModel = s.model;
        for (const km of knownModels) {
          // Direct match or one contains the other (handles truncation)
          if (km === s.model) { normModel = km; break; }
          const a = km.toLowerCase(), b = s.model.toLowerCase();
          if (a.includes(b) || b.includes(a)) { normModel = km; break; }
          // Match on last significant word (e.g. 'gemma-3n-e4b-it' matches 'OpenRouter: gemma-3n-e4b-it')
          const lastA = a.split(/[:\s]+/).pop();
          const lastB = b.split(/[:\s]+/).pop();
          if (lastA && lastB && lastA === lastB) { normModel = km; break; }
        }
        if (!scoreMap[normModel]) {
          scoreMap[normModel] = { accuracy: [], hallucination: [], relevance: [], specificity: [], completeness: [], codeCorrectness: [],
                                halluItems: new Set(), comments: [], codeQuotes: [], selfScore: null };
        }
        const sm = scoreMap[normModel];
        // Cap accuracy at 3 if evaluator provided no code quote -- enforces source citation
        const hasQuote = s.code_quote && s.code_quote.trim() && s.code_quote !== 'no source available';
        sm.accuracy.push(hasQuote ? (s.accuracy || 0) : Math.min(s.accuracy || 0, 3));
        if (hasQuote) sm.codeQuotes.push(s.code_quote.trim());
        sm.hallucination.push(s.hallucination || 0);
        sm.relevance.push(s.relevance || 0);
        sm.specificity.push(s.specificity || 0);
        sm.completeness.push(s.completeness || 0);
        if (isGenerative) sm.codeCorrectness.push(s.codeCorrectness || 0);
        (s.hallucinated_items || []).forEach(h => sm.halluItems.add(h));
        if (s.comment) sm.comments.push('[' + evaluator + '] ' + s.comment);
        // Self-score: explicit mapping handles cases where evaluator key != task model name
        // e.g. evaluator 'codestral' scores task model 'Mistral'
        const SELF_MAP = {
          'groq':          ['groq'],
          'gemini':        ['gemini'],
          'codestral':     ['mistral', 'codestral'],
          'openrouter':    ['openrouter'],
          'cerebras':      ['cerebras'],
          'github':        ['github'],
          'groq-qwq':      ['qwq'],
          'deepseek-cloud':['deepseek v3', 'deepseek'],
          'deepseek-r1':   ['deepseek r1'],
        };
        const selfNames = SELF_MAP[evaluator] || [evaluator.toLowerCase()];
        if (selfNames.some(n => normModel.toLowerCase().includes(n))) {
          sm.selfScore = s.accuracy || 0;
        }
      }
    }

    // Calculate averages -- one decimal place
    const avgArr = arr => arr.length ? Math.round((arr.reduce((a,b)=>a+b,0)/arr.length) * 10) / 10 : 0;

    const scores = Object.entries(scoreMap).map(([model, sm]) => ({
      model,
      accuracy:        avgArr(sm.accuracy),
      hallucination:   avgArr(sm.hallucination),
      relevance:       avgArr(sm.relevance),
      specificity:     avgArr(sm.specificity),
      completeness:    avgArr(sm.completeness),
      codeCorrectness: isGenerative ? avgArr(sm.codeCorrectness) : null,
      total: avgArr([...sm.accuracy.map((a, i) =>
        a
        + (sm.hallucination[i]    || 0)
        + (sm.relevance[i]        || 0)
        + (sm.specificity[i]      || 0)
        + (sm.completeness[i]     || 0)
        + (isGenerative ? (sm.codeCorrectness[i] || 0) : 0)
      )]),
      hallucinated_items: Array.from(sm.halluItems),
      comment:            sm.comments.slice(0, 2).join(' | '),
      evaluator_count:    sm.accuracy.length,
      self_score:         sm.selfScore,
      best_code_quote:    sm.codeQuotes.reduce((a, b) => b.length > a.length ? b : a, '')
    }));
    scores.sort((a, b) => b.total - a.total);

    // Winner = highest aggregate score, with H≤2 veto
    // A model that hallucinated severely cannot win regardless of other scores
    let computedWinner = null;
    for (const s of scores) {
      if ((s.hallucination || 0) > 2) { computedWinner = s.model; break; }
    }
    if (!computedWinner) computedWinner = scores[0]?.model; // all hallucinated badly -- pick least bad
    const winnerVoteCount = winnerVotes[computedWinner] || 0;

    // ── Phase 2: Head-to-head comparison of closely-ranked top models ─────
    // Fires only when top models are within 2 points of each other.
    // Two trusted evaluators compare them directly with source code context.
    // Phase 2 ranking overrides Phase 1 for top positions only.
    let phase2Rankings = null;
    const topScore  = scores[0]?.total || 0;
    const contested = scores.filter(s => (s.hallucination || 0) > 2 && topScore - s.total < 2.0).slice(0, 4);
    if (contested.length >= 2) {
      updateStatus('\u231B Phase 2: comparing top ' + contested.length + ' models head-to-head...');
      const topResponseText = contested.map(s => {
        const entry = valid.find(e => e.model === s.model);
        return entry ? '[' + s.model + ']:\n' + String(entry.content).slice(0, 1500).trim() : '';
      }).filter(Boolean).join('\n\n---\n\n');

      const phase2Prompt =
        'You are comparing ' + contested.length + ' AI responses HEAD-TO-HEAD.\n'
        + 'These models scored similarly in independent evaluation. Produce a DEFINITIVE RANKING.\n'
        + 'Reply ONLY with valid JSON. No markdown.\n\n'
        + '=== SOURCE OF TRUTH ===\n' + briefSnippet + '\n=== END ===\n\n'
        + 'QUERY: "' + query.slice(0, 200) + '"\n\n'
        + 'RESPONSES TO COMPARE:\n' + topResponseText + '\n\n'
        + 'For each response evaluate:\n'
        + '1. What specific variable/function names from SOURCE does it correctly quote?\n'
        + '2. What does SOURCE show that this response OMITS?\n'
        + '3. Is the call ORDER correct vs SOURCE?\n'
        + '4. Which response is MOST COMPLETE and MOST ACCURATE?\n\n'
        + 'JSON: {"ranking":["best","second","third","fourth"],'
        + '"reasons":{"model_name":"why ranked here -- quote a source line"}}\n'
        + 'Use exact model names as they appear above.';

      const phase2Results = await Promise.allSettled([
        fetch('/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: phase2Prompt, model: 'deepseek-r1', userId: window.getAuth('mobius_user_id') }),
          signal: AbortSignal.timeout(25000) }).then(r => r.json()),
        fetch('/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: phase2Prompt, model: 'gemini', userId: window.getAuth('mobius_user_id') }),
          signal: AbortSignal.timeout(25000) }).then(r => r.json())
      ]);

      const p2Rankings = [];
      for (const result of phase2Results) {
        if (result.status !== 'fulfilled') continue;
        const raw = (result.value.reply || '').replace(/```json[\s\S]*?```/g, m => m.slice(7,-3)).replace(/```/g,'').trim();
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed.ranking) && parsed.ranking.length) p2Rankings.push(parsed);
        } catch { /* skip malformed */ }
      }

      if (p2Rankings.length) {
        // Normalise Phase 2 model names against known models
        const knownModels = valid.map(e => e.model);
        const p2Norm = p2Rankings.map(r => ({
          ...r,
          ranking: r.ranking.map(name => {
            for (const km of knownModels) {
              if (km === name) return km;
              const a = km.toLowerCase(), b = name.toLowerCase();
              if (a.includes(b) || b.includes(a)) return km;
            }
            return name;
          })
        }));
        // Build vote tally: position scores (rank 1 = N points, rank 2 = N-1, ...)
        const p2Votes = {};
        p2Norm.forEach(r => r.ranking.forEach((m, i) => { p2Votes[m] = (p2Votes[m] || 0) + (contested.length - i); }));
        const p2Sorted = Object.entries(p2Votes).sort((a,b) => b[1]-a[1]).map(([m]) => m);
        // Collect reasons from first result
        const p2Reasons = p2Norm[0]?.reasons || {};
        phase2Rankings = { order: p2Sorted, reasons: p2Reasons, evaluators: p2Rankings.length };
        console.log('[brief] Phase 2 ranking:', p2Sorted);
      }
    }

    // Apply Phase 2 ranking to top positions.
    // Protection: Phase 2 cannot override if Phase 1 plurality winner had 3+ votes.
    // A strong Phase 1 consensus (3+ evaluators agreeing) should not be reversed
    // by 2 Phase 2 judges, one of which may be evaluating itself.
    const phase1Winner      = computedWinner;
    const phase1WinnerVotes = winnerVotes[phase1Winner] || 0;
    const phase2CanOverride = phase1WinnerVotes < 3;

    if (phase2CanOverride && phase2Rankings && phase2Rankings.order.length >= 2) {
      const rest = scores.filter(s => !phase2Rankings.order.includes(s.model));
      const p2Top = phase2Rankings.order
        .map(m => scores.find(s => s.model === m))
        .filter(Boolean);
      scores.splice(0, scores.length, ...p2Top, ...rest);
      // Re-apply H≤2 veto after resorting
      computedWinner = null;
      for (const s of scores) {
        if ((s.hallucination || 0) > 2) { computedWinner = s.model; break; }
      }
      if (!computedWinner) computedWinner = scores[0]?.model;
    }
    // Store Phase 2 data on eval_
    // Build a synthetic eval_ object for compatibility with existing render/log functions
    const primaryEval = parsedEvals.find(p => p.evaluator === 'groq')?.eval
                     || parsedEvals[0]?.eval
                     || {};
    const eval_ = {
      winner:       computedWinner,
      winner_reason: 'Score ' + (scores.find(s=>s.model===computedWinner)?.total || 0) + '/' + MAX_SCORE + ' · ' + winnerVoteCount + '/' + EVAL_MODELS.length + ' evaluators voted'
        + (phase2Rankings && phase2CanOverride ? ' · P2' : '')
        + (phase2Rankings && !phase2CanOverride ? ' · P2 blocked (strong P1 consensus)' : ''),
      synthesis:    primaryEval.synthesis || '',
      confidence:   primaryEval.confidence || 'medium',
      winnerVotes, parsedEvals: parsedEvals.length, evalModels: EVAL_MODELS.length,
      isGenerative, maxScore: MAX_SCORE, phase2: phase2Rankings
    };

      // Record win
      const key = stableKeyFromName(eval_.winner);
      if (key && window.Scores) window.Scores.recordWin(key, plan.category || 'General');

      // Advance plan only if one is active
      const stepIdx   = hasActivePlan ? (plan.currentStep || 1) - 1 : 0;
      const nextIdx   = stepIdx + 1;
      const hasNext   = hasActivePlan && nextIdx < plan.steps.length;
      const planTotal = hasActivePlan ? plan.steps.length : 1;

      if (hasActivePlan) {
        plan.lastResult  = { step: plan.currentStep, winner: eval_.winner, synthesis: eval_.synthesis, confidence: eval_.confidence };
        plan.currentStep = hasNext ? nextIdx + 1 : plan.steps.length;
        plan.done        = !hasNext;
        await writePlan(plan);
      }

      let mcpWritten = false;
      if (hasNext) mcpWritten = await writeMcpTask(plan.steps[nextIdx], plan.project);

      // Remove the status element -- replaced by full evaluation result
      if (statusEl && statusEl.parentNode) statusEl.parentNode.removeChild(statusEl);

      const evalMs  = Date.now() - evalStart;
      const totalMs = window.allModeQueryStart ? Date.now() - window.allModeQueryStart : null;
      function fmtMsLocal(ms) { return ms < 1000 ? ms + 'ms' : (ms/1000).toFixed(1) + 's'; }
      eval_.timing = [taskMs && 'Task: ' + fmtMsLocal(taskMs), evalMs && 'Eval: ' + fmtMsLocal(evalMs), totalMs && 'Total: ' + fmtMsLocal(totalMs)].filter(Boolean).join(' | ');
      // ── SUCCESS_CRITERION check (L4 evaluation) ────────────────────────
      // When Brief: Protocol set a schema brief, check winner against criterion.
      // Fail: write trajectory to .context so next run is an informed retry.
      let criterionResult = null;
      if (window.lastReadFile && window.lastReadFile.path === '[Protocol Brief]') {
        try {
          const briefText   = window.lastReadFile.content || '';
          const critMatch   = briefText.match(/SUCCESS_CRITERION:\s*(.+?)(?:\n\nQUERY:|\n\n[A-Z]+:|$)/s);
          const criterion   = critMatch ? critMatch[1].trim() : '';
          const winnerEntry = valid.find(e => e.model === computedWinner);
          const winnerText  = winnerEntry ? String(winnerEntry.content) : '';
          if (criterion && winnerText) {
            const taskMatch = briefText.match(/^TASK:\s*(\S+)/m);
            const taskType  = taskMatch ? taskMatch[1].trim() : 'fix';
            const fileMatch = briefText.match(/^FILE:\s*(.+)/m);
            const fnMatch   = briefText.match(/^FUNCTION:\s*(.+)/m);
            const fileHint  = fileMatch ? fileMatch[1].trim().split('/').pop().replace('.js','') : '';
            const fnHint    = fnMatch   ? fnMatch[1].trim() : '';
            let pass = false;
            if (taskType === 'diagnose') {
              const hasFile = fileHint && winnerText.toLowerCase().includes(fileHint.toLowerCase());
              const hasFn   = fnHint   && winnerText.toLowerCase().includes(fnHint.toLowerCase());
              pass = !!(hasFile && hasFn);
            } else {
              const hasCode    = winnerText.includes('```') || /function\s+\w/.test(winnerText);
              const rcMatch    = briefText.match(/^ROOT_CAUSE:\s*([\s\S]+?)(?=\n\nRELEVANT_CODE:|$)/m);
              const rcText     = rcMatch ? rcMatch[1].slice(0,200).toLowerCase() : '';
              const keyIds     = (rcText.match(/\b[a-zA-Z_][a-zA-Z0-9_]{4,}\b/g) || []).slice(0,6);
              const matchCount = keyIds.filter(id => winnerText.toLowerCase().includes(id)).length;
              pass = hasCode && matchCount >= 2;
            }
            criterionResult = { criterion, pass, task: taskType };
            // Expose globally for retry loop
            window._lastCriterionResult = criterionResult;
            // Fail: write trajectory to .context for informed retry
            if (!pass && window.getRootHandle) {
              try {
                const root   = window.getRootHandle();
                const ctxDir = await root.getDirectoryHandle('_context');
                let existing = '';
                try { const fh2 = await ctxDir.getFileHandle('.context'); existing = await (await fh2.getFile()).text(); } catch { /* ok */ }
                const trace = '\n\n--- CRITERION FAIL ' + new Date().toISOString().slice(0,16) + ' ---\n'
                  + 'Task: ' + taskType + ' | Criterion: ' + criterion + '\n'
                  + 'Winner (' + computedWinner + '): ' + winnerText.slice(0,300).replace(/\n/g,' ') + '\n'
                  + 'Action: re-run Brief: Protocol with narrower QUERY\n';
                const fh = await ctxDir.getFileHandle('.context', { create: true });
                const wr = await fh.createWritable();
                await wr.write(existing + trace);
                await wr.close();
                window._protocolRetryContext = existing + trace;
              } catch { /* non-blocking */ }
            }
            // Auto-retry: if pipeline is in auto mode and retries remain, re-invoke
            if (!pass && window._autoProtocolState && window._autoProtocolState.remaining > 0) {
              window._autoProtocolState.remaining--;
              const retryNum = window._autoProtocolState.max - window._autoProtocolState.remaining;
              const chatPanel = document.getElementById('chatPanel');
              if (chatPanel) {
                const retryEl = document.createElement('div');
                retryEl.className = 'chat-entry';
                retryEl.style.cssText = 'border-left:3px solid #a06800;padding:4px 10px;font-size:12px;color:var(--text-dim);margin:4px 0;';
                retryEl.textContent = '\u21bb Criterion not met \u2014 retry ' + retryNum + '/' + window._autoProtocolState.max + '...';
                chatPanel.appendChild(retryEl);
                chatPanel.scrollTop = chatPanel.scrollHeight;
              }
              setTimeout(() => {
                if (window.handleBriefProtocol && window._autoProtocolState) {
                  window.handleBriefProtocol(
                    window._autoProtocolState.query,
                    window._autoProtocolState.output,
                    window._autoProtocolState.outputEl
                  );
                }
              }, 800);
            }
          }
        } catch { /* non-blocking */ }
      }
      if (criterionResult) eval_.criterionResult = criterionResult;

      _renderEvaluation(eval_, scores, failed, stepIdx, planTotal, hasNext, mcpWritten, taskMs, evalMs, totalMs, isGenerative, MAX_SCORE);

      if (window.appendToLog) {
        window.appendToLog(
          '[Brief AI -- Step ' + (stepIdx + 1) + '/' + planTotal + ']',
          [{ model: 'Brief AI', content: _buildLogText(eval_, scores, failed, stepIdx + 1, planTotal) }],
          'single', ''
        ).catch(() => {});
      }

    } catch (err) {
      console.warn('[brief] autoEvaluate failed:', err.message);
      _renderError('Brief AI evaluation failed: ' + err.message);
    }
  };

  // ── Log text (saved to chat.md, read by Claude Desktop via MCP) ───────────

  function _buildLogText(eval_, scores, failed, step, total) {
    let t = 'STEP ' + step + '/' + total + '\n';
    t += 'WINNER: ' + (eval_.winner || 'unknown') + ' (' + (eval_.confidence || '') + ')\n';
    if (eval_.criterionResult) {
      const cr = eval_.criterionResult;
      t += 'CRITERION ' + (cr.pass ? 'PASS' : 'FAIL') + ': ' + cr.criterion + '\n';
      if (!cr.pass) t += 'ACTION: re-run Brief: Protocol with narrower query (trajectory written to .context)\n';
    }
    if (eval_.timing) t += 'TIMING: ' + eval_.timing + '\n';
    // Evaluator vote breakdown
    if (eval_.winnerVotes) {
      const votes = Object.entries(eval_.winnerVotes).sort((a,b)=>b[1]-a[1]);
      t += 'VOTES (' + (eval_.parsedEvals||1) + '/' + (eval_.evalModels||1) + ' evaluators): '
        + votes.map(([m,n]) => m + '\u00d7' + n).join(', ') + '\n';
    }
    t += 'REASON: ' + (eval_.winner_reason || eval_.reason || '') + '\n';
    t += 'SYNTHESIS: ' + (eval_.synthesis || '') + '\n\n';
    t += 'RANKINGS (A=accuracy H=hallucination R=relevance S=specificity C=completeness'
      + (eval_.isGenerative ? ' X=codeCorrectness' : '')
      + ', averaged across evaluators, max ' + (eval_.maxScore || 25) + '):\n';
    scores.forEach((s, i) => {
      const selfNote = s.self_score !== null && s.self_score !== undefined
        ? ' [self:' + s.self_score + ']' : '';
      const vetoNote = (s.hallucination || 0) <= 2 ? ' [VETO: H≤2]' : '';
      t += (i + 1) + '. ' + s.model
        + ' [total:' + s.total + '/' + (eval_.maxScore || 25)
        + '  A:' + (s.accuracy||0) + ' H:' + (s.hallucination||0)
        + ' R:' + (s.relevance||0) + ' S:' + (s.specificity||0) + ' C:' + (s.completeness||0)
        + (s.codeCorrectness !== null && s.codeCorrectness !== undefined ? ' X:' + s.codeCorrectness : '')
        + ' n=' + (s.evaluator_count||0) + selfNote + vetoNote + ']';
      if (s.hallucinated_items && s.hallucinated_items.length) {
        t += '  HALLUCINATED: ' + s.hallucinated_items.join(', ');
      }
      t += '\n   ' + (s.comment || '') + '\n';
    });
    if (failed.length) {
      t += '\nFAILED:\n';
      failed.forEach(f => { t += '- ' + f.model + ': ' + String(f.content).slice(0, 80) + '\n'; });
    }
    return t;
  }

  // ── Chat panel rendering ──────────────────────────────────────────────────

  function _renderEvaluation(eval_, scores, failed, stepIdx, total, hasNext, mcpWritten, taskMs, evalMs, totalMs, isGenerative, MAX_SCORE) {
    const chatPanel = document.getElementById('chatPanel');
    if (!chatPanel) return;
    const step = stepIdx + 1;
    function fmtMs(ms) { return ms < 1000 ? ms + 'ms' : (ms/1000).toFixed(1) + 's'; }
    const timingStr = [taskMs && 'Task: ' + fmtMs(taskMs), evalMs && 'Eval: ' + fmtMs(evalMs), totalMs && 'Total: ' + fmtMs(totalMs)].filter(Boolean).join(' | ');

    // Ranked scores with criteria badges
    let rankHtml = '<div style="margin-top:8px;">';
    scores.forEach((s, i) => {
      const isWinner  = s.model === eval_.winner;
      const nameCol   = isWinner ? '#4a7c4e' : 'var(--text)';
      const halluWarn = (s.hallucination || 5) <= 2;

      // Criteria badge colours
      function badgeStyle(criterion, val) {
        if (criterion === 'H' && val <= 2) return 'background:#8d3a3a;color:#fff;';
        if (criterion === 'H' && val === 3) return 'background:#a06800;color:#fff;';
        return 'background:var(--border);color:var(--text);';
      }

      const criteria = [
        { k: 'A', v: s.accuracy     || 0, title: 'Accuracy' },
        { k: 'H', v: s.hallucination|| 0, title: 'Hallucination (5=clean)' },
        { k: 'R', v: s.relevance    || 0, title: 'Relevance' },
        { k: 'S', v: s.specificity  || 0, title: 'Specificity' },
        { k: 'C', v: s.completeness || 0, title: 'Completeness' },
        ...(isGenerative && s.codeCorrectness !== null
          ? [{ k: 'X', v: s.codeCorrectness || 0, title: 'Code Correctness' }]
          : []),
      ];

      rankHtml += '<div style="padding:4px 0 2px;border-bottom:1px solid var(--border);">';

      // Model name row + criteria badges + total
      rankHtml += '<div style="display:flex;align-items:center;gap:5px;font-size:12px;">';
      rankHtml += '<span style="min-width:14px;color:var(--text-dim);">' + (i + 1) + '.</span>';
      rankHtml += '<span style="flex:1;font-weight:' + (isWinner ? 'bold' : 'normal') + ';color:' + nameCol + ';">' + esc(s.model) + '</span>';
      criteria.forEach(c => {
        rankHtml += '<span title="' + c.title + '" style="' + badgeStyle(c.k, c.v) + 'padding:1px 4px;border-radius:3px;font-size:10px;font-weight:bold;">' + c.k + ':' + c.v + '</span>';
      });
      // Red veto ring on total if H≤2
      const vetoStyle = (s.hallucination || 0) <= 2 ? 'color:#8d3a3a;font-weight:bold;' : 'color:var(--text-dim);';
      rankHtml += '<span style="font-size:11px;min-width:48px;text-align:right;' + vetoStyle + '">' + s.total + '/' + MAX_SCORE
        + ((s.hallucination || 0) <= 2 ? ' ⛔' : '') + '</span>';
      // Self-score badge (did this model inflate its own score?)
      if (s.self_score !== null && s.self_score !== undefined) {
        const selfDiff = s.self_score - s.accuracy;
        const selfCol  = selfDiff > 1 ? '#8d3a3a' : selfDiff > 0 ? '#a06800' : 'var(--text-dim)';
        rankHtml += '<span title="Self-scored accuracy: ' + s.self_score + '" style="color:' + selfCol + ';font-size:10px;padding:1px 3px;">self:' + s.self_score + '</span>';
      }
      rankHtml += '</div>';

      // Hallucinated items + runtime/language warnings
      if (s.hallucinated_items && s.hallucinated_items.length) {
        rankHtml += '<div style="font-size:10px;color:#c0392b;padding:1px 20px;">'
          + '\u26a0 Invented/unverified: ' + s.hallucinated_items.map(esc).join(', ') + '</div>';
      }
      // Show pre-screen tags from Coder if available (stored per-model in prescreened)
      // These are already embedded in the response text Brief AI saw, but shown here for visibility

      // Code quote from source (confirms accuracy score was verified against real code)
      if (s.best_code_quote) {
        rankHtml += '<div style="font-size:10px;color:#4a7c4e;padding:1px 20px;font-style:italic;">'  
          + '“' + esc(s.best_code_quote.slice(0, 100)) + (s.best_code_quote.length > 100 ? '...' : '') + '”</div>';
      }
      // Comment
      if (s.comment) {
        rankHtml += '<div style="font-size:11px;color:var(--text-dim);padding:1px 20px;">' + esc(s.comment) + '</div>';
      }

      rankHtml += '</div>';
    });
    rankHtml += '</div>';

    // Failed models
    let failHtml = '';
    if (failed.length) {
      failHtml = '<div style="margin-top:4px;font-size:11px;color:var(--red);">Failed: '
        + failed.map(f => esc(f.model)).join(', ') + '</div>';
    }

    // Next step message
    const nextHtml = hasNext
      ? '<div style="margin-top:6px;font-size:12px;color:var(--text-dim);">\u25B6 '
        + (mcpWritten ? 'Next query written to mcp.json. <strong>Deploy + refresh to continue.</strong>'
                      : 'Claude Desktop will write next query to mcp.json.')
        + '</div>'
      : '<div style="margin-top:6px;font-size:12px;color:#4a7c4e;font-weight:bold;">\u2713 Brief complete (' + total + ' steps).</div>';

    const el = document.createElement('div');
    el.className = 'chat-entry';
    el.style.cssText = 'border-left:3px solid #4a7c4e;padding:6px 0 4px 10px;margin:8px 0 4px;';
    el.innerHTML =
      '<div style="font-size:11px;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:4px;">Brief AI \u2014 Step ' + step + '/' + total
      + (eval_.parsedEvals ? ' \u00b7 ' + eval_.parsedEvals + '/' + eval_.evalModels + ' evaluators' : '')
      + (eval_.phase2 ? ' \u00b7 Phase 2' : '')
      + (timingStr ? ' \u00b7 ' + timingStr : '') + '</div>'
      + '<div style="font-size:13px;"><span style="color:#4a7c4e;font-weight:bold;">' + esc(eval_.winner) + '</span>'
      + '<span style="color:var(--text-dim);font-size:11px;margin-left:6px;">(' + esc(eval_.confidence || '') + ')</span>'
      + ' \u2014 ' + esc(eval_.winner_reason || eval_.reason || '') + '</div>'
      + '<div style="font-size:12px;color:var(--text-dim);margin-top:3px;font-style:italic;">' + esc(eval_.synthesis || '') + '</div>'
      + rankHtml + failHtml
      + (eval_.criterionResult
          ? '<div style="margin-top:6px;padding:4px 8px;border-radius:3px;font-size:12px;'
            + (eval_.criterionResult.pass
                ? 'background:#1e3a1e;color:#7ec87e;'
                : 'background:#3a1e1e;color:#c87e7e;')
            + '">'
            + (eval_.criterionResult.pass ? '&#10003; CRITERION PASS' : '&#x26A0; CRITERION FAIL')
            + ' \u00b7 ' + esc(eval_.criterionResult.criterion)
            + (!eval_.criterionResult.pass ? '<br><span style="font-size:11px;opacity:0.8;">Trajectory written to .context \u2014 re-run Brief: Protocol with narrower query</span>' : '')
            + '</div>'
          : '')
      + nextHtml;

    chatPanel.appendChild(el);
    chatPanel.scrollTop = chatPanel.scrollHeight;
  }

  function _renderError(msg) {
    const chatPanel = document.getElementById('chatPanel');
    if (!chatPanel) return;
    const el = document.createElement('div');
    el.className = 'chat-entry';
    el.style.cssText = 'border-left:3px solid var(--red);padding-left:10px;margin:8px 0 4px;font-size:12px;color:var(--red);';
    el.textContent = msg;
    chatPanel.appendChild(el);
  }

  // ── Brief: Start ──────────────────────────────────────────────────────────

  async function handleBriefStart(args, output, outputEl) {
    if (!args.trim()) { output('Usage: Brief: Start [problem description]'); return; }

    const problem = args.trim();
    output('Brief AI planning...');

    const planPrompt =
      'Create a 4-step debugging/fix plan. Reply ONLY with valid JSON, no markdown.\n\n'
      + 'Problem: "' + problem + '"\n\n'
      + 'Steps: 1) explain and locate relevant files/functions, 2) find exact buggy lines/variables, '
      + '3) write complete corrected code, 4) review for correctness and side effects.\n'
      + 'Each step is a plain English question. NO command prefixes.\n\n'
      + 'JSON: {"steps":["q1","q2","q3","q4"],"summary":"one sentence","category":"Debug"}';

    try {
      const res  = await fetch('/ask', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: planPrompt, model: 'gemini', userId: window.getAuth('mobius_user_id') })
      });
      const data = await res.json();
      const raw  = (data.reply || '').replace(/```json[\s\S]*?```/g, m => m.slice(7, -3)).replace(/```/g, '').trim();
      const p    = JSON.parse(raw);

      if (!Array.isArray(p.steps) || !p.steps.length) throw new Error('No steps returned');

      const plan = {
        problem, summary: p.summary || problem, category: p.category || 'Debug',
        steps: p.steps, currentStep: 1,
        project: window._indexedProject || '',
        startedAt: new Date().toISOString(), done: false
      };

      await writePlan(plan);
      const mcpOk = await writeMcpTask(plan.steps[0], plan.project);
      window.briefModeActive = true;

      const stepsHtml = plan.steps.map((s, i) =>
        '<div style="display:flex;gap:6px;padding:4px 0;border-bottom:1px solid var(--border);font-size:12px;">'
        + '<span style="color:var(--text-dim);min-width:16px;">' + (i + 1) + '.</span>'
        + '<span style="flex:1;">' + esc(s) + '</span></div>'
      ).join('');

      outputEl.classList.add('html-content');
      outputEl.innerHTML =
        '<div style="font-size:14px;font-weight:bold;margin-bottom:8px;">Brief: ' + esc(plan.summary) + '</div>'
        + stepsHtml
        + '<div style="margin-top:8px;font-size:12px;color:' + (mcpOk ? '#4a7c4e' : 'var(--text-dim)') + ';">'
        + (mcpOk ? '\u2713 Step 1 written to mcp.json. Deploy + refresh to run.'
                 : '\u2713 Plan saved. Claude Desktop will write step 1 to mcp.json.')
        + '</div>';

      document.getElementById('input').value = '';
    } catch (err) {
      output('Planning failed: ' + err.message + '\nTry again.');
    }
  }

  // ── Brief: Status ─────────────────────────────────────────────────────────

  async function handleBriefStatus(args, output, outputEl) {
    const plan = await readPlan();
    if (!plan) { output('No active brief. Run: Brief: Start [problem]'); return; }

    const stepsHtml = plan.steps.map((s, i) => {
      const done    = i < (plan.currentStep - 1);
      const current = i === (plan.currentStep - 1) && !plan.done;
      const col = done ? '#4a7c4e' : current ? '#a06800' : 'var(--text-dim)';
      const dot = done ? '\u2713' : current ? '\u25B6' : '\u25CB';
      return '<div style="display:flex;gap:6px;padding:3px 0;border-bottom:1px solid var(--border);font-size:12px;">'
        + '<span style="color:' + col + ';width:14px;">' + dot + '</span>'
        + '<span style="flex:1;color:' + col + ';">' + esc(s) + '</span></div>';
    }).join('');

    outputEl.classList.add('html-content');
    outputEl.innerHTML =
      '<div style="font-size:14px;font-weight:bold;margin-bottom:6px;">Brief: ' + esc(plan.summary) + '</div>'
      + stepsHtml
      + (plan.lastResult ? '<div style="margin-top:6px;font-size:12px;color:var(--text-dim);">Last winner: <strong>'
        + esc(plan.lastResult.winner) + '</strong>'
        + (plan.lastResult.synthesis ? ' -- <em>' + esc(plan.lastResult.synthesis) + '</em>' : '')
        + '</div>' : '')
      + '<div style="font-size:12px;color:var(--text-dim);margin-top:6px;">'
      + (plan.done ? '\u2713 Complete' : 'Step ' + plan.currentStep + '/' + plan.steps.length)
      + (window.briefModeActive ? ' \u00b7 auto-eval ON' : ' \u00b7 auto-eval OFF')
      + '</div>';

    document.getElementById('input').value = '';
  }

  // ── Brief: Maintain ───────────────────────────────────────────────────────
  // Reads current session chat log -> Gemini Lite extracts notes -> writes .context
  // in open project. Keeps last 5 session entries, last 5 issues, last 10 decisions.

  async function handleBriefMaintain(args, output) {
    const coderRoot = window.coderRootHandle;
    const projRoot  = window.getRootHandle && window.getRootHandle();
    if (!projRoot) { output('No project open. Run Project: Open first.'); return; }

    // 1. Read session chat log
    let chatText = '';
    if (coderRoot && window.coderSessionStamp) {
      try {
        const chatsDir = await coderRoot.getDirectoryHandle('chats');
        const logFh    = await chatsDir.getFileHandle('chat-' + window.coderSessionStamp + '.md');
        chatText       = await (await logFh.getFile()).text();
      } catch { /* fallback */ }
    }
    if (!chatText) {
      try {
        const ctxDir = await projRoot.getDirectoryHandle('_context');
        const logFh  = await ctxDir.getFileHandle('chat.md');
        chatText     = (await (await logFh.getFile()).text()).slice(-6000);
      } catch { chatText = ''; }
    }
    if (!chatText.trim()) { output('No session log found. Run Project: Home and complete a session first.'); return; }

    output('Brief: Maintain -- extracting session notes...');

    // 2. Read existing .context (if any)
    let existing = '';
    try {
      const ctxDir = await projRoot.getDirectoryHandle('_context');
      const cfh    = await ctxDir.getFileHandle('.context');
      existing     = await (await cfh.getFile()).text();
    } catch { /* first run */ }

    // 3. Gemini Lite extracts session notes
    const project = projRoot.name;
    const now     = new Date().toISOString().slice(0, 10);
    const prompt  =
      'You are reading a mobius session log for project: ' + project + '.\n'
      + 'Extract facts useful for future sessions. Reply ONLY with valid JSON, no markdown.\n\n'
      + 'SESSION LOG:\n' + chatText.slice(-4000) + '\n\n'
      + 'JSON: {"summary":"one sentence","winner":"best model or null","winner_score":"e.g. 21/25 or null",'
      + '"issues":["active bug or task, max 3"],"decisions":["decision made, max 3"],'
      + '"key_finding":"most important thing learned or null","files_touched":["filename"]}';

    let extracted = null;
    try {
      const res  = await fetch('/ask', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: prompt, model: 'gemini-lite', userId: window.getAuth('mobius_user_id') })
      });
      const data = await res.json();
      const raw  = (data.reply || '').replace(/```json[\s\S]*?```/g, m => m.slice(7,-3)).replace(/```/g,'').trim();
      extracted  = JSON.parse(raw);
    } catch (err) { output('Extraction failed: ' + err.message); return; }

    // 4. Build new session entry
    const entry = [
      '### ' + now,
      'Summary: '     + (extracted.summary      || '(none)'),
      extracted.winner       ? 'Winner: ' + extracted.winner + (extracted.winner_score ? ' (' + extracted.winner_score + ')' : '') : null,
      extracted.key_finding  ? 'Key finding: ' + extracted.key_finding : null,
      extracted.files_touched && extracted.files_touched.length ? 'Files: ' + extracted.files_touched.join(', ') : null,
    ].filter(Boolean).join('\n');

    // 5. Parse and merge with existing sections
    const HEADER        = '# ' + project + ' -- Session Context\n_Auto-maintained by Brief AI. Last updated: ' + now + '_\n';
    const ISSUES_HDR    = '## Active issues';
    const DECISIONS_HDR = '## Recent decisions';
    const NOTES_HDR     = '## Session notes';

    function extractSection(text, hdr) {
      const start = text.indexOf('\n' + hdr + '\n');
      if (start === -1) return '';
      const afterHdr = text.slice(start + hdr.length + 2);
      const end = afterHdr.search(/\n## /);
      return end === -1 ? afterHdr.trim() : afterHdr.slice(0, end).trim();
    }

    const existingIssues    = extractSection(existing, ISSUES_HDR).split('\n').filter(l => l.startsWith('-'));
    const existingDecisions = extractSection(existing, DECISIONS_HDR).split('\n').filter(l => l.startsWith('-'));
    const existingNotes     = extractSection(existing, NOTES_HDR);

    const newIssues    = [...(extracted.issues    || []).map(i => '- ' + i),    ...existingIssues].slice(0, 5);
    const newDecisions = [...(extracted.decisions || []).map(d => '- ' + now + ' ' + d), ...existingDecisions].slice(0, 10);
    const noteBlocks   = existingNotes.split(/(?=### )/).filter(Boolean);
    const newNotes     = [entry, ...noteBlocks].slice(0, 5).join('\n\n');

    const newContext   =
      HEADER + '\n'
      + ISSUES_HDR    + '\n' + (newIssues.length    ? newIssues.join('\n')    : '(none)') + '\n\n'
      + DECISIONS_HDR + '\n' + (newDecisions.length ? newDecisions.join('\n') : '(none)') + '\n\n'
      + NOTES_HDR     + '\n' + newNotes + '\n';

    // 6. Write .context to open project
    try {
      const ctxDir = await projRoot.getDirectoryHandle('_context', { create: true });
      const fh     = await ctxDir.getFileHandle('.context', { create: true });
      const w      = await fh.createWritable();
      await w.write(newContext);
      await w.close();
      if (window._projectContext) window._projectContext.context = newContext;
    } catch (err) { output('Write failed: ' + err.message); return; }

    output('Brief: Maintain done. Issues: ' + newIssues.length
      + ' | Decisions: ' + newDecisions.length + ' | ' + now
      + '\n.context updated in ' + project + '/_context/');
  }

  // ── Self-register ──────────────────────────────────────────────────────────

  function register() {
    if (!window.COMMANDS) { setTimeout(register, 50); return; }
    window.COMMANDS['brief: start']  = { handler: handleBriefStart,  family: 'brief', desc: 'Create 4-step plan and start auto-evaluation loop' };
    window.COMMANDS['brief: status'] = { handler: handleBriefStatus, family: 'brief', desc: 'Show current brief plan and progress' };
    window.COMMANDS['brief: stop']     = {
      handler: async (_, output) => { window.briefModeActive = false; output('Brief AI paused.'); document.getElementById('input').value = ''; },
      family: 'brief', desc: 'Pause auto-evaluation'
    };
    window.COMMANDS['brief: maintain'] = { handler: handleBriefMaintain, family: 'brief', desc: 'Extract session notes and update .context in open project' };
  }
  register();

})();
