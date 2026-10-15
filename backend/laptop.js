// Asking Qwen (Ask: Local, Mobius AI desktop app) to work with files on Boon's laptop.
// A 7B model copies whatever it has just said: after a few wrong "I cannot reach that folder" answers it kept repeating them, even though
// the tools worked. So a request about files or folders is sent with the earlier turns left out, and only the new message (which carries
// the memory context) goes to the model. Ordinary chat with Qwen keeps its history.
const FILE_WORDS = /[A-Za-z]:[\\/]|\b(?:files?|folders?|directory|directories|paths?|atlas|drive)\b|\.(?:md|txt|docx?|pdf|pptx?|xlsx?|csv|json)\b/i;

export const isFileTurn = query => FILE_WORDS.test(String(query || ''));

export function turnsForLocal(messages, query, laptopTools) {
  return laptopTools && isFileTurn(query) ? messages.slice(-1) : messages;
}