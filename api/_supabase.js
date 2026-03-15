const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function saveConversation(userId, query, reply, modelUsed, topic, sessionId) {
  try {
    const { error } = await supabase
      .from('conversations')
      .insert([{
        user_id: userId,
        question: query,
        answer: reply,
        model: modelUsed,
        topic,
        session_id: sessionId || null,
        created_at: new Date().toISOString()
      }]);
    if (error) console.error('Error saving conversation:', error.message);
    // Don't throw — saving failure should never crash the ask response
  } catch (err) {
    console.error('Failed to save conversation:', err.message);
  }
}

async function getChatHistory(userId, limit = 10000) {
  try {
    const { data, error } = await supabase
      .from('conversations')
      .select('question, answer, model, topic, session_id, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: true })
      .limit(limit);
    if (error) throw error;
    // Group into sessions by session_id where available, fall back to 30-min gap
    const sessions = [];
    let current = null;
    const GAP_MS = 30 * 60 * 1000;
    for (const row of (data || [])) {
      const t = new Date(row.created_at).getTime();
      const sid = row.session_id || null;
      const newSession =
        !current ||
        (sid && current.session_id !== sid) ||
        (!sid && t - current.lastTime > GAP_MS);
      if (newSession) {
        current = { title: row.question, started_at: row.created_at, lastTime: t, session_id: sid, messages: [] };
        sessions.push(current);
      }
      current.lastTime = t;
      current.messages.push({ question: row.question, answer: row.answer, model: row.model, created_at: row.created_at });
    }
    sessions.reverse();
    return sessions;
  } catch (err) {
    console.error('Failed to get chat history:', err.message);
    return [];
  }
}

// ── Model event logging ─────────────────────────────────────────────────────────────
// Writes a model_event or error_event record to the knowledge table.
// Called after every AI call — success or failure. Never throws.
async function logModelEvent(userId, {
  type        = 'model_event',  // 'model_event' | 'error_event'
  provider,                     // 'groq' | 'gemini' | 'gemini-lite' | 'mistral' | 'github'
  modelId,                      // exact model string used
  displayName,                  // human-readable name
  capability   = 'general',     // task capability that triggered this call
  success,                      // boolean
  latencyMs,                    // response time in ms
  tokensIn     = 0,
  tokensOut    = 0,
  errorMessage = null,          // error string if failed
  errorType    = null,          // 'quota' | 'network' | 'timeout' | 'invalid' | 'unknown'
  fallbackFrom = null,          // model that failed before this one
  fallbackTo   = null,          // model tried next after this failure
  complexityScore = null,       // score that determined routing
  sessionId    = null
} = {}) {
  if (!userId) return; // no userId, no log
  try {
    const isError    = !success;
    const errorClass = errorMessage
      ? errorMessage.includes('quota')   ? 'quota'
      : errorMessage.includes('timeout') ? 'timeout'
      : errorMessage.includes('network') ? 'network'
      : errorMessage.includes('invalid') ? 'invalid'
      : 'unknown'
      : null;

    const tags = [
      provider,
      capability,
      success ? 'success' : 'failure',
      ...(errorClass ? [errorClass] : []),
      ...(fallbackFrom ? ['fallback'] : [])
    ].filter(Boolean);

    const content = success
      ? `${displayName} — ${capability} — ${latencyMs}ms — ${tokensIn}in/${tokensOut}out`
      : `${displayName} FAILED — ${capability} — ${errorClass || 'error'}: ${errorMessage}`;

    const now = new Date().toISOString();
    await supabase.from('knowledge').insert([{
      user_id:    userId,
      project:    'mobius',
      domain:     'management',
      type:       isError ? 'error_event' : 'model_event',
      tags,
      content,
      created_at: now,
      updated_at: now,
      context: {
        provider,
        model_id:         modelId,
        display_name:     displayName,
        capability,
        success,
        latency_ms:       latencyMs,
        tokens_in:        tokensIn,
        tokens_out:       tokensOut,
        error_message:    errorMessage,
        error_type:       errorClass || errorType,
        fallback_from:    fallbackFrom,
        fallback_to:      fallbackTo,
        complexity_score: complexityScore
      },
      session_id: sessionId || null
    }]);
  } catch (err) {
    // Never let logging crash the main flow
    console.error('[Mobius] logModelEvent failed:', err.message);
  }
}

module.exports = { supabase, saveConversation, getChatHistory, logModelEvent };
