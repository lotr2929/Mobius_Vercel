// ── api/query/[action].js ─────────────────────────────────────────────────────
// POST /ask   → action = 'ask'
// POST /parse → action = 'parse'

const { askGemini, askMistral, askGitHub, askOllama, askWithFallback, askWebSearch, detectsCutoff, MODEL_FULL_NAMES } = require('../_ai.js');
const { saveConversation, supabase } = require('../_supabase.js');
const { getDriveFiles, getTasks, getCalendarEvents, getEmails } = require('../../google_api.js');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action } = req.query;

  // ── /parse ────────────────────────────────────────────────────────────────
  if (action === 'parse') {
    try {
      const { text, model, history, context, forceInstructionMode } = req.body || {};
      if (!text) return res.status(400).json({ error: 'Text is required' });

      const elaborate  = /^Elaborate[:\s]/i.test(text) || /\belaborate\b/i.test(text);
      const cleanText  = text.replace(/^Elaborate[:\s]+/i, '').trim() || text;
      const instructionMode = forceInstructionMode || (elaborate ? 'Long' : 'Brief');

      const systemPrompt =
        instructionMode === 'Long'
          ? 'Use British English spelling and conventions. You are Mobius, a helpful AI assistant. Provide a thorough and detailed answer.'
          : instructionMode === 'Code'
            ? 'Use British English spelling and conventions. You are Mobius, a helpful AI coding assistant. Provide complete, working code with brief explanations. Do not truncate code. Use markdown code blocks.'
            : 'Use British English spelling and conventions. You are Mobius, a helpful AI assistant. Keep all responses concise and under 500 words. Be direct and to the point. If the user wants more detail, they will ask you to elaborate.';

      const SYSTEM_PREFIXES = ['[System]', 'You are Mobius', '[User Environment]'];
      const history_clean = (history || []).filter(
        m => !SYSTEM_PREFIXES.some(p => m.content?.startsWith(p))
      );

      const webAliases = { 'websearch': 'web', 'web': 'web', 'web2': 'web2', 'web3': 'web3' };
      const resolvedModel = webAliases[model?.toLowerCase()] || model || 'groq';

      const mobius_query = {
        ASK: resolvedModel,
        INSTRUCTIONS: instructionMode,
        HISTORY: history_clean,
        QUERY: cleanText,
        FILES: [],
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

      let reply, modelUsed = ASK, tokensIn = null, tokensOut = null;

      const imageParts = (FILES || [])
        .filter(f => f.mimeType?.startsWith('image/'))
        .map(f => ({ inline_data: { mime_type: f.mimeType, data: f.base64 } }));

      const hasImages = imageParts.length > 0;
      const hasNonImageFiles = (FILES || []).some(f => f.mimeType && !f.mimeType.startsWith('image/'));

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

      } else if (ASK === 'gemini' || hasImages) {
        try {
          const geminiResult = await askGemini(messages, imageParts);
          reply     = geminiResult.text;
          tokensIn  = geminiResult.tokensIn;
          tokensOut = geminiResult.tokensOut;
          modelUsed = MODEL_FULL_NAMES.gemini;
        } catch (err) {
          console.warn('[Mobius] Gemini failed, falling back:', err.message);
          const { reply: fbReply, modelUsed: fbModel } = await askWithFallback(messages, [], 'mistral');
          reply = fbReply;
          modelUsed = fbModel + ' (fallback from ' + MODEL_FULL_NAMES.gemini + ')';
        }

      } else if (ASK === 'mistral' || ASK === 'codestral') {
        try {
          reply = await askMistral(messages);
          modelUsed = MODEL_FULL_NAMES.mistral;
        } catch (err) {
          console.warn('[Mobius] Mistral failed, falling back:', err.message);
          const { reply: fbReply, modelUsed: fbModel } = await askWithFallback(messages, [], 'github');
          reply = fbReply;
          modelUsed = fbModel + ' (fallback from ' + MODEL_FULL_NAMES.mistral + ')';
        }

      } else if (ASK === 'github') {
        try {
          reply = await askGitHub(messages);
          modelUsed = MODEL_FULL_NAMES.github;
        } catch (err) {
          console.warn('[Mobius] GitHub failed, falling back:', err.message);
          const { reply: fbReply, modelUsed: fbModel } = await askWithFallback(messages, [], 'groq');
          reply = fbReply;
          modelUsed = fbModel + ' (fallback from ' + MODEL_FULL_NAMES.github + ')';
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
          const { reply: fallbackReply, modelUsed: fallbackModel } = await askWithFallback(messages, [], ASK);
          reply = fallbackReply;
          modelUsed = fallbackModel;
          if (detectsCutoff(reply)) {
            const cutoffStatus = `${modelUsed}: knowledge cutoff detected (no live data) → trying Ask: web2...`;
            try {
              const { reply: wsReply, modelUsed: wsModel } = await askWebSearch(messages, 2);
              reply = cutoffStatus + '\n\n' + wsReply;
              modelUsed = wsModel;
            } catch (wsErr) {
              reply = cutoffStatus + `\nAsk: web2: ${wsErr.message} → showing original answer.\n\n` + fallbackReply;
            }
          }
        } catch (err) {
          throw new Error('All models failed. Last error: ' + err.message);
        }
      }

      res.json({ reply, modelUsed, tokensIn, tokensOut });
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
