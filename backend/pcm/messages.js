// pcm/messages.js — the raw chat log (archive tier, and the source of tier 1's verbatim window).
import { supabase } from '../db.js';

// The newest `limit` messages, oldest first.
export async function getMessages(limit) {
  if (!supabase) return [];
  const { data, error } = await supabase.from('mobius_messages')
    .select('id, role, content, created_at, ai_provider, docs')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) { console.warn('[pcm] getMessages:', error.message); return []; }
  return data.reverse();
}

// Keep only complete exchanges (a question followed by its answer). A question whose answer
// never arrived (every model failed, or the connection dropped) would otherwise be merged into
// the next question and answered in its place.
export function settled(messages) {
  const out = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'user' && messages[i + 1]?.role === 'assistant') out.push(messages[i], messages[++i]);
  }
  return out;
}

// A question and its answer are saved together, once the answer is complete, so the log never
// holds a question without an answer. Two devices can be mid-conversation at once: because each
// pair is written in one go, pairs never interleave.
export async function saveExchange({ query, docs = [], answer, model = null }) {
  if (!supabase || !query || !answer) return null;
  const t = Date.now();
  const { data, error } = await supabase.from('mobius_messages').insert([
    { role: 'user', content: query, docs: docs.length ? docs : null, created_at: new Date(t).toISOString() },
    { role: 'assistant', content: answer, ai_provider: model, created_at: new Date(t + 1).toISOString() },
  ]).select('id, role');
  if (error) { console.warn('[pcm] saveExchange:', error.message); return null; }
  return { userId: data?.find(r => r.role === 'user')?.id || null, assistantId: data?.find(r => r.role === 'assistant')?.id || null };
}
