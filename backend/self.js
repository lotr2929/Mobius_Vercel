// self.js — what Mobius knows about itself: when and where it is, what it runs on, how it works.
//   describeContext()  always on: date, time and place for the system prompt
//   selfReport()       on demand (when Boon asks about Mobius itself): the manual, the device
//                      he is using, the server it runs on, live memory figures
import os from 'os';
import { PORT, IS_VERCEL, START_TIME, RECENT_MESSAGES, WEEK_DAYS, PROJECT_DORMANT_DAYS } from './config.js';
import { supabase } from './db.js';
import { providerStatus } from './ai/cascade.js';
import { listActive, getActive, getProposed, getState } from './pcm/memory.js';
import { lastUpdated } from './version.js';
import { nowIn, validTimeZone } from './util.js';

const clean = (s, n = 80) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, n);

// ── Where and when ───────────────────────────────────────────────────────────
// Vercel adds the caller's approximate location to every request.
export function geoFromHeaders(headers) {
  const h = k => { try { return clean(decodeURIComponent(headers[k] || ''), 60); } catch { return ''; } };
  const g = { city: h('x-vercel-ip-city'), region: h('x-vercel-ip-country-region'), country: h('x-vercel-ip-country'), tz: h('x-vercel-ip-timezone') };
  return g.city || g.country ? g : null;
}

// → { tz, now, where }. The device's own time zone wins; then the IP's; then Perth.
export function describeContext(client, geo) {
  const tz = [client?.tz, geo?.tz, 'Australia/Perth'].find(validTimeZone);
  const where = geo?.city
    ? `${[geo.city, geo.region, geo.country].filter(Boolean).join(', ')} (approximate, from the connection's IP address; it can be wrong on mobile data)`
    : `${tz.split('/').pop().replace(/_/g, ' ')} (from the device's time zone)`;
  return { tz, now: nowIn(tz), where };
}

// ── The device Boon is using (reported by his browser) ──────────────────────
function deviceSummary(c) {
  if (!c || typeof c !== 'object') return 'his browser did not report any device details';
  const platform = clean(c.platform, 30);
  const pv = clean(c.platformVersion, 20);
  const os_ = /windows/i.test(platform) && pv ? `Windows ${parseInt(pv, 10) >= 13 ? 11 : 10} (platform version ${pv})` : [platform, pv].filter(Boolean).join(' ');
  const parts = [
    `${c.mobile ? 'phone or tablet' : 'computer'}${c.model ? ` (${clean(c.model, 40)})` : ''}`,
    os_ && `OS ${os_}`,
    c.browser && `browser ${clean(c.browser, 60)}`,
    c.arch && `CPU architecture ${clean(c.arch, 12)}${c.bitness ? `, ${clean(c.bitness, 4)}-bit` : ''}`,
    c.cores && `${Number(c.cores)} logical CPU cores`,
    c.memoryGB && `about ${Number(c.memoryGB)} GB RAM (the browser rounds this and caps it at 8)`,
    c.screen && `screen ${clean(c.screen, 20)} at ${Number(c.dpr) || 1}x pixel density, window ${clean(c.viewport, 20)}`,
    `${c.touch ? 'touch screen' : 'no touch screen'}`,
    c.standalone ? 'running as the installed app' : 'running in a browser tab',
    c.online === false ? 'offline' : 'online',
    c.connection && `network ${[c.connection.type, c.connection.effectiveType, c.connection.downlink && `about ${Number(c.connection.downlink)} Mbps`, c.connection.rtt && `${Number(c.connection.rtt)} ms round trip`].filter(Boolean).map(x => clean(x, 24)).join(', ')}`,
    c.battery && `battery ${Number(c.battery.level)}%${c.battery.charging ? ' and charging' : ''}`,
    c.locale && `language ${clean(c.locale, 12)}`,
  ];
  return parts.filter(Boolean).join('; ');
}

// ── The server this code is running on ───────────────────────────────────────
function serverSummary() {
  if (IS_VERCEL) {
    const sha = (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7);
    return `a Vercel serverless function (region ${process.env.VERCEL_REGION || 'unknown'}), Node ${process.version}, ${os.arch()}${sha ? `, commit ${sha}` : ''}. It has no disk of its own that persists; everything lives in Supabase.`;
  }
  const cpus = os.cpus();
  const gb = n => (n / 2 ** 30).toFixed(1);
  return `Boon's own PC (${os.type()} ${os.release()}, ${os.arch()}): ${cpus[0]?.model?.trim() || 'unknown CPU'}, ${cpus.length} logical cores, ${gb(os.totalmem())} GB RAM (${gb(os.freemem())} GB free), Node ${process.version}, serving on port ${PORT}; this server process has been up ${Math.round((Date.now() - START_TIME) / 3600000 * 10) / 10} hours.`;
}

