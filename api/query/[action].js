// ── api/query/[action].js ─────────────────────────────────────────────────────
// POST /ask   → action = 'ask'
// POST /parse → action = 'parse'

const { askGeminiLite, askGemini, askMistral, askGitHub, askOllama, askWithFallback, askWebSearch, detectsCutoff, MODEL_FULL_NAMES } = require('../_ai.js');
const { saveConversation, supabase } = require('../_supabase.js');
const { getDriveFiles, getTasks, getCalendarEvents, getEmails, findDriveFile, readDriveFileContent } = require('../../google_api.js');

// ── Mobius pre-processor: load mobius.json from Drive ─────────────────────────
// Returns a formatted awareness string, or null if unavailable.
async function loadMobiusAwareness(userId) {
  if (!userId) return null;
  try {
    const found = await findDriveFile(userId, 'mobius.json');
    if (!found.files || found.files.length === 0) return null;
    const fileId  = found.files[0].id;
    const content = await readDriveFileContent(userId, fileId, 'text/plain');
    if (!content) return null;
    const data = JSON.parse(content);
    const lines = ['[Mobius Awareness]'];

    // Project state — always first so AI knows current context
    const ps = data.project_state;
    if (ps) {
      if (ps.current_project) lines.push('Current project: ' + ps.current_project);
      if (ps.current_focus)   lines.push('Current focus: '   + ps.current_focus);
      if (ps.next_steps?.length) lines.push('Next steps: ' + ps.next_steps.slice(0, 3).join(' | '));
    }

    // Preferences
    if (data.preferences?.length) {
      lines.push('');
      lines.push('Preferences:');
      data.preferences.forEach(p => lines.push('  - ' + p));
    }

    // Rules
    if (data.rules?.length) {
      lines.push('');
      lines.push('Rules:');
      data.rules.forEach(r => lines.push('  - ' + r));
    }

    // Do not
    if (data.do_not?.length) {
      lines.push('');
      lines.push('Do not:');
      data.do_not.forEach(d => lines.push('  - ' + d));
    }

    // Corrections
    if (data.corrections?.length) {
      lines.push('');
      lines.push('Known corrections (do not repeat these mistakes):');
      data.corrections.forEach(c => lines.push('  - ' + c));
    }

    return lines.join('\n');
  } catch (err) {
    console.warn('[Mobius] Could not load mobius.json:', err.message);
    return null;
  }
}

