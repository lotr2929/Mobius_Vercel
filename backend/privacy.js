// privacy.js - what a PRIVATE message may send to the web-search company.
// A "Private:" message is answered only by models that do not train on prompts. It may also search the web (Tavily), but only with short,
// generic queries that carry nothing personal: never the whole question, never his notes, never a name from his life, never a pasted link.
// The guard is plain code, not a model, so it cannot be talked round. If his list of names cannot be read, it allows nothing.

const MAX_WORDS = 12, MAX_CHARS = 120;
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const MANY_DIGITS = /(?:\+?\d[\s().-]*){9,}/;           // a phone number, an account or ID number, a long run of figures
const LONG_NUMBER = /\d{5,}/;
const ADDRESS = /\bhttps?:\/\/|\bwww\./i;
const PERSONAL = /\b(?:my|our|mine|ours|me|myself|ourselves)\b/i;
const I_WORDS = /^I\b|\bI['\u2019](?:m|ve|ll|d)\b/;     // "I ..." as the first word, or I'm, I've, I'll, I'd (a bare "I" mid-query may be a Roman numeral)

// A name that is also a book of the Bible ("Daniel 9", "Mark 4:35", "the Book of Daniel", "Gospel of Mark") is the book, not the person.
const BIBLICAL = new Set(['mark', 'daniel', 'john', 'luke', 'matthew', 'paul', 'peter', 'james', 'jude', 'timothy', 'titus', 'joel', 'amos', 'ruth', 'job', 'esther', 'philip']);

const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wholeWord = name => new RegExp('(?<![\\p{L}\\p{N}])' + escape(name) + '(?![\\p{L}\\p{N}])', 'iu');
const scripture = name => new RegExp('\\b(?:books?|gospel|epistles?|letters?)\\s+(?:of|to)\\s+(?:the\\s+)?' + escape(name) + '\\b|\\b' + escape(name) + '\\s+\\d{1,3}(?::\\d{1,3})?\\b', 'ig');

// The names come from mobius_state 'private_names': an array (or JSON text of one). Anything else means "unknown", and unknown allows nothing.
export function parseNames(value) {
  let v = value;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = v.split(/\r?\n|,/); } }
  if (!Array.isArray(v)) return null;
  const names = [...new Set(v.map(x => String(x || '').trim()).filter(x => x.length >= 3))];
  return names.length ? names : null;
}

export function guardQuery(query, { names } = {}) {
  const q = String(query ?? '').replace(/\s+/g, ' ').trim();
  if (!q) return { ok: false, query: q, why: 'empty' };
  if (!Array.isArray(names) || !names.length) return { ok: false, query: q, why: 'the list of names to keep out of searches could not be read' };
  if (q.split(' ').length > MAX_WORDS || q.length > MAX_CHARS) return { ok: false, query: q, why: 'too long and detailed for a generic search' };
  if (EMAIL.test(q)) return { ok: false, query: q, why: 'an email address' };
  if (MANY_DIGITS.test(q) || LONG_NUMBER.test(q)) return { ok: false, query: q, why: 'a phone, account or ID-like number' };
  if (ADDRESS.test(q)) return { ok: false, query: q, why: 'a web address' };
  if (PERSONAL.test(q) || I_WORDS.test(q)) return { ok: false, query: q, why: 'personal wording (my, our, I)' };
  let rest = q;
  for (const name of names) if (BIBLICAL.has(name.toLowerCase())) rest = rest.replace(scripture(name), ' ');
  for (const name of names) {
    if (wholeWord(name).test(rest)) return { ok: false, query: q, why: 'a name from your own notes' };
  }
  return { ok: true, query: q };
}

// Up to three queries pass; the rest are dropped, and each refusal is kept with its reason (the reason never repeats the name).
export function guardQueries(queries, { names } = {}) {
  const allowed = [], blocked = [];
  for (const raw of Array.isArray(queries) ? queries : []) {
    const r = guardQuery(raw, { names });
    if (r.ok) { if (!allowed.includes(r.query) && allowed.length < 3) allowed.push(r.query); }
    else blocked.push({ why: r.why });
  }
  return { allowed, blocked };
}

// Shown under the answer, so he can always see exactly what was sent out.
export const searchFooter = queries => `\n\n_Private web search, sent out: ${queries.map(q => '\u201C' + q + '\u201D').join(', ')}. Nothing else from your message or notes left Mobius._`;
