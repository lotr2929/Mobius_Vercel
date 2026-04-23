// ── js/catalogue.js ───────────────────────────────────────────────────────────
// Node utility script -- run from project root: node js/catalogue.js
// Scans all JS module files in js/, extracts self-registered COMMANDS entries,
// calls Groq/DeepSeek for any entries missing desc/model/context,
// writes _context/.catalogue.
// NOT a browser script -- never loaded by index.html.
// ─────────────────────────────────────────────────────────────────────────────

'use strict';
const fs   = require('fs');
const path = require('path');

const ROOT    = path.resolve(__dirname, '..');
const ENV_FILE = path.join(ROOT, '.env.local');
const OUTPUT  = path.join(ROOT, '_context', '.catalogue');

// ── 1. Parse .env.local ───────────────────────────────────────────────────────

function parseEnv(filePath) {
  const env = {};
  if (!fs.existsSync(filePath)) return env;
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

// ── 2. Collect all JS module files ────────────────────────────────────────────

function getModuleFiles() {
  const jsDir = path.join(ROOT, 'js');
  return fs.readdirSync(jsDir)
    .filter(f => f.endsWith('.js') && f !== 'catalogue.js' && f !== 'self_test.js')
    .map(f => ({ name: f, fullPath: path.join(jsDir, f) }));
}

// ── 3. Parse command entries from self-registering pattern ────────────────────
// Matches: window.COMMANDS['key'] = { handler: fn, desc: '...', ... }

function parseCommandEntries(source, fileName) {
  const commands = [];
  // Match window.COMMANDS['key'] = { ... } -- handles multi-line bodies
  const blockRe = /window\.COMMANDS\['([^']+)'\]\s*=\s*\{([^}]+)\}/gm;
  let m;
  while ((m = blockRe.exec(source)) !== null) {
    const key  = m[1];
    const body = m[2];

    const handler = (body.match(/handler\s*:\s*(\w+)/) || [])[1] || null;
    const desc    = (body.match(/desc\s*:\s*'([^']*)'/) || body.match(/desc\s*:\s*"([^"]*)"/) || [])[1] || null;
    const model   = (body.match(/model\s*:\s*'([^']*)'/) || body.match(/model\s*:\s*"([^"]*)"/) || [])[1] || null;
    const context = (body.match(/context\s*:\s*'([^']*)'/) || body.match(/context\s*:\s*"([^"]*)"/) || [])[1] || null;

    // Skip aliases -- they just point to other handlers
    if (desc && (desc.startsWith('alias') || desc.startsWith('alias'))) continue;

    if (handler) commands.push({ key, handler, desc, model, context, sourceFile: fileName });
  }
  return commands;
}

// ── 4. Extract handler function source (first 30 lines) ──────────────────────

function extractHandlerCode(source, handlerName) {
  const fnRe = new RegExp('(?:async\\s+)?function\\s+' + handlerName + '\\s*\\(');
  const match = fnRe.exec(source);
  if (!match) return null;
  let depth = 0;
  let started = false;
  let i = match.index;
  while (i < source.length) {
    if (source[i] === '{') { depth++; started = true; }
    else if (source[i] === '}') {
      depth--;
      if (started && depth === 0) {
        return source.slice(match.index, i + 1).split('\n').slice(0, 30).join('\n');
      }
    }
    i++;
  }
  return null;
}

// ── 5. Groq API call ─────────────────────────────────────────────────────────

async function askGroq(key, handlerCode, apiKey) {
  const prompt =
    'You are analysing a JavaScript command handler from a PWA called mobius -- an AI coding assistant.\n\n' +
    'Command key: "' + key + '"\n' +
    'Handler code:\n```js\n' + handlerCode + '\n```\n\n' +
    'Respond with valid JSON only (no markdown, no explanation):\n' +
    '{\n' +
    '  "desc": "one sentence describing what this command does, from the user\'s perspective",\n' +
    '  "model": "primary AI model used -- one of: gemini, gemini-lite, groq, mistral, ollama, none",\n' +
    '  "context": "what context is injected -- e.g. CLAUDE.md + history only"\n' +
    '}';

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 200
    }),
    signal: AbortSignal.timeout(15000)
  });

  if (!res.ok) throw new Error('Groq HTTP ' + res.status);
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || '';
  const clean = content.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

// ── 6. DeepSeek local fallback ────────────────────────────────────────────────

async function askDeepSeek(key, handlerCode) {
  const prompt =
    'Analyse this JavaScript command handler from a PWA coding assistant called mobius.\n\n' +
    'Command key: "' + key + '"\n' +
    'Handler code:\n```js\n' + handlerCode + '\n```\n\n' +
    'Respond with valid JSON only:\n' +
    '{"desc":"one sentence user-facing description","model":"gemini|gemini-lite|groq|mistral|ollama|none","context":"what context files are used"}';

  const endpoints = [
    'http://localhost:3000/ollama/v1/chat/completions',
    'http://localhost:11434/v1/chat/completions'
  ];

  for (const url of endpoints) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'deepseek-r1:7b',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.1
        }),
        signal: AbortSignal.timeout(60000)
      });
      if (!res.ok) continue;
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content || '';
      const clean = content.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/```json|```/g, '').trim();
      return JSON.parse(clean);
    } catch { continue; }
  }
  throw new Error('DeepSeek unavailable');
}

