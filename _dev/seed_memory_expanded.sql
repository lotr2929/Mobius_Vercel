-- seed_memory_expanded.sql
-- Additional entries across all four tables.
-- Paste into Supabase SQL editor, then run Memory: Vectorise.

-- ============================================================
-- memory_user additions
-- ============================================================

INSERT INTO memory_user (id, user_id, content, tags, embedding, created_at, updated_at) VALUES
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'Boon uses VS Code and Claude Desktop as primary coding tools alongside Mobius_Coder', ARRAY['tools','vscode','claude','coding'], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'Boon Python environment: Python 3.11 at C:\Users\263350F\AppData\Local\Programs\Python\Python311\python.exe -- Python 3.13 installed but broken, do not use', ARRAY['python','environment','path','windows'], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'Boon MCP config file: C:\Users\263350F\AppData\Roaming\Claude\claude_desktop_config.json', ARRAY['mcp','config','claude','path'], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'Boon active projects: GPRTool (active), Mobius_Coder (active), Mobius_Vercel (staged backlog), Mobius_Factory (active)', ARRAY['projects','active','overview','status'], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'Boon paused projects: DesktopAI, Finder (fully functional), Daily Grace', ARRAY['projects','paused','finder','desktopai'], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'Boon uses AI models from Gemini, Groq, Mistral, Cerebras, OpenRouter, and local Ollama -- consults ChatGPT, Gemini, and Grok for architecture decisions alongside Claude', ARRAY['ai','models','tools','multimodel'], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'Boon governing principle for AI development: AI proposes, Boon approves -- AI never acts autonomously', ARRAY['principle','workflow','approval','ai'], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'Boon long-term vision: integrated personal AI ecosystem with Mobius as orchestration layer, GPRTool as domain application, Factory modules as autonomous knowledge services', ARRAY['vision','ecosystem','mobius','gpr'], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'For DevTools/UI bugs Boon must open F12 Console and report exactly what he sees before any code changes are proposed', ARRAY['debugging','devtools','ui','workflow'], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'Boon prefers numbered responses that reset to 1 each exchange so individual points can be referenced precisely', ARRAY['preference','numbered','response','format'], NULL, now(), now());

-- ============================================================
-- memory_project additions
-- ============================================================

