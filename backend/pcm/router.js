// pcm/router.js — analyse a request before any retrieval happens.
// One cheap model call decides what to look up; a rule-based fallback keeps
// working if every model is unavailable.
import { askModel, ORDER } from '../ai/cascade.js';
import { parseJson } from '../util.js';

// Greetings and acknowledgements: no memory lookup, no web search.
const TRIVIAL = /^(hi|hey|hello|yo|sup|thanks|thank you|ta|cheers|ok|okay|k|cool|nice|great|got it|noted|ack|good morning|good night|bye|goodbye|yes|no|yep|nope|sure)[\s!.?]*$/;
export function isTrivial(query) {
  const q = query.toLowerCase().trim();
  return q.length < 3 || TRIVIAL.test(q);
}

function fallbackPlan(query, projects) {
  const q = query.toLowerCase();
  const hit = projects
    .filter(p => q.includes(p.key.toLowerCase()) || (p.keywords || []).some(k => k.length > 3 && q.includes(k.toLowerCase())))
    .map(p => p.key);
  return { standalone: query, queries: [query.slice(0, 160)], projects: hit.slice(0, 2), needsArchive: true, sinceDays: null };
}

function accept(j, query, projects, fallback) {
  const standalone = typeof j.standalone === 'string' && j.standalone.trim() ? j.standalone.trim().slice(0, 500) : query;
  const queries = (Array.isArray(j.queries) ? j.queries : [])
    .filter(q => typeof q === 'string' && q.trim()).map(q => q.trim().slice(0, 160)).slice(0, 2);
  const byName = new Map(projects.map(p => [p.key.toLowerCase(), p.key]));
  const named = (Array.isArray(j.projects) ? j.projects : []).map(n => byName.get(String(n).toLowerCase())).filter(Boolean);
  const days = Number.isInteger(j.sinceDays) && j.sinceDays > 0 && j.sinceDays <= 3650 ? j.sinceDays : null;
  return {
    standalone,
    queries: queries.length ? queries : [standalone],
    projects: [...new Set([...named, ...fallback.projects])].slice(0, 2),
    needsArchive: j.needsArchive !== false,
    sinceDays: days,
  };
}

// → { standalone, queries[], projects[], needsArchive, sinceDays }
export async function analyse(query, recent, projects) {
  if (isTrivial(query)) return { standalone: query, queries: [query], projects: [], needsArchive: false, sinceDays: null };
  const fallback = fallbackPlan(query, projects);

  const known = projects.length
    ? projects.map(p => `- ${p.key}${p.keywords?.length ? ` (${p.keywords.slice(0, 8).join(', ')})` : ''}`).join('\n')
    : '(none yet)';
  const convo = recent.slice(-6).map(m => `${m.role}: ${m.content.replace(/\s+/g, ' ').slice(0, 300)}`).join('\n') || '(no earlier messages)';

  const prompt = `You prepare memory retrieval for a personal AI assistant.

Known projects:
${known}

Recent conversation (oldest first):
${convo}

Latest message: "${query}"

Reply with ONLY a JSON object, no commentary:
{
  "standalone": "the latest message rewritten so it makes sense on its own; resolve it/that/this/the file using the conversation; unchanged if already standalone",
  "queries": ["one or two short keyword searches (names, terms, topics) for finding relevant past chats and documents"],
  "projects": ["exact names from the known projects that this message concerns, otherwise empty"],
  "needsArchive": true or false,
  "sinceDays": integer or null
}

needsArchive is true when answering needs older chats or stored documents: references to past discussions or decisions ("remember", "last time", "we agreed"), a named paper, file or project, or specifics of Boon's own work. It is false for self-contained general questions.
sinceDays is set only when the message limits itself to a period ("last week" = 7, "this month" = 30), otherwise null.`;

  try {
    const raw = await askModel(prompt, { order: ORDER.quick, timeoutMs: 8000 });
    return accept(parseJson(raw), query, projects, fallback);
  } catch (e) {
    console.warn('[pcm] router fell back to rules:', e.message);
    return fallback;
  }
}
