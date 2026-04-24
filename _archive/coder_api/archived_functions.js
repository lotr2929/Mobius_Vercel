// _archive/coder_api/archived_functions.js
// Functions removed from active Mobius API files.
// Kept for reference -- not imported by any active route.
// ─────────────────────────────────────────────────────────────────────────────

// ── From _ai.js: detectsCutoff ────────────────────────────────────────────────
// Detected "I don't have real-time access" phrases in AI responses.
// Used in Coder's ask pipeline to trigger web search fallback.
// Not used in Mobius (web search handled by askWebSearch directly).

const CUTOFF_PHRASES = [
  'knowledge cutoff', 'training cutoff', 'training data',
  'as of my last update', 'as of my knowledge', 'i don\'t have access to real-time',
  'i cannot browse', 'i can\'t browse', 'no internet access',
  'i don\'t have internet', 'i cannot access the internet',
  'my information may be outdated', 'i don\'t have current',
  'i cannot provide real-time', 'not able to access current'
];

function detectsCutoff(text) {
  return CUTOFF_PHRASES.some(p => text.toLowerCase().includes(p));
}
