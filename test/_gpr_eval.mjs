process.chdir('C:\\_Personal\\_Mobius\\Mobius');
const fs = await import('node:fs');
const { chatTurn } = await import('file:///C:/_Personal/_Mobius/Mobius/backend/chat.js');
const P = 'my 2002 paper "Green plot ratio: an ecological measure for architecture and urban planning"';
const Q = [
  { id: 'Q1', q: `How does ${P} define the green plot ratio, and what is it based on?`, need: [/average/i, /LAI|leaf area index/i] },
  { id: 'Q2', q: `In ${P}, what leaf area index does the paper suggest for turf or grass, and what for densely wooded landscapes with trees?`, need: [/\b1\b/, /\b6\b/, /grass|turf/i] },
  { id: 'Q3', q: `Which law does ${P} give as the basis for estimating LAI from canopy transmittance?`, need: [/Beer.{0,3}Lambert/i] },
  { id: 'Q4', q: `In ${P}, what GPR did the individual buildings reach in the Liuxiancun ecocity entry, and what GPR was set for the conserved part of the site?`, need: [/2\s*:\s*1|\b2\b/, /6\s*:\s*1|\b6\b/] },
  { id: 'Q5', q: `What percentage of the Liuxiancun site was conserved and returned to nature, according to ${P}?`, need: [/60\s*(%|per ?cent)|sixty/i] },
  { id: 'Q6', q: `According to ${P}, what are the ways a suitable GPR may be determined, and which does the author prefer?`, need: [/three|3/i, /ecolog/i, /prefer/i] },
  { id: 'Q7', q: `What caveats does ${P} give about using GPR?`, need: [/species richness/i] },
  { id: 'Q8', q: `Who collaborated on the Liuxiancun entry described in ${P}?`, need: [/Foo/, /CESMA/, /Archurban/i] },
  { id: 'Q9', q: `What mean LAI does ${P} give for shrubs, from the Scurlock data?`, need: [/\b2\b/, /\b4\b/] },
  { id: 'T1', trap: true, q: `What does ${P} say about GPR becoming Singapore's national greenery planning standard in 2013?`, need: [/not|doesn.t|does not|no mention|predate|before|cannot|can.t/i], forbid: [] },
  { id: 'T2', trap: true, q: `What does ${P} say is the cost per square metre of installing green roofs in Singapore dollars?`, need: [/not|doesn.t|does not|no mention|nowhere|cannot|can.t|isn.t/i], forbid: [/S?\$\s?\d/] },
];
const results = [];
for (const t of Q) {
  const tokens = []; const events = []; const t0 = Date.now();
  try { for await (const ev of chatTurn({ query: t.q, dryRun: true })) { if (typeof ev.token === 'string') tokens.push(ev.token); if (ev.event) events.push(ev.event); } }
  catch (e) { tokens.push('ERROR ' + e.message); }
  const a = tokens.join('');
  const hits = t.need.map(r => r.test(a)); const bad = (t.forbid || []).filter(r => r.test(a)).length + (/No cloud drive is connected|Drive lookup/.test(a) ? 1 : 0);
  const model = (events.find(e => e.startsWith('model:')) || '').slice(6);
  const namesFile = /Green plot ratio|2002|the paper|Ong/i.test(a);
  results.push({ id: t.id, trap: !!t.trap, ok: hits.every(Boolean) && !bad, hits, bad, model, secs: Math.round((Date.now() - t0) / 1000), namesFile, answer: a });
  console.log(`\n=== ${t.id} ${hits.every(Boolean) && !bad ? 'KEY FACTS FOUND' : 'CHECK'}  (${model}, ${Math.round((Date.now() - t0) / 1000)} s)\nQ: ${t.q.slice(0, 150)}\nA: ${a.replace(/\s+/g, ' ').slice(0, 650)}`);
  await new Promise(r => setTimeout(r, 4000));
}
fs.writeFileSync('C:\\Temp\\gpr_eval.json', JSON.stringify(results, null, 1), 'utf8');
const real = results.filter(r => !r.trap), traps = results.filter(r => r.trap);
console.log(`\nSUMMARY: key facts found in ${real.filter(r => r.ok).length} of ${real.length} questions; trap questions handled in ${traps.filter(r => r.ok).length} of ${traps.length}`);
process.exit(0);
