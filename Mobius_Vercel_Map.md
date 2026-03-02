# Mobius_Vercel — AI Briefing Document
*Read this entire file before touching any code. Last updated: 2026-03-02*

---

## What is Mobius?

Mobius is a Progressive Web App (PWA) deployed on Vercel. It is a personal AI coordination tool that routes queries to multiple AI backends (Groq, Gemini, Mistral) with a fallback chain, supports file attachments, Google Drive integration via a Focus command, chat history persistence in Supabase, and a colon-command system for non-AI utilities.

**Owner:** Boon Lay, landscape architect at Curtin University, Perth WA.
**Live URL:** Vercel deployment (run `npx vercel --prod` from project root to deploy)
**Project root:** `C:\Users\263350F\Mobius_Vercel`

---

## File Structure

```
Mobius_Vercel/
├── index.html          ← Entire client UI + all client JS (single file)
├── login.html          ← Login page
├── signup.html         ← Signup page
├── commands.js         ← Colon-command registry loaded by index.html
├── google_api.js       ← Google Drive/Gmail/Calendar/Tasks helpers
├── actions.js          ← Reserved for future action handlers
├── service-worker.js   ← PWA caching
├── manifest.json       ← PWA manifest
├── vercel.json         ← URL routing (see source below)
├── api/
│   ├── parse.js        ← Builds mobius_query from input + history
│   ├── ask.js          ← Routes mobius_query to AI model, saves to DB
│   ├── _ai.js          ← AI model wrappers (Groq, Gemini, Mistral, Tavily)
│   ├── _supabase.js    ← Supabase save/load conversations
│   ├── login.js        ← Auth endpoint
│   ├── signup.js       ← Auth endpoint
│   ├── upload.js       ← File upload → base64 temp storage
│   ├── chat-history.js ← Load saved sessions from Supabase
│   ├── auth/           ← Google OAuth flow
│   ├── focus/          ← Google Drive Focus command API endpoints
│   │   ├── find.js, read.js, copy.js, append.js, update-original.js, create.js
│   └── google/
│       └── info.js     ← Returns connected Google account details
```

---

## Core Data Flow

### Step 1 — First Ask press (parse)
```
User types query → handleAsk() → detectCommand()
  If colon-command (Focus:, Find:, etc.) → runCommand() → done
  If plain query → parseQuery(userId)
    → POST /parse  { text, model, history, context }
    ← { mobius_query }
    → displays preview in dashed box
    → stores in pendingMobiusQuery
    → waits for second press
```

### Step 2 — Second Ask press (execute)
```
handleAsk() → executeQuery(userId)
  → POST /ask  { mobius_query, userId }
  ← { reply, modelUsed }
  → renders answer
  → pushes { role:'user', content:QUERY } + { role:'assistant', content:reply } into chatHistory[]
  → clears input + attachedFiles
```

---

## The mobius_query Object

```json
{
  "ASK": "groq",
  "INSTRUCTIONS": [
    { "role": "user", "content": "[System] You are Mobius..." },
    { "role": "user", "content": "previous question" },
    { "role": "assistant", "content": "previous answer" }
  ],
  "QUERY": "the user's actual question",
  "FILES": [{ "name": "file.pdf", "mimeType": "application/pdf", "base64": "..." }],
  "CONTEXT": "[User Environment]\nDate/Time: ...\nOS: ..."
}
```

**ASK values:** `groq` | `gemini` | `mistral` | `websearch` | `google_drive` | `google_tasks` | `google_calendar` | `google_gmail` | `chat_history`

---

## Client-Side State (index.html)

| Variable              | Purpose                                                   |
|-----------------------|-----------------------------------------------------------|
| `chatHistory[]`       | Accumulates all Q+A pairs for the session as role/content |
| `pendingMobiusQuery`  | Holds parsed query between first and second Ask press     |
| `attachedFiles[]`     | Files attached this turn; cleared after send              |
| `mobiusContext`       | Environment string built once on page load                |
| `focusFile`           | Active Focus file (set by commands.js, read via getFocusFile()) |
| `currentNavIndex`     | ↑↓ navigation button state                                |

**Reset on New Chat:** chatHistory, attachedFiles, pendingMobiusQuery, currentNavIndex all clear.

---

## Key Patterns & Gotchas

