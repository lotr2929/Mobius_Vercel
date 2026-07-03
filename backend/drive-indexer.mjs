// drive-indexer.mjs
// Walks the Mobius Google Drive folder, extracts text from supported files,
// chunks and upserts into Supabase mobius_docs table.
// Supports: PDF, DOCX, TXT, MD, Google Docs (exported as text)

import { google } from 'googleapis';
import { createClient } from '@supabase/supabase-js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const DRIVE_FOLDER_ID = '1VVnAQfq___O30Jz7wW_ovRNQdk8jQdLj';
const CHUNK_SIZE      = 600;
const CHUNK_OVERLAP   = 100;
const SUPPORTED_MIME  = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/markdown',
  'application/vnd.google-apps.document',
  'application/vnd.google-apps.spreadsheet',
]);

// ── Auth ──────────────────────────────────────────────────────────────────────
// Accepts either a file path (local dev) or an already-parsed credentials
// object (Vercel, from the GOOGLE_SERVICE_ACCOUNT_JSON env var).
export function getDriveClient(keyOrCredentials) {
  const key = typeof keyOrCredentials === 'string' ? require(keyOrCredentials) : keyOrCredentials;
  const auth = new google.auth.GoogleAuth({
    credentials: key,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  return google.drive({ version: 'v3', auth });
}

// ── Embeddings (Gemini text-embedding-004, 768-dim) ──────────────────────────
async function embedGemini(text, geminiKey) {
  if (!geminiKey) return null;
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${geminiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'models/gemini-embedding-001',
        content: { parts: [{ text: text.slice(0, 8000) }] },
        outputDimensionality: 1024,
      }),
    }
  );
  if (!r.ok) throw new Error('Gemini embed HTTP ' + r.status);
  const data = await r.json();
  return data.embedding?.values || null;
}

// Gemini-only embedding, with retry-on-backoff (no cross-provider fallback —
// Gemini and Mistral vectors are not comparable even at matching dimensions).
async function embedText(text, geminiKey, _mistralKey, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const result = await embedGemini(text, geminiKey);
      if (result) return result;
    } catch (e) {
      const isRateLimit = /429/.test(e.message);
      console.warn(`[drive] gemini embed failed (attempt ${attempt + 1}/${retries}):`, e.message);
      if (attempt < retries - 1) {
        const wait = isRateLimit ? 15000 * (attempt + 1) : 2000 * (attempt + 1);
        await new Promise(r => setTimeout(r, wait));
      }
    }
  }
  return null;
}

// ── Text extraction ────────────────────────────────────────────────────────────
export async function extractText(drive, file) {
  try {
    if (file.mimeType === 'application/vnd.google-apps.document') {
      const res = await drive.files.export({ fileId: file.id, mimeType: 'text/plain' }, { responseType: 'text' });
      return res.data || '';
    }
    if (file.mimeType === 'application/vnd.google-apps.spreadsheet') {
      const res = await drive.files.export({ fileId: file.id, mimeType: 'text/csv' }, { responseType: 'text' });
      return res.data || '';
    }
    // Binary files — download buffer
    const res = await drive.files.get({ fileId: file.id, alt: 'media' }, { responseType: 'arraybuffer' });
    const buf = Buffer.from(res.data);

    if (file.mimeType === 'application/pdf') {
      const pdfParse = require('pdf-parse');
      const data = await pdfParse(buf);
      return data.text || '';
    }
    if (file.mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      const mammoth = require('mammoth');
      const result = await mammoth.extractRawText({ buffer: buf });
      return result.value || '';
    }
    // Plain text / markdown
    return buf.toString('utf8');
  } catch (e) {
    console.warn(`[drive] extractText failed for ${file.name}: ${e.message}`);
    return '';
  }
}

// ── Chunking ──────────────────────────────────────────────────────────────────
export function chunkText(text) {
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    chunks.push(text.slice(i, i + CHUNK_SIZE));
    i += CHUNK_SIZE - CHUNK_OVERLAP;
    if (i < 0) break;
  }
  return chunks.filter(c => c.trim().length > 20);
}

