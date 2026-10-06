// pcm/stance.js - Mobius's own positions on questions that no look-up can settle (God, morality, scripture, suffering ...).
//
// Why this exists (6 Oct 2026): Boon found Mobius defending Christianity where other AIs stay agnostic. The traces showed no
// instruction to do so. What they showed was a model that argued against whatever Boon had just said, a theology shelf made
// only of Christian authors, summaries of his own theology in memory, and a different model answering each time, so that no
// position survived from one message to the next. Positions of Mobius's own, kept in one place and read by every model, are the
// structural fix: Mobius starts balanced, and the positions move only when an argument or piece of evidence moves them.
//
// Storage: mobius_memory kind 'stance', one active row per topic (key = the topic), content = JSON:
//   { position, confidence, because, change, covered: [{ date, point, outcome }], revised }
//   position, because   what Mobius holds, and why
//   change              what would move it
//   covered             arguments already exchanged; not to be rerun unless something new arrives
//   outcome             'held' (Mobius kept its view for a reason) | 'conceded' (it accepted a point) | 'open'
// The maintenance job (maintain.js refreshStances) updates them from the conversations; older versions stay in the archive.
import { clip } from '../util.js';

const text = v => String(v ?? '').replace(/\s+/g, ' ').trim();
const norm = s => text(s).toLowerCase().replace(/[^a-z0-9 ]/g, '');
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const MAX_STANCES = 14;
export const MAX_COVERED = 16;

export function parseStance(content) {
  try {
    const o = JSON.parse(content);
    if (o && typeof o === 'object') return { position: '', confidence: '', because: '', change: '', ...o, covered: Array.isArray(o.covered) ? o.covered : [] };
  } catch { /* plain text */ }
  return { position: text(content), confidence: '', because: '', change: '', covered: [] };
}

export function renderStance(key, s) {
  const covered = (s.covered || []).slice(-8).map(c => `  - ${c.date ? c.date + ': ' : ''}${c.point}${c.outcome ? ` [${c.outcome}]` : ''}`).join('\n');
  return [
    `${key}`,
    `Your position: ${s.position}${s.confidence ? ` (confidence: ${s.confidence})` : ''}`,
    s.because && `Why: ${s.because}`,
    covered && `Already argued with Boon (build on it; do not rerun it):\n${covered}`,
    s.change && `What would change your mind: ${s.change}`,
  ].filter(Boolean).join('\n');
}

// Does this term appear in the text? A short term must be a whole word ("god" must not fire on "Godfather"); a longer
// one may carry a suffix ("christian" finds "Christianity").
const mentions = (hay, term) => new RegExp('\\b' + esc(term) + (term.length >= 6 ? '' : '\\b'), 'i').test(hay);

// The positions that bear on this message: rows is listActive('stance'). At most `max`, best match first.
export function stancesFor(rows, query, { max = 3 } = {}) {
  const hay = String(query || '');
  return (rows || [])
    .map(r => ({ r, n: [r.key, ...(r.keywords || [])].map(t => text(t)).filter(t => t.length > 2).filter(t => mentions(hay, t)).length }))
    .filter(x => x.n > 0)
    .sort((a, b) => b.n - a.n)
    .slice(0, max)
    .map(x => renderStance(x.r.key, parseStance(x.r.content)))
    .join('\n\n');
}

// Fold one update from the maintenance model into a stance. Fields the update leaves out stay as they were, which is the point:
// a position moves only when the update carries a new one. Returns null when there is still no position to keep.
export function mergeUpdate(existing, u, today) {
  const old = existing ? parseStance(existing.content) : null;
  const next = { position: old?.position || '', confidence: old?.confidence || '', because: old?.because || '', change: old?.change || '', covered: [...(old?.covered || [])], revised: old?.revised || null };
  for (const f of ['position', 'confidence', 'because', 'change']) {
    const v = text(u?.[f]);
    if (v) next[f] = clip(v, f === 'because' ? 700 : 450);
  }
  if (old && next.position !== old.position) next.revised = today;
  const known = new Set(next.covered.map(c => norm(c.point)));
  for (const c of Array.isArray(u?.covered) ? u.covered : []) {
    const point = clip(text(c?.point), 200);
    if (point.length < 12 || known.has(norm(point))) continue;
    next.covered.push({ date: today, point, outcome: ['held', 'conceded', 'open'].includes(c?.outcome) ? c.outcome : 'open' });
    known.add(norm(point));
  }
  next.covered = next.covered.slice(-MAX_COVERED);
  return next.position ? next : null;
}

export const cleanKeywords = k => (Array.isArray(k) ? k : []).map(t => text(t).slice(0, 40)).filter(t => t.length > 2).slice(0, 10);