1. **Two-press Ask** is intentional — first builds & previews, second sends.
2. **Image attachments** auto-switch ASK to `gemini` regardless of selected model.
3. **Focus file** is prepended (not appended) to FILES[] so it's always first.
4. **System messages** use `role: 'user'` with `[System]` prefix, NOT `role: 'system'`, because some model APIs reject the system role in messages array.
5. **`Elaborate:` prefix** disables the 200-word limit for that query only.
6. **loadSessionIntoChat()** rebuilds chatHistory from saved sessions so old conversations can be continued.
7. **System message de-duplication (fixed 2026-03-02):** History is filtered to remove any `[System]` messages before prepending the new one. Without this, INSTRUCTIONS grows 1→3→5→7 across turns.

---

## Environment Variables (set in Vercel dashboard)

| Variable                | Used in         |
|-------------------------|-----------------|
| `GROQ_API_KEY`          | _ai.js          |
| `GEMINI_API_KEY`        | _ai.js          |
| `MISTRAL_API_KEY`       | _ai.js          |
| `TAVILY_API_KEY`        | _ai.js          |
| `SUPABASE_URL`          | _supabase.js    |
| `SUPABASE_KEY`          | _supabase.js    |
| `GOOGLE_CLIENT_ID`      | auth/ OAuth     |
| `GOOGLE_CLIENT_SECRET`  | auth/ OAuth     |

---

## Commands (commands.js)

| Command    | Usage example                  | AI? | Notes                          |
|------------|--------------------------------|-----|--------------------------------|
| `Date`     | `date`                         | No  | Single-word, no colon needed   |
| `Time`     | `time`                         | No  | Single-word                    |
| `Location` | `location`                     | No  | IP-based via ipapi.co          |
| `Device`   | `device`                       | No  | Full UA + WebGL + storage info |
| `Google`   | `google`                       | No  | Shows connected account        |
| `Access`   | `access`                       | No  | Grant local folder (FS API)    |
| `Find:`    | `Find: report Ext: pdf From: last month` | No | Searches granted folder |
| `List`     | `list`                         | No  | Lists root of granted folder   |
| `History`  | `history`                      | No  | Loads sessions from Supabase   |
| `New:`     | `New: topic`                   | No  | Resets chat, optionally fires topic |
| `Focus:`   | `Focus: filename`              | No  | Attaches Google Drive file     |
| `Ask:`     | `Ask: gemini what is X`        | Yes | Explicit model override        |

---

## Model Routing (api/ask.js)

| ASK value        | Primary handler         | Fallback chain             |
|------------------|-------------------------|----------------------------|
| `groq` (default) | askGroq                 | → Gemini → Mistral         |
| `gemini`         | askGemini               | → Mistral → Groq           |
| `mistral`        | askMistral              | → Groq → Gemini            |
| `websearch`      | Tavily search + Groq    | → Gemini → Mistral         |
| Has image files  | Force → askGemini       | → Mistral → Groq           |
| `google_*`       | google_api.js helpers   | No fallback                |
| `chat_history`   | Returns token only      | No fallback                |

---

## Model Details (api/_ai.js)

| Model   | Endpoint                                                  | Model string            |
|---------|-----------------------------------------------------------|-------------------------|
| Groq    | `api.groq.com/openai/v1/chat/completions`                 | `llama-3.3-70b-versatile` |
| Gemini  | `generativelanguage.googleapis.com/v1beta/models/...`     | `gemini-2.5-flash`      |
| Mistral | `api.mistral.ai/v1/chat/completions`                      | `codestral-latest`      |
| Tavily  | `api.tavily.com/search`                                   | max_results: 5          |

---

## URL Routing (vercel.json)

```json
{
  "version": 2,
  "routes": [
    {"src": "/auth/google/callback", "dest": "/api/auth/google/callback"},
    {"src": "/auth/google/status",   "dest": "/api/auth/google/status"},
    {"src": "/auth/google",          "dest": "/api/auth/google"},
    {"src": "/ask",                  "dest": "/api/ask"},
    {"src": "/parse",                "dest": "/api/parse"},
    {"src": "/upload",               "dest": "/api/upload"},
    {"src": "/api/chat-history",     "dest": "/api/chat-history"},
    {"src": "/api/login",            "dest": "/api/login"},
    {"src": "/api/signup",           "dest": "/api/signup"},
    {"src": "/api/google/info",      "dest": "/api/google/info"},
    {"src": "/api/focus/(.*)",       "dest": "/api/focus/$1"},
    {"src": "/login",                "dest": "/login.html"},
    {"src": "/signup",               "dest": "/signup.html"},
    {"src": "/help/(.*)",            "dest": "/help/$1"},
    {"src": "/(.*)",                 "dest": "/$1"}
  ]
}
```

