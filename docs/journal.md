# Mobius Development Journal

---

## Session 1 — Thu 24 Apr 2026

**With:** Claude Desktop (Sonnet 4.6) **Duration:** \~4 hours **Status at end of session:** Deployed, pending first SSE test

---

### What Mobius Is

Mobius_PWA is a multi-gate AI consensus PWA deployed on Vercel + Supabase. It implements the architecture in `docs/mobius_architecture_final.md`:

- **Gate 1** — 5 task AIs generate prompts in parallel; 5 evaluators score them; consensus requires 3/5 to score ≥90
- **Gate 1.5** — Gemini grounding discovers web sources; 5 task AIs vote on relevance
- **Execution** — 5 task AIs answer using the consensus prompt + selected sources; race resolves on first 3 responses
- **Gate 2** — 5 evaluators score the synthesised answer; up to 3 rewrite iterations
- **Cycles** — Gate 2 failure restarts Gate 1; max 5 full cycles before showing alternatives to user

The 5 task AIs are:

RoleModelAnalyst AIGroq Llama 3.3 70BResearcher AIGemini 2.5 FlashTechnical AIMistral CodestralCritical AIGemini 2.5 Flash-LiteSynthesiser AIOpenRouter (Groq fallback)

**Brief AI** (synthesis, Gate 2 rewrites): Gemini 2.5 Flash

---

### What Was Built This Session

#### Architecture completed (from Mobius_Coder base)

1. `api/orchestrate.js` — Step 1 (Gate 1 + Gate 1.5) and Step 2 (execution + Gate 2) handler
2. `api/orchestrate-stream.js` — NEW: SSE endpoint for Step 2; streams each AI response to client as it arrives
3. `api/_exec.js` — NEW: shared execution core imported by both orchestrate files (CONFIG, TASK_AIS, raceAtLeast, evaluateItem, runGate2)
4. `api/_ai.js` — AI model routing (Groq, Gemini, Mistral, OpenRouter, GitHub, Ollama)
5. `api/status.js` — startup ping for all 6 cloud models including OpenRouter
6. `api/sql/schema.sql` — Supabase tables: mobius_queries, mobius_eval_scores, mobius_source_tracking, mobius_model_performance (already run)

#### Client

7. `js/orchestrator.js` — full orchestration UI with:
   - Heartbeat ticker showing elapsed seconds during waits
   - Consensus prompt shown in log after Gate 1
   - SSE stream reader (streamStep2) — panel updates live as AIs respond
   - Right panel opens immediately with placeholder; each AI response appears as it arrives; scores update in real time
   - Decision Point 2 source card: manual URL paste + file upload (txt/md/html/json/csv)
   - Gate 1 alternatives panel (last cycle failure)
   - Gate 2 alternatives panel (max cycles reached)
   - Up to 5 full cycles before fallback
8. `js/connectivity.js` — startup ping enabled; statusDot reflects task AI health (green=all 5 ready, amber=some, red=none); Local AI check removed; role labels shown per AI
9. `js/commands.js` — orchestrator is now the DEFAULT for all plain-text queries (no Orch: prefix needed); ALL MODE and Brief Protocol still take priority when active

#### Infrastructure

10. `vercel.json` — routes: `/orchestrate/stream` → SSE endpoint, `/orchestrate` → JSON endpoint
11. `index.html` — title changed from Mobius_Coder to Mobius_PWA

---

### Key Design Decisions Made

- **Race pattern**: fire all 5 AIs, synthesise on first 3 responses — avoids blocking on slowest AI
- **Parallel Gate 1 + source discovery**: both run simultaneously on Step 1, saving \~5-10s
- **SSE for Step 2**: server pushes each AI response as it arrives rather than batching at the end
- **OpenRouter fallback**: Synthesiser AI falls back to Groq if OpenRouter is unavailable
- **Source card**: empty RAG (search failed) shows URL paste input + file upload instead of dummy checkboxes
- **statusDot**: repurposed from network indicator to task AI readiness indicator

---

### Known Issues / Next Session TODO

#### Priority 1 — Verify SSE works on Vercel Hobby plan

The SSE stream endpoint (`/orchestrate/stream`) was just deployed. Need to test whether Vercel's infrastructure allows true streaming (not buffered). If it buffers, the panel will still populate at the end rather than live. Fallback: revert Step 2 to the regular JSON endpoint.

**Test**: submit a query, watch the right panel — if AI responses appear one by one (8-15s apart) SSE is working. If they all appear simultaneously at the end, SSE is being buffered.

#### Priority 2 — Fix Google Search (RAG)

Gate 1.5 currently returns empty sources (`no-search-available`) for every query. `askGoogleSearch` in `api/_ai.js` uses Gemini's built-in grounding tool (`google_search`), but the grounding metadata (`groundingChunks`) is coming back empty. Options:

