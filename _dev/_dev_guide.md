# mobius — Developer Guide
_Created: 2 Apr 2026_
_Last updated: 2 Apr 2026_

---

## What is mobius?

mobius is a focused coding assistant PWA forked from Mobius_Vercel. Where Mobius_Vercel is a general-purpose personal AI platform (health, Google Drive, Dropbox, calendar, email), mobius is stripped to a single purpose: **code generation, debugging, and code review**.

It is designed as an alternative to Claude Desktop for coding work — one that routes queries to the best available model (cloud or local) and can be extended with MCP tool servers for deeper repo and file access.

---

## Current Status

### Done ✅
- GitHub repo created: `lotr2929/Mobius_Vercel` (private)
- Vercel project created: `mobius.vercel.app`
- Supabase project created (isolated from Mobius_Vercel)
- Supabase schema created (5 tables: conversations, sessions, knowledge, user_profile, model_config)
- `.env.local` updated with new Supabase + Vercel credentials
- `deploy.bat` updated (paths, project ID, URLs)
- `_dev/poll_vercel.ps1` updated (reads deploy.env via relative path)
- `package.json` updated (name, deps — googleapis removed)
- `vercel.json` stripped (Google/Dropbox/sync routes removed)
- `server.js` updated (VERCEL_HOST → mobius.vercel.app)
- `api/agent.js` updated (REPO → lotr2929/Mobius_Vercel)
- `api/data.js` rewritten (Google/Focus/Sync removed, coding-focused)
- `api/query/[action].js` rewritten (Mobius persona replaced with coding persona, qwen35 routing added)
- `js/commands.js` rewritten (171KB → ~9KB, coding commands only)
- `CLAUDE.md` rewritten for mobius
- Folder structure reorganised:
  - `js/` — commands.js, server.js, self_test.js
  - `_dev/` — deploy scripts, poll scripts
  - `docs/` — README, MOBIUS_CONTEXT, dev_notes
- `login.html` / `signup.html` updated (title + h1: `mobius` with `_Coder` in dark green `#2d6a2d`)
- `manifest.json` updated (name: mobius)
- Logo created: `mobius-logo.png` (Möbius ribbon wrapping a C)
- `favicon.ico` regenerated (multi-size: 16/32/48/64/128/256px)
- `_dev/_dev_guide.md` created (this file)
- `documents/` folder deleted (stale Mobius_Vercel runtime artifacts)
- `claude_desktop_config.json` deleted from repo root (stale copy)

### Still To Do ⏳
- [ ] Copy new logo files into project root (user action):
  - `mobius-logo.png` → replaces `mobius-logo.png`
  - `mobius-logo-192.png` → new
  - `favicon.ico` → replaces existing
- [ ] Update HTML/manifest references from `mobius-logo.png` → `mobius-logo.png`
- [ ] `index.html` — full UI rewrite for coding focus (model selector, code display, startup panel)
- [ ] `api/services/[action].js` — review and strip Google-specific status endpoints
- [ ] `js/self_test.js` — update test URLs/endpoints for mobius
- [ ] First deploy via `deploy.bat` and end-to-end test
- [ ] Add `GITHUB_PAT` to `.env.local` for agent.js repo operations
- [ ] MCP layer — Phase 4: add GitHub/fetch/filesystem MCPs to api/agent.js

---

## Command Set

| Command | Purpose |
|---|---|
| `Code: [request]` | Generate code |
| `Debug: [error + code]` | Diagnose and fix errors |
| `Fix: [code + issue]` | Minimal targeted patch |
| `Explain: [code]` | Walk through what code does |
| `Review: [code]` | Code review and suggestions |
| `Ask: Groq [q]` | Groq Llama 3.3 70B (cloud, fast) |
| `Ask: Gemini [q]` | Gemini 2.5 Flash (cloud) |
| `Ask: Codestral [q]` | Mistral Codestral (cloud coder) |
| `Ask: Qwen35 [q]` | Qwen3.5 35B (local, most powerful) |
| `Ask: Qwen [q]` | Qwen2.5-coder 7B (local, fast) |
| `Ask: DeepSeek [q]` | DeepSeek R1 7B (local, reasoning) |
| `Web: [query]` | Web search via Tavily |
| `Find: [name]` | Search local files (File System Access API) |
| `Status: models` | Check all AI model availability |

---

## AI Models

### Cloud
- **Groq Llama 3.3 70B** — default, fast, free tier
- **Gemini 2.5 Flash** — vision capable, good for complex queries
- **Mistral Codestral** — specialist code model, best for generation tasks

### Local (via Ollama)
Ollama must be running via `start-ollama.bat` (IPEX-LLM, Intel Arc accelerated).

| Model | Size | Best for |
|---|---|---|
| `qwen3.5:35b-a3b` | 23 GB | Heavy code generation, complex reasoning |
| `qwen2.5-coder:7b` | 4.7 GB | Fast local coding queries |
| `deepseek-r1:7b` | 4.7 GB | Debugging, step-by-step reasoning |

---

## MCP Integration (planned — Phase 4)

