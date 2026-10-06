// pcm/chats.js — the message log cut into conversations ("chats"), so that Boon can refer to one.
// A new chat begins after 20 minutes of silence. Each chat gets a title and a short summary, which is what lets
// Mobius identify "the chat about X on Tuesday" and then read it, instead of guessing from stray messages.
import { supabase } from '../db.js';
import { askModel } from '../ai/cascade.js';
import { parseJson, clip } from '../util.js';

const GAP_MS = 20 * 60 * 1000;
const STOP = new Set('about after again also and any are because been before being between both but can could did does doing during each from have has had here his how into just like more most much not now only other our out over same she should some such than that the their them then there these they this those through under very was were what when where which while who why will with would you your please tell give show find look need want help make made know think said say get got let using use used chat chats conversation conversations discussion discussed previous earlier last time'.split(' '));
const words = s => [...new Set(String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\s-]+/gu, ' ').split(/\s+/).filter(w => w.length > 3 && !STOP.has(w)))];

const perth = iso => new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Perth', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(iso));
const perthDay = iso => new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Perth', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(iso));

// ── Cutting the log into chats ───────────────────────────────────────────────
export async function segmentChats() {
  if (!supabase) return { assigned: 0 };
  const { data: loose, error } = await supabase.from('mobius_messages').select('id, created_at').is('chat_id', null)
    .order('created_at', { ascending: true }).order('id', { ascending: true }).limit(3000);
  if (error || !loose?.length) return { assigned: 0 };
  const { data: last } = await supabase.from('mobius_chats').select('*').order('ended_at', { ascending: false }).limit(1).maybeSingle();

  const groups = [];
  let cur = null;
  for (const m of loose) {
    const t = Date.parse(m.created_at);
    if (!cur) cur = (last && t - Date.parse(last.ended_at) < GAP_MS && t >= Date.parse(last.started_at)) ? { row: last, ids: [], ended: last.ended_at } : { row: null, ids: [], started: m.created_at, ended: m.created_at };
    else if (t - Date.parse(cur.ended) > GAP_MS) { groups.push(cur); cur = { row: null, ids: [], started: m.created_at, ended: m.created_at }; }
    cur.ids.push(m.id); cur.ended = m.created_at;
  }
  if (cur) groups.push(cur);

  for (const g of groups) {
    let chatId;
    if (g.row) {
      chatId = g.row.id;
      await supabase.from('mobius_chats').update({ ended_at: g.ended, last_message_id: g.ids.at(-1), message_count: g.row.message_count + g.ids.length, updated_at: new Date().toISOString() }).eq('id', chatId);
    } else {
      const ins = await supabase.from('mobius_chats').insert({ started_at: g.started, ended_at: g.ended, first_message_id: g.ids[0], last_message_id: g.ids.at(-1), message_count: g.ids.length }).select('id').single();
      if (ins.error) { console.warn('[chats]', ins.error.message); continue; }
      chatId = ins.data.id;
    }
    for (let i = 0; i < g.ids.length; i += 300) await supabase.from('mobius_messages').update({ chat_id: chatId }).in('id', g.ids.slice(i, i + 300));
  }
  return { assigned: loose.length, chats: groups.length };
}

// ── Titles and summaries ─────────────────────────────────────────────────────
async function transcript(chatId, max = 9000) {
  const { data } = await supabase.from('mobius_messages').select('id, role, content, created_at, docs').eq('chat_id', chatId).order('created_at', { ascending: true }).order('id', { ascending: true });
  const lines = (data || []).map(m => `${m.role === 'user' ? 'Boon' : 'Mobius'}: ${String(m.content).replace(/\s+/g, ' ').slice(0, m.role === 'user' ? 500 : 300)}${m.docs?.length ? ' [files: ' + m.docs.join(', ') + ']' : ''}`);
  let text = lines.join('\n');
  if (text.length > max) text = text.slice(0, Math.floor(max * 0.55)) + '\n[…middle of the chat left out…]\n' + text.slice(-Math.floor(max * 0.4));
  return { text, count: (data || []).length };
}

