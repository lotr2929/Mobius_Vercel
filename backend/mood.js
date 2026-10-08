// mood.js - a light, private record of how Boon says he is, read from his own messages.
//   * No forms and no daily questions. When he says how he feels in a chat ("I've been a bit flat", "good day today"), a model
//     that does not train on prompts (ai/models.js `trains: false`) scores it from -2 (very low) to +2 (very good) and keeps his
//     own words as the evidence. Feelings about a topic, other people's feelings and opinions are not counted.
//   * Once or twice a week at most, on random days, the first reply of a chat opens with a friendly "How are you keeping today,
//     Boon?". His answer is read like any other message; ignoring it costs nothing.
//   * Trends are plain arithmetic (moodStats), never a model's impression, and are compared with his OWN usual level, since he
//     mostly mentions it when he is low. A model is given only a short computed summary, and only when he asks about his mood or
//     speaks of his feelings. The raw rows and his quotes go only to models that do not train, and only for a GP/counsellor summary.
//   * Settings lists every entry with his words and lets him delete any or all.
import { supabase } from './db.js';
import { askModel } from './ai/cascade.js';
import { clip, parseJson } from './util.js';

export const GREETING = 'How are you keeping today, Boon?';
export const DEFAULT_TZ = 'Australia/Perth';
const DAY = 86400000;
const GREET_CHANCE = 0.3;        // per day he writes at the start of a chat; with the limits below that is about one or two a week
const GREET_MAX_PER_WEEK = 2;
const GREET_MIN_GAP_DAYS = 2;
const CHAT_GAP_MS = 90 * 60 * 1000; // a new chat begins after this long a silence
const NOTE_GAP_DAYS = 14;          // a low pattern is raised at most once in this time

// ── Reading his messages ────────────────────────────────────────────────────

const STATE = [
  'down', 'low', 'flat', 'sad', 'depressed', 'blue', 'anxious', 'worried', 'stressed', 'exhausted', 'tired', 'drained', 'lonely',
  'hopeless', 'empty', 'numb', 'overwhelmed', 'irritable', 'miserable', 'unwell', 'awful', 'terrible', 'rubbish', 'lousy', 'dreadful',
  'better', 'worse', 'good', 'great', 'fine', 'well', 'happy', 'cheerful', 'content', 'calm', 'peaceful', 'hopeful', 'energetic',
  'upbeat', 'positive', 'ok', 'okay', 'alright', 'joyful', 'grateful', 'relieved', 'settled', 'discouraged', 'defeated', 'useless',
  'worthless', 'fed up', 'burnt out', 'burned out', 'on edge', 'at peace', 'in good spirits', 'not (?:so |very |too )?(?:good|great|well|happy|myself)',
].join('|');
const ADV = '(?:(?:so|very|really|quite|rather|pretty|a bit|a little|much|still|just|bit)\\s+)*';
const APOS = "['\u2019]";
// A cheap gate in front of the model: it must catch every real report and may let false ones through (the model decides).
export const FEELING_CUE = new RegExp([
  `\\bi(?:${APOS}m|${APOS}ve been| am| have been| was| feel| felt| still feel| have felt)\\s+(?:(?:feeling|being)\\s+)?${ADV}(?:${STATE})\\b`,
  `\\bi (?:feel|felt|have been feeling|am feeling)\\b`,
  `\\bi${APOS}m feeling\\b`,
  `\\bfeeling ${ADV}(?:${STATE})\\b`,
  `\\bmy (?:mood|spirits)\\b`,
  `\\bhow i(?:${APOS}m| am) (?:feeling|doing|keeping)\\b`,
  `\\b(?:no|little|lost my|lost) (?:energy|motivation|appetite|interest)\\b`,
  `\\bcan${APOS}?t (?:sleep|cope|face)\\b`,
  `\\b(?:low|bad|rough|good|great|hard|dark) (?:day|night|patch|week|spell|mood)\\b`,
  `\\b(?:depressed|depression|hopeless|despair|miserable)\\b`,
].join('|'), 'i');

