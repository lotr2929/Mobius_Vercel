// auth.js — passkey login: fingerprint on the phone, Windows Hello PIN on the laptop.
// A passkey is registered once per device (using SETUP_CODE); after that the device's own
// unlock (fingerprint / PIN) logs in. Sessions are signed cookies, so nothing is held in
// memory and it works on serverless. Login is on only when SESSION_SECRET is set.
import crypto from 'crypto';
import path from 'path';
import express from 'express';
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { SESSION_SECRET, SETUP_CODE, RP_ID, FRONTEND_DIR } from './config.js';
import { supabase } from './db.js';
import { sleep } from './util.js';

export const authEnabled = !!SESSION_SECRET;

const SESSION_DAYS = 30;
const CHALLENGE_MS = 5 * 60 * 1000;
const PASSKEYS = 'mobius_passkeys';

// ── Signed cookies ───────────────────────────────────────────────────────────
const mac = payload => crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
const sign = payload => `${payload}.${mac(payload)}`;

function unsign(value) {
  const i = value ? value.lastIndexOf('.') : -1;
  if (i < 0) return null;
  const payload = value.slice(0, i);
  const given = Buffer.from(value.slice(i + 1));
  const want = Buffer.from(mac(payload));
  return given.length === want.length && crypto.timingSafeEqual(given, want) ? payload : null;
}

function readCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setCookie(req, res, name, value, maxAgeSeconds) {
  const https = String(req.headers['x-forwarded-proto'] || req.protocol).split(',')[0] === 'https';
  res.append('Set-Cookie', `${name}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}${https ? '; Secure' : ''}`);
}

function startSession(req, res) {
  setCookie(req, res, 'mobius_session', sign(`s:${Date.now() + SESSION_DAYS * 864e5}`), SESSION_DAYS * 86400);
}

function hasSession(req) {
  const p = unsign(readCookies(req).mobius_session);
  return !!p && p.startsWith('s:') && Number(p.slice(2)) > Date.now();
}

// The challenge travels in a short-lived signed cookie and is used once.
function holdChallenge(req, res, kind, challenge) {
  setCookie(req, res, 'mobius_challenge', sign(`${kind}:${Date.now() + CHALLENGE_MS}:${challenge}`), 300);
}

function takeChallenge(req, res, kind) {
  const p = unsign(readCookies(req).mobius_challenge);
  setCookie(req, res, 'mobius_challenge', '', 0);
  if (!p) return null;
  const [k, exp, challenge] = p.split(':');
  return k === kind && Number(exp) > Date.now() ? challenge : null;
}

// Where the site lives, as the browser sees it.
function site(req) {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol).split(',')[0];
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0];
  return { rpID: RP_ID || host.split(':')[0], origin: `${proto}://${host}` };
}

const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const mayRegister = (req, code) =>
  hasSession(req) || (!!SETUP_CODE && !!code && crypto.timingSafeEqual(sha(code), sha(SETUP_CODE)));

async function listPasskeys() {
  const { data, error } = await supabase.from(PASSKEYS).select('id, transports');
  if (error) throw new Error(error.message);
  return data || [];
}

// ── Routes (open to everyone; they do their own checks) ──────────────────────
export const authRouter = express.Router();

const guard = handler => async (req, res) => {
  if (!authEnabled) return res.status(404).json({ error: 'Login is not enabled' });
  if (!supabase) return res.status(503).json({ error: 'No database connection' });
  try { await handler(req, res); }
  catch (e) { console.error('[auth]', e.message); res.status(500).json({ error: e.message }); }
};

authRouter.get('/auth/status', async (req, res) => {
  if (!authEnabled) return res.json({ enabled: false, authenticated: true, passkeys: 0 });
  let passkeys = 0;
  try { passkeys = (await listPasskeys()).length; } catch { /* table missing or database down */ }
  res.json({ enabled: true, authenticated: hasSession(req), passkeys });
});

