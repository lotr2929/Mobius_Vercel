# MOBIUS_CONTEXT.md

# Persistent knowledge anchor for all Code: AI calls.

# Maintained manually by the developer after every significant change.

# Mobius reads this file before every audit and sends only relevant sections.

# Last updated: 2026-03-13

---

## Architecture

Mobius is a local-first PWA deployed on Vercel (Hobby plan). The frontend is a single HTML/JS chat interface. The backend is a set of Vercel serverless API functions (Node.js, CommonJS).

### File structure

```
Mobius_Vercel/
├── index.html              — Main chat UI (PWA shell)
├── login.html              — Login page
├── signup.html             — Signup page
├── commands.js             — Client-side command registry (colon-prefix commands)
├── actions.js              — Client-side action helpers
├── google_api.js           — Google API wrapper (Drive, Gmail, Calendar, Tasks)
├── server.js               — Local dev server (not used in Vercel deployment)
├── service-worker.js       — PWA service worker
├── manifest.json           — PWA manifest
├── vercel.json             — Vercel routing (PROTECTED — do not edit)
├── package.json            — Dependencies
└── api/
    ├── _ai.js              — AI model routing and fallback chain
    ├── _supabase.js        — Supabase client, saveConversation, getChatHistory
    ├── data.js             — Chat history, sync, Drive index file writing
    ├── upload.js           — File upload handler
    ├── auth/
    │   ├── [service].js    — Google + Dropbox OAuth (index, callback, status)
    │   ├── google/         — (empty — handled by [service].js)
    │   ├── dropbox/        — (empty — handled by [service].js)
    │   └── user/
    │       └── [action].js — Login / signup handlers
    ├── query/
    │   └── [action].js     — /ask and /parse entry points (main AI handler)
    ├── focus/              — Focus: command file context handlers
    ├── services/
    │   └── google.js       — Google account info, disconnect, Dropbox token ops
    └── sync/               — (empty — sync handled in data.js)
```

### Request flow

```
User types command in index.html
  → commands.js detects colon-prefix command
  → Client calls POST /parse (api/query/[action].js?action=parse)
    → Parses instruction mode, loads mobius.json awareness from Drive
    → Returns mobius_query object
  → Client calls POST /ask (api/query/[action].js?action=ask)
    → Routes to correct AI model via _ai.js
    → Saves conversation to Supabase via _supabase.js
    → Returns reply, modelUsed, postFlags
  → Client renders response in chat UI
```

### Command architecture

Commands use a colon-prefix pattern: `Command: argument`All command routing is handled client-side in `commands.js`. Single-word commands (no colon) are also recognised.

Current command families:

- Ask: AI query routing (groq, gemini, mistral, github, web, web2, web3, local, qwen, deepseek, webllm)
- Elaborate: Re-run last query in Long instruction mode
- Focus: Load a Google Drive file into context for the next query
- Sync: Sync Google data (Drive, Gmail, Calendar, Tasks) to Drive index files
- Dropbox: Dropbox connection and file listing (partially implemented)
- Code: \[PLANNED — see CODE_PIPELINE.code\]

---

## Vercel Function Consolidation

Vercel Hobby plan limit: 12 serverless functions. Current deployment uses 7 functions by routing via dynamic segments.

Key pattern — `vercel.json` routes are EXTERNAL DEPENDENCY LOCKS: The `src` values in vercel.json routes map to external URLs (OAuth callbacks, redirect URIs registered in Google Cloud Console and Dropbox App Console). Changing any `src` value WILL break OAuth without updating those external registrations first. Never edit vercel.json without explicit developer approval.

Current function mapping: api/auth/\[service\].js — handles all auth routes for all services api/query/\[action\].js — handles /ask and /parse api/data.js — handles chat history and sync api/upload.js — handles file upload api/auth/user/\[action\] — handles login and signup api/services/google.js — handles Google account management + Dropbox token ops api/focus/ — handles Focus: command file context

---

## Protected Files

These files must NEVER be edited by Code: fix without explicit --override confirmation from the developer:

vercel.json Reason: Route src values are registered as external OAuth redirect URIs. Changing them breaks Google and Dropbox OAuth without external reconfiguration.

api/\_supabase.js Reason: Core database client shared by all API functions. Breaking this breaks the entire backend.

api/auth/\[service\].js Reason: OAuth flow. Breaks Google and Dropbox authentication.

api/auth/user/\[action\].js Reason: User login and signup. Breaking this locks all users out.

MOBIUS_CONTEXT.md Reason: This file. Always update manually.

---

## Environment Variables

All stored in Vercel project settings. Never in codebase.

