# mobius — Setup & Infrastructure

_Last updated: April 2026_

---

## Local Proxy

**What it does:** Runs a local Node.js server on port 3000. Required for Ollama
(local AI) to work from the browser due to CORS restrictions.

**File:** `C:\Users\263350F\_myProjects\Mobius\mobius\js\server.js`

**Manual start:** Double-click `local-proxy.bat` in the project root.
Keep the window open while using mobius with local models.

**Auto-start on Windows login:** `MobiusCoderServer.vbs` in Windows Startup folder.
Path: `C:\Users\263350F\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\`
Runs silently (no window).

**How it works:**
- Proxies `/ollama/*` → `localhost:11434` with `Access-Control-Allow-Origin: *`
- Proxies `/api/*` → `mobius-pwa.vercel.app` (Vercel serverless)
- Runs on `http://localhost:3000`

**Note:** Vercel serverless functions cannot reach `localhost:11434` on the user's
machine. All local Ollama calls must go through the browser via this proxy.

---

## Windows Startup Files

All startup files live in:
`C:\Users\263350F\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\`

| File | What it starts |
|---|---|
| `MobiusCoderServer.vbs` | mobius local proxy (port 3000) |
| `MobiusVercelServer.vbs` | Mobius_Vercel local server |
| `Ollama` | Ollama (standard Windows install) |

**Convention:** Always use `.vbs` wrappers for silent auto-start. Name as
`Mobius[ProjectName]Server.vbs`. The `.vbs` file uses `WScript.Shell` with
`Run(..., 0, False)` to suppress the command window.

---

## OLLAMA_ORIGINS

Ollama uses this environment variable to control which browser origins are
allowed to make cross-origin requests to its API.

**Current value (Machine level):**
```
https://mobius-plum.vercel.app,https://mobius-vercel.vercel.app,https://mobius-pwa.vercel.app
```

**Set via PowerShell (run as Administrator):**
```powershell
[System.Environment]::SetEnvironmentVariable("OLLAMA_ORIGINS", "https://mobius-plum.vercel.app,https://mobius-vercel.vercel.app,https://mobius-pwa.vercel.app", "Machine")
```

**Note:** Machine-level value takes effect after Ollama restarts. User-level
values can override Machine-level — always set at Machine level for reliability.
In practice, the local proxy bypasses this entirely since it adds
`Access-Control-Allow-Origin: *` itself.

---

## Local AI Models (Ollama)

Installed models:

| Call name | Model ID | Size |
|---|---|---|
| Ask: Qwen35 | qwen3.5:35b-a3b | 23 GB |
| Ask: Qwen | qwen2.5-coder:7b | 4.7 GB |
| Ask: DeepSeek | deepseek-r1:7b | 4.7 GB |

Local model chain: qwen35 → qwen → deepseek (all three always tried, rotated
to start at the requested model). No cloud fallback.

---

## Vercel Environment Variables

All env vars are stored in Vercel and injected at serverless function runtime.
To update: run `push_env.ps1` in `_dev/`.

Key vars: `GEMINI_API_KEY`, `GROQ_API_KEY`, `MISTRAL_API_KEY`, `GITHUB_TOKEN`,
`SUPABASE_URL`, `SUPABASE_KEY`, `TAVILY_API_KEY`.

---

## Deployment

Run `deploy.bat` from the project root. It:
1. Creates a pre-deploy backup zip
2. Stages all changed files (`git add -A`)
3. Commits with auto-generated message: `4Apr26 11:05am - [N] file1, file2`
4. Pushes to GitHub → Vercel auto-deploys
5. Polls Vercel until deployment is READY
6. Verifies the live URL responds

---

## WebLLM (Phone / Offline)

Extracted to `js/webllm.js` — not loaded by default.
To enable on phone: add `<script src="js/webllm.js"></script>` after `commands.js`
in `index.html`.