// "How have I been?", "my mood lately", "a summary for my GP"
export const MOOD_ASK = new RegExp([
  `\\bhow (?:have|am|was|are) (?:i|you) (?:been|doing|keeping|finding me|found me)\\b`,
  `\\bhow(?:${APOS}s| has| have) my (?:mood|moods|spirits)\\b`,
  `\\bmy (?:mood|moods)\\b`,
  `\\bmood (?:record|log|history|trend|trends|tracker|summary|chart)\\b`,
  `\\b(?:summary|report|chart|overview)\\b[^.?!]{0,40}\\b(?:gp|doctor|counsel+or|psycholog\\w+|psychiatrist)\\b`,
  `\\b(?:gp|doctor|counsel+or|psycholog\\w+|psychiatrist)\\b[^.?!]{0,60}\\b(?:summary|report|chart|how i(?:${APOS}ve| have) been)\\b`,
].join('|'), 'i');
export const MOOD_REPORT_ASK = /\b(?:summary|report|chart|overview|print|show me|list)\b|\bgp\b|\bdoctor\b|\bcounsel/i; // wants the weekly figures and his own words

const norm = s => String(s).toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\s+/g, ' ').trim();

// A long message is cut to the stretch around its first cue, so a pasted paper costs no more than a sentence.
function around(text, max = 1500) {
  if (text.length <= max) return text;
  const m = FEELING_CUE.exec(text);
  const start = Math.max(0, (m ? m.index : 0) - 400);
  return text.slice(start, start + max);
}

// The sentence of the message that carries the cue, used as the quote when the model's own quote is not found word for word.
function fallbackQuote(text) {
  const parts = text.split(/(?<=[.!?\n])\s+/);
  const hit = parts.find(p => FEELING_CUE.test(p)) || parts[0] || text;
  return clip(hit.trim(), 160);
}

// { score, quote } when the message says how Boon himself is, otherwise null. Only models that do not train on prompts are used.
export async function moodFromMessage({ query, answeringCheckin = false }) {
  const text = String(query || '').trim();
  if (!text) return null;
  if (!answeringCheckin && !FEELING_CUE.test(text)) return null;
  if (answeringCheckin && text.length > 600 && !FEELING_CUE.test(text)) return null; // he ignored the greeting and asked something else
  const body = around(text);
  const prompt = `You read one message that Boon wrote to his AI assistant, and decide whether it tells how HE HIMSELF is feeling in himself at present or lately: his mood, spirits or energy.

Count:
- his own mood, spirits, energy or wellbeing now, today, this week or lately ("I've been feeling flat", "good day today", "so tired of it all", "much better this morning");
${answeringCheckin ? '- a short answer to the assistant\'s greeting "How are you keeping today, Boon?" ("not too bad", "a bit low", "can\'t complain"), which counts even if it is only a few words.\n' : ''}Do not count:
- feelings about a topic, task, idea or event rather than himself ("I'm excited about this app", "I'm worried the code will fail", "I'm happy with that answer");
- opinions or arguments ("I feel that the argument fails");
- other people's feelings or health;
- hypotheticals, quotations, or anything the assistant said;
- how he felt long ago.

If it counts, give ONE score for the overall state he describes: -2 very low (despair, hopeless, cannot cope), -1 low (flat, down, worn out, anxious), 0 neutral or mixed (ok, so-so), 1 good, 2 very good (joyful, buoyant). Give the exact words of his that say it, copied letter for letter, at most 160 characters.
Reply with ONLY JSON: {"report":{"score":-1,"quote":"..."}} or {"report":null}.

Boon's message:
"""
${body}
"""`;
  let r;
  try { r = parseJson(await askModel(prompt, { role: 'learn', timeoutMs: 9000, privateOnly: true })).report; }
  catch { return null; }
  if (!r || !Number.isInteger(r.score) || r.score < -2 || r.score > 2) return null;
  let quote = String(r.quote || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!quote || !norm(text).includes(norm(quote))) quote = fallbackQuote(text);
  return { score: r.score, quote };
}

// ── The record ──────────────────────────────────────────────────────────────

// Everything except backfill bookkeeping, newest first.
export async function recentMood(days = 120) {
  if (!supabase) return [];
  const since = new Date(Date.now() - days * DAY).toISOString();
  const { data, error } = await supabase.from('mobius_mood')
    .select('id, created_at, kind, score, quote, message_id, source')
    .neq('kind', 'cursor').gte('created_at', since).order('created_at', { ascending: false }).limit(1500);
  if (error) { console.warn('[mood] recentMood:', error.message); return []; }
  return data;
}

export async function addReport({ score, quote, messageId = null, createdAt = null, source = 'chat' }) {
  if (!supabase) return null;
  if (messageId != null) {
    const { data } = await supabase.from('mobius_mood').select('id').eq('message_id', messageId).eq('kind', 'report').limit(1);
    if (data?.length) return null; // this message is already on record
  }
  const row = { kind: 'report', score, quote: clip(String(quote || ''), 200), message_id: messageId, source };
  if (createdAt) row.created_at = createdAt;
  const { error } = await supabase.from('mobius_mood').insert(row);
  if (error) { console.warn('[mood] addReport:', error.message); return null; }
  return row;
}

