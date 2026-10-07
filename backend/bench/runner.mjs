// backend/bench/runner.mjs — runs the bench unattended, politely, and in a way that can be stopped and carried on.
//
//  - One worker per provider, each keeping to the provider's free limits (a gap between calls, a tokens-a-minute budget per model).
//  - A refused call is told apart from a broken one: quota (try again in a minute), daily allowance spent (the model is left for today),
//    overload (try again later), timeout, and real errors. Only the real errors count against a model's reliability.
//  - Every result is written to results.jsonl the moment it arrives, so a shutdown loses at most the call in flight. Run again with the
//    same batch name and finished items are skipped; items that were only refused are tried again.
//  - Jobs are ordered run by run (every model's first pass, then every model's second), so stopping at any time leaves balanced data.
//  - Stops at --until, or when a file named STOP appears in the batch folder.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { MODELS, modelByKey, orderFor } from '../ai/models.js';
import { runCascade } from '../ai/cascade.js';
import { UTILITY_PROMPT } from '../ai/prompt.js';
import { chatTurn } from '../chat.js';
import { getMessages } from '../pcm/messages.js';
import { extractRefs } from '../bible.js';
import { supabase } from '../db.js';
import { KEYS } from '../config.js';
import { TASKS, LIGHT_SYSTEM, REAL_SYSTEM } from './tasks.mjs';

export const BENCH_ROOT = new URL('../../_dev/bench/', import.meta.url);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

// Providers Boon already sends his own notes and profile to. NVIDIA's trial terms forbid personal data and Mistral's free mode trains
// on prompts, so they are tried only on the made-up items unless --all-providers is given.
const PERSONAL_OK = new Set(['gemini', 'groq']);
// A gap between two calls to one provider (ms), and the tokens a minute we allow ourselves per model, under the free limits seen
const GAP = { gemini: 3500, groq: 6000, nvidia: 2500, mistral: 3000 };
const TPM = { gptoss: 6500, gptoss20: 6500, qwen: 5500, gemma26: 9000, gemma31: 9000 };
// What the bench may spend of a model's free allowance in one batch, so that Boon still has the rest for his own chat
// (flagship Gemini models allow 20 requests a day each; Groq's gpt-oss-120b 200,000 tokens a day)
const FLAGSHIP = new Set(['gemini', 'gemini37', 'gemini36', 'gemini35']);
const BUDGET = key => ({ requests: FLAGSHIP.has(key) ? 8 : modelByKey(key)?.provider === 'gemini' ? 90 : 400, tokens: modelByKey(key)?.provider === 'groq' ? 110000 : Infinity });

const estTokens = item => {
  if (item.kind === 'pipeline') return 6500;
  const sys = item.system === 'utility' ? 600 : item.system === 'real' ? REAL_SYSTEM.length : LIGHT_SYSTEM.length;
  const body = item.build ? item.build(10000)[0].content.length : item.messages.reduce((n, m) => n + m.content.length, 0);
  return Math.ceil((sys + body) / 3.6) + 500;
};

export const rolesOf = (m, explicit) => { const r = ['chat', 'quick', 'learn', 'deep'].filter(x => m.rank?.[x] != null); return r.length ? r : explicit ? ['chat'] : []; };
export const defaultModels = () => MODELS.filter(m => KEYS[m.provider] && rolesOf(m).length).map(m => m.key);

export function plan({ models, tasks = TASKS.map(t => t.id), runs = 1, personal = true, allProviders = false, explicit = false }) {
  const jobs = [];
  for (let run = 1; run <= runs; run++) for (const task of TASKS.filter(t => tasks.includes(t.id))) for (const item of task.items) for (const key of models) {
    const m = modelByKey(key);
    if (!m || !KEYS[m.provider]) continue;
    if (!task.roles.some(r => rolesOf(m, explicit).includes(r))) continue;
    const area = item.area || task.area;
    if (area === 'personal' && (!personal || (!allProviders && !PERSONAL_OK.has(m.provider)))) continue;
    jobs.push({ id: `${key}|${task.id}|${item.id}|${run}`, key, provider: m.provider, task: task.id, item, run, attempts: 0, est: estTokens(item) });
  }
  return jobs;
}

// ── one call ─────────────────────────────────────────────────────────────────
function classify(text, ev) {
  if (text.trim()) return 'ok';
  const e = ev || '';
  if (/\[daily\]|PerDay/i.test(e)) return 'daily';
  if (/HTTP 429|quota|rate limit|PerMinute|TokensPerMinute/i.test(e)) return 'quota';
  if (/HTTP 50[0-9]|overload|high demand|UNAVAILABLE/i.test(e)) return 'overload';
  if (/no first token|timed out|abort/i.test(e)) return 'timeout';
  if (/not-configured|no-private/.test(e)) return 'unavailable';
  return 'error';
}

