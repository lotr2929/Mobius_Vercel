// pcm/router.js — analyse a request before any retrieval happens.
// One cheap model call decides what to look up; a rule-based fallback keeps
// working if every model is unavailable.
import { askModel } from '../ai/cascade.js';
import { parseJson, nowIn } from '../util.js';
import { extractRefs, refStrings } from '../bible.js';

// Greetings and acknowledgements: no memory lookup, no web search.
const TRIVIAL = /^(hi|hey|hello|yo|sup|thanks|thank you|ta|cheers|ok|okay|k|cool|nice|great|got it|noted|ack|good morning|good night|bye|goodbye|yes|no|yep|nope|sure)[\s!.?]*$/;
export function isTrivial(query) {
  const q = query.toLowerCase().trim();
  return q.length < 3 || TRIVIAL.test(q);
}

// Messages about Mobius itself: how it works, its models, memory, device, location, version.
const ABOUT_SELF = /\b(mobius|yourself|what are you|who are you|how do you (work|remember)|which model|what model|your (memory|models?|device|location|version|architecture|brain)|where are you|what device|are you running)\b/i;

// ── Rules that stand in for the model (and check it) ─────────────────────────
const IMAGE_REF = /\b(?:the|that|this|my|earlier|previous|last|first|second)\s+(?:\w+\s+)?(?:image|photo|picture|pic|screenshot|scan|whiteboard)\b(?!\s+of\s+god)|\bin the (?:image|photo|picture)\b/i;
const CHAT_REF = /\b(?:previous|earlier|last|other|old|past)\s+(?:chat|conversation|discussion|session)\b|\bwe\s+(?:discussed|talked about|spoke about|covered|agreed)\b|\b(?:in|from) (?:the|our) (?:\w+\s+)?(?:chat|conversation|discussion)\b|\bwhen we (?:discussed|talked|spoke)\b/i;
const LIST_CHATS = /\b(?:list|show|what are|what were|give me)\b[^.?]{0,40}\b(?:my|our|the|recent|previous|past|earlier)\b[^.?]{0,25}\b(?:chats|conversations|discussions)\b/i;
const STRONG_DRIVE = /\b(?:drive|folders?|files?|documents?|docs?|papers?|pdfs?|spreadsheets?|cloud|dropbox|onedrive|google|accounts?|linked|index|indexed|directory)\b/i;
// A follow-up about the file just opened, without naming it ("his account", "the book", "the author's argument").
const OPEN_FILE_REF = /\b(?:the|this|that|his|her|its|their)\s+(?:book|document|file|paper|pdf|author|writer|chapter|account|argument|thesis|text|critique|claim|treatment|introduction|conclusion)s?\b/i;
const ORD = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 };
const ordinal = s => { const w = String(s).toLowerCase(); return ORD[w] || (/^\d+/.test(w) ? parseInt(w, 10) : null); };

