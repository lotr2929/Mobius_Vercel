// ── js/ask.js ─────────────────────────────────────────────────────────────────
// Ask: family -- AI model overrides, web search, retry, status check.
// All handlers delegate to window.sendToAI or window.sendToLocal.
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  // ── Cloud models ──────────────────────────────────────────────────────────

  async function handleAskGemini(args, output, outputEl) {
    if (!args.trim()) { output('Usage: Ask: Gemini [your question]'); return; }
    await window.sendToAI('gemini', [{ role: 'user', content: args.trim() }], output, outputEl);
  }

  async function handleAskLite(args, output, outputEl) {
    if (!args.trim()) { output('Usage: Ask: Lite [your question]'); return; }
    await window.sendToAI('gemini-lite', [{ role: 'user', content: args.trim() }], output, outputEl);
  }

  async function handleAskGroq(args, output, outputEl) {
    if (!args.trim()) { output('Usage: Ask: Groq [your question]'); return; }
    await window.sendToAI('groq', [{ role: 'user', content: args.trim() }], output, outputEl);
  }

  async function handleAskCodestral(args, output, outputEl) {
    if (!args.trim()) { output('Usage: Ask: Codestral [your question]'); return; }
    await window.sendToAI('mistral', [{ role: 'user', content: args.trim() }], output, outputEl);
  }

  async function handleAskGPT(args, output, outputEl) {
    if (!args.trim()) { output('Usage: Ask: GPT [your question]'); return; }
    await window.sendToAI('github', [{ role: 'user', content: args.trim() }], output, outputEl);
  }

  // ── Local models (Ollama) ─────────────────────────────────────────────────

  async function handleAskQwen35(args, output, outputEl) {
    if (!args.trim()) { output('Usage: Ask: Qwen35 [your question]'); return; }
    await window.sendToLocal('qwen35', [{ role: 'user', content: args.trim() }], output, outputEl);
  }

  async function handleAskQwen(args, output, outputEl) {
    if (!args.trim()) { output('Usage: Ask: Qwen [your question]'); return; }
    await window.sendToLocal('qwen', [{ role: 'user', content: args.trim() }], output, outputEl);
  }

  async function handleAskDeepSeek(args, output, outputEl) {
    if (!args.trim()) { output('Usage: Ask: DeepSeek [your question]'); return; }
    await window.sendToLocal('deepseek', [{ role: 'user', content: args.trim() }], output, outputEl);
  }

  // ── Ask: Web -- Tavily search ─────────────────────────────────────────────

  async function handleAskWeb(args, output, outputEl) {
    if (!args.trim()) { output('Usage: Ask: Web [search query]'); return; }
    await window.sendToAI('web', [{ role: 'user', content: args.trim() }], output, outputEl);
  }

  // ── Ask: Next -- retry on next cloud model ────────────────────────────────

  async function handleAskNext(args, output, outputEl) {
    const lastQuery    = window.getLastCloudQuery    ? window.getLastCloudQuery()    : null;
    const lastModelKey = window.getLastCloudModelKey ? window.getLastCloudModelKey() : null;

    if (!lastQuery || !lastModelKey) {
      output('No previous cloud query to retry. Ask something first.');
      return;
    }
    const next = window.nextCloudModel ? window.nextCloudModel(lastModelKey) : null;
    if (!next) {
      output('Already at the last cloud model (' + lastModelKey + '). No further fallbacks.');
      return;
    }
    const names = { 'gemini-lite': 'Gemini Flash-Lite', groq: 'Groq', mistral: 'Codestral', github: 'GitHub GPT-4o' };
    output('Retrying with ' + (names[next] || next) + '...');
    await window.sendToAI(next, lastQuery.messages, output, outputEl);
  }

  // ── Ask: Status -- model health check ─────────────────────────────────────

  async function handleAskStatus(args, output, outputEl) {
    outputEl.classList.add('html-content');
    outputEl.innerHTML = '';

    function section(label) {
      const d = document.createElement('div');
      d.style.cssText = 'font-size:11px;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.08em;margin:10px 0 4px;';
      d.textContent = label;
      outputEl.appendChild(d);
    }

    function placeholder(label) {
      const d = document.createElement('div');
      d.style.cssText = 'display:flex;align-items:baseline;gap:8px;padding:3px 0;font-size:13px;border-bottom:1px solid var(--border);color:var(--text-dim);';
      d.innerHTML = '<span style="width:18px;">&#x23F3;</span><span style="flex:1;">' + label + '</span><span>checking...</span>';
      outputEl.appendChild(d);
      return d;
    }

    function fill(p, label, ok, detail) {
      const col = ok ? '#4a7c4e' : '#8d3a3a';
      p.style.cssText = 'display:flex;align-items:baseline;gap:8px;padding:3px 0;font-size:13px;border-bottom:1px solid var(--border);';
      p.innerHTML = '<span style="width:18px;">' + (ok ? '&#x2705;' : '&#x274C;') + '</span>'
        + '<span style="flex:1;color:var(--text);">' + label + '</span>'
        + '<span style="color:' + col + ';font-weight:bold;">' + detail + '</span>';
    }

    const hdr = document.createElement('div');
    hdr.style.cssText = 'font-weight:bold;font-size:14px;margin-bottom:6px;';
    hdr.textContent = 'AI Models -- ' + new Date().toLocaleTimeString('en-AU', { hour12: true });
    outputEl.appendChild(hdr);

    section('Cloud');
    const pGroq    = placeholder('Groq Llama 3.3 70B');
    const pGemini  = placeholder('Gemini 2.5 Flash');
    const pMistral = placeholder('Mistral Codestral');

    section('Local (Ollama)');
    const pOllama  = placeholder('Ollama');

    // Cloud check
    try {
      const res  = await fetch('/api/services/status', { signal: AbortSignal.timeout(15000) });
      const data = await res.json();
      const map  = { groq: pGroq, gemini: pGemini, mistral: pMistral };
      for (const m of (data.models || [])) {
        const p = map[m.key]; if (!p) continue;
        fill(p, m.name, m.ok, m.ok ? 'ok ' + m.ms + 'ms' : 'failed: ' + (m.error || 'error'));
      }
    } catch {
      [pGroq, pGemini, pMistral].forEach(p => fill(p, p.querySelector('span:nth-child(2)')?.textContent || '?', false, 'unreachable'));
    }

    // Ollama check
    try {
      const r = await fetch('http://localhost:11434/api/tags', { signal: AbortSignal.timeout(4000) });
      if (r.ok) {
        const od     = await r.json();
        const pulled = (od.models || []).map(m => m.name);
        const names  = pulled.filter(n => n.includes('qwen') || n.includes('deepseek')).join(', ');
        fill(pOllama, 'Ollama', true, 'running -- ' + (names || pulled[0] || 'no models'));
      } else throw new Error();
    } catch {
      fill(pOllama, 'Ollama', false, 'not running -- run start-ollama.bat');
    }

    document.getElementById('input').value = '';
  }

  // ── Self-register ──────────────────────────────────────────────────────────

  function register() {
    if (!window.COMMANDS) { setTimeout(register, 50); return; }

    // Primary commands
    window.COMMANDS['ask: gemini']    = { handler: handleAskGemini,    family: 'ask', desc: 'Gemini 2.5 Flash (cloud, coding default)'        };
    window.COMMANDS['ask: lite']      = { handler: handleAskLite,      family: 'ask', desc: 'Gemini 2.5 Flash-Lite (cloud, fast default)'     };
    window.COMMANDS['ask: groq']      = { handler: handleAskGroq,      family: 'ask', desc: 'Llama 3.3 70B via Groq (cloud, fast)'            };
    window.COMMANDS['ask: codestral'] = { handler: handleAskCodestral, family: 'ask', desc: 'Codestral via Mistral AI (cloud, code-focused)'  };
    window.COMMANDS['ask: gpt']       = { handler: handleAskGPT,       family: 'ask', desc: 'GPT-4o via GitHub AI (cloud, fallback)'          };
    window.COMMANDS['ask: qwen35']    = { handler: handleAskQwen35,    family: 'ask', desc: 'Qwen3.5 35B via Ollama (local, most powerful)'   };
    window.COMMANDS['ask: qwen']      = { handler: handleAskQwen,      family: 'ask', desc: 'Qwen2.5-Coder 7B via Ollama (local, fast)'      };
    window.COMMANDS['ask: deepseek']  = { handler: handleAskDeepSeek,  family: 'ask', desc: 'DeepSeek R1 7B via Ollama (local, reasoning)'   };
    window.COMMANDS['ask: web']       = { handler: handleAskWeb,       family: 'ask', desc: 'Tavily web search'                               };
    window.COMMANDS['ask: next']      = { handler: handleAskNext,      family: 'ask', desc: 'Retry last query on next cloud model'            };
    window.COMMANDS['ask: status']    = { handler: handleAskStatus,    family: 'ask', desc: 'Check health of all AI models'                  };

    // Backward-compatible aliases
    window.COMMANDS['ask: llama']   = { handler: handleAskGroq,        family: 'ask', desc: 'alias -- Ask: Groq'      };
    window.COMMANDS['ask: mistral'] = { handler: handleAskCodestral,   family: 'ask', desc: 'alias -- Ask: Codestral' };
    window.COMMANDS['web']          = { handler: handleAskWeb,         family: 'ask', desc: 'alias -- Ask: Web'       };
    window.COMMANDS['status: models'] = { handler: handleAskStatus,   family: 'ask', desc: 'alias -- Ask: Status'    };
  }
  register();

})();
