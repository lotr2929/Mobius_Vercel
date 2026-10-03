// pcm/attachments.js — pictures sent in chat are kept, so they can be looked at again.
// The browser sends each picture already shrunk (about 1600 px, a few hundred KB). It is stored in the private
// Storage bucket "mobius-attachments" (separate from the 500 MB database allowance) with a row in mobius_attachments
// that holds the caption. When a later message refers to "the image I sent earlier", the real picture is attached
// to that message again, not just the earlier description of it.
import { randomUUID } from 'crypto';
import { supabase } from '../db.js';

const BUCKET = 'mobius-attachments';
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

// Keep the pictures of one message. `caption` is what the first answer said about them.
export async function saveImages(images, messageId, caption) {
  if (!supabase || !images?.length) return [];
  const saved = [];
  for (const [i, img] of images.entries()) {
    try {
      const buf = Buffer.from(img.base64, 'base64');
      const path = `${new Date().toISOString().slice(0, 7)}/${randomUUID()}.${EXT[img.mimeType] || 'jpg'}`;
      const up = await supabase.storage.from(BUCKET).upload(path, buf, { contentType: img.mimeType || 'image/jpeg', upsert: false });
      if (up.error) throw new Error(up.error.message);
      const { data, error } = await supabase.from('mobius_attachments')
        .insert({ message_id: messageId || null, path, mime: img.mimeType || 'image/jpeg', bytes: buf.length, caption: i === 0 ? String(caption || '').slice(0, 900) : null })
        .select('id, path').single();
      if (error) throw new Error(error.message);
      saved.push(data);
    } catch (e) { console.warn('[attachments] could not keep a picture:', e.message); }
  }
  return saved;
}

// The most recent pictures, newest first, as [{ id, message_id, path, mime, caption, created_at }].
export async function recentAttachments(limit = 8, withinDays = 30) {
  if (!supabase) return [];
  const since = new Date(Date.now() - withinDays * 864e5).toISOString();
  const { data, error } = await supabase.from('mobius_attachments')
    .select('id, message_id, path, mime, caption, created_at').gt('created_at', since).order('created_at', { ascending: false }).limit(limit);
  if (error) { console.warn('[attachments]', error.message); return []; }
  return data || [];
}

// Download a stored picture in the form the models take: { mimeType, base64 }.
export async function loadImage(row) {
  const { data, error } = await supabase.storage.from(BUCKET).download(row.path);
  if (error || !data) throw new Error(error?.message || 'picture not found');
  return { mimeType: row.mime || 'image/jpeg', base64: Buffer.from(await data.arrayBuffer()).toString('base64') };
}

const words = s => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, ' ').split(/\s+/).filter(w => w.length > 3);

// Which earlier picture(s) does the message mean? The hint ("whiteboard photo") is matched against captions; with no
// useful hint, the pictures of the latest message that had any.
export async function earlierImages(hint = '', { max = 3 } = {}) {
  const rows = await recentAttachments(12);
  if (!rows.length) return null;
  const hw = new Set(words(hint));
  let pick = [];
  if (hw.size) {
    const scored = rows.map(r => ({ r, s: words(r.caption).filter(w => hw.has(w)).length })).filter(x => x.s > 0).sort((a, b) => b.s - a.s || b.r.created_at.localeCompare(a.r.created_at));
    if (scored.length) { const top = scored[0].r.message_id; pick = rows.filter(r => r.message_id === top); }
  }
  if (!pick.length) { const latest = rows[0].message_id; pick = rows.filter(r => r.message_id === latest); }
  pick = pick.slice(0, max);
  const images = [];
  for (const r of pick) { try { images.push(await loadImage(r)); } catch (e) { console.warn('[attachments] load failed:', e.message); } }
  if (!images.length) return null;
  return { images, note: pick.map(r => `sent ${r.created_at.slice(0, 16).replace('T', ' ')} UTC${r.caption ? ' — first described as: ' + r.caption.replace(/\s+/g, ' ').slice(0, 300) : ''}`).join('\n') };
}
