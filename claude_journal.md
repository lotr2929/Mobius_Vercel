# Mobius — Claude Journal

## 30 Jun 2026 — Drive/embedding search session

Got Mobius (port 3005) running after npm install issues (corrupted
node_modules, better-sqlite3 native build failure on Node 24 — fixed with
--ignore-scripts).

Built semantic search for Drive docs + chat history:
- Added query preprocessing (resolveQuery) to resolve "it"/"that" references
  against recent history before search.
- Replaced keyword textSearch with pgvector embeddings (mobius_docs,
  mobius_messages), similarity threshold 0.5.
- Embedding cascade: Gemini (gemini-embedding-001) first, Mistral
  (mistral-embed) fallback on 429/failure, both pinned to 1024-dim so vectors
  are interchangeable. Circuit breaker added (skip Gemini for rest of run
  after first 429; cooldown 60s in live server).
- Per-chat-turn top-up (3 rows) embeds backlog messages automatically;
  no more manual message backfill needed going forward.
- Drive write access enabled (uploadToDrive) — file uploads in Mobius chat
  now also get pushed to the Drive folder, not just embedded.
- Added a "sync Drive now" icon button next to Send in the UI (calls existing
  /api/drive/sync endpoint).
- Confirmed start.bat path is correct as-is (D:\ is the real path,
  C:\_myProjects is the junction — do not "fix" this again).
- History nav (< >) staleness — only loads once on page load, not refreshed
  after each send. Known issue, not yet patched.

UNRESOLVED — stopped mid-cleanup, plan to restart fresh next session:
- mobius_docs had duplicate/misattributed content from old Drive files
  (Ong - 2013 - Beyond Environmental Comfort(2).pdf and (3).pdf were
  different mismatched content, not true duplicates — likely a stray
  unrelated textbook mislabeled). Drive folder cleaned down to ~25-27 files.
- Supabase purge was imprecise — accidentally deleted JoBD_Light.docx/
  JoBD_Sound.docx rows even though those files were still in Drive (my
  misread of the folder listing). Will self-heal on next sync since rows
  were only deleted from Supabase, files still in Drive.
- After purge, mobius_docs total chunks unexpectedly grew back to 3405
  (2019 embedded, 1386 not) — cause not confirmed, possibly an autosync
  or manual sync click re-ran after the purge.
- mobius_messages: 10 total, 0 embedded — embed-on-save logic may not be
  live. Need to confirm server.js with the embedding cascade was actually
  deployed and Mobius restarted after the last edit.
- DECISION: next session, truncate embedding columns (or full tables) for
  mobius_docs/mobius_messages, confirm Drive folder is clean, do one full
  fresh sync + one full fresh backfill from empty state rather than
  reconciling current uncertain state.

Files modified this session (in backend\): server.js, drive-indexer.mjs,
backfill-embeddings.mjs, backfill-message-embeddings.mjs.
Frontend: index.html (added Drive sync icon next to Send).
Supabase migration: supabase_embeddings_migration_v2.sql (1024-dim,
Gemini+Mistral compatible).