- Switch to Google Custom Search JSON API directly using `GOOGLE_API_KEY` + `GOOGLE_CSE_ID` (both already in Vercel Shared vars)
- Or switch to Tavily (`TAVILY_API_KEY` already in Vercel project vars) — simpler API, built for AI retrieval

Until search works, all answers are from model knowledge only. The consensus pipeline still runs but without real sources.

#### Priority 3 — Two-panel UX refinements

- Right panel: responses currently show raw text; apply `markdownToHtml` properly
- Score colour coding in panel (green ≥85, amber ≥70, red &lt;70) needs CSS var fixes
- Left panel: the `mq-block` border-left (accent colour) styling applied to the reuseOutputEl may collide with existing entry styles — verify visually

#### Priority 4 — Progressive Gate 1 evaluation

Currently Gate 1 waits for all 5 AIs to generate their prompts, then evaluates all 5 in one batch. Improvement: evaluate each prompt as it arrives (same race pattern as execution). Would save \~5s on Gate 1.

#### Priority 5 — Journal / session_task wiring

The `mcp.json` session_task fires a query on load for Claude Desktop sessions. Consider adding a journal-read task so Claude always starts with context. See `_dev/_session.md`.

---

### File Map (key files only)

```
Mobius/
  api/
    _exec.js              ← shared core (CONFIG, TASK_AIS, eval, runGate2)
    _ai.js                ← AI model routing
    _supabase.js          ← Supabase client
    orchestrate.js        ← Step 1 JSON handler (Gate 1 + Gate 1.5)
    orchestrate-stream.js ← Step 2 SSE handler (execution streaming)
    status.js             ← startup model ping
    sql/schema.sql        ← Supabase schema (already applied)
  js/
    orchestrator.js       ← full orchestration UI + SSE reader
    connectivity.js       ← startup ping + statusDot logic
    commands.js           ← command routing (orchestrator is default)
    panel.js              ← right panel API
    startup.js            ← session task + handle restore
  docs/
    mobius_architecture_final.md  ← canonical architecture spec
    journal.md                    ← this file
  index.html              ← main app shell (Mobius_PWA)
  vercel.json             ← routes
  deploy.bat              ← always deploy via this
```

---

### Environment Variables (Vercel)

**Project**:GITHUB_PAT, MISTRAL_API_KEY, GOOGLE_REDIRECT_URI, DROPBOX_APP_KEY, DROPBOX_APP_SECRET, DROPBOX_REDIRECT_URI, GITHUB_TOKEN, BASE_URL, GEMINI_API_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GROQ_API_KEY, SUPABASE_KEY, SUPABASE_URL, TAVILY_API_KEY

**Shared**:OPENROUTER_API_KEY, GOOGLE_CSE_ID, GOOGLE_API_KEY Note: Several show "Needs Attention" in Vercel UI — this means they are not marked Sensitive. Safe to ignore for solo project. Mark as Sensitive when adding team members (no key rotation needed).

---

### Supabase

Project: `sfvwhbzxklscfsnyrwq.supabase.co`Tables created (Apr 2026): mobius_queries, mobius_eval_scores, mobius_source_tracking, mobius_model_performance

## Session 2 — Fri 25 Apr 2026

**With:** Claude Desktop (Sonnet 4.6) **Status at end of session:** Deployed — cleanup complete

### What was done

Code audit of all files cloned from Mobius_Coder. 17 dead JS modules and 4 dead API files identified, archived, and removed. Script tags in index.html pruned. `sendToLastModel` in commands.js simplified. vercel.json dead routes removed.

#### Archived to `_archive/coder_modules/js/`

protocol.js, all.js, code.js, project.js, deploy.js, debug.js, map.js, codeindex.js, ask.js, refine.js, log.js, router.js, scores.js, help.js, catalogue.js, self_test.js, webllm.js

#### Archived to `_archive/coder_api/`

agent.js, index.js, data.js, \_memory.js, query/\[action\].js, services/\[action\].js

#### Kept in js/ (deferred -- not loaded, available if needed later)

memory.js, brief.js, chat.js, server.js (local dev)

#### Active JS files (loaded in index.html)

startup.js, commands.js, orchestrator.js, panel.js, connectivity.js

#### Changes to live files

- `index.html` -- script block pruned to 5 active files
- `js/commands.js` -- `sendToLastModel` simplified: Brief Protocol intercept removed; all queries route through orchestrator
- `vercel.json` -- dead routes removed (/codeindex, /api/data, /ask, /memory, /agent)

#### Note on api/services/\[action\].js

File could not be deleted (Windows access denied on bracket filename). Archived copy exists in `_archive/coder_api/services/`. Route removed from vercel.json so it is never served.

### Next session priority

