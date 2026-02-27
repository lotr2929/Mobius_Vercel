# Mobius PWA — Vercel Deployment

## What changed from Render version
- `server.js` is gone — replaced by serverless functions in `api/`
- `multer` removed — file uploads handled natively in `api/upload.js`
- `express` removed — not needed for serverless
- All routes preserved with identical URLs

## File structure
```
api/
  _ai.js              ← shared AI functions (Groq, Gemini, Mistral, fallback)
  _supabase.js        ← shared Supabase client
  ask.js              ← POST /ask
  parse.js            ← POST /parse
  upload.js           ← POST /upload
  login.js            ← POST /login
  chat-history.js     ← GET /api/chat-history
  auth/google/
    index.js          ← GET /auth/google
    callback.js       ← GET /auth/google/callback
    status.js         ← GET /auth/google/status
  google/
    info.js           ← GET /api/google/info
  focus/
    [action].js       ← POST /api/focus/* (find, read, copy, create, append, update-original)
```

## Deploy steps

1. Copy your existing files into this folder:
   - `index.html`
   - `login.html`
   - `google_api.js`
   - `actions.js`
   - `commands.js`
   - `service-worker.js`
   - `manifest.json`
   - `favicon.ico`
   - `mobius-logo.png`
   - `help/` folder

2. Run: `npm install`

3. Install Vercel CLI: `npm install -g vercel`

4. Run: `vercel` (follow prompts, link to your Vercel account)

5. Add environment variables in Vercel dashboard:
   - Go to your project → Settings → Environment Variables
   - Add all keys from `.env.example`
   - Update GOOGLE_REDIRECT_URI to your actual Vercel domain

6. Update Google Cloud Console:
   - Add your Vercel URL to Authorized redirect URIs

7. Deploy to production: `vercel --prod`