authRouter.post('/auth/register/options', guard(async (req, res) => {
  if (!mayRegister(req, req.body?.setupCode)) { await sleep(800); return res.status(403).json({ error: 'Setup code not accepted' }); }
  const existing = await listPasskeys();
  const options = await generateRegistrationOptions({
    rpName: 'Mobius',
    rpID: site(req).rpID,
    userName: 'boon',
    userDisplayName: 'Boon',
    userID: new TextEncoder().encode('boon'),
    attestationType: 'none',
    excludeCredentials: existing.map(c => ({ id: c.id, transports: c.transports || undefined })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
  });
  holdChallenge(req, res, 'reg', options.challenge);
  res.json(options);
}));

authRouter.post('/auth/register/verify', guard(async (req, res) => {
  if (!mayRegister(req, req.body?.setupCode)) { await sleep(800); return res.status(403).json({ error: 'Setup code not accepted' }); }
  const expectedChallenge = takeChallenge(req, res, 'reg');
  if (!expectedChallenge) return res.status(400).json({ error: 'That attempt expired — try again' });
  const { rpID, origin } = site(req);
  const v = await verifyRegistrationResponse({
    response: req.body.response, expectedChallenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
  });
  if (!v.verified) return res.status(400).json({ error: 'Could not verify this device' });
  const c = v.registrationInfo.credential;
  const { error } = await supabase.from(PASSKEYS).insert({
    id: c.id,
    public_key: Buffer.from(c.publicKey).toString('base64url'),
    counter: c.counter,
    transports: c.transports || [],
    device_name: String(req.body.deviceName || '').slice(0, 60) || null,
  });
  if (error) throw new Error(error.message);
  startSession(req, res);
  res.json({ ok: true });
}));

authRouter.post('/auth/login/options', guard(async (req, res) => {
  const options = await generateAuthenticationOptions({ rpID: site(req).rpID, userVerification: 'required' });
  holdChallenge(req, res, 'auth', options.challenge);
  res.json(options);
}));

authRouter.post('/auth/login/verify', guard(async (req, res) => {
  const expectedChallenge = takeChallenge(req, res, 'auth');
  if (!expectedChallenge) return res.status(400).json({ error: 'That attempt expired — try again' });
  const response = req.body?.response;
  const { data: row } = await supabase.from(PASSKEYS).select('*').eq('id', String(response?.id || '')).maybeSingle();
  if (!row) return res.status(403).json({ error: 'This device is not registered' });
  const { rpID, origin } = site(req);
  const v = await verifyAuthenticationResponse({
    response, expectedChallenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
    credential: {
      id: row.id,
      publicKey: new Uint8Array(Buffer.from(row.public_key, 'base64url')),
      counter: Number(row.counter),
      transports: row.transports || undefined,
    },
  });
  if (!v.verified) return res.status(403).json({ error: 'Could not verify this device' });
  await supabase.from(PASSKEYS).update({ counter: v.authenticationInfo.newCounter, last_used: new Date().toISOString() }).eq('id', row.id);
  startSession(req, res);
  res.json({ ok: true });
}));

authRouter.post('/auth/logout', (req, res) => {
  setCookie(req, res, 'mobius_session', '', 0);
  res.json({ ok: true });
});

// ── The gate ─────────────────────────────────────────────────────────────────
// Everything except the login page, /auth/*, the files an install needs and the cron
// route (which has its own CRON_SECRET check) requires a session.
const OPEN = new Set(['/login.html', '/manifest.json', '/favicon.ico', '/icon-192.png', '/icon-512.png', '/icon-maskable-192.png', '/icon-maskable-512.png', '/logo.png', '/api/cron/daily']);

export function authGate(req, res, next) {
  if (!authEnabled || OPEN.has(req.path) || req.path.startsWith('/auth/') || hasSession(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Login required' });
  const ext = path.extname(req.path);
  if (req.method === 'GET' && (!ext || ext === '.html')) return res.status(401).sendFile(path.join(FRONTEND_DIR, 'login.html'));
  res.status(401).send('Login required');
}
