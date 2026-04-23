# mobius — Test Checklist
_Step 3 — Command Routing & Ask:_
_Date: April 2026_

---

## Before Testing

- [ ] `deploy.bat` run and deployment READY
- [ ] `local-proxy.bat` running (for Ollama tests)
- [ ] Ollama running (check system tray)
- [ ] Open `https://mobius.vercel.app` in Edge

---

## 1. Layout & Panel

- [ ] App loads with single column (no panel on left)
- [ ] Header (logo + Help) is inside the left column
- [ ] Control bar shows: paperclip | up | down | [spacer] | panel-toggle
- [ ] Click panel toggle → right panel opens (left narrow, right wide ~62%)
- [ ] Panel toggle icon is highlighted/active when panel is open
- [ ] Click toggle again → panel closes, chat returns to full width
- [ ] Code: response auto-opens the panel
- [ ] Panel shows title bar with title, type badge, Copy, Close buttons
- [ ] Copy button in panel copies content to clipboard
- [ ] Close button (✕) in panel closes it

---

## 2. Startup Checklist

- [ ] Startup panel appears in chat (left column), not right panel
- [ ] 5 rows: Network, Vercel API, Supabase, Cloud AI, Local AI (no WebLLM)
- [ ] Network → online
- [ ] Vercel API → reachable
- [ ] Supabase → connected
- [ ] Cloud AI → all green except GitHub (rate limited is OK)
- [ ] Local AI → shows 3 Ollama models when proxy is running
- [ ] Local AI → "Ollama not running" when proxy is off

---

## 3. Command Routing — Cloud

- [ ] Plain text → response in chat, footer shows `Gemini 2.5 Flash-Lite`
- [ ] `Ask: Lite what is 2+2` → Gemini Flash-Lite in footer
- [ ] `Ask: Llama what is 2+2` → Groq Llama 3.3 70B in footer
- [ ] `Ask: Gemini what is 2+2` → Gemini 2.5 Flash in footer
- [ ] `Ask: Codestral write a hello world` → Codestral in footer
- [ ] `Ask: Mistral write a hello world` → same as Codestral (alias works)
- [ ] `Ask: GPT what is 2+2` → GPT-4o in footer (may fail if rate limited)

---

## 4. Command Routing — Local

- [ ] `Ask: Qwen35 what is 2+2` → Qwen3.5 35B (local) in footer
- [ ] `Ask: Qwen what is 2+2` → Qwen2.5-Coder 7B (local) in footer
- [ ] `Ask: DeepSeek what is 2+2` → DeepSeek R1 7B (local) in footer
- [ ] Local response does NOT fall back to cloud when Ollama is running

---

## 5. Ask: Next

- [ ] Ask a question (any model)
- [ ] Type `Ask: Next` → same question reruns on next model in chain
- [ ] Footer shows new model name
- [ ] Repeat `Ask: Next` until end of chain → shows "already at last model"

---

## 6. Ask?

- [ ] Type `Ask?` → model list appears in chat
- [ ] List shows: Lite, Llama, Codestral (with Mistral alias note), GPT, Gemini, Qwen35, Qwen, DeepSeek, Next
- [ ] Call names are in monospace font

---

## 7. Coding Commands → Panel

- [ ] `Code: write a function to add two numbers` → response in panel (chat shows "→ shown in panel")
- [ ] `Fix: [paste some broken code]` → response in panel
- [ ] `Review: [paste some code]` → response in panel
- [ ] `Explain: [paste some code]` → response in CHAT (not panel)
- [ ] `Debug: [paste an error]` → response in CHAT (not panel)

---

## 8. File Commands → Panel

- [ ] `Access:` → folder picker opens, grants access
- [ ] `List:` → directory listing appears in panel (chat shows "Listed N items → see panel")
- [ ] `Find: filename` → results appear in panel if found

---

## 9. Conversation History

- [ ] Ask a question, get a reply
- [ ] Ask a follow-up using "it" or "that" → model understands the context
- [ ] Type `New:` → chat clears, history resets
- [ ] After New: → follow-up no longer has previous context

---

## 10. Session Persistence

- [ ] Model badge starts as `gemini-lite` on fresh page load
- [ ] Use `Ask: Llama` → badge updates to show Llama
- [ ] Close tab, reopen → badge resets to `gemini-lite` (sessionStorage)
- [ ] Refresh page (F5) → badge resets to `gemini-lite`

---

## 11. Fallback Chain

- [ ] Check Vercel logs after a query — confirm Gemini Flash-Lite was tried first
- [ ] If a fallback occurred, footer label shows e.g. `Groq Llama 3.3 70B (fallback from Gemini Flash-Lite)`

---

## Notes

Record any failures here with the exact input, expected result, and actual result.
