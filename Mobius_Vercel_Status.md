# Mobius Vercel Migration - Session Notes
**Date:** 26 February 2026

## What We Did Today
- Converted Mobius from Render (Express server) to Vercel (serverless)
- Created all API route files in `api/` folder
- Deployed to Vercel successfully at **https://mobius-plum.vercel.app**
- Added all environment variables in Vercel dashboard
- Updated Google OAuth redirect URI in Google Cloud Console
- Login page loads correctly

## Current Status
- ✅ Vercel project created: `mobius` under `lotr2929-7612's projects`
- ✅ Deployed at: https://mobius-plum.vercel.app
- ✅ Environment variables added
- ✅ Google OAuth redirect URI updated
- ❌ API functions returning 404 — not being detected as serverless functions

## Root Cause of Problem
All `api/*.js` files use ES module syntax (`import`/`export`) because the root `package.json` has `"type": "module"`. Vercel's serverless functions require CommonJS syntax (`require`/`module.exports`).

The `api/package.json` fix with `{"type": "commonjs"}` did not work because the files still use `import` statements internally.

## What Needs to Be Done Tomorrow
Rewrite ALL files in the `api/` folder from ES module syntax to CommonJS syntax.

### Every `import` becomes `require`:
```js
// FROM (ES module):
import { createClient } from '@supabase/supabase-js';

// TO (CommonJS):
const { createClient } = require('@supabase/supabase-js');
```

### Every `export default function` becomes `module.exports`:
```js
// FROM:
export default async function handler(req, res) { ... }

// TO:
module.exports = async function handler(req, res) { ... }
```

### Every named export becomes module.exports:
```js
// FROM:
export async function askGroq(messages) { ... }

// TO:
async function askGroq(messages) { ... }
module.exports = { askGroq };
```

## Files That Need Rewriting
1. `api/_ai.js` — shared AI functions
2. `api/_supabase.js` — shared Supabase client
3. `api/ask.js` — POST /ask
4. `api/parse.js` — POST /parse
5. `api/upload.js` — POST /upload
6. `api/login.js` — POST /api/login
7. `api/chat-history.js` — GET /api/chat-history
8. `api/auth/google/index.js` — GET /auth/google
9. `api/auth/google/callback.js` — GET /auth/google/callback
10. `api/auth/google/status.js` — GET /auth/google/status
11. `api/google/info.js` — GET /api/google/info
12. `api/focus/[action].js` — POST /api/focus/*

## Also Remove
- `api/package.json` (the `{"type":"commonjs"}` file — not needed once files are CJS)

## Current vercel.json (correct, keep as-is)
```json
{
  "version": 2,
  "routes": [
    { "src": "/auth/google/callback", "dest": "/api/auth/google/callback" },
    { "src": "/auth/google/status", "dest": "/api/auth/google/status" },
    { "src": "/auth/google", "dest": "/api/auth/google" },
    { "src": "/ask", "dest": "/api/ask" },
    { "src": "/parse", "dest": "/api/parse" },
    { "src": "/upload", "dest": "/api/upload" },
    { "src": "/login", "dest": "/login.html" },
    { "src": "/help/(.*)", "dest": "/help/$1" },
    { "src": "/(.*)", "dest": "/$1" }
  ]
}
```

## login.html Change Already Made
`fetch('/login'` → `fetch('/api/login'` ✅ (already done)

## Tomorrow's Steps
1. Upload this file to Claude
2. Claude rewrites all 12 api files in CommonJS
3. Replace files in `Mobius_Vercel/api/` folder
4. Run `npx vercel --prod`
5. Check Deployment Summary shows Serverless Functions (not just Static Assets)
6. Test login at https://mobius-plum.vercel.app/login