INSERT INTO memory_project (id, user_id, content, tags, project_ids, file_refs, embedding, created_at, updated_at) VALUES

  -- GPRTool additional
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'GPRTool migrated from Render (Python backend) to Vercel (static PWA) in early 2026 -- no backend required', ARRAY['migration','render','vercel','pwa'], ARRAY['GPRTool'], ARRAY[]::text[], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'GPRTool has 2D surface canvas with Ortho and Surface sub-modes for drawing site boundaries', ARRAY['canvas','2d','ortho','surface'], ARRAY['GPRTool'], ARRAY[]::text[], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'GPRTool plants_free.json contains 56 species with size objects and substrate caps table', ARRAY['plants','json','species','substrate'], ARRAY['GPRTool'], ARRAY['plants_free.json'], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'GPRTool north point compass was a persistent bug across multiple sessions -- designNorthAngle and globalNorthAngle were the key variables causing confusion', ARRAY['compass','north','bug','angle'], ARRAY['GPRTool'], ARRAY[]::text[], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'GPRTool LAI pipeline files: lai_explorer.py, lai_categorise.py, LAI_DATABASE_STRATEGY.md -- merge into LAI_categorised.csv pending', ARRAY['lai','pipeline','python','csv'], ARRAY['GPRTool'], ARRAY['lai_explorer.py','lai_categorise.py','LAI_DATABASE_STRATEGY.md'], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'GPRTool Landgate SLIP API endpoint: https://public-services.slip.wa.gov.au/public/rest/services/SLIP_Public_Services/Places_and_Addresses/MapServer/2/query', ARRAY['landgate','slip','api','cadastral'], ARRAY['GPRTool'], ARRAY[]::text[], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'GPRTool deploy.bat creates backup zip, bumps service worker version, auto-generates commit message, pushes to GitHub, polls Vercel API for build status', ARRAY['deploy','bat','vercel','github'], ARRAY['GPRTool'], ARRAY['deploy.bat'], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'GPRTool legacy Python/Render version archived at C:\Users\263350F\_myProjects\_archive\GPRTool_legacy', ARRAY['legacy','archive','python','render'], ARRAY['GPRTool'], ARRAY[]::text[], NULL, now(), now()),

  -- Mobius_Coder additional
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'Mobius_Coder Debug pipeline: 5 steps each requiring explicit approval -- Triage (Groq), Diagnose (Gemini reads files live), Propose, Sandbox (Codestral writes to _debug/fix/ only), Promote CONFIRM', ARRAY['debug','pipeline','stages','approval'], ARRAY['Mobius_Coder'], ARRAY['js/debug.js'], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'Mobius_Coder Code: command family: generate, fix, explain, review, file -- handled in js/code.js', ARRAY['code','commands','generate','fix'], ARRAY['Mobius_Coder'], ARRAY['js/code.js'], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'Mobius_Coder Project: Open loads _map.md, _slim.md, .brief from _context/ -- must be run each session before file-specific queries', ARRAY['project','open','context','session'], ARRAY['Mobius_Coder'], ARRAY['js/project.js'], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'Mobius_Coder files use File System Access API (browser) via coderRootHandle -- set by Project: Home picker each session unless IndexedDB re-grant succeeds', ARRAY['filesystem','browser','handle','permission'], ARRAY['Mobius_Coder'], ARRAY['js/startup.js'], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'Mobius_Coder vercel.json routes: /ask and /parse -> query/[action].js; /memory -> query/[action].js; /api/health; /api/services/status', ARRAY['vercel','routes','api','endpoints'], ARRAY['Mobius_Coder'], ARRAY['vercel.json'], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'Mobius_Coder local server: node js/server.js at localhost:3000 -- proxies Ollama and serves static files; started via MobiusServer.vbs for invisible Windows startup', ARRAY['server','local','ollama','proxy'], ARRAY['Mobius_Coder'], ARRAY['js/server.js'], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'Mobius_Vercel staged but not yet deployed: Dropbox registry fix, Sync: all + Dropbox, startup panel, stale pack/audit/verify commands removed', ARRAY['mobius-vercel','staged','dropbox','backlog'], ARRAY['Mobius_Vercel'], ARRAY[]::text[], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'Mobius_Factory schema: objectives, sources, findings, knowledge, queries tables; admin UI with Google OAuth whitelist; query-driven autonomous research loop', ARRAY['factory','schema','research','crawler'], ARRAY['Mobius_Factory'], ARRAY[]::text[], NULL, now(), now()),

  -- Other projects
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'Finder project at C:\Users\263350F\_myProjects\Finder -- paused but fully functional file search app', ARRAY['finder','paused','functional','search'], ARRAY['Finder'], ARRAY[]::text[], NULL, now(), now());

-- ============================================================
-- memory_tools additions
-- ============================================================

INSERT INTO memory_tools (id, user_id, content, tags, embedding, created_at, updated_at) VALUES
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'Service worker cache busting: bump version string (e.g. mobius-coder-v34) in service-worker.js on every deploy to force clients to reload assets', ARRAY['service-worker','cache','pwa','deploy'], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'Vercel hobby plan allows max 12 serverless functions -- consolidate endpoints to stay within limit', ARRAY['vercel','serverless','limit','functions'], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'Three.js GLB import: unit auto-detection checks if values exceed 500 -- if so assumes millimetres and scales by 0.001', ARRAY['threejs','glb','units','scale'], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'Google OAuth multi-account setup uses composite primary key (user_id, label) to allow personal/family/work accounts in one app', ARRAY['google','oauth','multiaccount','supabase'], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'Supabase pgvector match function: UNION ALL across all memory tables, order by cosine similarity DESC, return top N -- must include new tables when schema grows', ARRAY['supabase','pgvector','rpc','union'], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'File System Access API: showDirectoryPicker() requires a user gesture -- cannot be called silently on page load', ARRAY['filesystem','browser','gesture','api'], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'PowerShell Compress-Archive requires -Force flag to overwrite existing zip files', ARRAY['powershell','zip','compress','archive'], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'pip install must use --break-system-packages flag on this system to avoid environment conflicts', ARRAY['python','pip','install','windows'], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'When Supabase RPC UNION includes a new table the DROP FUNCTION + CREATE FUNCTION approach is needed -- Supabase SQL editor warns about destructive operations but it is safe', ARRAY['supabase','rpc','drop','recreate'], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'IndexedDB is used to persist FileSystemDirectoryHandle across page reloads -- key stored in mcp.json as idb_key', ARRAY['indexeddb','filesystem','persist','handle'], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'Gemini Lite quota errors should fall back to Groq cascade -- wrap Gemini calls in try-catch and check error.message.includes("quota")', ARRAY['gemini','quota','fallback','groq'], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'Ollama IPEX-LLM portable at C:\Users\263350F\ollama-ipex-llm-2.3.0b20250612-win -- start via start-ollama.bat from Command Prompt in that folder', ARRAY['ollama','ipex','start','path'], NULL, now(), now());

