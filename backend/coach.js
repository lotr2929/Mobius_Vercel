// coach.js - Mobius as a personal coach (added 29 Oct 2026).
//
//   "Coach: ..." starts a coaching session. It carries on without the prefix until "Coach: off" or four quiet hours, so a conversation
//   does not need the word on every line. Everything said in it stays private:
//     * answered ONLY by models that do not train on prompts (ai/models.js `trains: false`); if none can answer, nothing is sent anywhere;
//     * no web search, no embedding, no automatic learning, no mood reading, no digest: none of those jobs can see it;
//     * the conversation is kept in the sealed compartment (pcm/sealed.js, kind 'coach'); the journal and the commitments in tables of
//       their own (mobius_coach_journal, mobius_coach_items). Only this file touches those two tables (test/coach.test.mjs guards it);
//     * none of it goes into the Drive backup (which sits where other AIs can read it); the backup script copies it to this PC only.
//
//   The coach is a COACH, not a counsellor: it listens when Boon vents, does not send him to a therapist, doctor or helpline in ordinary
//   conversation, and does so only when a message shows clear signs of distress (distressSignal: plain code, not a model's impression).
//
//   Mobius keeps the journal itself. "Close the day" (or the next coaching session) writes the day's entry from what was said, and what
//   was agreed becomes a commitment with a due date, which the coach reads back at the start of each session.
import { runCascade, askModel } from './ai/cascade.js';
import { supabase } from './db.js';
import { getState, setState } from './pcm/memory.js';
import { saveSealedExchange, getRecentCoach, coachMessagesBetween, coachStamps } from './pcm/sealed.js';
import { settled } from './pcm/messages.js';
import { startTrace, saveTrace } from './trace.js';
import { RECENT_MESSAGES } from './config.js';
import { clip, safe, parseJson, nowIn } from './util.js';

export const DEFAULT_TZ = 'Australia/Perth';
export const COACH_PREFIX = /^\s*coach\s*[:\-\u2013\u2014]\s*/i;
const LEAVE = /^(?:done|end|off|stop|finished|exit|leave|bye|goodbye|that'?s all)\s*[.!]?\s*$/i;
export const MODE_IDLE_MS = 4 * 3600e3;
const NO_MODEL = 'No private model is available just now (they are resting or out of allowance), so nothing was sent anywhere. Try again in a little while. Everything you say in coaching stays off the models that may learn from it.';

// ── Reading the message ─────────────────────────────────────────────────────
export function parseCoachMessage(text) {
  const s = String(text || '');
  const m = s.match(COACH_PREFIX);
  if (!m) return { prefixed: false, body: s.trim(), leave: false };
  const body = s.slice(m[0].length).trim();
  return { prefixed: true, body, leave: LEAVE.test(body) };
}

export const modeActive = (state, now = Date.now(), idle = MODE_IDLE_MS) =>
  !!(state && state.on && state.at && now - Date.parse(state.at) < idle);

// Is this message a coaching turn? Prefixed, or the session is still open.
export async function coachRoute(text, now = Date.now()) {
  const p = parseCoachMessage(text);
  if (p.prefixed) return { kind: p.leave ? 'leave' : 'turn', body: p.body, opening: !p.body };
  const state = await getState('coach_mode');
  if (modeActive(state, now)) return { kind: 'turn', body: p.body, opening: false };
  return null;
}
const setMode = (on, now = new Date()) => setState('coach_mode', { on, at: now.toISOString() });

// ── Dates (Boon's own time zone; Perth unless the browser says otherwise) ───
export function dayKey(d, tz = DEFAULT_TZ) {
  const date = d instanceof Date ? d : new Date(d);
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
function tzOffsetMs(date, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(date).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(date.getTime() / 1000) * 1000;
}
// The instant a calendar day begins in the given zone.
export function dayStartUtc(key, tz = DEFAULT_TZ) {
  const [y, m, d] = key.split('-').map(Number);
  const midnightUtc = Date.UTC(y, m - 1, d);
  const first = new Date(midnightUtc - tzOffsetMs(new Date(midnightUtc), tz));
  return new Date(midnightUtc - tzOffsetMs(first, tz));
}
export const addDays = (key, n) => { const [y, m, d] = key.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
export const weekdayOf = key => new Date(key + 'T12:00:00Z').getUTCDay(); // 0 = Sunday
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
// "Thursday 29 October 2026" and "Thu 29 Oct", written by hand so that the result never depends on a machine's locale data
export const prettyDate = key => `${WEEKDAYS[weekdayOf(key)]} ${+key.slice(8, 10)} ${MONTH_NAMES[+key.slice(5, 7) - 1]} ${key.slice(0, 4)}`;
export const shortDate = key => `${WEEKDAYS[weekdayOf(key)].slice(0, 3)} ${+key.slice(8, 10)} ${MONTH_NAMES[+key.slice(5, 7) - 1].slice(0, 3)}`;
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5);
export const monday = key => addDays(key, -((weekdayOf(key) + 6) % 7));

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const pad = n => String(n).padStart(2, '0');
// "Friday", "tomorrow", "31 Oct", "Oct 31", "2026-11-02" -> 'YYYY-MM-DD', or null if it cannot be read
export function parseDue(phrase, now = new Date(), tz = DEFAULT_TZ) {
  const s = String(phrase || '').toLowerCase().replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  const today = dayKey(now, tz);
  const year = +today.slice(0, 4);
  let m;
  const t = s.replace(/^(?:sun|mon|tue|wed|thu|fri|sat)[a-z]*\s+(?=\d{1,2}(?:st|nd|rd|th)?\s+[a-z]{3})/, ''); // "sat 31 oct" -> "31 oct"
  if ((m = t.match(/^(\d{4})-(\d{2})-(\d{2})\b/))) return `${m[1]}-${m[2]}-${m[3]}`;
  if (/^yesterday\b/.test(t)) return addDays(today, -1);
  if (/^(?:today|tonight)\b/.test(t)) return today;
  if (/^tomorrow\b/.test(t)) return addDays(today, 1);
  if ((m = t.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3})[a-z]*(?:\s+(\d{4}))?\b/)) && MONTHS.includes(m[2])) return `${m[3] || year}-${pad(MONTHS.indexOf(m[2]) + 1)}-${pad(+m[1])}`;
  if ((m = t.match(/^([a-z]{3})[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s+(\d{4}))?\b/)) && MONTHS.includes(m[1])) return `${m[3] || year}-${pad(MONTHS.indexOf(m[1]) + 1)}-${pad(+m[2])}`;
  if ((m = t.match(/^(?:(next|this|coming)\s+)?(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/))) {
    let diff = (DAYS.indexOf(m[2]) - weekdayOf(today) + 7) % 7;
    if (m[1] === 'next' && diff === 0) diff = 7;
    return addDays(today, diff);
  }
  return null;
}

