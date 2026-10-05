// chat.js — one chat turn, end to end:
//   1. load the verbatim window (memory tier 1)
//   2. analyse the request (pcm/router)
//   3. recall in parallel: profile, week, projects, archive, named document, web
//   4. assemble a budgeted context pack (pcm/assemble)
//   5. stream the answer from the free-model cascade
//   6. save the question and answer together; top up embeddings in the background
// Memory failures never stop the chat: every recall step degrades to "nothing found".
// Every turn leaves a trace (trace.js) so that a wrong answer can be diagnosed afterwards.

import { KEYS, RECENT_MESSAGES } from './config.js';
import { buildSystem } from './ai/prompt.js';
import { runCascade, parseAskPrefix } from './ai/cascade.js';
import { restoreAudit } from './ai/audit.js';
import { analyse, isTrivial } from './pcm/router.js';
import { getMessages, saveExchange, settled } from './pcm/messages.js';
import { getProfile, getWeek, searchArchive } from './pcm/retrieve.js';
import { listActive } from './pcm/memory.js';
import { listNotes, parseCommand, runCommand, notesForPrompt } from './pcm/notes.js';
import { learnFromExchange, learnedNotice } from './pcm/learn.js';
import { PROFILE_SEND_MAX } from './pcm/profile.js';
import { assembleContext } from './pcm/assemble.js';
import { embedBacklog } from './pcm/maintain.js';
import { findNamedDoc, getFullDoc } from './docs/store.js';
import { docDigests, digestOutline, passagesFrom, digestDoc, formatOverview, folderScope } from './docs/digest.js';
import { listSources } from './docs/sources.js';
import { isTheology, libraryContext } from './docs/library.js';
import { liveDriveSearch } from './docs/live.js';
import { runWorkspace, describeState, loadState } from './workspace.js';
import { earlierImages, saveImages } from './pcm/attachments.js';
import { findChats, ensureSummaries, loadChatText, listChats, describeChat, chatAtMessage } from './pcm/chats.js';
import { runBible } from './bible.js';
import { findReadings } from './readings.js';
import { describeContext, selfReport } from './self.js';
import { tavilySearch, tavilyUsage } from './web.js';
import { startTrace, saveTrace } from './trace.js';
import { clip, safe } from './util.js';

const ATTACHED_TITLE = "Attached document(s) — full text — CONFIRM RECEIPT: start your reply by explicitly listing these exact filenames as received before addressing the user's message";
const NO_DOCS_NOTE = 'No documents were attached to this message, and no matching document was found by search either. Tell the user plainly that nothing was received with THIS message and ask them to re-attach.';
const NOTHING = { messages: [], docs: [] };
// "What are the readings this week?": the references as found and checked by readings.js, shown as they are
const formatReadings = r => (r.refs.length
  ? `**Readings for ${r.header}**\n\n${r.refs.map(x => `- ${x}`).join('\n')}\n\n*${r.note}* Click a reference to read it, or say “show them in full”.`
  : `**Readings for ${r.header}**\n\n${r.note}`);

// Does the message read as if Boon expects a file to arrive with it ("summarise the attached paper")?
// Used only to warn the model when nothing came. It must NOT fire on the bare words "document" or
// "attachment" ("a flawed document written by humans", "there's no attachment"), which an earlier,
// looser version did: it made Mobius reply "I didn't receive any document" to ordinary messages.
const EXPECTS_FILE = /\b(?:attached|uploaded|uploading|attaching|enclosed)\b|\b(?:see|read|review|summari[sz]e|check|open|look at|analy[sz]e|edit|proofread)\s+(?:the |this |my |these )?(?:attached |uploaded )?(?:files?|documents?|pdfs?|papers?|spreadsheets?)\b|\bthis (?:file|document|pdf)\b/i;
const DENIES_FILE = /\b(?:no|without|didn'?t|did not|never|not)\b[^.]{0,20}\b(?:attach\w*|upload\w*|files?|documents?)\b|\bthere(?:'s| is) no\b/i;
export const expectsFile = q => EXPECTS_FILE.test(q) && !DENIES_FILE.test(q);