export function driveRules(query, hasFile = false) {
  const q = String(query || '').trim();
  if (/\b(?:what|which)\b[^.?]{0,30}\b(?:drives?|accounts?|cloud|storage)\b[^.?]{0,30}\b(?:linked|connected|set up|available|have)\b|\b(?:list|show)\b[^.?]{0,20}\b(?:linked|connected)\b[^.?]{0,20}\b(?:drives?|accounts?)\b|\bwhat (?:drives?|cloud storage) do (?:i|you) have\b/i.test(q)) return { action: 'accounts' };
  let m;
  if ((m = q.match(/\b(?:update|refresh|re-?read|re-?index)\b[^.?]{0,25}\bindex\b/i))) return { action: 'sync' };
  if ((m = q.match(/\b(?:link|index|keep indexed)\s+(?:the\s+)?(.+?)\s+folder\b/i))) return { action: 'link', target: m[1] };
  if ((m = q.match(/\b(?:unlink|stop indexing)\s+(?:the\s+)?(.+?)(?:\s+folder)?[.!?]*$/i))) return { action: 'unlink', target: m[1] };
  if ((m = q.match(/\b(?:list|show|display|give me)\b[^.?]{0,30}\b(?:files|contents|items|documents)\b[^.?]{0,12}\b(?:in|of|inside|within)\s+(?:the\s+)?(.+?)\s+(?:folder|directory)\b/i))) return { action: 'list', target: m[1] };
  if ((m = q.match(/\bwhat(?:'s| is)\s+(?:in|inside)\s+(?:the\s+)?(.+?)\s+folder\b/i))) return { action: 'list', target: m[1] };
  if ((m = q.match(/\b(?:open|go (?:in|into)|enter)\s+(?:the\s+)?(.+?)\s+folder\b/i))) return { action: 'list', target: m[1] };
  if (/\b(?:list|show)\b[^.?]{0,20}\b(?:my )?(?:google )?drive\b|\bwhat(?:'s| is) in my (?:google )?drive\b/i.test(q)) return { action: 'list', target: 'root' };
  if ((m = q.match(/\b(?:read|open|summari[sz]e|review|check|look at|translate)\s+(?:the\s+)?(\d+(?:st|nd|rd|th)?|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)(?:\s+(?:one|file|document|item|folder))?\b/i)) && ordinal(m[1])) return { action: 'open', ref: ordinal(m[1]) };
  if (hasFile && /^\s*(?:please\s+)?(?:now\s+)?(?:read|open|summari[sz]e|review|check|translate|quote|extract)\b[^.?]{0,25}\b(?:it|that|this)\b/i.test(q)) return { action: 'open', ref: 'last' };
  if ((m = q.match(/\b(?:find|search for|look for|where is)\s+(?:my\s+|the\s+)?(.+?)\s+(?:in|on) (?:my )?(?:google )?drive\b/i))) return { action: 'find', query: m[1] };
  return null;
}

const IMAGE_MARK = /\[\d+ images? attached\]/;
// ── Scripture: "show me Matthew 21:33-46", "those readings in full", "this Sunday's readings in full" ──
const SHOW = /\b(?:show|read|display|print|give me|quote|pull up|bring up|look up|open|fetch|put up|let me (?:see|read)|can i (?:see|read)|text of|full text|in full|word for word)\b/i;
const EXPLAIN = /\b(?:explain|compare|discuss|commentary|meaning|mean|interpret|reflect|reflection|sermon|summari[sz]e|why|how|what does|analy[sz]e|exegesis|context|background|difference|contrast)\b/i;
const READINGS = /\b(?:lectionary|rcl)\b[^.?]{0,30}\b(?:readings?|gospel|passages?|lessons?)\b|\b(?:today'?s|sunday'?s|(?:this|next|coming)\s+sunday'?s?)\s+(?:readings?|gospel|passages?|lessons?)\b|\breadings?\s+for\s+(?:this|next|the|sunday)\b|\breadings?\s+(?:this|next)\s+(?:sunday|week)\b|\b(?:this|next)\s+week'?s?\s+(?:readings?|gospel|passages?|lessons?)\b|\b(?:gospel|epistle|psalm|first|second|old testament)\s+(?:reading|lesson)\b[^.?]{0,25}\b(?:this|next)\s+(?:sunday|week)\b/i;
// What Boon wants done with scripture, decided in one place (a trace of 6 Oct 2026 showed three separate rules disagreeing):
//   compose  "write / give me a healing prayer ... quote them": Mobius is to WRITE something; scripture is material for it, never a request to display
//   show     he wants the passage text displayed ("show me", "read", "in full") and is not asking for something to be written
//   more     he wants more than a display or a list: explanation, discussion, reflection or composition, so a model must answer
const COMPOSE = /\b(?:write|compose|draft|prepare)\b|\b(?:prayers?|pray|sermons?|homil(?:y|ies)|poems?|letters?|blessings?|liturg(?:y|ies)|collects?|intercessions?)\b/i;
const DISCUSS = /\b(?:reflect\w*|learn\w*|learnt|discuss\w*|explor\w*|themes?|take-?aways?|thoughts?|insights?|covered)\b/i;
export function scriptureIntent(q) {
  const s = String(q || '');
  const compose = COMPOSE.test(s);
  return { compose, show: SHOW.test(s) && !compose, more: compose || EXPLAIN.test(s) || DISCUSS.test(s) };
}
// "both" alone ("we have covered both the passages") is not a request for both translations
const transl = q => (/\bboth\s+(?:translations?|versions?|texts?)\b|\bcompare\b|side by side|WEB and KJV|KJV and WEB/i.test(q) ? 'both' : /\bKJV\b|king james/i.test(q) ? 'KJV' : /\bWEB\b|world english/i.test(q) ? 'WEB' : '');
const lastAssistant = recent => [...recent].reverse().find(m => m.role === 'assistant')?.content || '';
const WANTS_THEM = /\b(?:them|those|these|the readings|the passages|the verses|that passage|the lessons)\b|in full|full text/i;

export function bibleRules(query, recent = []) {
  const q = String(query || '');
  const { show, more } = scriptureIntent(q);
  let refs = refStrings(q, { chapterOnlyOk: show });
  if (!refs.length && show && WANTS_THEM.test(q)) refs = refStrings(lastAssistant(recent), {});
  const readings = !refs.length && READINGS.test(q); // asked what they are: the references are listed; asked to show them: the text follows
  if (!refs.length && !readings) return null;
  return { refs: [...new Set(refs)].slice(0, 8), translation: transl(q), show, explain: more, readings };
}

// The model's version is kept only for references that really appear in the message or in the last answer.
function cleanBible(b, query, recent, fallback) {
  const f = fallback.bible;
  if (!b || typeof b !== 'object') return f;
  const intent = scriptureIntent(query);
  // References from the last answer count only when he asks to SEE them ("show me those"), never when he asks Mobius to write
  // something ("write a prayer, quote them"): lifting them then displayed the same verses again in place of the prayer.
  const allowed = new Set([...extractRefs(query, { chapterOnlyOk: true }), ...(intent.show && WANTS_THEM.test(query) ? extractRefs(lastAssistant(recent), {}) : [])].map(r => r.label));
  const refs = (Array.isArray(b.refs) ? b.refs : []).flatMap(x => extractRefs(String(x), { chapterOnlyOk: true })).filter(r => allowed.has(r.label)).map(r => r.text).slice(0, 8);
  const merged = refs.length ? refs : (f?.refs || []);
  const readings = !merged.length && ((b.readings === true && READINGS.test(query)) || !!f?.readings);
  if (!merged.length && !readings) return null;
  const tr = String(b.translation || '');
  return { refs: merged, translation: /both/i.test(tr) && transl(query) === 'both' ? 'both' : /kjv|king/i.test(tr) ? 'KJV' : /web|world/i.test(tr) ? 'WEB' : (f?.translation || transl(query)), show: intent.show && (b.show === true || !!f?.show), explain: b.explain === true || !!f?.explain || intent.more, readings };
}

function fallbackPlan(query, projects, hasFile, recentHasImage = false, recent = []) {
  const q = query.toLowerCase();
  const hit = projects
    .filter(p => q.includes(p.key.toLowerCase()) || (p.keywords || []).some(k => k.length > 3 && q.includes(k.toLowerCase())))
    .map(p => p.key);
  return {
    standalone: query, queries: [query.slice(0, 160)], projects: hit.slice(0, 2), needsArchive: true, sinceDays: null, aboutSelf: ABOUT_SELF.test(query), needsWeb: true,
    refersToImage: IMAGE_REF.test(query) && recentHasImage, imageHint: '',
    refersToChat: CHAT_REF.test(query), chatHint: { keywords: query.slice(0, 120), sinceDays: null, untilDays: null, previous: /\b(?:previous|last|earlier)\s+(?:chat|conversation|discussion)\b/i.test(query) },
    listChats: LIST_CHATS.test(query), drive: driveRules(query, hasFile), bible: bibleRules(query, recent),
    aboutOpenFile: hasFile && OPEN_FILE_REF.test(query),
  };
}

const DRIVE_ACTIONS = new Set(['accounts', 'list', 'find', 'open', 'link', 'unlink', 'sync']);
function cleanDrive(d, query, hasState, fallback) {
  const rule = fallback.drive;
  if (!d || typeof d !== 'object' || !DRIVE_ACTIONS.has(d.action)) return rule || null;
  // The model may see a drive request where there is none; require a word that points at drives, files or a numbered reply.
  if (!STRONG_DRIVE.test(query) && !(hasState && (Number.isInteger(d.ref) || d.ref === 'last'))) return rule || null;
  const ref = Number.isInteger(d.ref) && d.ref > 0 ? d.ref : d.ref === 'last' ? 'last' : null;
  return {
    action: d.action, target: String(d.target || '').trim().slice(0, 120), ref, query: String(d.query || '').trim().slice(0, 160),
    account: String(d.account || '').trim().slice(0, 30), withDocs: d.withDocs === true,
  };
}

function accept(j, query, projects, fallback, hasState, recent = [], hasFile = false) {
  const standalone = typeof j.standalone === 'string' && j.standalone.trim() ? j.standalone.trim().slice(0, 500) : query;
  const queries = (Array.isArray(j.queries) ? j.queries : [])
    .filter(q => typeof q === 'string' && q.trim()).map(q => q.trim().slice(0, 160)).slice(0, 2);
  const byName = new Map(projects.map(p => [p.key.toLowerCase(), p.key]));
  const named = (Array.isArray(j.projects) ? j.projects : []).map(n => byName.get(String(n).toLowerCase())).filter(Boolean);
  const days = Number.isInteger(j.sinceDays) && j.sinceDays > 0 && j.sinceDays <= 3650 ? j.sinceDays : null;
  const ch = j.chatHint && typeof j.chatHint === 'object' ? j.chatHint : {};
  const int = v => (Number.isInteger(v) && v >= 0 && v <= 3650 ? v : null);
  return {
    standalone,
    queries: queries.length ? queries : [standalone],
    projects: [...new Set([...named, ...fallback.projects])].slice(0, 2),
    needsArchive: j.needsArchive !== false,
    sinceDays: days,
    aboutSelf: typeof j.aboutSelf === 'boolean' ? j.aboutSelf : fallback.aboutSelf,
    needsWeb: typeof j.needsWeb === 'boolean' ? j.needsWeb : true,
    webQueries: (Array.isArray(j.webQueries) ? j.webQueries : []).filter(q => typeof q === 'string' && q.trim()).map(q => q.trim().slice(0, 140)).slice(0, 3),
    refersToImage: (typeof j.refersToImage === 'boolean' ? j.refersToImage : false) || fallback.refersToImage,
    imageHint: typeof j.imageHint === 'string' ? j.imageHint.trim().slice(0, 80) : '',
    refersToChat: (typeof j.refersToChat === 'boolean' ? j.refersToChat : false) || fallback.refersToChat,
    chatHint: { keywords: typeof ch.keywords === 'string' && ch.keywords.trim() ? ch.keywords.trim().slice(0, 160) : queries.join(' ') || standalone, sinceDays: int(ch.sinceDays), untilDays: int(ch.untilDays), previous: ch.previous === true || fallback.chatHint.previous },
    listChats: (typeof j.listChats === 'boolean' ? j.listChats : false) || fallback.listChats,
    drive: cleanDrive(j.drive, query, hasState, fallback),
    aboutOpenFile: hasFile && ((typeof j.aboutOpenFile === 'boolean' ? j.aboutOpenFile : false) || fallback.aboutOpenFile),
    bible: cleanBible(j.bible, query, recent, fallback),
  };
}

// → { standalone, queries[], projects[], needsArchive, sinceDays, aboutSelf, needsWeb,
//     refersToImage, imageHint, refersToChat, chatHint, listChats, drive }
// ctx = { now, where } from self.js describeContext(); workspace = a line from workspace.describeState()
export async function analyse(query, recent, projects, ctx = {}, workspace = '', opts = {}) {
  const hasState = /current folder|last file|numbered list|asked which/.test(workspace);
  const hasFile = /last file opened/.test(workspace);
  const recentHasImage = recent.some(m => IMAGE_MARK.test(m.content || ''));
  const fallback = fallbackPlan(query, projects, hasFile, recentHasImage, recent);
  if (isTrivial(query)) return { standalone: query, queries: [query], projects: [], needsArchive: false, sinceDays: null, aboutSelf: false, needsWeb: false, refersToImage: false, imageHint: '', refersToChat: false, chatHint: { keywords: '', sinceDays: null, untilDays: null, previous: false }, listChats: false, drive: null, bible: null };

  const known = projects.length
    ? projects.map(p => `- ${p.key}${p.keywords?.length ? ` (${p.keywords.slice(0, 8).join(', ')})` : ''}`).join('\n')
    : '(none yet)';
  const convo = recent.slice(-6).map(m => `${m.role}: ${m.content.replace(/\s+/g, ' ').slice(0, 300)}`).join('\n') || '(no earlier messages)';

  const prompt = `You prepare memory retrieval for a personal AI assistant. Right now it is ${ctx.now || nowIn()}. Boon's approximate location: ${ctx.where || 'Perth, Western Australia'}.

Known projects:
${known}

Recent conversation (oldest first; "[1 image attached]" marks a message that came with a picture):
${convo}

Cloud drives and files: ${workspace || 'No cloud drive is connected'}

Latest message: "${query}"

Reply with ONLY a JSON object, no commentary:
{
  "standalone": "the latest message rewritten so it makes sense on its own; resolve it/that/this/the file using the conversation; replace relative dates (today, this week, this Sunday, next month) with the actual date or period; for local questions (weather, nearby places, events, 'here', 'near me') add the place name; unchanged if already standalone",
  "queries": ["one or two short keyword searches (names, terms, topics) for finding relevant past chats and documents"],
  "projects": ["exact names from the known projects that this message concerns, otherwise empty"],
  "needsArchive": true or false,
  "sinceDays": integer or null,
  "aboutSelf": true or false,
  "needsWeb": true or false,
  "webQueries": ["one to three web-search queries, written the way a person would type them into a search engine, when needsWeb is true; otherwise empty"],
  "refersToImage": true or false,
  "imageHint": "a few words saying which earlier picture (for example: whiteboard photo), or empty",
  "refersToChat": true or false,
  "chatHint": {"keywords": "words likely to appear in that chat", "sinceDays": integer or null, "untilDays": integer or null, "previous": true or false},
  "listChats": true or false,
  "aboutOpenFile": true or false,
  "drive": null or {"action": "accounts" or "list" or "find" or "open" or "link" or "unlink" or "sync", "target": "folder or file name as Boon said it, or empty", "ref": null or a number or "last", "query": "words to search for, for find", "account": "google, dropbox, onedrive or empty", "withDocs": true or false},
  "bible": null or {"refs": ["Matthew 21:33-46"], "translation": "WEB" or "KJV" or "both" or "", "show": true or false, "explain": true or false, "readings": true or false}
}

needsWeb is false when the answer comes from information already given (the date, time or location above), from Boon's own memory, or from the conversation: for example "what time is it", "what do you know about me", "summarise what we discussed". It is true for facts about the world, current events, or anything that could be looked up. It is also true for any question of substance (history, science, theology, scholarship, argument), even when Boon's own files or library may hold material on it: outside evidence is gathered first.

webQueries (only when needsWeb is true) are what a person would type into a search engine: names and distinctive terms, not the whole question. Give two or three that approach the question from different angles, aimed at independent outside sources (scholarly work, primary sources, reputable reporting), not at Boon's own files or the wording of his question. For an analytical, historical, scientific or theological question, one query should look for the strongest case on the other side or for the scholarly debate. When the message asks what happened next, afterwards, later or most recently ("look into what happened afterwards", "do some research", "find out everything you can"), use the conversation to name the person or event and the likely later stages (for example "Rhys Bellinge sentenced", "Rhys Bellinge Supreme Court sentencing 2026"); never repeat the earlier stage that is already known. If the message is only a request to search or research, take the subject from the recent conversation.

aboutSelf is true when the message asks about this assistant itself: what Mobius is, how it works, its models, memory or version, where or on what device it is running, what it knows about itself. It is false for questions about Boon or the world.

needsArchive is true when answering needs older chats or stored documents: references to past discussions or decisions ("remember", "last time", "we agreed"), a named paper, file or project, or specifics of Boon's own work. It is false for self-contained general questions.
sinceDays is set only when the message limits itself to a period ("last week" = 7, "this month" = 30), otherwise null.

refersToImage is true when the message asks about a picture, photo or screenshot that was sent earlier in the conversation ("the man in the previous image", "that whiteboard photo", "what was in the picture I sent"), otherwise false.

refersToChat is true when the message points at an earlier conversation that is not in the recent conversation above ("in our chat about the GPR paper", "last Tuesday we discussed...", "the previous chat", "go back to where we talked about..."). chatHint.previous is true for "the previous / last chat". chatHint.sinceDays and untilDays turn a time expression into days ago (for "last week": sinceDays 14, untilDays 7; for "yesterday": sinceDays 2, untilDays 0), otherwise null.
listChats is true when Boon asks to see a list of his earlier chats or conversations.

aboutOpenFile is true when a file was recently opened (see "last file opened" above) and the message is a follow-up question about that file or its author without naming it: "is his account representative?", "what does the book say about grace?", "and chapter 3?", "why does the author think that?". When it is true, the standalone rewrite must name the file by its title, and drive stays null (the file is already in the archive). False when the message is about something else.

drive is for requests about Boon's cloud storage, answered by looking in it. "accounts": which drives, accounts or cloud storage are linked. "list": show the contents of a folder ("list the files in the GPR folder", "what's in my Drive", "open the Papers folder", "go into the third one"; target is the folder name, empty for "this folder", ref is a number when he picks from a numbered list). "find": look for files by name or subject across the Drive. "open": read, open, summarise, quote or check a particular file ("read the second one", "summarise draft_v3.pdf", "summarise it" when a file was just opened gives ref "last"). If Boon says where a file is without naming it ("it's in the Scriptura Fidelium folder"), the file is the one he asked for earlier in the recent conversation: use "open" with that file's title as target, and make standalone name it. "link": keep a folder indexed for searching; "unlink": stop that; "sync": update the index. bible is for scripture. refs are Bible references Boon wrote (copied exactly), or, when he says "them", "those readings" or "in full", the references listed in the recent conversation. show is true when he wants the passage text displayed ("show me", "read", "give me", "in full"); explain is true when he also asks for explanation, comparison or comment. readings is true when he asks to see this or next Sunday's lectionary readings (RCL) in full but names no references. A message that merely mentions a reference in discussion has refs and show false. Use null when there is no scripture reference and no request for readings.

Use null for drive for everything else, including general questions that merely mention documents, and for requests about files Boon attaches to the message itself.`;

  try {
    const raw = await askModel(prompt, { role: 'quick', timeoutMs: 10000, privateOnly: !!opts.privateOnly });
    return accept(parseJson(raw), query, projects, fallback, hasState, recent, hasFile);
  } catch (e) {
    console.warn('[pcm] router fell back to rules:', e.message);
    return fallback;
  }
}
