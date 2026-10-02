# Mobius — CLAUDE.md

Personal AI chat with tiered memory (PCM) and web search. Rewritten 1 Oct 2026; the previous version is in `..\Mobius(old)` and in git history.

## Keep (the three fixed points)
1. Free cloud models: Gemini 2.5 Flash → Mistral Small → Cerebras gpt-oss-120b → Groq gpt-oss-120b (`backend/ai/cascade.js`). A model that fails is skipped for a while (1 min after a rate limit, 6 h after 402/404/bad key). When one dies, check the provider's live model list: Groq retired llama-3.3-70b-versatile, and Cerebras began returning "payment required" in Oct 2026.
2. Supabase as the memory store (shared "dlbs" project, `mobius_` tables)
3. Simple chat UI (`frontend/index.html`, vanilla JS, unchanged by the rewrite)

## How a message is handled (`backend/chat.js`)
1. Load the last 12 messages verbatim (memory tier 1).
2. `pcm/router.js` makes one cheap model call: standalone rewrite of the message, search queries, which projects it concerns, whether the archive is needed. Rule-based fallback if every model fails.
3. Recall in parallel: profile, week digest, archive search, named document, web search (Tavily, on for every non-trivial message).
4. `pcm/assemble.js` builds a budgeted context pack (≈30K chars; sections ranked, lowest-ranked cut first).
5. Stream the answer from the cascade; save both messages; embed a few backlog rows in the background.

Memory failures never stop the chat; each recall step degrades to "nothing found".

## The four memory tiers
| Tier | Holds | Stored in | Refreshed by |
|---|---|---|---|
| 1 Immediate | last 12 messages verbatim + 7-day digest | `mobius_messages`, `mobius_memory` kind `week` | digest: `pcm/maintain.js` |
| 2 Personal | profile of Boon | `mobius_memory` kind `profile` | weekly *proposal*; Boon approves |
| 3 Current | one note per project active in the last 30 days | `mobius_memory` kind `project` | incremental, from new messages |
| 4 Archive | every message and document | `mobius_messages`, `mobius_docs`, `mobius_docs_full` | live; embeddings filled in the background |

Archive search is hybrid (vector + keyword, fused in SQL: `pcm_search_messages`, `pcm_search_docs`). With Gemini's quota exhausted it degrades to keywords only.

## Profile approval (no UI yet)
- `GET /api/pcm/profile` shows the active profile and any waiting proposal
- `/api/pcm/profile/approve` and `/api/pcm/profile/reject` decide it
- `POST /api/pcm/profile` with `{"content": "..."}` writes the profile directly

## Login (passkeys)
- On only when `SESSION_SECRET` is set (set on Vercel, not locally, so localhost stays open). Code: `backend/auth.js`, page: `frontend/login.html`, passkeys in `mobius_passkeys` (RLS on).
- First visit to the live site shows the sign-in page; use `SETUP_CODE` (Vercel env var) to register each device once, then fingerprint / Windows Hello PIN logs in. Sessions last 30 days (signed cookie).
- Passkeys are tied to the site's hostname (`mobius-pwa.vercel.app`); they do not work on localhost, a Tailscale IP or another Vercel domain.
- Lost every device? Use `SETUP_CODE` to register a new one. To switch login off, remove `SESSION_SECRET` in Vercel and redeploy.

## Layout
```
backend/
  server.js        routes only (the /api contract the UI expects — keep stable)
  auth.js          passkey login + session gate
  self.js          self-awareness: date/place, device, server, the Mobius manual (aboutSelf questions)
  version.js       the "Last updated" stamp
  chat.js          one chat turn
  config.js        env + constants (the only place env vars are read)
  db.js util.js web.js maintain-cli.mjs
  ai/              cascade.js, prompt.js
  pcm/             router, retrieve, assemble, maintain, memory, messages, embed
  docs/            store, extract, drive
frontend/          PWA (do not change without being asked)
supabase/schema.sql   idempotent; run in the Supabase SQL Editor
```

## Run
- `start.bat` / `stop.bat` — local server on port 3005
- `npm run maintain` — memory jobs now, no time limit, drains the embedding backlog (`-- --drive` also syncs Drive)
- `GET /api/pcm/status` — counts and last maintenance; `/api/pcm/maintain` runs the jobs
- Vercel cron `/api/cron/daily` is time-boxed; the local server runs upkeep every 6 hours

## Rules
- Embeddings are Gemini only (`gemini-embedding-001`, 1024-dim). Never mix providers in one column.
- `C:\_myProjects` is a junction to `D:\_myProjects`; `start.bat` uses the D: path on purpose — do not "fix" it.
- Cerebras free tier has an 8K-token context; `fit()` in `cascade.js` trims prompts per provider.
