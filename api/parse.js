module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { text, model, history, context, forceInstructionMode } = req.body || {};

    if (!text) {
      return res.status(400).json({ error: 'Text is required' });
    }

    // Detect response mode
    const elaborate = /^Elaborate[:\s]/i.test(text) || /\belaborate\b/i.test(text);
    const cleanText = text.replace(/^Elaborate[:\s]+/i, '').trim() || text;

    // Code mode only when explicitly set by an active Code session (forceInstructionMode)
    const instructionMode = forceInstructionMode || (elaborate ? 'Long' : 'Brief');

    const systemPrompt =
      instructionMode === 'Long'
        ? 'Use British English spelling and conventions. You are Mobius, a helpful AI assistant. Provide a thorough and detailed answer.'
        : instructionMode === 'Code'
          ? 'Use British English spelling and conventions. You are Mobius, a helpful AI coding assistant. Provide complete, working code with brief explanations. Do not truncate code. Use markdown code blocks.'
          : 'Use British English spelling and conventions. You are Mobius, a helpful AI assistant. Keep all responses concise and under 500 words. Be direct and to the point. If the user wants more detail, they will ask you to elaborate.';

    // INSTRUCTIONS: always exactly 1 — the system prompt only
    const instructions = [
      { role: 'user', content: `[System] ${systemPrompt}` }
    ];

    // HISTORY: plain Q&A pairs only — strip any system messages that may have
    // leaked in from older sessions before this refactor
    const SYSTEM_PREFIXES = ['[System]', 'You are Mobius', '[User Environment]'];
    const history_clean = (history || []).filter(
      m => !SYSTEM_PREFIXES.some(p => m.content?.startsWith(p))
    );

    // Normalise web aliases
    const webAliases = { 'websearch': 'web', 'web': 'web', 'web2': 'web2', 'web3': 'web3' };
    const resolvedModel = webAliases[model?.toLowerCase()] || model || 'groq';

    const mobius_query = {
      ASK: resolvedModel,
      INSTRUCTIONS: instructionMode,
      HISTORY: history_clean,
      QUERY: cleanText,
      FILES: [],
      CONTEXT: null  // context is now passed as a virtual file, not a field
    };

    return res.status(200).json({ mobius_query });

  } catch (err) {
    console.error('Parse error:', err);
    return res.status(500).json({ error: 'Parse failed' });
  }
};