// ── 7. Get metadata for one command ──────────────────────────────────────────

async function getMetadata(key, handlerCode, groqKey) {
  if (groqKey) {
    try {
      const meta = await askGroq(key, handlerCode, groqKey);
      if (meta.desc) return { ...meta, source: 'groq' };
    } catch (e) {
      console.warn('  Groq failed for "' + key + '": ' + e.message + ' -- trying DeepSeek...');
    }
  }
  try {
    const meta = await askDeepSeek(key, handlerCode);
    if (meta.desc) return { ...meta, source: 'deepseek' };
  } catch (e) {
    console.warn('  DeepSeek failed for "' + key + '": ' + e.message);
  }
  return { desc: '[no summary -- add desc to COMMANDS entry or re-run]', model: 'unknown', context: 'unknown', source: 'none' };
}

// ── 8. Write _context/.catalogue ─────────────────────────────────────────────

function writeCatalogue(commands, stats) {
  const now = new Date().toLocaleString('en-AU', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true
  });

  const lines = [
    '# mobius -- Command Catalogue',
    'Generated: ' + now,
    'Commands: ' + commands.length +
      ' | Inline: ' + stats.inline +
      ' | AI-generated: ' + stats.aiGenerated +
      ' | Missing: ' + stats.missing,
    '',
    '## Commands',
    ''
  ];

  for (const cmd of commands) {
    lines.push(cmd.key);
    lines.push('  file:    ' + (cmd.sourceFile || '[unknown]'));
    lines.push('  desc:    ' + (cmd.desc    || '[missing]'));
    lines.push('  model:   ' + (cmd.model   || '[missing]'));
    lines.push('  context: ' + (cmd.context || '[missing]'));
    lines.push('  handler: ' + cmd.handler);
    if (cmd.source && cmd.source !== 'inline') {
      lines.push('  meta:    ' + cmd.source);
    }
    lines.push('');
  }

  fs.writeFileSync(OUTPUT, lines.join('\n'), 'utf8');
}

// ── 9. Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('\nmobius -- catalogue.js');
  console.log('=============================');

  const env     = parseEnv(ENV_FILE);
  const groqKey = env.GROQ_API_KEY || null;
  console.log(groqKey ? 'Groq API key found.' : 'No Groq key -- will try DeepSeek for missing metadata.');

  const moduleFiles = getModuleFiles();
  console.log('Scanning ' + moduleFiles.length + ' module files in js/...\n');

  const allCommands = [];
  const allSources  = {};

  for (const { name, fullPath } of moduleFiles) {
    if (!fs.existsSync(fullPath)) continue;
    const source   = fs.readFileSync(fullPath, 'utf8');
    allSources[name] = source;
    const found    = parseCommandEntries(source, name);
    if (found.length > 0) {
      console.log('  ' + name + ': ' + found.length + ' command(s)');
      allCommands.push(...found);
    }
  }

  console.log('\nTotal commands found: ' + allCommands.length + '\n');

  const stats = { inline: 0, aiGenerated: 0, missing: 0 };

  for (const cmd of allCommands) {
    const hasInline = cmd.desc && cmd.model && cmd.context;
    if (hasInline) {
      cmd.source = 'inline';
      stats.inline++;
      console.log('  [inline]  ' + cmd.key);
      continue;
    }

    // Find handler code in the source file it came from
    const source      = allSources[cmd.sourceFile] || '';
    const handlerCode = extractHandlerCode(source, cmd.handler);

    if (!handlerCode) {
      console.warn('  [skip]    ' + cmd.key + ' -- handler "' + cmd.handler + '" not found in ' + cmd.sourceFile);
      cmd.desc    = cmd.desc    || '[handler not found in source]';
      cmd.model   = cmd.model   || 'unknown';
      cmd.context = cmd.context || 'unknown';
      cmd.source  = 'none';
      stats.missing++;
      continue;
    }

    process.stdout.write('  [ai]      ' + cmd.key + ' ... ');
    const meta = await getMetadata(cmd.key, handlerCode, groqKey);
    cmd.desc    = cmd.desc    || meta.desc;
    cmd.model   = cmd.model   || meta.model;
    cmd.context = cmd.context || meta.context;
    cmd.source  = meta.source;

    if (meta.source !== 'none') {
      stats.aiGenerated++;
      console.log('ok (' + meta.source + ')');
    } else {
      stats.missing++;
      console.log('failed');
    }
  }

  const contextDir = path.join(ROOT, '_context');
  if (!fs.existsSync(contextDir)) fs.mkdirSync(contextDir);
  writeCatalogue(allCommands, stats);

  console.log('\nWrote _context/.catalogue');
  console.log('Inline: ' + stats.inline + ' | AI-generated: ' + stats.aiGenerated + ' | Missing: ' + stats.missing);
  console.log('\nDone.\n');
}

main().catch(err => {
  console.error('\nFATAL: ' + err.message);
  process.exit(1);
});
