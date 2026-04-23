# mobius — Architecture & Logic Spec
_Version 2.0 — April 2026_
_Supersedes v1.1. Reflects decisions made in development sessions 3-5 Apr 2026._

---

## 1. Vision

mobius is a browser-based AI coding assistant and PWA — a personal Claude Desktop
equivalent, but running in the browser and routing to the best available model. Interaction
is conversational: you type naturally, commands are prefixed keywords that route queries
to the right pipeline.

It runs on any device and works offline. On a laptop it can reach Ollama for local models.
On a phone it uses WebLLM (browser-side inference). When online, cloud models and GitHub
become available.

It is NOT an IDE. It is a thinking and coding partner that understands your project context
and helps you diagnose, write, fix, and review code — step by step, with your approval
at each gate.

### Boon's role
Boon is the director — front office. He sets goals, approves direction, and judges outcomes.
He does not track files, read diffs, or follow the internal state of the repo closely.
Mobius presents plain English summaries. Gates are outcome decisions, not technical reviews.

---

## 2. Interaction Model

```
> Debug: the startup panel isn't showing Ollama models
> Code: write a function that parses triage.json and returns the file list
> Explain: what does routeToModel() do?
> Ask: Gemini what's the best way to handle stateless sessions in Vercel?
```

Plain text without a command prefix routes to the default model (Gemini Flash).

---

## 3. Connectivity & Capability Matrix

Detected on load by connectivity.js and re-checked on every online/offline event.

### Detection sequence (on init)

```
1. navigator.onLine          -> online / offline
2. ping /api/health          -> Vercel reachable
3. Supabase ping             -> DB connected
4. GitHub API                -> authenticated, repo accessible
5. ping Ollama local server  -> Ollama available? which models loaded?
6. navigator.gpu             -> WebGPU available (WebLLM eligible)
7. _context/ files           -> present and fresh (age check)
8. _debug/ folder            -> any unfinished debug session?
```

### Capability matrix

| State | Device | AI models available | Repo/file access |
|---|---|---|---|
| Offline | Laptop | Ollama (Qwen, DeepSeek) | Local via server.js |
| Offline | Phone | WebLLM (browser inference) | None |
| Online | Laptop | Ollama + Gemini + Codestral + Groq | GitHub + local via server.js |
| Online | Phone | WebLLM + Gemini + Codestral + Groq | GitHub only |

---

## 4. PWA & Local Server Architecture

mobius is a PWA with server.js as its native layer — equivalent to Claude Desktop's
Electron main process.

```
Browser (PWA — renderer)
    index.html + js/
    |
    fetch to localhost:3000
    |
server.js (Node — native layer)
    reads mobius_config.json
    spawns / proxies MCP servers
    |
MCP servers
    filesystem  -> local disk read/write
    github      -> repo operations
    fetch       -> live docs, APIs
```