export function describeDue(due, today) {
  if (!due) return '';
  const d = daysBetween(today, due);
  const when = d === 0 ? 'today' : d === 1 ? 'tomorrow' : d > 1 ? `in ${d} days` : d === -1 ? 'overdue by 1 day' : `overdue by ${-d} days`;
  return `due ${shortDate(due)} (${when})`;
}
export function formatItems(items, today) {
  return items.map(i => `#${i.id} ${i.text}${i.detail ? ` [${i.detail}]` : ''}${i.due ? ' \u2014 ' + describeDue(i.due, today) : ''}`).join('\n');
}

// ── Clear distress: plain code, deliberately narrow ─────────────────────────
// Ordinary venting ("I'm fed up", "this is killing me", "I can't go on like this with the marking", "dead tired") must NOT match.
const DISTRESS = new RegExp([
  String.raw`\bkill(?:ing)? myself\b(?!\s+(?:for|if|when|over|laughing|trying)\b)`, String.raw`\bend(?:ing)? my (?:own )?life\b`, String.raw`\bend(?:ing)? it all\b`, String.raw`\btake my (?:own )?life\b`,
  String.raw`\bsuicid\w*`, String.raw`\bself[- ]?harm\w*`, String.raw`\b(?:hurt|harm)(?:ing)? myself\b`,
  String.raw`\bwant(?:ed)?(?: to)? die\b`, String.raw`\bwish i (?:was|were) dead\b`, String.raw`\bwish i (?:would|could)(?: just)? not wake up\b`,
  String.raw`\bbetter off (?:dead|without me)\b`, String.raw`\bno (?:point|reason) (?:in )?(?:living|being alive)\b`,
  String.raw`\bdon['\u2019]?t want to (?:live|be alive)\b`,
].join('|'), 'i');
export const distressSignal = text => DISTRESS.test(String(text || '').replace(/[\u2018\u2019]/g, "'"));

