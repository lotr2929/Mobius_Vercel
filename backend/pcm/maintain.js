// pcm/maintain.js — the jobs that keep the memory tiers current. All are incremental
// (each remembers a cursor in mobius_state), so an interrupted run loses nothing.
//   models    the model stack: is every registered model still offered? any new ones?
//   week      tier 1  rolling digest of the past seven days
//   projects  tier 3  one note per current project, updated from new messages
//   profile   tier 2  weekly *proposal* for the personal profile; Boon approves it
//   embed     tier 4  embed messages and document chunks saved without a vector
import { supabase } from '../db.js';
import { RECENT_MESSAGES, WEEK_DAYS, PROJECT_DORMANT_DAYS } from '../config.js';
import { askModel } from '../ai/cascade.js';
import { auditModels } from '../ai/audit.js';
import { embedQuery, embedPatient } from './embed.js';
import { getActive, getProposed, listActive, put, retireStale, getState, setState } from './memory.js';
import { clip, isoDaysAgo, parseJson } from '../util.js';

const PAGE = 300;          // rows fetched per step
const BATCH_CHARS = 18000; // conversation text handed to the model per step

const today = () => new Date().toISOString().slice(0, 10);
const flat = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const stamp = m => m.created_at.slice(0, 16).replace('T', ' ');
const line = (m, n = 600) => `[${stamp(m)}] ${m.role}: ${flat(m.content, n)}`;

// Take rows from the front until the batch is full; report the last row's timestamp as the new cursor.
function takeBatch(rows, toLine) {
  const lines = [];
  let size = 0, upto = null;
  for (const m of rows) {
    const l = toLine(m);
    if (size + l.length > BATCH_CHARS) break;
    lines.push(l);
    size += l.length + 1;
    upto = m.created_at;
  }
  return { lines, upto };
}

async function messagesAfter(upto, role = null) {
  let q = supabase.from('mobius_messages').select('role, content, created_at')
    .gt('created_at', upto).order('created_at', { ascending: true }).limit(PAGE);
  if (role) q = q.eq('role', role);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data || [];
}

// ── Tier 1: rolling week digest ──────────────────────────────────────────────
async function refreshWeek() {
  const upto = (await getState('week_upto')) || isoDaysAgo(WEEK_DAYS);
  const data = await messagesAfter(upto);
  // The newest messages are sent verbatim anyway, so the digest leaves them out.
  const rows = data.length >= PAGE ? data : data.slice(0, Math.max(0, data.length - RECENT_MESSAGES));
  if (rows.length < 6) return { skipped: 'fewer than 6 new messages outside the recent window' };

  const { lines, upto: newUpto } = takeBatch(rows, line);
  const current = (await getActive('week'))?.content || '';
  const text = await askModel(`You maintain a rolling digest of Boon's last seven days of conversations with his personal AI assistant. Today is ${today()}.

Current digest:
${current || '(empty)'}

New conversation since the digest was last updated (oldest first):
${lines.join('\n')}

Merge the new material into the digest.
- Drop anything no longer relevant to the last seven days.
- Keep topics discussed, decisions made, questions left open, and things Boon said he will do. Skip small talk.
- Compact bullet points grouped by topic. At most 1,800 characters.
Reply with ONLY the updated digest.`, { role: 'deep', timeoutMs: 40000 });

  await put('week', 'main', { content: clip(text, 2200) });
  await setState('week_upto', newUpto);
  return { summarised: lines.length };
}

// ── Tier 3: current projects ─────────────────────────────────────────────────
async function refreshProjects(left) {
  const report = { batches: 0, updated: 0 };
  for (let i = 0; i < 3 && left() > 15000; i++) {
    const upto = (await getState('projects_upto')) || isoDaysAgo(PROJECT_DORMANT_DAYS);
    const { lines, upto: newUpto } = takeBatch(await messagesAfter(upto), m => line(m, 500));
    if (lines.length < 4) break;

    const current = await listActive('project');
    const notes = current.length
      ? current.map(p => `## ${p.key}\nKeywords: ${(p.keywords || []).join(', ')}\n${p.content}`).join('\n\n')
      : '(none yet)';
    const raw = await askModel(`You maintain notes on the projects Boon is currently working on, based on his conversations with his personal AI assistant. Today is ${today()}.

Current project notes:
${notes}

New conversation since the notes were last updated (oldest first):
${lines.join('\n')}

Return updates ONLY for projects these messages actually touch.
- A project is sustained work with a goal: a paper, an app, a dataset, a course, a grant. One-off questions and small talk are not projects.
- If a message concerns an existing project, reuse its exact name.
- "summary" is the complete updated note, merging old and new: goal, current status, decisions made, open items. 500 to 900 characters.
- "keywords" are 4 to 8 terms (names, tools, acronyms) likely to appear when the project is mentioned.
- If nothing qualifies, return {"updates": []}.

Reply with ONLY JSON: {"updates":[{"name":"...","keywords":["..."],"summary":"..."}]}`, { role: 'deep', timeoutMs: 45000 });

    const updates = parseJson(raw).updates;
    for (const u of Array.isArray(updates) ? updates : []) {
      const name = flat(u?.name, 80);
      const summary = String(u?.summary ?? '').trim();
      if (!name || summary.length < 40) continue;
      const keywords = (Array.isArray(u.keywords) ? u.keywords : []).map(k => flat(k, 40)).filter(Boolean).slice(0, 8);
      const existing = current.find(p => p.key.toLowerCase() === name.toLowerCase());
      await put('project', existing ? existing.key : name, { content: clip(summary, 1500), keywords });
      report.updated++;
    }
    await setState('projects_upto', newUpto);
    report.batches++;
  }
  await retireStale('project', PROJECT_DORMANT_DAYS);
  return report;
}

