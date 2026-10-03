// google.js — "Connect my Google account": Mobius reads Boon's Google Drive as himself, read-only.
// This replaces the invite step: no folder has to be shared with anyone, and links can simply be pasted.
// The sign-in is Google's own page; Mobius only ever receives a long-lived token for drive.readonly.
// The OAuth client (made once in Google Cloud Console) and the token are stored in mobius_google, sealed with
// AES-256-GCM keyed from SESSION_SECRET. Nothing here is ever sent to the browser or to an AI model.
import crypto from 'crypto';
import { google } from 'googleapis';
import { supabase } from './db.js';
import { SESSION_SECRET, DRIVE_CREDENTIALS } from './config.js';

const T = 'mobius_google';
export const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/drive.readonly'];
const STATE_MS = 10 * 60 * 1000;

// ── Sealing secrets at rest ──────────────────────────────────────────────────
const sealKey = () => crypto.createHash('sha256').update('mobius-google|' + SESSION_SECRET).digest();
export function seal(text) {
  if (!text) return null;
  if (!SESSION_SECRET) return 'plain:' + text; // a local copy without SESSION_SECRET cannot seal
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', sealKey(), iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return 'v1:' + Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}
export function unseal(value) {
  try {
    if (!value) return null;
    if (value.startsWith('plain:')) return value.slice(6);
    if (!value.startsWith('v1:') || !SESSION_SECRET) return null;
    const buf = Buffer.from(value.slice(3), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', sealKey(), buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
  } catch { return null; }
}

// ── Stored state ─────────────────────────────────────────────────────────────
async function row() {
  if (!supabase) return null;
  const { data } = await supabase.from(T).select('*').eq('id', 1).maybeSingle();
  return data;
}
async function patch(p) {
  const { error } = await supabase.from(T).upsert({ id: 1, ...p, updated_at: new Date().toISOString() });
  if (error) throw new Error('google: ' + error.message);
}
// Which Google key to use. A key saved in Settings comes first; the key the earlier version of Mobius registered (kept in
// GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET, or GOOGLE_OAUTH_*) is the fallback, so there is nothing to set up if it still works.
async function creds() {
  const r = await row();
  const savedId = r?.client_id, savedSecret = unseal(r?.client_secret);
  if (savedId && savedSecret) return { id: savedId, secret: savedSecret, r, from: 'set-up' };
  const id = process.env.GOOGLE_OAUTH_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
  const secret = process.env.GOOGLE_OAUTH_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET;
  return id && secret ? { id, secret, r, from: 'earlier version' } : null;
}

// Where the site lives, as the browser sees it. Google must be told this exact address in advance.
export function redirectUri(req) {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol).split(',')[0];
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0];
  return `${proto}://${host}/api/google/callback`;
}

export async function status(req) {
  const r = await row();
  const c = await creds();
  return {
    redirectUri: redirectUri(req), project: DRIVE_CREDENTIALS?.project_id || null, // the Google project Mobius already has, so the set-up links go straight to it
    configured: !!c, clientIdHint: c ? c.id.slice(0, 14) + '…' : null, clientProject: c ? c.id.split('-')[0] : null,
    keyFrom: c ? c.from : null,
    connected: !!(r?.refresh_token && unseal(r.refresh_token)), email: r?.email || null, connectedAt: r?.connected_at || null, problem: r?.last_error || null,
  };
}

