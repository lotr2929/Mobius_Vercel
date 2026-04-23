// ── js/orchestrator.js ────────────────────────────────────────────────────────
// Mobius planner -- Go: [intent] maps plain-English intent to a command
// sequence using the COMMANDS registry metadata, then executes step-by-step
// with a gate between each step.
//
// Go: [intent]  -- build a plan from the registry + context, ask Boon to confirm
// Go: Next      -- run the next pending step in the current plan
// Go: Skip      -- skip the current step and advance
// Go: Stop      -- cancel the current plan
// Go: Plan      -- show the pending plan without running it
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  // ── Plan state ─────────────────────────────────────────────────────────────

  // window.orchestratorPlan = {
  //   intent:      string
  //   steps:       [{ command, args, desc, done }]
  //   currentStep: number  (0-based index)
  //   running:     bool
  // }

  function initPlan(intent, steps) {
    window.orchestratorPlan = {
      intent,
      steps:       steps.map(s => ({ ...s, done: false })),
      currentStep: 0,
      running:     false
    };
  }

  function clearPlan() {
    window.orchestratorPlan = null;
  }

  // ── Build a registry summary for Groq ─────────────────────────────────────

  function buildRegistrySummary() {
    const cmds = window.COMMANDS || {};
    return Object.entries(cmds)
      .filter(([, v]) => v.family && v.family !== 'help' && !v.desc.startsWith('alias'))
      .map(([k, v]) => k + ' -- ' + v.desc
        + (v.needs && v.needs.length ? ' [needs: ' + v.needs.join(', ') + ']' : ''))
      .join('\n');
  }

  // ── Build current state summary ────────────────────────────────────────────

  async function buildStateSummary() {
    const lines = [];
    const debug = window.getDebugState ? window.getDebugState() : null;
    if (debug) {
      const step = debug.step;
      const labels = ['', 'Triage', 'Diagnose', 'Propose', 'Sandbox', 'Promote'];
      lines.push('Debug pipeline: at step ' + step + ' (' + (labels[step] || 'unknown') + ')');
      if (debug.triage)    lines.push('  Triage done: ' + (debug.triage.summary || ''));
      if (debug.diagnosis) lines.push('  Diagnosis done: root cause in ' + (debug.diagnosis.file || '?'));
      if (debug.proposal)  lines.push('  Proposal done: ' + (debug.proposal.summary || ''));
      if (debug.sandbox)   lines.push('  Sandbox done: ' + debug.sandbox.file);
    }

    const rootHandle = window.getRootHandle ? window.getRootHandle() : null;
    if (rootHandle) lines.push('Folder open: ' + rootHandle.name);
    else lines.push('No folder open.');

    // Read log_summary if available
    if (rootHandle) {
      try {
        let ctxDir = null;
        for await (const [name, h] of rootHandle.entries()) {
          if (name === '_context' && h.kind === 'directory') { ctxDir = h; break; }
        }
        if (ctxDir) {
          for await (const [name, h] of ctxDir.entries()) {
            if (name === 'log_summary.md') {
              const text = await (await h.getFile()).text();
              lines.push('Log summary excerpt: ' + text.slice(0, 400).replace(/\n/g, ' '));
              break;
            }
          }
        }
      } catch { /* skip */ }
    }

    return lines.join('\n');
  }

  // ── Plan renderer ──────────────────────────────────────────────────────────

  function renderPlan(plan, outputEl, note) {
    if (!plan || !plan.steps || plan.steps.length === 0) {
      outputEl.classList.add('html-content');
      outputEl.innerHTML = '<div style="font-size:13px;">No active plan.</div>';
      return;
    }

    const stepList = plan.steps.map((s, i) => {
      const col = s.done ? '#4a7c4e'
        : i === plan.currentStep ? '#a06800'
        : '#8d7c64';
      const dot = s.done ? '&#x2713;'
        : i === plan.currentStep ? '&#x25B6;'
        : '&#x25CB;';
      const cmd  = '<code style="font-size:12px;">'
        + (s.command + (s.args ? ' ' + s.args : '')) + '</code>';
      return '<div style="display:flex;gap:8px;align-items:baseline;padding:3px 0;border-bottom:1px solid var(--border);">'
        + '<span style="color:' + col + ';width:16px;flex-shrink:0;">' + dot + '</span>'
        + '<span style="flex:1;font-size:13px;">' + cmd + '</span>'
        + '<span style="font-size:12px;color:var(--text-muted);">' + (s.desc || '') + '</span>'
        + '</div>';
    }).join('');

    const hint = plan.steps[plan.currentStep]
      ? 'Next: <strong>' + plan.steps[plan.currentStep].command + '</strong> &nbsp;|&nbsp; Type <strong>Go: Next</strong> to run it.'
      : 'All steps complete.';

    outputEl.classList.add('html-content');
    outputEl.innerHTML = '<div style="font-weight:bold;font-size:14px;margin-bottom:8px;">Plan: ' + (plan.intent || '') + '</div>'
      + stepList
      + '<div style="margin-top:10px;color:var(--text-dim);font-size:13px;">' + hint + '</div>'
      + (note ? '<div style="margin-top:6px;color:var(--text-dim);font-size:12px;">' + note + '</div>' : '');
    document.getElementById('input').value = '';
  }

  // ── Go: [intent] -- build a plan ─────────────────────────────────────────

  async function handleGo(args, output, outputEl) {
    const sub = (args || '').trim().toLowerCase();

    // Sub-commands
    if (sub === 'next')  return await goNext(output, outputEl);
    if (sub === 'skip')  return goSkip(output, outputEl);
    if (sub === 'stop')  return goStop(output, outputEl);
    if (sub === 'plan')  return goPlan(output, outputEl);

    if (!args.trim()) {
      outputEl.classList.add('html-content');
      outputEl.innerHTML = '<div style="font-size:13px;">'
        + '<div style="font-weight:bold;margin-bottom:6px;">Go: [intent]</div>'
        + '<div>Describe what you want to do in plain English. Mobius will plan the steps.</div>'
        + '<div style="margin-top:8px;"><strong>Examples:</strong>'
        + '<ul style="margin:4px 0 0 18px;padding:0;">'
        + '<li style="margin:2px 0;">Go: fix the login bug</li>'
        + '<li style="margin:2px 0;">Go: review the authentication module</li>'
        + '<li style="margin:2px 0;">Go: plan my next task</li>'
        + '</ul></div>'
        + '<div style="margin-top:8px;color:var(--text-dim);font-size:12px;">'
        + 'Sub-commands: <code>Go: Next</code> &nbsp; <code>Go: Skip</code> &nbsp; <code>Go: Stop</code> &nbsp; <code>Go: Plan</code>'
        + '</div></div>';
      document.getElementById('input').value = '';
      return;
    }

    const intent   = args.trim();
    const registry = buildRegistrySummary();

    output('Planning...');
    const state  = await buildStateSummary();

    const prompt = 'You are Mobius, an AI coding orchestrator. Map the developer\'s intent to a sequence of commands.\n\n'
      + 'Available commands:\n' + registry + '\n\n'
      + 'Current state:\n' + state + '\n\n'
      + 'Developer intent: ' + intent + '\n\n'
      + 'Respond ONLY with valid JSON, no markdown fences:\n'
      + '{"steps":[{"command":"code: fix","args":"","desc":"Fix the identified bug"},{"command":"debug: sandbox","args":"","desc":"Write fix to sandbox"}]}';

    try {
      const res  = await fetch('/ask', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          query:  prompt,
          model:  'groq',
          userId: window.getAuth ? window.getAuth('mobius_user_id') : null
        })
      });
      const data   = await res.json();
      const parsed = parseJSON(data.reply || data.answer || '');

      if (!parsed || !Array.isArray(parsed.steps) || parsed.steps.length === 0) {
        outputEl.classList.add('html-content');
        outputEl.innerHTML = '<div style="font-size:13px;color:var(--red);">Could not parse a plan from the AI response.</div>'
          + '<div style="font-size:12px;margin-top:6px;color:var(--text-dim);">'
          + 'Try rephrasing your intent, or run commands directly (type ? for help).</div>';
        return;
      }

      initPlan(intent, parsed.steps);
      renderPlan(window.orchestratorPlan, outputEl,
        'Mobius has built this plan. Review it, then type Go: Next to run the first step.');
    } catch (err) {
      output('Planning failed: ' + err.message);
    }
  }

  // ── Go: Next -- run next pending step ────────────────────────────────────

  async function goNext(output, outputEl) {
    const plan = window.orchestratorPlan;
    if (!plan || plan.steps.length === 0) {
      output('No active plan. Type Go: [intent] to build one first.');
      return;
    }
    if (plan.currentStep >= plan.steps.length) {
      output('All steps complete. Type Go: [new intent] to start a new plan.');
      return;
    }

    const step = plan.steps[plan.currentStep];
    const cmd  = window.COMMANDS && window.COMMANDS[step.command.toLowerCase()];

    if (!cmd) {
      output('Command not found: ' + step.command + '\nSkipping to next step.');
      plan.steps[plan.currentStep].done = true;
      plan.currentStep++;
      renderPlan(plan, outputEl);
      return;
    }

    output('Running: ' + step.command + (step.args ? ' ' + step.args : '') + '...');
    try {
      await cmd.handler(step.args || '', output, outputEl);
      plan.steps[plan.currentStep].done = true;
      plan.currentStep++;

      if (plan.currentStep < plan.steps.length) {
        // Show updated plan with next gate
        setTimeout(() => {
          const nextStep = plan.steps[plan.currentStep];
          const gateHtml = '<div style="font-size:13px;margin-top:10px;">'
            + '<div style="font-weight:bold;">Step complete. Next: <code>' + nextStep.command + '</code></div>'
            + '<div style="color:var(--text-dim);margin-top:4px;">' + (nextStep.desc || '') + '</div>'
            + '<div style="margin-top:6px;">Type <strong>Go: Next</strong> to continue, '
            + '<strong>Go: Skip</strong> to skip, or <strong>Go: Stop</strong> to cancel.</div>'
            + '</div>';
          const existing = document.querySelector('.chat-answer.html-content:last-child');
          if (existing) existing.innerHTML += gateHtml;
        }, 100);
      } else {
        output('Plan complete.');
        clearPlan();
      }
    } catch (err) {
      output('Step failed: ' + err.message + '\nType Go: Next to retry, Go: Skip to skip, or Go: Stop to cancel.');
    }
  }

  // ── Go: Skip / Stop / Plan ────────────────────────────────────────────────

  function goSkip(output, outputEl) {
    const plan = window.orchestratorPlan;
    if (!plan) { output('No active plan.'); return; }
    if (plan.currentStep >= plan.steps.length) { output('All steps are already done.'); return; }
    plan.steps[plan.currentStep].done = true;
    plan.currentStep++;
    renderPlan(plan, outputEl, 'Step skipped.');
  }

  function goStop(output, outputEl) {
    if (!window.orchestratorPlan) { output('No active plan to stop.'); return; }
    const intent = window.orchestratorPlan.intent;
    clearPlan();
    output('Plan cancelled: "' + intent + '"');
    document.getElementById('input').value = '';
  }

  function goPlan(output, outputEl) {
    const plan = window.orchestratorPlan;
    if (!plan) {
      output('No active plan. Type Go: [intent] to build one.');
      return;
    }
    renderPlan(plan, outputEl);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  function parseJSON(text) {
    try {
      const clean = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      return JSON.parse(clean);
    } catch { return null; }
  }

  // ── Self-register ──────────────────────────────────────────────────────────

  function register() {
    if (!window.COMMANDS) { setTimeout(register, 50); return; }
    window.COMMANDS['go'] = {
      handler:  handleGo,
      family:   'go',
      desc:     'Mobius planner -- map intent to command sequence, execute with gates',
      needs:    [],
      produces: ['plan'],
      gate:     true
    };
  }
  register();

  window.clearOrchestrator   = clearPlan;
  window.getOrchestratorPlan = function () { return window.orchestratorPlan || null; };

})();
