// util.js — small helpers shared across modules.

export const sleep = ms => new Promise(r => setTimeout(r, ms));

// "Friday 2 October 2026, 2:25pm" in Perth time. Models don't know the date; we tell them.
export function perthNow() {
  const f = Object.fromEntries(new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Perth', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  }).formatToParts(new Date()).map(p => [p.type, p.value]));
  return `${f.weekday} ${f.day} ${f.month} ${f.year}, ${f.hour}:${f.minute}${String(f.dayPeriod).toLowerCase()}`;
}

export const isoDaysAgo = days => new Date(Date.now() - days * 864e5).toISOString();

// Trim text to n characters, marking the cut.
export function clip(text, n) {
  const s = String(text ?? '');
  return s.length <= n ? s : s.slice(0, Math.max(0, n - 14)).trimEnd() + ' […truncated]';
}

// Run an async function; on failure log and return the fallback. Used so a
// memory failure can never take the chat down.
export async function safe(fn, fallback) {
  try { return await fn(); }
  catch (e) { console.warn('[mobius]', e.message); return fallback; }
}

// Pull the first JSON object out of a model reply (tolerates code fences and chatter).
export function parseJson(text) {
  const s = String(text).replace(/```json|```/gi, '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON object in model output');
  return JSON.parse(s.slice(start, end + 1));
}

// "what did we decide about the plant database" -> "decide or about or plant or database"
// (OR semantics for Postgres websearch_to_tsquery; stopwords are dropped server-side.)
export function toOrQuery(text, max = 8) {
  const words = [...new Set(String(text).toLowerCase().match(/[a-z0-9]{3,}/g) || [])];
  return words.slice(0, max).join(' or ');
}
