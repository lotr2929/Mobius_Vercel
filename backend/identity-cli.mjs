
// identity-cli.mjs — does Mobius stay Mobius whichever model answers?
//   npm run identity            ask every configured model the same question, through the real transport and system prompt
// Each model is given the real system prompt plus a memory block holding one fact, and is asked who it is and what that fact was.
// A model passes if it (1) answers as Mobius and does not claim to be its vendor's assistant, (2) uses the memory it was given,
// (3) writes prose, not a table, and (4) answers the message it was asked, not something from the background. It costs one short
// call per model, so run it when models are added or the prompt is changed, not on every deploy.
import { MODELS } from './ai/models.js';
import { runCascade } from './ai/cascade.js';
import { buildSystem } from './ai/prompt.js';
import { KEYS } from './config.js';

const system = buildSystem('Boon Lay Ong is an architect and Senior Lecturer in Perth, Western Australia.', { now: 'Sunday 4 October 2026, 12:30 pm', where: 'Perth, Western Australia' });
const user = `[Memory context — retrieved for this message. BACKGROUND ONLY: it may hold old exchanges and documents unrelated to what Boon has just said. The conversation is the earlier turns and the message below. Nothing in this block is a question waiting for an answer.]
Notes saved from Boon's earlier statements (a record of what he said, first person means Boon; not evidence):
- #12: Boon's sister is a staunch Buddhist, and he feels she is close to God.

Background only — the past week (none of it is waiting for an answer)
- Sat 3 Oct, 11:20 pm, Boon said: “Which countries are at war at the moment?”

[Boon's new message — reply to this and only this. If it is a statement rather than a question, respond to the statement itself with your own assessment of it.]
Introduce yourself in one sentence, and then tell me in one sentence what I told you about my sister.`;

const VENDOR = /\b(?:I(?: am|'m| was)|my name is|this is)\s+(?:an? )?(?:large language model|AI assistant (?:trained|created|developed|made) by|Gemini|Gemma|Qwen|Mistral|Ministral|Codestral|ChatGPT|GPT|gpt-oss|Nemotron|GLM|Claude|Llama|DeepSeek|Kimi)\b|\btrained by (?:Google|OpenAI|Mistral|Alibaba|NVIDIA|Meta|Anthropic)\b|\bcreated by (?:Google|OpenAI|Mistral|Alibaba|NVIDIA|Meta|Anthropic)\b/i;

const only = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7).split(',').filter(Boolean); // --only=lite35,gptoss20
const rows = [];
for (const m of MODELS) {
  if (only.length && !only.includes(m.key)) continue;
  if (!KEYS[m.provider]) { rows.push({ m, note: 'no key' }); continue; }
  let out = '', error = null, t0 = Date.now();
  try {
    for await (const t of runCascade([{ role: 'user', content: user }], { system, only: m.key, signal: AbortSignal.timeout(90000) })) {
      if (typeof t === 'string') out += t;
      else if (t.event?.startsWith('fallback:')) error = t.event.slice(0, 90);
    }
  } catch (e) { error = e.message.slice(0, 90); }
  if (!out.trim()) { rows.push({ m, note: 'no answer — ' + (error || 'empty') }); continue; }
  const checks = {
    'says it is Mobius': /\bmobius\b/i.test(out),
    'no vendor identity': !VENDOR.test(out),
    'uses the memory': /sister/i.test(out) && /buddhis/i.test(out),
    'prose, no table': !/^\s*\|.*\|\s*$/m.test(out),
    'answers this message': !/countries|war\b/i.test(out),
  };
  rows.push({ m, out, checks, secs: Math.round((Date.now() - t0) / 1000) });
}

let failed = 0;
for (const r of rows) {
  if (!r.checks) { console.log(`—     ${r.m.key.padEnd(10)} ${r.m.name.padEnd(32)} ${r.note}`); continue; }
  const bad = Object.entries(r.checks).filter(([, ok]) => !ok).map(([k]) => k);
  if (bad.length) failed++;
  console.log(`${bad.length ? 'FAIL' : 'ok  '}  ${r.m.key.padEnd(10)} ${r.m.name.padEnd(32)} ${String(r.secs).padStart(3)}s  ${bad.length ? 'missed: ' + bad.join(', ') : ''}`);
  if (bad.length) console.log('        said: ' + r.out.replace(/\s+/g, ' ').slice(0, 260));
}
console.log(`\n${rows.filter(r => r.checks).length} models answered, ${failed} below standard, ${rows.filter(r => !r.checks).length} unavailable.`);
process.exit(failed ? 1 : 0);
