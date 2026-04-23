// js/help.js -- mobius help system
// Commands: ? | help | Memory? | Formats? | Code? | Debug? | Project? | Ask? | Chat? | Deploy? | Go?
// Each command opens a reference card in the right panel.

(function () {
  'use strict';

  // ── Renderer ─────────────────────────────────────────────────────────────

  function render(title, sections, outputEl) {
    var html = '<div style="padding:16px;font-size:13px;line-height:1.6;">';
    html += '<div style="font-weight:bold;font-size:15px;color:var(--accent2);margin-bottom:12px;">' + title + '</div>';

    for (var i = 0; i < sections.length; i++) {
      var sec = sections[i];
      if (sec.heading) {
        html += '<div style="font-size:10px;color:var(--text-dim);text-transform:uppercase;'
          + 'letter-spacing:0.1em;margin:14px 0 5px;border-bottom:1px solid var(--border);padding-bottom:2px;">'
          + sec.heading + '</div>';
        continue;
      }
      if (sec.note) {
        html += '<div style="color:var(--text-dim);font-style:italic;font-size:12px;margin:6px 0 4px;padding:6px 10px;'
          + 'background:var(--surface2);border-left:2px solid var(--border2);">' + sec.note + '</div>';
        continue;
      }
      if (sec.cmd !== undefined) {
        html += '<div style="display:flex;gap:12px;padding:4px 0;border-bottom:1px solid var(--border);">'
          + '<code style="color:var(--text);min-width:220px;flex-shrink:0;font-family:var(--font-mono);font-size:12px;">'
          + esc(sec.cmd) + '</code>'
          + '<span style="color:var(--text-muted);font-size:12px;">' + sec.desc + '</span>'
          + '</div>';
      }
    }

    html += '<div style="margin-top:14px;font-size:11px;color:var(--text-dim);">Type a command? for detail &mdash; e.g. Memory? &nbsp; Project? &nbsp; Ask? &nbsp; Formats?</div>';
    html += '</div>';

    if (window.panel) {
      window.panel.open(title, html, 'html');
      outputEl.classList.add('html-content');
      outputEl.innerHTML = '<span style="font-size:13px;color:var(--text-dim);">' + title + ' shown in panel.</span>';
    } else {
      outputEl.classList.add('html-content');
      outputEl.innerHTML = html;
    }
  }

  function esc(t) {
    return String(t || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // ── ? -- master quick reference ───────────────────────────────────────────

  function helpMaster(args, output, outputEl) {
    render('mobius -- Command Reference', [
      { heading: 'Memory' },
      { cmd: 'Memory: View [table|topic]',   desc: 'Browse stored memories -- filter by table or keyword' },
      { cmd: 'Memory: Add [text]',           desc: 'Manually save a fact to memory' },
      { cmd: 'Memory: Search [query]',       desc: 'Semantic search across all memory tables' },
      { cmd: 'Memory: Distil [file]',        desc: 'Synthesise memory_general (or a file) into working tables' },
      { cmd: 'Memory: Vectorise',            desc: 'Generate embeddings for any un-vectorised rows' },
      { cmd: 'Memory: Delete [uuid]',        desc: 'Delete a memory entry by UUID' },
      { note: 'Type Memory? for full detail and workflows' },

      { heading: 'Project' },
      { cmd: 'Project: Home',               desc: 'Set home folder for file logging and commands' },
      { cmd: 'Project: Open',               desc: 'Grant folder access for file reading' },
      { cmd: 'Project: Read [file]',        desc: 'Load a file into the AI context' },
      { cmd: 'Project: Index [status|clear]', desc: 'Build semantic code index for current project' },
      { cmd: 'Project: Slim',               desc: 'Generate condensed file index (_slim.md)' },
      { cmd: 'Project: Brief',              desc: 'Edit project brief (_context/.brief)' },
      { note: 'Type Project? for full detail' },

      { heading: 'Coding' },
      { cmd: 'Code: [request]',             desc: 'Generate code (Gemini) -- Fix / Explain / Review' },
      { cmd: 'Debug: [error]',              desc: '5-step fault pipeline -- Diagnose / Propose / Sandbox / Promote' },
      { note: 'Type Code? or Debug? for pipelines' },

      { heading: 'AI Models' },
      { cmd: 'Ask: Gemini / Groq / Codestral', desc: 'Force a specific cloud model' },
      { cmd: 'Ask: Qwen / DeepSeek / Qwen35',  desc: 'Local Ollama models (offline capable)' },
      { cmd: 'ALL MODE button',              desc: 'Toggle -- every query goes to all models' },
      { note: 'Type Ask? for full model list' },

      { heading: 'Session' },
      { cmd: 'Chat: New',                   desc: 'Start fresh -- clears conversation history' },
      { cmd: 'Chat: History / Diary',        desc: 'Browse past sessions and dev diary' },
      { cmd: 'Chat: End',                   desc: 'Write session summary and update log' },

      { heading: 'Help' },
      { cmd: 'Memory?',    desc: 'Memory system detail' },
      { cmd: 'Formats?',   desc: 'All file formats Coder accepts' },
      { cmd: 'Project?',   desc: 'Project commands detail' },
      { cmd: 'Code?',      desc: 'Code and Debug pipelines' },
      { cmd: 'Ask?',       desc: 'All AI models and modes' },
      { cmd: 'Chat?',      desc: 'Session management' },
      { cmd: 'Deploy?',    desc: 'Backup and deploy' },
      { cmd: 'Go?',        desc: 'Plain-English planner' },
    ], outputEl);
  }

  // ── Memory? ───────────────────────────────────────────────────────────────

  function helpMemory(args, output, outputEl) {
    render('Memory: -- Reference', [
      { heading: 'View and search' },
      { cmd: 'Memory: View',              desc: 'Show all memories across all 5 tables (user / tools / project / mobius + general)' },
      { cmd: 'Memory: View user',         desc: 'Show only the user table' },
      { cmd: 'Memory: View tools',        desc: 'Show only the tools table' },
      { cmd: 'Memory: View project',      desc: 'Show only the project table' },
      { cmd: 'Memory: View mobius',       desc: 'Show only the mobius self-awareness table' },
      { cmd: 'Memory: View GPRTool',      desc: 'Show all entries containing "gprTool" across all tables' },
      { cmd: 'Memory: View compass',      desc: 'Show all entries matching the keyword "compass"' },
      { cmd: 'Memory: Search [query]',    desc: 'Semantic vector search -- returns the 15 most relevant memories by meaning' },

      { heading: 'Add and edit' },
      { cmd: 'Memory: Add [text]',        desc: 'Manually store a fact -- Gemini classifies it into the right table automatically' },
      { note: 'To edit an entry: use Memory: View, click the pencil icon. Saving auto-re-vectorises the entry.' },

      { heading: 'Distil and import' },
      { cmd: 'Memory: Distil',            desc: 'Read memory_general (last 48h), synthesise atomic facts into working tables' },
      { cmd: 'Memory: Distil notes.md',   desc: 'Read a file, chunk it, write chunks to memory_general, then distil' },
      { cmd: 'Memory: Distil report.pdf', desc: 'Same -- supports .md .txt .docx .pdf .xlsx (see Formats?)' },
      { note: 'Distil has dedup: exact match and semantic similarity >= 0.92 both skip duplicates. Safe to run repeatedly.' },

      { heading: 'Vectorise and delete' },
      { cmd: 'Memory: Vectorise',         desc: 'Generate and store vectors for any rows with embedding = null. Verifies in Supabase after.' },
      { cmd: 'Memory: Delete [uuid]',     desc: 'Delete a specific entry by UUID (copy UUID with the copy button in Memory: View)' },

      { heading: 'How memory is injected' },
      { note: 'Before every AI query, Coder runs a semantic search against your memory and prepends the top 15 relevant facts to the prompt. You never need to paste context manually.' },

      { heading: 'The 5 memory tables' },
      { cmd: 'memory_general',   desc: 'Raw intake -- Q+A pairs auto-written after every response, file chunks from Distil' },
      { cmd: 'memory_user',      desc: 'Facts about you -- preferences, tools, credentials, working style' },
      { cmd: 'memory_tools',     desc: 'Reusable technical lessons -- patterns that apply across all projects' },
      { cmd: 'memory_project',   desc: 'Project decisions -- architecture, bugs fixed, file paths, URLs' },
      { cmd: 'memory_mobius',    desc: 'Mobius self-awareness -- commands, models, architecture, routing rules' },

      { heading: 'Seed files (Supabase SQL editor)' },
      { cmd: '_context/seed_memory_user.sql',       desc: 'Boon profile facts' },
      { cmd: '_context/seed_memory_project.sql',    desc: 'GPRTool + Mobius project facts' },
      { cmd: '_context/seed_memory_tools.sql',      desc: 'Technical lessons' },
      { cmd: '_context/create_memory_mobius.sql',   desc: 'Create memory_mobius table + seed' },
      { cmd: '_context/seed_memory_expanded.sql',   desc: 'Second batch -- more entries' },
      { cmd: '_context/seed_memory_expanded2.sql',  desc: 'Third batch -- deep technical' },
    ], outputEl);
  }

  // ── Formats? ─────────────────────────────────────────────────────────────

  function helpFormats(args, output, outputEl) {
    render('Formats -- What Coder Accepts', [
      { heading: 'Plain text (read directly, no library needed)' },
      { cmd: '.md',   desc: 'Markdown -- the primary format for notes, decisions, journals' },
      { cmd: '.txt',  desc: 'Plain text' },
      { cmd: '.js .ts .jsx .tsx', desc: 'JavaScript / TypeScript source files' },
      { cmd: '.html', desc: 'HTML -- includes inline CSS and JS' },
      { cmd: '.css',  desc: 'Stylesheets' },
      { cmd: '.json', desc: 'JSON data and config files' },
      { cmd: '.csv',  desc: 'Comma-separated values' },
      { cmd: '.xml',  desc: 'XML documents' },
      { cmd: '.py',   desc: 'Python source files' },
      { cmd: '.yaml .yml', desc: 'YAML config' },

      { heading: 'Office documents (library loaded on demand)' },
      { cmd: '.docx', desc: 'Word documents -- text extracted via mammoth.js' },
      { cmd: '.pdf',  desc: 'PDF -- text extracted via pdf.js. Text PDFs only, not scanned images.' },
      { cmd: '.xlsx .xls', desc: 'Excel spreadsheets -- converted to CSV text via SheetJS' },

      { heading: 'Project: Index (code indexing)' },
      { cmd: '.js',   desc: 'JavaScript -- always indexed' },
      { cmd: '.html', desc: 'HTML -- always indexed' },
      { cmd: '.md',   desc: 'Markdown -- always indexed' },
      { cmd: 'vercel.json  mcp.json  package.json  CLAUDE.md', desc: 'Named config files -- always indexed' },
      { note: 'Skipped automatically: node_modules/ .git/ backups/ chats/ -- and any file not matching the above extensions' },

      { heading: 'Not yet supported' },
      { cmd: 'Images (.jpg .png .gif .webp)', desc: 'Planned -- Gemini Vision will describe, then distil' },
      { cmd: '.pptx',  desc: 'Planned -- PowerPoint text extraction' },
      { cmd: 'Audio / Video', desc: 'Not planned' },

      { heading: 'How to use' },
      { note: 'Memory: Distil [filename] -- finds the file in your project home, extracts text, chunks it, writes to memory_general, and distils into working tables.' },
      { note: 'If the file is not in your project home folder, a file picker will open automatically.' },
    ], outputEl);
  }

  // ── Project? ─────────────────────────────────────────────────────────────

  function helpProject(args, output, outputEl) {
    render('Project: -- Reference', [
      { heading: 'Setup -- run once per session' },
      { cmd: 'Project: Home',          desc: 'Pick your project root folder -- required for file logging, Map, Index, and Distil' },
      { cmd: 'Project: Open',          desc: 'Open a project folder to work on (sets target to that project)' },
      { cmd: 'Project: Close',         desc: 'Close the open project -- clears context, resets target to Home' },

      { heading: 'Reading files into AI context' },
      { cmd: 'Project: Read [file]',   desc: 'Load a specific file -- shows in panel, injects into next AI query' },
      { cmd: 'Project: List',          desc: 'List all files in the root of the opened folder' },
      { cmd: 'Project: Find [name]',   desc: 'Search all files by filename or keyword' },
      { cmd: 'Project: Scan',          desc: 'Rebuild the file map after adding or renaming files' },
      { cmd: 'Project: Parse',         desc: 'Find source files missing header comments; AI generates them' },

      { heading: 'Context documents' },
      { cmd: 'Project: Map',           desc: 'Build annotated file tree, save as _context/_map.md' },
      { cmd: 'Project: Slim',          desc: 'Generate condensed index of key files (_context/_slim.md) via Gemini' },
      { cmd: 'Project: Brief',         desc: 'Open _context/.brief in edit panel -- your 1-page project summary for AI' },

      { heading: 'Code Index -- semantic file search' },
      { cmd: 'Project: Index',         desc: 'Walk the project tree, summarise every .js/.html/.md file via Gemini, store with vectors' },
      { cmd: 'Project: Index status',  desc: 'Show how many files are currently indexed and their paths' },
      { cmd: 'Project: Index clear',   desc: 'Delete the entire code index for the current project' },
      { note: 'Once indexed, the top 5 most relevant files are injected into every AI query automatically (when window._indexedProject is set).' },

      { heading: 'Indexed file types' },
      { note: '.js  .html  .md  and named configs: vercel.json  mcp.json  package.json  CLAUDE.md. See Formats? for full list.' },

      { heading: 'Typical session workflow' },
      { note: '1. Project: Home  2. Project: Open  3. Project: Read [file]  4. Ask a question -- context is injected automatically' },
    ], outputEl);
  }

  // ── Code? ─────────────────────────────────────────────────────────────────

  function helpCode(args, output, outputEl) {
    render('Code: and Debug: -- Reference', [
      { heading: 'Code: -- generate and analyse' },
      { cmd: 'Code: [request]',              desc: 'Generate code from a plain-English request (Gemini)' },
      { cmd: 'Code: Fix [issue]',            desc: 'Targeted fix -- injects last Project: Read file automatically' },
      { cmd: 'Code: Explain [paste]',        desc: 'Walk through what a piece of code does (Gemini Lite)' },
      { cmd: 'Code: Review [paste]',         desc: 'Code review -- bugs, security, performance (Gemini)' },
      { cmd: 'Code: File [file] [instruction]', desc: 'Read a file and apply an instruction in one step' },

      { heading: 'Debug: -- 5-step fault pipeline (run in order)' },
      { cmd: 'Debug: [error message]', desc: 'Step 1 -- Triage: classify fault type, identify likely files (Groq)' },
      { cmd: 'Debug: Diagnose',        desc: 'Step 2 -- Read those files live, find root cause (Gemini)' },
      { cmd: 'Debug: Propose',         desc: 'Step 3 -- Write a plain-English fix plan for your approval (Gemini)' },
      { cmd: 'Debug: Sandbox',         desc: 'Step 4 -- Write the fix to _debug/fix/ only -- real files untouched (Codestral)' },
      { cmd: 'Debug: Promote CONFIRM', desc: 'Step 5 -- Copy fix to the real file. Must type CONFIRM exactly.' },

      { heading: 'Debug: pipeline rules' },
      { note: 'AI stops after every step and waits for your decision. Nothing is written to real files until Promote CONFIRM.' },
      { note: 'State is held in window.debugState between steps -- close the chat to reset.' },
      { note: 'Files are always read live from disk via FileSystem Access API -- never from AI memory.' },
    ], outputEl);
  }

  // ── Ask? ──────────────────────────────────────────────────────────────────

  function helpAsk(args, output, outputEl) {
    render('Ask: -- AI Models and Modes', [
      { heading: 'Cloud models -- general' },
      { cmd: 'Ask: Lite',                   desc: 'Gemini 2.5 Flash-Lite -- fast, default for most queries' },
      { cmd: 'Ask: Groq',                   desc: 'Llama 3.3 70B via Groq -- fast cloud fallback' },
      { cmd: 'Ask: Codestral / Mistral',    desc: 'Mistral Codestral -- specialised for code writing' },
      { cmd: 'Ask: GPT',                    desc: 'GPT-4o via GitHub AI (Azure) -- general fallback' },

      { heading: 'Cloud models -- coding' },
      { cmd: 'Ask: Gemini',                 desc: 'Gemini 2.5 Flash -- default for Code:, Fix:, Review:' },

      { heading: 'Local models -- Ollama (offline capable)' },
      { cmd: 'Ask: Qwen35',                 desc: 'Qwen3.5 35B-a3b -- most capable local model, slow (requires Ollama running)' },
      { cmd: 'Ask: Qwen',                   desc: 'Qwen2.5-Coder 7B -- fast local coding model' },
      { cmd: 'Ask: DeepSeek',               desc: 'DeepSeek R1 7B -- local reasoning and step-by-step debugging' },
      { cmd: 'Ask: Ollama',                 desc: 'Default local model (whatever Ollama serves on :11434)' },
      { note: 'Ollama auto-starts via Task Scheduler. Portable install at: C:\\Users\\263350F\\ollama-ipex-llm-2.3.0b20250612-win' },

      { heading: 'Modes' },
      { cmd: 'ALL MODE button',             desc: 'Toggle All Mode -- every query is sent to all 5 cloud model stables simultaneously' },
      { cmd: 'Ask: All [query]',            desc: 'One-off -- send a specific query to all models and compare' },
      { cmd: 'Ask: Next',                   desc: 'Retry the last query on the next model in the fallback chain' },

      { heading: 'Special' },
      { cmd: 'Ask: Web [query]',            desc: 'Web search via Tavily + AI synthesis' },
      { cmd: 'Ask: Scores [category]',      desc: 'Win/loss leaderboard per model -- filter by category e.g. Scores Fix' },
      { cmd: 'Ask: Status',                 desc: 'Ping all cloud and local models and show health' },

      { heading: 'How plain text routes' },
      { note: 'Any message without a command prefix is sent to the last model you used. The model name shown in the top-right is the current default.' },
    ], outputEl);
  }

  // ── Chat? ─────────────────────────────────────────────────────────────────

  function helpChat(args, output, outputEl) {
    render('Chat: -- Session Management', [
      { heading: 'Session control' },
      { cmd: 'Chat: New',         desc: 'Start a fresh chat -- clears conversation history' },
      { cmd: 'Chat: End',         desc: 'Write a session summary and update _context/log_summary.md (Groq)' },

      { heading: 'History and logs' },
      { cmd: 'Chat: History',     desc: 'Browse past sessions stored in Supabase' },
      { cmd: 'Chat: Log',         desc: 'Show _context/log_summary.md from the opened project' },
      { cmd: 'Chat: Diary [n]',   desc: 'Fetch last n dev diary entries from Supabase (default: 5)' },
      { note: 'Chat logs are saved automatically to chats/chat-YYYYMMDD-HHmm.md when Project: Home is set.' },

      { heading: 'Planning' },
      { cmd: 'Chat: Plan',        desc: 'AI reads CLAUDE.md + log_summary.md and recommends the next task' },
      { cmd: 'Go: [intent]',      desc: 'Map a plain-English goal to a step-by-step command plan -- see Go?' },

      { heading: 'Utilities' },
      { cmd: 'Chat: Date',        desc: 'Show current date' },
      { cmd: 'Chat: Time',        desc: 'Show current time' },
    ], outputEl);
  }

  // ── Deploy? ───────────────────────────────────────────────────────────────

  function helpDeploy(args, output, outputEl) {
    render('Deploy: -- Backup and Ship', [
      { heading: 'Steps -- run in order' },
      { cmd: 'Deploy: Backup',          desc: 'Run backup.bat to create a timestamped zip in backups/' },
      { cmd: 'Deploy: Commit [msg]',    desc: 'Commit the last sandboxed file to GitHub dev branch via agent.js' },
      { cmd: 'Deploy: Push',            desc: 'Merge dev into main -- Vercel detects and builds automatically' },
      { cmd: 'Deploy: Run',             desc: 'Instructions to run deploy.bat locally for a full deploy' },

      { heading: 'deploy.bat (the preferred method)' },
      { note: 'Run deploy.bat from Command Prompt in the project folder. It: checks changed files, asks for confirmation, creates a backup zip, bumps service-worker version, auto-generates a commit message, pushes to GitHub, and polls Vercel API until READY.' },

      { heading: 'Notes' },
      { note: 'Deploy: Commit only commits the file from the Debug: Sandbox step. For all-file deploys, use deploy.bat directly.' },
      { note: 'Vercel env vars: set new keys at Team level first, then override at project level.' },
      { note: 'Git commit email must be lotr2929@gmail.com -- not the Curtin email -- or Vercel blocks the deploy trigger.' },
    ], outputEl);
  }

  // ── Go? ───────────────────────────────────────────────────────────────────

  function helpGo(args, output, outputEl) {
    render('Go: -- Plain-English Planner', [
      { heading: 'Commands' },
      { cmd: 'Go: [intent]',   desc: 'Describe a goal; Coder maps it to a step-by-step command plan (Groq)' },
      { cmd: 'Go: Next',       desc: 'Execute the next pending step in the current plan' },
      { cmd: 'Go: Skip',       desc: 'Skip the current step and move to the next' },
      { cmd: 'Go: Stop',       desc: 'Cancel the current plan entirely' },
      { cmd: 'Go: Plan',       desc: 'Show pending steps without running anything' },

      { heading: 'Examples' },
      { cmd: 'Go: fix the login bug',          desc: 'Maps to: Debug: [error] -> Diagnose -> Propose -> Sandbox -> Promote' },
      { cmd: 'Go: review the auth module',     desc: 'Maps to: Project: Read [file] -> Code: Review' },
      { cmd: 'Go: plan next task',             desc: 'Maps to: Chat: Plan' },
      { cmd: 'Go: index the project',          desc: 'Maps to: Project: Home -> Project: Index' },

      { heading: 'Rules' },
      { note: 'AI stops after every step and waits for Go: Next. Nothing runs automatically. You control every gate.' },
      { note: 'Requires a project folder open. Run Project: Home or Project: Open first.' },
    ], outputEl);
  }

  // ── Register ──────────────────────────────────────────────────────────────

  function register() {
    if (!window.COMMANDS) { setTimeout(register, 50); return; }

    window.COMMANDS['?']         = { handler: helpMaster,  family: 'help', desc: 'Master command reference -- all families' };
    window.COMMANDS['help']      = { handler: helpMaster,  family: 'help', desc: 'alias -- ?' };
    window.COMMANDS['memory?']   = { handler: helpMemory,  family: 'help', desc: 'Memory: system detail -- tables, commands, workflows' };
    window.COMMANDS['formats?']  = { handler: helpFormats, family: 'help', desc: 'All file formats Coder accepts for indexing and distilling' };
    window.COMMANDS['project?']  = { handler: helpProject, family: 'help', desc: 'Project: commands -- Home, Open, Read, Index, Slim, Brief' };
    window.COMMANDS['code?']     = { handler: helpCode,    family: 'help', desc: 'Code: and Debug: pipeline detail' };
    window.COMMANDS['debug?']    = { handler: helpCode,    family: 'help', desc: 'alias -- Code?' };
    window.COMMANDS['ask?']      = { handler: helpAsk,     family: 'help', desc: 'All AI models -- cloud, local, modes' };
    window.COMMANDS['chat?']     = { handler: helpChat,    family: 'help', desc: 'Session management -- history, logs, planning' };
    window.COMMANDS['deploy?']   = { handler: helpDeploy,  family: 'help', desc: 'Backup and deploy workflow' };
    window.COMMANDS['go?']       = { handler: helpGo,      family: 'help', desc: 'Go: plain-English planner detail' };
  }

  register();

})();