---

## SOURCE: api/parse.js

```js
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { text, model, history, context } = req.body || {};

    if (!text) {
      res.status(400).json({ error: 'Text is required' });
      return;
    }

    // Detect Elaborate command — allow long answers
    const elaborate = /^Elaborate[:\s]/i.test(text) || /\belaborate\b/i.test(text);
    const cleanText = text.replace(/^Elaborate[:\s]+/i, '').trim() || text;

    const systemPrompt = elaborate
      ? 'You are Mobius, a helpful AI assistant. Provide a thorough and detailed answer.'
      : 'You are Mobius, a helpful AI assistant. Keep all responses concise and under 200 words. Be direct and to the point. If the user wants more detail, they will ask you to elaborate.';

    const systemMessage = { role: 'user', content: `[System] ${systemPrompt}` };
    // Strip any prior system messages from history to prevent duplication
    const cleanHistory = (history || []).filter(m => !m.content?.startsWith('[System] '));
    const instructions = [systemMessage, ...cleanHistory];

    const mobius_query = {
      ASK: model || 'groq',
      INSTRUCTIONS: instructions,
      QUERY: cleanText,
      FILES: [],
      CONTEXT: context || ''
    };

    res.status(200).json({ mobius_query });
  } catch (err) {
    console.error('Parse error:', err);
    res.status(500).json({ error: 'Parse failed' });
  }
};
```

---

## SOURCE: api/ask.js

```js
const { askGemini, askMistral, askWithFallback, askWebSearch } = require('./_ai.js');
const { saveConversation } = require('./_supabase.js');
const { getDriveFiles, getTasks, getCalendarEvents, getEmails } = require('../google_api.js');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { mobius_query, userId, topic } = req.body;
  const { ASK, INSTRUCTIONS, QUERY, FILES, CONTEXT } = mobius_query;

  try {
    const messages = [...INSTRUCTIONS, { role: 'user', content: QUERY }];
    if (CONTEXT) messages.unshift({ role: 'system', content: CONTEXT });

    let reply, modelUsed = ASK;

    const imageParts = (FILES || [])
      .filter(f => f.mimeType?.startsWith('image/'))
      .map(f => ({ inline_data: { mime_type: f.mimeType, data: f.base64 } }));

    const hasImages = imageParts.length > 0;
    const hasNonImageFiles = (FILES || []).some(f => f.mimeType && !f.mimeType.startsWith('image/'));

    const appendFileTexts = () => {
      if (hasNonImageFiles) {
        const fileTexts = (FILES || [])
          .filter(f => !f.mimeType.startsWith('image/'))
          .map(f => `[File: ${f.name}]\n${Buffer.from(f.base64, 'base64').toString('utf8')}`)
          .join('\n\n');
        messages[messages.length - 1].content += '\n\n' + fileTexts;
      }
    };

    if (ASK === 'chat_history') {
      reply = '__CHAT_HISTORY__';
      modelUsed = 'system';
    } else if (ASK === 'google_drive') {
      reply = await getDriveFiles(userId, QUERY);
    } else if (ASK === 'google_tasks') {
      reply = await getTasks(userId);
    } else if (ASK === 'google_calendar') {
      reply = await getCalendarEvents(userId);
    } else if (ASK === 'google_gmail') {
      reply = await getEmails(userId);
    } else if (ASK === 'gemini' || hasImages) {
      try {
        reply = await askGemini(messages, imageParts);
        modelUsed = 'gemini';
      } catch (err) {
        try {
          reply = await askMistral(messages);
          modelUsed = 'mistral (fallback from gemini)';
        } catch (err2) {
          const { reply: fbReply, modelUsed: fbModel } = await askWithFallback(messages, [], 'groq');
          reply = fbReply;
          modelUsed = fbModel + ' (fallback from gemini)';
        }
      }
    } else if (ASK === 'mistral' || ASK === 'codestral') {
      try {
        reply = await askMistral(messages);
        modelUsed = 'mistral';
      } catch (err) {
        const { reply: fbReply, modelUsed: fbModel } = await askWithFallback(messages, [], 'groq');
        reply = fbReply;
        modelUsed = fbModel + ' (fallback from mistral)';
      }
    } else if (ASK === 'websearch') {
      appendFileTexts();
      try {
        const { reply: wsReply, modelUsed: wsModel } = await askWebSearch(messages);
        reply = wsReply;
        modelUsed = wsModel;
      } catch (err) {
        const { reply: fbReply, modelUsed: fbModel } = await askWithFallback(messages, [], 'groq');
        reply = fbReply;
        modelUsed = fbModel + ' (fallback from websearch)';
      }
    } else {
      appendFileTexts();
      const { reply: fallbackReply, modelUsed: fallbackModel } = await askWithFallback(messages, [], ASK);
      reply = fallbackReply;
      modelUsed = fallbackModel;
    }

    res.json({ reply, modelUsed });
    if (userId && reply !== '__CHAT_HISTORY__') {
      saveConversation(userId, QUERY, reply, modelUsed, topic || 'general').catch(e => console.error('Save error:', e.message));
    }
  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).json({ error: err.message });
  }
};
```