export async function summariseChat(chat) {
  const { text, count } = await transcript(chat.id);
  if (!text) return null;
  const raw = await askModel(`Give a title and a summary for this conversation between Boon and his AI assistant (Mobius).

${text}

Reply with ONLY JSON: {"title":"at most 9 words naming the main topic, or the two or three main topics if the conversation moved from one subject to another","topics":["3 to 8 short keyphrases (1-3 words each) covering EVERY subject discussed, including minor ones, in the words Boon would use to look for them later"],"summary":"at most 650 characters in British English: what was discussed, any conclusions or decisions, open questions, and any files or images mentioned (an image is described by what it showed)"}`, { role: 'quick', timeoutMs: 40000 });
  const j = parseJson(raw);
  const title = String(j.title || '').replace(/\s+/g, ' ').trim().slice(0, 90);
  const summary = String(j.summary || '').replace(/\s+/g, ' ').trim().slice(0, 800);
  const topics = (Array.isArray(j.topics) ? j.topics : []).map(t => String(t).replace(/\s+/g, ' ').trim().slice(0, 40)).filter(Boolean).slice(0, 8);
  if (!title && !summary) return null;
  await supabase.from('mobius_chats').update({ title: title || null, topics, summary: summary || null, summary_msgs: count, updated_at: new Date().toISOString() }).eq('id', chat.id);
  return { ...chat, title, topics, summary, summary_msgs: count };
}

// Chats that are over (quiet for 20 minutes), have at least one exchange, and are not summarised yet or have grown since.
export async function summariseChats({ limit = 3 } = {}) {
  if (!supabase) return { skipped: 'no database' };
  const quiet = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  const { data } = await supabase.from('mobius_chats').select('*').gte('message_count', 2).lt('ended_at', quiet).order('started_at', { ascending: false }).limit(60);
  const todo = (data || []).filter(c => !c.summary || c.summary_msgs < c.message_count).slice(0, limit);
  let done = 0;
  for (const c of todo) { try { if (await summariseChat(c)) done++; } catch (e) { console.warn('[chats] summary failed:', e.message); } }
  return { summarised: done, waiting: Math.max(0, (data || []).filter(c => !c.summary || c.summary_msgs < c.message_count).length - done) };
}

// ── Finding a chat ───────────────────────────────────────────────────────────
// → up to `limit` chats, best first. `hitMessageIds` are archive-search hits: a chat that holds several of them is likely the one.
export async function findChats({ keywords = '', sinceDays = null, untilDays = null, previous = false, hitMessageIds = [], limit = 2 } = {}) {
  if (!supabase) return [];
  await segmentChats();
  const { data: newest } = await supabase.from('mobius_messages').select('chat_id').order('id', { ascending: false }).limit(1).maybeSingle();
  const currentId = newest?.chat_id || null;
  const since = sinceDays ? new Date(Date.now() - sinceDays * 864e5).toISOString() : null;
  const until = untilDays != null ? new Date(Date.now() - untilDays * 864e5).toISOString() : null;
  let q = supabase.from('mobius_chats').select('*').order('started_at', { ascending: false }).limit(300);
  if (since) q = q.gte('started_at', since);
  if (until) q = q.lte('started_at', until);
  const { data: chats } = await q;
  const pool = (chats || []).filter(c => c.id !== currentId);
  if (!pool.length) return [];
  if (previous) return pool.slice(0, 1);

  const hits = new Map();
  if (hitMessageIds.length) {
    const { data } = await supabase.from('mobius_messages').select('id, chat_id').in('id', hitMessageIds);
    for (const r of data || []) if (r.chat_id) hits.set(r.chat_id, (hits.get(r.chat_id) || 0) + 1);
  }
  const kw = words(keywords);
  const scored = pool.map(c => {
    const hay = `${c.title || ''} ${(c.topics || []).join(' ')} ${c.summary || ''}`.toLowerCase();
    const km = kw.filter(w => hay.includes(w)).length;
    return { c, score: (hits.get(c.id) || 0) * 2 + km * 3 };
  });
  const best = scored.filter(x => x.score > 0).sort((a, b) => b.score - a.score || b.c.started_at.localeCompare(a.c.started_at));
  if (best.length) return best.slice(0, limit).map(x => x.c);
  return (since || until) && !kw.length ? pool.slice(0, limit) : []; // a date alone ("last Tuesday") picks the chat of that time
}

// Make sure the chosen chats have a title and summary (one model call at most, so the reply is not held up).
export async function ensureSummaries(chats, { max = 1 } = {}) {
  let n = 0;
  const out = [];
  for (const c of chats) {
    if ((!c.summary || c.summary_msgs < c.message_count) && c.message_count >= 2 && n < max) {
      n++;
      try { out.push((await summariseChat(c)) || c); continue; } catch { /* fall through */ }
    }
    out.push(c);
  }
  return out;
}

