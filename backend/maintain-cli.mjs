// maintain-cli.mjs — run the memory jobs by hand, without a time limit.
//   npm run maintain            week digest, projects, profile proposal, embed the whole backlog
//   npm run maintain -- --drive also sync the Google Drive folder first
import { runMaintenance } from './pcm/maintain.js';
import { syncDrive, driveConfigured } from './docs/drive.js';

if (process.argv.includes('--drive')) {
  if (driveConfigured()) console.log('drive:', JSON.stringify(await syncDrive()));
  else console.log('drive: not configured, skipped');
}

console.log(JSON.stringify(await runMaintenance({ cli: true }), null, 2));
process.exit(0);