Test the full pipeline at <https://mobius-pwa.vercel.app>:

1. Submit a query and watch Gate 1 log appear
2. Check whether SSE streams responses live (one-by-one) or batched at end
3. Verify source card appears after Gate 1.5
4. If SSE buffered on Vercel Hobby -- switch Step 2 back to JSON endpoint

---

## Session 3 — Fri 25 Apr 2026

**With:** Claude Desktop (Sonnet 4.6) **Status:** Deployed — protocol redesigned

### Protocol redesign

Replaced autonomous Gate 1/2 consensus loop with Boon-directed workflow.

**Step 1** (POST /orchestrate step:1):

- 5 Task AIs each suggest a prompt rewrite in parallel
- Brief AI synthesises one combined prompt from all suggestions
- Source discovery runs in parallel (placeholder -- search TBD)
- Returns: suggestions\[\], synthesised_prompt, sources\[\]

**Step 2** (POST /orchestrate/stream SSE):

- 5 Task AIs answer with Boon-approved prompt + selected sources
- Race resolves on first 3; waits up to 2 min for all 5
- Brief AI produces annotated evaluation summary
- Summary format: bullet points with \[N/5 agree: names\] + VERIFY/CONFLICT flags

**Panel discipline:**

- Right (preview): Task AI prompt suggestions, then Task AI answers
- Left (chat): query, status log, source card, prompt approval card, eval summary

**Decision points:**

1. Source card -- select URLs or skip
2. Prompt card -- Approve / Edit textarea / Redo with feedback
3. Eval card -- Accept / Edit prompt and redo (Step 2 only)

**Reject paths:**

- Reject prompt -- Boon adds feedback -- Step 1 reruns with feedback
- Reject answer -- Boon edits the PROMPT (not query) -- Step 2 reruns only

### Also fixed

- OpenRouter HTTP-Referer corrected to mobius-pwa.vercel.app
- OpenRouter model cascade updated to stable free models

### Removed

- Gate 1 evaluator scoring
- Gate 2 autonomous consensus loop
- 5-cycle restart logic

### Next session

1. Test full flow: <https://mobius-pwa.vercel.app>
2. Discuss search integration (Firecrawl vs Tavily)
3. Review AI lineup and system prompts

---

## Session 4 — Fri 25 Apr 2026

**With:** Claude Desktop (Sonnet 4.6) **Status:** Deployed — protocol refinements, labelling, Conductor finalised

### Changes

**Protocol fixes (from live testing)**

- Task AI response text: removed 3000-char truncation; full responses now transmitted
- Evaluation scoring: Groq now primary scorer (was Gemini Lite); Mistral fallback added
- Evaluation summary: Groq → Mistral fallback chain (Gemini fully removed from Conductor role)
- Prompt synthesis: Groq → Mistral fallback chain

**Conductor naming and routing**

- The AI that synthesises prompts and evaluation summaries is now formally named the **Conductor**
- Conductor runs on Groq (Llama 3.3 70B), falls back to Mistral (Codestral)
- Gemini is now strictly Task AI only (Researcher AI and Critical Reviewer)
- Header badge shows "Groq: Llama 3.3 70B" while orchestrator is running

**Model label format**

- All modelUsed labels now follow Stable: Model format throughout \_ai.js:
  - Groq: Llama 3.3 70B / Groq: Qwen QwQ 32B / Groq: Llama 3.1 8B
  - Gemini: 2.5 Flash / Gemini: 2.0 Flash / Gemini: Flash-Lite
  - Mistral: Codestral / Mistral: Small / Mistral: Nemo
  - OpenRouter: Llama 3.3 70B / OpenRouter: Qwen 2.5 72B / etc.

**OpenRouter fix**

- status.js ping updated to use meta-llama/llama-3.3-70b-instruct:free with correct HTTP-Referer
- connectivity.js display updated to "Llama 3.3 70B (free)"

**Timing**

- Task AI answer headers now show time taken per response (e.g. \[Groq: Llama 3.3 70B\] · 8.4s)
- Prompt suggestion headers also show time taken

**Evaluation summary format**

- Sections: Key Points / Differences / Concerns / Overall
- Each point annotated with \[N/5 agree: names\], VERIFY flags, CONFLICT flags
- Rendered as HTML via markdownToHtml (no raw # or \* symbols)

### AI role summary (current)

RoleModelStableAnalyst AILlama 3.3 70BGroqResearcher AIGemini 2.5 FlashGeminiTechnical AICodestralMistralCritical ReviewerFlash-LiteGeminiSynthesiser AILlama 3.3 70B (free)OpenRouterConductorLlama 3.3 70BGroq (Mistral fallback)

### Next session

- Search integration: Firecrawl vs Tavily for Step 1 source discovery
- Review AI lineup and Task AI system prompts (Boon has changes in mind)

---
