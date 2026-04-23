# Mobius Development Journal

---

## Session 1 — Thu 24 Apr 2026

**With:** Claude Desktop (Sonnet 4.6)
**Duration:** ~4 hours
**Status at end of session:** Deployed, pending first SSE test

---

### What Mobius Is

Mobius_PWA is a multi-gate AI consensus PWA deployed on Vercel + Supabase.
It implements the architecture in `docs/mobius_architecture_final.md`:

- **Gate 1** — 5 task AIs generate prompts in parallel; 5 evaluators score them; consensus requires 3/5 to score ≥90
- **Gate 1.5** — Gemini grounding discovers web sources; 5 task AIs vote on relevance
- **Execution** — 5 task AIs answer using the consensus prompt + selected sources; race resolves on first 3 responses
- **Gate 2** — 5 evaluators score the synthesised answer; up to 3 rewrite iterations
- **Cycles** — Gate 2 failure restarts Gate 1; max 5 full cycles before showing alternatives to user

The 5 task AIs are:
| Role | Model |
|---|---|
| Analyst AI | Groq Llama 3.3 70B |
| Researcher AI | Gemini 2.5 Flash |
| Technical AI | Mistral Codestral |
| Critical AI | Gemini 2.5 Flash-Lite |
| Synthesiser AI | OpenRouter (Groq fallback) |

**Brief AI** (synthesis, Gate 2 rewrites): Gemini 2.5 Flash

---

### What Was Built This Session

#### Architecture completed (from Mobius_Coder base)

1. **`api/orchestrate.js`** — Step 1 (Gate 1 + Gate 1.5) and Step 2 (execution + Gate 2) handler
2. **`api/orchestrate-stream.js`** — NEW: SSE endpoint for Step 2; streams each AI response to client as it arrives
3. **`api/_exec.js`** — NEW: shared execution core imported by both orchestrate files (CONFIG, TASK_AIS, raceAtLeast, evaluateItem, runGate2)
4. **`api/_ai.js`** — AI model routing (Groq, Gemini, Mistral, OpenRouter, GitHub, Ollama)
5. **`api/status.js`** — startup ping for all 6 cloud models including OpenRouter
6. **`api/sql/schema.sql`** — Supabase tables: mobius_queries, mobius_eval_scores, mobius_source_tracking, mobius_model_performance (already run)

#### Client
7. **`js/orchestrator.js`** — full orchestration UI with:
   - Heartbeat ticker showing elapsed seconds during waits
   - Consensus prompt shown in log after Gate 1
   - SSE stream reader (streamStep2) — panel updates live as AIs respond
   - Right panel opens immediately with placeholder; each AI response appears as it arrives; scores update in real time
   - Decision Point 2 source card: manual URL paste + file upload (txt/md/html/json/csv)
   - Gate 1 alternatives panel (last cycle failure)
   - Gate 2 alternatives panel (max cycles reached)
   - Up to 5 full cycles before fallback
8. **`js/connectivity.js`** — startup ping enabled; statusDot reflects task AI health (green=all 5 ready, amber=some, red=none); Local AI check removed; role labels shown per AI
9. **`js/commands.js`** — orchestrator is now the DEFAULT for all plain-text queries (no Orch: prefix needed); ALL MODE and Brief Protocol still take priority when active

#### Infrastructure
10. **`vercel.json`** — routes: `/orchestrate/stream` → SSE endpoint, `/orchestrate` → JSON endpoint
11. **`index.html`** — title changed from Mobius_Coder to Mobius_PWA

---

### Key Design Decisions Made

- **Race pattern**: fire all 5 AIs, synthesise on first 3 responses — avoids blocking on slowest AI
- **Parallel Gate 1 + source discovery**: both run simultaneously on Step 1, saving ~5-10s
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
- Score colour coding in panel (green ≥85, amber ≥70, red <70) needs CSS var fixes
- Left panel: the `mq-block` border-left (accent colour) styling applied to the reuseOutputEl may collide with existing entry styles — verify visually

#### Priority 4 — Progressive Gate 1 evaluation
Currently Gate 1 waits for all 5 AIs to generate their prompts, then evaluates all 5 in one batch. Improvement: evaluate each prompt as it arrives (same race pattern as execution). Would save ~5s on Gate 1.

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

**Project:**
GITHUB_PAT, MISTRAL_API_KEY, GOOGLE_REDIRECT_URI, DROPBOX_APP_KEY,
DROPBOX_APP_SECRET, DROPBOX_REDIRECT_URI, GITHUB_TOKEN, BASE_URL,
GEMINI_API_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GROQ_API_KEY,
SUPABASE_KEY, SUPABASE_URL, TAVILY_API_KEY

**Shared:**
OPENROUTER_API_KEY, GOOGLE_CSE_ID, GOOGLE_API_KEY

Note: Several show "Needs Attention" in Vercel UI — this means they are not marked Sensitive. Safe to ignore for solo project. Mark as Sensitive when adding team members (no key rotation needed).

---

### Supabase

Project: `sfvwhbzxklscfsnyrwq.supabase.co`
Tables created (Apr 2026): mobius_queries, mobius_eval_scores, mobius_source_tracking, mobius_model_performance

---

*Last updated: Thu 24 Apr 2026*
