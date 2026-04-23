# CLAUDE.md -- Mobius
_First read: C:\_myProjects\CLAUDE.md (master standing instructions)._

AI orchestrator for Mobius -- a multi-gate consensus PWA built on Vercel + Supabase.
Core Mobius purpose: Persistent and Continuity Memory (PCM) for stateless AI sessions.
Every Mobius decision should move closer to genuine PCM.

## Additional rules
- Fully understand the problem before suggesting solutions
- Simplest solution that fits existing code logic
- Read files before editing them

## Project
- Repo: lotr2929/Mobius_Vercel
- Live: https://mobius.vercel.app (TBC after deploy)
- Local: http://localhost:3000 (node js/server.js)
- Deploy: run deploy.bat

## Stack
- Frontend: index.html (vanilla JS PWA)
- Backend: Vercel serverless (api/)
- DB: Supabase (conversations, sessions, knowledge, user_profile tables)
- AI: Groq, Gemini, Mistral, Ollama (local)

## Architecture
See mobius_architecture_final.md for the 9-AI consensus orchestration pipeline.
Gate 1 (Prompt Consensus) -> Gate 1.5 (Source Consensus) -> Execute -> Gate 2 (Answer Consensus)

## AI Models
- Cloud: Groq Llama 3.3 70B, Gemini 2.5 Flash, Mistral Codestral
- Local: qwen3.5:35b-a3b, qwen2.5-coder:7b, deepseek-r1:7b (via Ollama)
- Ollama start: start-ollama.bat (IPEX-LLM, Intel Arc accelerated)

## Key Files
- index.html -- main UI
- js/commands.js -- all command handlers (client-side)
- api/_ai.js -- AI model routing
- api/agent.js -- orchestration engine (REPO = lotr2929/Mobius_Vercel)
- api/_supabase.js -- DB helpers
- api/query/[action].js -- /ask and /parse endpoints
