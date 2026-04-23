# Coder — Project Preparation Protocol
_Detailed task list for review and approval before building._
_Written: 2026-04-11_

---

## Overview

Project: Open is the gatekeeper. Before any work begins on a project, six
scaffolding artefacts must exist and be current. This protocol defines exactly
how each artefact is produced, what it contains, and how it is maintained.

The six artefacts:

  _context/.brief      Collaborative — architecture, vocabulary, constraints
  _context/.map        Automatic — full annotated file tree
  _context/.slim       Automatic — file index with one-line descriptions
  _context/.funcs      Automatic — function index with one-line descriptions
  _context/.context    Automatic — rolling session notes
  Supabase code_chunks Automatic — function bodies chunked and embedded

---

## TASK 1 — Project: Open (the gatekeeper)

### What it does now
Opens folder, runs checkAndRestoreIndex, reports .map/.slim/.brief status.

### What it needs to do
Run a full six-item checklist before any work begins. Hard stop if .brief
is missing. Auto-generate everything else.

### Checklist logic (in order)

  CHECK 1: .brief
    MISSING → output "No brief found. Running Project: Brief..."
              call handleProjectBrief() → interview flow (Task 2)
              do not continue until .brief exists
    PRESENT → load into _projectContext.brief
              read "Current focus" date from brief header
              if date > 7 days ago → output:
              "⚠ Current focus is X days old. Update before working? [Y/N]"
              if Y → open .brief in edit panel
              if N → continue with stale focus noted

  CHECK 2: .map
    MISSING → output "No map found. Running Project: Map..."
              call handleProjectMap() → generates .map + .slim + .funcs
    PRESENT → compare .map lastModified against source file timestamps
              (same staleness logic already in setupProjectContext)
              STALE → output "Map is outdated. Regenerating..."
                      call handleProjectMap()
              CURRENT → load .map, .slim, .funcs into _projectContext

  CHECK 3: .funcs
    MISSING → run Project: Map (should not happen if Map ran, but guard anyway)
    HAS [undocumented] entries → output count:
      "⚠ 3 functions have no description. Review now? [Y/N]"
      if Y → run undocumented review flow (Task 4)
      if N → continue, flagged functions usable but marked in .funcs

  CHECK 4: code_chunks in Supabase
    MISSING or STALE → output "Indexing project..."
                        call existing checkAndRestoreIndex() → Project: Index
    CURRENT → output "Index current (N chunks)"

  CHECK 5: .context
    MISSING → output "No session context yet. Will be created after
              first session (Brief: Maintain)."
              not a blocker — continue
    PRESENT → load into _projectContext.context

### Output on clean pass

  GPRTool — ready.
  .brief ✓  (updated 2 days ago, focus current)
  .map ✓    (42 files, current)
  .slim ✓   (42 entries)
  .funcs ✓  (87 functions, 0 undocumented)
  .context ✓ (3 sessions)
  index ✓   (582 chunks)

  All context loaded. You can begin work.

### Output on first run (nothing exists)

  GPRTool — first time setup.
  No brief found. Starting Project: Brief interview...
  [interview runs]
  Generating map, slim, funcs...
  [map runs]
  Indexing project...
  [index runs]
  Setup complete. GPRTool ready.

---

## TASK 2 — Project: Brief (guided interview)

### What it does now
Opens .brief in edit panel, or saves text passed as argument.

### What it needs to do
Run a structured 5-question interview that produces a well-formed .brief.
The interview is conversational — Coder asks one question at a time in the
chat panel, waits for Boon's typed answer, then asks the next.

### The 5 questions

---

QUESTION 1: What does this project do?

Coder prompt (shown in chat):
  "What does [project name] do, and why does it exist?
   Write 2-3 sentences. Focus on purpose and who uses it.
   Do not include technical stack — that comes from .slim automatically."

Boon answers in the input field and presses Enter.
Coder stores the answer as the "What this is" section.

Example good answer:
  "GPRTool is a browser-based CAD tool for calculating Green Plot Ratio,
   a greenery metric for urban sites. Landscape architects use it to place
   plants on building surfaces and compute GPR scores."

---

QUESTION 2: What is the current focus?

Coder prompt:
  "What are you actively building or debugging right now?
   1-2 sentences. This will be flagged for update after 7 days."

Boon answers.
Coder stores as "Current focus" section with today's date appended:
  "Current focus (2026-04-11): ..."

