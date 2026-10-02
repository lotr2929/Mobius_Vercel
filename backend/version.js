// version.js — "Last updated" stamp shown under the header.
//   Local:  the newest modification time of any app file, so it moves with every edit.
//   Vercel: the time at the start of the deploy commit message. deploy.bat writes
//           messages like "2Oct26 1:30pm - [3] server.js, ...".
import fs from 'fs';
import path from 'path';
import { ROOT, IS_VERCEL } from './config.js';

const WATCH = ['backend', 'frontend', 'supabase', 'package.json', 'vercel.json'];
const SKIP = new Set(['node_modules', '.git', '.vercel', '_dev']);

function newestMtime(p) {
  let st;
  try { st = fs.statSync(p); } catch { return 0; }
  if (!st.isDirectory()) return st.mtimeMs;
  let newest = 0;
  for (const name of fs.readdirSync(p)) {
    if (!SKIP.has(name)) newest = Math.max(newest, newestMtime(path.join(p, name)));
  }
  return newest;
}

// → "2 Oct 26 1:30pm", in Perth time
function perthStamp(date) {
  const f = Object.fromEntries(new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Perth', day: 'numeric', month: 'short', year: '2-digit',
    hour: 'numeric', minute: '2-digit', hour12: true,
  }).formatToParts(date).map(p => [p.type, p.value]));
  return `${f.day} ${f.month} ${f.year} ${f.hour}:${f.minute}${String(f.dayPeriod).toLowerCase()}`;
}

export function lastUpdated() {
  if (IS_VERCEL) {
    const m = (process.env.VERCEL_GIT_COMMIT_MESSAGE || '').match(/^(\d{1,2})([A-Za-z]{3})(\d{2}) (\d{1,2}:\d{2}(?:am|pm))/i);
    return m ? `${m[1]} ${m[2]} ${m[3]} ${m[4].toLowerCase()}` : null;
  }
  const t = Math.max(...WATCH.map(w => newestMtime(path.join(ROOT, w))));
  return t ? perthStamp(new Date(t)) : null;
}
