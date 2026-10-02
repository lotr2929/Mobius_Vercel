// pcm/assemble.js — build the context pack for the stateless model.
// Every section has a cap and a rank; when the total budget runs short, the
// highest-ranked (lowest number) sections are filled first and the rest shrink or drop.
import { clip } from '../util.js';

export const TOTAL_CHARS = 30000; // ≈ 8K tokens

// parts: [{ title, text, cap, rank }] in display order.
export function assembleContext(parts, total = TOTAL_CHARS) {
  const live = parts.filter(p => p.text && p.text.trim());
  const body = new Map();
  let left = total;
  for (const p of [...live].sort((a, b) => a.rank - b.rank)) {
    const room = Math.min(p.cap, left);
    if (room < 300) continue;
    const text = clip(p.text.trim(), room);
    body.set(p, text);
    left -= text.length + p.title.length + 4;
  }
  return live.filter(p => body.has(p)).map(p => `[${p.title}]\n${body.get(p)}`).join('\n\n');
}