// ── The coach's character ───────────────────────────────────────────────────
// Kept short on purpose: the models that may be used here take about 22,000 characters in all, and the profile, the commitments and the journal also need room.
export const COACH_PROMPT = `You are Mobius, acting as Boon's personal coach. You are still Mobius: never claim to be any other assistant or vendor. Your work is practical: help him think clearly, keep his promises realistic, carry his load more lightly, and keep a strong but honest optimism. You are a coach, not a counsellor and not a doctor.

How you talk
- Speak TO him ("you"). British English. Warm, plain and brief: a few short paragraphs at most. No tables, no headings, no clinical vocabulary. A short list only for agreed actions.
- Be honest. Say what you think, including when he is harder on himself than the facts justify, or kinder to himself than they do. Never open by praising or agreeing ("Great", "You're right", "Absolutely"). No flattery and no empty cheering.
- Realistic optimism: name the real difficulty in one plain sentence, then find what is in his control, what has worked for him before, and the smallest next step. Never make a problem smaller than it is, and never leave it without a way forward.
- Do not psychoanalyse, label him or interpret his motives. Name an unhelpful pattern, plainly and without blame, only when the journal shows it more than once ("this is the third morning this week").

When he vents
- Listen first. Reflect what he said in a sentence or two, in his own words, add one honest, human remark if you have one, and let him lead. Do not fix, lecture, list tips or change the subject. In your first reply to a feeling, do not ask what he wants: reflect it and let him go on. Only if he keeps circling with no direction, ask once: "Do you want me to just listen, or help you sort it out?" But if he asks a question, asks for your view or brings a decision or a plan, answer it directly: never ask whether he wants to be listened to when he has asked something.
- Tiredness, worry, anger, a low morning or grief are ordinary and are not an emergency. Do not treat them as problems to refer on.

Help from others
- Do NOT suggest a therapist, counsellor, psychologist, doctor or helpline in ordinary conversation, however low he sounds. The only exception is a system note headed CLEAR DISTRESS below: then follow it.
- You do not give medical advice. If he asks about his own or Fee Yoon's treatment, help him prepare the questions for the people treating them; never advise on medicines or doses.

Coaching
- Help him keep to "promise less, deliver more": when he takes on something new, set it beside the open commitments and the time left, and say honestly if it is too much. Three real priorities beat ten.
- When he is deciding whether to take something on, weigh it honestly against the open commitments and the days left, give your view in two or three sentences, and ask the one question that would change it.
- Ask at most one question at a time. Offer a next step when he wants one or the plan is stuck.
- Use his own words and values when they help (Love, Creation, Contribution, Understanding; "Wake up with courage. Act with confidence. Reflect with gratitude."; "It is what it is ... just keep doing it ... enjoy today."). Do not preach, and do not raise his faith unless he does.
- When something is settled, say it back in one line starting "Agreed:" with the due date, so that it is written into the journal.
- Use only what the notes below and he himself have said. Never invent a number, a date or something he said. If you do not know, ask.
- Use what you know about him only where it changes your answer. Do not recite his health, his family or his worries back to him unless he raises them.`;

export const DISTRESS_NOTE = `CLEAR DISTRESS: his last message suggests he may be in real danger or despair. Put everything else aside for this reply. Answer warmly, directly and in plain words, and tell him you are glad he said it. Ask him plainly whether he is thinking of ending his life or harming himself. If he is in immediate danger, tell him to call 000; otherwise Lifeline is on 13 11 14, at any hour. Ask whether someone close is with him, and encourage him to tell them, or his doctor, today. Do not lecture, and do not return to tasks, commitments or the journal in this reply.`;

export function buildCoachContext({ profile = '', items = [], entries = [], week = null, now = new Date(), tz = DEFAULT_TZ, opening = false, newSession = false } = {}) {
  const today = dayKey(now, tz);
  const parts = [`Now: ${nowIn(tz)}.`];
  if (profile.trim()) parts.push(`What you know about him (his coaching profile; he can correct it):\n${clip(profile.trim(), 2800)}`);
  parts.push(items.length
    ? `His open commitments (use these numbers; he can say "done 3" or "drop 3"):\n${formatItems(items.slice(0, 25), today)}`
    : 'He has no open commitments on record.');
  const newest = entries.slice(0, 3).map(e => `[${shortDate(e.period)}]\n${clip(e.content, 1400)}`);
  if (newest.length) parts.push(`Your journal of recent days, newest first (your own record; trust it over guesses):\n${newest.join('\n\n')}`);
  if (week) parts.push(`Your latest weekly review:\n${clip(week.content, 1200)}`);
  if (opening) parts.push('He has just opened a coaching session and said nothing else. Open with one short, warm check-in that fits the time of day and, if something is due soon or overdue, name it plainly. Ask one question.');
  else if (newSession) parts.push('This is the first message of a new coaching session. If he is planning, deciding or asking about his day, you may add one short line about anything due today or overdue. If he is venting or low, say nothing about commitments.');
  return parts.join('\n\n');
}
export const buildCoachSystem = (ctx, { distress = false } = {}) =>
  `${COACH_PROMPT}\n\n${buildCoachContext(ctx)}${distress ? '\n\n' + DISTRESS_NOTE : ''}`;