### mobius_config.json
Mirrors Claude Desktop's claude_desktop_config.json. Defines which MCP servers are
available and what directories they can access.

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["@modelcontextprotocol/server-filesystem"],
      "allowedDirs": ["C:\\Users\\263350F\\_myProjects\\Mobius\\mobius"]
    },
    "github": {
      "url": "https://server.smithery.ai/github"
    }
  }
}
```

### Electron (future path)
The PWA + server.js architecture is Electron-compatible. When the app is stable and
ready for distribution, server.js becomes Electron's main process and the PWA becomes
the renderer. No code changes required beyond packaging.

### Constraint
All filesystem and MCP operations require server.js to be running at localhost:3000.
This is the same constraint as Ollama -- user starts server.js before opening mobius.

---

## 5. Repo Layout

```
mobius/
|
+-- index.html                  <- single page app shell
+-- CLAUDE.md                   <- project rules for Claude Desktop sessions
+-- mobius_config.json          <- MCP server config (mirrors claude_desktop_config.json)
+-- vercel.json                 <- Vercel routing
+-- service-worker.js           <- PWA offline shell + asset caching
+-- package.json
+-- deploy.bat                  <- deploy to Vercel (also runs update-map)
|
+-- js/                         <- all JS (browser scripts + Node utility scripts)
|   +-- commands.js             <- command registry, parser, all handlers
|   +-- connectivity.js         <- startup self-check, status panel
|   +-- panel.js                <- right-side output panel
|   +-- debug.js                <- debug pipeline state machine (Steps 7-8)
|   +-- session.js              <- session state, IndexedDB persistence
|   +-- webllm.js               <- WebLLM offline inference
|   +-- catalogue.js            <- Node utility: parses commands.js -> _context/.catalogue
|   +-- update-map.js           <- Node utility: incremental .map update (runs in deploy.bat)
|
+-- api/                        <- Vercel serverless functions
|   +-- _ai.js                  <- model routing
|   +-- agent.js                <- GitHub tool loop (commit, merge)
|   +-- health.js               <- startup ping -> { ok, supabase }
|   +-- status.js               <- model health check
|   +-- query/[action].js       <- /ask and /parse endpoints
|   +-- _supabase.js            <- DB helpers incl. diary + fault log writes
|
+-- _context/                   <- project context files (gitignored)
|   +-- CLAUDE.md               <- project rules, stack, conventions (written manually)
|   +-- .map                    <- file tree + one-liner per file (Map: command)
|   +-- .catalogue              <- command signatures (catalogue.js)
|
+-- _debug/                     <- debug session state (gitignored, runtime only)
|   +-- fault_log.json          <- machine-readable fault history indexed by file
|   +-- triage.json
|   +-- diagnosis.json
|   +-- proposal.json
|   +-- test_result.json
|   +-- fix/                    <- sandbox files only -- never real files
```

---

## 6. Command Registry

| Command | Default Model | Context Bundle |
|---|---|---|
| Debug: | Groq (brief) / Gemini (diagnose) / Codestral (fix) | See Section 8 |
| Code: | Codestral | CLAUDE.md + .map + relevant files |
| Fix: | Codestral | CLAUDE.md + specific file only |
| Explain: | Gemini Flash | CLAUDE.md + specific file only |
| Review: | Gemini Flash | CLAUDE.md + .map + specific files |
| Ask: Gemini | Gemini Flash | CLAUDE.md + history (last 10) |
| Ask: Codestral | Codestral | CLAUDE.md + history |
| Ask: Qwen | Qwen 2.5-coder (Ollama) | CLAUDE.md + history |
| Ask: DeepSeek | DeepSeek-R1 (Ollama) | CLAUDE.md + history |
| Map: | server.js + Groq | Walks tree via filesystem MCP, fills gaps with Groq |
| Deploy: | server.js | Git commit + merge, triggers Vercel auto-deploy |
| _(plain text)_ | Gemini Flash | CLAUDE.md + history |

---

## 7. Dev Diary & Fault Log

This is the institutional memory of mobius. It replaces the need for .repo
and prevents the AI from guessing about the history or state of the codebase.

### 7.1 Dev Diary (Supabase)

Every coding session is logged as a diary entry in Supabase. After every session,
Groq reads the raw session notes and writes a plain English summary entry.

**Supabase table: dev_diary**
```
id           uuid
project      text        -- 'mobius'
session_date date
summary      text        -- Groq-written plain English summary
files_touched text[]     -- which files were worked on
outcome      text        -- 'deployed', 'wip', 'reverted', 'abandoned'
raw_notes    text        -- full session notes (never injected into AI)
created_at   timestamptz
```

The diary is a chronological record of how the app was developed -- what decisions
were made, what was changed, what broke, what customisations exist. It is the answer
to "why is this code written this way?"

### 7.2 Fault Log (local JSON + Supabase)

Machine-readable fault history indexed by file. Never injected wholesale -- queried
by file key at triage time.

**Local: _debug/fault_log.json**
```json
{
  "api/_ai.js": [
    {
      "date": "2026-04-03",
      "error": "Codestral returning undefined on choices[0]",
      "rootCause": "null check missing before destructure",
      "fix": "added optional chaining on choices?.[0]",
      "worked": true,
      "session": "03Apr26-afternoon"
    }
  ],
  "js/commands.js": []
}
```

**Supabase table: fault_log**
Same structure as local JSON but persistent across machines and sessions.
Local JSON is the working copy. Supabase is the master record.
Synced at the end of every debug session.

### 7.3 Log Summary (rolling, Groq-maintained)

A short plain English summary of recent activity across the whole project.
Groq rewrites this at the end of every session. Never more than 300 words.
This is what gets injected at the start of every AI interaction.

**Location: _context/log_summary.md**
```
Last updated: 2026-04-05 17:46

Recent activity (last 7 days):
- service-worker.js: updated cache name, fixed SHELL_URLS (5 Apr)
- manifest.json: fixed icon path mismatch, added 192px entry (5 Apr)
- js/catalogue.js: new file -- parses commands.js for .catalogue (5 Apr)
- _context/CLAUDE.md: written -- project context for AI injection (5 Apr)

Known fragile areas:
- Ollama CORS: requires localhost:3000 proxy. Breaks if server.js not running.
- Gemini quota: hits rate limits under heavy use. Falls back to Groq.
- CACHE_NAME: must be updated manually in service-worker.js before each deploy.

Last deploy: 04Apr26 17:46 -- clean. All startup checks green.

