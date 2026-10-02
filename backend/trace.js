// trace.js — a flight recorder. Every chat turn (and every error the browser hits) is written to
// mobius_traces with what Mobius understood, what it recalled, what it sent the model and what
// came back, so problems can be diagnosed from the record instead of from descriptions.
// Traces hold the full prompt (including personal memory), so the table is locked with Row Level
// Security, and entries older than 14 days are deleted.
import { supabase } from './db.js';
import { isoDaysAgo } from './util.js';

export function startTrace(kind, data = {}) {
  const t0 = Date.now();
  const trace = {
    kind,
    data: { ...data, marks: {} },
    set(fields) { Object.assign(this.data, fields); return this; },
    mark(name) { this.data.marks[name] = Date.now() - t0; return this; }, // milliseconds since the turn began
  };
  return trace;
}

export async function saveTrace(trace) {
  if (!supabase) return;
  try {
    const { error } = await supabase.from('mobius_traces').insert({ kind: trace.kind, data: trace.data });
    if (error) console.warn('[trace]', error.message);
    if (Math.random() < 0.1) await supabase.from('mobius_traces').delete().lt('created_at', isoDaysAgo(14));
  } catch (e) { console.warn('[trace]', e.message); }
}

export async function recentTraces(n = 5, kind = null) {
  if (!supabase) return [];
  let q = supabase.from('mobius_traces').select('id, created_at, kind, data').order('id', { ascending: false }).limit(Math.min(n, 30));
  if (kind) q = q.eq('kind', kind);
  const { data } = await q;
  return data || [];
}

export async function getTrace(id) {
  if (!supabase) return null;
  const { data } = await supabase.from('mobius_traces').select('*').eq('id', id).maybeSingle();
  return data;
}
