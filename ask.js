import { askGemini, askMistral, askWithFallback, askWebSearch } from './_ai.js';
import { saveConversation } from './_supabase.js';
import { getDriveFiles, getTasks, getCalendarEvents, getEmails } from '../google_api.js';

export default async function handler(req, res) {
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
      reply = await askGemini(messages, imageParts);
      modelUsed = 'gemini';
    } else if (ASK === 'mistral' || ASK === 'codestral') {
      reply = await askMistral(messages);
      modelUsed = 'mistral';
    } else if (ASK === 'websearch') {
      appendFileTexts();
      const { reply: wsReply, modelUsed: wsModel } = await askWebSearch(messages);
      reply = wsReply;
      modelUsed = wsModel;
    } else {
      appendFileTexts();
      const { reply: fallbackReply, modelUsed: fallbackModel } = await askWithFallback(messages, [], ASK);
      reply = fallbackReply;
      modelUsed = fallbackModel;
    }

    if (userId && reply !== '__CHAT_HISTORY__') {
      await saveConversation(userId, QUERY, reply, modelUsed, topic || 'general');
    }

    res.json({ reply, modelUsed });
  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).json({ error: err.message });
  }
}