Example:
  "Fixing the 3D compass gizmo — it appears inverted and DN is not
   aligned with the grid when switching from 2D to 3D view."

---

QUESTION 3: What are the hard constraints?

Coder prompt:
  "List the things an AI must never do in this project.
   These are hard rules, not style preferences — things that would
   break the project or produce wrong results if violated.
   3-5 bullet points. Use plain language."

Boon answers as a list (one item per line).
Coder stores as "Key constraints" section.

Example:
  - Vanilla JS only — no TypeScript, no npm packages in app/
  - Never send LAI_categorised.csv content to external APIs
  - Two coordinate systems (Global and Design) must stay strictly
    separate — mixing them causes compass and grid errors
  - Always propose and get approval before writing any file
  - Use Microsoft Edge for testing — Chrome has rendering issues

---

QUESTION 4: What vocabulary should we use?

Coder prompt:
  "Define the canonical names for the key concepts in this project.
   These exact words must appear in:
     — code comments
     — your queries to Coder
     — Coder's responses
   Consistent vocabulary is what lets Coder find the right code when
   you describe a symptom. One term per line, format: term: definition"

Boon answers as a list.
Coder stores as "Vocabulary" section.

Example:
  gizmo: the 3D compass widget rendered by north-point-3d.js
  housing: the rotating outer ring of the 2D compass (np-rotator)
  DN: Design North — the user's chosen grid orientation (designNorthAngle)
  TN: True North — geographic north offset (globalNorthAngle)
  tilt: the angle between DN and TN shown as a label on the compass
  GPR: Green Plot Ratio — the primary metric this tool calculates
  surface: a detected flat plane from the imported 3D model

---

QUESTION 5: What are the known active issues?

Coder prompt:
  "List any bugs or incomplete features currently in progress.
   These will appear in the brief so Coder knows what is unresolved.
   Write 'none' if the slate is clean."

Boon answers.
Coder stores as "Known issues" section.

Example:
  - 3D compass gizmo: appears inverted, DN not aligned with grid
  - LAI database: Singapore field data merge pending, duplicates
    in Singapore CSV unresolved
  - index.html: substantial inline code still awaiting extraction
    to app/js/ files

---

### Assembly and size check

After all 5 answers are collected, Coder assembles .brief:

  1. Writes the five sections in order
  2. Appends the tech stack note:
     "Stack and file structure: see .slim"
     (prevents duplication of information that already lives in .slim)
  3. Appends a coding standards section:
     "## Coding standards
      - Every function must begin with a one-line comment describing
        what it does, using the vocabulary terms defined above.
      - File headers must state the file's purpose and what it exposes."
  4. Appends ---TEMPLATE--- section (AI system instruction):
     Auto-generated from Q3 answers, formatted as direct instructions:
     "You are a coding assistant for [project].
      [Each constraint from Q3 becomes one instruction line.]
      Source truth: treat [Relevant code] chunks as ground truth.
      Answer format: always reference exact file path and function name.
      Vocabulary: use the terms defined above — not synonyms."
  5. Checks token count (estimate: characters / 4)
     If > 1600 chars (~400 tokens) → flag to Boon:
     "Brief is [N] chars. Recommended maximum is 1600.
      [Section name] is the longest at [N] chars. Trim it?"
  6. Opens assembled .brief in edit panel for final review
  7. Boon edits if needed, clicks Save

### .brief output template

  # [ProjectName] — Project Brief
  _Last updated: YYYY-MM-DD_

  ## What this is
  [Q1 answer — 2-3 sentences]

  ## Current focus
  (YYYY-MM-DD) [Q2 answer — 1-2 sentences]

  ## Key constraints
  - [constraint 1]
  - [constraint 2]
  - [constraint 3]

  ## Vocabulary
  term: definition
  term: definition
  term: definition

  ## Known issues
  - [issue 1]
  - [issue 2]

  ## Coding standards
  - Every function must begin with a one-line comment describing what
    it does, using the vocabulary terms defined above.
  - File headers must state the file's purpose and what it exposes.

  Stack and file structure: see .slim

  ---TEMPLATE---
  You are a coding assistant for [ProjectName].
  [Constraint 1 as instruction.]
  [Constraint 2 as instruction.]
  Source truth: treat [Relevant code] chunks as ground truth —
  never invent function or variable names not shown there.
  Answer format: always reference exact file path and function name.
  For fixes: show exact lines to change.
  Vocabulary: use the terms above — not synonyms.

---

## TASK 3 — Project: Map (three outputs, one pass)