// ── Live memory figures (also used by /api/pcm/status) ───────────────────────
export async function memoryStats() {
  if (!supabase) return null;
  const count = async (table, narrow = q => q) => {
    const { count: n, error } = await narrow(supabase.from(table).select('id', { count: 'exact', head: true }));
    return error ? null : n;
  };
  return {
    messages:  { total: await count('mobius_messages'), unembedded: await count('mobius_messages', q => q.is('embedding', null)) },
    docChunks: { total: await count('mobius_docs'),     unembedded: await count('mobius_docs',     q => q.is('embedding', null)) },
    profile:   { active: !!(await getActive('profile')), proposed: !!(await getProposed('profile')) },
    weekDigest: !!(await getActive('week')),
    projects:  (await listActive('project')).map(p => p.key),
    lastMaintenance: await getState('last_maintenance'),
  };
}

// ── The manual ───────────────────────────────────────────────────────────────
const MANUAL = `# About Mobius (your own documentation)

Mobius is Boon Lay Ong's personal AI assistant: a chat app (an installable PWA) with persistent memory and live web search. Its one purpose is to give him a single AI to talk to that remembers, can search the web, and can recall every document he uploads. It is a conversation partner, not an agent: it cannot run tasks on his computer, see his screen, or open files he has not uploaded. Boon built it with Claude as his coding assistant; it was rewritten from scratch in October 2026.

## Where it runs
- Live at mobius-pwa.vercel.app (Vercel). The live site asks for a passkey login: fingerprint on his phone, Windows Hello PIN on his laptop.
- The same code also runs on Boon's PC at localhost:3005, with no login.
- Both use the same Supabase database, so the memory is shared.

## The models
You are one of four free cloud models tried in order for each answer: Gemini 2.5 Flash, then Mistral Small, Cerebras gpt-oss-120b and Groq gpt-oss-120b. If one fails or is rate-limited, the next one answers, and a model that has just failed is skipped for a while (a minute after a rate limit, hours after "payment required" or "model not found"). Boon can force one by starting a message with "Ask: Mistral" (or Gemini, Cerebras, Groq). Models are stateless: they remember nothing between messages. Everything you know about Boon and past conversations comes from what Mobius puts in front of you each time.

## Memory (PCM, Persistent Contextual Memory), stored in Supabase
1. Immediate: the last ${RECENT_MESSAGES} messages arrive verbatim, plus a rolling digest of the past ${WEEK_DAYS} days.
2. Personal: a profile of who Boon is, carried in your system prompt. A weekly update is only proposed; Boon approves it.
3. Current: one note per project active in the last ${PROJECT_DORMANT_DAYS} days.
4. Archive: every message and every document, searched by meaning (Gemini embeddings) and by keyword together.
Memory is imperfect: summaries can be stale or wrong. If something Boon mentions is not in your context, say so rather than guess.

## How each message is handled
1. A fast model analyses the message: it rewrites it as a standalone question, picks relevant projects, and decides whether the archive is needed.
2. Mobius recalls from the tiers, searches the web (Tavily) for any non-trivial message, and checks whether a stored document is named.
3. It assembles a size-limited "Memory context" and sends it with the message; for small-context models it is trimmed.
4. The answer streams back and both messages are saved. Embeddings and summaries are filled in afterwards by background jobs, which run every six hours when Boon's PC is running and once a day on Vercel.

## Documents
Uploaded files (PDF, DOCX, text, Markdown) and the Google Drive "Mobius" folder are stored whole and as searchable chunks. A file attached to a message is given to you in full.

## Limits
Free-tier quotas (Gemini embeddings, Tavily searches, model rate limits) can run out; Mobius then falls back to keyword search or the next model. Your training data is out of date, so rely on the date above and on web results for anything recent. You do not know your own exact version beyond what is stated here.`;

// The report handed to the model when Boon asks about Mobius itself.
export async function selfReport(client, geo, ctx) {
  const stats = await memoryStats().catch(() => null);
  const live = [
    '## Right now',
    `- Date and time: ${ctx.now}`,
    `- Approximate location: ${ctx.where}`,
    `- This request was served by: ${serverSummary()}`,
    `- The device Boon is using: ${deviceSummary(client)}`,
    `- App: last updated ${lastUpdated() || 'unknown'}`,
    `- Models right now: ${providerStatus().join('; ')}`,
    stats && `- Memory: ${stats.messages.total} messages (${stats.messages.unembedded} not yet embedded), ${stats.docChunks.total} document chunks (${stats.docChunks.unembedded} not yet embedded); personal profile ${stats.profile.active ? 'set' : 'not set'}${stats.profile.proposed ? ' (a new proposal is waiting for approval)' : ''}; week digest ${stats.weekDigest ? 'present' : 'not built yet'}; current projects: ${stats.projects.join('; ') || 'none'}; last maintenance run ${stats.lastMaintenance || 'never'}`,
  ];
  return `${MANUAL}\n\n${live.filter(Boolean).join('\n')}`;
}
