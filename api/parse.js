module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { text, model, history, context } = req.body || {};

    if (!text) {
      res.status(400).json({ error: 'Text is required' });
      return;
    }

    // Detect Elaborate command — allow long answers
    const elaborate = /^Elaborate[:\s]/i.test(text) || /\belaborate\b/i.test(text);
    const cleanText = text.replace(/^Elaborate[:\s]+/i, '').trim() || text;

    const systemPrompt = elaborate
      ? 'You are Mobius, a helpful AI assistant. Provide a thorough and detailed answer.'
      : 'You are Mobius, a helpful AI assistant. Keep all responses concise and under 200 words. Be direct and to the point. If the user wants more detail, they will ask you to elaborate.';

    const systemMessage = { role: 'user', content: `[System] ${systemPrompt}` };
    // Strip any prior system messages from history to prevent duplication
    const cleanHistory = (history || []).filter(m => !m.content?.startsWith('[System] ') && !m.content?.startsWith('You are Mobius'));
    const instructions = [systemMessage, ...cleanHistory];

    const mobius_query = {
      ASK: model || 'groq',
      INSTRUCTIONS: instructions,
      QUERY: cleanText,
      FILES: [],
      CONTEXT: context || ''
    };

    res.status(200).json({ mobius_query });
  } catch (err) {
    console.error('Parse error:', err);
    res.status(500).json({ error: 'Parse failed' });
  }
};
