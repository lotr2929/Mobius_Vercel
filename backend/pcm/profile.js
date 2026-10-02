// pcm/profile.js — the personal profile (memory tier 2).
// It is sent to the model with every message, so it has a size limit. A profile over the limit is
// condensed by a model rather than refused or chopped, and the old version is kept (last five,
// then the trash) so nothing is lost.
import { askModel } from '../ai/cascade.js';
import { put, setState } from './memory.js';
import { clip } from '../util.js';

export const PROFILE_MAX = 3000;

// → { text, shortened, from?, truncated? }
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
    } catch { /* try the next target, then fall back */ }
  }

  // No model could do it: cut at the last whole line that fits, never mid-sentence.
  const cut = text.slice(0, PROFILE_MAX);
  const nl = cut.lastIndexOf('\n');
  return { text: (nl > PROFILE_MAX * 0.6 ? cut.slice(0, nl) : cut).trim(), shortened: true, from: text.length, truncated: true };
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
