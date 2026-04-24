# mobius — Coding Protocol

*Written: 5 Apr 2026Based on development session decisions, 3-5 Apr 2026*

---

## Philosophy

mobius is built on one principle: **AI proposes, Boon decides. Always.**

The AI is the back office. It reads, reasons, and recommends. Boon is the front office.
He sets direction, approves outcomes, and judges results. He does not track files, read
diffs, or follow the internal state of the repo closely.

The greatest risk in AI-assisted development is not a wrong answer -- it is an AI that
acts before it understands, guesses when it should verify, and writes when it should ask.
This protocol exists to prevent that.

---

## The Core Rules

1. **Never assume. Always verify.**
   AI reads the actual file before forming any opinion about its contents.
   No relying on memory. No assuming the file matches what was seen last session.

2. **Read before you write. Always.**
   Before proposing any change, AI reads the file it intends to change -- live, via
   server.js MCP. Not from context. Not from a previous message.

3. **Propose before acting.**
   AI never writes to real files directly. All changes go to _debug/fix/ first.
   Promotion to real files requires Boon's explicit CONFIRM.

4. **Log everything.**
   Every session, every fault, every fix is recorded. The log is the institutional
   memory of the project. AI reads it before each session -- not to guess, but to know.

5. **Minimum tokens, maximum precision.**
   Context is assembled surgically -- only what is needed for the current step.
   No wholesale file dumps. No injecting .repo into every prompt.

6. **Plain English to Boon. Always.**
   Gates present outcomes in plain English. Never diffs, never raw code,
   never technical jargon unless Boon asks for it.

---

## The Institutional Memory System

Three files form the memory layer. Together they tell the AI everything it needs to
know about the project without reading the entire codebase.

### 1. _context/CLAUDE.md
The project rulebook. Stack, conventions, constraints, key files.
Written once manually. Updated when the architecture changes.
Injected into every AI prompt.

### 2. _context/log_summary.md
A rolling 300-word plain English summary of recent activity.
Written automatically by Groq at the end of every session.
Covers: what was worked on, what changed, what is fragile, last deploy status.
This is the only log content ever injected into AI prompts.

Example:
```
Last updated: 2026-04-05 17:46

Recent activity:
- service-worker.js: fixed SHELL_URLS, updated cache name (5 Apr)
- manifest.json: fixed icon path, added 192px entry (5 Apr)

Known fragile areas:
- Ollama CORS: requires localhost:3000 proxy. Breaks if server.js not running.
- CACHE_NAME: must be updated manually before each deploy.

Last deploy: 04Apr26 17:46 -- clean.
```

### 3. _debug/fault_log.json
Machine-readable fault history indexed by filename.
Queried by file key at triage -- never injected wholesale.
Tells the AI: has this file broken before? What fixed it? Did it work?

```json
{
  "api/_ai.js": [
    {
      "date": "2026-04-03",
      "error": "Codestral returning undefined on choices[0]",
      "rootCause": "null check missing before destructure",
      "fix": "added optional chaining on choices?.[0]",
      "worked": true
    }
  ]
}
```

### 4. Supabase: dev_diary
The full chronological journal of the app's development.
Every session gets an entry -- what was worked on, what decisions were made,
what customisations exist and why.
AI reads this via a targeted Supabase query when it needs deeper history.
Never injected into routine prompts.

---

## Session Start Protocol

Every mobius session begins with this context:

```
Injected automatically:
  _context/CLAUDE.md       -- project rules and stack
  _context/log_summary.md  -- recent activity and known fragile areas
```

This is enough for the AI to understand the project state and give informed responses
without reading the entire codebase. If a command needs more -- a specific file,
a fault history entry -- it is fetched at that point, not before.

---

## The Debug Pipeline

When something breaks, Mobius follows a structured pipeline.
Each step is gated -- AI stops after every step and waits for Boon's decision.
No autonomous looping. No automatic retries. No assumptions.

### Step 1 -- Brief Assembly (Groq)

Groq is fast and cheap. Its job is identification, not diagnosis.

Reads:
- log_summary.md -- what changed recently?
- fault_log.json[affected files] -- has this broken before?
- The error text Boon provided

Produces: triage.json
```json
{
  "type": "logic bug",
  "files": ["api/_ai.js"],
  "knownPattern": true,
  "previousFix": "null check on choices?.[0] -- worked 3 Apr",
  "confidence": "high",
  "summary": "This looks like the same null check issue seen on 3 Apr in api/_ai.js."
}
```

