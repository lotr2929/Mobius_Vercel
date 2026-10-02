// chat.js — one chat turn, end to end:
//   1. load the verbatim window (memory tier 1)
//   2. analyse the request (pcm/router)
//   3. recall in parallel: profile, week, projects, archive, named document, web
//   4. assemble a budgeted context pack (pcm/assemble)
//   5. stream the answer from the free-model cascade
//   6. save both messages; top up embeddings in the background
// Memory failures never stop the chat: every recall step degrades to "nothing found".

import { KEYS, RECENT_MESSAGES } from './config.js';
import { buildSystem } from './ai/prompt.js';
import { runCascade, parseAskPrefix } from './ai/cascade.js';
import { analyse, isTrivial } from './pcm/router.js';
import { getMessages, saveMessage } from './pcm/messages.js';
import { getProfile, getWeek, searchArchive } from './pcm/retrieve.js';
import { listActive } from './pcm/memory.js';
import { assembleContext } from './pcm/assemble.js';
import { embedBacklog } from './pcm/maintain.js';
import { findNamedDoc, getFullDoc } from './docs/store.js';
import { tavilySearch, tavilyUsage } from './web.js';
import { clip, safe } from './util.js';

const ATTACHED_TITLE = "Attached document(s) — full text — CONFIRM RECEIPT: start your reply by explicitly listing these exact filenames as received before addressing the user's message";
const NO_DOCS_NOTE = 'No documents were attached to this message, and no matching document was found by search either. Tell the user plainly that nothing was received with THIS message and ask them to re-attach.';
const NOTHING = { messages: [], docs: [] };

const fmtProjects = ps => ps.map(p => `${p.key}:\n${p.content}`).join('\n\n');
const fmtChunks   = ds => ds.map(d => `[${d.filename}]: ${d.chunk}`).join('\n\n');
const fmtPast = ms => [...ms]
  .sort((a, b) => a.created_at.localeCompare(b.created_at))
  .map(m => `[${m.created_at.slice(0, 10)}] ${m.role}: ${clip(m.content, 700)}`)
  .join('\n\n');

// Yields { event } and { token } objects for server.js to relay as SSE.
export async function* chatTurn({ query, docs = [], signal }) {
  const { forceProvider, cleanQuery } = parseAskPrefix(query);
  const userQuery = cleanQuery || query; // "Ask: Mistral" alone shouldn't blank the query
  const attached = (Array.isArray(docs) ? docs : []).filter(d => d?.text);

  // 1–2. verbatim window, then the plan
  const recent = await getMessages(RECENT_MESSAGES);
  const projects = await listActive('project');
  const plan = await analyse(userQuery, recent, projects);

  // 3. recall, with the web search running alongside
  const useWeb = !!KEYS.tavily && !isTrivial(plan.standalone);
  if (useWeb) yield { event: 'searching web...' };

  const [web, profile, week, archive, namedFile] = await Promise.all([
    useWeb ? tavilySearch(plan.standalone) : null,
    safe(getProfile, ''),
    safe(() => getWeek(recent[0]?.created_at), { digest: '', gap: '' }),
    plan.needsArchive
      ? safe(() => searchArchive({ semantic: plan.standalone, keywords: plan.queries.join(' ') }, { sinceDays: plan.sinceDays }), NOTHING)
      : NOTHING,
    attached.length ? null : safe(() => findNamedDoc(plan.standalone), null),
  ]);
  const namedText = namedFile ? await safe(() => getFullDoc(namedFile), null) : null;

  const seen = new Set(recent.map(m => m.id));
  const past = archive.messages.filter(m => !seen.has(m.id));
  const chunks = namedText ? [] : archive.docs;
  const chosen = projects.filter(p => plan.projects.includes(p.key));

  // 4. assemble — parts are in display order; rank decides who is cut first when space runs out
  const noDocs = !attached.length && !namedText && !chunks.length && /\b(file|document|paper|upload|attach)/i.test(userQuery);
  const context = assembleContext([
    { title: ATTACHED_TITLE, rank: 1, cap: 20000,
      text: attached.map(d => `--- ${d.filename} ---\n${clip(d.text, 20000)}`).join('\n\n') },
    { title: `Archived document: ${namedFile} — full text`, rank: 1, cap: 20000, text: namedText },
    { title: 'Note', rank: 1, cap: 400, text: noDocs ? NO_DOCS_NOTE : '' },
    { title: 'Active projects', rank: 2, cap: 2600, text: fmtProjects(chosen) },
    { title: 'Past week', rank: 4, cap: 3600,
      text: [week.digest, week.gap && `Since that digest:\n${week.gap}`].filter(Boolean).join('\n\n') },
    { title: 'Relevant past discussion', rank: 3, cap: 3200, text: fmtPast(past) },
    { title: 'Relevant documents', rank: 5, cap: 3500, text: fmtChunks(chunks) },
    { title: 'Web search results', rank: 6, cap: 2600, text: web },
  ]);

  const system = buildSystem(clip(profile, 3000));
  const messages = [
    // Older turns are clipped; the latest exchange goes in whole.
    ...recent.map((m, i) => ({ role: m.role, content: i >= recent.length - 2 ? m.content : clip(m.content, 4000) })),
    { role: 'user', content: context ? `[Memory context — retrieved for this message]\n${context}\n\n[User message]\n${userQuery}` : userQuery },
  ];

  // 5–6. answer, remember
  await saveMessage('user', userQuery, { docs: attached.map(d => d.filename) });

  let full = '', usedModel = '';
  for await (const chunk of runCascade(messages, { signal, system, only: forceProvider })) {
    if (typeof chunk === 'string') {
      full += chunk;
      yield { token: chunk };
    } else if (chunk.event) {
      if (chunk.event.startsWith('model:')) usedModel = chunk.event.slice(6);
      yield { event: chunk.event };
    }
  }
  await saveMessage('assistant', full, { model: usedModel });

  if (useWeb) {
    const usage = await tavilyUsage();
    if (usage) yield { event: `tavily:${usage.remaining}/${usage.limit}` };
  }

  embedBacklog({ messages: 4, docs: 8 }).catch(() => {}); // quiet top-up, never blocks the reply
}