-- ============================================================
-- memory_mobius additions
-- ============================================================

INSERT INTO memory_mobius (id, user_id, content, tags, app_ids, file_refs, embedding, created_at, updated_at) VALUES
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'Mobius_Coder panel (right side) renders code, HTML, and output -- opened by window.panel.open(title, content, type)', ARRAY['panel','ui','output','render'], ARRAY['Mobius_Coder'], ARRAY['js/panel.js'], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'Mobius_Coder command detection: "Word: rest" and "Word: Sub rest" patterns -- commands self-register into window.COMMANDS in each module js file', ARRAY['commands','registry','routing','detection'], ARRAY['Mobius_Coder'], ARRAY['js/commands.js'], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'Mobius_Coder Ask: family routes to specific models -- Ask: Gemini, Ask: Groq, Ask: Codestral, Ask: Qwen, Ask: DeepSeek, Ask: Ollama', ARRAY['ask','models','routing','commands'], ARRAY['Mobius_Coder'], ARRAY['js/ask.js'], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'Mobius_Coder All Mode sends query to all model stables simultaneously -- model name underlined above each response; toggle via ALL MODE button', ARRAY['all-mode','simultaneous','models','toggle'], ARRAY['Mobius_Coder'], ARRAY['js/all.js'], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'Mobius_Coder scores.js tracks localStorage model win/loss scores -- used by router to weight model selection', ARRAY['scores','routing','models','localstorage'], ARRAY['Mobius_Coder'], ARRAY['js/scores.js'], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'Mobius_Coder Map: command walks the File System Access API directory tree and saves result to disk via panel', ARRAY['map','filesystem','tree','command'], ARRAY['Mobius_Coder'], ARRAY['js/map.js'], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'Mobius_Coder Chat: family manages history, new sessions, and dev diary -- stored in Supabase conversations table', ARRAY['chat','history','sessions','diary'], ARRAY['Mobius_Coder'], ARRAY['js/chat.js'], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'Mobius_Coder api/_ai.js contains all model functions and fallback chains -- cloud chain: gemini-lite -> groq -> mistral -> github', ARRAY['ai','fallback','chain','models'], ARRAY['Mobius_Coder'], ARRAY['api/_ai.js'], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'Mobius_Coder connectivity panel checks 5 services on startup: Network, Vercel API, Supabase, Cloud AI (5 models), Local AI (Ollama models)', ARRAY['connectivity','startup','panel','health'], ARRAY['Mobius_Coder'], ARRAY['js/connectivity.js'], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'Mobius_Coder deploy.bat: checks changes, creates backup zip, bumps service worker, auto-generates commit message, pushes to GitHub, polls Vercel API via poll_vercel.ps1', ARRAY['deploy','bat','backup','vercel'], ARRAY['Mobius_Coder'], ARRAY['deploy.bat','_dev/poll_vercel.ps1'], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'Mobius_Coder memory system auto-extracts facts after every AI response via autoExtractMemory() -- writes Q+A pair to memory_general for later distillation', ARRAY['memory','auto-extract','distil','general'], ARRAY['Mobius_Coder'], ARRAY['js/memory.js','js/commands.js'], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'Mobius_Coder Memory: Distil reads last 48h from memory_general, sends batch to Gemini Lite for synthesis, writes atomic facts to working tables with embeddings', ARRAY['distil','gemini','memory-general','synthesis'], ARRAY['Mobius_Coder'], ARRAY['api/_memory.js'], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'Mobius_Coder Memory: View shows entries from all working tables (user, tools, project, mobius) with inline edit, copy UUID, and delete buttons', ARRAY['memory-view','ui','edit','delete'], ARRAY['Mobius_Coder'], ARRAY['js/memory.js'], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'Mobius_Vercel Factory Model: one codebase runs locally on every device; Vercel is the cloud API gateway and sync hub', ARRAY['factory-model','architecture','local','vercel'], ARRAY['Mobius_Vercel'], ARRAY[]::text[], NULL, now(), now()),
  (gen_random_uuid(), '22008c93-c79b-491d-b3c1-efa194c0c871', 'Mobius General Supabase env vars: GENERAL_SUPABASE_URL and GENERAL_SUPABASE_KEY -- set at Team level in Vercel', ARRAY['supabase','env','general','keys'], ARRAY['Mobius_Coder','Mobius_Vercel'], ARRAY[]::text[], NULL, now(), now());
