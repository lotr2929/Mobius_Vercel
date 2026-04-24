# mobius -- Activity Log Summary

*Auto-updated by Groq at end of each session. Max 300 words.Last updated: 2026-04-06 (bootstrap)*

---

## Recent activity

**06 Apr 2026 -- Bootstrap + GPRTool integration groundwork**

- service-worker.js: switched to network-first strategy, no more date-based cache name
- js/code.js: added withFileContext() helper, Code: File command, auto file injection for Fix/Explain/Review
- js/all.js: full rewrite -- Ask: All multi-model voting, All Mode toggle, Groq category classification
- js/scores.js: new file -- localStorage model win/loss tracking, Ask: Scores leaderboard
- js/ask.js: Ask: Mistral alias added
- vercel.json: /api/data route added
- \_context/: bootstrapped -- [CLAUDE.md](http://CLAUDE.md) and log_summary.md created

**Repository audit completed:**

- BASE_URL fallback fixed (was pointing at mobius-vercel.vercel.app)
- server.js static file path fixed (ROOT_DIR was wrong)
- Chat: History URL fixed (/api/data?action=history)
- catalogue.js: rewritten to scan all js/*.js files for self-registering pattern

---

## Known fragile areas

- Ask: All classification uses Groq in parallel -- if Groq is down, category defaults to General
- Ollama requires server.js running (localhost:3000 proxy) -- breaks if server.js not started
- window.allModeActive is session-scoped -- resets to off on page reload
- Scores are in localStorage -- cleared if user clears browser data
- File System Access API: Project: Open must be run at start of every session

---

## Last deploy

06 Apr 2026 -- clean. All startup checks green.

## Active issues

None.
