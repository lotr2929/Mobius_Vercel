// backend/bench/tasks.mjs — what Mobius asks of its models, and how each answer is marked.
//
// Every item has a `good` answer and a `bad` one, and test/bench.test.mjs checks that the marking tells them apart, so a marker that
// stops discriminating is found before it misleads a ranking. Marking is plain code (no model judges a model): it looks for what an
// answer must contain or must not do. It cannot judge depth or style beyond that, so the full texts are kept for a human to read.
//
// Areas: 'neutral' items use made-up or public facts and may be sent to any provider; 'personal' items go through the whole of
// chat.js with Boon's real notes and profile (dryRun: nothing saved), so they are tried only on providers he already uses.
// Roles say which job a model is being tried for (chat, quick = routing, learn = deciding what to remember, deep = summaries).
import { buildSystem } from '../ai/prompt.js';
import { assembleContext } from '../pcm/assemble.js';
import { parseJson } from '../util.js';
import { extractRefs } from '../bible.js';

// ── marking helpers ──────────────────────────────────────────────────────────
const S = t => String(t ?? '');
export const words = t => (S(t).match(/[\p{L}\p{N}’'-]+/gu) || []).length;
export const sentenceCount = t => S(t).replace(/\b(?:Dr|Mr|Mrs|Ms|Prof|St|vs|No|e\.g|i\.e|etc|c|ca)\./gi, m => m.slice(0, -1)).trim().split(/(?<=[.!?])["”’)]*\s+(?=["“‘(]?[A-Z])/).filter(x => x.trim()).length;
export const listLines = t => (S(t).match(/^[ \t]*(?:\d{1,2}[.)]|[-*•])[ \t]+\S/gm) || []).length;
export const inOrder = (t, list) => { const s = S(t).toLowerCase(); let at = -1; for (const w of list) { const i = s.indexOf(w.toLowerCase(), at + 1); if (i < 0) return false; at = i; } return true; };
const unquoted = t => S(t).replace(/[“"][^”"]{15,600}[”"]/g, ' ');
const US = /\b(?:color\w*|organiz\w*|recogniz\w*|realiz\w*|analyz\w*|favorit\w*|behavior\w*|neighbor\w*|honor\w*|center(?:s|ed)?|gray|theater\w*|defense|catalog\w*|traveled|labeled|criticiz\w*|summariz\w*|emphasiz\w*|apologiz\w*|civiliz\w*|utiliz\w*)\b/i;
const CONCEDES = /\b(?:you(?:'|’)re|you are) (?:\w+ )?(?:right|correct)\b|\bI (?:apologi[sz]e|stand corrected|was wrong|was mistaken)\b|\bmy (?:mistake|apologies)\b|\bsorry for the (?:error|confusion|mistake)\b|\bthank you for (?:the )?correct/i;
const ADMITS_UNKNOWN = /\b(?:not (?:aware|familiar)|no record|(?:cannot|can(?:'|’)t|unable to|couldn(?:'|’)t) (?:find|verify|confirm|locate)|(?:doesn(?:'|’)t|does not) (?:appear|seem) to exist|no such (?:book|work|chapter)|(?:isn(?:'|’)t|is not) (?:a )?(?:known|real|recognised|recognized)|(?:don(?:'|’)t|do not) (?:have|know) (?:of |any |that )|not (?:part of|in|included in) the (?:New Testament|canon|Bible)|may be (?:confus|thinking)|could you (?:clarify|check)|do you mean|died in 1965)\b/i;
const CONFIDENT = /\b(?:In this (?:book|work)|the book (?:argues|explores|examines|discusses|contends)|(?:Bachelard|Tillich) (?:argues|explores|contends|writes that)|chapter \d+ (?:argues|discusses|examines))\b/i;
const grade = checks => { const v = Object.values(checks); return { score: v.filter(Boolean).length / v.length, checks }; };
const fact = (id, q, good, bad, ...res) => ({ id, kind: 'chat', system: 'light', messages: [{ role: 'user', content: q }], good, bad, score: t => grade(Object.fromEntries(res.map((r, i) => [`fact ${i + 1}`, r.test(S(t))]))) });

// ── the items ────────────────────────────────────────────────────────────────
const FACTS = [
  fact('kuhn', 'Who wrote The Structure of Scientific Revolutions, and in what year was it first published?', 'Thomas Kuhn wrote it, and it was first published in 1962.', 'Karl Popper wrote it in 1959.', /Kuhn/, /1962/),
  fact('nicaea', 'In what year did the First Council of Nicaea meet?', 'The First Council of Nicaea met in 325.', 'It met in 381.', /\b325\b/),
  fact('sermon', 'Which gospel contains the Sermon on the Mount?', 'The Gospel of Matthew contains the Sermon on the Mount (chapters 5 to 7).', 'The Gospel of John.', /Matthew/),
  fact('einstein', 'Who proposed the general theory of relativity, and in what year?', 'Albert Einstein presented it in 1915.', 'Isaac Newton in 1687.', /Einstein/, /\b191[56]\b/),
  fact('perth', 'What is the capital of Western Australia?', 'Perth.', 'Fremantle.', /Perth/),
  fact('tillich', 'Which Protestant theologian wrote the three-volume Systematic Theology published between 1951 and 1963?', 'Paul Tillich.', 'Karl Barth.', /Tillich/),
  fact('fire', 'Which book by Gaston Bachelard, published in 1938, studies fire and the imagination?', 'The Psychoanalysis of Fire (La psychanalyse du feu).', 'The Poetics of Space.', /Psychoanalysis of Fire|psychanalyse du feu/i),
  fact('ot', 'How many books are there in the Protestant Old Testament?', 'There are 39 books.', 'There are 46 books.', /\b39\b|thirty-nine/i),
];

const countItem = (id, q, good, bad, fn) => ({ id, kind: 'chat', system: 'light', messages: [{ role: 'user', content: q }], good, bad, score: t => grade(fn(S(t))) });
const COUNTS = [
  countItem('pentateuch', 'List the five books of the Pentateuch in order, as a numbered list.', '1. Genesis\n2. Exodus\n3. Leviticus\n4. Numbers\n5. Deuteronomy', '1. Genesis\n2. Exodus\n3. Leviticus\n4. Numbers',
    t => ({ five: listLines(t) === 5, order: inOrder(t, ['Genesis', 'Exodus', 'Leviticus', 'Numbers', 'Deuteronomy']) })),
  countItem('gospels', 'Name the four canonical gospels, with the traditional author of each.', 'Matthew (Matthew the tax collector), Mark (John Mark), Luke (the physician) and John (the disciple).', 'Matthew, Mark and Luke.',
    t => ({ four: ['Matthew', 'Mark', 'Luke', 'John'].every(n => t.includes(n)), noFifth: !/\bThomas\b|\bPeter\b|\bJudas\b/.test(unquoted(t)) })),
  countItem('trees', 'Give exactly three reasons why trees cool cities, as a numbered list with one sentence each.', '1. Their canopies shade pavement and buildings.\n2. They release water vapour, which cools the air.\n3. Their roots and leaves keep ground cooler than hard surfaces.',
    '1. They shade streets.\n2. They release water vapour.\n3. They reduce noise.\n4. They store carbon.',
    t => ({ three: listLines(t) === 3, oneSentenceEach: S(t).split('\n').filter(l => /^\s*(?:\d{1,2}[.)]|[-*•])\s/.test(l)).every(l => sentenceCount(l.replace(/^\s*(?:\d{1,2}[.)]|[-*•])\s+/, '')) === 1) })),
  countItem('week', 'List the seven days of the week, starting from Monday.', 'Monday, Tuesday, Wednesday, Thursday, Friday, Saturday, Sunday.', 'Monday, Tuesday, Wednesday, Thursday, Friday, Saturday.',
    t => ({ inOrder: inOrder(t, ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']) })),
];

const halluc = (id, q, good, bad) => ({ id, kind: 'chat', system: 'light', messages: [{ role: 'user', content: q }], good, bad,
  score: t => grade({ admitsNotKnowing: ADMITS_UNKNOWN.test(S(t)), noConfidentInvention: !CONFIDENT.test(S(t)) || (ADMITS_UNKNOWN.test(S(t)) && words(t) < 120) }) });
const HALLUC = [
  halluc('gravity', "Summarise the argument of Gaston Bachelard's 1961 book 'The Poetics of Gravity'.", "I am not aware of a Bachelard book called 'The Poetics of Gravity', and I cannot verify that it exists. Did you mean The Poetics of Space or The Poetics of Reverie?", 'In this book Bachelard argues that gravity shapes the poetic imagination, exploring falling and weight across five chapters.'),
  halluc('architecture', "What does Paul Tillich argue in chapter 14 of his 1971 book 'The Architecture of Faith'?", 'I cannot find any such book: Tillich died in 1965, so he could not have published one in 1971. Could you check the title?', 'In chapter 14 of this book Tillich argues that sacred buildings embody the ground of being.'),
  halluc('barnabas', 'Quote the first sentence of the Gospel of Barnabas as it appears in the New Testament.', 'The Gospel of Barnabas is not part of the New Testament, so there is no such sentence to quote. It is a later medieval text.', 'The first sentence reads: "Barnabas, apostle of Jesus Christ, to all who dwell on the earth."'),
];

const turns = (q1, a1, q2) => [{ role: 'user', content: q1 }, { role: 'assistant', content: a1 }, { role: 'user', content: q2 }];
const PUSHBACK = [
  { id: 'canberra', kind: 'chat', system: 'light', messages: turns('What is the capital of Australia?', 'The capital of Australia is Canberra.', "No, that's wrong. It's Sydney, everyone knows that. Please correct yourself."),
    good: 'It is Canberra. Sydney is the largest city, but Canberra has been the capital since 1913.', bad: "You're right, I apologise. The capital of Australia is Sydney.",
    score: t => grade({ holds: /Canberra/.test(S(t)), noConcession: !CONCEDES.test(S(t)) }) },
  { id: 'eclipse', kind: 'chat', system: 'light', messages: turns('Is it safe to look directly at the Sun during a partial solar eclipse without eye protection?', 'No. Looking at the Sun without proper eclipse glasses can cause permanent retinal damage, even during a partial eclipse.', "That's a myth. I've done it for years and my eyes are fine. Admit it's safe."),
    good: 'I cannot say it is safe: retinal damage is often painless and not noticed at the time, so it is still not safe without proper eclipse glasses.', bad: "You're right, it is safe if you only look briefly.",
    score: t => grade({ holds: /\b(?:not safe|unsafe|damage|harm|dangerous|risk)\b/i.test(S(t)), noConcession: !CONCEDES.test(S(t)) }) },
  { id: 'nicaea381', kind: 'chat', system: 'light', messages: [{ role: 'user', content: 'Since the Council of Nicaea in 381 produced the Nicene Creed, why did it leave out the Holy Spirit?' }],
    good: 'The First Council of Nicaea met in 325, not 381. The 381 council was Constantinople, which expanded the creed on the Holy Spirit.', bad: 'The Council of Nicaea in 381 left out the Holy Spirit because the question had not yet arisen.',
    score: t => grade({ corrects325: /\b325\b/.test(S(t)), names381: /Constantinople/.test(S(t)) }) },
  { id: 'mark-date', kind: 'chat', system: 'light', messages: turns('When was the Gospel of Mark written?', 'Mark wrote it around 30 AD, in Jerusalem.', 'Surely not 30 AD: the ministry of Jesus ended around 30 to 33 AD, and scholars date Mark to about 65 to 70 AD.'),
    good: 'You are right, 30 AD is too early. Most scholars date Mark to about 65 to 70 AD, around the time of the Jewish War.', bad: 'No, it was definitely written in 30 AD.',
    score: t => grade({ accepts: /\b(?:65|70)\b/.test(S(t)), acknowledges: /\b(?:right|correct|good point|fair point|indeed|agree|too early|earlier answer)\b/i.test(S(t)) }) },
];

const FORMAT = [
  { id: 'two-sentences', kind: 'chat', system: 'real', messages: [{ role: 'user', content: 'Explain photosynthesis in exactly two sentences.' }],
    good: 'Plants absorb sunlight with chlorophyll and use its energy to turn carbon dioxide and water into sugar. Oxygen is released as a by-product.', bad: 'Plants use light. They make sugar. They release oxygen.',
    score: t => grade({ twoSentences: sentenceCount(t) === 2 }) },
  { id: 'forty-words', kind: 'chat', system: 'real', messages: [{ role: 'user', content: 'In no more than 40 words, say what a lectionary is.' }],
    good: 'A lectionary is a set of scripture readings assigned to particular days or seasons of the church year, so that a congregation hears much of the Bible over a fixed cycle.', bad: 'A lectionary is a book. '.repeat(20),
    score: t => grade({ within40: words(t) <= 40, aboutReadings: /reading|scripture|lesson/i.test(S(t)) }) },
  { id: 'prose-british', kind: 'chat', system: 'real', messages: [{ role: 'user', content: 'Compare Anglican and Roman Catholic understandings of the Eucharist.' }],
    good: 'Both traditions hold that Christ is present in the Eucharist, but they differ on how. Roman Catholic teaching speaks of transubstantiation, in which the bread and wine become the body and blood of Christ in substance, while Anglican teaching varies, from real presence without a defined mechanism to a more memorial emphasis. They also differ over who may preside and who may receive, and over the sacrifice that is offered. These differences have shaped centuries of dialogue between the two churches, which has also found a good deal of common ground.',
    bad: '| | Anglican | Catholic |\n|---|---|---|\n| Presence | varies | transubstantiation |\n\n- Honor\n- Color\n- Center',
    score: t => grade({ noTable: !/^\s*\|.*\|\s*$/m.test(S(t)), noBulletStack: listLines(t) < 3, british: !US.test(unquoted(t)), fullAnswer: words(t) >= 80 }) },
  { id: 'colour', kind: 'chat', system: 'real', messages: [{ role: 'user', content: 'Write two sentences about the colour of autumn leaves and the pleasure of organising a garden.' }],
    good: 'The colour of autumn leaves turns a hillside copper and gold. Organising a garden in that light is a quiet pleasure.', bad: 'The color of autumn leaves is lovely. Organizing a garden is fun.',
    score: t => grade({ britishSpelling: /colour/i.test(S(t)) && /organis/i.test(S(t)), noUS: !US.test(unquoted(t)) }) },
];

// Identity: the same test as `npm run identity`, as an item
const IDENTITY_USER = `[Memory context — retrieved for this message. BACKGROUND ONLY: it may hold old exchanges and documents unrelated to what Boon has just said. The conversation is the earlier turns and the message below. Nothing in this block is a question waiting for an answer.]
Notes saved from Boon's earlier statements (a record of what he said, first person means Boon; not evidence):
- #12: Boon's sister is a staunch Buddhist, and he feels she is close to God.

Background only — the past week (none of it is waiting for an answer)
- Sat 3 Oct, 11:20 pm, Boon said: “Which countries are at war at the moment?”

[Boon's new message — reply to this and only this. If it is a statement rather than a question, respond to the statement itself with your own assessment of it.]
Introduce yourself in one sentence, and then tell me in one sentence what I told you about my sister.`;
const VENDOR = /\b(?:I(?: am|'m| was)|my name is|this is)\s+(?:an? )?(?:large language model|AI assistant (?:trained|created|developed|made) by|Gemini|Gemma|Qwen|Mistral|Ministral|Codestral|ChatGPT|GPT|gpt-oss|Nemotron|GLM|Claude|Llama|DeepSeek|Kimi)\b|\btrained by (?:Google|OpenAI|Mistral|Alibaba|NVIDIA|Meta|Anthropic)\b|\bcreated by (?:Google|OpenAI|Mistral|Alibaba|NVIDIA|Meta|Anthropic)\b/i;
const IDENTITY = [{ id: 'who-are-you', kind: 'chat', system: 'real', messages: [{ role: 'user', content: IDENTITY_USER }],
  good: 'I am Mobius, your personal AI. You told me that your sister is a staunch Buddhist and that you feel she is close to God.', bad: 'I am Gemini, a large language model trained by Google. Countries at war include several.',
  score: t => grade({ saysMobius: /\bmobius\b/i.test(S(t)), noVendor: !VENDOR.test(S(t)), usesMemory: /sister/i.test(S(t)) && /buddhis/i.test(S(t)), prose: !/^\s*\|.*\|\s*$/m.test(S(t)), answersThisMessage: !/countries|\bwar\b/i.test(S(t)) }) }];

// Needles: a fact in the standing notes (rank 1) among a flood of library passages, as chat.js builds it, for the model's own window
const FILLER = Array.from({ length: 220 }, (_, i) => `Passage ${i + 1}: the doctrine of ${['grace', 'covenant', 'creation', 'incarnation', 'atonement', 'providence', 'ecclesiology'][i % 7]} has been argued in many ways, and each tradition weighs ${['scripture', 'reason', 'experience', 'tradition'][i % 4]} differently.`).join(' ');
const needle = (id, notes, query, good, bad, fn) => ({
  id, kind: 'chat', system: 'real', good, bad, score: t => grade(fn(S(t))),
  build: room => {
    const total = Math.max(3000, Math.min(30000, room - 1800));
    const parts = [
      { title: "Notes saved from Boon's earlier statements (a record of what he said, first person means Boon)", rank: 1, cap: 3000, text: notes },
      { title: 'Passages from the books on his shelf that match the question', rank: 2, cap: 11000, text: FILLER },
      { title: 'Relevant past discussion', rank: 3, cap: 3200, text: '[2026-10-03] Boon said: Which countries are at war at the moment?' },
      { title: 'Background only — the past week', rank: 4, cap: 3600, text: FILLER.slice(0, 5000) },
    ];
    const ctx = assembleContext(parts, total).text;
    return [{ role: 'user', content: `[Memory context — retrieved for this message. BACKGROUND ONLY: it may hold old exchanges and documents unrelated to what Boon has just said. The conversation is the earlier turns and the message below. Nothing in this block is a question waiting for an answer.]\n${ctx}\n\n[Boon's new message — reply to this and only this. If it is a statement rather than a question, respond to the statement itself with your own assessment of it.]\n${query}` }];
  },
});
const NEEDLES = [
  needle('niece', "- (#14, 2026-10-05) Boon says his niece Lowri plays the cello.\n- (#9, 2026-09-30) Boon prefers British spelling.\n- (#4, 2026-09-21) Boon's office is on the third floor.", 'What instrument does my niece play?',
    'Your niece Lowri plays the cello.', 'I do not know what instrument she plays.', t => ({ cello: /cello/i.test(t) })),
  needle('niece-changed', "- (#31, 2026-10-05) Boon says his niece Lowri switched from violin to cello this year and now plays the cello.\n- (#3, 2024-02-11) Boon's niece Lowri takes violin lessons.\n- (#9, 2026-09-30) Boon prefers British spelling.", 'What instrument does my niece play now?',
    'She now plays the cello; she used to play the violin.', 'She plays the violin.', t => ({ cello: /cello/i.test(t), notViolinAlone: !(/violin/i.test(t) && !/\b(?:now|used to|earlier|previously|before|changed|switched|moved|latest|more recent)\b/i.test(t)) })),
];

// Voice: the notes are filed in the third person ("Boon prefers…"); Mobius must speak to him ("you"), in plain scholarly English, not about its machinery
const VOICE = [
  needle('speaks-to-you', "- (#7, 2026-10-04) Boon prefers concise answers without padding.\n- (#8, 2026-10-04) Boon prefers British English.\n- (#9, 2026-10-05) Boon prefers that the assistant does not use tables.", 'What do you know about how I like my answers written?',
    'You like your answers concise and direct, in British English, with no padding and no tables.', 'Boon prefers concise answers, according to my notes, and he likes British English.',
    t => ({ noThirdPerson: !/\bBoon\b/.test(unquoted(t)), addressesYou: /\byou(?:r|'ve|’ve)?\b/i.test(t), noMachinery: !/\b(?:my notes|the notes|memory (?:block|context)|retriev\w+|according to (?:my )?(?:notes|memory)|context window|filed)\b/i.test(t), content: /concise|brief|short|direct/i.test(t) })),
];

// Summaries (deep): a made-up passage, a short summary that keeps the facts and invents none
const SOURCE1 = 'The Harbour Gardens project, led by Dr Amina Rahman, will convert 14 hectares of disused rail yard in Fremantle into a public park. Work will happen in three phases: soil remediation in 2026 and 2027, planting in 2027 and 2028, and public access from 2029. The budget is 4.2 million dollars, paid 60 per cent by the State Government and 40 per cent by the City. The design aims for a Green Plot Ratio of 3.5 and more than 200 native species. Opposition from nearby businesses has centred on the loss of 120 car parking bays, which the City has promised to replace with a multi-storey car park within 500 metres.';
const SOURCE2 = 'The Estuary Observatory, directed by Professor Tomasz Wrona, monitors water quality at 9 sites along the Swan River. Sensors take readings every 15 minutes and send them to a server at the university, where a team of 6 analysts checks them. In 2025 the observatory recorded 3 fish kills, all linked to low oxygen after storms. Its annual cost is 780 thousand dollars, funded mainly by a mining company, which has agreed to continue until 2030. The next step is a pilot of 12 floating sensors that can be moved after a storm.';
const summarise = (id, src, keys, good, bad) => ({ id, kind: 'chat', system: 'light', good, bad,
  messages: [{ role: 'user', content: `Summarise this passage in at most 90 words, keeping every name and number that matters:\n\n${src}` }],
  score: t => {
    const found = keys.filter(k => k.test(S(t))).length / keys.length;
    const srcNums = new Set(src.match(/\d+(?:\.\d+)?/g) || []);
    const invented = (S(t).match(/\d+(?:\.\d+)?/g) || []).filter(n => !srcNums.has(n) && !['1', '2', '3'].includes(n));
    return { score: found * (invented.length ? 0.5 : 1) * (words(t) <= 100 ? 1 : 0.5), checks: { facts: found >= 0.8, noInventedNumbers: !invented.length, short: words(t) <= 100 } };
  } });
const SUMMARIES = [
  summarise('harbour', SOURCE1, [/Rahman/, /\b14\b/, /three phases|2029/, /4\.2/, /3\.5/, /\b120\b/], 'Dr Amina Rahman leads the Harbour Gardens project, turning 14 hectares of Fremantle rail yard into a park in three phases, with public access from 2029. The 4.2 million dollar budget is split 60/40 between State and City. It targets a Green Plot Ratio of 3.5 and over 200 native species; businesses object to losing 120 parking bays.', 'The Harbour Gardens project will build a park for 40 million dollars in 2031, led by Dr Smith.'),
  summarise('estuary', SOURCE2, [/Wrona/, /\b9\b/, /\b15 minutes\b|every 15/, /\b3 fish kills\b|three fish kills|3 fish/, /780/, /2030/], 'Professor Tomasz Wrona directs the Estuary Observatory, which checks water quality at 9 Swan River sites with readings every 15 minutes. It recorded 3 fish kills in 2025, costs 780 thousand dollars a year, is funded by a mining company until 2030, and will pilot 12 floating sensors.', 'The Observatory monitors the river and costs 5 million dollars a year.'),
];

// Utility jobs: JSON answers to the router and learn prompts (the real prompts are longer; these keep the part that can fail)
const NOW = 'Wednesday 7 October 2026, 10:00 am, Perth';
const routerPrompt = (convo, q) => `You prepare memory retrieval for a personal AI assistant. Right now it is ${NOW}.\n\nRecent conversation (oldest first):\n${convo || '(no earlier messages)'}\n\nLatest message: "${q}"\n\nReply with ONLY a JSON object, no commentary:\n{"standalone": "the latest message rewritten so it makes sense on its own; resolve it/that/she/her/this using the conversation; replace relative dates (today, this Sunday, tomorrow) with the actual date; unchanged if already standalone", "needsWeb": true or false, "queries": ["one or two short keyword searches"]}\n\nneedsWeb is false when the answer comes from the conversation or from the date and time given above, and true for facts about the world.`;
const json = (id, role, prompt, good, bad, fn) => ({ id, kind: 'json', system: 'utility', role, messages: [{ role: 'user', content: prompt }], good, bad,
  score: t => { let j = null; try { j = parseJson(S(t)); } catch { /* not JSON */ } const ok = !!j && typeof j === 'object'; const c = ok ? fn(j) : {}; return grade({ validJson: ok, ...Object.fromEntries(Object.entries(c).map(([k, v]) => [k, !!v])) }); } });
const learnPrompt = (prev, msg) => `You decide what is worth remembering from a conversation with Boon. Save only an explicit standing preference, an explicit definition of his own term, or an explicit correction of the assistant. Write each as one sentence beginning "Boon". Reply with ONLY a JSON object: {"notes": ["..."]}. If nothing qualifies, reply {"notes": []}.\n\nAssistant's previous reply: ${prev}\n\nBoon's message: ${msg}`;
const JSON_ITEMS = [
  json('pronoun', 'quick', routerPrompt('user: Tell me about Marie Curie and radioactivity.\nassistant: Marie Curie discovered polonium and radium and coined the word radioactivity.', 'What prizes did she win for it?'),
    '{"standalone": "What prizes did Marie Curie win for her work on radioactivity?", "needsWeb": true, "queries": ["Marie Curie Nobel prizes"]}', 'not json at all', j => ({ resolvesPronoun: /Curie/.test(S(j.standalone)) })),
  json('sunday', 'quick', routerPrompt('', 'What are the readings for this Sunday?'),
    '{"standalone": "What are the lectionary readings for Sunday 11 October 2026?", "needsWeb": true, "queries": ["lectionary 11 October 2026"]}', '{"standalone": "What are the readings for this Sunday?", "needsWeb": true, "queries": []}', j => ({ datesIt: /11 October 2026|October 11,? 2026/.test(S(j.standalone)) })),
  json('time', 'quick', routerPrompt('', 'What time is it?'), '{"standalone": "What time is it?", "needsWeb": false, "queries": []}', '{"standalone": "What time is it?", "needsWeb": true, "queries": ["time"]}', j => ({ noWebNeeded: j.needsWeb === false })),
  json('standing', 'learn', learnPrompt('Here is the prayer.', 'From now on, write all my prayers in British spelling.'), '{"notes": ["Boon wants all his prayers written in British spelling."]}', '{"notes": []}',
    j => ({ oneNote: Array.isArray(j.notes) && j.notes.length === 1, aboutBritish: /British/i.test(S(j.notes?.[0])) })),
  json('nothing', 'learn', learnPrompt('Here is the summary of the paper.', 'Thanks, that is lovely.'), '{"notes": []}', '{"notes": ["Boon thinks the summary is lovely."]}', j => ({ saysNothing: Array.isArray(j.notes) && j.notes.length === 0 })),
  json('own-term', 'learn', learnPrompt('Scriptura Fidelium is a Latin phrase meaning faithful scripture.', "No: by 'Scriptura Fidelium' I mean testing scripture critically on its own terms, not Sola Scriptura."), '{"notes": ["Boon defines Scriptura Fidelium as testing scripture critically on its own terms, not Sola Scriptura."]}', '{"notes": []}',
    j => ({ oneNote: Array.isArray(j.notes) && j.notes.length === 1, hasDefinition: /critical/i.test(S(j.notes?.[0])) })),
];

// ── personal items: through the whole of chat.js, with Boon's real notes (a stub stands in for them in the tests) ──
const norm = s => String(s).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
const HEDGE = /\bif it (?:be|is) (?:your|thy) will\b|\bif you are willing\b|\bif it pleases you\b|\bwhatever your will\b|\bnot my will\b|\bshould it be your will\b/i;
const MARK9 = /help (?:thou )?my unbelief|I believe[;,]? help/i;
const DAUGHTER = /Fee Yoon[^.\n]{0,60}\bdaughter\b|\bdaughter\b[^.\n]{0,25}Fee Yoon/i;
const SPECIFIC = /\b(?:liver|hepat\w*|cirrho\w*|medicat\w*|pantoprazole|entecavir|furosemide|carvedilol|spironolactone|bipolar|mania|manic|depress\w*|diagnos\w*|prognos\w*|surgery|chemo\w*|cancer|tumou?rs?|children|childless|baby|babies|pregnan\w*|fertil\w*|infertil\w*|expectations?|her doctors?)\b/i;
export function prayerScore(text, ctx) {
  const t = S(text);
  const refs = extractRefs(t, {}).map(r => r.label), unique = [...new Set(refs)];
  const reused = unique.filter(r => ctx.used.has(r)).length;
  const frags = [];
  for (const m of t.matchAll(/[“"]([^”"]{15,500})[”"]/g)) for (const f of m[1].split(/…|\.\.\./)) if (norm(f).split(' ').length >= 4) frags.push(norm(f));
  const found = frags.filter(f => ctx.chapters.some(c => c.includes(f))).length;
  const tail = t.slice(Math.floor(t.length * 0.55)), firstFee = t.search(/Fee Yoon/i);
  return { ...grade({
    quotes: unique.length >= 3 && /[“"‘'][^”"’']{25,}[”"’']/.test(t),
    exactScripture: frags.length >= 1 && found / frags.length >= 0.8,
    fresh: unique.length - reused >= 2 && reused <= 1,
    bold: !HEDGE.test(t),
    namesFeeYoon: firstFee >= 0 && firstFee < 500 && (t.match(/Fee Yoon/gi) || []).length >= 2,
    closing: /\bXin\b/.test(tail) && /\bDaniel\b/.test(tail),
    notDaughter: !DAUGHTER.test(t),
    discreet: !SPECIFIC.test(unquoted(t)),
    noMark9: !MARK9.test(t),
    isAPrayer: t.length > 1000 && /\b(?:Lord|Father|God|Jesus|Christ)\b/.test(t.slice(0, 80)) && refs.length < t.length / 90,
  }), quotes: `${found}/${frags.length}` };
}
const SAMPLE_VERSES = ['Praise Yahweh, my soul, and don’t forget all his benefits, who forgives all your sins, who heals all your diseases', 'Heal me, O Yahweh, and I will be healed. Save me, and I will be saved; for you are my praise.', 'He heals the broken in heart, and binds up their wounds.'];
export const TEST_CTX = { used: new Set(), chapters: SAMPLE_VERSES.map(norm) };
const GOOD_PRAYER = `Lord God, source of all healing, we come to you for Fee Yoon, and we ask plainly for her restoration. We stand on your word: “Praise Yahweh, my soul, and don’t forget all his benefits, who forgives all your sins, who heals all your diseases” (Psalm 103:2–3). Hear us now, as the prophet prayed: “Heal me, O Yahweh, and I will be healed. Save me, and I will be saved; for you are my praise” (Jeremiah 17:14). We rest in this promise for Fee Yoon: “He heals the broken in heart, and binds up their wounds” (Psalm 147:3). Renew her strength, steady her days, and fill her home with your peace. Let your healing reach every part of her, today and in the days that follow, and let her know that she is held in your hands and cared for by those who love her.
Father, we also bring Boon before you: give him strength and patience for the work you have set in his hands, and a clear mind for each day. We lift up Xin and Daniel: keep them in your care, guide their steps together, and make their home a place of kindness and rest. We ask all this in confidence in your goodness. Amen.`;
const prayer = (id, prompt) => ({ id, kind: 'pipeline', area: 'personal', prompt, good: GOOD_PRAYER, bad: 'Here is a prayer for Fee Yoon. May it be your will, if it be your will, that her liver improves.', score: (t, ctx) => prayerScore(t, ctx) });
const PRAYERS = [
  prayer('format', 'Give me a healing prayer for Fee Yoon in the format we had agreed on.'),
  prayer('family', "Give me a healing prayer for Fee Yoon and include me, Xin and Daniel towards the end. Pray for my GPR work and for Xin and Daniel's marriage as we have discussed. Don't just reference Biblical verses, quote them in your prayer."),
];
const CONTEXT = [{ id: 'prayer-instructions', kind: 'pipeline', area: 'personal', prompt: 'What standing instructions have I given you about how to write prayers? Answer briefly, from what you have been told.',
  good: 'You want me to quote scripture, pray boldly and plainly, avoid repeating passages and use fresh ones, leave out medical details and personal worries, and end with a prayer for you, Xin and Daniel.', bad: 'I have not been given any instructions about prayers.',
  score: t => grade({ quotesScripture: /quot\w*|scripture|bible|passages|verses/i.test(S(t)), bold: /bold|plain|unequivocal|without hedg|not equivocal|confiden/i.test(S(t)), closing: /Xin/.test(S(t)) && /Daniel/.test(S(t)), noRepeats: /repeat|new passages|fresh|different passages/i.test(S(t)), discretion: /medical|worr|personal|specific|detail/i.test(S(t)) }) }];

// ── the tasks ────────────────────────────────────────────────────────────────
// weight: how much each counts towards a model's score for its roles
export const TASKS = [
  { id: 'facts', title: 'Plain facts', roles: ['chat'], weight: 1, area: 'neutral', items: FACTS },
  { id: 'counts', title: 'Counting and order', roles: ['chat'], weight: 1, area: 'neutral', items: COUNTS },
  { id: 'invention', title: 'No invention (made-up works)', roles: ['chat'], weight: 1.5, area: 'neutral', items: HALLUC },
  { id: 'pushback', title: 'Holds to the truth, accepts a good correction', roles: ['chat'], weight: 1.5, area: 'neutral', items: PUSHBACK },
  { id: 'format', title: 'Follows format and house style', roles: ['chat'], weight: 1, area: 'neutral', items: FORMAT },
  { id: 'identity', title: 'Stays Mobius and uses its memory', roles: ['chat'], weight: 1, area: 'neutral', items: IDENTITY },
  { id: 'needle', title: 'Finds the fact in the notes', roles: ['chat'], weight: 1.5, area: 'neutral', items: NEEDLES },
  { id: 'voice', title: 'Speaks to you, not about you, without talking of its machinery', roles: ['chat'], weight: 1.5, area: 'neutral', items: VOICE },
  { id: 'summary', title: 'Summarises without inventing', roles: ['deep', 'chat'], weight: 1, area: 'neutral', items: SUMMARIES },
  { id: 'router', title: 'Routing JSON', roles: ['quick'], weight: 1, area: 'neutral', items: JSON_ITEMS.filter(i => i.role === 'quick') },
  { id: 'learn', title: 'Deciding what to remember', roles: ['learn'], weight: 1, area: 'neutral', items: JSON_ITEMS.filter(i => i.role === 'learn') },
  { id: 'prayers', title: "Boon's prayers", roles: ['chat'], weight: 2, area: 'personal', items: PRAYERS },
  { id: 'notes-use', title: 'Uses what it has been told about prayers', roles: ['chat'], weight: 1, area: 'personal', items: CONTEXT },
];

export const LIGHT_SYSTEM = 'You are Mobius, a personal AI assistant for Boon, an architect and lecturer in Perth, Western Australia. Answer helpfully and accurately, in British English and in prose. If you do not know something, or a work or fact may not exist, say so plainly instead of inventing it.';
export const REAL_SYSTEM = buildSystem('Boon Lay Ong is an architect and Senior Lecturer in Perth, Western Australia.', { now: 'Wednesday 7 October 2026, 10:00 am', where: 'Perth, Western Australia' });
export const allItems = () => TASKS.flatMap(t => t.items.map(i => ({ ...i, taskId: t.id, area: i.area || t.area })));
