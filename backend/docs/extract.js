// docs/extract.js — turn an uploaded or downloaded file's bytes into text.
// pdf-parse and mammoth are loaded with require(): pdf-parse 1.x misbehaves when
// imported as an ES module.
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

export async function extractFromBuffer(buffer, name = '', mimeType = '') {
  if (mimeType === 'application/pdf' || /\.pdf$/i.test(name)) {
    return (await require('pdf-parse')(buffer)).text || '';
  }
  if (mimeType.includes('wordprocessingml') || /\.docx$/i.test(name)) {
    return (await require('mammoth').extractRawText({ buffer })).value || '';
  }
  return buffer.toString('utf8');
}
