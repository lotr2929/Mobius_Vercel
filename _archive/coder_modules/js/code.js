// ── js/code.js ────────────────────────────────────────────────────────────────
// Code: family -- generate, fix, explain, review, file.
// Smart file resolution: Groq identifies relevant files from description.
// Aliases: fix, explain, review kept for backward compatibility.
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  const S_CODE = 'You are an expert coding assistant. Write clean, well-commented, production-ready code. '
    + 'Explain what the code does and why. Never truncate code. Match the user\'s language and framework '
    + 'unless asked otherwise. British English.';

  const S_FIX  = 'You are an expert debugger and code fixer. Provide a minimal, targeted fix. '
    + 'Show the changed lines with enough context to locate them. '
    + 'Explain exactly what was wrong and what the fix does. British English.';

  const S_EXPL = 'You are a patient coding teacher. Explain the code clearly, walking through what each '
    + 'part does and why. Assume the reader is intelligent but unfamiliar with this specific code. British English.';

  const S_REVW = 'You are a senior code reviewer. Identify bugs, security issues, performance problems, '
    + 'and style issues. Be specific and actionable. Group findings by severity: Critical / High / Medium / Low. British English.';

  // ── File context builder ───────────────────────────────────────────────────

  function buildContext(instruction, files) {
    // files: array of {path, content} or single {path, content}
    if (!files || (Array.isArray(files) && files.length === 0)) return instruction;
    const arr = Array.isArray(files) ? files : [files];
    const blocks = arr.map(f =>
      'File: ' + f.path + '\n\n```\n' + f.content + '\n```'
    ).join('\n\n---\n\n');
    return blocks + '\n\n' + instruction;
  }

  function withFileContext(instruction, fileOverride) {
    const f = fileOverride || window.lastReadFile;
    if (!f) return instruction;
    return buildContext(instruction, f);
  }

  // ── Smart file resolver ────────────────────────────────────────────────────
  // Given a plain-English description, uses Groq + project map to identify
  // which files are relevant, then reads them via File System Access API.
  // Falls back to fuzzy filename search if Groq fails or no map.

  const SKIP_DIRS = new Set(['.git', 'node_modules', '_debug', 'dist', 'build', '.vercel', 'backups', '__pycache__', '.venv']);

  async function findFileByName(dirHandle, target, results, depth) {
    if (depth > 6) return;
    const lower = target.toLowerCase();
    for await (const [name, h] of dirHandle.entries()) {
      if (SKIP_DIRS.has(name)) continue;
      if (h.kind === 'directory') {
        await findFileByName(h, target, results, depth + 1);
      } else {
        if (name.toLowerCase().includes(lower)) results.push({ name, handle: h });
      }
    }
  }

  async function readHandlePath(rootHandle, relPath) {
    try {
      const parts = relPath.replace(/\\/g, '/').split('/');
      let current = rootHandle;
      for (const part of parts) {
        if (!part) continue;
        let found = false;
        for await (const [name, h] of current.entries()) {
          if (name === part) { current = h; found = true; break; }
        }
        if (!found) return null;
      }
      if (current.kind !== 'file') return null;
      const file    = await current.getFile();
      const content = await file.text();
      return content;
    } catch { return null; }
  }

  async function resolveFiles(description, output) {
    const handle = window.getRootHandle ? window.getRootHandle() : null;
    if (!handle) return null;

    const map = window.projectMap || null;

    // ── Step 1: Ask Groq which files are relevant ─────────────────────────
    if (map) {
      output('Identifying relevant files...');
      const trimmedMap = map.split('\n').slice(0, 120).join('\n'); // ~3KB max
      const prompt = 'You are helping a developer find relevant source files.\n\n'
        + 'Project file map:\n' + trimmedMap + '\n\n'
        + 'Task: ' + description + '\n\n'
        + 'List the 1-3 most relevant source files for this task. '
        + 'Respond ONLY with a JSON array of relative file paths, e.g. ["app/js/north-point-2d.js"]. '
        + 'No explanation. No markdown.';

      try {
        const res  = await fetch('/ask', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: prompt, model: 'groq', userId: window.getAuth('mobius_user_id') })
        });
        const data = await res.json();
        const raw  = (data.reply || data.answer || '').trim()
          .replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

        const paths = JSON.parse(raw);
        if (Array.isArray(paths) && paths.length > 0) {
          const files = [];
          for (const p of paths) {
            const content = await readHandlePath(handle, p);
            if (content !== null) {
              files.push({ path: p, content });
              window.lastReadFile = { path: p, content }; // keep last for follow-ups
            }
          }
          if (files.length > 0) {
            output('Found: ' + files.map(f => f.path.split('/').pop()).join(', '));
            return files;
          }
        }
      } catch { /* fall through to fuzzy search */ }
    }

    // ── Step 2: Fallback -- fuzzy filename search ─────────────────────────
    // Extract the most likely filename hint from the description
    output('Searching project for relevant files...');
    const words    = description.toLowerCase().split(/\s+/);
    const fileHint = words.find(w => w.includes('.') || w.includes('-') || w.includes('_')) || words[0];

    const results = [];
    await findFileByName(handle, fileHint, results, 0);

    if (results.length === 0) return null;

    // Pick best match -- prefer shorter names (less ambiguous)
    results.sort((a, b) => a.name.length - b.name.length);
    const best = results[0];
    try {
      const file    = await best.handle.getFile();
      const content = await file.text();
      window.lastReadFile = { path: best.name, content };
      output('Found: ' + best.name);
      return [{ path: best.name, content }];
    } catch { return null; }
  }

  // ── detectFileRef: checks if args start with an explicit file reference ──
  // Returns { filePath, instruction } or null if no file reference detected.

  function detectFileRef(args) {
    const parts    = args.trim().split(/\s+/);
    const first    = parts[0];
    const rest     = parts.slice(1).join(' ').trim();
    // Has a file extension or a path separator -> treat as explicit file ref
    const hasExt   = /\.[a-zA-Z0-9]{1,5}$/.test(first);
    const hasSlash = first.includes('/') || first.includes('\\');
    if ((hasExt || hasSlash) && rest) return { filePath: first, instruction: rest };
    return null;
  }

  // ── Handlers ──────────────────────────────────────────────────────────────

  async function handleCode(args, output, outputEl) {
    if (!args.trim()) {
      output('Usage: Code: [your request]\nExample: Code: write a function that parses a CSV string');
      return;
    }
    const messages = [{ role: 'user', content: S_CODE + '\n\n' + args.trim() }];
    await window.sendToAI('gemini', messages, output, outputEl,
      { toPanel: true, panelTitle: 'Code', panelType: 'html' });
  }

  async function handleCodeFix(args, output, outputEl) {
    if (!args.trim()) {
      output('Usage: Code: Fix [describe the issue]');
      return;
    }

    let files = null;
    const ref = detectFileRef(args);

    if (ref) {
      // Explicit file reference -- read it directly
      await window.ensureAccess(output);
      const content = await readHandlePath(window.getRootHandle(), ref.filePath);
      if (content) {
        files = [{ path: ref.filePath, content }];
        window.lastReadFile = files[0];
      }
    } else if (window.lastReadFile) {
      // Already have a file loaded -- use it
      files = [window.lastReadFile];
    } else if (window.getRootHandle && window.getRootHandle()) {
      // Smart resolve from description
      files = await resolveFiles(args.trim(), output);
    }

    const prompt   = buildContext(args.trim(), files);
    const messages = [{ role: 'user', content: S_FIX + '\n\n' + prompt }];
    const fname    = files && files.length ? files[0].path.split('/').pop() : null;
    await window.sendToAI('gemini', messages, output, outputEl,
      { toPanel: true, panelTitle: fname ? 'Fix: ' + fname : 'Code: Fix', panelType: 'html' });
  }

  async function handleCodeExplain(args, output, outputEl) {
    if (!args.trim()) {
      output('Usage: Code: Explain [what to explain]\nExample: Code: Explain the compass rotation');
      return;
    }

    let files = null;
    const ref = detectFileRef(args);

    if (ref) {
      // Explicit file reference
      await window.ensureAccess(output);
      const content = await readHandlePath(window.getRootHandle(), ref.filePath);
      if (content) {
        files = [{ path: ref.filePath, content }];
        window.lastReadFile = files[0];
      }
    } else if (window.lastReadFile) {
      // File already loaded
      files = [window.lastReadFile];
    } else if (window.getRootHandle && window.getRootHandle()) {
      // Smart resolve -- no file loaded, use description to find one
      files = await resolveFiles(args.trim(), output);
    }

    const prompt   = buildContext(args.trim(), files);
    const messages = [{ role: 'user', content: S_EXPL + '\n\n' + prompt }];
    const fname    = files && files.length ? files[0].path.split('/').pop() : null;
    await window.sendToAI('gemini-lite', messages, output, outputEl,
      { toPanel: true, panelTitle: fname ? 'Explain: ' + fname : 'Explain', panelType: 'html' });
  }

  async function handleCodeReview(args, output, outputEl) {
    if (!args.trim()) {
      output('Usage: Code: Review [what to review]');
      return;
    }

    let files = null;
    const ref = detectFileRef(args);

    if (ref) {
      await window.ensureAccess(output);
      const content = await readHandlePath(window.getRootHandle(), ref.filePath);
      if (content) {
        files = [{ path: ref.filePath, content }];
        window.lastReadFile = files[0];
      }
    } else if (window.lastReadFile) {
      files = [window.lastReadFile];
    } else if (window.getRootHandle && window.getRootHandle()) {
      files = await resolveFiles(args.trim(), output);
    }

    const prompt   = buildContext(args.trim(), files);
    const messages = [{ role: 'user', content: S_REVW + '\n\n' + prompt }];
    const fname    = files && files.length ? files[0].path.split('/').pop() : null;
    await window.sendToAI('gemini', messages, output, outputEl,
      { toPanel: true, panelTitle: fname ? 'Review: ' + fname : 'Code: Review', panelType: 'html' });
  }

  // ── Code: File [filename-or-description] [instruction] ───────────────────
  // Smart version: if first token is not an exact path, searches project.

  async function handleCodeFile(args, output, outputEl) {
    if (!args.trim()) {
      output('Usage: Code: File [filename or description] [instruction]\n'
        + 'Examples:\n'
        + '  Code: File north-point-2d.js explain the rotation logic\n'
        + '  Code: File compass explain how rotation works');
      return;
    }

    if (!await window.ensureAccess(output)) return;

    const parts       = args.trim().split(/\s+/);
    const fileRef     = parts[0];
    const instruction = parts.slice(1).join(' ').trim();

    if (!instruction) {
      output('Missing instruction. Example: Code: File compass explain how rotation works');
      return;
    }

    const handle = window.getRootHandle();
    let files    = null;

    // Try exact path first
    const exact = await readHandlePath(handle, fileRef);
    if (exact !== null) {
      files = [{ path: fileRef, content: exact }];
      window.lastReadFile = files[0];
    } else {
      // Smart resolve: use fileRef as filename hint + instruction as description
      const combined = fileRef + ' ' + instruction;
      files = await resolveFiles(combined, output);
    }

    if (!files || files.length === 0) {
      output('Could not find a file matching "' + fileRef + '".\n'
        + 'Try: Project: Find ' + fileRef);
      return;
    }

    // Pick system prompt from instruction keywords
    const lower = instruction.toLowerCase();
    let sys, titlePrefix;
    if (lower.startsWith('explain') || lower.startsWith('what') || lower.startsWith('how')) {
      sys = S_EXPL; titlePrefix = 'Explain';
    } else if (lower.startsWith('review') || lower.startsWith('audit')) {
      sys = S_REVW; titlePrefix = 'Review';
    } else {
      sys = S_FIX; titlePrefix = 'Fix';
    }

    const fname    = files[0].path.split('/').pop();
    const prompt   = buildContext(instruction, files);
    const messages = [{ role: 'user', content: sys + '\n\n' + prompt }];
    await window.sendToAI('gemini', messages, output, outputEl,
      { toPanel: true, panelTitle: titlePrefix + ': ' + fname, panelType: 'html' });
  }

  // ── Self-register ──────────────────────────────────────────────────────────

  function register() {
    if (!window.COMMANDS) { setTimeout(register, 50); return; }

    window.COMMANDS['code']          = { handler: handleCode,        family: 'code', desc: 'Generate code from a plain-English request'                         };
    window.COMMANDS['code: fix']     = { handler: handleCodeFix,     family: 'code', desc: 'Fix code -- smart file search if no file loaded'                    };
    window.COMMANDS['code: explain'] = { handler: handleCodeExplain, family: 'code', desc: 'Explain code -- smart file search from plain-English description'   };
    window.COMMANDS['code: review']  = { handler: handleCodeReview,  family: 'code', desc: 'Review code -- smart file search if no file loaded'                 };
    window.COMMANDS['code: file']    = { handler: handleCodeFile,    family: 'code', desc: 'Read a file (by name or description) + send instruction to AI'      };

    // Backward-compatible aliases
    window.COMMANDS['fix']     = { handler: handleCodeFix,     family: 'code', desc: 'alias -- Code: Fix'     };
    window.COMMANDS['explain'] = { handler: handleCodeExplain, family: 'code', desc: 'alias -- Code: Explain' };
    window.COMMANDS['review']  = { handler: handleCodeReview,  family: 'code', desc: 'alias -- Code: Review'  };
  }
  register();

})();