// ── The coach's own tables ──────────────────────────────────────────────────
const need = () => { if (!supabase) throw new Error('No database connection.'); return supabase; };
export async function listItems({ status = 'open', limit = 60 } = {}) {
  const { data, error } = await need().from('mobius_coach_items').select('id, text, due, detail, status, created_at, closed_at').eq('status', status)
    .order('due', { ascending: true, nullsFirst: false }).order('id').limit(limit);
  if (error) throw new Error('coach items: ' + error.message);
  return data;
}
export async function addItem({ text, due = null, detail = null, from = null }) {
  const { data, error } = await need().from('mobius_coach_items').insert({ text: clip(text, 300), due, detail: detail ? clip(detail, 200) : null, from_period: from }).select('id, text, due').single();
  if (error) throw new Error('coach items: ' + error.message);
  return data;
}
export async function setItem(id, patch) {
  const { data, error } = await need().from('mobius_coach_items').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id).select('id, text, due, status').maybeSingle();
  if (error) throw new Error('coach items: ' + error.message);
  return data;
}
export async function listEntries({ kind = 'day', limit = 5 } = {}) {
  const { data, error } = await need().from('mobius_coach_journal').select('id, kind, period, content, created_at').eq('kind', kind).is('deleted_at', null)
    .order('period', { ascending: false }).limit(limit);
  if (error) throw new Error('coach journal: ' + error.message);
  return data;
}
export async function entryFor(kind, period) {
  const { data, error } = await need().from('mobius_coach_journal').select('id, kind, period, content, deleted_at').eq('kind', kind).eq('period', period).maybeSingle();
  if (error) throw new Error('coach journal: ' + error.message);
  return data;
}
export async function putEntry({ kind, period, content }) {
  const { error } = await need().from('mobius_coach_journal').upsert({ kind, period, content, deleted_at: null, updated_at: new Date().toISOString() }, { onConflict: 'kind,period' });
  if (error) throw new Error('coach journal: ' + error.message);
}
// "Forget": the entry is hidden from the coach and from "show journal", but kept in the PC-only backup (nothing Mobius removes is gone).
export async function hideEntry(kind, period) {
  const { data, error } = await need().from('mobius_coach_journal').update({ deleted_at: new Date().toISOString() }).eq('kind', kind).eq('period', period).is('deleted_at', null).select('id');
  if (error) throw new Error('coach journal: ' + error.message);
  return data?.length || 0;
}
// What the coach holds about him is kept as a row of the journal table (kind 'profile'), so it stays out of the Drive backup like the rest.
const PROFILE_PERIOD = '2000-01-01';
const getProfile = async () => (await entryFor('profile', PROFILE_PERIOD))?.content || '';
async function addToProfile(line, now) {
  const stamp = dayKey(now);
  const lines = (await getProfile()).split('\n').filter(Boolean);
  lines.push(`- ${clip(line, 400)} (${stamp})`);
  let text = lines.join('\n');
  while (text.length > 3500 && lines.length > 1) { lines.shift(); text = lines.join('\n'); } // the oldest lines go first
  await putEntry({ kind: 'profile', period: PROFILE_PERIOD, content: text });
  return text;
}

