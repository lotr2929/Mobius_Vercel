/* scripture.js — recognising Bible references in text.
 * One file, used twice: the browser loads it as a plain script (to underline references in the chat, so that a click
 * shows the passage), and the server imports it for the same reading of references (backend/bible.js).
 * It only reads references; the words of the Bible come from the table mobius_bible, never from here. */
(function () {
  'use strict';
  const NAMES = [
    'Genesis|gen,gn', 'Exodus|exod,exo,ex', 'Leviticus|lev,lv', 'Numbers|num,nm', 'Deuteronomy|deut,dt,deu', 'Joshua|josh,jos',
    'Judges|judg,jdg,jg', 'Ruth|rut', '1 Samuel|1sam,1sa,1sm,isamuel,firstsamuel', '2 Samuel|2sam,2sa,2sm,iisamuel,secondsamuel',
    '1 Kings|1kgs,1ki,1kin,ikings,firstkings', '2 Kings|2kgs,2ki,2kin,iikings,secondkings', '1 Chronicles|1chr,1ch,ichronicles,firstchronicles', '2 Chronicles|2chr,2ch,iichronicles,secondchronicles',
    'Ezra|ezr', 'Nehemiah|neh', 'Esther|esth,est', 'Job|jb', 'Psalms|psalm,ps,pss,psa,psm', 'Proverbs|prov,prv',
    'Ecclesiastes|eccl,eccles,ecc,qoheleth', 'Song of Solomon|songofsongs,songofsol,song,sos,ss,canticles,canticleofcanticles', 'Isaiah|isa', 'Jeremiah|jer',
    'Lamentations|lam', 'Ezekiel|ezek,eze,ezk', 'Daniel|dan,dn', 'Hosea|hos', 'Joel|joe,jl', 'Amos|amo', 'Obadiah|obad,ob', 'Jonah|jon,jnh',
    'Micah|mic', 'Nahum|nah', 'Habakkuk|hab,hb', 'Zephaniah|zeph,zep,zp', 'Haggai|hag,hg', 'Zechariah|zech,zec,zc', 'Malachi|mal,ml',
    'Matthew|matt,mat,mt', 'Mark|mrk,mk,mr', 'Luke|luk,lk', 'John|joh,jhn,jn', 'Acts|act,actsoftheapostles', 'Romans|rom,rm',
    '1 Corinthians|1cor,1co,icorinthians,firstcorinthians', '2 Corinthians|2cor,2co,iicorinthians,secondcorinthians', 'Galatians|gal,ga', 'Ephesians|eph,ephes',
    'Philippians|phil,php,pp', 'Colossians|col', '1 Thessalonians|1thess,1thes,1th,ithessalonians,firstthessalonians', '2 Thessalonians|2thess,2thes,2th,iithessalonians,secondthessalonians',
    '1 Timothy|1tim,1ti,itimothy,firsttimothy', '2 Timothy|2tim,2ti,iitimothy,secondtimothy', 'Titus|tit', 'Philemon|philem,phm,pm', 'Hebrews|heb',
    'James|jas,jm', '1 Peter|1pet,1pe,1pt,ipeter,firstpeter', '2 Peter|2pet,2pe,2pt,iipeter,secondpeter', '1 John|1jn,1jo,ijohn,firstjohn', '2 John|2jn,2jo,iijohn,secondjohn',
    '3 John|3jn,3jo,iiijohn,thirdjohn', 'Jude|jud,jd', 'Revelation|rev,rv,revelationofjohn,apocalypse',
  ];
  const BOOKS = NAMES.map((s, i) => { const [name, alias] = s.split('|'); return { n: i + 1, name, keys: [name.toLowerCase().replace(/[^a-z0-9]/g, ''), ...alias.split(',')] }; });
  const KEY = new Map();
  for (const b of BOOKS) for (const k of b.keys) if (!KEY.has(k)) KEY.set(k, b.n);
  const bookNumber = text => KEY.get(String(text).toLowerCase().replace(/[^a-z0-9]/g, '')) || null;
  const bookName = n => BOOKS[n - 1] && BOOKS[n - 1].name;
  const display = n => (n === 19 ? 'Psalm' : bookName(n));

  const DASH = '[-\u2013\u2014]';
  const REF_SOURCE = (
    '(?<![A-Za-z0-9])(?<num>[1-3]|III|II|I|First|Second|Third)?\\.?\\s*(?<name>[A-Za-z]+(?:\\s+of\\s+(?:Songs|Solomon|John|the\\s+Apostles))?)\\.?\\s*(?<ch>\\d{1,3})' +
    '(?:\\s*:\\s*(?<v1>\\d{1,3})(?<s1>[a-c])?(?:\\s*' + DASH + '\\s*(?:(?<c2>\\d{1,3})\\s*:\\s*)?(?<v2>\\d{1,3})(?<s2>[a-c])?)?' +
    '(?<more>(?:\\s*[,;]\\s*(?:\\d{1,3}\\s*:\\s*)?\\d{1,3}[a-c]?(?:\\s*' + DASH + '\\s*(?:\\d{1,3}\\s*:\\s*)?\\d{1,3}[a-c]?)?(?!\\d)(?!\\s*:)(?!\\s*[A-Za-z]{2,}))*))?');
  const numKey = n => ({ i: '1', ii: '2', iii: '3', first: '1', second: '2', third: '3' }[String(n).toLowerCase()] || n);

  // → [{ book, ranges: [{ c1, v1, c2, v2 }], partial, chapterOnly, label, text, start, end }]
  // (v2 = Infinity means "to the end of the chapter"; start/end are the positions of the reference in the text.)
  // Without chapterOnlyOk, "Psalm 23" alone is not taken as a reference (words like "job 5 years" would be).
  function extractRefs(text, opts) {
    const chapterOnlyOk = !!(opts && opts.chapterOnlyOk);
    const out = [];
    const re = new RegExp(REF_SOURCE, 'gi');
    const str = String(text || '');
    let m;
    while ((m = re.exec(str))) {
      const g = m.groups;
      const nm = g.name.replace(/\s+of\s+/i, 'of');
      const book = bookNumber((g.num ? numKey(g.num) : '') + nm) || bookNumber((g.num || '') + nm);
      if (!book) { re.lastIndex = m.index + 1; continue; }
      const hasVerse = g.v1 != null;
      if (!hasVerse && !chapterOnlyOk) { re.lastIndex = m.index + m[0].length; continue; }
      const ch = +g.ch;
      const ranges = [];
      let partial = !!(g.s1 || g.s2);
      if (!hasVerse) ranges.push({ c1: ch, v1: 1, c2: ch, v2: Infinity });
      else {
        const c2 = g.c2 ? +g.c2 : ch;
        ranges.push({ c1: ch, v1: +g.v1, c2, v2: g.v2 ? +g.v2 : (g.c2 ? Infinity : +g.v1) });
        const parts = String(g.more || '').split(/[,;]/).map(s => s.trim()).filter(Boolean);
        let cur = c2; // the chapter in force; "; 2:1-4" moves to chapter 2
        for (const part of parts) {
          const mm = part.match(/^(?:(\d{1,3})\s*:\s*)?(\d{1,3})([a-c])?(?:\s*[-\u2013\u2014]\s*(?:(\d{1,3})\s*:\s*)?(\d{1,3})([a-c])?)?$/);
          if (!mm) continue;
          if (mm[3] || mm[6]) partial = true;
          const cs = mm[1] ? +mm[1] : cur, ce = mm[4] ? +mm[4] : cs;
          ranges.push({ c1: cs, v1: +mm[2], c2: ce, v2: mm[5] ? +mm[5] : +mm[2] });
          cur = ce;
        }
      }
      const spec = ranges.map(r => (r.v2 === Infinity && r.v1 === 1 ? '' + r.c1 : r.c1 === r.c2
        ? (r.v1 === r.v2 ? r.c1 + ':' + r.v1 : r.c1 + ':' + r.v1 + '\u2013' + (r.v2 === Infinity ? 'end' : r.v2))
        : r.c1 + ':' + r.v1 + '\u2013' + r.c2 + ':' + (r.v2 === Infinity ? 'end' : r.v2)));
      // later ranges in the same chapter are written without repeating the chapter: "105:1–11, 45"
      const label = display(book) + ' ' + spec.map((s, i) => (i > 0 && ranges[i].c1 === ranges[0].c2 && s.indexOf(ranges[i].c1 + ':') === 0 ? s.slice(String(ranges[i].c1).length + 1) : s)).join(', ');
      const lead = m[0].length - m[0].replace(/^\s+/, '').length;
      const shown = m[0].trim();
      out.push({ book, ranges, partial, chapterOnly: !hasVerse, label, text: shown, start: m.index + lead, end: m.index + lead + shown.length });
    }
    return out;
  }

  globalThis.MobiusScripture = { BOOKS, bookNumber, bookName, display, extractRefs };
})();