---

## SOURCE: api/_ai.js

```js
async function askGroq(messages) {
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + process.env.GROQ_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages })
  });
  const data = await r.json();
  const content = data.choices?.[0]?.message?.content || data.choices?.[0]?.message?.reasoning_content;
  if (!content) throw new Error(JSON.stringify(data));
  return content;
}

async function askGemini(messages, imageParts = []) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is not set on the server.');
  const contents = messages.map((m, i) => {
    const isLastUser = i === messages.length - 1 && m.role === 'user';
    const parts = [];
    if (isLastUser && imageParts.length > 0) parts.push(...imageParts);
    parts.push({ text: m.content });
    return { role: m.role === 'assistant' ? 'model' : 'user', parts };
  });
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' + key;
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents }) });
  const data = await r.json();
  if (data.error) throw new Error('Gemini API error: ' + data.error.message);
  if (!data.candidates?.[0]) throw new Error('No candidates: ' + JSON.stringify(data));
  return data.candidates[0].content.parts[0].text;
}

async function askMistral(messages) {
  const r = await fetch('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + process.env.MISTRAL_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'codestral-latest', messages })
  });
  const data = await r.json();
  return data.choices?.[0]?.message?.content || JSON.stringify(data);
}

const MODEL_CHAIN = ['groq', 'gemini', 'mistral'];

async function askWithFallback(messages, imageParts = [], startModel = 'groq') {
  const startIdx = MODEL_CHAIN.indexOf(startModel);
  const chain = startIdx !== -1 ? MODEL_CHAIN.slice(startIdx) : MODEL_CHAIN;
  let lastErr = null;
  for (const model of chain) {
    try {
      let result;
      if (model === 'groq') result = await askGroq(messages);
      else if (model === 'gemini') result = await askGemini(messages, imageParts);
      else if (model === 'mistral') result = await askMistral(messages);
      const label = model === startModel ? model : model + ' (fallback from ' + startModel + ')';
      return { reply: result, modelUsed: label };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('All models failed');
}

async function askWebSearch(messages) {
  const tavilyKey = process.env.TAVILY_API_KEY;
  if (!tavilyKey) throw new Error('TAVILY_API_KEY is not set.');
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  const query = lastUserMsg ? lastUserMsg.content : '';
  const searchRes = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: tavilyKey, query, max_results: 5, include_answer: false })
  });
  const searchData = await searchRes.json();
  if (searchData.error) throw new Error('Tavily error: ' + searchData.error);
  const context = searchData.results.map((r, i) => `[${i+1}] ${r.title}\n${r.content}\nSource: ${r.url}`).join('\n\n');
  const augmented = messages.map((m, i) =>
    i === messages.length - 1 && m.role === 'user'
      ? { role: 'user', content: `Answer using web search results. Be concise and cite sources.\n\nQuestion: ${m.content}\n\nSearch Results:\n${context}` }
      : m
  );
  return await askWithFallback(augmented);
}

module.exports = { askGroq, askGemini, askMistral, askWithFallback, askWebSearch };
```

---

## How to Use This Document

**For Claude Desktop / Claude.ai:** Say "read Mobius_Vercel_Map.md first" — Claude can access it via MCP filesystem.

**For Mobius itself (any AI model):** Use `Focus: Mobius_Vercel_Map.md` to attach it, then ask your question. The AI will have full context.

**For Aider or other coding tools:** Pass it as context: `aider --read Mobius_Vercel_Map.md`

**Keep this file updated** whenever you: add a new API endpoint, change a model, add a command, or fix a significant bug (note the fix with date).
