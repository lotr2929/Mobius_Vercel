
// docs/library.js — Boon's library: the folders he has marked as shelves (mobius_sources.library), used when he talks theology.
// Search finds a passage at a time; a conversation with a library needs more: Mobius should know WHAT it holds (the shelf:
// one line per book, from the digests written in advance) and be handed the passages of those books that bear on the
// question, each with its neighbours and its book's name, so that it can say where a point comes from and set the author's
// argument beside its own view. Only open shelves are used; a private shelf (sensitivity = 'private') is never offered here.
import { supabase } from '../db.js';
import { embedQuery } from '../pcm/embed.js';
import { toOrQuery } from '../util.js';
import { docDigests } from './digest.js';

// A message is "theology" if it uses a strong term, or two ordinary ones. Boon's own term "Scriptura Fidelium" counts.
const STRONG = /\b(theolog\w*|doctrin\w*|dogma\w*|scripture\w*|bibl(?:e|ical)|gospels?|testament|trinit\w*|christ\w*|jesus|resurrection|incarnation|atonement|salvation|redemption|sacrament\w*|liturg\w*|creeds?|anglican\w*|catholic\w*|protestant\w*|reformation|orthodoxy|heresy|eucharist|baptism|exegesis|hermeneutic\w*|patristic\w*|theodicy|monotheis\w*|scriptura fidelium|tillich|barth|aquinas|augustine|merton|hooker|chapman|armstrong)\b/i;
const WEAK = /\b(god|gods|faith|grace|sin|sins|heaven|hell|prayer|worship|church|churches|prophet\w*|apostle\w*|paul|luther|calvin|judaism|jewish|islam|muslim|mystic\w*|contemplat\w*|divine|holy|sacred|soul|eternal|providence|evil|suffering|axial|torah|psalms?|canon|sermon|clergy|priest|bishop|spiritual\w*|religio\w*)\b/gi;
const ASKS_LIBRARY = /\b(?:my|the) (?:library|shelf|shelves)\b|\bin (?:my|the) books\b/i;

export function isTheology(text) {
  const t = String(text || '');
  if (STRONG.test(t) || ASKS_LIBRARY.test(t)) return true;
  return new Set((t.match(WEAK) || []).map(w => w.toLowerCase())).size >= 2;
}

const titleOf = filename => filename.split('/').pop().replace(/\.(pdf|docx?|txt|md)$/i, '').replace(/\s*[(\[](?:z[- ]?library|z-lib\.org|pdfdrive|libgen)[)\]]/gi, '').replace(/\s+/g, ' ').trim();

export async function libraryShelves() {
  if (!supabase) return [];
  const { data } = await supabase.from('mobius_sources').select('id, label').eq('library', true).eq('sensitivity', 'open');
  return data || [];
}

let shelfMemo = { at: 0, text: '', books: 0 };
// One line per book: its title and the opening of its digest (what it is and what it argues).
async function shelfText(shelves) {
  if (Date.now() - shelfMemo.at < 10 * 60e3 && shelfMemo.text) return shelfMemo;
  const lines = [];
  for (const s of shelves) {
    const digests = await docDigests({ folder: s.label });
    const digested = new Set(digests.map(d => d.filename));
    for (const d of digests) {
      const gist = d.content.replace(/\s+/g, ' ').slice(0, 430).replace(/\s+\S*$/, '');
      lines.push(`- ${titleOf(d.filename)}: ${gist} …`);
    }
    // books read but not yet digested are still on the shelf, listed by title only
    const { data: files } = await supabase.from('mobius_docs_full').select('filename').like('filename', s.label.replace(/[\\%_]/g, m => '\\' + m) + '/%');
    for (const f of files || []) if (!digested.has(f.filename)) lines.push(`- ${titleOf(f.filename)} (not yet digested)`);
  }
  shelfMemo = { at: Date.now(), text: lines.join('\n'), books: lines.length };
  return shelfMemo;
}

