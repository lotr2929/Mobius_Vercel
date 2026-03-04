const { askGemini, askMistral, askGitHub, askWithFallback, askWebSearch, MODEL_FULL_NAMES } = require('./_ai.js');
const { saveConversation } = require('./_supabase.js');
const { getDriveFiles, getTasks, getCalendarEvents, getEmails } = require('../google_api.js');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Read userId from cookie (preferred — works even when client forgets to send it)
  // Fall back to req.body.userId for backward compatibility
  const cookieHeader = req.headers.cookie || '';
  const cookieUserId = cookieHeader.split(';').map(c => c.trim())
    .find(c => c.startsWith('mobius_user_id='))?.split('=')[1] || null;
  const { mobius_query, userId: bodyUserId, topic, session_id } = req.body;
  const userId = cookieUserId || bodyUserId || null;
  const { ASK, INSTRUCTIONS, HISTORY, QUERY, FILES, CONTEXT } = mobius_query;

  try {
    // Rebuild system instruction from INSTRUCTIONS mode label
    const systemPrompts = {
      'Brief': 'You are Mobius, a helpful AI assistant. Keep all responses concise and under 200 words. Be direct and to the point. If the user wants more detail, they will ask you to elaborate.',
      'Long':  'You are Mobius, a helpful AI assistant. Provide a thorough and detailed answer.',
      'Code':  'You are Mobius, a helpful AI coding assistant. Provide complete, working code with brief explanations. Do not truncate code. Use markdown code blocks.'
    };
    const systemPrompt = systemPrompts[INSTRUCTIONS] || systemPrompts['Brief'];
    const instructionMessages = [{ role: 'user', content: '[System] ' + systemPrompt }];

    // Assemble in order: system instruction, history, current query
    const messages = [
      ...instructionMessages,
      ...(HISTORY || []),
      { role: 'user', content: QUERY }
    ];
    if (CONTEXT && CONTEXT !== 'None') messages.unshift({ role: 'system', content: CONTEXT });

    let reply, modelUsed = ASK;

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
        reply = await askGemini(messages, imageParts);
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

    } else if (ASK === 'websearch') {
      appendFileTexts();
      try {
        const { reply: wsReply, modelUsed: wsModel } = await askWebSearch(messages);
        reply = wsReply;
        modelUsed = wsModel;
      } catch (err) {
        console.warn('[Mobius] Websearch failed, falling back:', err.message);
        const { reply: fbReply, modelUsed: fbModel } = await askWithFallback(messages, [], 'groq');
        reply = fbReply;
        modelUsed = fbModel + ' (fallback from websearch)';
      }

    } else {
      appendFileTexts();
      try {
        const { reply: fallbackReply, modelUsed: fallbackModel } = await askWithFallback(messages, [], ASK);
        reply = fallbackReply;
        modelUsed = fallbackModel;
      } catch (err) {
        throw new Error('All models failed. Last error: ' + err.message);
      }
    }

    // Send response first, then save asynchronously
    res.json({ reply, modelUsed });
    if (userId && reply !== '__CHAT_HISTORY__') {
      saveConversation(userId, QUERY, reply, modelUsed, topic || 'general', session_id || null).catch(e => console.error('Save error:', e.message));
    }
  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).json({ error: err.message });
  }
};