SUPABASE_URL Purpose: Supabase project REST endpoint Used by: api/\_supabase.js, api/auth/\[service\].js, api/services/google.js, api/data.js

SUPABASE_KEY Purpose: Supabase anon/service key Used by: api/\_supabase.js, api/auth/\[service\].js, api/services/google.js, api/data.js Note: Variable is referenced as SUPABASE_KEY in \_supabase.js. Known issue: Some files may reference SUPABASE_PUBLISHABLE_KEY — this is wrong, the correct variable name is SUPABASE_KEY.

GEMINI_API_KEY Purpose: Google Gemini AI (gemini-2.5-flash) Used by: api/\_ai.js

GROQ_API_KEY Purpose: Groq cloud AI (llama-3.3-70b-versatile) — default model Used by: api/\_ai.js

MISTRAL_API_KEY Purpose: Mistral AI (codestral-latest) Used by: api/\_ai.js

GITHUB_TOKEN Purpose: GitHub Models inference (gpt-4o via Azure) Used by: api/\_ai.js

GOOGLE_CLIENT_ID Purpose: Google OAuth app identity Used by: api/auth/\[service\].js

GOOGLE_CLIENT_SECRET Purpose: Google OAuth app secret Used by: api/auth/\[service\].js

GOOGLE_REDIRECT_URI Purpose: Registered OAuth callback URL — must match Google Cloud Console exactly Used by: api/auth/\[service\].js Warning: Changing this requires updating Google Cloud Console OAuth settings.

BASE_URL Purpose: Production base URL for redirects after OAuth Used by: api/auth/\[service\].js, api/query/\[action\].js Note: Used as returnTo fallback in OAuth state. Must be the live Vercel domain.

DROPBOX_APP_KEY Purpose: Dropbox OAuth app key Used by: api/auth/\[service\].js

DROPBOX_APP_SECRET Purpose: Dropbox OAuth app secret Used by: api/auth/\[service\].js

DROPBOX_REDIRECT_URI Purpose: Registered Dropbox OAuth callback URL Used by: api/auth/\[service\].js Warning: Changing this requires updating Dropbox App Console settings.

GITHUB_PAT Purpose: \[PLANNED\] GitHub Personal Access Token for Code: push/deploy Used by: \[PLANNED\] api/code handler Scope required: repo

---

## Supabase Schema

Project: Mobius_Vercel (separate from Factory_Health project)

### Table: conversations

user_id TEXT — Mobius internal user ID question TEXT — User query answer TEXT — AI response model TEXT — Model used (e.g. "Groq Llama 3.3 70B") topic TEXT — Topic label (defaults to 'general') session_id TEXT — Session grouping ID (nullable) created_at TIMESTAMPTZ — Record creation time

Used by: api/\_supabase.js (saveConversation, getChatHistory) Note: getChatHistory groups rows into sessions by session_id, falling back to a 30-minute gap heuristic when session_id is null.

### Table: google_tokens

user_id TEXT — Mobius internal user ID label TEXT — Account label: 'personal', 'family', 'work' email TEXT — Google account email access_token TEXT — OAuth access token refresh_token TEXT — OAuth refresh token expiry_date BIGINT — Token expiry as Unix ms timestamp PRIMARY KEY: (user_id, label) — composite key, supports multi-account

Used by: api/auth/\[service\].js, api/services/google.js, google_api.js Note: Multi-account Google OAuth. Composite primary key is essential — a single user_id can have multiple rows (one per label). Breaking the composite key constraint will corrupt multi-account support.

### Table: dropbox_tokens

user_id TEXT — Mobius internal user ID access_token TEXT — Dropbox access token refresh_token TEXT — Dropbox refresh token (nullable) expiry_date BIGINT — Token expiry as Unix ms timestamp (nullable) PRIMARY KEY: (user_id)

Used by: api/auth/\[service\].js, api/services/google.js

### Table: sync_meta

user_id TEXT — Mobius internal user ID label TEXT — Google account label type TEXT — Sync type: 'drive', 'gmail', 'calendar', 'tasks' synced_at TIMESTAMPTZ — Last sync timestamp PRIMARY KEY: (user_id, label, type)

Used by: api/data.js

### Table: users (inferred — login/signup)

user_id TEXT — Primary key email TEXT — User email password TEXT — Hashed password (handled by auth/user/\[action\].js)

---

## AI Model Routing

Default fallback chain (cloud only, defined in api/\_ai.js): groq → gemini → mistral → github

Models: groq Groq Llama 3.3 70B Versatile — default, fastest gemini Google Gemini 2.5 Flash — multimodal, handles images mistral Mistral Codestral Latest — code-focused github GPT-4o via GitHub Models/Azure — fallback

