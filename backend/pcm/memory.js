// pcm/memory.js — storage for the curated memory tiers (mobius_memory) and job cursors (mobius_state).
//   kind 'profile' — tier 2, who Boon is (one active row, proposals await approval)
//   kind 'project' — tier 3, one active row per current project
//   kind 'week'    — tier 1, rolling digest of the past seven days
// Reads never throw (a missing table just means "no memory yet"); writes do.

import { supabase } from '../db.js';

const T = 'mobius_memory';

async function one(kind, key, status) {
  if (!supabase) return null;
  const { data, error } = await supabase.from(T).select('*')
    .eq('kind', kind).eq('key', key).eq('status', status)
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) { console.warn(`[pcm] ${kind}/${key}: ${error.message}`); return null; }
  return data || null;
}

export const getActive   = (kind, key = 'main') => one(kind, key, 'active');
export const getProposed = (kind, key = 'main') => one(kind, key, 'proposed');

export async function listActive(kind) {
  if (!supabase) return [];
  const { data, error } = await supabase.from(T).select('key, content, keywords, updated_at')
    .eq('kind', kind).eq('status', 'active').order('updated_at', { ascending: false });
  if (error) { console.warn(`[pcm] list ${kind}: ${error.message}`); return []; }
  return data || [];
}

// Replace the row of this status for (kind, key); the old one is archived (atomic, in SQL).
export async function put(kind, key, { content, keywords = [], status = 'active' }) {
  const { error } = await supabase.rpc('pcm_put_memory', {
    p_kind: kind, p_key: key, p_content: content, p_keywords: keywords, p_status: status,
  });
  if (error) throw new Error('pcm_put_memory: ' + error.message);
}

// Approve a proposal: it becomes the active row, the previous active one is archived.
export async function promote(kind, key = 'main') {
  const { data, error } = await supabase.rpc('pcm_promote_memory', { p_kind: kind, p_key: key });
  if (error) throw new Error('pcm_promote_memory: ' + error.message);
  return data; // id of the promoted row, or null when there was nothing to promote
}

export async function discard(kind, key = 'main') {
  const { error } = await supabase.from(T).update({ status: 'archived' })
    .eq('kind', kind).eq('key', key).eq('status', 'proposed');
  if (error) throw new Error(error.message);
}

// Active rows untouched for `days` fall out of the "current" tier (they remain in the archive).
export async function retireStale(kind, days) {
  const cutoff = new Date(Date.now() - days * 864e5).toISOString();
  const { error } = await supabase.from(T).update({ status: 'archived' })
    .eq('kind', kind).eq('status', 'active').lt('updated_at', cutoff);
  if (error) throw new Error(error.message);
}

// ── Job cursors ──────────────────────────────────────────────────────────────
export async function getState(key) {
  if (!supabase) return null;
  const { data, error } = await supabase.from('mobius_state').select('value').eq('key', key).maybeSingle();
  if (error) { console.warn(`[pcm] state ${key}: ${error.message}`); return null; }
  return data?.value ?? null;
}

export async function setState(key, value) {
  const { error } = await supabase.from('mobius_state').upsert({ key, value, updated_at: new Date().toISOString() });
  if (error) throw new Error('mobius_state: ' + error.message);
}