// A short passage (600 characters, overlapping its neighbours by 100) is widened by the chunk before and after it. A shelf
// passage of 1,800 characters (docs/store.js LIBRARY_CHUNK) is already a paragraph or two, and is used as it stands.
async function widen(hits) {
  const small = hits.filter(h => h.chunk.length <= 1200);
  const ids = [...new Set(small.flatMap(h => [h.id - 1, h.id, h.id + 1]))];
  const { data } = ids.length ? await supabase.from('mobius_docs').select('id, filename, chunk').in('id', ids) : { data: [] };
  const byId = new Map((data || []).map(r => [r.id, r]));
  const used = new Set();
  const out = [];
  for (const h of hits) {
    if (used.has(h.id)) continue;
    if (h.chunk.length > 1200) { used.add(h.id); out.push({ filename: h.filename, text: h.chunk.replace(/\s+/g, ' ').trim() }); continue; }
    const win = [h.id - 1, h.id, h.id + 1].map(i => byId.get(i)).filter(r => r && r.filename === h.filename);
    win.forEach(r => used.add(r.id));
    const text = win.map((r, i) => (i === 0 ? r.chunk : r.chunk.slice(100))).join('').replace(/\s+/g, ' ').trim();
    out.push({ filename: h.filename, text });
  }
  return out;
}

// The author's surname as it appears in a file name: "(Paul Tillich)" → tillich, "(Bray, Gerald)" → bray, "by C. Fred Alford" → alford.
function surnameOf(filename) {
  const base = filename.split('/').pop().replace(/\.[a-z]+$/i, '');
  const tags = [...base.matchAll(/\(([^)]*)\)/g)].map(m => m[1]).filter(t => !/z[- ]?lib|pdfdrive|libgen/i.test(t));
  const who = tags.at(-1) || (base.match(/\bby ([A-Z][\w. ]+?)(?: \(|$)/) || [])[1] || '';
  const name = who.includes(',') ? who.split(',')[0] : who.trim().split(/\s+/).at(-1);
  return (name || '').toLowerCase().replace(/[^a-z]/g, '');
}

// → { shelf, passages, books, hits } or null when no shelf is marked or nothing is held
// Passages are spread across the books: at most 3 from any one book, and when the question names an author on the shelf
// ("does Armstrong see it differently?") that author's book is searched on its own, so one strong match cannot crowd the others out.
export async function libraryContext(query, { max = 6, noEmbed = false } = {}) {
  const shelves = await libraryShelves();
  if (!shelves.length) return null;
  const [shelf, embedding] = await Promise.all([shelfText(shelves), noEmbed ? null : embedQuery(query).catch(() => null)]);
  const search = async (prefix, n) => (await supabase.rpc('pcm_search_library', { query_text: toOrQuery(query), query_embedding: embedding, shelf_prefix: prefix, match_count: n })).data || [];
  const q = query.toLowerCase();
  const found = new Map();
  for (const s of shelves) {
    for (const h of await search(s.label + '/', max * 3)) found.set(h.id, h);
    const { data: files } = await supabase.from('mobius_docs_full').select('filename').like('filename', s.label.replace(/[\\%_]/g, m => '\\' + m) + '/%');
    for (const f of files || []) {
      const sn = surnameOf(f.filename);
      if (sn.length >= 4 && q.includes(sn)) for (const h of await search(f.filename, 4)) found.set(h.id, h); // that book alone
    }
  }
  const perBook = new Map(), top = [];
  for (const h of [...found.values()].sort((a, b) => b.score - a.score)) {
    if ((perBook.get(h.filename) || 0) >= 3) continue;
    perBook.set(h.filename, (perBook.get(h.filename) || 0) + 1);
    top.push(h);
    if (top.length >= max) break;
  }
  const wide = top.length ? await widen(top) : [];
  const passages = wide.map(p => `[${titleOf(p.filename)}] …${p.text}…`).join('\n\n');
  return { shelf: shelf.text, passages, books: shelf.books, hits: wide.length, labels: shelves.map(s => s.label) };
}
