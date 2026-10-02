// models-cli.mjs — check the model stack against what each provider offers right now.
//   npm run models            list check: is every registered model still listed? any new ones?
//   npm run models -- --probe also make one tiny live call per model (uses a little free quota)
import { auditModels, probeModels } from './ai/audit.js';
import { MODELS } from './ai/models.js';

const report = await auditModels();
console.log('Providers:', JSON.stringify(report.providers));
console.log('Retired (no longer listed):', report.retired.length ? report.retired.join(', ') : 'none');
for (const [p, ids] of Object.entries(report.candidates)) console.log(`Unregistered ${p} models worth a look:`, ids.length ? ids.join(', ') : 'none');

if (process.argv.includes('--probe')) {
  console.log('\nLive probe:');
  for (const r of await probeModels()) {
    const m = MODELS.find(x => x.key === r.key);
    console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${m.name.padEnd(28)} ${String(r.ms ?? '').padStart(6)} ms  ${r.note}`);
  }
}
process.exit(0);
