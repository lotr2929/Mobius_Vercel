# Mobius — CLAUDE.md

Personal AI chat with tiered memory (PCM) and web search. Rewritten 1 Oct 2026; the previous version is in `..\Mobius(old)` and in git history.

## Keep (the three fixed points)
1. Free cloud models, kept current (see "The model stack" below)
2. Supabase as the memory store (shared "dlbs" project, `mobius_` tables)
3. Simple chat UI (`frontend/index.html`, vanilla JS)

## The model stack (`backend/ai/models.js` is the single list)
- Each model is tagged with strengths (general, reasoning, code, fast, long-context, multilingual) and ranked per role: `chat` (answers), `quick` (routing), `deep` (big summaries), `learn` (deciding what to remember).
- Prefer `-latest` aliases where a provider offers them; they follow new releases by themselves.
- A model that fails is skipped for a while (1 min after a rate limit, 6 h after 402/404/bad key). Free-tier limits are per model.
- **Keeping it current:** `npm run models` (add `-- --probe` for a tiny live call per model) compares the list with what each provider offers: it flags retired models (skipped automatically) and lists new ones. The same audit runs inside the 6-hourly maintenance. Review its "worth a look" list and update `models.js`.
- Learned the hard way (Oct 2026): Groq retired llama-3.3-70b; Cerebras and Mistral Small/Medium/Magistral and all Gemini Pro models are closed to these free keys. Check access with `--probe`, not just the model list.
- **Free quotas are per model (4 Oct 2026):** the 3.8 and 3.7 Flash allowances ran out for two days while 3.6, 3.5, 3.5-lite and 3-flash-preview still answered, so each extra Gemini Flash version is another quota. The chat order is deliberate: strongest first (Gemini 3.8, 3.7, 3.6, 3.5, gpt-oss-120b, 3-flash-preview, Qwen3.8-27B, then NVIDIA's MiniMax M3 and Nemotron), the small models (ministral-14b, gpt-oss-20b) last, after one of them answered an old question from the memory block. Mistral Small/Medium/Magistral answer 429 on every request and Large is tier-blocked on this key; the bigger open models (Kimi K3, DeepSeek V4, GLM-5.3) are not free by API (Ollama Cloud went credit-based on 31 Aug 2026).
- **NVIDIA NIM** (`provider: 'nvidia'`, key `NVIDIA_API_KEY`, endpoint integrate.api.nvidia.com/v1; free with the NVIDIA Developer Program): MiniMax M3, Nemotron 3 Ultra and Super, and gpt-oss-120b on a second allowance. Models with no key are skipped silently. NVIDIA's free endpoints are "trial use only: no personal or confidential data", and Mobius sends the profile and memory with each message, so they sit below the Gemini models. The ids were taken from a list, not tried (no key yet): after adding the key run `npm run models -- --probe`; a wrong id shows as retired in the audit. Put the key in `C:\_myProjects\.master-env.var`, in `.env`, and in Vercel (Team level first), then redeploy.
- `runCascade(..., { task: 'code' })` tries models tagged for that task first; nothing sets it yet. Intended for the later "best model per job" routing.

## How a message is handled (`backend/chat.js`)
1. Load the last 20 messages (complete question+answer pairs only) verbatim.
2. `pcm/router.js` makes one cheap model call: standalone rewrite of the message, search queries, which projects it concerns, whether the archive, the web or Mobius's own documentation is needed. Rule-based fallback if every model fails.
3. Recall in parallel: profile, week digest, archive search, named document, web search (Tavily, skipped when the answer is already in hand).
4. `pcm/assemble.js` builds a budgeted context pack (about 30K chars; sections ranked, lowest-ranked cut first).
5. Stream the answer from the cascade; save the question and answer together; embed a few backlog rows in the background.

Memory failures never stop the chat; each recall step degrades to "nothing found".

## Debugging (read this first when something looks wrong)
- Every chat turn writes a **trace** to `mobius_traces` (14 days kept, RLS on): the question, the router's plan, what was recalled, the exact prompt sent, which model answered, fallbacks, timings, errors. Browser errors are reported there too.
- Read them: `select id, created_at, data->>'query', data->>'model', data->'plan', data->'marks' from mobius_traces order by id desc limit 5;` in the Supabase SQL Editor (or via the Supabase connector), or `GET /api/debug/traces?n=5` and `/api/debug/trace/<id>` (login required on the live site).
- Fixed on 2 Oct 2026 (found by trace): a question whose answer failed was saved alone, then merged into the *next* question and answered in its place. Now pairs are saved together and unanswered rows are ignored.

## Notes: remembering what Boon asks, and finding what he would want (`pcm/notes.js`)
- **Commands** are plain sentences at the start of a message, matched by rules (no model needed, so they work even when every model is down): `Remember that ...` / `Note: ...` / `Keep in mind ...` / `From now on ...` save a note at once; `Forget ...` or `Forget #14` removes one; `Show notes`; `Show suggestions`; `Save 14, 16` / `Save all`; `Drop 15` / `Drop all`.
- **Learning as he talks** (`pcm/learn.js`; mode chosen in Settings, default from config `LEARN_MODE`): the `learn`-role model reads each message alongside the assistant's previous reply and what is already saved. In `auto` mode an *explicit* definition of his own term, correction of the assistant, or standing preference is saved at once; the reply ends with a line saying what was noted and how to undo it (`forget #14`). Anything less certain becomes a suggestion. It runs in parallel with the answer (starts at the first token), so it adds no waiting time. Found necessary after the model guessed the meaning of his own term "Scriptura Fidelium" wrongly.
- Active notes (table `mobius_notes`) are sent to the model with every message (all of them if they fit in 3,000 chars, else the most relevant plus the newest).
- **Review job** (`harvestNotes` in `pcm/maintain.js`, part of the 6-hourly maintenance): a model reads new conversation, compares it with notes, profile and projects, and *suggests* up to 8 notes per batch. Suggestions from the review job stay `proposed` until Boon says "save"; at the start of a conversation Mobius mentions that some are waiting. First run read the whole history. Max 20 waiting at a time. Rejected or forgotten notes are not suggested again.
- Not yet built: folding long-lived notes into the profile; semantic (embedding) selection when notes outgrow the prompt.

## Conversation continuity
One continuous stream (there is no separate "conversation" object). The last 20 messages (10 exchanges) go to the model verbatim; older material arrives as the week digest, recent un-digested lines, project notes and archive search. The UI's reset button only clears the screen.

## Syncing devices
All state is in Supabase, so the phone and laptop (and the local server and Vercel) share one history and memory. Each device refreshes its history list every 30 seconds and when the app regains focus; the arrows then include exchanges from the other device. A question and its answer are written in one insert, so two devices chatting at once never interleave.

## The four memory tiers
| Tier | Holds | Stored in | Refreshed by |
|---|---|---|---|
| 1 Immediate | last 20 messages verbatim + 7-day digest | `mobius_messages`, `mobius_memory` kind `week` | digest: `pcm/maintain.js` |
| 2 Personal | profile of Boon (target 3,000 chars; a longer one is condensed by a model) | `mobius_memory` kind `profile` | weekly update, used at once; Boon edits it in Settings |
| 3 Current | one note per project active in the last 30 days | `mobius_memory` kind `project` | incremental, from new messages |
| 4 Archive | every message and document | `mobius_messages`, `mobius_docs`, `mobius_docs_full` | live; embeddings filled in the background |

Archive search is hybrid (vector + keyword, fused in SQL: `pcm_search_messages`, `pcm_search_docs`). With Gemini's quota exhausted it degrades to keywords only.

## Development notes: Boon's to-do list for Mobius (READ AT THE START OF EVERY SESSION)
- Boon types instructions and improvements into Settings > Development notes from any device. Stored in `mobius_devnotes` (Supabase); on the laptop a readable copy of the open items is kept in `_dev\devnotes.md`. Never sent to any AI model.
- **At the start of a session:** read the open items (`select id, content, created_at from mobius_devnotes where status = 'open' order by id;` via the Supabase connector, or `GET /api/devnotes`), tell Boon what is waiting, and work through them with him.
- **When one is finished:** mark it done with a line saying what was done: `update mobius_devnotes set status = 'done', done_at = now(), result = '...' where id = N;`. Boon sees it under Done in Settings.
- Removed notes go to the backup like everything else (`devnote` kind); finished ones are retired after 90 days.

## Reading a whole folder: digests (`docs/digest.js`, table `mobius_digests`)
- Search finds passages; it cannot answer "what runs through all of these?" because no model has seen the whole. So every document is **digested once, in advance** (maintenance step `digests`): its text is cut into ~16,000-character sections (small enough for every model in the stack), a `deep`-role model writes a ~150–200-word digest of each (`level='section'`), and those are folded in order into one ~300–400-word digest of the file (`level='doc'`). Files under 4,000 characters are their own digest. Digests are derived, so they are not backed up; a changed file (`mobius_docs_full.updated_at` differs) has them rebuilt. Resumable: a rate limit or time limit stops the run and the next carries on from the last finished section.
- **Pace:** by hand (`npm run maintain`) it runs to the end; the daily timed run makes at most 60 model calls and keeps 30% of its time for embedding. Files from linked folders (`<label>/…`) are digested first.
- **At chat time** (`chat.js`): `folderScope()` decides whether the question is about a whole folder or collection ("the documents in Scriptura Fidelium", "across my documents"). A folder name alone does not count, because "Scriptura Fidelium" is also Boon's own term in ordinary talk. If so, the `doc` digests of that folder (or all) go into the context (cap 14,000 chars). A **named long file** (over 20,000 chars) is sent as its `doc` digest plus the section digests that best match the question, together with the usual search passages, instead of being cut at 20,000 characters.
- `findNamedDoc` ignores the `<folder>/` prefix, and a long title is found by its first three words (not for exported chats, whose names end in a hash).
- **Big files:** the live site reads Drive files under 25 MB and keeps 1,000,000 characters per file. Anything bigger (a whole book) goes in from the laptop: `npm run ingest -- "<file or folder>" --label "<linked folder name>"` (no limit, up to 6,000,000 characters; stops at 85% database use), then `npm run maintain` for digests and embeddings. A 1,000-page book is about 3 million characters, ≈ 6,000 search passages, ≈ 45 MB of database.
- **Linked folders cannot be read from the laptop:** the Google token is sealed with `SESSION_SECRET`, which exists only on Vercel. Read them with Settings → "Read new files now" on the live site. (`npm run maintain -- --drive` reads only the old single `DRIVE_FOLDER_ID` folder.)
- Not built: images and scanned PDFs in Drive folders are skipped (a vision model could describe them as they are read).
- **Opening a long Drive file in chat (fixed 4 Oct 2026, after a trace showed a "summary" of a 727,842-character book written from its first 20,000 characters, with no word that most of it was unread):** `workspace.js actOpen` still gives the model the first 20,000 characters, but now (1) says so in capitals, with the percentage, in both the drive result and the context part's title, and the system prompt forbids describing unread parts; (2) **files the whole text in the archive** (`archiveOpened`: under `<linked folder>/<name>` if its folder is linked, so nothing is stored twice, else `Drive/<name>`; refused above 85% database use; capped at 1,000,000 chars) and starts its digest in the background (`chat.js` end of turn, 10 parts at a time; maintenance finishes it); (3) remembers the file as `state.file.archived` in `mobius_state` (12 h). The router flag `aboutOpenFile` (model, plus the `OPEN_FILE_REF` rule when a file was opened) makes follow-ups such as "is his account representative?" use that file even though it is not named; the context then holds the digest (or, while digesting, the parts done so far and how much of the text they cover), plus `passagesFrom()` (full-text search within that one file, which works before any embedding exists).
- `findNamedDoc` compares names without brackets, punctuation and the "(Z-Library)" tag, so "Anglican Theology by Mark Chapman" finds `Anglican Theology (Mark Chapman) (Z-Library).pdf`.
- **Style (system prompt):** conversational prose, never tables, no stacks of headings or bullets unless Boon asks for a list (the drive listings produced by code are exempt). Models that ignore it need a stronger line in `BASE_PROMPT`.

## Settings page (`/settings.html`, gear icon after the refresh icon in the app)
- **Profile:** edit and save (target 3,000 chars; over it, a `deep`-role model condenses it, never refused or chopped; the original stays under earlier versions). **If no model is available the whole profile is kept** (up to 6,000 chars is sent to the model) and housekeeping condenses it later. Mobius also updates it weekly from conversations and **uses the update straight away**, keeping the old version; a manual edit holds the automatic update off for a day.
- **Notes and suggestions:** edit, add, forget; save or drop suggestions (same as the chat commands).
- **Learning mode:** auto / suggest only / off (stored in `mobius_state` key `settings`; `pcm/settings.js`).
- **Models:** read-only status. **Storage & housekeeping:** database use against the 500 MB free plan, last housekeeping report, run it now. **Backup:** everything removed, with Restore.
- API: `GET/POST /api/pcm/profile`, `GET/POST /api/pcm/notes`, `PUT /api/pcm/notes/:id`, `POST /api/pcm/notes/:id/forget|save|drop`, `GET/POST /api/settings`, `POST /api/housekeeping/run`, `GET /api/backup`, `POST /api/backup/:id/restore`, `DELETE /api/backup/:id`.

## Self-cleaning and backups
- **Principle:** nothing Mobius removes is gone. Deleting a document, pruning an old version, retiring a note: each goes to `mobius_trash` (Supabase, the source of truth, restorable for 180 days) and, when Mobius runs on the laptop, is also written as a JSON file to `C:\_myProjects\_Mobius\Backup` (outside the repository: it holds personal documents; `BACKUP_DIR` overrides). Items trashed while running on Vercel are written to the folder the next time Mobius runs locally. If the backup cannot be made, the deletion does not happen.
- **Housekeeping** (`pcm/housekeeping.js`, a step of every maintenance run): mirrors pending trash to the Backup folder; rebuilds documents that have text but no search chunks (reports, never deletes, chunks without text); lapses suggestions unreviewed for 60 days; trashes notes forgotten/rejected over 180 days ago; clears traces over 14 days; clears trash over 180 days (over 360 if never mirrored); measures storage.
- **Drive:** a file removed from the Google Drive folder is removed here too (into the backup), unless more than 30% of files seem to have vanished at once, which is treated as a bad listing.
- **Capacity:** the whole Supabase project is 195 MB of 500 MB (2 Oct 2026); Mobius's document chunks are about 61 MB for 8,100 chunks, so the 15,000-document PCM archive on the laptop drive does NOT fit and stays on the laptop. Google Drive is the next place to attach if Supabase fills.

## Login (passkeys)
- On only when `SESSION_SECRET` is set (set on Vercel, not locally, so localhost stays open). Code: `backend/auth.js`, page: `frontend/login.html`, passkeys in `mobius_passkeys` (RLS on).
- First visit to the live site shows the sign-in page; use `SETUP_CODE` (Vercel env var) to register each device once, then fingerprint / Windows Hello PIN logs in. Sessions last 30 days (signed cookie).
- Passkeys are tied to the site's hostname (`mobius-pwa.vercel.app`); they do not work on localhost, a Tailscale IP or another Vercel domain.
- Lost every device? Use `SETUP_CODE` to register a new one. To switch login off, remove `SESSION_SECRET` in Vercel and redeploy.

## Layout
```
backend/
  server.js        routes only (the /api contract the UI expects — keep stable)
  chat.js          one chat turn, with its trace
  auth.js          passkey login + session gate
  self.js          self-awareness: date/place, device, server, the Mobius manual
  trace.js         the flight recorder
  version.js       the "Last updated" stamp
  config.js        env + constants (the only place env vars are read)
  db.js util.js web.js maintain-cli.mjs models-cli.mjs
  ai/              models.js (registry), cascade.js (runs them), audit.js (checks them), prompt.js
  pcm/             router, retrieve, assemble, maintain, memory, messages, embed, notes, devnotes, learn, profile, settings, backup, housekeeping
  docs/            store, extract, drive
frontend/          PWA (do not change without being asked)
supabase/schema.sql   idempotent; run in the Supabase SQL Editor
```

## Run
- `start.bat` / `stop.bat` — local server on port 3005
- `npm run maintain` — memory jobs now, no time limit, drains the embedding backlog (`-- --drive` also syncs Drive)
- `npm run models` — check the model stack against the providers (`-- --probe` for live calls)
- `GET /api/pcm/status` — counts and last maintenance; `/api/pcm/maintain` runs the jobs; `/api/models` model states
- Vercel cron `/api/cron/daily` is time-boxed; the local server runs upkeep every 6 hours

## Rules
- Embeddings are Gemini only (`gemini-embedding-001`, 1024-dim). Never mix providers in one column.
- `C:\_myProjects` is a junction to `D:\_myProjects`; `start.bat` uses the D: path on purpose — do not "fix" it.
- Prompts are trimmed per model (`fit()` in `cascade.js`) to respect free-tier limits.
- Cleaning up test data: never delete `mobius_messages` by id range or time. Real chats from the phone and laptop arrive interleaved with test traffic (a range delete on 2 Oct 2026 removed five real phone chats; they were rebuilt from `mobius_traces`, one reply truncated). Identify test rows by their content, and check first.
