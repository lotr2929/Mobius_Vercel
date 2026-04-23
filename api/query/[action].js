// ── api/query/[action].js ─────────────────────────────────────────────────────
// POST /ask   → action=ask
// POST /parse → action=parse

const {
  askGeminiLite, askGemini, askMistral, askGitHub,
  askOllama, askCerebras, askDeepSeekCloud, askOpenRouter,
  askGroqCascade, askGeminiCascade, askMistralCascade,
  askCerebrasCascade, askOpenRouterCascade,
  askWithFallback, askWebSearch, detectsCutoff, MODEL_FULL_NAMES
} = require('../_ai.js');
const {
  saveConversation, logModelEvent,
  startSession, closeSession, heartbeatSession
} = require('../_supabase.js');
const {
  writeGeneral, searchMemory, viewMemory,
  writeWorking, deleteMemory, distilMemory, countMemory, updateMemory, embedList, embedOne
} = require('../_memory.js');

const CODER_PERSONA = `You are Mobius — an expert coding assistant. You specialise in web development, JavaScript, Node.js, Python, and modern frameworks. You write clean, well-commented, production-ready code. You explain your reasoning. You debug systematically. You never truncate code. British English.`;

const SYSTEM_PROMPTS = {
  Brief:   CODER_PERSONA + '\n\nBe concise. Answer the question directly.',
  Long:    CODER_PERSONA + '\n\nBe thorough. Explain fully. No length limits.',
  Code:    CODER_PERSONA + '\n\nProvide complete, working code. Never truncate. Use markdown code blocks. Explain what the code does and why.',
  Debug:   CODER_PERSONA + '\n\nYou are debugging a specific bug. Identify root cause first. State the exact file and line. Propose the minimal change only. Explain why it fixes the problem. Do not rewrite unrelated code.',
  Explain: CODER_PERSONA + '\n\nExplain clearly in plain English. Walk through each part step by step. Assume the reader understands code but not this specific implementation. No jargon without definition.',
  Review:  CODER_PERSONA + '\n\nGroup findings by severity: Critical / High / Medium / Low. For each finding state the exact problem, why it matters, and the minimal fix. Be specific. No generalities.',
  Plan:    CODER_PERSONA + '\n\nThink step by step before answering. State assumptions explicitly. Identify risks. Give a numbered action plan. Prefer the simplest solution that works. Flag anything that needs browser testing.'
};

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action } = req.query;

  if (action === 'parse') {
    try {
      const { text, model, history, forceInstructionMode } = req.body || {};
      if (!text) return res.status(400).json({ error: 'text is required' });
      const cookieHeader = req.headers.cookie || '';
      const userId = cookieHeader.split(';').map(c => c.trim())
        .find(c => c.startsWith('mobius_user_id='))?.split('=')[1] || req.body?.userId || null;
      const elaborate  = /^Elaborate[:\s]/i.test(text);
      const cleanText  = text.replace(/^Elaborate[:\s]+/i, '').trim() || text;
      const instructionMode = forceInstructionMode || (elaborate ? 'Long' : 'Brief');
      const codeIntent = /```|function |const |let |var |import |require |def |class |<script|<html/i.test(cleanText);
      const finalMode  = forceInstructionMode || (codeIntent ? 'Code' : instructionMode);
      return res.status(200).json({ mobius_query: {
        ASK: model || 'groq', INSTRUCTIONS: finalMode,
        HISTORY: history || [], QUERY: cleanText, FILES: [], CONTEXT: null
      }});
    } catch (err) {
      console.error('[Coder] Parse error:', err.message);
      return res.status(500).json({ error: 'Parse failed' });
    }
  }

  if (action === 'ask') {
    const cookieHeader = req.headers.cookie || '';
    const cookieUserId = cookieHeader.split(';').map(c => c.trim())
      .find(c => c.startsWith('mobius_user_id='))?.split('=')[1] || null;
    const { mobius_query, userId: bodyUserId, topic, session_id } = req.body || {};
    const userId = cookieUserId || bodyUserId || null;

    let ASK, INSTRUCTIONS, HISTORY, QUERY, FILES;
    if (mobius_query) {
      ({ ASK, INSTRUCTIONS, HISTORY, QUERY, FILES } = mobius_query);
    } else {
      ASK = req.body.model || 'gemini-lite'; INSTRUCTIONS = 'Brief';
      HISTORY = req.body.history || []; QUERY = req.body.query || ''; FILES = [];
    }

    const t0 = Date.now();

    try {
      const systemPrompt = SYSTEM_PROMPTS[INSTRUCTIONS] || SYSTEM_PROMPTS.Brief;
      const messages = [
        { role: 'user', content: '[System] ' + systemPrompt },
        ...(HISTORY || []),
        { role: 'user', content: QUERY }
      ];

      const imageParts       = (FILES || []).filter(f => f.mimeType?.startsWith('image/')).map(f => ({ inline_data: { mime_type: f.mimeType, data: f.base64 } }));
      const hasImages        = imageParts.length > 0;
      const hasNonImageFiles = (FILES || []).some(f => f.mimeType && !f.mimeType.startsWith('image/'));

      function appendFileTexts() {
        if (hasNonImageFiles) {
          const fileTexts = (FILES || [])
            .filter(f => !f.mimeType.startsWith('image/'))
            .map(f => '[File: ' + f.name + ']\n' + Buffer.from(f.base64, 'base64').toString('utf8'))
            .join('\n\n');
          messages[messages.length - 1].content += '\n\n' + fileTexts;
        }
      }

      let reply, modelUsed = ASK, tokensIn = null, tokensOut = null, failedModels = [];
      const ask = (ASK || 'groq').toLowerCase();

      if (ask === 'qwen35') {
        try {
          appendFileTexts(); reply = await askOllama(messages, 'qwen3.5:35b-a3b'); modelUsed = 'Qwen3.5 35B (local)';
        } catch (err) {
          failedModels.push({ model: 'qwen35', reason: err.message });
          const fb = await askWithFallback(messages, [], 'groq');
          reply = fb.reply; modelUsed = fb.modelUsed + ' (fallback from Qwen35)';
        }

      } else if (ask === 'qwen') {
        try {
          appendFileTexts(); reply = await askOllama(messages, 'qwen2.5-coder:7b'); modelUsed = 'Qwen2.5-Coder 7B (local)';
        } catch (err) {
          failedModels.push({ model: 'qwen', reason: err.message });
          const fb = await askWithFallback(messages, [], 'groq');
          reply = fb.reply; modelUsed = fb.modelUsed + ' (fallback from Qwen)';
        }

      } else if (ask === 'deepseek') {
        try {
          appendFileTexts(); reply = await askOllama(messages, 'deepseek-r1:7b'); modelUsed = 'DeepSeek R1 7B (local)';
        } catch (err) {
          failedModels.push({ model: 'deepseek', reason: err.message });
          const fb = await askWithFallback(messages, [], 'groq');
          reply = fb.reply; modelUsed = fb.modelUsed + ' (fallback from DeepSeek)';
        }

      } else if (ask === 'groq-qwq') {
        // Qwen-QwQ 32B via Groq -- reasoning model, different architecture from Llama
        try {
          appendFileTexts();
          const key = process.env.GROQ_API_KEY;
          if (!key) throw new Error('GROQ_API_KEY not configured.');
          const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'qwen-qwq-32b', messages }),
            signal: AbortSignal.timeout(30000)
          });
          const data = await r.json();
          const content = data.choices?.[0]?.message?.content || data.choices?.[0]?.message?.reasoning_content;
          if (!content) throw new Error(JSON.stringify(data));
          reply = content; modelUsed = 'Groq QwQ 32B';
        } catch (err) {
          failedModels.push({ model: 'groq-qwq', reason: err.message });
          const fb = await askGroqCascade(messages);
          reply = fb.text; modelUsed = fb.modelUsed + ' (fallback from QwQ)';
        }

      } else if (ask === 'mistral' || ask === 'codestral') {
        try {
          appendFileTexts(); reply = await askMistral(messages); modelUsed = MODEL_FULL_NAMES.mistral;
        } catch (err) {
          failedModels.push({ model: 'codestral', reason: err.message });
          const fb = await askWithFallback(messages, [], 'groq');
          reply = fb.reply; modelUsed = fb.modelUsed + ' (fallback from Codestral)';
          failedModels = failedModels.concat(fb.failedModels || []);
        }

      } else if (ask === 'gemini' || ask === 'gemini-flash' || hasImages) {
        try {
          const r = await askGemini(messages, imageParts);
          reply = r.text; tokensIn = r.tokensIn; tokensOut = r.tokensOut; modelUsed = MODEL_FULL_NAMES.gemini;
        } catch (err) {
          failedModels.push({ model: 'gemini', reason: err.message });
          appendFileTexts();
          const fb = await askWithFallback(messages, [], 'groq');
          reply = fb.reply; modelUsed = fb.modelUsed + ' (fallback from Gemini)';
          failedModels = failedModels.concat(fb.failedModels || []);
        }

      } else if (ask === 'gemini-lite') {
        try {
          appendFileTexts();
          const r = await askGeminiLite(messages);
          reply = r.text; tokensIn = r.tokensIn; tokensOut = r.tokensOut; modelUsed = MODEL_FULL_NAMES['gemini-lite'];
        } catch (err) {
          failedModels.push({ model: 'gemini-lite', reason: err.message });
          const fb = await askWithFallback(messages, [], 'groq');
          reply = fb.reply; modelUsed = fb.modelUsed + ' (fallback from Gemini Lite)';
          failedModels = failedModels.concat(fb.failedModels || []);
        }

      } else if (ask === 'web' || ask === 'web2' || ask === 'web3') {
        appendFileTexts();
        try {
          const r = await askWebSearch(messages, ask === 'web3' ? 3 : ask === 'web2' ? 2 : 1);
          reply = r.reply; modelUsed = r.modelUsed;
        } catch (err) {
          failedModels.push({ model: ask, reason: err.message });
          const fb = await askWithFallback(messages, [], 'groq');
          reply = fb.reply; modelUsed = fb.modelUsed + ' (fallback from web search)';
        }

      } else if (ask === 'cerebras' || ask === 'cerebras-cascade') {
        // Within-stable cascade -- no cross-stable fallback
        try {
          appendFileTexts();
          const r = await askCerebrasCascade(messages);
          reply = r.text; modelUsed = r.modelUsed;
        } catch (err) {
          failedModels.push({ model: 'cerebras', reason: err.message });
          throw err;
        }

      } else if (ask === 'deepseek-cloud') {
        try {
          appendFileTexts(); reply = await askDeepSeekCloud(messages); modelUsed = 'DeepSeek V3';
        } catch (err) {
          failedModels.push({ model: 'deepseek-cloud', reason: err.message });
          const fb = await askWithFallback(messages, [], 'groq');
          reply = fb.reply; modelUsed = fb.modelUsed + ' (fallback from DeepSeek V3)';
          failedModels = failedModels.concat(fb.failedModels || []);
        }

      } else if (ask === 'deepseek-r1') {
        // DeepSeek R1 -- reasoning model, thinks before answering
        try {
          appendFileTexts();
          reply = await askDeepSeekCloud(messages, 'deepseek-reasoner'); modelUsed = 'DeepSeek R1';
        } catch (err) {
          failedModels.push({ model: 'deepseek-r1', reason: err.message });
          const fb = await askDeepSeekCloud(messages, 'deepseek-chat').catch(async () => askWithFallback(messages, [], 'groq'));
          reply = typeof fb === 'string' ? fb : (fb.reply || fb.text);
          modelUsed = 'DeepSeek V3 (fallback from R1)';
        }

      } else if (ask === 'openrouter' || ask === 'openrouter-cascade') {
        // Within-stable cascade -- no cross-stable fallback
        try {
          appendFileTexts();
          const r = await askOpenRouterCascade(messages);
          reply = r.text; modelUsed = r.modelUsed;
        } catch (err) {
          failedModels.push({ model: 'openrouter', reason: err.message });
          throw err;
        }

      } else if (ask === 'groq-cascade') {
        try {
          appendFileTexts();
          const r = await askGroqCascade(messages);
          reply = r.text; modelUsed = r.modelUsed;
        } catch (err) {
          failedModels.push({ model: 'groq-cascade', reason: err.message });
          const fb = await askWithFallback(messages, [], 'gemini-lite');
          reply = fb.reply; modelUsed = fb.modelUsed + ' (fallback from Groq)';
          failedModels = failedModels.concat(fb.failedModels || []);
        }

      } else if (ask === 'gemini-cascade') {
        try {
          appendFileTexts();
          const r = await askGeminiCascade(messages);
          reply = r.text; modelUsed = r.modelUsed;
        } catch (err) {
          failedModels.push({ model: 'gemini-cascade', reason: err.message });
          const fb = await askWithFallback(messages, [], 'groq');
          reply = fb.reply; modelUsed = fb.modelUsed + ' (fallback from Gemini)';
          failedModels = failedModels.concat(fb.failedModels || []);
        }

      } else if (ask === 'mistral-cascade') {
        try {
          appendFileTexts();
          const r = await askMistralCascade(messages);
          reply = r.text; modelUsed = r.modelUsed;
        } catch (err) {
          failedModels.push({ model: 'mistral-cascade', reason: err.message });
          const fb = await askWithFallback(messages, [], 'groq');
          reply = fb.reply; modelUsed = fb.modelUsed + ' (fallback from Mistral)';
          failedModels = failedModels.concat(fb.failedModels || []);
        }

      } else {
        const isCoding = (INSTRUCTIONS === 'Code');
        appendFileTexts();
        try {
          const fb = await askWithFallback(messages, [], ask || 'gemini-lite', isCoding);
          reply = fb.reply; modelUsed = fb.modelUsed; failedModels = fb.failedModels || [];
          if (detectsCutoff(reply)) {
            try { const ws = await askWebSearch(messages, 2); reply = ws.reply; modelUsed = ws.modelUsed; } catch {}
          }
        } catch (err) {
          throw new Error('All models failed: ' + err.message);
        }
      }

      const latencyMs = Date.now() - t0;
      res.json({ reply, modelUsed, tokensIn, tokensOut, failedModels });

      if (userId && reply) {
        saveConversation(userId, QUERY, reply, modelUsed, topic || 'coding', session_id || null, {
          ask: ASK, instructions: INSTRUCTIONS, historyCount: (HISTORY || []).length,
          tokensIn, tokensOut, latencyMs, failedModels: failedModels.length ? failedModels : null
        }).catch(e => console.error('[Coder] Save error:', e.message));
      }

    } catch (err) {
      console.error('[Coder] Ask error:', err.message);
      res.status(500).json({ error: err.message });
    }
    return;
  }

  if (action === 'session/start') {
    const cookieHeader = req.headers.cookie || '';
    const userId = cookieHeader.split(';').map(c => c.trim())
      .find(c => c.startsWith('mobius_user_id='))?.split('=')[1] || req.body?.userId || null;
    const { project = 'coder', domain = 'coding' } = req.body || {};
    return res.status(200).json({ sessionId: await startSession(userId, project, domain) });
  }

  if (action === 'session/close') {
    try {
      let body = req.body || {};
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
      await closeSession(body.sessionId, body.userId);
      return res.status(200).json({ ok: true });
    } catch { return res.status(200).json({ ok: false }); }
  }

  if (action === 'session/heartbeat') {
    const cookieHeader = req.headers.cookie || '';
    const userId = cookieHeader.split(';').map(c => c.trim())
      .find(c => c.startsWith('mobius_user_id='))?.split('=')[1] || null;
    await heartbeatSession(req.body?.sessionId, userId);
    return res.status(200).json({ ok: true });
  }

  // ── Memory actions ──────────────────────────────────────────────────────────
  if (action === 'memory') {
    const cookieHeader = req.headers.cookie || '';
    const cookieUserId = cookieHeader.split(';').map(c => c.trim())
      .find(c => c.startsWith('mobius_user_id='))?.split('=')[1] || null;
    const { sub, userId: bodyUserId, content, query, table, id } = req.body || {};
    const userId = cookieUserId || bodyUserId || process.env.MOBIUS_TEST_USER_ID || '22008c93-c79b-491d-b3c1-efa194c0c871';

    try {
      if (sub === 'write') {
        const ok = await writeGeneral(userId, content, req.body.source || 'auto', null);
        return res.json({ ok });
      }

      if (sub === 'search') {
        const result = await searchMemory(userId, query || '');
        return res.json({ result });
      }

      if (sub === 'view') {
        const data = await viewMemory(userId, 15);
        return res.json(data);
      }

      if (sub === 'add') {
        // Split input into sentences -- each atomic fact stored as a separate record.
        const sentences = (content || '')
          .split(/(?<=[.!?])\s+/)
          .map(s => s.trim())
          .filter(s => s.length > 4);
        const items = sentences.length > 1 ? sentences : [content];
        let saved = 0;
        let lastTable = null;
        for (const item of items) {
          await writeGeneral(userId, item, 'manual', null);
          try {
            const prompt = 'Classify this memory into user/tools/project and extract 3-5 tags.\nMemory: "' + item + '"\nRespond ONLY with JSON (no markdown): {"table":"user|tools|project","tags":["a","b"],"project_ids":[]}';
            const r = await askGeminiLite([{ role: 'user', content: prompt }]);
            const parsed = JSON.parse((r.text || '').replace(/```json|```/g, '').trim());
            const t = 'memory_' + (parsed.table || 'tools');
            await writeWorking(userId, t, item, parsed.tags || [], parsed.project_ids || [], []);
            lastTable = parsed.table;
          } catch {
            // Saved to memory_general, will be classified on next distil
          }
          saved++;
        }
        return res.json({ ok: true, saved, table: lastTable });
      }

      if (sub === 'delete') {
        const ok = await deleteMemory(userId, id);
        return res.json({ ok });
      }

      if (sub === 'update') {
        const ok = await updateMemory(userId, id, content);
        return res.json({ ok });
      }

      if (sub === 'count') {
        const counts = await countMemory(userId);
        return res.json(counts);
      }

      if (sub === 'embed-list') {
        const rows = await embedList(userId);
        return res.json({ ok: true, rows });
      }

      if (sub === 'embed-one') {
        const { id: rowId, table: rowTable, content: rowContent } = req.body || {};
        const result = await embedOne(userId, rowId, rowTable, rowContent);
        return res.json(result);
      }

      if (sub === 'distil') {
        // Try Gemini Lite first, fall back to Groq cascade if quota exceeded
        async function distilAI(messages) {
          try {
            return await askGeminiLite(messages);
          } catch (e) {
            if (e.message && e.message.includes('quota')) {
              const r = await askGroqCascade(messages);
              return { text: r.text };
            }
            throw e;
          }
        }
        const result = await distilMemory(userId, distilAI, 30);
        return res.json(result);
      }

      return res.status(400).json({ error: 'Unknown memory sub-action: ' + sub });
    } catch (err) {
      console.error('[Memory] handler error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  res.status(400).json({ error: 'Unknown action: ' + action });
};
