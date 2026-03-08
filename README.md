# Mobius — Personal AI Assistant PWA

A browser-based AI assistant deployed on Vercel. Routes queries across multiple AI models, integrates with Google Workspace, and includes a structured coding assistant framework (`Code:`) for software development projects.

**Production:** https://mobius-vercel.vercel.app
**Stable:** https://mobius-plum.vercel.app

---

## What Mobius Does

- **Multi-model AI routing** — Groq (Llama), Gemini, Mistral, GitHub (GPT-4o), with manual `Ask:` override or auto-routing via the Action Layer
- **Local AI** — Ollama via IPEX-LLM (Intel Arc); `Ask: Qwen` for coding, `Ask: DeepSeek` for reasoning
- **Google Workspace** — Drive (Focus: file context), Gmail, Calendar, Tasks
- **Code: command suite** — structured coding assistant with repo scanning, static analysis, AI briefing, and audit tracking (see below)
- **Chat history** — stored in Supabase, browsable via `History`
- **PWA** — installable on desktop and mobile, service worker for offline support
- **File uploads** — image, PDF, text; images route to Gemini Vision

---

## Command Reference

### General commands
| Command | What it does |
|---|---|
| `Date` / `Time` / `Location` / `Device` | Local device info (no AI) |
| `Status` | Live health check — server, Google, Supabase, Ollama, PWA |
| `Google` | Show connected Google account |
| `Access` | Grant local folder access (File System API) |
| `Find: filename` | Search granted local folder |
| `List` | List root of granted local folder |
| `History` | Browse Supabase chat history |
| `New` | Start a new chat session |

### Ask: commands (model selection)
| Command | Routes to |
|---|---|
| `Ask: Gemini` | Gemini (default for long/complex) |
| `Ask: Groq` | Groq / Llama (fast) |
| `Ask: Mistral` | Mistral |
| `Ask: GitHub` | GPT-4o via GitHub Models |
| `Ask: Qwen` | Local Ollama — qwen2.5-coder:7b |
| `Ask: DeepSeek` | Local Ollama — deepseek-r1:7b |
| `Ask: Web` | Tavily web search |

### Focus: commands (Google Drive file context)
| Command | What it does |
|---|---|
| `Focus: filename` | Search Drive, load file as AI context |
| `Focus: add [text]` | Append timestamped entry to focused file |
| `Focus: update` | Write Mobius copy back to original Drive file |
| `Focus: end` | Detach file from session |

### Code: commands (coding assistant framework)
| Command | What it does | Output |
|---|---|---|
| `Code: [projectname]` | Open project folder, load session | Reads `.map` `.repo` `.audit` from `documents/` |
| `Code: repo` | Parse all `.js`/`.html` — functions, imports, exports, routes | `projectname.repo` |
| `Code: map` | Send `.repo` to Gemini for architectural summary | `projectname.map` |
| `Code: scan` | nAI static analysis — secrets, errors, bad patterns | `projectname.scan` |
| `Code: audit new` | Run repo + scan, ask Gemini for briefing + fix plan | `projectname.audit` |
| `Code: audit` | Resume audit — re-scan, reload context, continue with Gemini | Updated `.audit` |
| `Code: audit end` | Close audit with final Gemini summary | Final `.audit` |
| `Code: all` | Run repo → map → audit in sequence | All three files |
| `Code: status` | Snapshot current session state | `projectname.status` |
| `Code: show` | Display all loaded session content | (display only) |
| `Code: end` | End code session | — |

All `Code:` output files are saved to **Google Drive (Mobius folder)** and offered as a local download. Save local copies into the project's `documents/` subfolder.

#### Classifier Legend

`.map` files:
- `[D]` Design decision or principle
- `[E]` External fact — URLs, API keys, service names, table names

`.repo` files:
- `[F]` Function — named function or arrow function
- `[V]` Environment variable — `process.env.*` reference
- `[>]` Import — `require()` or `import from`
- `[<]` Export — `module.exports` entry
- `[R]` Route — Express endpoint

---

## File Structure

```
api/
  _ai.js              ← AI model routing (Groq, Gemini, Mistral, GitHub, Ollama, Web)
  _supabase.js        ← Supabase client
  ask.js              ← POST /ask
  parse.js            ← POST /parse
  upload.js           ← POST /upload
  login.js            ← POST /login
  signup.js           ← POST /signup
  chat-history.js     ← GET /api/chat-history
  auth/google/        ← OAuth flow (index, callback, status)
  google/info.js      ← GET /api/google/info
  focus/[action].js   ← POST /api/focus/* (find, read, copy, create, append, update-original, create-or-update)
documents/            ← Project documents (.code, .map, .repo, .audit, .status etc.)
help/                 ← Help content
actions.js            ← Action Layer (command → local → Google → AI routing)
commands.js           ← All colon-prefix command handlers
index.html            ← Main chat UI
login.html            ← Login page
signup.html           ← Signup page
google_api.js         ← Google Drive, Gmail, Calendar, Tasks API functions
service-worker.js     ← PWA offline support
manifest.json         ← PWA manifest
deploy.bat            ← Deploy to Vercel (preferred over manual git)
backup.bat            ← Local backup script
```

---

## Deploy

```bat
deploy.bat
```

Or manually:
```bash
git add .
git commit -m "your message"
git push
```

Vercel auto-deploys on push to `main`.

---

## Environment Variables

Set in Vercel dashboard (Settings → Environment Variables):

```
SUPABASE_URL
SUPABASE_KEY
GROQ_API_KEY
GEMINI_API_KEY
MISTRAL_API_KEY
GITHUB_TOKEN
TAVILY_API_KEY
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GOOGLE_REDIRECT_URI
OLLAMA_BASE_URL       ← local only (http://localhost:11434)
```

---

## Local Development

```bash
npm install
vercel dev          # runs serverless functions locally on localhost:3000
```

Ollama (local AI): open Command Prompt, `cd` to `C:\Users\263350F\ollama-ipex-llm-2.3.0b20250612-win`, run `start-ollama.bat`.
