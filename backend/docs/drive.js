// docs/drive.js — the Mobius Google Drive folder: browse, import, upload, sync.
// Reads via a service account (no OAuth flow). Supported: PDF, DOCX, TXT, MD, Google Docs/Sheets.
import { google } from 'googleapis';
import { Readable } from 'stream';
import { DRIVE_CREDENTIALS, DRIVE_FOLDER_ID } from '../config.js';
import { supabase } from '../db.js';
import { saveDoc, deleteDoc } from './store.js';
import { extractFromBuffer } from './extract.js';

export const SUPPORTED_MIME = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/epub+zip',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/html',
  'application/json',
  'application/vnd.google-apps.document',
  'application/vnd.google-apps.spreadsheet',
  'application/vnd.google-apps.presentation',
]);

export const driveConfigured = () => !!DRIVE_CREDENTIALS;

export function client() {
  const auth = new google.auth.GoogleAuth({
    credentials: DRIVE_CREDENTIALS,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  return google.drive({ version: 'v3', auth });
}

export async function extractText(drive, file) {
  try {
    if (file.mimeType === 'application/vnd.google-apps.document' || file.mimeType === 'application/vnd.google-apps.presentation') {
      return (await drive.files.export({ fileId: file.id, mimeType: 'text/plain' }, { responseType: 'text' })).data || '';
    }
    if (file.mimeType === 'application/vnd.google-apps.spreadsheet') {
      return (await drive.files.export({ fileId: file.id, mimeType: 'text/csv' }, { responseType: 'text' })).data || '';
    }
    const res = await drive.files.get({ fileId: file.id, alt: 'media' }, { responseType: 'arraybuffer' });
    return await extractFromBuffer(Buffer.from(res.data), file.name || '', file.mimeType || '');
  } catch (e) {
    console.warn(`[drive] extractText failed for ${file.name || file.id}: ${e.message}`);
    return '';
  }
}

// Walk the folder recursively, keeping supported files with their folder path.
async function listFiles(drive, folderId, prefix = '') {
  const files = [];
  let pageToken = null;
  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'nextPageToken, files(id, name, mimeType, modifiedTime)',
      pageSize: 100,
      pageToken: pageToken || undefined,
    });
    for (const f of res.data.files || []) {
      if (f.mimeType === 'application/vnd.google-apps.folder') files.push(...await listFiles(drive, f.id, prefix + f.name + '/'));
      else if (SUPPORTED_MIME.has(f.mimeType)) files.push({ ...f, path: prefix + f.name });
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return files;
}

export async function browse() {
  const files = await listFiles(client(), DRIVE_FOLDER_ID);
  return files.map(f => ({ id: f.id, name: f.path, mimeType: f.mimeType, modifiedTime: f.modifiedTime }));
}

export async function importFile(fileId, mimeType) {
  return extractText(client(), { id: fileId, mimeType });
}

export async function uploadToDrive(buffer, filename, mimeType) {
  const res = await client().files.create({
    requestBody: { name: filename, parents: [DRIVE_FOLDER_ID] },
    media: { mimeType: mimeType || 'application/octet-stream', body: Readable.from(buffer) },
    fields: 'id, name, webViewLink',
  });
  return res.data;
}

// A file that has left the Drive folder is removed here too, into the backup so it can be restored.
// Guarded: if a large share of files seem to have vanished, the listing is more likely wrong than the folder.
async function removeVanished(files) {
  if (!files.length) return { skipped: 'Drive listing was empty' };
  const present = new Set(files.map(f => f.path));
  const { data } = await supabase.rpc('pcm_doc_sources');
  const fromDrive = (data || []).filter(r => r.source === 'gdrive').map(r => r.filename);
  const gone = fromDrive.filter(f => !present.has(f));
  if (!gone.length) return { removed: 0 };
  if (gone.length > Math.max(3, fromDrive.length * 0.3)) return { skipped: `${gone.length} of ${fromDrive.length} files look removed; not acting on that many at once` };
  for (const f of gone) await deleteDoc(f, 'removed from the Google Drive folder');
  return { removed: gone.length };
}

// New or changed files are re-read and re-chunked; unchanged ones are skipped.
export async function syncDrive() {
  const drive = client();
  const files = await listFiles(drive, DRIVE_FOLDER_ID);
  const gone = await removeVanished(files);
  let indexed = 0, skipped = 0;
  for (const file of files) {
    const { data: existing } = await supabase.from('mobius_docs').select('id')
      .eq('filename', file.path).eq('modified_at', file.modifiedTime).limit(1);
    if (existing?.length) { skipped++; continue; }
    const text = await extractText(drive, file);
    if (!text.trim()) { skipped++; continue; }
    await saveDoc(file.path, text, { source: 'gdrive', modifiedAt: file.modifiedTime });
    indexed++;
  }
  return { indexed, skipped, total: files.length, ...gone };
}

// Fill mobius_docs_full for files that were chunked before that table existed. Text only, no embedding.
export async function backfillFull() {
  const drive = client();
  const files = await listFiles(drive, DRIVE_FOLDER_ID);
  let added = 0, skipped = 0;
  for (const file of files) {
    const { data: have } = await supabase.from('mobius_docs_full').select('filename').eq('filename', file.path).maybeSingle();
    if (have) { skipped++; continue; }
    const text = await extractText(drive, file);
    if (!text.trim()) { skipped++; continue; }
    await supabase.from('mobius_docs_full').upsert({ filename: file.path, content: text, updated_at: new Date().toISOString() });
    added++;
  }
  return { added, skipped, total: files.length };
}