async function call(job) {
  const m = modelByKey(job.key), item = job.item, t0 = Date.now();
  let text = '', first = null, ev = '';
  const signal = AbortSignal.timeout(180000);
  try {
    const stream = item.kind === 'pipeline'
      ? chatTurn({ query: `Ask: ${m.key} ${item.prompt}`, dryRun: true, signal })
      : runCascade(item.build ? item.build(1e9) : item.messages, { signal, system: item.system === 'utility' ? UTILITY_PROMPT : item.system === 'real' ? REAL_SYSTEM : LIGHT_SYSTEM, only: m.key, rebuild: item.build || null });
    for await (const t of stream) {
      const tok = typeof t === 'string' ? t : t.token;
      if (typeof tok === 'string') { if (first === null) first = Date.now() - t0; text += tok; }
      else if (t.event && /^(fallback:|error:)/.test(t.event)) ev = t.event;
    }
  } catch (e) { ev = `error: ${e.message}`; }
  return { text, first, secs: Math.round((Date.now() - t0) / 100) / 10, outcome: classify(text, ev), ev: ev.slice(0, 160) };
}

async function personalContext() {
  const cache = new URL('../../_dev/compare/bible-cache.json', import.meta.url);
  const norm = s => String(s).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  let chapters;
  if (existsSync(cache)) chapters = JSON.parse(readFileSync(cache, 'utf8'));
  else {
    const by = {};
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase.from('mobius_bible').select('translation, book, chapter, verse, text').order('translation').order('book').order('chapter').order('verse').range(from, from + 999);
      if (error) throw new Error('bible: ' + error.message);
      for (const r of data) (by[`${r.translation}/${r.book}/${r.chapter}`] ||= []).push(norm(r.text));
      if (data.length < 1000) break;
    }
    chapters = Object.values(by).map(v => v.join(' '));
    mkdirSync(new URL('../../_dev/compare/', import.meta.url), { recursive: true });
    writeFileSync(cache, JSON.stringify(chapters));
  }
  const used = new Set();
  for (const m of await getMessages(80)) if (m.role === 'assistant' && /\b(?:Lord|Father)\b/.test(m.content) && /\bpray/i.test(m.content)) for (const r of extractRefs(m.content, {})) used.add(r.label);
  return { chapters, used };
}

// ── the batch ────────────────────────────────────────────────────────────────
export function readLedger(file) {
  const last = new Map();
  if (existsSync(file)) for (const line of readFileSync(file, 'utf8').split('\n')) { if (!line.trim()) continue; try { const r = JSON.parse(line); last.set(r.id, r); } catch { /* a torn last line */ } }
  return last;
}

