const { askGemini, askMistral, askWithFallback, askWebSearch } = require('./_ai.js');
const { saveConversation } = require('./_supabase.js');
const { getDriveFiles, getTasks, getCalendarEvents, getEmails } = require('../google_api.js');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { mobius_query, userId, topic } = req.body;
  const { ASK, INSTRUCTIONS, QUERY, FILES, CONTEXT } = mobius_query;

  try {
    const messages = [...INSTRUCTIONS, { role: 'user', content: QUERY }];
    if (CONTEXT) messages.unshift({ role: 'system', content: CONTEXT });

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
        modelUsed = 'gemini';
      } catch (err) {
        console.warn('[Mobius] Gemini failed, falling back to Mistral:', err.message);
        try {
          reply = await askMistral(messages);
          modelUsed = 'mistral (fallback from gemini)';
        } catch (err2) {
          console.warn('[Mobius] Mistral failed, falling back to Groq:', err2.message);
          const { reply: fbReply, modelUsed: fbModel } = await askWithFallback(messages, [], 'groq');
          reply = fbReply;
          modelUsed = fbModel + ' (fallback from gemini)';
        }
      }

    } else if (ASK === 'mistral' || ASK === 'codestral') {
      try {
        reply = await askMistral(messages);
        modelUsed = 'mistral';
      } catch (err) {
        console.warn('[Mobius] Mistral failed, falling back:', err.message);
        const { reply: fbReply, modelUsed: fbModel } = await askWithFallback(messages, [], 'groq');
        reply = fbReply;
        modelUsed = fbModel + ' (fallback from mistral)';
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
      saveConversation(userId, QUERY, reply, modelUsed, topic || 'general').catch(e => console.error('Save error:', e.message));
    }
  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).json({ error: err.message });
  }
};
