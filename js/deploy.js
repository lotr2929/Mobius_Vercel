// ── js/deploy.js ──────────────────────────────────────────────────────────────
// Deploy: family -- backup, commit, push, run.
// Commit and Push use api/agent.js (GitHub API).
// Backup and Run show instructions (cannot run .bat from browser).
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function instrCard(title, lines) {
    return '<div style="font-size:13px;">'
      + '<div style="font-weight:bold;margin-bottom:8px;">' + title + '</div>'
      + lines.map(l => '<div style="margin:3px 0;">' + l + '</div>').join('')
      + '</div>';
  }

  // ── Deploy: Backup ────────────────────────────────────────────────────────

  async function handleDeployBackup(args, output, outputEl) {
    outputEl.classList.add('html-content');
    outputEl.innerHTML = instrCard('Deploy: Backup',
      [
        'Run <code>backup.bat</code> in the project root before promoting any fix.',
        '<div style="margin-top:6px;">Once complete, type <strong>Deploy: Backup Done</strong> '
        + 'to mark this session as backed up.</div>'
      ]
    );
    document.getElementById('input').value = '';

    if ((args || '').trim().toLowerCase() === 'done') {
      window.deployState = window.deployState || {};
      window.deployState.backedUp = true;
      output('Backup confirmed for this session.');
    }
  }

  // ── Deploy: Commit ────────────────────────────────────────────────────────
  // Commits the last sandboxed/promoted file to the GitHub dev branch via agent.js.

  async function handleDeployCommit(args, output, outputEl) {
    const message = args.trim() || null;

    // Get the last promoted file from debug pipeline
    const debugState = window.getDebugState ? window.getDebugState() : null;
    const lastFile   = debugState && debugState.sandbox
      ? debugState.sandbox
      : null;

    if (!lastFile) {
      outputEl.classList.add('html-content');
      outputEl.innerHTML = instrCard('Deploy: Commit',
        [
          'No sandboxed file found. Commit is for files produced by the debug pipeline.',
          '<div style="margin-top:6px;">For manual commits, run in PowerShell or Git Bash:</div>',
          '<code>git add .</code>',
          '<code>git commit -m "' + esc(message || 'your message') + '"</code>',
          '<code>git push</code>'
        ]
      );
      document.getElementById('input').value = '';
      return;
    }

    if (!message) {
      output('Usage: Deploy: Commit [commit message]');
      return;
    }

    output('Committing ' + lastFile.file + ' to dev branch...');
    try {
      // Encode content as base64 for GitHub API
      const encoded = btoa(unescape(encodeURIComponent(lastFile.content)));
      const res     = await fetch('/agent?action=commit', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          path:    lastFile.file,
          content: encoded,
          message: message
        })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      window.deployState = window.deployState || {};
      window.deployState.lastCommit = { file: lastFile.file, message, sha: data.sha };

      outputEl.classList.add('html-content');
      outputEl.innerHTML = instrCard('&#x2705; Committed to dev branch',
        [
          '<strong>File:</strong> ' + esc(lastFile.file),
          '<strong>Message:</strong> ' + esc(message),
          (data.commitUrl ? '<a href="' + esc(data.commitUrl) + '" target="_blank" style="color:var(--green);">View commit on GitHub</a>' : ''),
          '<div style="margin-top:8px;">Type <strong>Deploy: Push</strong> to merge dev to main and trigger Vercel.</div>'
        ].filter(Boolean)
      );
      document.getElementById('input').value = '';
    } catch (err) {
      output('Commit failed: ' + err.message);
    }
  }

  // ── Deploy: Push ──────────────────────────────────────────────────────────
  // Merges dev branch into main via agent.js -- Vercel auto-builds on push.

  async function handleDeployPush(args, output, outputEl) {
    const message = (args || '').trim() || 'Deploy: merge dev into main';
    output('Merging dev into main...');
    try {
      const res  = await fetch('/agent?action=merge', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ message })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      if (data.alreadyUpToDate) {
        output('dev and main are already in sync. Nothing to push.');
        return;
      }

      window.deployState = window.deployState || {};
      window.deployState.lastPush = { sha: data.sha, message };

      outputEl.classList.add('html-content');
      outputEl.innerHTML = instrCard('&#x2705; Pushed -- Vercel building',
        [
          '<strong>Merged:</strong> dev -- main',
          '<strong>SHA:</strong> ' + esc((data.sha || '').slice(0, 8)),
          'Vercel will detect the push and build automatically.',
          '<div style="margin-top:6px;color:var(--text-dim);">Check build status at vercel.com/dashboard or run <strong>Status: Vercel</strong> (coming soon).</div>'
        ]
      );
      document.getElementById('input').value = '';
    } catch (err) {
      output('Push failed: ' + err.message);
    }
  }

  // ── Deploy: Run ───────────────────────────────────────────────────────────

  async function handleDeployRun(args, output, outputEl) {
    outputEl.classList.add('html-content');
    outputEl.innerHTML = instrCard('Deploy: Run',
      [
        'Run <code>deploy.bat</code> from the project root in a terminal.',
        '<div style="margin-top:6px;">This runs <code>vercel --prod</code> and deploys directly to production.</div>',
        '<div style="margin-top:6px;color:var(--text-dim);">Alternatively, use <strong>Deploy: Commit</strong> + <strong>Deploy: Push</strong> to deploy via GitHub (triggers Vercel automatically).</div>'
      ]
    );
    document.getElementById('input').value = '';
  }

  // ── Self-register ──────────────────────────────────────────────────────────

  function register() {
    if (!window.COMMANDS) { setTimeout(register, 50); return; }
    window.COMMANDS['deploy: backup'] = { handler: handleDeployBackup, family: 'deploy', desc: 'Run backup.bat before promoting (instruction + confirmation)' };
    window.COMMANDS['deploy: commit'] = { handler: handleDeployCommit, family: 'deploy', desc: 'Commit sandboxed file to GitHub dev branch'                   };
    window.COMMANDS['deploy: push']   = { handler: handleDeployPush,   family: 'deploy', desc: 'Merge dev into main -- triggers Vercel build'                 };
    window.COMMANDS['deploy: run']    = { handler: handleDeployRun,    family: 'deploy', desc: 'Show instructions to run deploy.bat locally'                  };
  }
  register();

})();