export async function runBatch({ batch, models = defaultModels(), tasks, runs = 1, until = null, personal = true, allProviders = false, explicit = false, say = console.log }) {
  const dir = new URL(`${batch}/`, BENCH_ROOT);
  mkdirSync(dir, { recursive: true });
  const file = new URL('results.jsonl', dir), ledger = readLedger(file);
  const all = plan({ models, tasks, runs, personal, allProviders, explicit });
  const todo = all.filter(j => { const r = ledger.get(j.id); return !r || !['ok', 'error'].includes(r.outcome); });
  for (const j of todo) j.attempts = 0;
  say(`batch ${batch}: ${all.length} items planned, ${all.length - todo.length} already done, ${todo.length} to run, until ${until ? new Date(until).toLocaleTimeString() : 'finished'}`);
  const pctx = todo.some(j => j.item.kind === 'pipeline') ? await personalContext() : null;

  const spent = {}; // model -> { requests, tokens } in this batch, counting earlier sessions of it
  for (const r of ledger.values()) { const s = (spent[r.model] ||= { requests: 0, tokens: 0 }); s.requests += r.attempts || 1; s.tokens += r.tokens || 0; }
  const cool = {}, exhausted = new Map(), lastCall = {}, window = {}, progress = { started: new Date().toISOString(), done: 0, byOutcome: {}, exhausted: {}, left: todo.length };
  const stopping = () => (until && Date.now() > until) || existsSync(new URL('STOP', dir));

  const tpmWait = (key, est) => {
    const lim = TPM[key]; if (!lim) return 0;
    const now = Date.now(), w = (window[key] ||= []).filter(x => now - x.t < 60000); window[key] = w;
    let total = w.reduce((n, x) => n + x.n, 0);
    if (total + est <= lim) return 0;
    for (const x of w) { total -= x.n; if (total + est <= lim) return Math.max(0, x.t + 60000 - now) + 500; }
    return 61000;
  };
  const ready = j => {
    const now = Date.now(), k = j.key;
    if (exhausted.has(k)) return null;
    const b = BUDGET(k), s = spent[k] || { requests: 0, tokens: 0 };
    if (s.requests >= b.requests || s.tokens + j.est > b.tokens) { exhausted.set(k, 'budget for this batch used'); return null; }
    return Math.max(0, (cool[k] || 0) - now, (lastCall[j.provider] || 0) + GAP[j.provider] - now, tpmWait(k, j.est));
  };
  const flush = () => { progress.at = new Date().toISOString(); progress.left = todo.length; progress.exhausted = Object.fromEntries(exhausted); writeFileSync(new URL('progress.json', dir), JSON.stringify(progress, null, 1)); };

  async function worker(provider) {
    const queue = todo.filter(j => j.provider === provider);
    while (queue.length && !stopping()) {
      let pick = -1, soonest = Infinity;
      for (let i = 0; i < queue.length; i++) { const w = ready(queue[i]); if (w === null) continue; if (w === 0) { pick = i; break; } soonest = Math.min(soonest, w); }
      if (pick < 0) { if (soonest === Infinity) break; await sleep(Math.min(soonest + 200, 30000)); continue; }
      const job = queue.splice(pick, 1)[0], k = job.key;
      lastCall[provider] = Date.now();
      (window[k] ||= []).push({ t: Date.now(), n: job.est });
      const s = (spent[k] ||= { requests: 0, tokens: 0 }); s.requests++; s.tokens += job.est;
      job.attempts++;
      const res = await call(job);
      lastCall[provider] = Date.now();
      let scored = null;
      if (res.outcome === 'ok') { try { scored = job.item.score(res.text, pctx); } catch (e) { scored = { score: 0, checks: { markerError: false }, note: e.message }; } }
      if (['quota', 'overload', 'timeout', 'error'].includes(res.outcome) && job.attempts < 3) {
        cool[k] = Date.now() + ({ quota: 65000, overload: 90000 * job.attempts, timeout: 20000, error: 15000 })[res.outcome];
        queue.push(job); // later, after the others
        continue;
      }
      if (res.outcome === 'daily') exhausted.set(k, `daily allowance spent (${res.ev})`);
      const rec = { id: job.id, batch, model: k, task: job.task, item: job.item.id, run: job.run, outcome: res.outcome, attempts: job.attempts, score: scored?.score ?? null, checks: scored?.checks ?? null, quotes: scored?.quotes ?? null, secs: res.secs, firstMs: res.first, tokens: job.est, note: res.outcome === 'ok' ? null : res.ev, text: res.text.slice(0, 6000), at: new Date().toISOString() };
      appendFileSync(file, JSON.stringify(rec) + '\n');
      progress.done++; progress.byOutcome[res.outcome] = (progress.byOutcome[res.outcome] || 0) + 1;
      const idx = todo.indexOf(job); if (idx >= 0) todo.splice(idx, 1);
      flush();
      say(`${new Date().toLocaleTimeString()}  ${k.padEnd(10)} ${job.task}/${job.item.id}#${job.run}  ${res.outcome}${scored ? ` ${scored.score.toFixed(2)}` : ''}  ${res.secs}s${res.outcome !== 'ok' ? '  ' + res.ev : ''}`);
    }
  }
  await Promise.all([...new Set(todo.map(j => j.provider))].map(worker));
  flush();
  say(`batch ${batch}: stopped with ${todo.length} items not run${exhausted.size ? '; left alone: ' + [...exhausted].map(([k, why]) => `${k} (${why})`).join(', ') : ''}`);
  return { dir, left: todo.length, exhausted: Object.fromEntries(exhausted) };
}

