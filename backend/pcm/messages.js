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

// Saved without an embedding: embedding happens in the background (see maintain.js),
// which keeps the reply fast and spares the Gemini quota.
export async function saveMessage(role, content, { model = null, docs = [] } = {}) {
  if (!supabase || !content) return;
  const { error } = await supabase.from('mobius_messages').insert({
    role,
    content,
    ai_provider: model,
    docs: docs.length ? docs : null,
    created_at: new Date().toISOString(),
  });
  if (error) console.warn('[pcm] saveMessage:', error.message);
}
