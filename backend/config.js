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
  gemini:   env.GEMINI_API_KEY   || '',
  mistral:  env.MISTRAL_API_KEY  || '',
  cerebras: env.CEREBRAS_API_KEY || '',
  groq:     env.GROQ_API_KEY     || '',
  tavily:   env.TAVILY_API_KEY   || '',
};

export const SUPABASE_URL = env.SUPABASE_URL || '';
export const SUPABASE_KEY = env.SUPABASE_KEY || '';
export const CRON_SECRET  = env.CRON_SECRET  || '';

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
export const RECENT_MESSAGES      = 12;  // tier 1: messages sent verbatim with every request
export const WEEK_DAYS            = 7;   // tier 1: horizon of the rolling digest
export const PROJECT_DORMANT_DAYS = 30;  // tier 3: a project untouched this long drops out of "current"
export const CRON_BUDGET_MS       = 50000; // time-box for the daily cron route