mobius is designed to leverage MCP (Model Context Protocol) tool servers for deeper coding capabilities. MCP servers allow the AI to perform real actions — reading files, calling APIs, querying repos — rather than just generating text.

### What MCPs are
MCP servers are standardised tool endpoints that AI clients can call. Smithery.ai (smithery.ai) and MCP Market are registries hosting thousands of community-built MCP servers. Smithery servers can be run locally via CLI or accessed as hosted remote endpoints.

### Planned MCP servers

| MCP | Source | Mode | Purpose |
|---|---|---|---|
| GitHub | Smithery (`https://server.smithery.ai/github`) | Hosted | Read/write repo files, PRs, issues, commits |
| Filesystem | Smithery (`npx @modelcontextprotocol/server-filesystem`) | Local | Read/write local project files |
| Fetch | Smithery (`https://server.smithery.ai/fetch`) | Hosted | Fetch live docs, APIs, Stack Overflow |
| Sequential Thinking | Smithery (`https://server.smithery.ai/sequentialthinking`) | Hosted | Structured step-by-step debugging |

### Integration approach
`api/agent.js` already has a Gemini tool-loop pattern from the GitHub integration. MCP calls will be added as additional tools in that loop — mobius calls the MCP endpoint, gets the result, and feeds it back into the AI context.

### Claude Desktop MCPs
Claude Desktop (`AppData\Roaming\Claude\claude_desktop_config.json`) currently only has the filesystem MCP. Adding GitHub, fetch, and sequential thinking MCPs to that config would give Claude Desktop the same tool access during development sessions — independent of mobius. Decision pending.

---

## Architecture

```
Browser (PWA)
    index.html + js/commands.js
    ↓ /ask, /parse
Vercel serverless
    api/query/[action].js — model routing + session logging
    ├── Groq API
    ├── Gemini API
    ├── Mistral API (Codestral)
    └── Ollama proxy (via js/server.js local)
        ├── qwen3.5:35b-a3b
        ├── qwen2.5-coder:7b
        └── deepseek-r1:7b
Supabase (sfvwhbzxklscfsnyrwq.supabase.co)
    ├── conversations
    ├── sessions
    ├── knowledge
    ├── user_profile
    └── model_config
```

---

## Project Structure

```
mobius/
├── index.html          — main UI (⏳ needs full rewrite)
├── login.html          — auth (updated)
├── signup.html         — auth (updated)
├── manifest.json       — PWA manifest (updated)
├── service-worker.js   — PWA offline shell
├── favicon.ico         — multi-size icon (updated)
├── mobius-logo.png  — main logo (⏳ copy from downloads)
├── mobius-logo-192.png — PWA icon (⏳ copy from downloads)
├── package.json        — Node deps (updated)
├── vercel.json         — routing (stripped)
├── .env.local          — secrets (updated, gitignored)
├── CLAUDE.md           — Claude Desktop context (updated)
├── deploy.bat          — deploy to Vercel (updated)
├── deploy.env          — Vercel credentials (updated, gitignored)
├── js/
│   ├── commands.js     — all client-side command handlers (rewritten)
│   ├── server.js       — local dev server (updated)
│   └── self_test.js    — post-deploy health check (⏳ needs update)
├── api/
│   ├── _ai.js          — AI model routing (unchanged from Mobius_Vercel)
│   ├── _supabase.js    — Supabase helpers (unchanged)
│   ├── agent.js        — GitHub tool loop (REPO updated)
│   ├── data.js         — data endpoints (rewritten)
│   └── query/[action].js — /ask and /parse (rewritten)
├── _dev/
│   ├── _dev_guide.md   — this file
│   ├── poll_vercel.ps1 — deployment polling (updated)
│   ├── poll_test.ps1
│   ├── MobiusServer.bat
│   ├── backup.bat
│   └── download_sessions.*
└── docs/
    ├── README.md
    ├── MOBIUS_CONTEXT.md
    └── dev_notes.md
```

---

## Infrastructure

| Item | Detail |
|---|---|
| GitHub repo | `lotr2929/Mobius_Vercel` (private) |
| Vercel project | `mobius.vercel.app` |
| Vercel project ID | `prj_o3wt39gLQk1URzydKfhexcCyaaQW` |
| Supabase URL | `https://sfvwhbzxklscfsnyrwq.supabase.co` |
| Local dev URL | `http://localhost:3000` (`node js/server.js`) |
| Deploy | `deploy.bat` from project root |

---

## Differences from Mobius_Vercel

| Feature | Mobius_Vercel | mobius |
|---|---|---|
| Google Drive / Calendar / Gmail | Yes | No |
| Dropbox | Yes | No |
| Health / lifestyle commands | Yes | No |
| Mobius memory rulebook | Yes | No |
| Focus: file management | Yes | No |
| Code generation commands | Basic | Full (Code/Debug/Fix/Explain/Review) |
| Qwen3.5 35B routing | No | Yes |
| MCP tool integration | No | Planned Phase 4 |
| Supabase project | Mobius_Vercel DB | Separate isolated DB |
| Logo | Mobius ribbon | Möbius ribbon + C |
