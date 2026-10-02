// pcm/router.js — analyse a request before any retrieval happens.
// One cheap model call decides what to look up; a rule-based fallback keeps
// working if every model is unavailable.
import { askModel } from '../ai/cascade.js';
import { parseJson, nowIn } from '../util.js';

// Greetings and acknowledgements: no memory lookup, no web search.
const TRIVIAL = /^(hi|hey|hello|yo|sup|thanks|thank you|ta|cheers|ok|okay|k|cool|nice|great|got it|noted|ack|good morning|good night|bye|goodbye|yes|no|yep|nope|sure)[\s!.?]*$/;
export function isTrivial(query) {
  const q = query.toLowerCase().trim();
  return q.length < 3 || TRIVIAL.test(q);
}

// Messages about Mobius itself: how it works, its models, memory, device, location, version.
const ABOUT_SELF = /\b(mobius|yourself|what are you|who are you|how do you (work|remember)|which model|what model|your (memory|models?|device|location|version|architecture|brain)|where are you|what device|are you running)\b/i;

function fallbackPlan(query, projects) {
  const q = query.toLowerCase();
  const hit = projects
    .filter(p => q.includes(p.key.toLowerCase()) || (p.keywords || []).some(k => k.length > 3 && q.includes(k.toLowerCase())))
    .map(p => p.key);
  return { standalone: query, queries: [query.slice(0, 160)], projects: hit.slice(0, 2), needsArchive: true, sinceDays: null, aboutSelf: ABOUT_SELF.test(query), needsWeb: true };
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
    aboutSelf: typeof j.aboutSelf === 'boolean' ? j.aboutSelf : fallback.aboutSelf,
    needsWeb: typeof j.needsWeb === 'boolean' ? j.needsWeb : true,
  };
}

// → { standalone, queries[], projects[], needsArchive, sinceDays, aboutSelf }
// ctx = { now, where } from self.js describeContext()
export async function analyse(query, recent, projects, ctx = {}) {
  if (isTrivial(query)) return { standalone: query, queries: [query], projects: [], needsArchive: false, sinceDays: null, aboutSelf: false, needsWeb: false };
  const fallback = fallbackPlan(query, projects);

  const known = projects.length
    ? projects.map(p => `- ${p.key}${p.keywords?.length ? ` (${p.keywords.slice(0, 8).join(', ')})` : ''}`).join('\n')
    : '(none yet)';
  const convo = recent.slice(-6).map(m => `${m.role}: ${m.content.replace(/\s+/g, ' ').slice(0, 300)}`).join('\n') || '(no earlier messages)';

  const prompt = `You prepare memory retrieval for a personal AI assistant. Right now it is ${ctx.now || nowIn()}. Boon's approximate location: ${ctx.where || 'Perth, Western Australia'}.

Known projects:
${known}

Recent conversation (oldest first):
${convo}

Latest message: "${query}"

Reply with ONLY a JSON object, no commentary:
{
  "standalone": "the latest message rewritten so it makes sense on its own; resolve it/that/this/the file using the conversation; replace relative dates (today, this week, this Sunday, next month) with the actual date or period; for local questions (weather, nearby places, events, 'here', 'near me') add the place name; unchanged if already standalone",
  "queries": ["one or two short keyword searches (names, terms, topics) for finding relevant past chats and documents"],
  "projects": ["exact names from the known projects that this message concerns, otherwise empty"],
  "needsArchive": true or false,
  "sinceDays": integer or null,
  "aboutSelf": true or false,
  "needsWeb": true or false
}

needsWeb is false when the answer comes from information already given (the date, time or location above), from Boon's own memory, or from the conversation: for example "what time is it", "what do you know about me", "summarise what we discussed". It is true for facts about the world, current events, or anything that could be looked up.

aboutSelf is true when the message asks about this assistant itself: what Mobius is, how it works, its models, memory or version, where or on what device it is running, what it knows about itself. It is false for questions about Boon or the world.

needsArchive is true when answering needs older chats or stored documents: references to past discussions or decisions ("remember", "last time", "we agreed"), a named paper, file or project, or specifics of Boon's own work. It is false for self-contained general questions.
sinceDays is set only when the message limits itself to a period ("last week" = 7, "this month" = 30), otherwise null.`;

  try {
    const raw = await askModel(prompt, { role: 'quick', timeoutMs: 8000 });
    return accept(parseJson(raw), query, projects, fallback);
  } catch (e) {
    console.warn('[pcm] router fell back to rules:', e.message);
    return fallback;
  }
}
