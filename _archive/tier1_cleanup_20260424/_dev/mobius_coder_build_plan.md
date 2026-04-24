# mobius — Build Plan
_Version 1.0 — April 2026_
_Reference spec: _dev/mobius_spec.md v1.1_

---

## Governing Rules

- Deploy and test each step before moving to the next
- No step touches files owned by a future step
- AI proposes all code — Boon approves before any file is written
- Each step has a clear, unambiguous pass/fail test
- If a step fails, fix it before proceeding — no carrying forward broken code

---

## Current State (as of April 2026)

- Repo: lotr2929/Mobius_Vercel (private)
- Live: https://mobius.vercel.app
- Vercel + Supabase: connected and configured
- commands.js: fully rewritten (coding commands only)
- api/_ai.js: model routing working (Groq, Gemini, Codestral, Ollama)
- CLAUDE.md: written
- index.html: inherited from Mobius_Vercel — needs full UI rewrite
- _context/: folder does not exist yet
- api/health.js: does not exist yet
- js/connectivity.js: does not exist yet

---

## Step 1 — Skeleton Shell

**Goal:** App loads, input bar works, plain text reaches Gemini and gets a response. Proves the full deployment pipeline is functional. New clean UI replaces the Mobius_Vercel index.html.

**Files to create/modify:**
- `index.html` — full rewrite: modern minimal UI (header, chat area, input bar)
- `api/health.js` — returns `{ ok: true, timestamp }`
- `vercel.json` — add /api/health route

**Pass test:**
1. Deploy to Vercel
2. Open app — new UI renders cleanly
3. Type "hello" -> Gemini responds in chat area
4. GET /api/health -> returns { ok: true }

---

## Step 2 — Connectivity Detection & Startup Panel

**Goal:** Full self-check on every session open. Startup status panel shown. Header status dot updates live.

**Files to create:**
- `js/connectivity.js` — detects network/Vercel/Supabase/GitHub/Ollama/WebLLM
- `js/ui.js` — startup panel rendering, card rendering infrastructure

**Checks:**
1. navigator.onLine -> network
2. /api/health ping -> Vercel reachable
3. Supabase ping -> DB connected
4. GitHub API -> repo accessible
5. Ollama ping -> models loaded
6. navigator.gpu -> WebGPU available
7. _context/ files -> present and fresh
8. _debug/ -> unfinished session?

**Pass test:**
1. Load app -> startup panel appears with correct status for each check
2. Disable WiFi -> header dot updates within 2 seconds
3. Panel auto-collapses after 5 seconds

---

## Step 3 — Command Routing & Ask:

**Goal:** All Ask: variants route correctly. Unavailable models greyed out.

**Files to modify:**
- `js/commands.js` — wire connectivity state to command availability
- `index.html` — connect commands.js to UI

**Commands wired:**
- Ask: Gemini -> Gemini Flash
- Ask: Codestral -> Mistral Codestral
- Ask: Groq -> Groq Llama
- Ask: Qwen -> Ollama qwen2.5-coder:7b
- Ask: DeepSeek -> Ollama deepseek-r1:7b
- plain text -> Gemini Flash (default)

**Pass test:**
1. Ask: Gemini what is 2+2 -> Gemini responds
2. Ask: Codestral write a JS hello world -> Codestral responds
3. Ask: Qwen offline -> greyed out with tooltip if Ollama not running
4. Model indicator in header shows which model responded

---

## Step 4 — Context Files Bootstrap

**Goal:** All four context files in _context/. Startup check reports their freshness.

**Actions (setup tasks, not code):**
1. Create _context/ folder
2. Write _context/CLAUDE.md manually (Boon)
3. Install codebase-memory-mcp -> generates .map
4. Create and run generate-catalogue.js -> generates .catalogue
5. Install codebase-mcp for .repo (on demand — Step 11)

**Pass test:**
1. _context/CLAUDE.md exists and readable
2. _context/.map exists with file tree + descriptions
3. _context/.catalogue exists with all commands
4. Startup panel shows correct status for context files

---

## Step 5 — Code: and Fix:

**Goal:** Code: and Fix: commands assemble context bundles and route to Codestral.

**Files to create:**
- `js/context.js` — buildBundle(step, session) function

**Files to modify:**
- `js/commands.js` — Code: and Fix: handlers use context.js

**Bundles:**
- Code: -> CLAUDE.md + .catalogue + .map + relevant files
- Fix: -> CLAUDE.md + specific file only

**Pass test:**
1. Code: write a function that reads a JSON file -> Codestral responds with working JS
2. Fix: js/commands.js the fallback model is missing -> targeted fix proposed
3. Token count in Supabase logs is not bloated

---

## Step 6 — Explain: and Review:

**Goal:** Explain: and Review: work with Gemini Flash and correct context.

**Files to modify:**
- `js/commands.js` — Explain: and Review: handlers use context.js

**Pass test:**
1. Explain: js/commands.js -> coherent plain-English explanation
2. Review: js/commands.js -> structured feedback (structure, naming, gaps)

---

## Step 7 — Debug Pipeline: Triage -> Diagnose -> Propose

**Goal:** First half of debug pipeline. Cards render, gate buttons work, JSON files written.

**Files to create:**
- `js/debug.js` — state machine: triage, diagnose, propose steps
- `js/session.js` — debugSession object, step tracking

**Files to modify:**
- `js/ui.js` — card rendering (completed/active/failed), gate buttons, inline JSON editor

**Pass test:**
1. Debug: js/commands.js Ask: Qwen is not routing correctly
2. Triage card appears -> type and files shown -> approve
3. Diagnose card appears -> root cause and lines -> approve
4. Propose card appears -> change with risks -> approve
5. _debug/triage.json, diagnosis.json, proposal.json written
6. Abort -> session cancelled, JSONs retained
7. Override -> inline JSON editor opens

---

## Step 8 — Debug Pipeline: Sandbox -> Test -> Promote

**Goal:** Second half. Fix to sandbox, test run, promote to real files.

**Files to create:**
- `api/run.js` — Node child_process shell execution
- `api/agent.js` update — filesystem write (sandbox + promote), git commit

**Files to modify:**
- `js/debug.js` — add sandbox, test, promote steps

**Governing rule:** After every test stop and report. No automatic looping. Boon decides.

**Pass test:**
1. Continue session from Step 7 through sandbox
2. _debug/fix/commands.js written — real js/commands.js unchanged
3. Test runs -> result reported -> gate shown (pass or fail)
4. On approval -> real file updated + git commit created
5. Attempt promote offline -> hard block message shown

---

## Step 9 — Session Persistence

**Goal:** Sessions survive page reload. Unfinished debug sessions detected on startup.

**Files to create/modify:**
- `js/session.js` — IndexedDB read/write, serialisation
- `api/_supabase.js` — log completed sessions

**Pass test:**
1. Start debug session -> close browser -> reopen -> startup shows unfinished session -> Resume restores state
2. Complete session -> Supabase row logged with metadata
3. Discard on startup -> _debug/ cleared -> fresh session

---

## Step 10 — WebLLM Offline (Phone)

**Goal:** Ask: routes to WebLLM browser inference when offline on WebGPU device.

**Files to modify:**
- `js/commands.js` — WebLLM routing branch
- `js/connectivity.js` — wire WebGPU detection to router

**Note:** WebLLM model downloads once on first use (online). Stored in browser cache.

**Pass test:**
1. Phone + WiFi -> download WebLLM model (one-time)
2. Phone + airplane mode -> Ask: explain recursion -> WebLLM responds
3. Code: offline on phone -> greyed out with tooltip

---

## Step 11 — Repomix MCP & .repo

**Goal:** codebase-mcp wired in. .repo generated on demand for Review: and deep Debug:.

**Files to modify:**
- `api/agent.js` — add codebase-mcp tool call
- `js/commands.js` — Review: requests .repo; deep Debug: requests .repo for architectural type
- `js/ui.js` — [Refresh .repo] button in startup panel

**Pass test:**
1. Review: entire codebase -> .repo generated and used -> architectural review returned
2. Startup panel shows .repo age + [Refresh] button works
3. Deep debug (architectural) -> .repo in propose bundle

---

## Summary

| Step | Focus | Complexity | Status |
|---|---|---|---|
| 1 | Skeleton shell + health endpoint | Low | Done ✅ |
| 2 | Connectivity + startup panel | Medium | Done ✅ |
| 3 | Command routing + Ask: | Medium | Done ✅ |
| 4 | Context files bootstrap | Low (setup) | Partial -- CLAUDE.md exists, .map and .catalogue not yet generated |
| 5 | Code: and Fix: | Medium | Done ✅ (Code: File added, file context auto-inject working) |
| 6 | Explain: and Review: | Low | Done ✅ |
| 7 | Debug pipeline pt.1 | High | Done ✅ |
| 8 | Debug pipeline pt.2 | High | Done ✅ |
| 9 | Session persistence | Medium | Partial -- localStorage scores done; IndexedDB debug session persistence not built |
| 10 | WebLLM offline | High | Stub only (js/webllm.js exists, not wired) |
| 11 | Repomix MCP | Medium | Not started |
| -- | Ask: All + voting + scores | Medium | Done ✅ (added this session) |
| -- | GPRTool-Demo integration | Ongoing | Project: Open + Code: File groundwork done; active testing next session |

---

_End of build plan v1.0_