### What it does now
Walks file tree → .map (full annotated tree)
Extracts file header comments → .slim (one-line file index)

### What it needs to add
While walking, extract function signatures + preceding comments → .funcs

### .funcs parser logic

For each file with extension .js, .html, .css, .py:
  Read full file content
  Scan line by line
  For each line matching a function definition pattern:

    Patterns to match:
      function name(          — standard function
      async function name(    — async function
      export function name(   — exported function
      export async function name(
      const name = function(  — function expression
      const name = async (    — arrow function expression
      const name = (          — arrow function (no async)

  Look back up to 5 lines for a preceding comment:
    // single line comment
    // ── section header ─── (treat as section marker, not description)
    /** multi-line JSDoc */
    If found: extract the text (strip //, /**, */, leading spaces)
    If not found: mark as [undocumented]

  Record: { file, functionName, params, description, lineNumber }

After walking all files, write _context/.funcs

### .funcs output format

  # [ProjectName] — Function Index
  Generated: [date]
  Files: N  |  Functions: N  |  Undocumented: N

  ## filename.js
  functionName(params) [line N]
    — Description from comment.
  anotherFunction(a, b) [line N]
    — [undocumented]
  _privateHelper() [line N]
    — Does X when Y condition is met.

  ## another-file.js
  ...

### .slim output format (existing, confirm unchanged)

  # [ProjectName] — File index
  Stack: [from tech stack header if present]
  [other header lines]

  ---
  path/to/file.js  —  one-line description from file header
  path/to/other.js  —  one-line description
  ...

  (Files with no header comment: marked as [no description])

### .map output format (existing, confirm unchanged)

  # Project Map: [name]
  Generated: [date]  (N.Ns)
  Files: N

  [dir]  dirname/
    [file] filename.js (N KB)  -- hint from first comment line
    [file] filename.html (N KB)  -- hint
    [dir]  subdir/
      [file] ...

---

## TASK 4 — Undocumented function review

### Trigger
Called from Project: Open when .funcs contains [undocumented] entries.
Also callable directly: Project: Map will flag them and offer to review.

### Flow for each undocumented function

  1. Coder reads lines N to N+20 of the function body
  2. Sends to Gemini Lite:
       "This is a JavaScript function from [project].
        Write ONE sentence (max 15 words) describing what it does.
        Use these vocabulary terms where applicable: [vocabulary from .brief]
        Function: [name]
        Code: [first 20 lines]"
  3. Displays in chat:

       ⚠ _buildCompassMesh() — no description  [north-point-3d.js, line 52]

       Suggested:
         "Creates flat PlaneGeometry with CanvasTexture; sets up gizmo scene."

       [A] Accept  [E] Edit  [S] Skip

  4. On Accept:
       Inserts comment line immediately above function definition in source file
       (requires coderRootHandle or rootHandle with write access)
       Format: // [description]
       Updates .funcs entry from [undocumented] to accepted description
       Outputs: "✓ Comment added to [filename] line [N]"

  5. On Edit:
       Shows text input pre-filled with suggestion
       Boon types new description, presses Enter
       Coder writes that text as the comment
       Outputs: "✓ Comment added to [filename] line [N]"

  6. On Skip:
       Leaves [undocumented] in .funcs
       Function still usable but Brief AI will note it is unverified
       Outputs: "Skipped. Function will show as [undocumented] in .funcs"

  7. After all undocumented functions reviewed:
       Outputs summary:
         "Review complete. Accepted: N  Edited: N  Skipped: N
          .funcs updated. Re-indexing changed files..."
       Triggers incremental Project: Index for files that were edited

### Batch option
  If > 5 undocumented functions:
    "Found 12 undocumented functions. Review all now (slower) or
     accept all suggestions (faster, you can edit in .funcs later)?"
    [Review all]  [Accept all suggestions]  [Skip all for now]

---

## TASK 5 — Project: Index (code chunk indexing)

### What it does now
Walks source files → splits into function-level chunks →
generates embeddings → stores in Supabase code_chunks.
Already works correctly.

### Changes needed
None to existing behaviour.

### One addition: exact-match lookup endpoint
Add sub-action to api/index.js:

  sub: 'chunk-get'
  params: { project, functionNames: ['name1', 'name2'] }
  action: SELECT content FROM code_chunks
          WHERE project = $project
          AND function_name = ANY($functionNames)
  returns: { chunks: [{ function_name, file_path, content }] }

This is used by Brief: Locate (Task 7) to retrieve specific function
bodies by name rather than by semantic similarity.

---

## TASK 6 — Brief: Maintain (addition to existing)

### What it does now
Reads session chat log → Gemini Lite extracts summary, decisions,
issues, files touched → updates .context with new session entry.

### One addition: stale focus flag
After writing .context, check .brief "Current focus" date:
  Extract date from: "(YYYY-MM-DD) ..." line
  If today - date > 7 → append to .context session entry:
    "⚠ Current focus in .brief has not changed for N days.
     Update at next Project: Open."

This surfaces at next session start without requiring Boon to remember.

---

## TASK 7 — Brief: Locate (staged pre-step before All Mode)

### What it does
Runs automatically when All Mode is triggered AND a project is open
AND query category is Debug or Fix (from classifyTaskType).
Replaces direct RAG injection with a staged 3-step pipeline.

### Stage 1 — File identification

  Input:  query + .brief + .slim  (all already in _projectContext)
  Prompt to Gemini Lite:
    "Given this query about [project], which source files are most
     likely to contain the relevant code?
     Query: [query]
     Project brief: [.brief]
     File index: [.slim]
     Reply with JSON only: { files: ['file1.js', 'file2.js'],
                             reasoning: 'one sentence' }"
  Output: list of 1-3 file names

  Check: are all named files present in .slim?
    If a named file is not in .slim → discard it (hallucination guard)

### Stage 2 — Function identification

  Input:  query + .funcs FOR CANDIDATE FILES ONLY
    (filter .funcs to show only sections matching files from Stage 1)
    (~300-500 tokens, not the full .funcs)
  Prompt to Gemini Lite:
    "Given this query and these function descriptions, which functions
     are most likely involved?
     Query: [query]
     Functions: [filtered .funcs]
     Reply with JSON only: { functions: ['name1', 'name2'],
                             reasoning: 'one sentence' }"
  Output: list of 2-5 function names

  Check: are all named functions present in the filtered .funcs?
    If a named function is not in .funcs → discard it (hallucination guard)

### Stage 3 — Code retrieval

  Input:  function names from Stage 2
  Action: chunk-get exact-match lookup in Supabase code_chunks
  Output: function bodies returned

  Fallback (if chunk-get returns nothing for a function name):
    Run semantic search using the function name as query
    (handles cases where indexing used a slightly different name)

### Stage 4 — Brief assembly

  Assemble the brief for All Mode:
    [Project]         ← .brief (always)
    [Files]           ← .slim (always)
    [Session Context] ← .context (always)
    [Relevant code]   ← retrieved function bodies from Stage 3
    [Locate reasoning] ← one-line summary: "Files: X, Y. Functions: A, B, C."

  Total target: < 2000 tokens

### Stage 5 — All Mode fires with assembled brief

  Exactly as now — 9 models, Brief AI evaluates responses.

### Gap detection (after All Mode)

  Brief AI checks each winning response before declaring a winner:
    "Does this response trace an unbroken causal chain from the
     described symptom to a specific root cause?
     At each step: is the supporting code present in [Relevant code]?
     If any step is unsupported, name the function that would fill the gap."

  If gaps identified:
    Brief AI writes to mcp.json session_task:
      { query: "Retrieve and explain [missing function] in [file]",
        project: "[project]",
        all_mode: true }
    Outputs: "Gap found: need [function name]. Written to mcp.json.
              Deploy + refresh to continue."

  If no gaps:
    Normal evaluation and winner declaration.

---

## Implementation notes

### Files to change
  project.js  — Tasks 1, 2, 3, 4 (gatekeeper, brief interview, map/funcs, review)
  brief.js    — Tasks 6, 7 (maintain addition, locate pipeline)
  api/index.js — Task 5 (chunk-get sub-action)

### Build order
  Task 3 first (.funcs parser) — self-contained, no dependencies
  Task 4 second (undocumented review) — depends on .funcs
  Task 2 third (brief interview) — self-contained
  Task 1 fourth (gatekeeper) — depends on Tasks 2, 3
  Task 5 fifth (chunk-get endpoint) — self-contained
  Task 6 sixth (maintain addition) — small addition to existing
  Task 7 last (locate pipeline) — depends on all previous

### Rollout strategy
Each task is independently deployable and testable.
Build and deploy Task 3 first, test on GPRTool.
Verify .funcs output before proceeding to Task 4.
Each subsequent task builds on confirmed working foundations.

---

_End of protocol. Review each task in order tomorrow._
