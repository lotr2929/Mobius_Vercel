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

// Several targeted searches at once (the planner's webQueries), de-duplicated by address. The first runs in 'advanced' depth
// (two credits) and carries Tavily's summary; the others run 'basic' (one credit each). Returns text, or null if nothing came back.
export async function tavilySearchMany(queries, { max = 3 } = {}) {
  const qs = [...new Set((queries || []).map(q => String(q || '').trim()).filter(Boolean))].slice(0, max);
  if (!KEYS.tavily || !qs.length) return null;
  const runs = await Promise.all(qs.map(async (q, i) => {
    try {
      const r = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEYS.tavily },
        body: JSON.stringify({ query: q, max_results: 5, search_depth: i === 0 ? 'advanced' : 'basic', include_answer: i === 0 }),
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) return null;
      return { q, data: await r.json() };
    } catch { return null; }
  }));
  const seen = new Set(), out = [];
  for (const run of runs.filter(Boolean)) {
    out.push('Search: ' + run.q);
    if (run.data.answer) out.push('Summary: ' + run.data.answer);
    for (const h of (run.data.results || []).slice(0, 5)) {
      if (!h.url || seen.has(h.url)) continue;
      seen.add(h.url);
      out.push('\n- ' + h.title + ' - ' + h.url);
      if (h.content) out.push('  ' + h.content.slice(0, 500));
    }
    out.push('');
  }
  return out.length ? out.join('\n') : null;
}

// Opens pages whose addresses Boon put in his message ("can you open this?"). Costs one credit per five pages.
// Always says which pages could not be opened, so the model can tell him plainly instead of guessing.
export async function tavilyExtract(urls, { perPage = 5000 } = {}) {
  const list = [...new Set(urls || [])].slice(0, 3);
  if (!KEYS.tavily || !list.length) return null;
  try {
    const r = await fetch('https://api.tavily.com/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEYS.tavily },
      body: JSON.stringify({ urls: list, extract_depth: 'basic' }),
      signal: AbortSignal.timeout(25000),
    });
    if (!r.ok) return 'Pages Boon linked: the page-opening service returned an error (HTTP ' + r.status + '), so none could be opened.';
    const data = await r.json();
    const out = [];
    for (const p of data.results || []) out.push('Page opened: ' + p.url + '\n' + String(p.raw_content || '').slice(0, perPage));
    for (const f of data.failed_results || []) out.push('Could NOT open: ' + (f.url || '') + (f.error ? ' (' + String(f.error).slice(0, 80) + ')' : '') + ' - the site blocked it or needs a sign-in. Say so plainly.');
    return out.length ? out.join('\n\n') : null;
  } catch { return 'Pages Boon linked: opening them timed out or failed, so none could be read. Say so plainly.'; }
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