// ── Walk folder recursively ────────────────────────────────────────────────────
export async function listFiles(drive, folderId, path = '') {
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
      if (f.mimeType === 'application/vnd.google-apps.folder') {
        const sub = await listFiles(drive, f.id, path + f.name + '/');
        files.push(...sub);
      } else if (SUPPORTED_MIME.has(f.mimeType)) {
        files.push({ ...f, path: path + f.name });
      }
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return files;
}

// ── Main sync ─────────────────────────────────────────────────────────────────
// ── Upload a file into the Mobius Drive folder ────────────────────────────────
export async function uploadToDrive(keyPath, buffer, filename, mimeType) {
  const drive = getDriveClient(keyPath);
  const { Readable } = await import('stream');
  const res = await drive.files.create({
    requestBody: {
      name: filename,
      parents: [DRIVE_FOLDER_ID],
    },
    media: {
      mimeType: mimeType || 'application/octet-stream',
      body: Readable.from(buffer),
    },
    fields: 'id, name, webViewLink',
  });
  return res.data;
}

export async function syncDrive(keyPath, supabaseUrl, supabaseKey, geminiKey, mistralKey) {
  const drive   = getDriveClient(keyPath);
  const supabase = createClient(supabaseUrl, supabaseKey);

  console.log('[drive] Starting sync of Mobius folder…');
  const files = await listFiles(drive, DRIVE_FOLDER_ID);
  console.log(`[drive] Found ${files.length} indexable files`);

  let indexed = 0; let skipped = 0; let embedFailed = 0;

  for (const file of files) {
    // Check if already indexed with same modifiedTime
    const { data: existing } = await supabase
      .from('mobius_docs')
      .select('id')
      .eq('filename', file.path)
      .eq('modified_at', file.modifiedTime)
      .limit(1);

    if (existing?.length) { skipped++; continue; }

    // Delete old chunks for this file
    await supabase.from('mobius_docs').delete().eq('filename', file.path);

    // Extract and chunk
    const text = await extractText(drive, file);
    if (!text.trim()) { skipped++; continue; }

    // Full raw text — this is what gets retrieved when the paper is
    // referenced by name later, separate from the chunks used for topic search.
    await supabase.from('mobius_docs_full').upsert({ filename: file.path, content: text, updated_at: new Date().toISOString() });

    const chunks = chunkText(text);
    const rows = [];
    for (const chunk of chunks) {
      const embedding = await embedText(chunk, geminiKey, mistralKey);
      if (!embedding) embedFailed++;
      rows.push({
        filename: file.path,
        chunk,
        embedding,
        embedding_provider: embedding ? 'gemini' : null,
        modified_at: file.modifiedTime,
        source: 'gdrive',
        created_at: new Date().toISOString(),
      });
    }

    if (rows.length) {
      const { error } = await supabase.from('mobius_docs').insert(rows);
      if (error) console.warn(`[drive] insert error for ${file.path}:`, error.message);
      else indexed++;
    }
  }

  console.log(`[drive] Sync complete — ${indexed} indexed, ${skipped} skipped${embedFailed ? `, ${embedFailed} embeds failed` : ''}`);
  return { indexed, skipped, total: files.length, embedFailed };
}

// One-time backfill: populate mobius_docs_full for files that were already
// chunked before that table existed. Pure text extraction — no embedding
// calls, so it's not affected by the Gemini quota.
export async function backfillFullDocs(keyPath, supabaseUrl, supabaseKey) {
  const drive = getDriveClient(keyPath);
  const supabase = createClient(supabaseUrl, supabaseKey);
  const files = await listFiles(drive, DRIVE_FOLDER_ID);
  let done = 0, skipped = 0;
  for (const file of files) {
    const { data: existing } = await supabase.from('mobius_docs_full').select('filename').eq('filename', file.path).maybeSingle();
    if (existing) { skipped++; continue; }
    const text = await extractText(drive, file);
    if (!text.trim()) { skipped++; continue; }
    await supabase.from('mobius_docs_full').upsert({ filename: file.path, content: text, updated_at: new Date().toISOString() });
    done++;
    console.log(`[backfill-full] ${file.path}`);
  }
  console.log(`[backfill-full] done — ${done} added, ${skipped} skipped`);
  return { done, skipped, total: files.length };
}
