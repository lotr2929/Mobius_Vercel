/* render.js — turning a reply into the HTML shown in the chat.
 *  1. Markdown, by `marked` (vendor/marked.min.js): nested lists, numbering that carries on from item to item, tables, code.
 *     Raw HTML in a reply is shown as text and only web, mail and in-page links are kept, so a reply cannot inject anything.
 *  2. Bible references (Mark 1:2-4, Psalm 23, 1 Cor 13:4-7 …) get a dashed underline. A click opens the passage in a small
 *     pop-up (World English Bible or King James, exactly as stored on the server); a click anywhere else closes it. */
(function () {
  'use strict';
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  if (window.marked) {
    window.marked.use({
      gfm: true, breaks: true,
      renderer: {
        html(h) { return esc(typeof h === 'string' ? h : (h && h.text) || ''); },
        link(href, title, text) {
          const h = String(href || '');
          if (!/^(https?:\/\/|mailto:|#|\/)/i.test(h)) return text;
          return '<a href="' + esc(h) + '"' + (title ? ' title="' + esc(title) + '"' : '') + ' target="_blank" rel="noopener">' + text + '</a>';
        },
        image(href, title, text) { return esc(text || ''); },
      },
    });
  }

  // ── Underlining references ─────────────────────────────────────────────────
  function decorate(root) {
    const S = window.MobiusScripture;
    if (!S || !root) return;
    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        if (!/\d/.test(n.nodeValue)) return NodeFilter.FILTER_REJECT;
        const p = n.parentElement;
        return p && p.closest('code,pre,a,button,textarea,.scripture') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      },
    });
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      const text = node.nodeValue;
      // a bare chapter is only taken as a reference for the Psalms ("Psalm 23"); anything else needs a verse
      const refs = S.extractRefs(text, { chapterOnlyOk: true }).filter(r => !r.chapterOnly || r.book === 19);
      if (!refs.length) continue;
      const frag = document.createDocumentFragment();
      let at = 0;
      for (const r of refs) {
        if (r.start < at) continue;
        frag.append(text.slice(at, r.start));
        const sp = document.createElement('span');
        sp.className = 'scripture'; sp.dataset.ref = r.text; sp.tabIndex = 0; sp.setAttribute('role', 'button'); sp.title = 'Click to read this passage';
        sp.textContent = r.text;
        frag.append(sp);
        at = r.end;
      }
      frag.append(text.slice(at));
      node.replaceWith(frag);
    }
  }

  function decorateHtml(html) {
    if (!window.MobiusScripture) return html;
    const t = document.createElement('template');
    t.innerHTML = html;
    decorate(t.content);
    return t.innerHTML;
  }

  function mdToHtml(text) {
    if (!text) return '';
    let html;
    try { html = window.marked.parse(String(text)); } catch (e) { html = '<p>' + esc(text) + '</p>'; }
    return decorateHtml(html);
  }

  // ── The pop-up ─────────────────────────────────────────────────────────────
  let pop = null, popFor = null;
  const cache = new Map();
  const pref = () => { try { return localStorage.getItem('mobiusBibleTr') || 'WEB'; } catch (e) { return 'WEB'; } };
  const remember = t => { try { localStorage.setItem('mobiusBibleTr', t); } catch (e) { /* private mode: fine */ } };

  function load(ref, tr) {
    const key = tr + '|' + ref;
    if (!cache.has(key)) {
      cache.set(key, fetch('/api/bible?ref=' + encodeURIComponent(ref) + '&t=' + tr).then(r => r.json())
        .then(d => { if (d.error && !d.label) cache.delete(key); return d; })
        .catch(() => { cache.delete(key); return { error: 'The passage could not be loaded (are you offline?).' }; }));
    }
    return cache.get(key);
  }

  function place(el) {
    if (!pop) return;
    const r = el.getBoundingClientRect(), vw = window.innerWidth, vh = window.innerHeight;
    const w = Math.min(520, vw - 16);
    pop.style.width = w + 'px';
    pop.style.left = Math.max(8, Math.min(r.left, vw - w - 8)) + 'px';
    const below = vh - r.bottom - 14, above = r.top - 14;
    if (below >= 220 || below >= above) {
      pop.style.top = (r.bottom + 6) + 'px'; pop.style.bottom = 'auto'; pop.style.maxHeight = Math.max(150, Math.min(below, 460)) + 'px';
    } else {
      pop.style.bottom = (vh - r.top + 6) + 'px'; pop.style.top = 'auto'; pop.style.maxHeight = Math.max(150, Math.min(above, 460)) + 'px';
    }
  }

  function closePassage() { if (pop) { pop.remove(); pop = null; popFor = null; } }

  async function showPassage(el) {
    if (popFor === el) { closePassage(); return; }
    closePassage();
    popFor = el;
    const mine = document.createElement('div');
    mine.className = 'scripture-pop';
    mine.textContent = 'Loading…';
    document.body.appendChild(mine);
    pop = mine;
    place(el);
    const ref = el.dataset.ref;
    const paint = async tr => {
      const data = await load(ref, tr);
      if (pop !== mine) return; // closed or replaced while loading
      mine.replaceChildren();
      const head = document.createElement('div'); head.className = 'sp-head';
      const title = document.createElement('b'); title.textContent = data.label || ref; head.append(title);
      const sw = document.createElement('span'); sw.className = 'sp-tr';
      for (const t of ['WEB', 'KJV']) {
        const b = document.createElement('button'); b.type = 'button'; b.textContent = t; if (t === tr) b.className = 'on';
        b.addEventListener('click', ev => { ev.stopPropagation(); remember(t); paint(t); });
        sw.append(b);
      }
      head.append(sw); mine.append(head);
      const body = document.createElement('div'); body.className = 'sp-body';
      if (data.error) body.textContent = data.error;
      else {
        const multi = new Set(data.verses.map(v => v.chapter)).size > 1;
        for (const v of data.verses) {
          const line = document.createElement('div'), n = document.createElement('b');
          n.textContent = (multi ? v.chapter + ':' : '') + v.verse + ' ';
          line.append(n, v.text); body.append(line);
        }
        if (data.cut) { const c = document.createElement('div'); c.className = 'sp-foot'; c.textContent = '…' + data.cut + ' more verse' + (data.cut === 1 ? '' : 's') + ' not shown.'; body.append(c); }
        const foot = document.createElement('div'); foot.className = 'sp-foot';
        foot.textContent = (data.name || data.translation) + ', public domain' + (data.partial ? '. A lettered verse (such as 4b) is shown whole.' : '');
        body.append(foot);
      }
      mine.append(body);
      place(el);
    };
    paint(pref());
  }

  document.addEventListener('click', e => {
    const t = e.target.closest && e.target.closest('.scripture');
    if (t) { e.preventDefault(); showPassage(t); return; }
    if (pop && !pop.contains(e.target)) closePassage();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closePassage();
    else if (e.key === 'Enter' && e.target.classList && e.target.classList.contains('scripture')) { e.preventDefault(); showPassage(e.target); }
  });
  window.addEventListener('resize', closePassage);
  const feed = document.getElementById('feed');
  if (feed) feed.addEventListener('scroll', closePassage, { passive: true });

  window.mdToHtml = mdToHtml;
  window.decorateScripture = decorate;
})();