// The key file Google lets you download when you create the client (client_secret_….json). Taking the whole file
// saves copying two long strings by hand, and lets Mobius check the file is the right kind before using it.
export async function saveClientJson(req, text) {
  let j;
  try { j = JSON.parse(text); } catch { throw new Error('That is not the key file from Google. Choose the file named client_secret_….json that you downloaded.'); }
  const type = Object.keys(j || {})[0];
  if (!j?.web) {
    throw new Error(j?.installed
      ? 'That key is for a different kind of app (“Desktop”). In step 3 choose “Web application”, create the key again and download it.'
      : 'That file does not contain a Google client key. It should come from the Clients page, from the “Download JSON” button' + (type ? ` (this one starts with “${type}”).` : '.'));
  }
  const c = j.web;
  if (!c.client_id || !c.client_secret) throw new Error('That file has no client secret in it. Google shows the secret only when the key is created, so create a new key and download the file straight away.');
  const uri = redirectUri(req);
  if (!(c.redirect_uris || []).includes(uri)) {
    throw new Error(`That key does not list Mobius’s return address. In Google open the key (Clients → Mobius), add ${uri} under “Authorised redirect URIs”, save, and use the file again (or download a new one).`);
  }
  await saveCredentials(c.client_id, c.client_secret);
}

export async function saveCredentials(clientId, clientSecret) {
  const id = String(clientId || '').trim(), secret = String(clientSecret || '').trim();
  if (!/\.apps\.googleusercontent\.com$/.test(id)) throw new Error('The Client ID should end with .apps.googleusercontent.com. Copy it exactly from Google.');
  if (secret.length < 10) throw new Error('That Client secret looks too short. Copy it exactly from Google.');
  // A token belongs to the client that issued it, so changing the client ends any earlier connection.
  await patch({ client_id: id, client_secret: seal(secret), refresh_token: null, email: null, connected_at: null, last_error: null, oauth_state: null });
}

// ── Signing in ───────────────────────────────────────────────────────────────
// Google answers a request it will refuse with a redirect to its error page. Asking first means Mobius can say what is
// wrong in its own words, instead of leaving the browser on Google's error screen.
export async function preflight(url) {
  try {
    const r = await fetch(url, { redirect: 'manual' });
    const loc = r.headers.get('location') || '';
    if (!/signin\/oauth\/error/.test(loc)) return { ok: true };
    let what = '';
    try { what = Buffer.from(decodeURIComponent((loc.match(/authError=([^&]+)/) || [])[1] || ''), 'base64').toString('utf8'); } catch { /* unreadable: treated as a general error */ }
    return { ok: false, kind: /redirect_uri_mismatch/.test(what) ? 'redirect' : /invalid_client|deleted_client/.test(what) ? 'client' : 'other' };
  } catch { return { ok: true }; } // cannot tell from here: let Google decide
}

export class SetupError extends Error { constructor(message, fix) { super(message); this.fix = fix; } }

// Google only sends the browser back to an address it was told about in advance. Mobius's own address is tried first;
// the address the earlier version registered (GOOGLE_REDIRECT_URI) is the second choice, so a sign-in works the moment
// either one is known to Google. The choice, and the page to come back to, travel inside the one-time state value.
const originOf = req => redirectUri(req).replace(/\/api\/google\/callback$/, '');
function redirectCandidates(req) {
  const list = [redirectUri(req)];
  const earlier = process.env.GOOGLE_REDIRECT_URI;
  try { if (earlier && new URL(earlier).protocol === 'https:' && !list.includes(earlier)) list.push(earlier); } catch { /* not an address: ignored */ }
  return list;
}
// The path part of the earlier address, so the server can answer there too.
export function earlierCallbackPath() { try { return new URL(process.env.GOOGLE_REDIRECT_URI).pathname; } catch { return null; } }
const readState = state => { try { return JSON.parse(Buffer.from(String(state).split('.')[1], 'base64url').toString('utf8')); } catch { return null; } };

export async function startAuth(req) {
  const c = await creds();
  if (!c) throw new Error('Save the Client ID and Client secret first.');
  let first = null;
  for (const uri of redirectCandidates(req)) {
    const state = crypto.randomBytes(24).toString('hex') + '.' + Buffer.from(JSON.stringify({ o: originOf(req), r: uri })).toString('base64url');
    const o = new google.auth.OAuth2(c.id, c.secret, uri);
    const url = o.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES, state });
    const p = await preflight(url);
    if (p.ok) { await patch({ oauth_state: state, oauth_state_at: new Date().toISOString() }); return url; }
    first = first || p;
  }
  if (first.kind === 'redirect') throw new SetupError('Google does not yet know this return address: ' + redirectUri(req), 'redirect');
  if (first.kind === 'client') throw new SetupError('Google no longer recognises the saved key (it may have been deleted). Use “Use a different key” and download a new one.', 'client');
  throw new SetupError('Google refused the sign-in request. Check the key and its consent screen in Google Cloud.', 'other');
}