Gate: Boon sees a plain English summary. He approves the file list, adds any files
AI missed, or aborts. This is where Boon's knowledge of the project gets injected.

### Step 2 -- Diagnose (Gemini Flash)

Reads the actual file contents live via server.js MCP. No assumptions.

Produces: diagnosis.json
```json
{
  "rootCause": "choices[0] accessed without null check on line 47",
  "file": "api/_ai.js",
  "lineNumbers": [47],
  "confidence": "high",
  "explanation": "When Codestral returns an empty choices array, accessing [0] throws undefined."
}
```

Gate: "Root cause found in api/_ai.js line 47: accessing choices[0] without a null check."
Boon approves or aborts.

### Step 3 -- Propose (Gemini Flash)

Reads diagnosis.json and the same file contents.

Produces: proposal.json
```json
{
  "changes": ["add optional chaining: choices?.[0]?.message?.content"],
  "filesAffected": ["api/_ai.js"],
  "risks": "low -- isolated change, no side effects",
  "plainEnglishSummary": "Add a null check on line 47. If Codestral returns nothing, return null instead of crashing."
}
```

Gate: "Will add a null check on line 47 of api/_ai.js. Risk: low."
Boon says fix it or don't.

### Step 4 -- Sandbox (Codestral)

Codestral is the code generation specialist. It writes the fix.

- Reads the actual file and the proposal
- Writes the fixed version to _debug/fix/api/_ai.js
- Real file is untouched
- No gate needed -- sandbox is safe

### Step 5 -- Promote

No AI involved. Pure filesystem operation.

Pre-conditions (enforced -- hard block if not met):
1. backup.bat has run this session
2. server.js is running

Actions:
1. Copy _debug/fix/[filename] to real file
2. Update fault_log.json with outcome
3. Write diary entry to Supabase dev_diary
4. Git commit via agent.js
5. Boon runs deploy.bat when ready

Requires: Boon types CONFIRM (not a button -- a conscious decision)

---

## Context Bundle by Command

Minimum context injected at each step. Never more than this.

| Command / Step | Context injected |
|---|---|
| Session start | CLAUDE.md + log_summary.md |
| Debug: brief assembly | log_summary.md + fault_log[files] + error text |
| Debug: diagnose | triage.json + named file contents (read live) |
| Debug: propose | diagnosis.json + named file contents (read live) |
| Debug: sandbox | proposal.json + named file contents (read live) |
| Code: | CLAUDE.md + .map + relevant files (read live) |
| Fix: | CLAUDE.md + specific file (read live) |
| Explain: | CLAUDE.md + specific file (read live) |
| Review: | CLAUDE.md + .map + specific files (read live) |
| Ask: | CLAUDE.md + log_summary.md + history (last 10) |

---

## Model Roles

Each model has a specific role. Models are not interchangeable.

| Model | Role | Why |
|---|---|---|
| Groq Llama 3.3 70B | Brief assembly, triage, log summary | Fast, cheap, good enough for identification |
| Gemini Flash | Diagnose, propose, explain, review | Strong reasoning, good at analysis |
| Codestral | Sandbox fix, Code:, Fix: | Code generation specialist |
| Gemini Flash-Lite | Simple Ask: queries | Cheapest cloud option |
| Qwen 2.5-coder | Offline Code:/Fix: | Local, no network needed |
| DeepSeek-R1 | Offline reasoning, fallback | Local reasoning model |

---

## File Write Rules

These rules are absolute. No exceptions.

1. AI never writes to real project files directly. Ever.
2. All AI-generated fixes go to _debug/fix/ only.
3. Promote copies from _debug/fix/ to real files -- after backup, after CONFIRM.
4. backup.bat must run before every promote. Hard block if skipped.
5. Every file write is logged to fault_log.json and dev_diary.

---

## End of Session Protocol

At the end of every coding session, Mobius automatically:

1. Groq reads the session's raw activity
2. Groq writes a summary entry to Supabase dev_diary
3. fault_log.json synced to Supabase fault_log table
4. Groq rewrites _context/log_summary.md from the last 7 days of diary entries
5. IndexedDB session state cleared

This keeps log_summary.md current without any manual work from Boon.

---

## What AI Must Never Do

- Guess at file contents instead of reading them
- Write to real files without a promote + CONFIRM
- Loop or retry automatically after a failed test
- Present code diffs or technical detail to Boon unprompted
- Assume a previous fix still applies without checking the fault log
- Inject the full dev_diary or fault_log into a prompt
- Act on a problem before assembling a brief from the log system

---

_End of coding-protocol.md_
