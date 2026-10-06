// web.js — Tavily web search (on by default for every substantive question).
import { KEYS } from './config.js';

// depth 'advanced' (the default, two credits) for answering; 'basic' (one credit) is enough to check a single fact.
export async function tavilySearch(query, { depth = 'advanced' } = {}) {
  if (!KEYS.tavily) return null;
  try {
    const r = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEYS.tavily },
      body: JSON.stringify({ query, max_results: 5, search_depth: depth, include_answer: true }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return null;
    const data = await r.json();
    const lines = ['Query: ' + query];
    if (data.answer) lines.push('Summary: ' + data.answer);
    for (const h of (data.results || []).slice(0, 5)) {
      lines.push('\n• ' + h.title + ' — ' + h.url);
      if (h.content) lines.push('  ' + h.content.slice(0, 300));
    }
    return lines.join('\n');
  } catch { return null; }
}

// GET /usage costs no credit; surfaced in the UI as "credits remaining this month".
export async function tavilyUsage() {
  if (!KEYS.tavily) return null;
  try {
    const r = await fetch('https://api.tavily.com/usage', {
      headers: { Authorization: 'Bearer ' + KEYS.tavily },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    const data = await r.json();
    const limit = data?.account?.plan_limit;
    const used = data?.account?.plan_usage;
    return (typeof limit === 'number' && typeof used === 'number') ? { remaining: limit - used, limit } : null;
  } catch { return null; }
}
