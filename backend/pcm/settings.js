// pcm/settings.js — the few switches Boon can flip from the Settings page. Stored in Supabase so they
// follow him to whichever device he uses, and apply to the laptop and the cloud alike.
import { LEARN_MODE } from '../config.js';
import { getState, setState } from './memory.js';

const DEFAULTS = { learnMode: LEARN_MODE }; // 'auto' | 'suggest' | 'off'
const CHOICES = { learnMode: ['auto', 'suggest', 'off'] };

let cache = null, cachedAt = 0;

export async function getSettings() {
  if (cache && Date.now() - cachedAt < 20000) return cache;
  const stored = await getState('settings').catch(() => null);
  cache = { ...DEFAULTS, ...(stored && typeof stored === 'object' ? stored : {}) };
  cachedAt = Date.now();
  return cache;
}

export async function saveSettings(patch) {
  const next = { ...(await getSettings()) };
  for (const [k, allowed] of Object.entries(CHOICES)) if (patch?.[k] != null && allowed.includes(patch[k])) next[k] = patch[k];
  await setState('settings', next);
  cache = next; cachedAt = Date.now();
  return next;
}
