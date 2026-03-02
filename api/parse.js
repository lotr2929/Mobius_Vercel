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

    const mobius_query = {
      ASK: model || 'groq',
      INSTRUCTIONS: history || [],
      QUERY: text,
      FILES: [],
      CONTEXT: context || ''
    };

    res.status(200).json({ mobius_query });
  } catch (err) {
    console.error('Parse error:', err);
    res.status(500).json({ error: 'Parse failed' });
  }
};
