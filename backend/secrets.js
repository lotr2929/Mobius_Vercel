// secrets.js - the plain-code screen for things that must never leave Mobius.
// Card numbers, passwords, PINs, API keys and tokens, and Australian identity and bank numbers are cut out of what Boon types or attaches
// BEFORE anything else sees it: no model, no embedding, no database row, no backup. It is code, not a model, so it cannot be talked round.
// The rest of his message is kept, so nothing needs resending; the secret is replaced by a plain marker such as [card number removed].
// Deliberately cautious about false alarms: a number is only taken for a card if it passes the Luhn check and begins like a real card,
// and a tax file, Medicare, passport or licence number is only taken when the words say what it is.
// Used by chat.js (the message and attached text), server.js (exchanges filed from the laptop) and pcm/notes.js (saved notes).
// Not screened: documents read from his Drive or archive. They were not typed or attached by him in this message.

const STOP = new Set(('required wrong weak incorrect expired too not missing invalid correct strong secure hidden stored saved encrypted hashed changed reset '
  + 'same different case-sensitive sensitive short long empty blank set shown visible being now still never always protected compromised leaked unknown '
  + 'here there something valid ok okay fine').split(' '));

const luhn = digits => {
  let sum = 0, alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n; alt = !alt;
  }
  return sum % 10 === 0;
};
const CARD_START = /^(?:4|5[1-5]|2[2-7]|3\d|6)/;   // Visa, Mastercard, Amex, JCB, Diners, Discover and the like

const ibanOk = s => {
  const t = s.replace(/ /g, '');
  if (t.length < 15 || t.length > 34) return false;
  let rem = 0;
  for (const ch of t.slice(4) + t.slice(0, 4)) for (const d of (/\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55))) rem = (rem * 10 + Number(d)) % 97;
  return rem === 1;
};

const PLACEHOLDER = /^(?:process\.env|import\.meta|your[_-]|xxx|example|placeholder|\.\.\.)/i;

// Returns { text, found, changed }: the text with secrets replaced, and the kinds that were found (never the secrets themselves).
export function redactSecrets(input) {
  const original = typeof input === 'string' ? input : String(input ?? '');
  let text = original;
  const found = [];
  const hit = label => { if (!found.includes(label)) found.push(label); return `[${label} removed]`; };
  const whole = (label, re) => { text = text.replace(re, () => hit(label)); };            // the whole match is the secret
  const tail = (label, re, group, ok = () => true) => {                                   // the secret is the end of the match; the words before it stay
    text = text.replace(re, (...a) => {
      const full = a[0], secret = a[group];
      return ok(secret) ? full.slice(0, full.length - secret.length) + hit(label) : full;
    });
  };

  // keys and tokens
  whole('private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g);
  whole('token', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g);
  for (const re of [
    /\bAIza[0-9A-Za-z_-]{35}/g, /\bsk-(?:ant-|proj-|or-)?[A-Za-z0-9_-]{20,}/g, /\bgh[pousr]_[A-Za-z0-9]{36,}/g, /\bgithub_pat_[A-Za-z0-9_]{50,}/g,
    /\bAKIA[0-9A-Z]{16}\b/g, /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, /\bnvapi-[A-Za-z0-9_-]{20,}/g, /\btvly-[A-Za-z0-9_-]{15,}/g, /\bgsk_[A-Za-z0-9]{20,}/g,
    /\bcsk-[A-Za-z0-9]{20,}/g, /\bGOCSPX-[A-Za-z0-9_-]{15,}/g, /\bsbp_[a-f0-9]{30,}/g, /\bsb_secret_[A-Za-z0-9_-]{20,}/g, /\bhf_[A-Za-z0-9]{30,}/g,
  ]) whole('API key', re);
  whole('token', /\bBearer\s+[A-Za-z0-9._~+\/-]{20,}=*/g);
  tail('API key', /\b(?:api[_-]?key|client[_-]?secret|access[_-]?key|private[_-]?key|secret|token)\b\s*[:=]\s*["']?([A-Za-z0-9._\/+=-]{16,})/gi, 1, v => !PLACEHOLDER.test(v) && !/^\[.* removed\]$/.test(v));

  // passwords and PINs
  tail('password', /\b(?:password|passcode|passphrase|pwd)\s*(?:\b(?:is|was)\b|=|:)\s*["'\u201C\u2018]?([^\s"'\u201D\u2019,;]{4,})/gi, 1, v => !(/^[a-z-]+$/.test(v) && STOP.has(v)) && !v.startsWith('['));
  tail('PIN', /\bPIN(?: code| number)?\s*(?:\b(?:is|was)\b|=|:)\s*(\d{4,8})\b/gi, 1);

  // identity numbers, only where the words say what they are
  tail('tax file number', /\b(?:TFN|tax file (?:number|no\.?))\b[^\d\n]{0,25}(\d{3}[ -]?\d{3}[ -]?\d{3})\b/gi, 1);
  tail('Medicare number', /\bmedicare\b[^\d\n]{0,25}(\d{4}[ -]?\d{5}[ -]?\d(?:[ \/-]?\d)?)\b/gi, 1);
  tail('passport number', /\bpassport\b[^\d\n]{0,30}?([A-Z]{1,2}\d{6,9})\b/gi, 1);
  tail('licence number', /\bdriver'?s?\s+licen[cs]e\b[^\d\n]{0,30}?((?=[A-Z0-9]*\d)[A-Z0-9]{6,10})\b/gi, 1);

  // bank details
  tail('BSB', /\bBSB\b[^\d\n]{0,10}(\d{3}[ -]?\d{3})\b/gi, 1);
  tail('bank account number', /\b(?:account|acc|a\/c)\s*(?:number|no\.?|#)?\s*(?:is|=|:)?\s*(\d[\d -]{5,17}\d)\b/gi, 1);
  tail('IBAN', /\b([A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?)\b/g, 1, ibanOk);

  // card numbers, last: 13 to 19 digits, groups allowed, Luhn-valid, and beginning like a real card
  text = text.replace(/(?<![\d-])(?:\d[ -]?){12,18}\d(?![\d-])/g, m => {
    const digits = m.replace(/[ -]/g, '');
    return digits.length >= 13 && digits.length <= 19 && CARD_START.test(digits) && luhn(digits) ? hit('card number') : m;
  });

  return { text, found, changed: text !== original };
}

// Attached documents: [{ filename, text }]. Returns the same list with the text screened, and the kinds found.
export function redactDocs(docs) {
  const found = [];
  const out = (Array.isArray(docs) ? docs : []).map(d => {
    if (!d || typeof d.text !== 'string') return d;
    const r = redactSecrets(d.text);
    for (const f of r.found) if (!found.includes(f)) found.push(f);
    return r.changed ? { ...d, text: r.text } : d;
  });
  return { docs: out, found };
}

// What Boon is told, at the head of the reply, when something was cut out.
export const redactionNotice = found => (found.length
  ? `*Mobius removed these from your message before anything was sent or saved: ${found.join(', ')}.*\n\n`
  : '');