// ── Reading a chat back ──────────────────────────────────────────────────────
export async function loadChatText(chat, { query = '', budget = 6500, focusIds = [] } = {}) {
  const { data } = await supabase.from('mobius_messages').select('id, role, content, created_at').eq('chat_id', chat.id).order('created_at', { ascending: true }).order('id', { ascending: true });
  const msgs = data || [];
  const fmt = (m, n) => `[${perth(m.created_at)}] ${m.role === 'user' ? 'Boon' : 'Mobius'}: ${clip(String(m.content).replace(/\n{3,}/g, '\n\n'), n)}`;
  let lines = msgs.map(m => ({ m, text: fmt(m, m.role === 'user' ? 700 : 900) }));
  const total = lines.reduce((s, l) => s + l.text.length, 0);
  if (total > budget) {
    // too long: keep first the messages the search found (with the ones either side of them), then the opening and the
    // ending, then whatever mentions what is being asked about
    const kw = words(query);
    const keep = new Set();
    let size = 0;
    const add = i => { if (i < 0 || i >= lines.length || keep.has(i) || size + lines[i].text.length > budget) return false; keep.add(i); size += lines[i].text.length; return true; };
    for (const id of focusIds) { const at = msgs.findIndex(m => m.id === id); if (at >= 0) { add(at); add(at - 1); add(at + 1); } }
    for (const i of [0, 1, msgs.length - 2, msgs.length - 1]) add(i);
    const ranked = msgs.map((m, i) => ({ i, s: kw.filter(w => m.content.toLowerCase().includes(w)).length })).filter(x => x.s > 0).sort((a, b) => b.s - a.s);
    for (const r of ranked) if (!add(r.i)) break;
    lines = [...keep].sort((a, b) => a - b).map(i => lines[i]);
  }
  const { data: att } = await supabase.from('mobius_attachments').select('message_id, caption, created_at').in('message_id', msgs.map(m => m.id));
  const pics = (att || []).filter(a => a.caption).map(a => `(picture sent at ${perth(a.created_at)}: ${a.caption.replace(/\s+/g, ' ').slice(0, 300)})`);
  const head = `Chat of ${perthDay(chat.started_at)}${chat.title ? ' — “' + chat.title + '”' : ''} (${chat.message_count} messages)${chat.summary ? '\nSummary: ' + chat.summary : ''}`;
  return [head, ...lines.map(l => l.text), ...pics].join('\n');
}

// "Show my recent chats": a plain list, newest first.
export async function listChats(limit = 12) {
  if (!supabase) return [];
  await segmentChats();
  const { data } = await supabase.from('mobius_chats').select('id, started_at, ended_at, message_count, title, summary').gte('message_count', 2).order('started_at', { ascending: false }).limit(limit);
  return data || [];
}
export const describeChat = c => `${perthDay(c.started_at)}, ${new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Perth', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(c.started_at))}: ${c.title || '(not yet titled)'}${c.summary ? ' — ' + clip(c.summary, 160) : ''}`;



// ── The chat Boon has opened ─────────────────────────────────────────────────
// He navigates back to an earlier exchange and writes from there. `messageId` is the question of the exchange on screen.
// → { chat, window, later }: the chat that exchange belongs to, its last `tail` messages up to and including the answer he is
// looking at (the verbatim window to continue from), and how many messages of that chat came after it.
export async function chatAtMessage(messageId, tail = 10) {
  if (!supabase || messageId == null) return null;
  await segmentChats(); // a message that is not yet cut into a chat has no chat_id
  const { data: row } = await supabase.from('mobius_messages').select('id, chat_id').eq('id', messageId).maybeSingle();
  if (!row?.chat_id) return null;
  const [{ data: chat }, { data: msgs }] = await Promise.all([
    supabase.from('mobius_chats').select('*').eq('id', row.chat_id).maybeSingle(),
    supabase.from('mobius_messages').select('id, role, content, created_at, ai_provider, docs').eq('chat_id', row.chat_id)
      .order('created_at', { ascending: true }).order('id', { ascending: true }),
  ]);
  const at = (msgs || []).findIndex(m => m.id === row.id);
  if (!chat || at < 0) return null;
  const upto = msgs.slice(0, at + 2); // through the answer to the exchange he is viewing
  return { chat, window: upto.slice(-tail), later: msgs.length - upto.length };
}
