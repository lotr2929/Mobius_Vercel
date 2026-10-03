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
import { liveDriveSearch } from './docs/live.js';
import { runWorkspace, describeState } from './workspace.js';
import { earlierImages, saveImages } from './pcm/attachments.js';
import { findChats, ensureSummaries, loadChatText, listChats, describeChat } from './pcm/chats.js';
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
  .map(m => `[${m.created_at.slice(0, 10)}] ${m.role}: ${clip(m.content, 700)}`)
  .join('\n\n');

// A short, harmless summary of what the browser reported, for the trace.
const clientBrief = c => c && { model: c.model, platform: c.platform, browser: c.browser, standalone: c.standalone, screen: c.screen, tz: c.tz };

// Yields { event } and { token } objects for server.js to relay as SSE.
// client = what the browser reported about the device; geo = approximate location from the request.
export async function* chatTurn({ query, docs = [], images = [], client = null, geo = null, signal }) {
  await restoreAudit(); // learn which models the last audit found retired (matters on a fresh serverless start)

  const { forceProvider, cleanQuery } = parseAskPrefix(query);
  const userQuery = cleanQuery || query; // "Ask: Qwen" alone shouldn't blank the query
  const attached = (Array.isArray(docs) ? docs : []).filter(d => d?.text);
  const ctx = describeContext(client, geo); // { tz, now, where }

  const trace = startTrace('chat', {
    query: userQuery, forced: forceProvider, attached: attached.map(d => d.filename),
    where: ctx.where, tz: ctx.tz, client: clientBrief(client), events: [],
  });

  try {
    // 1–2. verbatim window (complete exchanges only), then the plan
    const raw = await getMessages(RECENT_MESSAGES + 4);
    const recent = settled(raw).slice(-RECENT_MESSAGES);
    const projects = await listActive('project');

    // Notes: "Remember that ...", "Forget ...", "Save 14" and the like are carried out here, before any
    // model is involved. The model is then told what happened so it can confirm it.
    let notes = await listNotes(); // active + suggested
    const command = parseCommand(userQuery, notes.some(n => n.status === 'proposed'));
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
      : await analyse(userQuery, recent, projects, ctx, await safe(describeState, ''));
    trace.set({ plan }).mark('analysed');

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
    const useWeb = !!KEYS.tavily && plan.needsWeb && !isTrivial(plan.standalone) && !plan.aboutSelf && !direct; // none for greetings, questions about Mobius, or answers already in hand
    if (useWeb) yield { event: 'searching web...' };

    const [web, profile, week, archive, namedFile, selfText, live] = await Promise.all([
      useWeb ? tavilySearch(plan.standalone) : null,
      safe(getProfile, ''),
      safe(() => getWeek(recent[0]?.created_at), { digest: '', gap: '' }),
      plan.needsArchive && !direct
        ? safe(() => searchArchive({ semantic: plan.standalone, keywords: plan.queries.join(' ') }, { sinceDays: plan.sinceDays }), NOTHING)
        : NOTHING,
      attached.length || direct ? null : safe(() => findNamedDoc(plan.standalone), null),
      plan.aboutSelf ? safe(() => selfReport(client, geo, ctx), '') : '',
      // Boon's linked Drive folders, searched now rather than stored (only when the message is about his documents or work)
      plan.aboutSelf || memoryAction || direct ? null : safe(() => Promise.race([liveDriveSearch(plan.standalone, plan), new Promise(r => setTimeout(() => r(null), 10000))]), null),
    ]);
    const namedText = namedFile ? await safe(() => getFullDoc(namedFile), null) : null;

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

    const seen = new Set(recent.map(m => m.id));
    const past = archive.messages.filter(m => !seen.has(m.id));
    const chunks = namedText ? [] : archive.docs;
    const chosen = projects.filter(p => plan.projects.includes(p.key));
    trace.set({ recalled: {
      web: web ? web.length : 0, profile: profile.length, weekDigest: week.digest.length, weekGap: week.gap.length,
      pastMessages: past.length, docChunks: chunks.length, namedFile: namedFile || null, projects: chosen.map(p => p.key), self: selfText.length, liveDrive: live?.files || null, liveDriveMs: live?.ms || null,
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
      { title: `File opened from Boon's Drive: ${driveResult?.fileName || ''}`, rank: 1, cap: 20000, text: driveResult?.fileText || '' },
      { title: 'Earlier conversation(s) Boon is referring to (name the chat by its date and title when you answer; if it does not hold what he asks, say so)', rank: 2, cap: 7000, text: earlierChats },
      { title: 'Picture(s) sent earlier, attached to this message again (look at them afresh; the earlier description is only a hint)', rank: 1, cap: 900, text: earlier?.note || '' },
      { title: ATTACHED_TITLE, rank: 1, cap: 20000,
        text: attached.map(d => `--- ${d.filename} ---\n${clip(d.text, 20000)}`).join('\n\n') },
      { title: `Archived document: ${namedFile} — full text`, rank: 1, cap: 20000, text: namedText },
      { title: 'Note', rank: 1, cap: 400, text: noDocs ? NO_DOCS_NOTE : '' },
      { title: 'Note about images', rank: 1, cap: 600, text: noImage ? NO_IMAGE_NOTE : '' },
      { title: 'Files found just now in Boon\'s linked Drive folders for this message (opened live, not stored in Mobius; refer to them by file name)', rank: 3, cap: 5300, text: live?.text || '' },
      { title: 'Relevant past discussion', rank: 3, cap: 3200, text: fmtPast(past) },
      { title: 'Notes saved from Boon\'s earlier statements (a record of what he said, first person means Boon; not evidence, and not conclusions to defend or to agree with)', rank: 2, cap: 3000, text: notesForPrompt(activeNotes, plan.standalone) },
      { title: 'Active projects', rank: 2, cap: 2600, text: fmtProjects(chosen) },
      { title: 'Past week', rank: 4, cap: 3600,
        text: [week.digest, week.gap && `Since that digest:\n${week.gap}`].filter(Boolean).join('\n\n') },
      { title: 'Relevant documents', rank: 5, cap: 3500, text: fmtChunks(chunks) },
      { title: 'Web search results', rank: 6, cap: 2600, text: web },
    ];
    const context = assembleContext(plan.aboutSelf ? [selfPart, ...parts] : [...parts, selfPart]);

    const idle = !recent.length || Date.now() - Date.parse(recent.at(-1).created_at) > 3600e3;
    ctx.suggestions = idle && !memoryAction ? pendingNotes.length : 0; // mention waiting suggestions once, at the start of a conversation
    const system = buildSystem(clip(profile, PROFILE_SEND_MAX), ctx);
    const finalContent = context.text ? `[Memory context — retrieved for this message]\n${context.text}\n\n[User message]\n${userQuery}` : userQuery;
    const messages = [
      // Older turns are clipped; the latest exchange goes in whole.
      ...recent.map((m, i) => ({ role: m.role, content: i >= recent.length - 2 ? m.content : clip(m.content, 4000) })),
      { role: 'user', content: finalContent },
    ];
    trace.set({
      sections: context.sections,
      system_chars: system.length, system: system.slice(0, 6000),
      messages: messages.map(m => ({ role: m.role, chars: m.content.length })),
      prompt: finalContent.slice(0, 30000), // exactly what the model was asked
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
    if (!bibleOnly && !(directAnswer && !bibleShown)) for await (const chunk of runCascade(messages, { signal, system, only: forceProvider, images: sendImages })) {
      if (typeof chunk === 'string') {
        if (!full) {
          trace.mark('first_token');
          if (!memoryAction && !direct) learning = learnFromExchange({ query: userQuery, previousAnswer: lastReply, notes }).catch(() => []);
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
    trace.set({ learned, model: usedModel, answer_chars: full.length, answer_head: full.slice(0, 600) }).mark('answered');

    // 6. remember — only a finished answer to a question that is still wanted
    if (!signal?.aborted && full.trim()) {
      const saved = await saveExchange({ query: images.length ? `[${images.length} image${images.length > 1 ? 's' : ''} attached] ${userQuery}` : userQuery, docs: attached.map(d => d.filename), answer: full, model: usedModel });
      // keep the pictures so a later "the man in the previous image" can be answered by looking again
      if (images.length && saved?.userId) await saveImages(images, saved.userId, full).catch(e => console.warn('[chat] pictures not kept:', e.message));
    }

    if (useWeb) {
      const usage = await tavilyUsage();
      if (usage) yield { event: `tavily:${usage.remaining}/${usage.limit}` };
    }

    embedBacklog({ messages: 4, docs: 8 }).catch(() => {}); // quiet top-up, never blocks the reply
  } catch (e) {
    trace.set({ error: String(e.message).slice(0, 500) });
    throw e;
  } finally {
    trace.set({ aborted: !!signal?.aborted }).mark('end');
    await saveTrace(trace); // awaited so a serverless function isn't frozen before the write lands
  }
}