// The same check for pictures: "what is in this photo?" with no image attached must not be answered by guessing
// (a model asked about an image it cannot see will happily invent one).
const NO_IMAGE_NOTE = 'No image was attached to this message. If Boon means an image he sent earlier in this conversation, answer from what was said about it then. Otherwise tell him plainly that nothing was received with THIS message and ask him to attach it (attach panel, "Add a photo or screenshot"). Do not describe or guess at any image.';
// Deliberately narrow: "created in the image of God" or "the big picture" must not trip it (an earlier, looser
// document check once did exactly that). It looks for "this/these/attached/uploaded <image>" or a request to read one.
const EXPECTS_IMAGE = /\b(?:this|these|attached|uploaded)\s+(?:\w+\s+)?(?:images?|photos?|pictures?|screenshots?|scans?|selfies?|pics?)\b(?!\s+of\b)|\b(?:read|describe|look at|analy[sz]e|transcribe|identify|what(?:'s| is) in)\s+(?:the |this |my |that )?(?:image|photo|picture|screenshot|scan|handwriting)\b(?!\s+of\b)|\b(?:in|on|from) (?:this|the attached) (?:image|photo|picture|screenshot|scan)\b/i;
const DENIES_IMAGE = /\b(?:no|without|didn'?t|did not|never|not)\b[^.]{0,20}\b(?:image|photo|picture|screenshot|attach\w*|upload\w*)\b|\bthere(?:'s| is) no\b/i;
export const expectsImage = q => EXPECTS_IMAGE.test(q) && !DENIES_IMAGE.test(q);

const fmtProjects = ps => ps.map(p => `${p.key}:\n${p.content}`).join('\n\n');
const fmtChunks   = ds => ds.map(d => `[${d.filename}]: ${d.chunk}`).join('\n\n');
const fmtPast = ms => [...ms]
  .sort((a, b) => a.created_at.localeCompare(b.created_at))
  .map(m => `[${m.created_at.slice(0, 10)}] ${m.role === 'user' ? 'Boon said' : 'Mobius replied'}: ${clip(m.content, 700)}`)
  .join('\n\n');

// A short, harmless summary of what the browser reported, for the trace.
const clientBrief = c => c && { model: c.model, platform: c.platform, browser: c.browser, standalone: c.standalone, screen: c.screen, tz: c.tz };

// Yields { event } and { token } objects for server.js to relay as SSE.
// client = what the browser reported about the device; geo = approximate location from the request.
export async function* chatTurn({ query, docs = [], images = [], client = null, geo = null, viewing = null, signal }) {
  await restoreAudit(); // learn which models the last audit found retired (matters on a fresh serverless start)

  const { forceProvider, cleanQuery } = parseAskPrefix(query);
  // "Private: …" (or "Confidential: …"): answered only by models whose provider does not train on prompts (ai/models.js `trains`),
  // with no web search, no embedding call, no automatic learning, and nothing saved to memory (a saved message would later be
  // read by the digest jobs, which use the free models that do train).
  const PRIVATE_PREFIX = /^\s*(?:private|confidential)\s*[:\-\u2013\u2014]\s*/i;
  const asked = cleanQuery || query; // "Ask: Qwen" alone shouldn't blank the query
  const privateMode = PRIVATE_PREFIX.test(asked);
  const userQuery = privateMode ? (asked.replace(PRIVATE_PREFIX, '') || asked) : asked;
  const attached = (Array.isArray(docs) ? docs : []).filter(d => d?.text);
  const ctx = describeContext(client, geo); // { tz, now, where }

  const trace = startTrace('chat', {
    query: privateMode ? '[private message — not recorded]' : userQuery, forced: forceProvider, attached: attached.map(d => d.filename), private: privateMode,
    where: ctx.where, tz: ctx.tz, client: clientBrief(client), events: [],
  });

  try {
    // 1–2. verbatim window (complete exchanges only), then the plan
    const raw = await getMessages(RECENT_MESSAGES + 4);
    let recent = settled(raw).slice(-RECENT_MESSAGES);
    // Boon has navigated back to an earlier exchange and is writing from there: that chat, up to the exchange on screen, becomes
    // the conversation this message continues (instead of the newest messages in the log, which may be about something else).
    const newestQuestionId = recent.at(-2)?.id;
    const reopened = viewing != null && String(viewing) !== String(newestQuestionId)
      ? await safe(() => chatAtMessage(viewing, RECENT_MESSAGES), null)
      : null;
    if (reopened) recent = settled(reopened.window);
    const projects = await listActive('project');

    // Notes: "Remember that ...", "Forget ...", "Save 14" and the like are carried out here, before any
    // model is involved. The model is then told what happened so it can confirm it.
    let notes = await listNotes(); // active + suggested
    const command = privateMode ? null : parseCommand(userQuery, notes.some(n => n.status === 'proposed'));
    const memoryAction = command
      ? await safe(() => runCommand(command, { active: notes.filter(n => n.status === 'active'), pending: notes.filter(n => n.status === 'proposed') }), null)
      : null;
    if (memoryAction) notes = await listNotes();
    const activeNotes = notes.filter(n => n.status === 'active');
    const pendingNotes = notes.filter(n => n.status === 'proposed');

    trace.set({
      recent: recent.map(m => ({ id: m.id, role: m.role, chars: m.content.length, head: m.content.slice(0, 80) })),
      unanswered_dropped: raw.length - settled(raw).length,
      command: command?.action || null, memoryAction: memoryAction?.slice(0, 200) || null, notes: activeNotes.length, suggestions: pendingNotes.length,
    }).mark('loaded');
    const plan = memoryAction
      ? { standalone: userQuery, queries: [userQuery], projects: [], needsArchive: false, sinceDays: null, aboutSelf: false, needsWeb: false }
      : await analyse(userQuery, recent, projects, ctx, await safe(describeState, ''), { privateOnly: privateMode });
    trace.set({ plan: privateMode ? { private: true } : plan }).mark('analysed');

    // Requests about his cloud drives ("what drives are linked?", "list the files in the GPR folder", "read the second one")
    // are carried out here; the model is handed the result to present.
    const driveResult = !memoryAction && plan.drive ? await safe(() => runWorkspace(plan.drive), null) : null;
    const chatList = !memoryAction && plan.listChats ? await safe(async () => (await listChats(12)).map((c, i) => `${i + 1}. ${describeChat(c)}`).join('\n'), '') : '';
    // A question about a picture sent earlier gets that picture back, not just the earlier description of it.
    const earlier = !images.length && !driveResult?.images?.length && !memoryAction && plan.refersToImage ? await safe(() => earlierImages(plan.imageHint), null) : null;
    const sendImages = images.length ? images : (driveResult?.images?.length ? driveResult.images : (earlier?.images || []));
    // Scripture: the words come from the stored WEB and KJV, exactly as stored, never from a model's memory. Without references
    // ("this Sunday's readings in full") the references are found by web search first.
    let bibleResult = null;
    if (!memoryAction && plan.bible) {
      bibleResult = await safe(async () => {
        let refs = plan.bible.refs, source = '', list = null;
        if (!refs.length && plan.bible.readings) {
          list = await findReadings(plan.standalone);
          refs = list.refs;
          source = `Readings for ${list.header}. ${list.note}`;
          if (!plan.bible.show) return { text: '', found: 0, notes: [], refs, source, list };
        }
        const out = await runBible({ refs, translation: plan.bible.translation });
        return { ...out, refs, source, list };
      }, null);
    }
    const bibleShown = bibleResult?.text && plan.bible?.show ? bibleResult : null; // asked to see it: shown verbatim, before anything a model says
    const bibleOnly = !!bibleShown && !plan.bible.explain;                         // no explanation asked for: no model is needed at all
    if (bibleResult) trace.set({ bible: { refs: bibleResult.refs, found: bibleResult.found, notes: bibleResult.notes, source: bibleResult.source, shown: !!bibleShown, only: bibleOnly } });
    // A listing of files or chats is shown exactly as produced. Given to a model to "present", it once invented files that were not there.
    const driveDirect = !!driveResult && !driveResult.fileText && !driveResult.images?.length;
    const readingsAnswer = bibleResult?.list && !plan.bible.show ? formatReadings(bibleResult.list) : '';
    const directAnswer = readingsAnswer || (driveDirect ? driveResult.text : (chatList ? `Your recent chats, newest first:\n\n${chatList}` : ''));
    const directLabel = readingsAnswer ? 'Lectionary lookup' : driveDirect ? 'Drive lookup' : 'Chat list';
    const direct = !!(driveResult || chatList || bibleShown || readingsAnswer); // answered by the result itself: nothing else is searched, so nothing competes with it
    trace.set({ direct, drive: plan.drive || null, driveResult: driveResult?.text?.slice(0, 300) || null, earlierImages: earlier?.images?.length || 0, sendImages: sendImages.length });

    // 3. recall, with the web search running alongside
    const useWeb = !!KEYS.tavily && plan.needsWeb && !isTrivial(plan.standalone) && !plan.aboutSelf && !direct && !privateMode; // none for greetings, questions about Mobius, answers already in hand, or private messages
    if (useWeb) yield { event: 'searching web...' };
    // Theology talk draws on Boon's library shelves (docs/library.js); a private message does not search outside, so nor does it embed.
    const theology = !direct && !memoryAction && !attached.length && !plan.aboutSelf && isTheology(`${plan.standalone} ${userQuery}`);
    // A shelf Boon has marked private (mobius_sources.sensitivity) is kept out of every prompt that goes to a model which trains on
    // prompts. A "Private:" message goes only to models that do not, so it may use them.
    const privateLabels = privateMode ? [] : await safe(async () => (await listSources()).filter(s => s.sensitivity === 'private').map(s => s.label), []);
    const hidden = name => privateLabels.some(l => String(name).startsWith(l + '/'));

    const [web, profile, week, archive0, namedFile0, selfText, live0, overview0, library] = await Promise.all([
      useWeb ? tavilySearch(plan.standalone) : null,
      safe(getProfile, ''),
      safe(() => getWeek(recent[0]?.created_at), { digest: '', gap: '' }),
      plan.needsArchive && !direct
        ? safe(() => searchArchive({ semantic: plan.standalone, keywords: plan.queries.join(' ') }, { sinceDays: plan.sinceDays, noEmbed: privateMode }), NOTHING)
        : NOTHING,
      attached.length || direct ? null : safe(async () => {
        const hit = await findNamedDoc(plan.standalone);
        if (hit || !plan.aboutOpenFile) return hit;
        return (await loadState())?.file?.archived || null; // a follow-up ("his account…") about the file opened a moment ago
      }, null),
      plan.aboutSelf ? safe(() => selfReport(client, geo, ctx), '') : '',
      // Boon's linked Drive folders, searched now rather than stored (only when the message is about his documents or work)
      plan.aboutSelf || memoryAction || direct ? null : safe(() => Promise.race([liveDriveSearch(plan.standalone, plan), new Promise(r => setTimeout(() => r(null), 10000))]), null),
      // A question about a whole folder ("what runs through the documents in Scriptura Fidelium?") is answered from the digests of its documents
      plan.aboutSelf || memoryAction || direct || attached.length ? null : safe(async () => {
        const scope = folderScope(plan.standalone, (await listSources()).map(s => s.label));
        if (!scope) return null;
        const rows = (await docDigests({ folder: scope.label })).filter(r => !hidden(r.filename));
        return { label: scope.label, n: rows.length, text: formatOverview(rows, 14000) };
      }, null),
      theology ? safe(() => libraryContext(plan.standalone, { noEmbed: privateMode }), null) : null,
    ]);
    const archive = { ...archive0, docs: (archive0.docs || []).filter(d => !hidden(d.filename)) };
    const namedFile = namedFile0 && !hidden(namedFile0) ? namedFile0 : null;
    const overview = overview0 && !(overview0.label && hidden(overview0.label + '/')) ? overview0 : null;
    const live = privateLabels.length ? null : live0; // the live Drive search cannot tell private folders apart: off while any is marked
    const namedText = namedFile ? await safe(() => getFullDoc(namedFile), null) : null;
    // A book too long to send whole is sent as its digest (or the parts digested so far) plus the digests of the parts that match
    // the question, and the passages of it that contain the question's words (docs/digest.js).
    const longNamed = !!namedText && namedText.length > 20000;
    const [namedOutline, namedPassages] = longNamed
      ? await Promise.all([
        safe(() => digestOutline(namedFile, plan.standalone, { totalChars: namedText.length }), null),
        safe(() => passagesFrom(namedFile, plan.standalone), ''),
      ])
      : [null, ''];

    // "In our chat about X ...", "the previous chat": find that conversation and read it back.
    const hitIds = archive.messages.map(m => m.id);
    const earlierChats = plan.refersToChat && !memoryAction
      ? await safe(async () => {
        let found = await findChats({ keywords: plan.chatHint?.keywords || plan.queries.join(' '), sinceDays: plan.chatHint?.sinceDays ?? plan.sinceDays, untilDays: plan.chatHint?.untilDays ?? null, previous: !!plan.chatHint?.previous, hitMessageIds: hitIds, limit: 2 });
        found = await ensureSummaries(found, { max: 1 });
        const texts = [];
        for (const c of found) texts.push(await loadChatText(c, { query: plan.standalone, budget: found.length > 1 ? 3300 : 6500, focusIds: hitIds }));
        trace.set({ earlierChats: found.map(c => ({ id: c.id, title: c.title, started: c.started_at })) });
        return texts.join('\n\n---\n\n');
      }, '')
      : '';

    // The chat Boon reopened: the turns above are its tail up to the exchange he is looking at; a longer chat also gets its whole text.
    const reopenedFull = reopened && reopened.chat.message_count > reopened.window.length
      ? await safe(() => loadChatText(reopened.chat, { query: plan.standalone, budget: 5000 }), '')
      : '';
    const reopenedNote = reopened
      ? `Boon has gone back to an earlier chat (${describeChat(reopened.chat)}) and is writing from there. The earlier turns of this conversation are THAT chat, up to the exchange he had on screen${reopened.later ? ` (${reopened.later} more message${reopened.later > 1 ? 's' : ''} followed it in that chat)` : ''}. His new message continues that chat, so answer it as part of that conversation; whatever else was said in Mobius since is a different conversation unless he says otherwise.`
      : '';
    trace.set({ reopened: reopened ? { id: reopened.chat.id, title: reopened.chat.title, started: reopened.chat.started_at, window: reopened.window.length, viewing } : null });

    const seen = new Set(recent.map(m => m.id));
    const past = archive.messages.filter(m => !seen.has(m.id));
    const chunks = longNamed || !namedText ? archive.docs : []; // a short named file goes in whole; a long one keeps its search passages too
    const chosen = projects.filter(p => plan.projects.includes(p.key));
    trace.set({ recalled: {
      web: web ? web.length : 0, profile: profile.length, weekDigest: week.digest.length, weekGap: week.gap.length,
      pastMessages: past.length, docChunks: chunks.length, namedFile: namedFile || null, aboutOpenFile: !!plan.aboutOpenFile,
      namedOutline: namedOutline ? { chars: namedOutline.text.length, complete: namedOutline.complete } : 0, namedPassages: namedPassages.length,
      folderOverview: overview ? { folder: overview.label, digests: overview.n } : null,
      library: library ? { books: library.books, passages: library.hits } : (theology ? 'none held' : null),
      projects: chosen.map(p => p.key), self: selfText.length, liveDrive: live?.files || null, liveDriveMs: live?.ms || null,
    } }).mark('recalled');

    // 4. assemble — parts are in display order; rank decides who is cut first when space runs out
    const noDocs = !attached.length && !namedText && !chunks.length && expectsFile(userQuery);
    const noImage = !sendImages.length && expectsImage(userQuery);
    trace.set({ images: images.length, noImageWarning: noImage });
    // Order matters twice over: it is the order the model reads them in, and a model with a small window has the MIDDLE of
    // this text cut out. So what this very message needs (the drive result, the file, the earlier chat) comes first and
    // the standing background (notes, week, documentation) after it.
    const selfPart = { title: 'About Mobius and this device (your own documentation)', rank: plan.aboutSelf ? 1 : 3, cap: 8000, text: selfText };
    const parts = [
      { title: 'Memory action just taken (report it to Boon)', rank: 1, cap: 3000, text: memoryAction },
      { title: 'Result of the cloud-drive request just carried out for Boon: this IS the answer, so present it as it stands, keeping the numbers so he can answer by number (Mobius can only read his Drive, never change it)', rank: 1, cap: 7000, text: driveResult?.text || '' },
      { title: 'Boon\'s earlier chats, newest first: this IS the answer to his request to see them, so present the list as it stands, with the dates and titles', rank: 1, cap: 5000, text: chatList },
      { title: 'Scripture lookup note', rank: 1, cap: 900, text: [bibleResult?.source, ...(bibleResult?.notes || [])].filter(Boolean).join('\n') },
      { title: 'Scripture text just shown to Boon in full, word for word from the stored translation. Do NOT repeat it. Comment only on what he asked; quote a few words from it only when needed, exactly as written', rank: 1, cap: 14000, text: bibleShown && !bibleOnly ? bibleShown.text : '' },
      { title: 'Scripture text for the references in this message: the exact words of the stored translation. Quote scripture only from this, never from memory', rank: 2, cap: 7000, text: bibleResult?.text && !bibleShown ? bibleResult.text : '' },
      { title: `File opened from Boon's Drive: ${driveResult?.fileName || ''}${driveResult?.partial ? ` — ONLY THE FIRST ${driveResult.partial.shown.toLocaleString()} OF ${driveResult.partial.total.toLocaleString()} CHARACTERS (${(driveResult.partial.shown / driveResult.partial.total * 100).toFixed(1)}%) ARE HERE. Say so in your first sentence. Describe only what these characters contain (probably the front matter and the opening); do not summarise the rest of the document, state its argument or name its chapters from memory. If the whole is filed in the archive, tell Boon that questions about the whole will be answered once its digest is written, and that he can ask again later` : ''}`, rank: 1, cap: 20000, text: driveResult?.fileText || '' },
      { title: 'Which conversation this is — Boon reopened an earlier chat', rank: 1, cap: 900, text: reopenedNote },
      { title: 'The whole of the chat Boon reopened (the turns above are its tail up to where he is writing; name the chat by its date and title when you answer)', rank: 2, cap: 5200, text: reopenedFull },
      { title: 'Earlier conversation(s) Boon is referring to (name the chat by its date and title when you answer; if it does not hold what he asks, say so)', rank: 2, cap: 7000, text: earlierChats },
      { title: 'Picture(s) sent earlier, attached to this message again (look at them afresh; the earlier description is only a hint)', rank: 1, cap: 900, text: earlier?.note || '' },
      { title: ATTACHED_TITLE, rank: 1, cap: 20000,
        text: attached.map(d => `--- ${d.filename} ---\n${clip(d.text, 20000)}`).join('\n\n') },
      { title: `Archived document: ${namedFile} — full text`, rank: 1, cap: 20000, text: longNamed ? '' : namedText },
      { title: namedOutline?.complete
        ? `Archived document: ${namedFile} — too long to send whole, so this is its digest and the digests of the parts that best match the question. The digests were written in advance by a model from the full text; answer from them and say that this is what the answer rests on. For exact wording use the passages below`
        : `Archived document: ${namedFile} (${namedText?.length.toLocaleString()} characters) — its digest is NOT finished, so what follows is only what has been digested so far. Say in your first sentence that you have not yet read all of it and how much you have; answer only from what is below; do not describe parts you were not given`,
      rank: 1, cap: 20000, text: longNamed ? (namedOutline?.text || `The digest of this document has not been started yet; nothing but the passages below was available. Say that you have not read the whole book and answer only from the passages.`) : '' },
      { title: `Passages of ${namedFile} that contain the words of the question (exact text from the document; quote only from these)`, rank: 2, cap: 5000, text: namedPassages },
      { title: `Boon's theology library — the shelf (${library?.labels?.join(', ') || ''}): the books he keeps, each with what it is and argues. This is a theological conversation, so draw on these books where they bear on the question, naming the book for every point you take from it; keep what an author says apart from your own view; test an author's argument instead of just repeating it; if the shelf does not cover the question, say so and answer from your own knowledge, marked as such`, rank: 2, cap: 4500, text: library?.shelf || '' },
      { title: 'Passages from the books on his shelf that match the question (exact words of the books, each a paragraph or two, labelled by book). They are fragments: do not claim an author never says something just because it is not among them', rank: 2, cap: 11000, text: library?.passages || '' },
      { title: `Digests of the documents ${overview?.label ? `in Boon's folder "${overview.label}"` : 'in Boon\'s folders'} — each written in advance by a model from the document's whole text. Answer the question about the collection from these; for detail from one document, name it and say that its passages can be searched`, rank: 2, cap: 14000, text: overview?.text || '' },
      { title: 'Note', rank: 1, cap: 600, text: noDocs ? NO_DOCS_NOTE : (overview && !overview.n ? 'Boon asked about a whole folder, but no document in it has been digested yet (digests are written gradually in the background after files are read). Say so plainly, and answer only from the searched passages, making clear they are not the whole.' : '') },
      { title: 'Note about images', rank: 1, cap: 600, text: noImage ? NO_IMAGE_NOTE : '' },
      { title: 'Files found just now in Boon\'s linked Drive folders for this message (opened live, not stored in Mobius; refer to them by file name)', rank: 3, cap: 5300, text: live?.text || '' },
      { title: 'Relevant past discussion', rank: 3, cap: 3200, text: fmtPast(past) },
      { title: 'Notes saved from Boon\'s earlier statements (a record of what he said, first person means Boon; not evidence, and not conclusions to defend or to agree with)', rank: 2, cap: 3000, text: notesForPrompt(activeNotes, plan.standalone) },
      { title: 'Active projects', rank: 2, cap: 2600, text: fmtProjects(chosen) },
      { title: 'Background only — the past week (a digest, then dated notes of earlier exchanges that are already dealt with; none of it is part of the current conversation and none of it is waiting for an answer)', rank: 4, cap: 3600,
        text: [week.digest, week.gap && `Dated notes since that digest:\n${week.gap}`].filter(Boolean).join('\n\n') },
      { title: 'Relevant documents', rank: 5, cap: 3500, text: fmtChunks(chunks) },
      { title: 'Web search results', rank: 6, cap: 2600, text: web },
    ];
    const context = assembleContext(plan.aboutSelf ? [selfPart, ...parts] : [...parts, selfPart]);

    // Suggested notes are no longer announced at the start of a conversation (Boon does not review them; he corrects Mobius
    // structurally instead). They wait quietly, lapse after 60 days, and can still be listed with "show suggestions".
    ctx.suggestions = 0;
    const system = buildSystem(clip(profile, PROFILE_SEND_MAX), ctx);
    // The memory block is background, and a small model can mistake an old exchange inside it for the live conversation: say plainly
    // what is what, and put the instruction last, where it is read last.
    const finalContent = context.text
      ? `[Memory context — retrieved for this message. BACKGROUND ONLY: it may hold old exchanges and documents unrelated to what Boon has just said. The conversation is the earlier turns and the message below. Nothing in this block is a question waiting for an answer.]\n${context.text}\n\n[Boon's new message — reply to this and only this. If it is a statement rather than a question, respond to the statement itself with your own assessment of it.]\n${userQuery}`
      : userQuery;
    const messages = [
      // Older turns are clipped; the latest exchange goes in whole.
      ...recent.map((m, i) => ({ role: m.role, content: i >= recent.length - 2 ? m.content : clip(m.content, 4000) })),
      { role: 'user', content: finalContent },
    ];
    trace.set({
      sections: context.sections,
      system_chars: system.length, system: system.slice(0, 6000),
      messages: messages.map(m => ({ role: m.role, chars: m.content.length })),
      prompt: privateMode ? '[private — not recorded]' : finalContent.slice(0, 30000), // exactly what the model was asked
    }).mark('assembled');

    // 5. answer. Learning (pcm/learn.js) starts with the first token and runs alongside the rest of
    //    the answer, so it adds no waiting time and never runs for an answer that failed.
    let full = '', usedModel = '', learning = null;
    const lastReply = recent.at(-1)?.role === 'assistant' ? recent.at(-1).content : '';
    if (bibleShown) {
      const shownText = (bibleShown.source ? `*${bibleShown.source}*\n\n` : '') + bibleShown.text + (bibleShown.notes.length ? '\n\n' + bibleShown.notes.map(n => `*${n}*`).join('\n') : '');
      yield { event: 'model:Scripture lookup' };
      usedModel = 'scripture lookup';
      full = shownText + (bibleOnly ? '' : '\n\n---\n\n');
      yield { token: full };
    }
    if (directAnswer && !bibleShown) {
      yield { event: 'model:' + directLabel };
      usedModel = directLabel.toLowerCase();
      full = directAnswer;
      yield { token: full };
    }
    if (!bibleOnly && !(directAnswer && !bibleShown)) for await (const chunk of runCascade(messages, { signal, system, only: forceProvider, images: sendImages, privateOnly: privateMode })) {
      if (typeof chunk === 'string') {
        if (!full) {
          trace.mark('first_token');
          if (!memoryAction && !direct && !privateMode) learning = learnFromExchange({ query: userQuery, previousAnswer: lastReply, notes }).catch(() => []);
        }
        full += chunk;
        yield { token: chunk };
      } else if (chunk.event) {
        if (chunk.event.startsWith('model:')) usedModel = chunk.event.slice(6);
        trace.data.events.push(chunk.event.slice(0, 160));
        yield { event: chunk.event };
      }
    }

    // Anything Boon said that is worth keeping: say what was noted, so nothing is saved silently.
    const learned = learning && !signal?.aborted ? await Promise.race([learning, new Promise(r => setTimeout(() => r([]), 4000))]) : [];
    const notice = learnedNotice(learned);
    if (notice) { full += notice; yield { token: notice }; }
    trace.set({ learned, model: usedModel, answer_chars: full.length, answer_head: privateMode ? '[private]' : full.slice(0, 600) }).mark('answered');

    // 6. remember — only a finished answer to a question that is still wanted. A private message is not kept at all.
    if (!privateMode && !signal?.aborted && full.trim()) {
      const saved = await saveExchange({ query: images.length ? `[${images.length} image${images.length > 1 ? 's' : ''} attached] ${userQuery}` : userQuery, docs: attached.map(d => d.filename), answer: full, model: usedModel });
      // keep the pictures so a later "the man in the previous image" can be answered by looking again
      if (images.length && saved?.userId) await saveImages(images, saved.userId, full).catch(e => console.warn('[chat] pictures not kept:', e.message));
    }

    if (useWeb) {
      const usage = await tavilyUsage();
      if (usage) yield { event: `tavily:${usage.remaining}/${usage.limit}` };
    }

    embedBacklog({ messages: 4, docs: 8 }).catch(() => {}); // quiet top-up, never blocks the reply
    // A long file Boon is working with gets its digest written, a few parts at a time, whenever it is used (maintenance finishes the job)
    const toDigest = driveResult?.archived || (longNamed && !namedOutline?.complete ? namedFile : null);
    if (toDigest) digestDoc(toDigest, { left: () => 45000, maxParts: 10, pause: 1500 }).catch(() => {});
  } catch (e) {
    trace.set({ error: String(e.message).slice(0, 500) });
    throw e;
  } finally {
    trace.set({ aborted: !!signal?.aborted }).mark('end');
    await saveTrace(trace); // awaited so a serverless function isn't frozen before the write lands
  }
}
