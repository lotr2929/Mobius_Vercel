// compare-cli.mjs — which model writes Boon's prayers properly, through the real pipeline?
//   npm run compare                       every chat model, the two prayer requests
//   npm run compare -- --only=gemini35,gptoss     some models
//   npm run compare -- --runs=2           ask each prompt twice (a model can be right once by luck)
// Each model is forced with "Ask: <key>" and the request goes through the whole of chat.js with dryRun: the router, Boon's real notes,
// the window built for that model, the system prompt. Nothing is saved, nothing is learned, no note is changed. It does use each
// model's free allowance (two calls per model, and the routing calls), so run it when models or the prompt change, not on every deploy.
// Plain code scores the answer against what Boon has asked for, in his own words, in his notes:
//   quotes     quotes scripture in the prayer itself (at least three references, and quoted words), not merely cites it
//   accurate   what it puts in quotation marks is what the stored WEB or KJV says (at least 80% of the quoted stretches are found)
//   fresh      draws on passages not used in his recent prayers (it may reuse one at most)
//   bold       asks plainly: none of "if it be your will" and its kin
//   subject    the prayer is for Fee Yoon: named at once, and again
//   closing    ends with prayers for Boon, Xin and Daniel (the last part names Xin and Daniel)
//   relation   never calls Fee Yoon his daughter
//   discreet   leaves out medical details and personal worries (liver, drugs, bipolar, children ...) outside the scripture quoted
//   no Mark 9  does not echo the father's cry ("help my unbelief"), which he has asked it not to do every time
//   a prayer   is a prayer: begins by addressing God (no preface), and is not a list of verses or a lecture
// A model that passes every check is not thereby good, and one that misses one is not thereby bad: the full texts are written to
// _dev/compare/ so that Boon (or Claude) can read the best of them.
import { mkdirSync, writeFileSync, existsSync, readFileSync, appendFileSync } from 'node:fs';
import { MODELS, orderFor } from './ai/models.js';
import { chatTurn } from './chat.js';
import { getMessages } from './pcm/messages.js';
import { extractRefs } from './bible.js';
import { supabase } from './db.js';
import { KEYS } from './config.js';

const arg = (name, dflt = '') => (process.argv.find(a => a.startsWith(`--${name}=`)) || '').slice(name.length + 3) || dflt;
const only = arg('only').split(',').filter(Boolean);
const runs = Math.max(1, Number(arg('runs', '1')) || 1);

// Boon's own words (5 and 6 Oct 2026), so the test is the request he really makes
const PROMPTS = [
  { id: 'format', text: 'Give me a healing prayer for Fee Yoon in the format we had agreed on.' },
  { id: 'family', text: "Give me a healing prayer for Fee Yoon and include me, Xin and Daniel towards the end. Pray for my GPR work and for Xin and Daniel's marriage as we have discussed. Don't just reference Biblical verses, quote them in your prayer." },
];

// passages used in recent prayers: what a new prayer should not repeat
const past = await getMessages(80);
const usedBefore = new Set();
for (const m of past) if (m.role === 'assistant' && /\b(?:Lord|Father)\b/.test(m.content) && /\bpray/i.test(m.content)) for (const r of extractRefs(m.content, {})) usedBefore.add(r.label);