// ── the report ───────────────────────────────────────────────────────────────
const ROLES = ['chat', 'quick', 'learn', 'deep'];
export function summarise(file) {
  const rows = [...readLedger(file).values()];
  const models = {};
  for (const r of rows) {
    const m = (models[r.model] ||= { key: r.model, outcomes: {}, items: {}, secs: [], first: [] });
    m.outcomes[r.outcome] = (m.outcomes[r.outcome] || 0) + 1;
    if (r.outcome === 'ok') { (m.items[`${r.task}/${r.item}`] ||= []).push(r.score); m.secs.push(r.secs); if (r.firstMs != null) m.first.push(r.firstMs / 1000); }
  }
  const out = [];
  for (const m of Object.values(models)) {
    const tasks = {};
    for (const t of TASKS) { const its = t.items.map(i => m.items[`${t.id}/${i.id}`]).filter(Boolean); if (its.length) tasks[t.id] = { score: mean(its.map(mean)), items: its.length, of: t.items.length, runs: Math.max(...its.map(a => a.length)), spread: mean(its.filter(a => a.length > 1).map(a => Math.max(...a) - Math.min(...a))) }; }
    const roles = {};
    for (const role of ROLES) {
      const ts = TASKS.filter(t => t.roles.includes(role) && tasks[t.id]);
      const all = TASKS.filter(t => t.roles.includes(role));
      if (!ts.length) continue;
      const w = ts.reduce((n, t) => n + t.weight, 0);
      roles[role] = { score: ts.reduce((n, t) => n + tasks[t.id].score * t.weight, 0) / w, coverage: ts.reduce((n, t) => n + tasks[t.id].items, 0) / all.reduce((n, t) => n + t.items.length, 0), runs: Math.min(...ts.map(t => tasks[t.id].runs)) };
    }
    const o = m.outcomes, ok = o.ok || 0;
    out.push({ key: m.key, tasks, roles, calls: ok + (o.error || 0) + (o.timeout || 0) + (o.overload || 0) + (o.quota || 0) + (o.daily || 0), reliability: ok / Math.max(1, ok + (o.error || 0) + (o.timeout || 0)), overload: (o.overload || 0) / Math.max(1, ok + (o.overload || 0)), refused: (o.quota || 0) + (o.daily || 0), secs: median(m.secs), first: median(m.first), outcomes: o });
  }
  return out;
}

export function report(batch) {
  const dir = new URL(`${batch}/`, BENCH_ROOT), file = new URL('results.jsonl', dir);
  const sums = summarise(file);
  const pct = x => (x == null ? '–' : `${Math.round(x * 100)}`);
  const L = [`# Model bench — ${batch}`, '', `Scored by plain code against what each answer must contain or must not do; no model judges a model. It cannot see depth, warmth or style beyond that: read the full texts in results.jsonl before trusting a close call. A score is out of 100. "cover" is the share of the role's items answered; "runs" the repeats; "spread" how far one item's score moved between repeats (large = luck matters). Reliability counts real errors and timeouts only; a refusal for quota or overload is shown separately because it says nothing about the answer.`, ''];
  const proposal = {};
  for (const role of ROLES) {
    const have = sums.filter(s => s.roles[role]).sort((a, b) => b.roles[role].score - a.roles[role].score || b.reliability - a.reliability);
    if (!have.length) continue;
    L.push(`## ${role}`, '', '| model | score | cover | runs | reliability | refused | overloaded | median s | first token s |', '|---|---|---|---|---|---|---|---|---|');
    for (const s of have) L.push(`| ${s.key} | ${pct(s.roles[role].score)} | ${pct(s.roles[role].coverage)}% | ${s.roles[role].runs} | ${pct(s.reliability)}% | ${s.refused} | ${pct(s.overload)}% | ${s.secs ?? '–'} | ${s.first ?? '–'} |`);
    const sure = have.filter(s => s.roles[role].coverage >= 0.6 && s.reliability >= 0.8);
    proposal[role] = { order: sure.map(s => s.key), provisional: sure.some(s => s.roles[role].runs < 3 || s.roles[role].coverage < 0.8), current: orderFor(role) };
    L.push('', `Proposed order from this batch: ${sure.map(s => s.key).join(' > ') || '(none sure enough)'}${proposal[role].provisional ? ' — provisional (fewer than 3 runs, or part of the bench unanswered)' : ''}`, `Current order in models.js: ${proposal[role].current.join(' > ')}`, '');
  }
  L.push('## By task (chat items; score out of 100)', '', `| model | ${TASKS.map(t => t.id).join(' | ')} |`, `|---|${TASKS.map(() => '---').join('|')}|`);
  for (const s of sums) L.push(`| ${s.key} | ${TASKS.map(t => (s.tasks[t.id] ? pct(s.tasks[t.id].score) : '–')).join(' | ')} |`);
  const noData = sums.filter(s => !Object.keys(s.roles).length);
  if (noData.length) L.push('', '## Not tested', '', ...noData.map(s => `- ${s.key}: ${JSON.stringify(s.outcomes)}`));
  writeFileSync(new URL('report.md', dir), L.join('\n'));
  writeFileSync(new URL('stable-proposal.json', dir), JSON.stringify(proposal, null, 1));
  return { text: L.join('\n'), proposal };
}
