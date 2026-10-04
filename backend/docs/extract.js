
// docs/extract.js — turn a file's bytes into text, whatever the file is.
//   PDF            pdf-parse         Word (.docx)   mammoth
//   EPUB           spine order, tags stripped              (this file)
//   Excel (.xlsx)  one block per sheet, cells tab-separated (this file)
//   PowerPoint (.pptx)  one block per slide, speaker notes included (this file)
//   HTML           tags stripped     anything else  read as UTF-8 text (txt, md, csv, json, code…)
// The old binary Office formats (.doc .xls .ppt) cannot be read; the error says to save them in the newer format.
// pdf-parse and mammoth are loaded with require(): pdf-parse 1.x misbehaves when imported as an ES module.
// The zip-based formats are opened with JSZip and read with small, plain parsers (no heavy spreadsheet or slide library).
import { createRequire } from 'module';
import path from 'path';
import JSZip from 'jszip';

const require = createRequire(import.meta.url);

export const MIME = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  epub: 'application/epub+zip',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  html: 'text/html',
};
export const READABLE_EXTENSIONS = ['pdf', 'docx', 'epub', 'xlsx', 'pptx', 'html', 'htm', 'txt', 'md', 'csv', 'json', 'js', 'py'];

// ── small helpers ────────────────────────────────────────────────────────────
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', hellip: '…' };
export const decodeEntities = s => String(s).replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (m, dec, hex, name) => {
  if (dec) return String.fromCodePoint(+dec);
  if (hex) return String.fromCodePoint(parseInt(hex, 16));
  return ENTITIES[name.toLowerCase()] ?? m;
});
const attr = (tag, name) => (tag.match(new RegExp(`\\b${name}="([^"]*)"`)) || [])[1];

// HTML or XHTML → plain text with paragraph breaks.
export function htmlToText(html) {
  return decodeEntities(String(html)
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|section|article|table)>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t\u00a0]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

const read = async (zip, p) => { const f = zip.file(p); return f ? f.async('string') : null; };

// ── EPUB ─────────────────────────────────────────────────────────────────────
export async function epubText(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const container = await read(zip, 'META-INF/container.xml');
  const opfPath = container && attr((container.match(/<rootfile\b[^>]*>/) || [''])[0], 'full-path');
  const opf = opfPath ? await read(zip, opfPath) : null;
  let order = [];
  let title = '';
  if (opf) {
    title = decodeEntities(((opf.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i) || [])[1] || '').trim());
    const base = path.posix.dirname(opfPath);
    const manifest = new Map([...opf.matchAll(/<item\b[^>]*>/g)].map(m => [attr(m[0], 'id'), { href: attr(m[0], 'href'), type: attr(m[0], 'media-type') || '' }]));
    order = [...opf.matchAll(/<itemref\b[^>]*>/g)].map(m => manifest.get(attr(m[0], 'idref')))
      .filter(x => x?.href && /html|xml/.test(x.type))
      .map(x => path.posix.normalize(path.posix.join(base === '.' ? '' : base, decodeURIComponent(x.href.split('#')[0]))));
  }
  if (!order.length) order = Object.keys(zip.files).filter(f => /\.(x?html?)$/i.test(f)).sort(); // no readable spine: all pages in name order
  const parts = [];
  for (const p of [...new Set(order)]) {
    const html = await read(zip, p);
    const text = html ? htmlToText(html) : '';
    if (text.length > 20) parts.push(text);
  }
  return (title ? `${title}\n\n` : '') + parts.join('\n\n');
}

// ── Excel ────────────────────────────────────────────────────────────────────
const cellColumn = ref => ref.replace(/\d+/g, '').split('').reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0); // "C5" → 3