Active issues: none.
```

---

## 8. Debug Pipeline

### Governing principles
- AI never guesses. It reads before it speaks.
- AI never writes to real files. Sandbox only (_debug/fix/).
- Backup runs before every promote.
- Boon sees plain English summaries -- not diffs, not code.
- Gates are outcome decisions: fix it / don't fix it.
- No autonomous looping. After every step: stop, report, wait.
- Boon decides. Always.

### Pipeline overview

```
Debug: fired
    |
    Brief Assembly (Groq -- fast, cheap)
        Reads: log_summary.md + fault_log[affected files] + error text
        Asks: has this been seen before? which files are involved?
        Writes: _debug/triage.json
        Gate: Boon sees plain English summary -- approve / add files / abort
    |
    Diagnose (Gemini Flash)
        Reads: triage.json + named file contents (read via server.js MCP)
        Finds: root cause, file, line numbers, confidence
        Writes: _debug/diagnosis.json
        Gate: Boon sees -- "Found in api/_ai.js line 47. Cause: X." -- approve / abort
    |
    Propose (Gemini Flash)
        Reads: diagnosis.json + same files
        Proposes: exact change, risks, plain English explanation
        Writes: _debug/proposal.json
        Gate: Boon sees -- "Change X in file Y. Risk: low." -- fix it / don't fix it
    |
    Sandbox (Codestral)
        Reads: proposal.json + specific file
        Writes: fix to _debug/fix/filename -- NEVER touches real files
        Gate: auto (no approval needed -- real files not touched)
    |
    Promote
        Runs: backup.bat first -- always
        Shows: plain English summary of what will change
        Requires: Boon types CONFIRM
        Writes: real file updated + diary entry written + fault_log updated
        Commits: via agent.js (GitHub)
