const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function saveConversation(userId, query, reply, modelUsed, topic) {
  try {
    const { error } = await supabase
      .from('conversations')
      .insert([{
        user_id: userId,
        question: query,
        answer: reply,
        model: modelUsed,
        topic,
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
      .select('question, answer, model, topic, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: true })
      .limit(limit);
    if (error) throw error;
    // Group into sessions by 30-min gap
    const sessions = [];
    let current = null;
    const GAP_MS = 30 * 60 * 1000;
    for (const row of (data || [])) {
      const t = new Date(row.created_at).getTime();
      if (!current || t - current.lastTime > GAP_MS) {
        current = { title: row.question, started_at: row.created_at, lastTime: t, messages: [] };
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

module.exports = { supabase, saveConversation, getChatHistory };
