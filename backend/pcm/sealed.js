// pcm/sealed.js - sealed private exchanges.
// A message that begins "Private:" used to be thrown away. Now the question and its answer are kept, but in a table of their own
// (mobius_sealed_messages) with no embedding, no full-text index and no chat id, so no search, digest, summary, mood or learning job can
// reach them: those jobs read mobius_messages, and nothing else. Only two things read the sealed table, and both are in this file's callers:
//   - a PRIVATE turn (chat.js), so a private conversation can carry on, and
//   - the history screen (server.js), so the exchanges are still there when the window is reopened.
// A test (test/sealed.test.mjs) fails if any other file touches the table or imports this one.
import { supabase } from '../db.js';
import { getMessages } from './messages.js';

export const SEALED_ID_OFFSET = 1000000000; // ids shown to the page are offset, so one can never be mistaken for a row of mobius_messages
export const stripPrivatePrefix = q => String(q || '').replace(/^\s*(?:private|confidential)\s*[:\-\u2013\u2014]\s*/i, '');

const shaped = (row, screen) => ({
  id: SEALED_ID_OFFSET + row.id, role: row.role,
  content: screen && row.role === 'user' ? 'Private: ' + row.content : row.content, // on screen it reads as he typed it
  created_at: row.created_at, ai_provider: row.ai_provider || null, docs: null, sealed: true,
});

// Oldest first, by time (then id), keeping the newest `limit`.
export function mergeByTime(a, b, limit) {
  return [...a, ...b].sort((x, y) => (Date.parse(x.created_at) - Date.parse(y.created_at)) || (x.id - y.id)).slice(-limit);
}

export async function saveSealedExchange({ query, answer, model = null }) {
  if (!supabase || !query || !answer) return null;
  const t = Date.now();
  const { error } = await supabase.from('mobius_sealed_messages').insert([
    { role: 'user', content: String(query), created_at: new Date(t).toISOString() },
    { role: 'assistant', content: String(answer), ai_provider: model, created_at: new Date(t + 1).toISOString() },
  ]);
  if (error) { console.warn('[pcm] saveSealedExchange:', error.message); return null; }
  return true;
}

async function sealedRows(limit) {
  if (!supabase) return [];
  const { data, error } = await supabase.from('mobius_sealed_messages').select('id, role, content, created_at, ai_provider').order('created_at', { ascending: false }).limit(limit);
  if (error) { console.warn('[pcm] sealed messages:', error.message); return []; }
  return data.reverse();
}

// For a PRIVATE turn: the ordinary recent messages and the sealed ones, in time order, as the model's earlier turns.
export async function getRecentWithSealed(limit) {
  const [normal, sealed] = await Promise.all([getMessages(limit), sealedRows(limit)]);
  return mergeByTime(normal, sealed.map(r => shaped(r, false)), limit);
}

// For the history screen: both, the sealed ones shown with "Private: " in front of the question.
export async function getHistoryWithSealed(limit) {
  const [normal, sealed] = await Promise.all([getMessages(limit), sealedRows(limit)]);
  return mergeByTime(normal, sealed.map(r => shaped(r, true)), limit);
}

// The time of the newest message of either kind (other devices use it to notice that something new has been said).
export async function latestStamp() {
  const [a, b] = await Promise.all([getMessages(1), sealedRows(1)]);
  const times = [a[0]?.created_at, b[0]?.created_at].filter(Boolean);
  return times.length ? times.sort((x, y) => Date.parse(y) - Date.parse(x))[0] : null;
}