// pcm/retrieve.js — recall from the memory tiers.
//   tier 1  getWeek()        digest of the past week + anything not yet digested
//   tier 2  getProfile()     who Boon is
//   tier 3  (projects are listed and picked in chat.js from memory.listActive)
//   tier 4  searchArchive()  hybrid vector + keyword search over every message and document
import { supabase } from '../db.js';
import { WEEK_DAYS } from '../config.js';
import { isoDaysAgo, toOrQuery } from '../util.js';
import { embedQuery } from './embed.js';
import { getActive, getState } from './memory.js';

export async function getProfile() {
  return (await getActive('profile'))?.content || '';
}

// The week digest only covers messages up to its last refresh, and the newest
// messages are sent verbatim. `gap` bridges the two so nothing from the week is missing.
export async function getWeek(windowStart) {
  const digest = (await getActive('week'))?.content || '';
  let gap = '';
  if (supabase && windowStart) {
    const upto = await getState('week_upto');
    const since = new Date(Math.max(upto ? Date.parse(upto) : 0, Date.now() - WEEK_DAYS * 864e5)).toISOString();
    const { data } = await supabase.from('mobius_messages')
      .select('role, content, created_at')
      .gt('created_at', since).lt('created_at', windowStart)
      .order('created_at', { ascending: false }).limit(60);
    // Written as dated notes, not as "user:" / "assistant:" turns: a small model that meets a transcript here takes its last
    // line for the live conversation and answers that (it once answered a question from the night before).
    const when = iso => new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Perth', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(iso));
    gap = (data || []).reverse().map(m => `- ${when(m.created_at)}, ${m.role === 'user' ? 'Boon said' : 'Mobius replied'}: “${m.content.replace(/\s+/g, ' ').slice(0, 160)}”`).join('\n');
  }
  return { digest, gap };
}

// Hybrid search (SQL functions pcm_search_messages / pcm_search_docs fuse vector and
// keyword ranks). Without an embedding — Gemini quota out — it degrades to keywords only.
export async function searchArchive({ semantic, keywords }, { sinceDays = null, noEmbed = false } = {}) {
  const empty = { messages: [], docs: [] };
  if (!supabase) return empty;
  const query_text = toOrQuery(keywords || semantic);
  const query_embedding = noEmbed ? null : await embedQuery(semantic); // noEmbed: a private message is not sent to the embedding service
  const min_date = sinceDays ? isoDaysAgo(sinceDays) : null;

  const [m, d] = await Promise.all([
    supabase.rpc('pcm_search_messages', { query_text, query_embedding, match_count: 6, min_date }),
    supabase.rpc('pcm_search_docs',     { query_text, query_embedding, match_count: 5 }),
  ]);
  if (m.error) console.warn('[pcm] search messages:', m.error.message);
  if (d.error) console.warn('[pcm] search docs:', d.error.message);
  return { messages: m.data || [], docs: d.data || [] };
}