// ── Mobius post-processor: nAI response checks ────────────────────────────────
// Returns array of flag strings. Empty = clean response.
function postProcessReply(reply, instructions) {
  const flags = [];
  if (!reply) return flags;
  const lower = reply.toLowerCase();

  // Error / apology signals
  const errorPhrases = ['i cannot', "i can't", 'i am unable', "i'm unable", 'i don\'t have access',
    'i apologise', 'i apologize', 'i\'m sorry', 'i am sorry', 'i made an error',
    'i made a mistake', 'i was wrong', 'that was incorrect'];
  for (const phrase of errorPhrases) {
    if (lower.includes(phrase)) { flags.push('Response contains apology or error signal: "' + phrase + '"'); break; }
  }

  // Uncertainty signals
  const uncertainPhrases = ['i\'m not sure', 'i am not sure', 'i\'m not certain', 'i cannot be certain',
    'as of my knowledge cutoff', 'my training data', 'i don\'t know', "i do not know"];
  for (const phrase of uncertainPhrases) {
    if (lower.includes(phrase)) { flags.push('Response contains uncertainty signal: "' + phrase + '"'); break; }
  }

  // Knowledge cutoff — already auto-escalates, but flag it too
  if (lower.includes('knowledge cutoff') || lower.includes('training data')) {
    flags.push('Knowledge cutoff detected — consider Ask: web');
  }

  // Truncation signals (code/long mode)
  if (instructions === 'Code' || instructions === 'Long') {
    const truncPhrases = ['...', '// ...', '/* ... */', '[rest of', '[continued', 'and so on', 'etc.'];
    for (const phrase of truncPhrases) {
      if (reply.includes(phrase)) { flags.push('Possible truncation detected: "' + phrase + '"'); break; }
    }
    if (reply.length < 200) flags.push('Response very short for ' + instructions + ' mode (' + reply.length + ' chars) — possibly incomplete');
  }

  // Over-verbose in Brief mode
  if (instructions === 'Brief' && reply.length > 3000) {
    flags.push('Response very long for Brief mode (' + reply.length + ' chars) — consider elaborating intentionally');
  }

  // Stalling — repeats the question back verbatim (first 60 chars)
  // (skip for very short queries)
  return flags;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action } = req.query;

  // ── /parse ────────────────────────────────────────────────────────────────
  if (action === 'parse') {
    try {
      const { text, model, history, context, forceInstructionMode } = req.body || {};
      if (!text) return res.status(400).json({ error: 'Text is required' });

      // Read userId from cookie (same pattern as /ask)
      const cookieHeader  = req.headers.cookie || '';
      const cookieUserId  = cookieHeader.split(';').map(c => c.trim())
        .find(c => c.startsWith('mobius_user_id='))?.split('=')[1] || null;
      const parseUserId   = cookieUserId || req.body?.userId || null;

      const elaborate  = /^Elaborate[:\s]/i.test(text) || /\belaborate\b/i.test(text);
      const cleanText  = text.replace(/^Elaborate[:\s]+/i, '').trim() || text;
      const instructionMode = forceInstructionMode || (elaborate ? 'Long' : 'Brief');

      const systemPrompt =
        instructionMode === 'Long'
          ? 'Use British English spelling and conventions. You are Mobius, a helpful AI assistant. Provide a thorough and detailed answer.'
          : instructionMode === 'Code'
            ? 'Use British English spelling and conventions. You are Mobius, a helpful AI coding assistant. Provide complete, working code with brief explanations. Do not truncate code. Use markdown code blocks.'
            : 'Use British English spelling and conventions. You are Mobius, a helpful AI assistant. Keep all responses concise and under 500 words. Be direct and to the point. If the user wants more detail, they will ask you to elaborate.';

      const SYSTEM_PREFIXES = ['[System]', 'You are Mobius', '[User Environment]', '[Mobius Awareness]'];
      const history_clean = (history || []).filter(
        m => !SYSTEM_PREFIXES.some(p => m.content?.startsWith(p))
      );

      const webAliases = { 'websearch': 'web', 'web': 'web', 'web2': 'web2', 'web3': 'web3' };
      const resolvedModel = webAliases[model?.toLowerCase()] || model || 'groq';

      // ── Pre-processor: load mobius.json awareness ─────────────────────────
      // Fetched here at parse time so it's always fresh.
      // Injected as a virtual file attachment — same pattern as environment.txt.
      let mobiusFile = null;
      const awarenessText = await loadMobiusAwareness(parseUserId);
      if (awarenessText) {
        const encoded = Buffer.from(awarenessText, 'utf8').toString('base64');
        mobiusFile = {
          name:     'mobius_context.txt',
          mimeType: 'text/plain',
          base64:   encoded,
          size:     awarenessText.length
        };
        console.log('[Mobius] Awareness injected (' + awarenessText.length + ' chars)');
      } else {
        console.log('[Mobius] No awareness context available — continuing without.');
      }

      const mobius_query = {
        ASK: resolvedModel,
        INSTRUCTIONS: instructionMode,
        HISTORY: history_clean,
        QUERY: cleanText,
        FILES: mobiusFile ? [mobiusFile] : [],
        CONTEXT: null
      };

      return res.status(200).json({ mobius_query });
    } catch (err) {
      console.error('Parse error:', err);
      return res.status(500).json({ error: 'Parse failed' });
    }
  }

  // ── /ask ──────────────────────────────────────────────────────────────────
  if (action === 'ask') {
    const cookieHeader = req.headers.cookie || '';
    const cookieUserId = cookieHeader.split(';').map(c => c.trim())
      .find(c => c.startsWith('mobius_user_id='))?.split('=')[1] || null;
    const { mobius_query, userId: bodyUserId, topic, session_id } = req.body;
    const userId = cookieUserId || bodyUserId || null;
    const { ASK, INSTRUCTIONS, HISTORY, QUERY, FILES, CONTEXT } = mobius_query;

    try {
      const systemPrompts = {
        'Brief': 'You are Mobius, a helpful AI assistant. Keep all responses concise and under 500 words. Be direct and to the point. If the user wants more detail, they will ask you to elaborate.',
        'Long':  'You are Mobius, a helpful AI assistant. Provide a thorough and detailed answer.',
        'Code':  'You are Mobius, a helpful AI coding assistant. Provide complete, working code with brief explanations. Do not truncate code. Use markdown code blocks.'
      };
      const systemPrompt = systemPrompts[INSTRUCTIONS] || systemPrompts['Brief'];
      const instructionMessages = [{ role: 'user', content: '[System] ' + systemPrompt }];

      const messages = [
        ...instructionMessages,
        ...(HISTORY || []),
        { role: 'user', content: QUERY }
      ];
      if (CONTEXT && CONTEXT !== 'None') messages.unshift({ role: 'system', content: CONTEXT });

      let reply, modelUsed = ASK, tokensIn = null, tokensOut = null, failedModels = [];

      const imageParts = (FILES || [])
        .filter(f => f.mimeType?.startsWith('image/'))
        .map(f => ({ inline_data: { mime_type: f.mimeType, data: f.base64 } }));

      const hasImages        = imageParts.length > 0;
      const hasNonImageFiles = (FILES || []).some(f => f.mimeType && !f.mimeType.startsWith('image/'));

      // ── Task complexity scoring — most tokens first, specialists only when needed ──
      // Scores the query to pick the cheapest capable model.
      // User can always override with explicit Ask: [model].
      let fileModelFallbacks = [];
      const userExplicitModel = ['gemini','gemini-flash','gemini-lite','groq','mistral','codestral','github','web','web2','web3','qwen','deepseek','webllm'].includes(ASK?.toLowerCase());

      function scoreComplexity(query, files, history, instructions) {
        let score = 0;
        // Files
        if ((files || []).some(f => f.mimeType?.startsWith('image/')))  score += 5; // vision required
        if ((files || []).some(f => f.mimeType?.startsWith('audio/')))  score += 5; // multimodal
        if ((files || []).some(f => (f.size || 0) > 100000))            score += 3; // large file
        if ((files || []).length > 0)                                   score += 1; // any file
        // Query length
        if ((query || '').length > 1500)                                score += 2;
        else if ((query || '').length > 500)                            score += 1;
        // Keywords
        if (/analys|reason|architect|design|review|compar|evaluat/i.test(query)) score += 1;
        // History depth
        if ((history || []).length > 20)                                score += 2;
        else if ((history || []).length > 10)                           score += 1;
        // Instruction mode
        if (instructions === 'Long' || instructions === 'Code')         score += 1;
        return score;
      }

      if (!userExplicitModel) {
        const files     = FILES || [];
        const mimeTypes = files.map(f => f.mimeType || '').join(',').toLowerCase();
        const fileNames = files.map(f => f.name    || '').join(',').toLowerCase();
        const codeExts  = /\.(js|ts|jsx|tsx|py|java|cs|cpp|c|h|go|rs|rb|php|swift|kt|sql|sh|bash|zsh)$/;
        const docExts   = /\.(pdf|txt|md|docx|doc|rtf|odt)$/;
        const dataExts  = /\.(csv|json|xml|yaml|yml|toml|ini)$/;

        const score = scoreComplexity(QUERY, files, HISTORY, INSTRUCTIONS);

        if (hasImages || /^(audio|video)\//.test(mimeTypes)) {
          // Vision — Flash is the only free option, protect it
          modelUsed = 'gemini';
          fileModelFallbacks = ['github'];
          console.log('[Mobius] Routing: vision → Flash (score ' + score + ')');

        } else if (codeExts.test(fileNames) && /generat|creat|write|implement|build/i.test(QUERY)) {
          // Code generation specifically — specialist Codestral first
          modelUsed = 'codestral';
          fileModelFallbacks = ['groq', 'gemini-lite', 'gemini', 'github'];
          console.log('[Mobius] Routing: code generation → Codestral (score ' + score + ')');

        } else if (files.length > 0) {
          // File attached (doc, code, data) — start with Groq if small, Flash-Lite if large
          if (score >= 4) {
            modelUsed = 'gemini-lite';
            fileModelFallbacks = ['groq', 'gemini', 'github'];
            console.log('[Mobius] Routing: large file → Flash-Lite (score ' + score + ')');
          } else {
            modelUsed = 'groq';
            fileModelFallbacks = ['gemini-lite', 'gemini', 'github'];
            console.log('[Mobius] Routing: file → Groq (score ' + score + ')');
          }

        } else if (score >= 5) {
          // Complex text query — Flash-Lite first, Flash as escalation
          modelUsed = 'gemini-lite';
          fileModelFallbacks = ['groq', 'gemini', 'github'];
          console.log('[Mobius] Routing: complex → Flash-Lite (score ' + score + ')');

        } else {
          // Default — Groq: most tokens, fastest, cheapest
          modelUsed = 'groq';
          fileModelFallbacks = ['gemini-lite', 'github'];
          console.log('[Mobius] Routing: default → Groq (score ' + score + ')');
        }
      }

      const appendFileTexts = () => {
        if (hasNonImageFiles) {
          const fileTexts = (FILES || [])
            .filter(f => !f.mimeType.startsWith('image/'))
            .map(f => `[File: ${f.name}]\n${Buffer.from(f.base64, 'base64').toString('utf8')}`)
            .join('\n\n');
          messages[messages.length - 1].content += '\n\n' + fileTexts;
        }
      };

      if (ASK === 'chat_history') {
        reply = '__CHAT_HISTORY__';
        modelUsed = 'system';

      } else if (ASK === 'google_drive') {
        reply = await getDriveFiles(userId, QUERY);

      } else if (ASK === 'google_tasks') {
        reply = await getTasks(userId);

      } else if (ASK === 'google_calendar') {
        reply = await getCalendarEvents(userId);

      } else if (ASK === 'google_gmail') {
        reply = await getEmails(userId);

      } else if (ASK === 'gemini-lite' || modelUsed === 'gemini-lite') {
        appendFileTexts();
        try {
          const r = await askGeminiLite(messages);
          reply = r.text; tokensIn = r.tokensIn; tokensOut = r.tokensOut;
          modelUsed = MODEL_FULL_NAMES['gemini-lite'];
        } catch (err) {
          failedModels.push({ model: MODEL_FULL_NAMES['gemini-lite'], reason: err.message });
          const chain = fileModelFallbacks.length ? fileModelFallbacks.filter(m => m !== 'gemini-lite') : ['groq', 'gemini', 'github'];
          const fb = await askWithFallback(messages, [], chain[0]);
          reply = fb.reply; modelUsed = fb.modelUsed + ' (fallback from Flash-Lite)';
          failedModels = failedModels.concat(fb.failedModels || []);
        }

      } else if (ASK === 'codestral' || modelUsed === 'codestral') {
        appendFileTexts();
        try {
          reply = await askMistral(messages);
          modelUsed = MODEL_FULL_NAMES.codestral;
        } catch (err) {
          failedModels.push({ model: MODEL_FULL_NAMES.codestral, reason: err.message });
          const chain = fileModelFallbacks.length ? fileModelFallbacks.filter(m => m !== 'codestral') : ['groq', 'gemini-lite', 'gemini'];
          const fb = await askWithFallback(messages, [], chain[0]);
          reply = fb.reply; modelUsed = fb.modelUsed + ' (fallback from Codestral)';
          failedModels = failedModels.concat(fb.failedModels || []);
        }

      } else if (['gemini','gemini-flash'].includes(ASK) || modelUsed === 'gemini' || hasImages) {
        try {
          const geminiResult = await askGemini(messages, imageParts);
          reply     = geminiResult.text;
          tokensIn  = geminiResult.tokensIn;
          tokensOut = geminiResult.tokensOut;
          modelUsed = MODEL_FULL_NAMES.gemini;
        } catch (err) {
          console.warn('[Mobius] Gemini failed:', err.message);
          failedModels.push({ model: MODEL_FULL_NAMES.gemini, reason: err.message });
          // Use file-type fallback chain if defined, otherwise default chain
          const fallbackChain = fileModelFallbacks.length ? fileModelFallbacks : ['mistral', 'github', 'groq'];
          let fell = false;
          for (const fb of fallbackChain) {
            try {
              appendFileTexts(); // ensure file content is appended for text-based fallbacks
              const fbResult = await askWithFallback(messages, [], fb);
              reply      = fbResult.reply;
              modelUsed  = fbResult.modelUsed + ' (fallback from Gemini)';
              failedModels = failedModels.concat(fbResult.failedModels || []);
              fell = true;
              break;
            } catch (fbErr) {
              failedModels.push({ model: fb, reason: fbErr.message });
            }
          }
          if (!fell) throw new Error('All models failed including fallbacks: ' + fallbackChain.join(', '));
        }

      } else if (ASK === 'mistral' || ASK === 'codestral' || modelUsed === 'mistral') {
        appendFileTexts(); // append file content before sending to Mistral
        try {
          reply = await askMistral(messages);
          modelUsed = MODEL_FULL_NAMES.mistral;
        } catch (err) {
          console.warn('[Mobius] Mistral failed, falling back:', err.message);
          failedModels.push({ model: MODEL_FULL_NAMES.mistral, reason: err.message });
          const fbResult = await askWithFallback(messages, [], 'github');
          reply = fbResult.reply;
          modelUsed = fbResult.modelUsed + ' (fallback from ' + MODEL_FULL_NAMES.mistral + ')';
          failedModels = failedModels.concat(fbResult.failedModels || []);
        }

      } else if (ASK === 'github') {
        appendFileTexts(); // append file content before sending to GitHub
        try {
          reply = await askGitHub(messages);
          modelUsed = MODEL_FULL_NAMES.github;
        } catch (err) {
          console.warn('[Mobius] GitHub failed, falling back:', err.message);
          failedModels.push({ model: MODEL_FULL_NAMES.github, reason: err.message });
          const fbResult = await askWithFallback(messages, [], 'groq');
          reply = fbResult.reply;
          modelUsed = fbResult.modelUsed + ' (fallback from ' + MODEL_FULL_NAMES.github + ')';
          failedModels = failedModels.concat(fbResult.failedModels || []);
        }

      } else if (ASK === 'websearch' || ASK === 'web' || ASK === 'web2' || ASK === 'web3') {
        appendFileTexts();
        const webDepth = ASK === 'web3' ? 3 : ASK === 'web2' ? 2 : 1;
        const webLabel = ASK === 'web3' ? 'Ask: web3' : ASK === 'web2' ? 'Ask: web2' : 'Ask: web';
        const statusLines = [];
        try {
          const { reply: wsReply, modelUsed: wsModel } = await askWebSearch(messages, webDepth);
          reply = (statusLines.length ? statusLines.join('\n') + '\n\n' : '') + wsReply;
          modelUsed = wsModel;
        } catch (err) {
          statusLines.push(`${webLabel}: ${err.message} → trying Gemini...`);
          console.warn('[Mobius] Websearch failed:', err.message);
          try {
            const geminiResult = await askGemini(messages);
            reply = statusLines.join('\n') + '\n\n' + geminiResult.text;
            modelUsed = MODEL_FULL_NAMES.gemini + ' (fallback from ' + webLabel + ')';
            tokensIn  = geminiResult.tokensIn;
            tokensOut = geminiResult.tokensOut;
          } catch (err2) {
            statusLines.push(`Gemini: ${err2.message} → no more fallbacks.`);
            reply = statusLines.join('\n');
            modelUsed = 'failed';
          }
        }

      } else {
        appendFileTexts();
        try {
          const fbResult = await askWithFallback(messages, [], ASK);
          reply = fbResult.reply;
          modelUsed = fbResult.modelUsed;
          failedModels = fbResult.failedModels || [];
          if (detectsCutoff(reply)) {
            const cutoffStatus = `${modelUsed}: knowledge cutoff detected (no live data) → trying Ask: web2...`;
            try {
              const { reply: wsReply, modelUsed: wsModel } = await askWebSearch(messages, 2);
              reply = cutoffStatus + '\n\n' + wsReply;
              modelUsed = wsModel;
            } catch (wsErr) {
              reply = cutoffStatus + `\nAsk: web2: ${wsErr.message} → showing original answer.\n\n` + fbResult.reply;
            }
          }
        } catch (err) {
          throw new Error('All models failed. Last error: ' + err.message);
        }
      }

      // ── Post-processor: nAI response checks ──────────────────────────────
      const postFlags = postProcessReply(reply, INSTRUCTIONS);
      if (postFlags.length > 0) {
        console.log('[Mobius] Post-processor flags:', postFlags);
      }

      res.json({ reply, modelUsed, tokensIn, tokensOut, postFlags, failedModels });
      if (userId && reply !== '__CHAT_HISTORY__') {
        saveConversation(userId, QUERY, reply, modelUsed, topic || 'general', session_id || null)
          .catch(e => console.error('Save error:', e.message));
      }
    } catch (err) {
      console.error('Error:', err.message);
      res.status(500).json({ error: err.message });
    }
    return;
  }

  res.status(400).json({ error: 'Unknown action: ' + action });
};