// The page to send the browser back to, but only if the state is the one Mobius issued (never a made-up address).
export async function originForState(state) {
  const r = await row();
  return r?.oauth_state && r.oauth_state === state ? (readState(state)?.o || null) : null;
}

export async function finishAuth(req, code, state) {
  const c = await creds();
  if (!c) throw new Error('The Google client is not set up.');
  const r = c.r;
  if (!r?.oauth_state || r.oauth_state !== state || Date.now() - Date.parse(r.oauth_state_at) > STATE_MS) {
    throw new Error('That sign-in attempt was not recognised or has expired. Press Connect and try again.');
  }
  await patch({ oauth_state: null });
  const o = new google.auth.OAuth2(c.id, c.secret, readState(state)?.r || redirectUri(req));
  const { tokens } = await o.getToken(code);
  if (!tokens.refresh_token) throw new Error('Google did not return a lasting permission. Remove Mobius at myaccount.google.com/permissions, then press Connect again.');
  let email = null;
  try { email = JSON.parse(Buffer.from(tokens.id_token.split('.')[1], 'base64url').toString('utf8')).email || null; } catch { /* the address is only for display */ }
  await patch({ refresh_token: seal(tokens.refresh_token), email, scope: tokens.scope || SCOPES.join(' '), connected_at: new Date().toISOString(), last_error: null });
  return { email };
}

export async function disconnect() {
  const c = await creds();
  const token = unseal(c?.r?.refresh_token);
  if (c && token) { try { await new google.auth.OAuth2(c.id, c.secret).revokeToken(token); } catch { /* already revoked: fine */ } }
  await patch({ refresh_token: null, email: null, connected_at: null, last_error: null, oauth_state: null });
}

// ── Using it ─────────────────────────────────────────────────────────────────
// A Drive client acting as Boon, or null when no account is connected.
export async function userDrive() {
  const c = await creds();
  const token = unseal(c?.r?.refresh_token);
  if (!c || !token) return null;
  const o = new google.auth.OAuth2(c.id, c.secret);
  o.setCredentials({ refresh_token: token });
  return google.drive({ version: 'v3', auth: o });
}

// Google ended the permission (revoked, expired, or the app was left in Testing): say so, stop using it.
export async function noteFailure(err) {
  const msg = String(err?.message || err);
  if (/invalid_grant|invalid_client|unauthorized_client/i.test(msg)) {
    await patch({ refresh_token: null, email: null, connected_at: null, last_error: 'Google ended the connection (the permission was removed or expired). Press Connect to sign in again.' });
    return true;
  }
  return false;
}

// Folders for the "Browse my Drive" list. `parent` is 'root', 'shared' (shared with me) or a folder id.
export async function listFolders(parent = 'root') {
  const drive = await userDrive();
  if (!drive) throw new Error('Connect your Google account first.');
  if (!/^(root|shared|[A-Za-z0-9_-]{10,})$/.test(parent)) throw new Error('Not a folder.');
  const q = parent === 'shared'
    ? "sharedWithMe = true and mimeType = 'application/vnd.google-apps.folder' and trashed = false"
    : `'${parent}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  try {
    const out = [];
    let pageToken;
    do {
      const r = await drive.files.list({ q, pageSize: 200, pageToken, orderBy: 'name', fields: 'nextPageToken, files(id, name)', supportsAllDrives: true, includeItemsFromAllDrives: true });
      out.push(...(r.data.files || []));
      pageToken = r.data.nextPageToken;
    } while (pageToken && out.length < 1000);
    return out;
  } catch (e) { await noteFailure(e); throw e; }
}