// ── Commands (plain rules, so they work even when every model is down) ─────
export function parseCoachCommand(body, now = new Date(), tz = DEFAULT_TZ) {
  const s = String(body || '').trim().replace(/[.!]+$/, '');
  let m;
  if ((m = s.match(/^show\s+(?:my\s+)?(?:coach\s+)?journal(?:\s+(?:for\s+)?(.+))?$/i))) return { cmd: 'show-journal', arg: m[1] ? m[1].trim() : null };
  if (/^(?:show|list|what are)\s+(?:my\s+)?(?:coach\s+)?(?:commitments|agreements|actions|to-?dos?)$/i.test(s)) return { cmd: 'show-items' };
  if (/^show\s+(?:my\s+)?(?:coach\s+)?profile$/i.test(s)) return { cmd: 'show-profile' };
  if ((m = s.match(/^(?:done|finished|completed)\s+#?(\d{1,6})$/i))) return { cmd: 'item-done', id: +m[1] };
  if ((m = s.match(/^(?:drop|cancel|scrap)\s+#?(\d{1,6})$/i))) return { cmd: 'item-drop', id: +m[1] };
  if ((m = s.match(/^(?:later|move|postpone)\s+#?(\d{1,6})\s+(?:to|until|till)\s+(.+)$/i))) return { cmd: 'item-move', id: +m[1], due: parseDue(m[2], now, tz), phrase: m[2] };
  if ((m = s.match(/^(?:add|commit(?:ment)?|agreed)\s*[:\-]?\s+(.+)$/i))) {
    const t = m[1].trim();
    const by = t.match(/^(.*?)\s+(?:by|on|before|due)\s+(.+)$/i);
    const due = by ? parseDue(by[2], now, tz) : null;
    return { cmd: 'item-add', text: by && due ? by[1].trim() : t, due };
  }
  if ((m = s.match(/^(?:note|remember(?: that)?)\s*[:\-]?\s+(.+)$/i))) return { cmd: 'profile-add', text: m[1].trim() };
  if (/^(?:close(?: the)?\s+(?:day|today|journal)|end(?: of)?\s+day|write\s+(?:up\s+)?(?:the\s+|today'?s\s+)?journal)$/i.test(s)) return { cmd: 'close-day' };
  if (/^(?:weekly review|review (?:the |my )?week|week in review)$/i.test(s)) return { cmd: 'weekly' };
  if ((m = s.match(/^forget\s+(?:the\s+)?(?:journal\s+)?entry\s+(?:for\s+|of\s+)?(.+)$/i))) return { cmd: 'forget-entry', arg: m[1].trim() };
  return null;
}

export const HELP_LINE = 'You can say: "show journal", "show commitments", "done 3", "drop 3", "later 3 to Friday", "add ... by Friday", "close the day", "weekly review", or "Coach: off".';

async function runCommand(c, { now, tz }) {
  const today = dayKey(now, tz);
  switch (c.cmd) {
    case 'show-items': {
      const items = await listItems();
      return items.length ? `Your open commitments:\n\n${formatItems(items, today)}` : 'You have no open commitments on record.';
    }
    case 'show-profile': {
      const p = await getProfile();
      return p.trim() ? `What I hold about you for coaching:\n\n${p}\n\nTell me "note: ..." to add a line.` : 'I hold nothing about you for coaching yet. Tell me "note: ..." to add a line.';
    }
    case 'profile-add': await addToProfile(c.text, now); return 'Noted, and I will keep it in mind when we talk.';
    case 'item-done': case 'item-drop': {
      const r = await setItem(c.id, { status: c.cmd === 'item-done' ? 'done' : 'dropped', closed_at: now.toISOString() });
      return r ? `${c.cmd === 'item-done' ? 'Marked done' : 'Dropped'}: #${r.id} ${r.text}.` : `I cannot find commitment #${c.id}.`;
    }
    case 'item-move': {
      if (!c.due) return `I could not read "${c.phrase}" as a date. Try "later ${c.id} to Friday" or "later ${c.id} to 2 Nov".`;
      const r = await setItem(c.id, { due: c.due });
      return r ? `Moved #${r.id} ${r.text} to ${shortDate(c.due)}.` : `I cannot find commitment #${c.id}.`;
    }
    case 'item-add': {
      const r = await addItem({ text: c.text, due: c.due, from: today });
      return `Added #${r.id}: ${r.text}${r.due ? ` \u2014 ${describeDue(r.due, today)}` : ''}.`;
    }
    case 'show-journal': {
      if (c.arg) {
        const key = parseDue(c.arg, now, tz);
        const e = key ? await entryFor('day', key) : null;
        return e && !e.deleted_at ? e.content : `There is no journal entry for ${c.arg}.`;
      }
      const list = await listEntries({ kind: 'day', limit: 7 });
      if (!list.length) return 'There is no journal entry yet. Say "close the day" and I will write today\u2019s.';
      return `${list[0].content}\n\n---\nEarlier entries: ${list.slice(1).map(e => shortDate(e.period)).join(', ') || 'none yet'}. Say "show journal 28 Oct" to read one.`;
    }
    case 'forget-entry': {
      const key = parseDue(c.arg, now, tz);
      if (!key) return `I could not read "${c.arg}" as a date.`;
      const n = await hideEntry('day', key);
      return n ? `The entry for ${prettyDate(key)} is hidden from me and from the journal. A copy stays in the private backup on your PC.` : `There is no entry for ${c.arg}.`;
    }
    default: return null;
  }
}

// ── The journal, written by Mobius ──────────────────────────────────────────
export const JOURNAL_SYSTEM = `You keep a private coaching journal for Boon. You write ONLY what the conversation below actually says. Never invent a number, a date, a feeling or an event. If something was not mentioned, write "Not mentioned." Write to him in the second person ("you slept about six hours"), in British English, plainly and briefly, with no flattery. Reply with one JSON object and nothing else.`;

export function buildJournalPrompt({ day, transcript, items, previous }) {
  return `Write the journal entry for ${prettyDate(day)}.

The entry is Markdown with this exact layout:

**DATE:** ${prettyDate(day)}

**1. HEALTH & ENERGY**
- **Sleep:** ...
- **Body:** ...
- **Mind:** how he said he felt, in his own words where possible

**2. CAREGIVING & HOUSEHOLD**
- ...

**3. WORKLOAD & PROGRESS**
- the numbers he gave (marking done and left, meetings, deadlines), exactly as given

**4. CREATION & PROJECTS**
- ...

**5. REFLECTION & NEXT DAY'S INTENTION**
- **How it felt:** one honest sentence
- **What helped / what did not:** only if it came up
- **Tomorrow's focus:** only what he and you agreed

**AGREED**
- each thing he committed to, with its due date (or "none")

Then list the changes to his commitments. Use only ids from the list below. Reply as JSON:
{"entry": "<the whole entry as Markdown>", "items": [{"op":"add","text":"...","due":"YYYY-MM-DD or null","detail":"or null"},{"op":"done","id":0},{"op":"drop","id":0},{"op":"update","id":0,"due":"YYYY-MM-DD or null","detail":"e.g. 8 left"}]}
Add an item only if he clearly agreed to it. Mark one done only if he said it is done. Leave "items" empty if nothing changed.

His open commitments:
${items.length ? items.map(i => `#${i.id} ${i.text}${i.detail ? ` [${i.detail}]` : ''}${i.due ? ' (due ' + i.due + ')' : ''}`).join('\n') : 'none'}

${previous ? `Yesterday's entry, for continuity only:\n${clip(previous, 1200)}\n\n` : ''}The conversation of ${day}:
${transcript}`;
}

export const WEEK_SYSTEM = `You keep a private coaching journal for Boon. Use ONLY the entries and commitments given. Never invent anything. Write to him in the second person, in British English, plainly and briefly, with no flattery. Reply with one JSON object and nothing else.`;
export function buildWeekPrompt({ from, to, entries, closed, open }) {
  return `Write his weekly review for the week ${shortDate(from)} to ${shortDate(to)}, as Markdown with these headings:

**WEEK OF ${shortDate(from).toUpperCase()}**
**What got done**
**What moved or was dropped** (and whether the promises were realistic: "promise less, deliver more")
**What weighed on you, and what helped**
**A pattern worth noticing** (only if the entries show it more than once; otherwise "Nothing clear yet.")
**Three priorities for next week**

Reply as JSON: {"entry": "<the review as Markdown>"}

Commitments closed this week:
${closed.length ? closed.map(i => `- ${i.text} (${i.status})`).join('\n') : 'none'}

Still open:
${open.length ? open.map(i => `- ${i.text}${i.due ? ' (due ' + i.due + ')' : ''}`).join('\n') : 'none'}

The week's entries:
${entries.map(e => `[${e.period}]\n${clip(e.content, 1500)}`).join('\n\n')}`;
}

// What the model proposed: the entry text and the changes to commitments, checked against the real list before anything is changed.
export function parseJournalReply(text, openIds = []) {
  let obj;
  try { obj = parseJson(text); } catch { return { entry: String(text || '').trim(), ops: [], parsed: false }; }
  const entry = String(obj.entry || '').trim();
  const ids = new Set(openIds);
  const ops = (Array.isArray(obj.items) ? obj.items : []).flatMap(o => {
    if (!o || typeof o !== 'object') return [];
    const due = typeof o.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(o.due) ? o.due : null;
    if (o.op === 'add' && typeof o.text === 'string' && o.text.trim()) return [{ op: 'add', text: o.text.trim(), due, detail: typeof o.detail === 'string' && o.detail.trim() ? o.detail.trim() : null }];
    if ((o.op === 'done' || o.op === 'drop') && ids.has(Number(o.id))) return [{ op: o.op, id: Number(o.id) }];
    if (o.op === 'update' && ids.has(Number(o.id))) return [{ op: 'update', id: Number(o.id), due, detail: typeof o.detail === 'string' && o.detail.trim() ? o.detail.trim() : null }];
    return [];
  });
  return { entry, ops, parsed: true };
}

async function applyOps(ops, { day, now }) {
  const done = [];
  for (const o of ops) {
    if (o.op === 'add') { await addItem({ text: o.text, due: o.due, detail: o.detail, from: day }); done.push(o); }
    else if (o.op === 'done' || o.op === 'drop') { await setItem(o.id, { status: o.op === 'done' ? 'done' : 'dropped', closed_at: now.toISOString() }); done.push(o); }
    else if (o.op === 'update') {
      const patch = {};
      if (o.due) patch.due = o.due;
      if (o.detail) patch.detail = o.detail;
      if (Object.keys(patch).length) { await setItem(o.id, patch); done.push(o); }
    }
  }
  return done;
}

const transcriptOf = rows => clip(rows.map(r => `${r.role === 'user' ? 'Boon' : 'Mobius'}: ${clip(r.content, 900)}`).join('\n\n'), 13000);

export async function writeDayEntry(day, { now = new Date(), tz = DEFAULT_TZ } = {}) {
  const from = dayStartUtc(day, tz), to = dayStartUtc(addDays(day, 1), tz);
  const rows = await coachMessagesBetween(from.toISOString(), to.toISOString());
  if (!rows.length) return { ok: false, why: 'nothing was said in coaching on that day' };
  const [items, prev] = await Promise.all([listItems(), entryFor('day', addDays(day, -1))]);
  const prompt = buildJournalPrompt({ day, transcript: transcriptOf(rows), items, previous: prev && !prev.deleted_at ? prev.content : '' });
  const reply = await askModel(prompt, { role: 'chat', privateOnly: true, timeoutMs: 70000, system: JOURNAL_SYSTEM });
  const { entry, ops, parsed } = parseJournalReply(reply, items.map(i => i.id));
  if (!entry) return { ok: false, why: 'the model returned no entry' };
  await putEntry({ kind: 'day', period: day, content: entry });
  const changed = parsed ? await applyOps(ops, { day, now }) : [];
  return { ok: true, entry, changed, parsed };
}

export async function writeWeekEntry(weekStart, { now = new Date(), tz = DEFAULT_TZ } = {}) {
  const to = addDays(weekStart, 6);
  const { data: all } = await need().from('mobius_coach_journal').select('period, content').eq('kind', 'day').is('deleted_at', null).gte('period', weekStart).lte('period', to).order('period');
  if (!all?.length) return { ok: false, why: 'no daily entries that week' };
  const since = dayStartUtc(weekStart, tz).toISOString(), until = dayStartUtc(addDays(to, 1), tz).toISOString();
  const { data: closed } = await need().from('mobius_coach_items').select('text, status').in('status', ['done', 'dropped']).gte('closed_at', since).lt('closed_at', until);
  const open = await listItems();
  const reply = await askModel(buildWeekPrompt({ from: weekStart, to, entries: all, closed: closed || [], open }), { role: 'chat', privateOnly: true, timeoutMs: 70000, system: WEEK_SYSTEM });
  const { entry } = parseJournalReply(reply, []);
  if (!entry) return { ok: false, why: 'the model returned no review' };
  await putEntry({ kind: 'week', period: weekStart, content: entry });
  return { ok: true, entry };
}

// Days with coaching but no entry (before today) get one now; a finished week with two or more entries gets its review.
export async function catchUpJournal({ now = new Date(), tz = DEFAULT_TZ, maxDays = 2 } = {}) {
  const today = dayKey(now, tz);
  const stamps = await coachStamps(new Date(now.getTime() - 14 * 864e5).toISOString());
  const days = [...new Set(stamps.map(t => dayKey(t, tz)))].filter(d => d < today).sort();
  const wrote = [];
  for (const d of days) {
    if (wrote.length >= maxDays) break;
    const e = await entryFor('day', d);
    if (e) continue; // an entry (even a hidden one) is respected
    const r = await writeDayEntry(d, { now, tz }).catch(err => ({ ok: false, why: err.message }));
    if (r.ok) wrote.push(d);
  }
  const lastWeek = addDays(monday(today), -7);
  if (!(await entryFor('week', lastWeek))) {
    const n = (await listEntries({ kind: 'day', limit: 14 })).filter(e => e.period >= lastWeek && e.period <= addDays(lastWeek, 6)).length;
    if (n >= 2) await writeWeekEntry(lastWeek, { now, tz }).then(r => { if (r.ok) wrote.push('week ' + lastWeek); }).catch(() => {});
  }
  return wrote;
}

// ── One coaching turn ───────────────────────────────────────────────────────
// Yields { event } and { token } like chatTurn. route comes from coachRoute. dryRun: run the model, keep nothing.
export async function* coachTurn({ route, signal, dryRun = false, tz = DEFAULT_TZ, redactionNote = '' }) {
  const trace = startTrace('coach', { query: '[coach message - not recorded]', dryRun, tz, events: [] });
  const now = new Date();
  try {
    if (redactionNote) yield { token: redactionNote };
    if (route.kind === 'leave') {
      if (!dryRun) await safe(() => setMode(false, now), null);
      yield { event: 'model:Coach (rules)' };
      yield { token: 'Coach mode is off. We are back to ordinary Mobius. Say "Coach:" whenever you want me again.' };
      return;
    }
    const body = route.body;
    // Plain-rule commands first: no model needed, and nothing is sent anywhere.
    const cmd = body ? parseCoachCommand(body, now, tz) : null;
    if (cmd) {
      if (!dryRun) await safe(() => setMode(true, now), null);
      let text;
      if (cmd.cmd === 'close-day' || cmd.cmd === 'weekly') {
        yield { event: 'model:Coach (journal)' };
        const today = dayKey(now, tz);
        const r = cmd.cmd === 'close-day' ? await writeDayEntry(today, { now, tz }) : await writeWeekEntry(monday(today), { now, tz });
        text = r.ok
          ? `${r.entry}${r.changed?.length ? `\n\n---\nCommitments updated: ${r.changed.length}. Say "show commitments" to see them.` : ''}${r.parsed === false ? '\n\n(I could not read the changes to your commitments from this, so I left them alone.)' : ''}`
          : `I could not write it: ${r.why}.`;
      } else {
        yield { event: 'model:Coach (rules)' };
        text = (await runCommand(cmd, { now, tz })) || HELP_LINE;
      }
      yield { token: text };
      if (!dryRun && !signal?.aborted) await safe(() => saveSealedExchange({ query: body, answer: text, model: 'coach commands', kind: 'coach' }), null);
      return;
    }

    // A conversation turn.
    const lastState = dryRun ? null : await safe(() => getState('coach_mode'), null);
    const newSession = !modeActive(lastState, now.getTime(), 6 * 3600e3);
    if (!dryRun) await safe(() => setMode(true, now), null);
    const [profile, items, entries, weeks, raw] = await Promise.all([
      safe(getProfile, ''), safe(() => listItems(), []), safe(() => listEntries({ kind: 'day', limit: 3 }), []), safe(() => listEntries({ kind: 'week', limit: 1 }), []),
      safe(() => getRecentCoach(RECENT_MESSAGES + 4), []),
    ]);
    const distress = distressSignal(body);
    const system = buildCoachSystem({ profile, items, entries, week: weeks[0] || null, now, tz, opening: route.opening, newSession }, { distress });
    const messages = [...settled(raw).slice(-RECENT_MESSAGES).map(m => ({ role: m.role, content: m.content })), { role: 'user', content: body || 'Hello.' }];
    trace.set({ distress, items: items.length, entries: entries.length, system_chars: system.length, turns: messages.length });

    let full = '', usedModel = null, failure = null;
    try {
      for await (const chunk of runCascade(messages, { signal, system, privateOnly: true })) {
        if (typeof chunk === 'string') { full += chunk; yield { token: chunk }; }
        else if (chunk.event) {
          if (chunk.event.startsWith('model:')) usedModel = chunk.event.slice(6);
          if (chunk.event === 'error:no-private-model') failure = NO_MODEL;
          trace.data.events.push(chunk.event.slice(0, 160));
          yield { event: chunk.event };
        }
      }
    } catch (e) { failure = failure || ('The coaching models could not answer just now (' + String(e.message).slice(0, 80) + '). Nothing was sent to any model that may learn from it. Please try again in a moment.'); }
    if (!full.trim() && failure) { full = failure; yield { token: failure }; }

    trace.set({ model: usedModel, answer_chars: full.length, answer_head: '[coach]' }).mark('answered');
    if (!dryRun && !signal?.aborted && full.trim() && !failure) {
      await safe(() => saveSealedExchange({ query: body || 'Hello.', answer: full, model: usedModel, kind: 'coach' }), null);
      catchUpJournal({ now, tz }).catch(() => {}); // earlier days without an entry get one; never blocks the reply
    }
  } catch (e) {
    trace.set({ error: String(e.message).slice(0, 300) });
    throw e;
  } finally {
    trace.mark('end');
    await saveTrace(trace);
  }
}