export async function addMarker(kind) { // 'asked' | 'noted'
  if (!supabase) return;
  const { error } = await supabase.from('mobius_mood').insert({ kind, source: 'chat' });
  if (error) console.warn('[mood] marker:', error.message);
}

export async function deleteMood(id) {
  if (!supabase) return;
  const { error } = await supabase.from('mobius_mood').delete().eq('id', id).eq('kind', 'report');
  if (error) throw new Error(error.message);
}

export async function deleteAllMood() {
  if (!supabase) return;
  const { error } = await supabase.from('mobius_mood').delete().gte('id', 0); // every kind, including backfill progress
  if (error) throw new Error(error.message);
}

// ── Days, greetings and patterns (pure, so they can be tested) ──────────────

export function dayOf(date, tz = DEFAULT_TZ) {
  const fmt = zone => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(date));
  try { return fmt(tz); } catch { return fmt(DEFAULT_TZ); }
}
const dayNumber = day => Math.round(Date.parse(day + 'T00:00:00Z') / DAY);

// A fixed number between 0 and 1 for a given date, so "random" days are the same however many times it is asked.
export function dayRoll(day) {
  let h = 2166136261;
  for (const ch of day + '|mobius-checkin') { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return h / 4294967296;
}

export function isChatStart(lastMessageAt, now = new Date()) {
  return !lastMessageAt || now - new Date(lastMessageAt) > CHAT_GAP_MS;
}

// rows = recentMood(). Greets on a random day, at the start of a chat, never twice in a day, never on a day he has already said
// how he is, at most twice in seven days and not on consecutive days.
export function shouldGreet({ now = new Date(), tz = DEFAULT_TZ, rows = [], chance = GREET_CHANCE } = {}) {
  const today = dayOf(now, tz), n = dayNumber(today);
  const asked = rows.filter(r => r.kind === 'asked').map(r => dayNumber(dayOf(r.created_at, tz)));
  if (asked.includes(n)) return false;
  if (rows.some(r => r.kind === 'report' && dayOf(r.created_at, tz) === today)) return false;
  if (asked.filter(d => n - d < 7).length >= GREET_MAX_PER_WEEK) return false;
  if (asked.some(d => n - d < GREET_MIN_GAP_DAYS)) return false;
  return dayRoll(today) < chance;
}

const mean = a => (a.length ? a.reduce((s, r) => s + r.score, 0) / a.length : null);
const f1 = x => (x == null ? 'n/a' : (x > 0 ? '+' : '') + x.toFixed(1));

// The last fortnight against his own usual (the 90 days before it), and week by week. Plain arithmetic.
export function moodStats(rows, now = new Date(), tz = DEFAULT_TZ) {
  const reports = rows.filter(r => r.kind === 'report' && Number.isInteger(r.score));
  const ageDays = r => (now - new Date(r.created_at)) / DAY;
  const last = reports.filter(r => ageDays(r) >= 0 && ageDays(r) < 14);
  const older = reports.filter(r => ageDays(r) >= 14 && ageDays(r) < 104);
  const mean14 = mean(last), meanOlder = mean(older);
  const days14 = new Set(last.map(r => dayOf(r.created_at, tz))).size;
  let verdict = 'unknown';
  if (last.length >= 5 && older.length >= 6) {
    const d = mean14 - meanOlder;
    verdict = d <= -0.6 ? 'lower' : d >= 0.6 ? 'higher' : 'usual';
  }
  const lowRun = last.length >= 5 && days14 >= 3 && ((verdict === 'lower' && mean14 <= -0.5) || (verdict === 'unknown' && mean14 <= -1));
  const weeks = [];
  for (let i = 0; i < 8; i++) {
    const w = reports.filter(r => ageDays(r) >= i * 7 && ageDays(r) < i * 7 + 7);
    if (w.length) weeks.push({ to: dayOf(new Date(now - i * 7 * DAY), tz), n: w.length, mean: mean(w), min: Math.min(...w.map(r => r.score)) });
  }
  return { total: reports.length, n14: last.length, days14, mean14, nOlder: older.length, meanOlder, verdict, lowRun, weeks };
}

// Raise a sustained low once, gently, and not more than once in two weeks.
export function shouldRaisePattern({ stats, rows, now = new Date(), tz = DEFAULT_TZ }) {
  if (!stats.lowRun) return false;
  const n = dayNumber(dayOf(now, tz));
  return !rows.some(r => r.kind === 'noted' && n - dayNumber(dayOf(r.created_at, tz)) < NOTE_GAP_DAYS);
}

// The words a model is given. Only this short computed summary goes into an ordinary prompt; with detail (a GP summary) it also
// gets the weekly figures and some of his own words, and that turn goes only to models that do not train.
export function moodText(stats, rows, { detail = false, tz = DEFAULT_TZ, now = new Date() } = {}) {
  if (!stats.total) return 'Nothing about his mood has been recorded yet, so there is no record to speak from: say so plainly.';
  const lines = [
    'Scores run from -2 (very low) to +2 (very good). Each comes from something Boon himself said about how he is, so the record shows how he SAYS he is, not how he is; days he did not mention it count for nothing; and he mostly mentions it when he is low.',
    `Last 14 days: ${stats.n14} report${stats.n14 === 1 ? '' : 's'} on ${stats.days14} day${stats.days14 === 1 ? '' : 's'}${stats.n14 ? `, average ${f1(stats.mean14)}` : ''}.`,
  ];
  if (stats.nOlder) lines.push(`His own usual, over the three months before that: average ${f1(stats.meanOlder)} from ${stats.nOlder} reports.`);
  lines.push({
    lower: 'This fortnight is LOWER than his own usual.',
    higher: 'This fortnight is HIGHER than his own usual.',
    usual: 'This fortnight is about his own usual.',
    unknown: 'There are too few reports to say whether this is different from his usual: say so.',
  }[stats.verdict]);
  if (detail) {
    if (stats.weeks.length) lines.push('Week by week (newest first): ' + stats.weeks.map(w => `to ${w.to}: ${w.n} report${w.n === 1 ? '' : 's'}, average ${f1(w.mean)}, lowest ${f1(w.min)}`).join('; ') + '.');
    const recent = rows.filter(r => r.kind === 'report' && r.quote && (now - new Date(r.created_at)) / DAY < 60);
    const pick = [...recent].sort((a, b) => a.score - b.score).slice(0, 3).concat([...recent].sort((a, b) => b.score - a.score).slice(0, 2));
    const seen = new Set();
    const quotes = pick.filter(r => !seen.has(r.id) && seen.add(r.id)).map(r => `${dayOf(r.created_at, tz)} (${f1(r.score)}): "${clip(r.quote, 140)}"`);
    if (quotes.length) lines.push('His own words, some of the lowest and highest in the last two months:\n' + quotes.join('\n'));
  }
  return lines.join('\n');
}

// ── Reading his earlier chats once, to start from a baseline ────────────────

async function getCursor() {
  const { data } = await supabase.from('mobius_mood').select('message_id').eq('kind', 'cursor').order('id', { ascending: false }).limit(1);
  return data?.[0]?.message_id ?? 0;
}
async function setCursor(id) {
  await supabase.from('mobius_mood').delete().eq('kind', 'cursor');
  await supabase.from('mobius_mood').insert({ kind: 'cursor', message_id: id, source: 'backfill' });
}

// Works through his old messages in order, a bounded amount at a time (the Settings button calls it until `done`).
export async function backfillMood({ budgetMs = 25000, batch = 60 } = {}) {
  if (!supabase) return { done: true, processed: 0, found: 0, remaining: 0 };
  const t0 = Date.now();
  let cursor = await getCursor(), processed = 0, found = 0;
  while (Date.now() - t0 < budgetMs) {
    const { data, error } = await supabase.from('mobius_messages').select('id, content, created_at')
      .eq('role', 'user').gt('id', cursor).order('id', { ascending: true }).limit(batch);
    if (error) throw new Error(error.message);
    if (!data.length) return { done: true, processed, found, remaining: 0 };
    let last = cursor;
    for (const m of data) {
      if (Date.now() - t0 > budgetMs) break;
      last = m.id; processed++;
      if (!FEELING_CUE.test(m.content || '')) continue;
      const r = await moodFromMessage({ query: m.content });
      if (r && await addReport({ ...r, messageId: m.id, createdAt: m.created_at, source: 'backfill' })) found++;
    }
    cursor = last;
    await setCursor(cursor);
  }
  const { count } = await supabase.from('mobius_messages').select('id', { count: 'exact', head: true }).eq('role', 'user').gt('id', cursor);
  return { done: false, processed, found, remaining: count ?? 0 };
}
