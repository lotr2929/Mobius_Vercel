// bench-cli.mjs — the model bench: which models are the most reliable for each of Mobius's jobs?
//   npm run bench -- --list                          show what would run, and roughly what it would cost, without calling anything
//   npm run bench -- --runs=2 --until=17:00          today's batch, every model, two passes, stopping at 5 pm (carries on where it stopped)
//   npm run bench -- --models=gptoss,gemini3p --tasks=facts,prayers
//   npm run bench -- --report                        rewrite report.md and stable-proposal.json from what has been recorded
//   npm run bench -- --trend                         role scores batch by batch, to see a model slipping or improving
//   npm run bench -- --daemon                        once a day, in the small hours, one quick pass of everything (not installed anywhere yet)
// Results: _dev/bench/<batch>/ (results.jsonl one line per answer, progress.json, report.md, stable-proposal.json). Stop a run early by
// creating a file named STOP in the batch folder. The bench never edits models.js: it proposes, Boon (or Claude with him) decides.
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { MODELS, orderFor } from './ai/models.js';
import { KEYS } from './config.js';
import { plan, runBatch, report, defaultModels, rolesOf, summarise, BENCH_ROOT } from './bench/runner.mjs';
import { TASKS } from './bench/tasks.mjs';

const flag = n => process.argv.includes(`--${n}`);
const arg = (n, d = '') => (process.argv.find(a => a.startsWith(`--${n}=`)) || '').slice(n.length + 3) || d;
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const batch = arg('batch', `bench-${today()}`);
const models = arg('models') ? arg('models').split(',').filter(Boolean) : defaultModels();
const tasks = arg('tasks') ? arg('tasks').split(',').filter(Boolean) : undefined;
const runs = Math.max(1, Number(arg('runs', '1')) || 1);
const untilAt = hhmm => { if (!hhmm) return null; const [h, m] = hhmm.split(':').map(Number); const d = new Date(); d.setHours(h, m || 0, 0, 0); if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1); return d.getTime(); };
const opts = { models, tasks, runs, personal: !flag('no-personal'), allProviders: flag('all-providers'), explicit: !!arg('models') };

if (flag('list')) {
  const jobs = plan(opts);
  const by = {};
  for (const j of jobs) { const b = (by[j.key] ||= { calls: 0, tokens: 0 }); b.calls++; b.tokens += j.est; }
  console.log(`${jobs.length} calls planned for ${Object.keys(by).length} models (${runs} run${runs > 1 ? 's' : ''}), batch ${batch}\n`);
  for (const [k, b] of Object.entries(by)) console.log(`  ${k.padEnd(11)} ${String(b.calls).padStart(4)} calls  about ${Math.round(b.tokens / 1000)}k tokens   roles: ${rolesOf(MODELS.find(m => m.key === k), opts.explicit).join(', ')}`);
  console.log(`\nItems per task: ${TASKS.map(t => `${t.id} ${t.items.length}`).join(', ')}`);
  console.log('Flagship Gemini models are held to 8 calls each (their free allowance is 20 a day); Groq models to about 110k tokens; see BUDGET in bench/runner.mjs.');
  process.exit(0);
}

if (flag('trend')) {
  if (!existsSync(BENCH_ROOT)) { console.log('no batches yet'); process.exit(0); }
  const dirs = readdirSync(BENCH_ROOT).filter(d => existsSync(new URL(`${d}/results.jsonl`, BENCH_ROOT))).sort();
  const table = {};
  for (const d of dirs) for (const s of summarise(new URL(`${d}/results.jsonl`, BENCH_ROOT))) for (const [role, r] of Object.entries(s.roles)) ((table[`${s.key}/${role}`] ||= {})[d] = Math.round(r.score * 100));
  console.log(`model/role`.padEnd(22) + dirs.map(d => d.replace('bench-', '').slice(-5).padStart(7)).join(''));
  for (const [k, v] of Object.entries(table).sort()) console.log(k.padEnd(22) + dirs.map(d => String(v[d] ?? '–').padStart(7)).join(''));
  process.exit(0);
}

if (flag('report')) { console.log(report(batch).text); process.exit(0); }

if (flag('daemon')) {
  const startHour = Number(arg('at', '2'));
  const done = new Set();
  console.log(`bench daemon: one quick pass a day from ${startHour}:00, until six hours later`);
  for (;;) {
    const d = new Date(), name = `daily-${today()}`;
    if (d.getHours() >= startHour && !done.has(name)) {
      try { await runBatch({ batch: name, models: defaultModels(), runs: 1, until: Date.now() + 6 * 3600e3, personal: true, allProviders: false }); report(name); } catch (e) { console.log('daily bench failed:', e.message); }
      done.add(name);
    }
    await new Promise(r => setTimeout(r, 30 * 60e3));
  }
}

const until = untilAt(arg('until'));
const res = await runBatch({ batch, ...opts, until });
const r = report(batch);
console.log('\n' + r.text);
console.log(`\nFull texts and every mark: _dev/bench/${batch}/results.jsonl   report: _dev/bench/${batch}/report.md   ${res.left ? `(${res.left} items not run: start again with the same --batch to carry on)` : '(finished)'}`);
process.exit(0);
