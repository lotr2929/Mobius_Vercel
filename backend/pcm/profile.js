// pcm/profile.js — the personal profile (memory tier 2).
// It is sent to the model with every message, so it has a target size (PROFILE_MAX). A profile
// over the target is condensed by a model rather than refused or chopped, and the old version is
// kept (last five, then the trash) so nothing is lost. If no model is available the profile is
// kept whole and condensed later (housekeeping retries); PROFILE_SEND_MAX is the safety limit on
// what is actually sent.
import { askModel } from '../ai/cascade.js';
import { put, setState, getActive } from './memory.js';
import { clip } from '../util.js';

export const PROFILE_MAX = 3000;       // the target
export const PROFILE_SEND_MAX = 6000;  // never send more than this to a model

// → { text, shortened, from?, tooLong? }   tooLong: over the target and no model could condense it
export async function fitProfile(input) {
  const text = String(input).trim();
  if (text.length <= PROFILE_MAX) return { text, shortened: false };

  for (const target of [2800, 2400]) {
    try {
      const out = (await askModel(`Condense this personal profile to at most ${target} characters.
Keep every distinct fact, name, date and preference. Remove repetition and filler, merge bullets that overlap, and shorten wording. Keep the same style (plain markdown bullets) and the same point of view. Do not add anything new.
Reply with ONLY the condensed profile.

${clip(text, 14000)}`, { role: 'deep', timeoutMs: 40000 })).trim();
      if (out.length <= PROFILE_MAX && out.length > text.length * 0.3) return { text: out, shortened: true, from: text.length };
    } catch { /* try the next target */ }
  }

  // No model could do it right now: keep the whole profile rather than lose anything.
  return { text, shortened: false, tooLong: true };
}

// Save as the active profile. `manual` means Boon typed it himself, which holds off the weekly
// automatic update for a day so it never overwrites his edit straight away.
export async function saveProfile(input, { manual = false } = {}) {
  const fit = await fitProfile(input);
  if (!fit.text) throw new Error('The profile cannot be empty');
  await put('profile', 'main', { content: fit.text });
  if (manual) await setState('profile_edited_at', new Date().toISOString());
  return fit;
}

// Housekeeping: a profile saved whole because no model was available gets condensed once one is.
export async function condenseProfileIfNeeded() {
  const current = (await getActive('profile'))?.content || '';
  if (current.length <= PROFILE_MAX) return { condensed: false };
  const fit = await fitProfile(current);
  if (fit.tooLong) return { condensed: false, stillTooLong: current.length };
  await put('profile', 'main', { content: fit.text }); // the long version stays under earlier versions
  return { condensed: true, from: current.length, to: fit.text.length };
}