Local models (client-side only, not in server fallback chain): ollama/qwen Qwen2.5-Coder 7B via Ollama + IPEX-LLM (Intel Arc GPU) ollama/deepseek DeepSeek-R1 7B via Ollama + IPEX-LLM webllm Qwen2.5-Coder 1.5B via WebGPU in browser (Samsung A55)

Web search: web Tavily search, depth 1 web2 Tavily search, depth 2 web3 Tavily search, depth 3 Auto-escalates to web2 if knowledge cutoff detected in cloud model response.

Instruction modes: Brief Default — concise, under 500 words Long Elaborate: prefix or Elaborate command — detailed response Code Code-focused — complete working code, no truncation

---

## Self-Awareness System

mobius.json — stored in Google Drive (personal account, Mobius folder) Loaded at /parse time and injected as a virtual file into every AI call. Contains: project_state, preferences, rules, do_not, corrections.

This is Mobius's working memory across sessions. It is NOT the same as MOBIUS_CONTEXT.md. mobius.json = Mobius's current goals and preferences (dynamic, AI-facing) MOBIUS_CONTEXT.md = Repo architecture knowledge for Code: pipeline (static, developer-facing)

---

## Known Fragilities

1. SUPABASE_PUBLISHABLE_KEY vs SUPABASE_KEY Some files have referenced SUPABASE_PUBLISHABLE_KEY which does not exist. The correct variable is SUPABASE_KEY. Always verify this when editing any file that initialises a Supabase client.

2. google_tokens composite primary key The table uses (user_id, label) as composite primary key. Any upsert must specify onConflict: 'user_id, label'. Using onConflict: 'user_id' alone will break multi-account support.

3. vercel.json src values are external locks Route src values are registered OAuth redirect URIs. They cannot be changed in code alone — external console updates are required.

4. OAuth state parameter Google OAuth passes returnTo and label via JSON-encoded state parameter. The callback parses this with a try/catch fallback to raw string. Any change to state encoding must maintain backward compatibility or all in-flight OAuth sessions will fail.

5. Local models are client-side only Ollama and WebLLM are not accessible from Vercel serverless functions. They must never be added to the server-side fallback chain in \_ai.js.

6. Vercel Hobby 12-function limit Adding new top-level files under api/ may breach the function limit. New functionality must be routed through existing dynamic handlers or the existing handlers must be consolidated further.

7. saveConversation is fire-and-forget It uses .catch() and never throws. A failure to save will not surface as an error to the user. Do not assume conversations are always saved.

8. getChatHistory session grouping Sessions are grouped by session_id first, then by 30-minute gap. If session_id is inconsistently set, history will appear fragmented.

---

## Runtime Behaviours

1. Auth flow sequence Login → cookie set (mobius_user_id) → index.html reads cookie → userId passed in request body or read from cookie on server. Server always prefers cookie over body userId.

2. Google OAuth multi-account User can connect personal, family, and work Google accounts independently. Each is identified by label. All three can coexist in google_tokens. Disconnecting one label does not affect others.

3. Dropbox OAuth Fully implemented server-side. Tokens saved to dropbox_tokens. Client-side Dropbox: connect command not yet wired in commands.js.

4. AI fallback timing Groq is fastest. Gemini has higher latency but handles images. Mistral and GitHub models are used as fallbacks only. If all cloud models fail, the error surfaces to the user.

5. Vercel cold starts Serverless functions may have cold start latency on first request. This is normal and not a bug.

6. mobius.json availability If the user has not connected Google Drive, loadMobiusAwareness returns null. The system continues without awareness context — this is expected behaviour.

7. Post-processor flags postProcessReply checks for apology, uncertainty, truncation, and verbosity signals. Flags are logged server-side and returned in the response as postFlags. The client may display these as warnings. They do not block the response.

---

## Current Dev State

Branch: main (production) Dev branch: not yet created — planned as part of Code: pipeline implementation.

### Staged but not yet deployed (main branch, local only)

- Dropbox registry fix
- Sync:all + Dropbox command
- Dropbox:list command
- Startup status panel
- backgroundSync account check
- Removal of stale pack/audit/verify commands

### Planned (not yet built)

- Code: pipeline (audit, fix, push, deploy, restore) — see CODE_PIPELINE.code
- GITHUB_PAT environment variable for Code: push/deploy
- dev branch creation in GitHub
- commands.js audit for consistency
- help/index.html overhaul (Dropbox: connect/sync/list, startup panel)
- Factory_Health autonomous knowledge discovery system (separate repo/Supabase)

### Known issues

- SUPABASE_PUBLISHABLE_KEY reference in api/\_supabase.js (should be SUPABASE_KEY)
- Dropbox: connect not yet in commands.js

---
