# Mobius — CLAUDE.md

## What this is
Mobius is a personal AI chat application. It is not Mobius+. It is a clean greenfield build.

**One purpose:** Give Boon a single AI to talk to that has perfect memory, can search the web, and has full recall of every document he uploads. Nothing else.

## Architecture
- **Frontend:** Single-page chat UI. Mobile-first. Clean. No clutter.
- **Backend:** Node.js server. Handles AI cascade, chat history, Tavily search, document store.
- **AI cascade:** Gemini 2.5 Flash → Groq Llama 3.3 → Mistral Small
- **Web search:** Tavily — triggered automatically when AI needs current information
- **Chat history:** SQLite (`data/history.db`) — full conversation persistence
- **Document store:** SQLite FTS5 (`data/docs.db`) — uploaded docs, full-text search
- **No Hermes.** No relay. No meeting system. No PCM port from Mobius+.

## Core behaviours
1. AI always has the full conversation history in context
2. AI searches Tavily automatically when it detects a need for current information
3. AI searches the document store when the question relates to uploaded content
4. Responses stream to the UI token by token
5. Chat history persists across sessions and browser refreshes

## What this is NOT
- Not a multi-agent system
- Not a board/panel tool
- Not a task runner
- Not a code assistant
- Just a chat interface with memory and search

## Stack
- Node.js backend (server.js)
- Vanilla JS frontend (no framework)
- SQLite via better-sqlite3
- Tailscale for remote access from phone/tablet

## Start
```
start.bat        — starts backend on port 3005
stop.bat         — stops it
```

## Ports
- 3005 — Mobius backend + UI