```

### Step details

**Brief Assembly**
- Model: Groq (Llama 3.3 70B) -- fast, cheap, good enough for file identification
- Input: error text + log_summary.md + fault_log.json[implicated files]
- Output: triage.json { type, files[], knownPattern, confidence, summary }
- If known pattern from fault_log: surfaces the previous fix for Boon's awareness
- Gate: Boon approves file list. Can add files AI missed. Plain English only.

**Diagnose**
- Model: Gemini Flash
- Input: triage.json + actual file contents (read fresh via server.js, never from memory)
- Output: diagnosis.json { rootCause, file, lineNumbers, confidence, explanation }
- Rule: AI reads the file first. No assumptions about file contents.
- Gate: "Root cause found in [file] line [N]: [plain English explanation]." Approve / abort.

**Propose**
- Model: Gemini Flash
- Input: diagnosis.json + file contents
- Output: proposal.json { changes[], filesAffected[], risks[], plainEnglishSummary }
- Gate: "Will change [X] in [file]. This fixes [Y]. Risk: [low/medium/high]." Fix it / don't.

**Sandbox**
- Model: Codestral (code generation specialist)
- Input: proposal.json + file contents
- Output: writes to _debug/fix/[filename] only
- Real files: untouched
- Gate: none -- sandbox is safe

**Promote**
- Model: none -- filesystem write only
- Pre-condition: backup.bat must have run this session (enforced -- hard block if not)
- Input: _debug/fix/[filename]
- Actions: copy to real file + update fault_log + write diary entry + git commit via agent.js
- Requires: Boon types CONFIRM (not a button click -- a conscious decision)
- Post: diary entry written to Supabase, fault_log.json synced

### Offline limits
Promote requires online + GitHub. Offline sessions can proceed through sandbox.
Hard block at promote with message: "PROMOTE UNAVAILABLE -- offline. Changes in _debug/fix/."

---

## 9. Context Bundle Assembly

The minimum context needed at each step. Never inject more than this.

| Step / Command | Context injected |
|---|---|
| Session start | CLAUDE.md + log_summary.md |
| Brief assembly (triage) | log_summary.md + fault_log[files] + error text |
| Diagnose | triage.json + named file contents (read live) |
| Propose | diagnosis.json + named file contents (read live) |
| Sandbox | proposal.json + named file contents (read live) |
| Promote | proposal.json + backup confirmation |
| Code: | CLAUDE.md + .map + relevant files (read live) |
| Fix: | CLAUDE.md + specific file (read live) |
| Explain: | CLAUDE.md + specific file (read live) |
| Review: | CLAUDE.md + .map + specific files (read live) |
| Ask: | CLAUDE.md + log_summary.md + history (last 10) |

Rule: files are always read live via server.js MCP -- never from AI memory or cache.

---

## 10. Model Routing

| Model | Route | Best for |
|---|---|---|
| Groq Llama 3.3 70B | Groq API | Brief assembly, triage, fast queries |
| Gemini Flash | Google API | Diagnose, propose, explain, review |
| Codestral | Mistral API | Sandbox fix, Code:, Fix: |
| Gemini Flash-Lite | Google API | Simple Ask: queries, log summary writes |
| Qwen 2.5-coder | Ollama local | Offline Code:/Fix: |
| DeepSeek-R1 | Ollama local | Offline reasoning/fallback |

Ollama routes disabled if server.js not reachable.
WebLLM used offline on WebGPU-capable devices (phone).

---

## 11. Session Lifecycle & Persistence

### In-session
- Active debug state: in-memory debugSession object
- Survives page reload: IndexedDB
- Step JSON files: _debug/*.json (resumable if interrupted)

### End of session (automatic)
1. Groq writes session summary to dev_diary (Supabase)
2. fault_log.json synced to Supabase fault_log table
3. Groq rewrites _context/log_summary.md from recent diary entries
4. IndexedDB session cleared

### Supabase tables
- dev_diary: session-by-session journal of all development work
- fault_log: fault history indexed by file
- conversations: individual AI query/response pairs
- sessions: session metadata (start, end, model, tokens)
- user_profile: Boon's preferences and settings

---

## 12. Context Files

| File | Contains | Generated by | When |
|---|---|---|---|
| _context/CLAUDE.md | Project rules, stack, conventions | Written manually by Boon | Once, at bootstrap |
| _context/.map | File tree + one-liner per file | Map: command (server.js + Groq) | On demand + every deploy |
| _context/.catalogue | Command signatures from commands.js | js/catalogue.js (Node) | On demand |
| _context/log_summary.md | Rolling plain English activity summary | Groq (auto, end of session) | Every session |

Note: .repo dropped from plan. .map + live file reads via server.js MCP replaces it.
.catalogue scope: command signatures only. Not injected into debug pipeline.

### Bootstrap sequence
```
1. Boon writes _context/CLAUDE.md manually -- done
2. Run node js/catalogue.js -> generates _context/.catalogue
3. Run Map: command in Mobius -> generates _context/.map
4. First session -> Groq generates _context/log_summary.md
5. Startup check verifies all four files -> Ready
```

---

## 13. UI Layout

```
+-------------------------------------+
|  mobius           [model]  O  |  <- header: logo, model indicator, status dot
+-------------------------------------+
|                                     |
|  > TRIAGE    Logic bug -- api/_ai.js  v  |  <- completed step, collapsed
|                                     |
|  > DIAGNOSE                         |
|    Root cause: null check missing   |  <- active card, plain English
|    File: api/_ai.js  line 47        |
|    Confidence: High                 |
|    [Approve]  [Abort]               |  <- outcome gates -- no diffs
|                                     |
+-------------------------------------+
|  > input here ___________________   |  <- input bar
+-------------------------------------+
```

Card states:
- Completed: collapsed, single line summary, tick
- Active: expanded, plain English output, gate buttons
- Failed: highlighted, what went wrong, retry option

---

## 14. Startup Self-Check

```
+-------------------------------------+
|  STARTUP CHECK
|  v Network         online
|  v Vercel API      reachable
|  v Supabase        connected
|  v GitHub          authenticated
|  v Ollama          qwen3.5:35b-a3b, qwen2.5-coder:7b, deepseek-r1:7b
|  x WebLLM          WebGPU not available
|  ! Context files   log_summary.md missing -- run a session to generate
|  ! Debug session   unfinished session found
|
|  Ready.
+-------------------------------------+
```

- Auto-collapses after 5 seconds
- Unfinished debug session offers [Resume] / [Discard]
- Re-checks on online/offline events

---

## 15. Resolved Decisions

1. Boon is front office -- director only. AI presents plain English. No diffs, no code reviews.
2. AI never assumes file contents. Always reads live via server.js MCP before acting.
3. .repo dropped. Replaced by .map + live file reads.
4. .catalogue = command signatures only. Not a debug context file.
5. Groq is the brief assembler -- fast, cheap, good enough for file identification.
6. Fault log indexed by file -- queried by key, never injected wholesale.
7. Dev diary in Supabase -- institutional memory of the app's development history.
8. log_summary.md is the only log content injected into AI prompts -- 300 words max.
9. Promote requires: backup first + Boon types CONFIRM.
10. No autonomous looping. After every step: stop, report, wait. Boon decides. Always.
11. server.js is the native layer (MCP bridge). Electron is the future packaging path.
12. PWA install: manifest.json + service-worker.js done. 192px icon declared.
13. debug.js is a state machine -- not an AI. It sequences steps and manages _debug/ JSON.
14. All file writes in debug pipeline go to _debug/fix/ only until promote is confirmed.

---

## 16. What This Is NOT

- Not an IDE
- Not autonomous -- AI proposes, Boon approves every gate
- Not always-on -- server.js and Ollama must be running for local features
- Not a replacement for git -- all git ops via agent.js only
- Not a code reviewer for Boon -- Boon does not read diffs or code

---

_End of spec v2.0_
