// config.js — the one place environment variables are read, plus shared constants.
import 'dotenv/config';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;

export const ROOT = path.join(here, '..');
export const FRONTEND_DIR = path.join(ROOT, 'frontend');
export const PORT = env.PORT || 3005;
export const IS_VERCEL = env.VERCEL === '1';
export const START_TIME = Date.now();

export const KEYS = {
  gemini:  env.GEMINI_API_KEY  || '',
  mistral: env.MISTRAL_API_KEY || '',
  groq:    env.GROQ_API_KEY    || '',
  nvidia:  env.NVIDIA_API_KEY  || '',   // NVIDIA NIM free endpoints (build.nvidia.com); "trial use only"
  tavily:  env.TAVILY_API_KEY  || '',
};

export const SUPABASE_URL = env.SUPABASE_URL || '';
export const SUPABASE_KEY = env.SUPABASE_KEY || '';
export const CRON_SECRET  = env.CRON_SECRET  || '';

// What Mobius does when Boon states something worth keeping, without being told to remember it:
//   'auto'    explicit definitions, corrections and preferences are saved at once (and reported, with undo);
//             everything else becomes a suggestion that waits for his say-so
//   'suggest' everything becomes a suggestion
//   'off'     no learning from messages
export const LEARN_MODE = env.LEARN_MODE || 'auto';

// ── Login (passkeys) ─────────────────────────────────────────────────────────
// Login is on only when SESSION_SECRET is set (do that on Vercel; leave it out locally).
export const SESSION_SECRET = env.SESSION_SECRET || ''; // long random string; signs the login cookie
export const SETUP_CODE     = env.SETUP_CODE     || ''; // one-time code that lets a new device register a passkey
export const RP_ID           = env.RP_ID          || ''; // optional override; defaults to the site's hostname

// ── Google Drive ─────────────────────────────────────────────────────────────
// Credentials come from GOOGLE_SERVICE_ACCOUNT_JSON (Vercel) or the gitignored
// google-service-account.json in the repo root (local).
export const DRIVE_FOLDER_ID = env.DRIVE_FOLDER_ID || '1VVnAQfq___O30Jz7wW_ovRNQdk8jQdLj';

function loadDriveCredentials() {
  try {
    if (env.GOOGLE_SERVICE_ACCOUNT_JSON) return JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const local = path.join(ROOT, 'google-service-account.json');
    return fs.existsSync(local) ? JSON.parse(fs.readFileSync(local, 'utf8')) : null;
  } catch (e) {
    console.warn('[drive] could not read service-account credentials:', e.message);
    return null;
  }
}
export const DRIVE_CREDENTIALS = loadDriveCredentials();

// ── Memory (PCM) ─────────────────────────────────────────────────────────────
// Whatever Mobius removes is kept in Supabase (mobius_trash) and, when it runs on the laptop,
// also written here. Outside the repository on purpose: it holds personal documents.
export const BACKUP_DIR = env.BACKUP_DIR || path.join(ROOT, '..', 'Backup');
export const TRASH_DAYS = 180; // how long removed items stay restorable in Supabase
export const RECENT_MESSAGES      = 20;  // tier 1: messages sent verbatim with every request (10 exchanges)
export const WEEK_DAYS            = 7;   // tier 1: horizon of the rolling digest
export const PROJECT_DORMANT_DAYS = 30;  // tier 3: a project untouched this long drops out of "current"
export const CRON_BUDGET_MS       = 50000; // time-box for the daily cron route

// ── Answer review (pcm/review.js) ────────────────────────────────────────────
// A second model checks a factual, theological or research answer before it is sent (and the draft is redrafted once if it
// finds real problems). 'on' (default) or 'off'.
export const REVIEW_MODE    = (env.REVIEW_MODE || 'on').toLowerCase();
// The most time one chat turn may take, review included. The review is cut short, and the draft sent as it stands, rather than
// run past it: a held draft that outlives the serverless function would be lost. The Vercel figure is a guess to be raised if
// the project's function limit allows (CRON_BUDGET_MS above suggests about a minute); locally there is no such limit.
export const TURN_BUDGET_MS = Number(env.TURN_BUDGET_MS) || (IS_VERCEL ? 52000 : 110000);
