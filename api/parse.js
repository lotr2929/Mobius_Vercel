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
    const instructions = [systemMessage, ...(history || [])];

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