// ── Tier 2: personal profile (proposal only — never self-applies) ────────────
async function proposeProfile() {
  if (await getProposed('profile')) return { skipped: 'a proposal is waiting for approval' };
  const last = await getState('profile_last');
  if (last && Date.now() - Date.parse(last) < 7 * 864e5) return { skipped: 'already proposed within the last week' };

  const upto = (await getState('profile_upto')) || isoDaysAgo(30);
  const rows = await messagesAfter(upto, 'user');
  if (rows.length < 8) return { skipped: 'fewer than 8 new messages from Boon' };

  const { lines, upto: newUpto } = takeBatch(rows, m => line(m, 500));
  const current = (await getActive('profile'))?.content || '';
  const text = await askModel(`You maintain a short personal profile of Boon, the user, so his AI assistant can answer as someone who knows him. Today is ${today()}.

Current profile:
${current || '(none yet)'}

Boon's messages since the profile was last updated (oldest first; his side only):
${lines.join('\n')}

Rewrite the profile, merging in anything new and durable.
- Keep every fact already in the current profile (including family, health and commercial details Boon asked to be kept) unless his new messages contradict it. Never drop a line just because it is sensitive.
- Add only things he actually said about himself or his work: who he is, the areas and projects he works on, his interests, how he likes to be answered. Do not infer new health, family or money details, and do not guess at his personality; prefer his own wording to interpretation.
Plain markdown bullets, at most 480 words (about 3,000 characters). Reply with ONLY the profile.`, { role: 'deep', timeoutMs: 40000 });

  await put('profile', 'main', { content: clip(text, 3000), status: 'proposed' });
  await setState('profile_last', new Date().toISOString());
  await setState('profile_upto', newUpto);
  return { proposed: true };
}

// ── Tier 4: embedding backlog ────────────────────────────────────────────────
export async function embedBacklog({ messages = 0, docs = 0, patient = false, left = () => Infinity } = {}) {
  const embed = patient ? embedPatient : embedQuery;
  const out = { messages: 0, docs: 0, stoppedBy: null };
  for (const [table, col, count, key] of [['mobius_messages', 'content', messages, 'messages'], ['mobius_docs', 'chunk', docs, 'docs']]) {
    if (!count) continue;
    const { data, error } = await supabase.from(table).select(`id, ${col}`)
      .is('embedding', null).order('id', { ascending: false }).limit(count);
    if (error) { out.stoppedBy = error.message; continue; }
    for (const row of data || []) {
      if (left() < 1500) { out.stoppedBy = 'time'; return out; }
      if (!String(row[col] ?? '').trim()) continue;
      const vector = await embed(row[col]);
      if (!vector) { out.stoppedBy = 'quota or error'; return out; }
      const { error: e2 } = await supabase.from(table).update({ embedding: vector, embedding_provider: 'gemini' }).eq('id', row.id);
      if (!e2) out[key]++;
    }
  }
  return out;
}

// ── Run everything ───────────────────────────────────────────────────────────
// budgetMs bounds the run (cron); the CLI passes Infinity and drains the whole embedding backlog.
export async function runMaintenance({ budgetMs = Infinity, cli = false } = {}) {
  if (!supabase) return { skipped: 'no database' };
  const t0 = Date.now();
  const left = () => budgetMs - (Date.now() - t0);
  const steps = [
    ['models',   async () => { const a = await auditModels(); return { retired: a.retired, newModels: a.candidates }; }],
    ['week',     () => refreshWeek()],
    ['projects', () => refreshProjects(left)],
    ['profile',  () => proposeProfile()],
    ['embed',    () => embedBacklog({ messages: cli ? 500 : 20, docs: cli ? 3000 : 30, patient: cli, left })],
  ];
  const report = {};
  for (const [name, run] of steps) {
    if (left() < 3000) { report[name] = { skipped: 'out of time' }; continue; }
    try { report[name] = await run(); }
    catch (e) { report[name] = { error: e.message }; }
  }
  try { await setState('last_maintenance', new Date().toISOString()); } catch { /* table may not exist yet */ }
  report.ms = Date.now() - t0;
  return report;
}