export async function xlsxText(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const sharedXml = await read(zip, 'xl/sharedStrings.xml');
  const shared = sharedXml ? [...sharedXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map(m => decodeEntities([...m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(t => t[1]).join(''))) : [];
  const workbook = (await read(zip, 'xl/workbook.xml')) || '';
  const rels = (await read(zip, 'xl/_rels/workbook.xml.rels')) || '';
  const target = new Map([...rels.matchAll(/<Relationship\b[^>]*>/g)].map(m => [attr(m[0], 'Id'), attr(m[0], 'Target')]));
  let sheets = [...workbook.matchAll(/<sheet\b[^>]*>/g)].map(m => ({ name: decodeEntities(attr(m[0], 'name') || 'Sheet'), file: target.get(attr(m[0], 'r:id')) }))
    .filter(s => s.file).map(s => ({ ...s, file: path.posix.normalize(s.file.startsWith('/') ? s.file.slice(1) : 'xl/' + s.file) }));
  if (!sheets.length) sheets = Object.keys(zip.files).filter(f => /^xl\/worksheets\/sheet\d+\.xml$/.test(f)).sort().map((f, i) => ({ name: `Sheet${i + 1}`, file: f }));
  const out = [];
  for (const s of sheets) {
    const xml = await read(zip, s.file);
    if (!xml) continue;
    const lines = [];
    for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const c of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const t = attr(c[1], 't'), ref = attr(c[1], 'r') || '';
        const inner = c[2] || '';
        const v = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        let val = '';
        if (t === 's') val = shared[+v] ?? '';
        else if (t === 'inlineStr') val = decodeEntities([...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(m => m[1]).join(''));
        else if (t === 'b') val = v === '1' ? 'TRUE' : 'FALSE';
        else val = decodeEntities(v ?? '');
        if (val !== '') cells[(ref ? cellColumn(ref) : cells.length + 1) - 1] = val;
      }
      if (cells.some(x => x !== undefined)) lines.push(Array.from(cells, x => x ?? '').join('\t'));
    }
    if (lines.length) out.push(`## Sheet: ${s.name}\n${lines.join('\n')}`);
  }
  return out.join('\n\n');
}

// ── PowerPoint ───────────────────────────────────────────────────────────────
const paragraphs = xml => [...xml.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)]
  .map(p => decodeEntities([...p[1].matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g)].map(t => t[1]).join(''))).filter(s => s.trim());

export async function pptxText(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const num = f => +(f.match(/(\d+)\.xml$/) || [0, 0])[1];
  const slides = Object.keys(zip.files).filter(f => /^ppt\/slides\/slide\d+\.xml$/.test(f)).sort((a, b) => num(a) - num(b));
  const out = [];
  for (const f of slides) {
    const body = paragraphs((await read(zip, f)) || '').join('\n');
    const notesXml = await read(zip, `ppt/notesSlides/notesSlide${num(f)}.xml`);
    const notes = notesXml ? paragraphs(notesXml).filter(s => !/^\d+$/.test(s.trim())).join('\n') : ''; // the slide-number placeholder is not a note
    if (body || notes) out.push(`## Slide ${num(f)}\n${body}${notes ? `\n\nSpeaker notes: ${notes}` : ''}`);
  }
  return out.join('\n\n');
}

// ── the one entry point ──────────────────────────────────────────────────────
export async function extractFromBuffer(buffer, name = '', mimeType = '') {
  const ext = ((String(name).match(/\.([a-z0-9]+)$/i) || [])[1] || '').toLowerCase();
  const is = (e, m) => ext === e || mimeType === m;
  if (is('pdf', MIME.pdf)) return (await require('pdf-parse')(buffer)).text || '';
  if (is('docx', MIME.docx) || mimeType.includes('wordprocessingml')) return (await require('mammoth').extractRawText({ buffer })).value || '';
  if (is('epub', MIME.epub)) return epubText(buffer);
  if (is('xlsx', MIME.xlsx)) return xlsxText(buffer);
  if (is('pptx', MIME.pptx)) return pptxText(buffer);
  if (ext === 'html' || ext === 'htm' || mimeType === MIME.html) return htmlToText(buffer.toString('utf8'));
  if (['doc', 'xls', 'ppt'].includes(ext)) throw new Error(`.${ext} is an old binary Office format that Mobius cannot read. Open it and save it as .${ext}x, then add it again.`);
  return buffer.toString('utf8');
}
