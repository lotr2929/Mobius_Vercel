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

// ── Session lifecycle ────────────────────────────────────────────────────────
// startSession: creates a new row in the sessions table, returns the session ID.
// Never throws — if Supabase is unavailable the caller gets null and carries on.
async function startSession(userId, project = 'mobius', domain = 'management') {
  if (!userId) return null;
  try {
    const id  = 'sess_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    const now = new Date().toISOString();
    const { error } = await supabase.from('sessions').insert([{
      id,
      user_id:    userId,
      project,
      domain,
      started_at: now,
      updated_at: now,
      status:     'active'
    }]);
    if (error) { console.error('[Mobius] startSession error:', error.message); return null; }
    console.log('[Mobius] Session started:', id);
    return id;
  } catch (err) {
    console.error('[Mobius] startSession failed:', err.message);
    return null;
  }
}

// closeSession: marks session ended, writes deterministic summary.
// Called from session/close endpoint (triggered by sendBeacon on beforeunload).
// Also updates the heartbeat timestamp so we know when the session was last active.
async function closeSession(sessionId, userId) {
  if (!sessionId || !userId) return;
  try {
    const now = new Date().toISOString();

    // Gather raw material for the deterministic summary
    const [convRes, errRes] = await Promise.all([
      supabase
        .from('conversations')
        .select('question, model, created_at')
        .eq('session_id', sessionId)
        .order('created_at', { ascending: true }),
      supabase
        .from('knowledge')
        .select('content, tags, created_at')
        .eq('session_id', sessionId)
        .eq('type', 'error_event')
    ]);

    const convs  = convRes.data  || [];
    const errors = errRes.data   || [];

    // Build deterministic summary — no AI, no ambiguity
    const lines = [];
    lines.push(`Session: ${sessionId}`);
    lines.push(`Exchanges: ${convs.length}`);

    if (convs.length > 0) {
      const models = [...new Set(convs.map(c => c.model).filter(Boolean))];
      lines.push(`Models used: ${models.join(', ') || 'unknown'}`);
      lines.push(`First query: ${convs[0].question?.slice(0, 120) || '(none)'}`);
      if (convs.length > 1) {
        lines.push(`Last query:  ${convs[convs.length - 1].question?.slice(0, 120) || '(none)'}`);
      }
    }

    if (errors.length > 0) {
      lines.push(`Errors: ${errors.length}`);
      errors.slice(0, 3).forEach(e => lines.push(`  - ${e.content?.slice(0, 100) || '(unknown)'}`));
    } else {
      lines.push('Errors: none');
    }

    const summary_det = lines.join('\n');

    const { error } = await supabase.from('sessions').update({
      ended_at:           now,
      updated_at:         now,
      status:             'ended',
      summary_det,
      pending_ai_summary: true
    }).eq('id', sessionId).eq('user_id', userId);

    if (error) console.error('[Mobius] closeSession error:', error.message);
    else console.log('[Mobius] Session closed:', sessionId);
  } catch (err) {
    console.error('[Mobius] closeSession failed:', err.message);
  }
}

// heartbeat: keeps updated_at current so we can detect abandoned sessions.
// Called every 5 minutes from the client via sendBeacon or fetch.
async function heartbeatSession(sessionId, userId) {
  if (!sessionId || !userId) return;
  try {
    await supabase.from('sessions')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', sessionId).eq('user_id', userId).eq('status', 'active');
  } catch (err) {
    console.error('[Mobius] heartbeat failed:', err.message);
  }
}

module.exports = { supabase, saveConversation, getChatHistory, logModelEvent, startSession, closeSession, heartbeatSession };
