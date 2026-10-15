// docs/coverage.js - what Mobius has actually read of Boon's linked Drive folders (Atlas and the others).
// Asked "have you read everything in Atlas?", Mobius used to answer from whatever digests happened to be in its prompt. Now it is given exact
// figures: per linked folder how many files were found, read, and summarised; what was skipped and why; how full the database is; and which
// Atlas folders are NOT linked (it can still open those on request, but it has not read them).
import { supabase } from '../db.js';
import { listSources } from './sources.js';
import { storageReport } from '../pcm/housekeeping.js';
import { listFolders } from '../google.js';

// Is this question about what Mobius has read or indexed?
export const asksCoverage = q => /\b(?:have you|did you|do you|has mobius|are you|is mobius)\b[^.?!]{0,60}\b(?:read|index(?:ed|es|ing)?|ingest\w*|digest\w*|know|covered|sync\w*)\b[^.?!]{0,80}\b(?:atlas|folders?|drive|documents|files|library)\b|\bwhat (?:have you|has mobius|did you) (?:read|index(?:ed)?|ingested)\b|\bread (?:everything|all)\b[^.?!]{0,50}\b(?:atlas|folder|drive)|\b(?:everything|all)\b[^.?!]{0,50}\b(?:atlas|folder|drive)\b[^.?!]{0,30}\b(?:read|index(?:ed)?)\b/i.test(String(q || ''));

const like = label => label.replace(/[\\%_]/g, m => '\\' + m) + '/%';
const when = iso => iso ? new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', timeZone: 'Australia/Perth' }) : 'never';

// Plain text for the model: the facts only.
export async function coverageText({ atlas = 'Atlas' } = {}) {
  if (!supabase) return '';
  const sources = (await listSources()).filter(s => s.provider === 'gdrive');
  const lines = [];
  for (const s of sources) {
    const [read, digested] = await Promise.all([
      supabase.from('mobius_docs_full').select('filename', { count: 'exact', head: true }).like('filename', like(s.label)),
      supabase.from('mobius_digests').select('filename', { count: 'exact', head: true }).eq('level', 'doc').like('filename', like(s.label)),
    ]);
    lines.push(`- "${s.label}": ${s.files_seen ?? '?'} files found, ${read.count ?? '?'} read and searchable, ${digested.count ?? '?'} summarised so far; last checked ${when(s.last_synced || s.last_checked)}. ${String(s.detail || '').slice(0, 220)}${s.sensitivity === 'private' ? ' (marked private)' : ''}`);
  }
  let notLinked = '';
  try {
    const root = (await listFolders('root')).find(f => f.name === atlas);
    if (root) {
      const names = (await listFolders(root.id)).map(f => f.name);
      const linked = new Set(sources.map(s => s.label));
      const missing = names.filter(n => !linked.has(n));
      notLinked = `Folders inside "${atlas}" that are NOT linked, so not read (Mobius can still open any of them when asked): ${missing.length ? missing.join(', ') : 'none'}. Loose files directly inside "${atlas}" are not read either.`;
    }
  } catch { /* no Google connection: say nothing about it */ }
  let space = '';
  try { const r = await storageReport(); space = `The database is ${r.percent}% full; indexing of new files stops at 85%, because the free plan is small.`; } catch { /* ignore */ }
  return [
    `Linked Drive folders and what has been read from each (exact figures; a folder is synced once a day, newest files first, files over 25 MB are skipped, and summaries are written gradually in the background):`,
    ...(lines.length ? lines : ['- (no folder is linked)']),
    notLinked, space,
  ].filter(Boolean).join('\n');
}