const HEDGE = /\bif it (?:be|is) (?:your|thy) will\b|\bif you are willing\b|\bif it pleases you\b|\bwhatever your will\b|\bnot my will\b|\bshould it be your will\b/i;
const MARK9 = /help (?:thou )?my unbelief|I believe[;,]? help/i;
const DAUGHTER = /Fee Yoon[^.\n]{0,60}\bdaughter\b|\bdaughter\b[^.\n]{0,25}Fee Yoon/i;
// Boon (7 Oct 2026): leave out medical details and personal worries; let the background inform the prayer without being referred to.
// Scripture in quotation marks is taken out first (a verse may speak of sickness or children), then these specifics are looked for.
const SPECIFIC = /\b(?:liver|hepat\w*|cirrho\w*|medicat\w*|pantoprazole|entecavir|furosemide|carvedilol|spironolactone|bipolar|mania|manic|depress\w*|diagnos\w*|prognos\w*|surgery|chemo\w*|cancer|tumou?rs?|children|childless|baby|babies|pregnan\w*|fertil\w*|infertil\w*|expectations?|her doctors?)\b/i;
const unquoted = t => t.replace(/[“"][^”"]{15,600}[”"]/g, ' ');

// The stored WEB and KJV, chapter by chapter, to check that what a prayer puts in quotation marks is what scripture says.
// Read once from the database and kept in _dev/compare/ (about 8 MB).
const norm = s => String(s).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
async function loadChapters() {
  const cache = new URL('../_dev/compare/bible-cache.json', import.meta.url);
  mkdirSync(new URL('../_dev/compare/', import.meta.url), { recursive: true });
  if (existsSync(cache)) return JSON.parse(readFileSync(cache, 'utf8'));
  const chapters = {};
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('mobius_bible').select('translation, book, chapter, verse, text').order('translation').order('book').order('chapter').order('verse').range(from, from + 999);
    if (error) throw new Error('bible: ' + error.message);
    for (const r of data) (chapters[`${r.translation}/${r.book}/${r.chapter}`] ||= []).push(norm(r.text));
    if (data.length < 1000) break;
  }
  const joined = Object.values(Object.fromEntries(Object.entries(chapters).map(([k, v]) => [k, v.join(' ')])));
  writeFileSync(cache, JSON.stringify(joined));
  return joined;
}
const CHAPTERS = await loadChapters();

// Each quoted stretch of 4 or more words (split at "…") must appear in the stored text of some chapter: share found, and how many were tested
function quoteAccuracy(text) {
  const frags = [];
  for (const m of text.matchAll(/[“"]([^”"]{15,500})[”"]/g)) for (const f of m[1].split(/…|\.\.\./)) if (norm(f).split(' ').length >= 4) frags.push(norm(f));
  if (!frags.length) return { tested: 0, found: 0, share: 0 };
  const found = frags.filter(f => CHAPTERS.some(c => c.includes(f))).length;
  return { tested: frags.length, found, share: found / frags.length };
}

function score(text) {
  const refs = extractRefs(text, {}).map(r => r.label);
  const unique = [...new Set(refs)];
  const reused = unique.filter(r => usedBefore.has(r)).length;
  const tail = text.slice(Math.floor(text.length * 0.55));
  const firstFee = text.search(/Fee Yoon/i);
  const acc = quoteAccuracy(text);
  return {
    quotes: unique.length >= 3 && /[“"‘'][^”"’']{25,}[”"’']/.test(text),
    accurate: acc.share >= 0.8,
    fresh: unique.length - reused >= 2 && reused <= 1,
    bold: !HEDGE.test(text),
    subject: firstFee >= 0 && firstFee < 500 && (text.match(/Fee Yoon/gi) || []).length >= 2,
    closing: /\bXin\b/.test(tail) && /\bDaniel\b/.test(tail),
    relation: !DAUGHTER.test(text),
    discreet: !SPECIFIC.test(unquoted(text)),
    'no Mark 9': !MARK9.test(text),
    'a prayer': text.length > 1000 && /\b(?:Lord|Father|God|Jesus|Christ)\b/.test(text.slice(0, 80)) && refs.length < text.length / 90,
    _accuracy: acc,
  };
}

const rows = [];
// NVIDIA's trial terms forbid personal data and Mistral's free mode trains on prompts; the prayers carry Boon's family and profile, so they are
// left out unless asked for (--all). A model named with --only is always tried, whatever its role.
const skip = process.argv.includes('--all') ? [] : ['nvidia', 'mistral'];
const chat = (only.length ? only.map(k => MODELS.find(m => m.key === k)).filter(Boolean) : orderFor('chat').map(k => MODELS.find(m => m.key === k))).filter(m => only.length || !skip.includes(m.provider));
for (const m of chat) {
  if (only.length && !only.includes(m.key)) continue;
  if (!KEYS[m.provider]) { rows.push({ m, note: 'no key' }); continue; }
  for (const p of PROMPTS) for (let run = 1; run <= runs; run++) {
    let out = '', error = null, first = null, secs = 0;
    // Groq's free key allows 8,000 tokens a minute, and a prayer request is about 5,000: a refusal is tried again once, after the minute
    for (let attempt = 1; attempt <= 2 && !out.trim(); attempt++) {
      if (attempt === 2) await new Promise(r => setTimeout(r, 40000));
      const t0 = Date.now();
      error = null; first = null;
      try {
        for await (const t of chatTurn({ query: `Ask: ${m.key} ${p.text}`, dryRun: true, signal: AbortSignal.timeout(120000) })) {
          if (typeof t.token === 'string') { if (first === null) first = Date.now() - t0; out += t.token; }
          else if (t.event?.startsWith('fallback:') || t.event?.startsWith('error:')) error = t.event.slice(0, 100);
        }
      } catch (e) { error = e.message.slice(0, 100); }
      secs = Math.round((Date.now() - t0) / 1000);
    }
    if (!out.trim()) { rows.push({ m, p, run, note: 'no answer — ' + (error || 'empty'), secs }); continue; }
    rows.push({ m, p, run, out, secs, first, checks: score(out) });
    await new Promise(r => setTimeout(r, m.provider === 'groq' ? 30000 : 2000)); // gentle on per-minute allowances
  }
}

const dir = new URL('../_dev/compare/', import.meta.url);
mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
writeFileSync(new URL(`prayers-${stamp}.json`, dir), JSON.stringify(rows.map(r => ({ model: r.m.name, prompt: r.p?.id, run: r.run, secs: r.secs, firstTokenMs: r.first, note: r.note, checks: r.checks, text: r.out })), null, 2));
writeFileSync(new URL(`prayers-${stamp}.md`, dir), rows.filter(r => r.out).map(r => `## ${r.m.name} — ${r.p.id} (run ${r.run}, ${r.secs}s)\n\nChecks missed: ${Object.entries(r.checks).filter(([k, ok]) => !k.startsWith('_') && !ok).map(([k]) => k).join(', ') || 'none'}. Quotations found in scripture: ${r.checks._accuracy.found} of ${r.checks._accuracy.tested}.\n\n${r.out}\n`).join('\n---\n\n'));

const per = new Map();
// Every run is also appended to one file, so that testing spread over several days (the flagship Gemini models allow only 20 requests a day each)
// builds up a picture: _dev/compare/history.jsonl, one line per prayer written or refused
appendFileSync(new URL('history.jsonl', dir), rows.map(r => JSON.stringify({
  when: new Date().toISOString(), model: r.m.key, prompt: r.p?.id, secs: r.secs, answered: !!r.out, note: r.note || null,
  checks: r.checks ? Object.fromEntries(Object.entries(r.checks).filter(([k]) => !k.startsWith('_'))) : null,
  quotes: r.checks ? `${r.checks._accuracy.found}/${r.checks._accuracy.tested}` : null,
})).join('\n') + '\n');
for (const r of rows) {
  if (!per.has(r.m.key)) per.set(r.m.key, { m: r.m, points: 0, of: 0, secs: [], misses: {}, unavailable: 0, qf: 0, qt: 0 });
  const s = per.get(r.m.key);
  if (!r.checks) { s.unavailable++; s.note = r.note; continue; }
  const ok = Object.entries(r.checks).filter(([k]) => !k.startsWith('_'));
  s.points += ok.filter(([, v]) => v).length; s.of += ok.length; s.secs.push(r.secs);
  s.qf += r.checks._accuracy.found; s.qt += r.checks._accuracy.tested;
  for (const [k, v] of ok) if (!v) s.misses[k] = (s.misses[k] || 0) + 1;
}
const lines = [`Passages used in recent prayers (not to be repeated): ${usedBefore.size}`, ''];
for (const s of [...per.values()].sort((a, b) => (b.of ? b.points / b.of : -1) - (a.of ? a.points / a.of : -1))) {
  if (!s.of) { lines.push(`—      ${s.m.name.padEnd(30)} ${s.note || 'no answer'}`); continue; }
  const avg = Math.round(s.secs.reduce((a, b) => a + b, 0) / s.secs.length);
  const miss = Object.entries(s.misses).map(([k, n]) => `${k}×${n}`).join(', ');
  lines.push(`${String(s.points).padStart(3)}/${s.of}  ${s.m.name.padEnd(30)} ${String(avg).padStart(3)}s avg  quotes true to scripture ${s.qf}/${s.qt}  ${miss ? 'missed: ' + miss : 'missed nothing'}${s.unavailable ? `  (${s.unavailable} unavailable)` : ''}`);
}
lines.push('', `Full texts: _dev/compare/prayers-${stamp}.md`);
writeFileSync(new URL(`summary-${stamp}.txt`, dir), lines.join('\n')); // the console may be lost on a long run: the table is kept
console.log('\n' + lines.join('\n'));
process.exit(0);
