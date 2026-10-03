/* Testside — app shell: library, import review, test runner, results. */
(function () {
  'use strict';
  const TS = window.TS;
  const P = TS.parser;
  const root = document.getElementById('app');
  const KN = P.KIND_NAMES;
  const CROP_SCALE = 1.8; // CSS px per PDF point at 100% zoom (10pt body text ≈ 18px)

  // ================= helpers =================
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'html') el.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    return el;
  }
  const svg = (d, s = 22, extra = '') => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${extra}>${d}</svg>`;
  const I = {
    left: (s) => svg('<path d="M19 12H5"/><path d="M11 6l-6 6 6 6"/>', s || 26, 'stroke-width="2.6"'),
    right: (s) => svg('<path d="M5 12h14"/><path d="M13 6l6 6-6 6"/>', s || 26, 'stroke-width="2.6"'),
    list: (s) => svg('<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>', s),
    flag: (s) => svg('<path d="M6 3h12v18l-6-4.5L6 21z"/>', s),
    flagOn: (s) => svg('<path d="M6 3h12v18l-6-4.5L6 21z" fill="#d97706" stroke="#b45309"/>', s),
    pointer: (s) => svg('<path d="M5 3l14 8-6.5 1.5L9 19z" fill="currentColor"/>', s || 20),
    elim: (s) => svg('<circle cx="12" cy="12" r="8.5"/><path d="M8.5 8.5l7 7M15.5 8.5l-7 7"/>', s || 21),
    hl: (s) => svg('<path d="M15 4l5 5-9 9H6v-5z"/><path d="M4 21h16" stroke-width="3" stroke="#e8b800"/>', s || 21),
    reader: (s) => svg('<rect x="3" y="4" width="18" height="4" rx="1" fill="currentColor" opacity=".35" stroke="none"/><rect x="3" y="10" width="18" height="4" rx="1"/><rect x="3" y="16" width="18" height="4" rx="1" fill="currentColor" opacity=".35" stroke="none"/>', s || 21),
    calc: (s) => svg('<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 7h8M8 11h2M12 11h0M16 11h0M8 15h0M12 15h0M16 15v3M8 18h4"/>', s || 21),
    user: (s) => svg('<circle cx="12" cy="8" r="4" fill="currentColor"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7z" fill="currentColor"/>', s || 20) + svg('<path d="M7 10l5 5 5-5" fill="currentColor"/>', 14),
    upload: (s) => svg('<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v3a2 2 0 002 2h12a2 2 0 002-2v-3"/>', s || 34),
    check: (s) => svg('<path d="M5 12l5 5L20 7"/>', s || 18),
    book: (s) => svg('<path d="M4 5a2 2 0 012-2h13v16H6a2 2 0 00-2 2z"/><path d="M4 19V5"/>', s || 22),
    close: (s) => svg('<path d="M6 6l12 12M18 6L6 18"/>', s || 18),
  };
  const fmt = (sec) => {
    sec = Math.max(0, Math.round(sec));
    const hh = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return hh ? `${hh}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };
  const fmtMin = (m) => (Number.isInteger(m) ? `${m}` : m.toFixed(1).replace(/\.0$/, '')) + ' min';
  const dateStr = (t) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  let toastTimer = null;
  function toast(msg, cls = '', ms = 3800) {
    document.querySelectorAll('.toast').forEach((t) => t.remove());
    const t = h('div', { class: `toast ${cls}` }, msg);
    document.body.append(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.remove(), ms);
  }
  function modal({ title, text, body, buttons }) {
    return new Promise((resolve) => {
      const bg = h('div', { class: 'modal-bg' });
      const close = (v) => { bg.remove(); resolve(v); };
      bg.append(h('div', { class: 'modal', role: 'dialog' },
        h('h3', null, title),
        text ? h('p', null, text) : null,
        body || null,
        h('div', { class: 'acts' }, (buttons || [{ label: 'OK', value: true, primary: true }]).map((b) =>
          h('button', { class: `btn ${b.primary ? 'primary' : ''} ${b.danger ? 'danger' : ''}`, onclick: () => close(b.value) }, b.label)))));
      document.body.append(bg);
      const p = bg.querySelector('.btn.primary');
      if (p) p.focus();
    });
  }

  // ================= text rendering =================
  // "(lines 23–24)", "in lines 5–7": meaningless without booklet line numbers
  const stripRefs = (t) => t
    .replace(/\s*\((?:see\s+)?lines?\s+\d+(?:\s*(?:[–—-]|to|through|and|,)\s*\d+)*\)/gi, '')
    .replace(/,?\s+(?:in|at|from|of)\s+lines?\s+\d+(?:\s*(?:[–—-]|to|through|and)\s*\d+)*/gi, '');
  function renderRuns(runs, parent, noRefs) {
    if (noRefs) {
      runs = runs.map((r) => (r.s && !r.t ? { ...r, s: stripRefs(r.s) } : r));
      // no space left dangling before punctuation where a reference was removed
      for (let i = 0; i < runs.length; i++) {
        const r = runs[i];
        if (!r.s || r.t) continue;
        r.s = r.s.replace(/\s+([?.,;:!])/g, '$1');
        const next = runs.slice(i + 1).find((x) => x.s && !x.t);
        if (next && /^\s*[?.,;:!]/.test(next.s) && /\s$/.test(r.s)) { r.s = r.s.replace(/\s+$/, ''); next.s = next.s.replace(/^\s+/, ''); }
      }
    }
    const base = parent;
    for (const r of runs) {
      // each booklet line becomes a span (invisible), so a question can highlight "lines 26–45"
      if (r.t === 'ln') { const sp = h('span', { class: 'lr', 'data-ln': r.n }); base.append(sp); parent = sp; continue; }
      if (r.t === 'm') {
        parent.append(h('button', { class: 'qbox', 'data-q': r.n, 'data-nohl': '', type: 'button', tabindex: '-1', title: `Question ${r.n}` }, String(r.n)));
        continue;
      }
      let node = document.createTextNode(r.s);
      const wrap = (tag) => { const e = document.createElement(tag); e.append(node); node = e; };
      if (r.sub) wrap('sub');
      if (r.sup) wrap('sup');
      if (r.i) wrap('i');
      if (r.b) wrap('b');
      if (r.u != null) { const s = h('span', { class: 'u', 'data-q': r.u }); s.append(node); node = s; }
      parent.append(node);
    }
  }
  const textRuns = (runs) => runs.filter((r) => !r.t && r.s);
  function joinLines(lines, lnums) {
    const out = [];
    lines.forEach((l, k) => {
      const runs = l.runs.map((r) => ({ ...r }));
      if (lnums && l._ln) runs.unshift({ t: 'ln', n: l._ln });
      if (k > 0 && runs.length) {
        const prevT = textRuns(out).slice(-1)[0];
        const nextT = textRuns(runs)[0];
        if (prevT && nextT) {
          const endsHy = /[A-Za-z]-$/.test(prevT.s) && /^[a-z]/.test(nextT.s);
          const lastWord = (prevT.s.match(/(\S+)$/) || ['', ''])[1];
          if (endsHy && !/-.*-$/.test(lastWord)) {
            // rejoin the hyphenated word inside the earlier line, so line highlights cover whole words
            prevT.s = prevT.s.slice(0, -1);
            const frag = (nextT.s.match(/^[^\s]+/) || [''])[0];
            prevT.s += frag;
            nextT.s = nextT.s.slice(frag.length);
            if (nextT.s.trim() || runs.some((r) => r !== nextT && !r.t && r.s && r.s.trim())) { prevT.s += ' '; nextT.s = nextT.s.replace(/^\s+/, ''); }
          }
          else if (endsHy || /[—–]$/.test(prevT.s) || /^[—–]/.test(nextT.s)) { /* join tight */ }
          else if (!/\s$/.test(prevT.s) && !/^\s/.test(nextT.s)) {
            const u = prevT.u != null && prevT.u === nextT.u ? prevT.u : undefined;
            out.push({ s: ' ', u });
          }
        }
      }
      out.push(...runs);
    });
    return out;
  }
  function renderBlocks(blocks, opt = {}) {
    const frag = document.createDocumentFragment();
    const scale = CROP_SCALE * (opt.zoom || 1);
    for (const b of blocks || []) {
      if (b.t === 'fig') {
        const w = h('div', { class: 'fig', 'data-nohl': '' });
        w.append(TS.render.img(b, scale * (opt.figScale || 1)));
        frag.append(w);
        continue;
      }
      const text = b.lines.map((l) => textRuns(l.runs).map((r) => r.s).join('')).join(' ');
      const cls = ['p'];
      if (b.indent) cls.push('indent');
      if (b.heading && !opt.noHeadings) cls.push('h');
      if (b.pnum) cls.push('pnum');
      if (b.bullet) cls.push('bullet');
      if (/ask(s)? about the preceding passage|asks? about the passage as a whole/i.test(text)) cls.push('qnote');
      const div = h('div', { class: cls.join(' ') });
      if (opt.lines) {
        for (const l of b.lines) {
          const ln = h('div', { class: 'ln', 'data-ln': l._ln || null });
          if (l.num && opt.lnums) ln.append(h('span', { class: 'lnum', 'data-nohl': '' }, String(l.num)));
          renderRuns(l.runs, ln);
          div.append(ln);
        }
      } else renderRuns(joinLines(b.lines, opt.lnums && opt.inlineNums), div, opt.noRefs);
      frag.append(div);
    }
    return frag;
  }

  // ================= highlights (offset ranges over eligible text) =================
  function textNodes(rootEl) {
    const out = [];
    const w = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement.closest('[data-nohl]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    while (w.nextNode()) out.push(w.currentNode);
    return out;
  }
  function pointOffset(rootEl, container, offset) {
    const r = document.createRange();
    r.setStart(container, offset); r.collapse(true);
    let total = 0;
    for (const tn of textNodes(rootEl)) {
      if (tn === container) return total + offset;
      if (r.comparePoint(tn, tn.length) <= 0) total += tn.length; else break;
    }
    return total;
  }
  function applyHL(rootEl, ranges) {
    rootEl.querySelectorAll('mark.hl').forEach((m) => m.replaceWith(...m.childNodes));
    rootEl.normalize();
    if (!ranges || !ranges.length) return;
    const nodes = textNodes(rootEl);
    let off = 0;
    const plan = [];
    for (const tn of nodes) {
      const len = tn.length, a = off, b = off + len;
      for (let k = 0; k < ranges.length; k++) {
        const [s, e, c] = ranges[k];
        const x = Math.max(s, a), y = Math.min(e, b);
        if (y > x) plan.push({ tn, from: x - a, to: y - a, c, k });
      }
      off = b;
    }
    // wrap from the end so earlier offsets stay valid
    for (let i = plan.length - 1; i >= 0; i--) {
      const { tn, from, to, c, k } = plan[i];
      if (!tn.parentNode) continue;
      let mid = tn;
      if (from > 0) mid = tn.splitText(from);
      if (to - from < mid.length) mid.splitText(to - from);
      const m = h('mark', { class: `hl ${c}`, 'data-k': k });
      mid.replaceWith(m);
      m.append(mid);
    }
  }
  function addRange(list, s, e, c) {
    const out = [];
    for (const [a, b, cc] of list) {
      if (b <= s || a >= e) { out.push([a, b, cc]); continue; }
      if (a < s) out.push([a, s, cc]);
      if (b > e) out.push([e, b, cc]);
    }
    out.push([s, e, c]);
    return out.sort((x, y) => x[0] - y[0]);
  }

  // ================= Library =================
  async function showLibrary() {
    stopRunner();
    document.title = 'Testside — digital ACT practice';
    const prefs = TS.prefs.get();
    const tests = (await TS.store.listTests()).sort((a, b) => b.created - a.created);
    const attempts = await TS.store.listAttempts();
    const fileIn = h('input', { type: 'file', accept: 'application/pdf,.pdf', class: 'hidden', onchange: (e) => e.target.files[0] && importFile(e.target.files[0]) });
    const drop = h('div', { class: 'drop', tabindex: '0', onclick: () => fileIn.click(), onkeydown: (e) => { if (e.key === 'Enter') fileIn.click(); } },
      h('div', { class: 'ico', html: I.upload() }),
      h('h2', null, 'Import an ACT test PDF'),
      h('p', null, 'A full booklet or a single section. Testside finds the sections, passages, questions and the scoring key, then rebuilds them as an on-screen test.'),
      h('p', { style: { marginTop: '6px', fontSize: '13px', color: '#7b858c' } }, 'Drop the file here or click to choose. Everything stays in this browser.'));
    ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', (e) => { const f = e.dataTransfer.files[0]; if (f) importFile(f); });

    const nameIn = h('input', { type: 'text', value: prefs.name, style: { border: '1px solid #d4d9dc', borderRadius: '6px', padding: '6px 8px', width: '130px', font: 'inherit', fontSize: '14px' },
      onchange: (e) => TS.prefs.set({ name: e.target.value.trim() || 'Student' }) });

    const list = h('div');
    if (!tests.length) list.append(h('div', { class: 'empty' }, 'No tests yet. Import a PDF to get started.'));
    for (const t of tests) list.append(testCard(t, attempts.filter((a) => a.testId === t.id)));

    root.replaceChildren(h('div', { class: 'lib' },
      h('div', { class: 'lib-head' },
        h('div', { class: 'logo', html: I.book(24) }),
        h('div', null, h('h1', null, 'Testside'), h('p', null, 'Practice ACT sections the way they appear on test day.')),
        h('div', { class: 'spacer' }),
        h('label', { style: { fontSize: '13px', color: '#4a545b', display: 'flex', gap: '8px', alignItems: 'center' } }, 'Name on screen', nameIn)),
      drop, fileIn, list,
      h('div', { class: 'foot' },
        h('div', null, 'Runs entirely in your browser: PDFs, answers and highlights are saved locally (IndexedDB) and never uploaded.'),
        h('div', null, 'Keyboard: ', h('kbd', null, 'Alt'), ' + ', h('kbd', null, '→'), ' / ', h('kbd', null, '←'), ' next/back · ', h('kbd', null, 'Alt'), ' + ', h('kbd', null, 'F'), ' flag · ', h('kbd', null, 'Alt'), ' + ', h('kbd', null, 'R'), ' review.'))));
  }

  function testCard(t, atts) {
    const secs = h('div', { class: 'secs' });
    t.sections.forEach((s, si) => {
      const scored = s.questions.filter((q) => !q.unscored).length;
      const inProg = atts.find((a) => a.si === si && !a.done);
      secs.append(h('div', { class: 'sec' },
        h('div', { class: 'k' }, h('span', { class: `dot ${s.kind}` }), s.title),
        h('div', { class: 'd' }, `${s.questions.length} questions · ${fmtMin(s.minutes)}`, scored !== s.questions.length ? ` · ${s.questions.length - scored} unscored` : ''),
        h('div', { class: 'row' }, s.keyCount === s.questions.length ? h('span', { class: 'pill ok' }, 'answer key ✓') : h('span', { class: 'pill warn' }, `key ${s.keyCount}/${s.questions.length}`)),
        h('div', { class: 'row' },
          inProg ? h('button', { class: 'btn primary small', onclick: () => startSection(t.id, si, { attemptId: inProg.id }) }, `Resume (${fmt(inProg.timed ? inProg.limit - inProg.elapsed : inProg.elapsed)} ${inProg.timed ? 'left' : 'used'})`)
            : h('button', { class: 'btn primary small', onclick: () => startSection(t.id, si, {}) }, 'Start'),
          h('button', { class: 'btn small', onclick: () => startSection(t.id, si, { preview: true }), title: 'Browse questions with answers shown' }, 'Preview'))));
    });
    const hist = h('div', { class: 'hist' });
    const done = atts.filter((a) => a.done).sort((a, b) => b.finishedAt - a.finishedAt);
    if (done.length) {
      hist.append(h('div', { style: { fontWeight: 700, marginBottom: '4px' } }, 'History'));
      for (const a of done.slice(0, 8)) {
        const s = t.sections[a.si];
        hist.append(h('div', { class: 'hist-row' },
          h('span', { class: 'when' }, dateStr(a.finishedAt)),
          h('span', { class: `dot ${s.kind}`, style: { width: '8px', height: '8px', borderRadius: '50%', display: 'inline-block' } }),
          h('span', { style: { width: '100px' } }, s.title),
          h('span', { class: 'sc' }, a.score ? `${a.score.raw}/${a.score.total}` : '—'),
          h('span', { style: { color: '#7b858c' } }, a.timed ? `${fmt(a.elapsed)} of ${fmt(a.limit)}` : `untimed · ${fmt(a.elapsed)}`),
          h('span', { style: { flex: 1 } }),
          h('button', { class: 'btn small ghost', onclick: () => showResults(a.id) }, 'Results'),
          h('button', { class: 'btn small ghost danger', onclick: async () => { if (await modal({ title: 'Delete this attempt?', buttons: [{ label: 'Cancel', value: false }, { label: 'Delete', value: true, primary: true }] })) { await TS.store.deleteAttempt(a.id); showLibrary(); } } }, '✕')));
      }
    }
    return h('div', { class: 'card' },
      h('div', { class: 'card-head' },
        h('div', null, h('h3', null, t.title), h('div', { class: 'meta' }, `Imported ${dateStr(t.created)} · ${t.fileName || 'PDF'} · ${t.pageCount} pages`)),
        h('div', { class: 'spacer' }),
        (t.parserVersion || 0) < P.VERSION ? h('button', { class: 'btn small primary', title: 'The converter has improved since this test was imported. Re-convert it from the saved PDF (your attempts are kept).', onclick: () => updateTest(t) }, 'Update conversion') : null,
        t.sections.length > 1 ? h('button', { class: 'btn small', onclick: () => startFullTest(t.id) }, 'Full test') : null,
        h('button', { class: 'btn small', onclick: async () => {
          const inp = h('input', { type: 'text', value: t.title, style: { width: '100%', font: 'inherit', padding: '8px', border: '1px solid #d4d9dc', borderRadius: '6px' } });
          if (await modal({ title: 'Rename test', body: inp, buttons: [{ label: 'Cancel', value: false }, { label: 'Save', value: true, primary: true }] })) { t.title = inp.value.trim() || t.title; await TS.store.putTest(t); showLibrary(); }
        } }, 'Rename'),
        h('button', { class: 'btn small danger', onclick: async () => {
          if (await modal({ title: `Delete “${t.title}”?`, text: 'This removes the test, its PDF copy and all attempts from this browser.', buttons: [{ label: 'Cancel', value: false }, { label: 'Delete', value: true, primary: true }] })) { await TS.store.deleteTest(t.id); showLibrary(); }
        } }, 'Delete')),
      secs, hist);
  }

  // Re-convert a saved test with the current parser (same pages / OCR / keys as its import).
  async function updateTest(t) {
    const ui = progressCard(`Updating ${t.title}`);
    try {
      const bytes = await TS.store.testPdf(t);
      if (!bytes) throw new Error('The original PDF is no longer stored for this test — please import it again.');
      const cand = t.source && t.source.cand;
      let opts = {};
      if (cand || /Prep Guide|OceanofPDF/i.test(t.fileName || '')) {
        const idx = await P.scanPdf(bytes, (f, m) => ui.set(f * 0.4, m));
        const c = cand || idx.candidates.find((x) => x.label && t.title.includes(x.label)) || null;
        opts = { texts: idx.texts };
        if (c) {
          const pages = new Set();
          for (let p = c.start; p <= c.end; p++) pages.add(p);
          for (const p of c.keyPages || []) pages.add(p);
          for (const p of c.keyScans || []) pages.add(p);
          const ocr = [];
          if (c.scanned) for (let p = c.start; p <= c.end; p++) ocr.push(p);
          opts = { ...opts, pages: [...pages], ocr, expl: c.expl };
        }
      }
      const ctx = await P.analyzePdf(bytes, (f, m) => ui.set(0.4 + f * 0.6, m), opts);
      const saved = (t.source && t.source.rows) || null;
      const specs = saved ? saved.map((r) => r.spec) : ctx.detected.map((f) => ({ kind: f.kind, start: f.start, end: f.end, startY: f.startY, endY: f.endY, count: f.count }));
      const sections = [];
      specs.forEach((spec, i) => {
        const sec = P.buildSection(ctx, spec);
        const extra = saved && saved[i];
        if (extra && extra.minutes) sec.minutes = extra.minutes;
        if (extra && extra.keyText) applyKey(sec, extra.keyText);
        sections.push({ ...sec, warnings: undefined });
      });
      t.sections = sections;
      t.parserVersion = P.VERSION;
      t.source = { ...(t.source || {}), rows: specs.map((spec, i) => ({ spec, minutes: saved && saved[i] ? saved[i].minutes : null, keyText: saved && saved[i] ? saved[i].keyText : null })) };
      await TS.store.putTest(t);
      toast(`Updated “${t.title}”.`);
    } catch (e) { console.error(e); toast(e.message || String(e), 'warn', 6000); }
    showLibrary();
  }

  // ================= Import =================
  async function importFile(file) {
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
      toast(/\.epub$/i.test(file.name) ? 'EPUB files can’t be imported — use a PDF of the book or test.' : 'Please choose a PDF file.', 'warn', 5000);
      return;
    }
    const ui = progressCard(`Importing ${file.name}`);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const idx = await P.scanPdf(bytes, (f, m) => ui.set(f * 0.5, m));
      const cands = idx.candidates;
      const bookTitle = cleanTitle(file.name);
      if (cands.length > 1 || (cands[0] && cands[0].scanned)) { showChooser({ file, bytes, idx, bookTitle }); return; }
      const c = cands[0] || null;
      await runImport({ file, bytes, idx, cand: c, bookTitle, ui, allPages: true });
    } catch (e) { importError(e); }
  }
  function cleanTitle(name) {
    return name.replace(/\.pdf$/i, '').replace(/_OceanofPDF\.com_/i, '').replace(/\s+--\s+.*$/, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function progressCard(title) {
    const bar = h('i');
    const msg = h('div', { class: 'meta' }, 'Opening…');
    const tip = h('p', { class: 'meta', style: { marginTop: '10px', lineHeight: 1.5, display: 'none' } },
      'Keep this tab visible while the scanned pages are read — Chrome slows background tabs several times over. Progress also shows in the tab title.');
    const card = h('div', { class: 'card imp' }, h('h3', null, title), msg, h('div', { class: 'progress' }, bar), tip);
    root.replaceChildren(h('div', { class: 'lib' }, card));
    return { set: (f, m) => {
      if (!card.isConnected) return;
      bar.style.width = `${Math.round(f * 100)}%`;
      if (m) msg.textContent = m;
      if (m && /Recognizing/.test(m)) tip.style.display = '';
      document.title = f >= 1 ? 'Testside — digital ACT practice' : `${Math.round(f * 100)}% · importing — Testside`;
    } };
  }
  function importError(e) {
    console.error(e);
    document.title = 'Testside — digital ACT practice';
    root.replaceChildren(h('div', { class: 'lib' }, h('div', { class: 'card' },
      h('h3', null, 'Could not import this PDF'), h('p', { style: { color: '#4a545b', lineHeight: 1.55 } }, e.message || String(e)),
      h('button', { class: 'btn', onclick: showLibrary }, 'Back'))));
  }
  function showChooser(st) {
    document.title = 'Testside — digital ACT practice';
    const { idx } = st;
    const rows = idx.candidates.map((c, ci) => {
      const n = c.end - c.start + 1;
      const imported = st.done && st.done.has(ci);
      const keyInfo = c.keyPages.length ? 'answer key' : c.expl ? 'answers + explanations' : c.keyScans.length ? 'scanned key' : 'no key found';
      return h('tr', null,
        h('td', null, h('b', null, c.label || 'Test'), imported ? h('div', null, h('span', { class: 'pill ok' }, 'imported')) : null),
        h('td', null, `pages ${c.start}–${c.end}`, h('div', { class: 'meta' }, `${n} pages`)),
        h('td', null, c.scanned ? h('span', { class: 'pill warn' }, 'scanned') : h('span', { class: 'pill ok' }, 'text'),
          c.scanned ? h('div', { class: 'meta' }, `OCR ≈ ${Math.max(1, Math.round(n * 3.4 / (TS.ocr ? TS.ocr.WORKERS : 2) / 60))} min`) : c.kinds.length ? h('div', { class: 'meta' }, c.kinds.map((k) => KN[k]).join(', ')) : null),
        h('td', null, h('span', { class: `pill ${keyInfo === 'no key found' ? 'warn' : 'ok'}` }, keyInfo)),
        h('td', null, h('button', { class: `btn small ${imported ? '' : 'primary'}`, onclick: async () => {
          const ui = progressCard(`Importing ${c.label || 'test'} from ${st.bookTitle}`);
          try { await runImport({ ...st, cand: c, ui }); } catch (e) { importError(e); }
        } }, 'Import')));
    });
    root.replaceChildren(h('div', { class: 'lib' },
      h('div', { class: 'card imp' },
        h('h3', null, st.bookTitle),
        h('p', { class: 'meta', style: { lineHeight: 1.55, marginTop: '6px' } }, `${idx.numPages} pages. This file contains ${idx.candidates.length} test${idx.candidates.length === 1 ? '' : 's'}. Pick one to import — you can come back for the others. Scanned tests are read with on-device OCR (the first run downloads the OCR engine, ~10 MB).`),
        idx.candidates.length ? h('table', null, h('thead', null, h('tr', null, ['Test', 'Pages', 'Type', 'Answers', ''].map((x) => h('th', null, x)))), h('tbody', null, rows))
          : h('div', { class: 'empty' }, 'No tests found in this PDF.'),
        h('div', { style: { marginTop: '14px' } }, h('button', { class: 'btn', onclick: showLibrary }, st.done ? 'Done' : 'Cancel')))));
  }
  async function runImport({ file, bytes, idx, cand, bookTitle, ui, allPages, done }) {
    let opts = { texts: idx.texts };
    if (cand && !allPages) {
      const pages = new Set();
      for (let p = cand.start; p <= cand.end; p++) pages.add(p);
      for (const p of cand.keyPages) pages.add(p);
      for (const p of cand.keyScans) pages.add(p);
      const ocr = [];
      if (cand.scanned) for (let p = cand.start; p <= cand.end; p++) ocr.push(p);
      if (!cand.keyPages.length && !cand.expl) ocr.push(...cand.keyScans);
      opts = { ...opts, pages: [...pages], ocr, expl: cand.expl };
    } else if (cand) opts.expl = cand.expl;
    const ctx = await P.analyzePdf(bytes, (f, m) => ui.set(0.5 + f * 0.5, m), opts);
    ui.set(1, 'Building sections…');
    if (document.hidden) {
      document.title = '✓ Ready to review — Testside';
      document.addEventListener('visibilitychange', () => { document.title = 'Testside — digital ACT practice'; }, { once: true });
    }
    const rows = ctx.detected.map((f) => ({ spec: { kind: f.kind, start: f.start, end: f.end, startY: f.startY, endY: f.endY, minutes: null, count: f.count }, include: true }));
    if (!rows.length) rows.push({ spec: { kind: P.guessKind(ctx), start: cand ? cand.start : 1, end: cand ? cand.end : ctx.numPages }, include: true });
    for (const r of rows) build(ctx, r);
    const title = cand && cand.label && !allPages ? `${bookTitle} — ${cand.label}` : (ctx.title || bookTitle);
    const source = { cand: cand && !allPages ? { label: cand.label, start: cand.start, end: cand.end, scanned: cand.scanned, keyPages: cand.keyPages, keyScans: cand.keyScans, expl: cand.expl } : null };
    const book = cand && !allPages ? { file, bytes, idx, bookTitle, cand: idx.candidates.indexOf(cand), done } : null;
    showImportReview({ file, bytes, ctx, rows, title, source, book });
  }
  function build(ctx, row) {
    try { row.sec = P.buildSection(ctx, row.spec); row.error = null; } catch (e) { console.error(e); row.sec = null; row.error = e.message; }
    if (row.sec && row.minutesOverride) row.sec.minutes = row.minutesOverride;
    if (row.sec && row.keyText) applyKey(row.sec, row.keyText);
  }
  function applyKey(sec, text) {
    const key = P.parseKeyText(text);
    for (const q of sec.questions) if (key[q.n]) q.answer = key[q.n];
    sec.keyCount = sec.questions.filter((q) => q.answer).length;
  }

  function showImportReview(st) {
    if (!document.hidden) document.title = 'Testside — digital ACT practice';
    const { ctx } = st;
    const titleIn = h('input', { type: 'text', value: st.title, style: { width: '100%', fontSize: '18px', fontWeight: 700 }, oninput: (e) => { st.title = e.target.value; } });
    const tbody = h('tbody');
    const warnBox = h('div');
    const redraw = () => {
      tbody.replaceChildren();
      st.rows.forEach((row, ri) => {
        const s = row.sec;
        const kindSel = h('select', { onchange: (e) => { row.spec.kind = e.target.value; row.dirty = true; redraw(); } },
          P.KINDS.map((k) => h('option', { value: k, selected: k === row.spec.kind }, KN[k])));
        const pf = h('input', { type: 'number', min: 1, max: ctx.numPages, value: row.spec.start, onchange: (e) => { row.spec.start = +e.target.value; row.spec.startY = -1; row.dirty = true; redraw(); } });
        const pt = h('input', { type: 'number', min: 1, max: ctx.numPages, value: row.spec.end, onchange: (e) => { row.spec.end = +e.target.value; row.spec.endY = Infinity; row.dirty = true; redraw(); } });
        const minIn = h('input', { type: 'number', min: 1, step: 0.5, value: s ? s.minutes : '', onchange: (e) => { row.minutesOverride = +e.target.value; if (row.sec) row.sec.minutes = +e.target.value; } });
        const found = s ? `${s.questions.length}${s.expected ? ` / ${s.expected}` : ''}` : '—';
        const keyCell = h('td');
        if (s) {
          keyCell.append(s.keyCount === s.questions.length ? h('span', { class: 'pill ok' }, `${s.keyCount} ✓`) : h('span', { class: 'pill warn' }, `${s.keyCount} / ${s.questions.length}`));
          if (s.keyCount < s.questions.length) {
            keyCell.append(h('textarea', { placeholder: 'Paste key: “1 B 2 J 3 A…” or “BJA…”', value: row.keyText || '', onchange: (e) => { row.keyText = e.target.value; applyKey(row.sec, row.keyText); redraw(); } }));
          }
        }
        tbody.append(h('tr', null,
          h('td', null, h('input', { type: 'checkbox', checked: row.include, onchange: (e) => { row.include = e.target.checked; } })),
          h('td', null, kindSel),
          h('td', null, pf, ' – ', pt),
          h('td', null, minIn),
          h('td', null, row.error ? h('span', { class: 'pill warn' }, 'error') : found, s ? h('div', { class: 'meta' }, `${s.passages.length} passage${s.passages.length === 1 ? '' : 's'}`) : null),
          keyCell,
          h('td', null,
            row.dirty ? h('button', { class: 'btn small primary', onclick: () => { build(ctx, row); row.dirty = false; redraw(); } }, 'Rebuild') : null,
            s && !row.dirty ? h('button', { class: 'btn small', onclick: () => previewImport(st, ri) }, 'Preview') : null,
            h('button', { class: 'btn small ghost danger', onclick: () => { st.rows.splice(ri, 1); redraw(); } }, '✕'))));
      });
      const warns = st.rows.flatMap((r) => (r.error ? [`${KN[r.spec.kind]}: ${r.error}`] : (r.sec ? r.sec.warnings.map((w) => `${KN[r.spec.kind]}: ${w}`) : [])));
      warnBox.replaceChildren(warns.length ? h('ul', { class: 'warns' }, warns.map((w) => h('li', null, w))) : '');
    };
    redraw();
    const addBtn = h('button', { class: 'btn small', onclick: () => {
      const row = { spec: { kind: 'reading', start: 1, end: ctx.numPages }, include: true, dirty: true };
      st.rows.push(row); redraw();
    } }, '+ Add section by page range');
    const save = async () => {
      const rows = st.rows.filter((r) => r.include && r.sec);
      if (!rows.length) { toast('Nothing to save — include at least one section.', 'warn'); return; }
      const id = TS.store.uid();
      const test = {
        id, title: st.title.trim() || st.file.name, created: Date.now(), fileName: st.file.name, pageCount: ctx.numPages,
        sections: rows.map((r) => ({ ...r.sec, warnings: undefined })),
        source: { ...(st.source || {}), rows: rows.map((r) => ({ spec: r.spec, minutes: r.minutesOverride || null, keyText: r.keyText || null })) },
        parserVersion: P.VERSION,
      };
      const pdfId = TS.store.pdfKey(st.bytes);
      if (!(await TS.store.hasPdf(pdfId))) await TS.store.putPdf(pdfId, st.bytes);
      test.pdfId = pdfId;
      await TS.store.putTest(test);
      toast(`Saved “${test.title}”.`);
      // from a multi-test book: go back to its list so the next test doesn't need a re-upload
      if (st.book && st.book.idx.candidates.length > 1) { (st.book.done = st.book.done || new Set()).add(st.book.cand); showChooser(st.book); }
      else showLibrary();
    };
    root.replaceChildren(h('div', { class: 'lib' },
      h('div', { class: 'card imp' },
        h('div', { class: 'meta', style: { marginBottom: '6px' } }, `${st.file.name} · ${ctx.numPages} pages`),
        titleIn,
        h('p', { class: 'meta', style: { marginTop: '10px', lineHeight: 1.5 } }, 'Check what was found. Change a section’s type or page range and press Rebuild. Preview shows every question with its answer so you can spot-check the conversion.'),
        h('table', null, h('thead', null, h('tr', null, ['', 'Section', 'Pages', 'Minutes', 'Questions', 'Answer key', ''].map((x) => h('th', null, x)))), tbody),
        warnBox,
        h('div', { style: { display: 'flex', gap: '10px', marginTop: '16px', flexWrap: 'wrap' } },
          addBtn, h('span', { style: { flex: 1 } }),
          h('button', { class: 'btn', onclick: showLibrary }, 'Cancel'),
          h('button', { class: 'btn primary', onclick: save }, 'Save test')))));
    st._redraw = redraw;
  }

  async function previewImport(st, ri) {
    const tmp = { id: '__import__', title: st.title, sections: [st.rows[ri].sec], pageCount: st.ctx.numPages };
    await TS.render.open('__import__', st.bytes);
    runSection(tmp, 0, { preview: true, onExit: () => { showImportReview(st); } });
  }

  // ================= Runner =================
  let RUN = null;

  async function loadTest(testId) {
    const test = await TS.store.getTest(testId);
    if (!test) throw new Error('Test not found');
    const pid = test.pdfId || testId;
    if (TS.render.openId !== pid) {
      const bytes = await TS.store.testPdf(test);
      if (bytes) await TS.render.open(pid, bytes);
    }
    return test;
  }

  async function startSection(testId, si, opts) {
    const test = await loadTest(testId);
    if (opts.preview) return runSection(test, si, { preview: true });
    if (opts.attemptId) {
      const att = await TS.store.getAttempt(opts.attemptId);
      return runSection(test, si, { att, review: att.done, startAt: opts.startAt, resumed: true });
    }
    showSectionIntro(test, si, opts);
  }

  function showSectionIntro(test, si, opts = {}) {
    stopRunner();
    const sec = test.sections[si];
    let timed = true, factor = 1;
    const facts = h('div', { class: 'facts' });
    const refresh = () => {
      facts.replaceChildren(
        h('div', null, h('b', null, sec.questions.length), 'questions'),
        h('div', null, h('b', null, timed ? fmt(sec.minutes * 60 * factor) : '—'), timed ? 'time limit' : 'untimed'),
        h('div', null, h('b', null, sec.passages.filter((p) => !p.stimulus).length || '—'), 'passages'));
    };
    refresh();
    const dirText = sec.directions || defaultDirections(sec.kind);
    const shell = frameShell(test, sec, { intro: true });
    shell.card.append(h('div', { class: 'intro-screen' },
      h('div', { class: 'meta', style: { fontSize: '14px', textTransform: 'uppercase', letterSpacing: '.06em', color: '#7b858c' } }, test.title),
      h('h2', null, `${sec.title} Test`),
      facts,
      h('div', { class: 'dir' }, h('b', null, 'Directions: '), dirText),
      h('div', { class: 'opts' },
        h('label', null, h('input', { type: 'radio', name: 'tm', checked: true, onchange: () => { timed = true; factor = 1; refresh(); } }), 'Standard time'),
        h('label', null, h('input', { type: 'radio', name: 'tm', onchange: () => { timed = true; factor = 1.5; refresh(); } }), 'Time and a half'),
        h('label', null, h('input', { type: 'radio', name: 'tm', onchange: () => { timed = false; refresh(); } }), 'Untimed')),
      h('div', { style: { display: 'flex', gap: '10px', marginBottom: '26px' } },
        h('button', { class: 'btn primary big', onclick: () => {
          const att = newAttempt(test, si, timed, factor, opts.group);
          runSection(test, si, { att });
        } }, 'Begin'),
        h('button', { class: 'btn big', onclick: showLibrary }, 'Back to library')),
      h('div', { class: 'tipbox' },
        h('b', null, 'Tools: '), 'Pointer (normal clicking) · Answer eliminator (strike out choices) · Highlighter (drag across text; click a highlight to remove it) · Line reader (drag the yellow tabs)',
        sec.kind === 'math' ? ' · Graphing calculator' : '', '. ',
        h('b', null, 'Review'), ' lists every question; ', h('b', null, 'Flag'), ' marks one to revisit. Your work saves automatically; you can close the tab and resume.')));
  }
  function defaultDirections(kind) {
    return {
      english: 'In the passages that follow, certain words and phrases are underlined and numbered. Choose the alternative that best expresses the idea, is most consistent with the style and tone of the passage, or makes the correct choice. If you think the original version is best, choose “No Change.”',
      math: 'Solve each problem and choose the correct answer. Do not linger over problems that take too much time.',
      reading: 'Read each passage and choose the best answer to each question. You may refer to the passages as often as necessary.',
      science: 'Read each passage and choose the best answer to each question. You may refer to the passages as often as necessary.',
    }[kind];
  }

  function newAttempt(test, si, timed, factor = 1, group) {
    const sec = test.sections[si];
    return {
      id: TS.store.uid(), testId: test.id, si, kind: sec.kind, group: group || null,
      timed, factor, limit: Math.round(sec.minutes * 60 * factor), elapsed: 0,
      answers: {}, elim: {}, flags: {}, hl: {}, timeOn: {}, visits: {}, cur: 0,
      started: Date.now(), done: false,
    };
  }

  function stopRunner() {
    if (!RUN) return;
    clearInterval(RUN.tick);
    if (RUN.att && !RUN.preview) TS.store.putAttempt(RUN.att);
    document.removeEventListener('keydown', RUN.onKey);
    document.removeEventListener('mouseup', RUN.onMouseUp);
    document.removeEventListener('mousedown', RUN.onDocDown);
    RUN = null;
  }

  // Builds the frame (toolbar + crumb + stage) and returns handles.
  function frameShell(test, sec, opt = {}) {
    const prefs = TS.prefs.get();
    const top = h('header', { class: 'tn-top' });
    const crumbPos = h('span');
    const barI = h('i');
    const pct = h('span');
    const mode = h('span', { class: 'mode' });
    const crumb = h('div', { class: 'tn-crumb' },
      h('span', null, test.title.toUpperCase()), h('span', { class: 'sl' }, '/'),
      h('span', null, sec.title.toUpperCase()), h('span', { class: 'sl' }, '/'),
      crumbPos, h('span', { class: 'sl' }, '/'), h('div', { class: 'bar' }, barI), pct,
      h('span', { class: 'spacer' }), mode);
    const card = h('section', { class: 'tn-card' });
    const stage = h('main', { class: 'tn-stage' }, card);
    const tn = h('div', { class: 'tn', 'data-contrast': prefs.contrast }, top, crumb, stage);
    tn.style.setProperty('--zoom', prefs.zoom / 100);
    root.replaceChildren(tn);
    if (opt.intro) {
      top.append(h('div', { class: 'logo', html: I.book(22), style: { width: '38px', height: '38px' } }), h('b', { style: { fontSize: '18px' } }, 'Testside'), h('div', { class: 'top-spacer' }), h('span', { class: 'who' }, prefs.name));
      crumbPos.textContent = 'DIRECTIONS';
      mode.textContent = 'Not started';
      card.style.display = 'block';
    }
    return { tn, top, crumb, crumbPos, barI, pct, mode, card, stage };
  }

  function runSection(test, si, opts) {
    stopRunner();
    const sec = test.sections[si];
    const prefs = TS.prefs.get();
    const preview = !!opts.preview;
    const att = opts.att || { id: '__preview__', testId: test.id, si, answers: {}, elim: {}, flags: {}, hl: {}, timeOn: {}, visits: {}, cur: 0, elapsed: 0, timed: false, limit: 0 };
    const review = preview || !!opts.review || att.done;
    const F = frameShell(test, sec);
    // snapshot for "exit without saving": a new attempt is discarded, a resumed one rolls back to here
    const snapshot = opts.att && !preview && !(opts.review || att.done) ? JSON.stringify(att) : null;
    RUN = { test, sec, si, att, preview, review, F, snapshot, isNew: !!(opts.att && !opts.att.elapsed && !Object.keys(opts.att.answers).length && !opts.resumed), tool: 'pointer', hlColor: 'yellow', shownPassage: undefined, lastTick: performance.now(), warned5: att.timed && att.limit - att.elapsed <= 300, onExit: opts.onExit, paused: false, endScreen: false };
    const R = RUN;

    // ---- toolbar ----
    const prevB = h('button', { title: 'Back (Alt+←)', html: I.left(), onclick: () => nav(-1) });
    const nextB = h('button', { title: 'Next (Alt+→)', html: I.right(), onclick: () => nav(1) });
    const reviewB = h('button', { class: 'tb', onclick: (e) => { e.stopPropagation(); toggleReviewPop(); } }, h('span', { class: 'lbl' }, 'Review'), h('span', { html: I.list(20) }));
    const flagB = h('button', { class: 'tb', onclick: () => toggleFlag() });
    const tools = h('div', { class: 'tools' });
    const toolDefs = [['pointer', 'Pointer', I.pointer()], ['elim', 'Answer eliminator', I.elim()], ['hl', 'Highlighter', I.hl()], ['reader', 'Line reader', I.reader()]];
    if (sec.kind === 'math') toolDefs.push(['calc', 'Calculator', I.calc()]);
    for (const [k, label, ic] of toolDefs) tools.append(h('button', { class: 'tip', 'data-tip': label, 'data-tool': k, 'aria-label': label, html: ic, onclick: (e) => { e.stopPropagation(); setTool(k); } }));
    const timerEl = h('div', { class: 'timer', title: 'Click to hide or show the timer', onclick: () => { TS.prefs.set({ timerHidden: !TS.prefs.get().timerHidden }); updateTimer(); } });
    const menuB = h('button', { class: 'menu-btn', html: I.user(), onclick: (e) => { e.stopPropagation(); toggleMenu(); } });
    F.top.append(h('div', { class: 'navpair' }, prevB, nextB), reviewB, flagB, tools, h('div', { class: 'top-spacer' }), timerEl, h('span', { class: 'who' }, '| ' + prefs.name), menuB);
    F.mode.textContent = preview ? 'Preview · answers shown' : review ? 'Review' : att.timed ? (att.factor > 1 ? `Timed · ${att.factor}× time` : 'Timed') : 'Untimed';
    R.el = { prevB, nextB, reviewB, flagB, tools, timerEl, menuB };

    // ---- card ----
    R.left = null;
    R.stageEl = F.stage;
    R.onKey = (e) => {
      if (e.target.closest && e.target.closest('input, textarea, select')) return;
      if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); nav(1); }
      else if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); nav(-1); }
      else if (e.altKey && (e.code === 'KeyF')) { e.preventDefault(); toggleFlag(); }
      else if (e.altKey && (e.code === 'KeyR')) { e.preventDefault(); toggleReviewPop(); }
      else if (e.key === 'Escape') closePops();
      else if (R.tool === 'reader' && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); moveReader(e.key === 'ArrowDown' ? 1 : -1); }
    };
    R.onMouseUp = (e) => { if (R.tool === 'hl') setTimeout(() => captureHighlight(e), 0); };
    R.onDocDown = (e) => { if (!e.target.closest('.pop, .menu, .tb, .menu-btn, .hlbar')) closePops(); };
    document.addEventListener('keydown', R.onKey);
    document.addEventListener('mouseup', R.onMouseUp);
    document.addEventListener('mousedown', R.onDocDown);

    if (!review) {
      R.tick = setInterval(tick, 250);
    }
    setTool('pointer');
    const startAt = opts.startAt != null ? opts.startAt : (att.cur || 0);
    if (att.onEnd && !review) showEnd(); else goTo(Math.min(startAt, sec.questions.length - 1));
    updateTimer();
  }

  // ---- timing ----
  function tick() {
    const R = RUN;
    if (!R || R.review) return;
    const now = performance.now();
    const dt = (now - R.lastTick) / 1000;
    R.lastTick = now;
    if (R.paused || document.hidden && false) return;
    R.att.elapsed += dt;
    if (!R.endScreen) {
      const q = R.sec.questions[R.idx];
      if (q) R.att.timeOn[q.n] = (R.att.timeOn[q.n] || 0) + dt;
    }
    updateTimer();
    if (R.att.timed) {
      const left = R.att.limit - R.att.elapsed;
      if (!R.warned5 && left <= 300 && R.att.limit > 600) { R.warned5 = true; toast('5 minutes remaining.', 'warn', 5000); }
      if (left <= 0) { timeUp(); return; }
    }
    R.saveCountdown = (R.saveCountdown || 0) + dt;
    if (R.saveCountdown > 4) { R.saveCountdown = 0; save(); }
  }
  function save() { if (RUN && !RUN.preview) TS.store.putAttempt(RUN.att); }
  function updateTimer() {
    const R = RUN;
    if (!R) return;
    const el = R.el.timerEl;
    if (R.review) { el.textContent = R.preview ? 'Preview' : 'Review'; el.className = 'timer hidden-time'; return; }
    const hidden = TS.prefs.get().timerHidden;
    const left = R.att.limit - R.att.elapsed;
    if (hidden) { el.textContent = 'Show time'; el.className = 'timer hidden-time'; return; }
    el.textContent = R.att.timed ? fmt(left) : `${fmt(R.att.elapsed)} ↑`;
    el.className = 'timer' + (R.att.timed && left <= 300 ? ' low' : '');
  }
  async function timeUp() {
    const R = RUN;
    clearInterval(R.tick);
    R.att.elapsed = R.att.limit;
    await modal({ title: 'Time is up', text: 'The time for this section has ended. Your answers have been submitted.', buttons: [{ label: 'See results', value: true, primary: true }] });
    finish();
  }

  // ---- navigation ----
  function nav(d) {
    const R = RUN;
    if (!R) return;
    if (R.endScreen) { if (d < 0) goTo(R.sec.questions.length - 1); return; }
    const i = R.idx + d;
    if (i < 0) return;
    if (i >= R.sec.questions.length) { if (!R.review) showEnd(); else if (R.preview && R.onExit) R.onExit(); else if (!R.preview) showResults(R.att.id); return; }
    goTo(i);
  }
  function goTo(i) {
    const R = RUN;
    closePops();
    R.endScreen = false;
    R.att.onEnd = false;
    R.idx = i;
    R.att.cur = i;
    const q = R.sec.questions[i];
    R.att.visits[q.n] = (R.att.visits[q.n] || 0) + 1;
    renderQuestion();
    updateChrome();
    save();
  }
  function updateChrome() {
    const R = RUN;
    const n = R.sec.questions.length;
    const answered = R.sec.questions.filter((q) => R.att.answers[q.n]).length;
    R.F.crumbPos.textContent = R.endScreen ? 'REVIEW' : `${R.idx + 1} OF ${n}`;
    const p = Math.round((answered / n) * 100);
    R.F.barI.style.width = `${p}%`;
    R.F.pct.textContent = `${p}%`;
    R.el.prevB.disabled = !R.endScreen && R.idx === 0;
    const q = R.sec.questions[R.idx];
    const flagged = q && R.att.flags[q.n];
    R.el.flagB.replaceChildren(h('span', { html: flagged ? I.flagOn(20) : I.flag(20) }), h('span', { class: 'lbl' }, flagged ? 'Flagged' : 'Flag'));
    R.el.flagB.classList.toggle('on', !!flagged);
    R.el.flagB.style.visibility = R.endScreen ? 'hidden' : '';
  }
  function toggleFlag() {
    const R = RUN;
    if (!R || R.endScreen) return;
    const q = R.sec.questions[R.idx];
    if (R.att.flags[q.n]) delete R.att.flags[q.n]; else R.att.flags[q.n] = true;
    updateChrome(); save();
  }

  // ---- question rendering ----
  function renderQuestion() {
    const R = RUN;
    const { sec, F } = R;
    const q = sec.questions[R.idx];
    const prefs = TS.prefs.get();
    const zoom = prefs.zoom / 100;
    const passage = q.passage != null ? sec.passages[q.passage] : null;
    const card = F.card;
    card.style.display = '';
    if (!passage) {
      R.shownPassage = null;
      R.left = null;
      card.replaceChildren(questionPane(q, 'single', zoom));
    } else {
      if (R.shownPassage !== q.passage || !R.left || !card.contains(R.left)) {
        R.left = passagePane(passage, q.passage, zoom);
        R.shownPassage = q.passage;
      }
      const right = questionPane(q, 'right', zoom);
      const div = h('div', { class: 'divider', title: 'Drag to resize' });
      div.addEventListener('mousedown', startSplitDrag);
      card.replaceChildren(R.left, div, right);
      card.style.setProperty('--split', `${prefs.split || 50}%`);
      // booklet line breaks only work if every line fits; otherwise reflow this passage
      const lns = R.left.querySelectorAll('.ptext.lines .ln');
      if (lns.length) {
        const lh = parseFloat(getComputedStyle(lns[0]).lineHeight) || 28;
        if ([...lns].some((l) => l.offsetHeight > lh * 1.5)) {
          (R.noLines = R.noLines || {})[q.passage] = true;
          R.left = passagePane(passage, q.passage, zoom);
          card.replaceChildren(R.left, div, right);
        }
      }
      focusPassage(q.n);
    }
    applyToolClass();
    if (R.readerEl) placeReader();
  }

  function passagePane(p, pi, zoom) {
    const R = RUN;
    const kind = R.sec.kind;
    const prefs = TS.prefs.get();
    const pane = h('div', { class: 'pane left' });
    if (p.intro) {
      const intro = h('div', { class: 'intro hlable', 'data-hl': `pi:${pi}` });
      intro.append(renderBlocks([p.intro], { zoom }));
      // bold the genre lead ("LITERARY NARRATIVE:")
      const first = intro.querySelector('.p');
      if (first && first.firstChild && first.firstChild.nodeType === 3) {
        const m = first.firstChild.nodeValue.match(/^([A-Z][A-Z ]+:)/);
        if (m) { first.firstChild.nodeValue = first.firstChild.nodeValue.slice(m[1].length); first.prepend(h('span', { class: 'lead' }, m[1])); }
      }
      pane.append(intro);
    }
    const useLines = kind === 'reading' && p.hasLineNumbers && prefs.readingLayout === 'booklet' && !(R.noLines || {})[pi];
    const box = h('div', { class: 'pbox' + (useLines && prefs.lineNumbers ? ' gutter' : '') });
    const text = h('div', { class: 'ptext hlable' + (useLines ? ' lines' : ''), 'data-hl': `p:${pi}` });
    if (kind === 'english') {
      if (p.title) text.append(h('div', { class: 'ptitle', 'data-nohl': '' }, p.title.replace(/PASSAGE/i, 'Passage')));
      if (p.subtitle) text.append(h('div', { class: 'psub' }, p.subtitle));
    } else if (kind === 'science' && p.title) text.append(h('div', { class: 'ptitle', 'data-nohl': '' }, p.title));
    if (kind === 'reading') numberLines(p);
    text.append(renderBlocks(p.blocks, { zoom, lines: useLines, lnums: prefs.lineNumbers, inlineNums: kind === 'reading', figScale: 1 }));
    box.append(text);
    pane.append(box);
    applyHL(text, R.att.hl[`p:${pi}`]);
    const intro = pane.querySelector('.intro');
    if (intro) applyHL(intro, R.att.hl[`pi:${pi}`]);
    // clicking a question box in the passage jumps to it
    text.addEventListener('click', (e) => {
      const b = e.target.closest('.qbox');
      if (!b || R.tool === 'hl') return;
      const n = +b.dataset.q;
      const i = R.sec.questions.findIndex((x) => x.n === n);
      if (i >= 0) goTo(i);
    });
    return pane;
  }

  // Give every passage line its booklet line number, using the printed numbers (every 5th line) as anchors.
  function numberLines(p) {
    const all = [];
    for (const b of p.blocks) if (b.t === 'p' && !b.heading) for (const l of b.lines) all.push(l);
    const anchors = all.map((l, i) => (l.num ? [i, l.num] : null)).filter(Boolean);
    if (!anchors.length) { all.forEach((l, i) => { l._ln = i + 1; }); return; }
    let a = 0;
    all.forEach((l, i) => {
      while (a + 1 < anchors.length && anchors[a + 1][0] <= i) a++;
      const [ai, an] = anchors[a];
      l._ln = an + (i - ai);
    });
  }
  const blocksText = (blocks) => (blocks || []).filter((b) => b.t === 'p').map((b) => b.lines.map((l) => l.runs.map((r) => r.s || '').join('')).join(' ')).join(' ').replace(/([a-z])- ([a-z])/g, '$1$2');
  // "(lines 26–45)", "line 12", "lines 3 and 7" → [[from, to], …]
  function refsIn(txt) {
    const out = [];
    for (const m of txt.matchAll(/\blines?\s+(\d+)(?:\s*(?:[–—-]|through|to)\s*(\d+))?(?:\s*(?:and|,)\s*(\d+)(?:\s*[–—-]\s*(\d+))?)?/gi)) {
      out.push([+m[1], +(m[2] || m[1])]);
      if (m[3]) out.push([+m[3], +(m[4] || m[3])]);
    }
    return out;
  }
  function lineRefs(q) { return refsIn(blocksText(q.stem)); }

  // Passage text + offset helpers for the reading pane (rebuilt per call; passages are small).
  function passageIndex() {
    const rootEl = RUN.left && RUN.left.querySelector('.ptext');
    if (!rootEl) return null;
    const nodes = textNodes(rootEl);
    let T = '';
    const starts = [];
    for (const tn of nodes) { starts.push(T.length); T += tn.data; }
    const lineEls = [...rootEl.querySelectorAll('[data-ln]')];
    const norm = (x) => x.replace(/[“”"]/g, '"').replace(/[‘’]/g, "'").replace(/[—–]/g, '-').replace(/\s+/g, ' ').toLowerCase();
    const TN = norm(T);
    return {
      rootEl, nodes, starts, T, norm,
      TN: TN.length === T.length ? TN : null, // offsets only line up when no whitespace runs collapsed
      lineStart: new Map(lineEls.map((el) => [+el.dataset.ln, pointOffset(rootEl, el, 0)])),
      lineEndMap: new Map(lineEls.map((el) => [+el.dataset.ln, pointOffset(rootEl, el, el.childNodes.length)])),
      paraStarts: [...rootEl.querySelectorAll('.p')].map((p) => pointOffset(rootEl, p, 0)),
    };
  }
  // Find a quotation in the passage; "…" inside it means words were left out, so match the
  // first and last fragments. `near` = [from, to] limits the search when line numbers are known.
  function findQuote(P, quote, near) {
    if (!P.TN) return null;
    const frags = P.norm(quote).split(/\s*(?:\.\s?\.\s?\.|…)\s*/).map((f) => f.replace(/^[\s,;:]+|[\s,;:.]+$/g, '')).filter((f) => f.length >= 3);
    if (!frags.length || frags.join(' ').length < 8) return null;
    const first = frags[0], last = frags[frags.length - 1];
    const hits = [];
    for (let i = P.TN.indexOf(first); i >= 0; i = P.TN.indexOf(first, i + 1)) {
      if (near && (i < near[0] - 250 || i > near[1] + 250)) continue;
      let end = i + first.length;
      if (frags.length > 1) { const j = P.TN.indexOf(last, end); if (j < 0 || j - end > 1500) continue; end = j + last.length; }
      hits.push([i, end]);
    }
    // without line numbers, only trust an unambiguous match
    return hits.length === 1 || (near && hits.length) ? hits[0] : null;
  }
  // The passage words a piece of question text points at. ACT line numbers point at where a
  // sentence starts, so: quoted words win; otherwise take whole sentences covering the lines.
  // Without line numbers, only quotations are used.
  function refRange(P, txt) {
    const { T, lineStart, lineEndMap, paraStarts } = P;
    const lineEnd = (ln) => (lineEndMap.has(ln) ? lineEndMap.get(ln) : T.length);
    const refs = refsIn(txt).filter(([a]) => lineStart.has(a));
    let s0 = null, e0 = null;
    if (refs.length) {
      s0 = Math.min(...refs.map(([a]) => lineStart.get(a)));
      e0 = Math.max(...refs.map(([, b]) => lineEnd(lineStart.has(b) ? b : refs[0][0])));
    }
    // 1) a quotation from the passage (near the reference, if there is one)
    let found = null;
    for (const m of txt.matchAll(/[“"]([^”"]{6,})[”"]/g)) {
      found = findQuote(P, m[1], refs.length ? [s0, e0] : null);
      if (found) break;
    }
    if (found) return found;
    if (!refs.length) return null;
    // 2) whole sentences
    const isEnd = (i) => /[.!?]/.test(T[i]) && (i + 1 >= T.length || /[\s"”’)\]]/.test(T[i + 1]));
    const sentStartAt = (i) => {
      if (paraStarts.includes(i)) return true;
      let j = i - 1;
      while (j >= 0 && /\s/.test(T[j])) j--;
      while (j >= 0 && /["”’)\]]/.test(T[j])) j--;
      return j < 0 || /[.!?]/.test(T[j]);
    };
    let a0 = null;
    const lineAEnd = lineEnd(refs[0][0]);
    for (let i = s0; i < lineAEnd; i++) if (!/\s/.test(T[i]) && sentStartAt(i)) { a0 = i; break; }
    if (a0 == null) { a0 = s0; while (a0 > 0 && !sentStartAt(a0)) a0--; while (/\s/.test(T[a0])) a0++; }
    let b0;
    let k = e0 - 1;
    while (k > a0 && /\s/.test(T[k])) k--;
    if (!isEnd(k) && !/["”’)\]]/.test(T[k])) {
      let j = k;
      while (j < T.length && j < e0 + 400 && !isEnd(j) && !paraStarts.includes(j + 1)) j++;
      b0 = Math.min(T.length, j + 1);
    } else b0 = k + 1;
    while (b0 < T.length && /["”’)\]]/.test(T[b0])) b0++;
    return [a0, b0];
  }
  function toRange(P, [a0, b0]) {
    const at = (off) => {
      for (let i = P.nodes.length - 1; i >= 0; i--) if (P.starts[i] <= off) return [P.nodes[i], Math.min(off - P.starts[i], P.nodes[i].length)];
      return [P.nodes[0], 0];
    };
    const r = document.createRange();
    const [sn, so] = at(a0), [en, eo] = at(b0);
    r.setStart(sn, so); r.setEnd(en, eo);
    return r;
  }
  // Everything a question points at: the stem's reference, plus each answer choice's own
  // reference or quotation (on paper you'd find those through their line numbers).
  function referencedRanges(q) {
    const P = passageIndex();
    if (!P) return [];
    const out = [];
    const stem = refRange(P, blocksText(q.stem));
    if (stem) out.push(stem);
    for (const c of q.choices || []) {
      const r = refRange(P, blocksText(c.blocks));
      if (r && !out.some(([a, b]) => a === r[0] && b === r[1])) out.push(r);
    }
    return out.map((x) => toRange(P, x));
  }
  function scrollRangeIntoView(range) {
    const box = RUN.left.querySelector('.pbox');
    const bt = box.getBoundingClientRect(), rr = range.getBoundingClientRect();
    if (rr.top < bt.top + 20 || rr.bottom > bt.bottom - 20) box.scrollTop += rr.top - bt.top - box.clientHeight * 0.25;
  }

  function focusPassage(n) {
    const R = RUN;
    if (!R.left) return;
    R.left.querySelectorAll('.cur').forEach((e) => e.classList.remove('cur'));
    if (window.CSS && CSS.highlights) CSS.highlights.delete('qfocus');
    let els = [...R.left.querySelectorAll(`.u[data-q="${n}"], .qbox[data-q="${n}"]`)];
    const q = R.sec.questions.find((x) => x.n === n);
    if (!els.length && q && R.sec.kind === 'reading') {
      const ranges = referencedRanges(q);
      if (ranges.length && window.CSS && CSS.highlights && window.Highlight) {
        CSS.highlights.set('qfocus', new Highlight(...ranges));
        scrollRangeIntoView(ranges[0]);
        return;
      }
      for (const [a, b] of lineRefs(q)) for (let ln = a; ln <= b; ln++) els.push(...R.left.querySelectorAll(`[data-ln="${ln}"]`));
    }
    els.forEach((e) => e.classList.add('cur'));
    if (!els.length) return;
    const box = R.left.querySelector('.pbox');
    const first = els[0], last = els[els.length - 1];
    const bt = box.getBoundingClientRect();
    const a = first.getBoundingClientRect(), b = last.getBoundingClientRect();
    if (a.top < bt.top + 20 || b.bottom > bt.bottom - 20) {
      box.scrollTop += a.top - bt.top - box.clientHeight * 0.3;
    }
  }

  function questionPane(q, where, zoom) {
    const R = RUN;
    const pane = h('div', { class: `pane ${where}` });
    if (R.review) {
      const your = R.att.answers[q.n];
      const t = R.att.timeOn[q.n];
      pane.append(h('div', { class: 'rv-banner' },
        h('span', null, 'Question ', h('b', null, q.n)),
        q.answer ? h('span', null, 'Correct answer ', h('b', null, q.answer)) : h('span', null, 'No answer key'),
        !R.preview ? h('span', null, 'You chose ', h('b', null, your || '—')) : null,
        !R.preview && t ? h('span', null, 'Time ', h('b', null, fmt(t))) : null,
        q.unscored ? h('span', null, h('b', null, 'Not scored'), ' (field-test item)') : null,
        q.region ? h('button', { class: 'btn small', style: { marginLeft: 'auto' }, onclick: () => showOriginal(q) }, 'View in booklet') : null));
      if (q.explanation) {
        const ex = h('details', { class: 'expl' }, h('summary', null, 'Explanation'), h('div', null, q.explanation.replace(/^(?:Question\s+)?\d{1,2}\.\s*/, '')));
        pane.append(ex);
      }
    }
    const stem = h('div', { class: 'qstem hlable', 'data-hl': `q:${q.n}` });
    const noRefs = R.sec.kind === 'reading' && TS.prefs.get().readingLayout !== 'booklet';
    stem.append(renderBlocks(q.stem, { zoom, noHeadings: true, noRefs }));
    if (!q.stem.length && R.sec.kind === 'english') stem.style.display = 'none';
    pane.append(stem);
    applyHL(stem, R.att.hl[`q:${q.n}`]);
    const box = h('div', { class: 'choices', role: 'radiogroup' });
    const elim = R.att.elim[q.n] || [];
    for (const c of q.choices) {
      const sel = R.att.answers[q.n] === c.L;
      const row = h('div', { class: 'choice' + (sel ? ' sel' : '') + (elim.includes(c.L) ? ' elim' : ''), role: 'radio', 'aria-checked': sel ? 'true' : 'false', tabindex: '0', 'data-l': c.L });
      const ct = h('div', { class: 'ct' });
      ct.append(renderBlocks(c.blocks, { zoom, noHeadings: true, noRefs }));
      row.append(h('span', { class: 'radio' }), h('span', { class: 'L' }, `${c.L}.`), ct);
      if (R.review) {
        if (c.L === q.answer) { row.classList.add('rv-correct'); row.append(h('span', { class: 'rv-tag ok' }, 'Correct')); }
        else if (sel) { row.classList.add('rv-wrong'); row.append(h('span', { class: 'rv-tag bad' }, 'Your answer')); }
      } else {
        row.append(h('button', { class: 'elimx', title: 'Eliminate', html: I.close(15), onclick: (e) => { e.stopPropagation(); toggleElim(q, c.L); } }));
        row.addEventListener('click', (e) => {
          if (R.tool === 'hl' && window.getSelection().toString()) return;
          if (R.tool === 'elim') toggleElim(q, c.L); else choose(q, c.L);
        });
        row.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); choose(q, c.L); } });
      }
      box.append(row);
    }
    pane.append(box);
    return pane;
  }

  function showOriginal(q) {
    const wrap = h('div', { class: 'orig-wrap' });
    for (const r of q.region) wrap.append(TS.render.img({ page: r.page, rect: r.rect }, 1.9));
    modal({ title: `Question ${q.n} in the booklet`, body: wrap, buttons: [{ label: 'Close', value: true, primary: true }] });
    const m = document.querySelector('.modal:last-of-type');
    if (m) m.classList.add('wide');
  }

  function choose(q, L) {
    const R = RUN;
    if (R.att.answers[q.n] === L) return;
    R.att.answers[q.n] = L;
    const el = R.att.elim[q.n];
    if (el && el.includes(L)) R.att.elim[q.n] = el.filter((x) => x !== L);
    refreshChoices(q);
    updateChrome(); save();
  }
  function toggleElim(q, L) {
    const R = RUN;
    const list = R.att.elim[q.n] || [];
    if (list.includes(L)) R.att.elim[q.n] = list.filter((x) => x !== L);
    else { R.att.elim[q.n] = [...list, L]; if (R.att.answers[q.n] === L) delete R.att.answers[q.n]; }
    refreshChoices(q);
    updateChrome(); save();
  }
  function refreshChoices(q) {
    const R = RUN;
    const elim = R.att.elim[q.n] || [];
    R.F.card.querySelectorAll('.choice').forEach((row) => {
      const L = row.dataset.l;
      const sel = R.att.answers[q.n] === L;
      row.classList.toggle('sel', sel);
      row.setAttribute('aria-checked', sel ? 'true' : 'false');
      row.classList.toggle('elim', elim.includes(L));
    });
  }

  // ---- split pane ----
  function startSplitDrag(e) {
    e.preventDefault();
    const card = RUN.F.card;
    const r = card.getBoundingClientRect();
    const move = (ev) => {
      const pct = Math.min(72, Math.max(28, ((ev.clientX - r.left) / r.width) * 100));
      card.style.setProperty('--split', `${pct}%`);
      TS.prefs.set({ split: Math.round(pct) });
    };
    const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }

  // ---- tools ----
  function setTool(k) {
    const R = RUN;
    if (k === 'calc') { toggleCalc(); return; }
    if (k === 'reader') { toggleReader(); return; }
    R.tool = R.tool === k && k !== 'pointer' ? 'pointer' : k;
    R.el.tools.querySelectorAll('button').forEach((b) => {
      const t = b.dataset.tool;
      b.classList.toggle('on', t === R.tool || (t === 'reader' && !!R.readerEl) || (t === 'calc' && !!R.calcEl));
    });
    applyToolClass();
    closePops();
    if (R.tool === 'hl') showHlBar();
  }
  function applyToolClass() {
    const R = RUN;
    const c = R.F.card;
    c.classList.toggle('tool-hl', R.tool === 'hl');
    c.querySelectorAll('.choices').forEach((x) => x.classList.toggle('tool-elim', R.tool === 'elim' && !R.review));
  }
  function showHlBar() {
    const R = RUN;
    const btn = R.el.tools.querySelector('[data-tool="hl"]');
    const r = btn.getBoundingClientRect();
    const bar = h('div', { class: 'hlbar', style: { top: `${r.bottom + 8}px`, left: `${r.left - 40}px`, position: 'fixed' } });
    for (const c of ['yellow', 'blue', 'pink']) {
      bar.append(h('button', { class: R.hlColor === c ? 'on' : '', title: c, style: { background: `var(--hl-${c})` }, onclick: () => { R.hlColor = c; bar.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.title === c)); } }));
    }
    bar.append(h('button', { class: 'x', onclick: () => clearHighlights() }, 'Clear all'));
    document.body.append(bar);
    R.hlBar = bar;
  }
  function clearHighlights() {
    const R = RUN;
    R.F.card.querySelectorAll('.hlable').forEach((el) => { delete R.att.hl[el.dataset.hl]; applyHL(el, []); });
    save();
  }
  function captureHighlight(e) {
    const R = RUN;
    if (!R || R.tool !== 'hl') return;
    const sel = window.getSelection();
    // click on an existing highlight removes it
    if (sel.isCollapsed) {
      const m = e.target.closest && e.target.closest('mark.hl');
      if (m) {
        const host = m.closest('.hlable');
        const key = host.dataset.hl;
        const k = +m.dataset.k;
        R.att.hl[key] = (R.att.hl[key] || []).filter((_, i) => i !== k);
        applyHL(host, R.att.hl[key]);
        save();
      }
      return;
    }
    const range = sel.getRangeAt(0);
    const a = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
    const b = range.endContainer.nodeType === 1 ? range.endContainer : range.endContainer.parentElement;
    const host = a.closest('.hlable');
    if (!host || host !== b.closest('.hlable')) { sel.removeAllRanges(); return; }
    const s = pointOffset(host, range.startContainer, range.startOffset);
    const en = pointOffset(host, range.endContainer, range.endOffset);
    sel.removeAllRanges();
    if (en <= s) return;
    const key = host.dataset.hl;
    R.att.hl[key] = addRange(R.att.hl[key] || [], s, en, R.hlColor);
    applyHL(host, R.att.hl[key]);
    save();
  }

  // line reader
  function toggleReader() {
    const R = RUN;
    if (R.readerEl) { R.readerEl.remove(); R.readerEl = null; }
    else {
      const fs = 18 * (TS.prefs.get().zoom / 100);
      R.reader = R.reader || { top: 120, h: Math.round(fs * 1.6 * 2 + 10) };
      const topM = h('div', { class: 'mask' }), botM = h('div', { class: 'mask' });
      const win = h('div', { class: 'win' });
      const drag = h('div', { class: 'drag', title: 'Drag to move (or use ↑ ↓)' }, 'MOVE');
      const grip = h('div', { class: 'grip', title: 'Drag to resize' }, 'SIZE');
      const el = h('div', { class: 'reader' }, topM, win, botM, drag, grip);
      R.readerEl = el;
      R.stageEl.append(el);
      const dragger = (kind) => (e) => {
        e.preventDefault();
        const y0 = e.clientY, t0 = R.reader.top, h0 = R.reader.h;
        const mv = (ev) => {
          if (kind === 'move') R.reader.top = t0 + ev.clientY - y0;
          else R.reader.h = Math.max(24, h0 + ev.clientY - y0);
          placeReader();
        };
        const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); };
        document.addEventListener('mousemove', mv);
        document.addEventListener('mouseup', up);
      };
      drag.addEventListener('mousedown', dragger('move'));
      grip.addEventListener('mousedown', dragger('size'));
      placeReader();
    }
    R.el.tools.querySelector('[data-tool="reader"]').classList.toggle('on', !!R.readerEl);
  }
  function placeReader() {
    const R = RUN;
    if (!R.readerEl) return;
    const H = R.stageEl.clientHeight;
    R.reader.top = Math.max(22, Math.min(H - R.reader.h - 22, R.reader.top));
    const [topM, win, botM, drag, grip] = R.readerEl.children;
    topM.style.top = '0'; topM.style.height = `${R.reader.top}px`;
    win.style.top = `${R.reader.top}px`; win.style.height = `${R.reader.h}px`;
    botM.style.top = `${R.reader.top + R.reader.h}px`; botM.style.bottom = '0';
    drag.style.top = `${R.reader.top - 22}px`;
    grip.style.top = `${R.reader.top + R.reader.h}px`;
  }
  function moveReader(d) {
    const R = RUN;
    if (!R.readerEl) return;
    R.reader.top += d * 18 * (TS.prefs.get().zoom / 100) * 1.6;
    placeReader();
  }

  // calculator (Desmos graphing, as provided on the digital ACT)
  let desmosLoading = null;
  function toggleCalc() {
    const R = RUN;
    if (R.calcEl) { R.calcEl.remove(); R.calcEl = null; }
    else {
      const body = h('div', { class: 'calc-b' }, h('div', { style: { padding: '16px', color: '#7b858c', fontSize: '14px' } }, 'Loading calculator…'));
      const head = h('div', { class: 'calc-h' }, 'Graphing Calculator', h('span', { class: 'spacer' }), h('button', { title: 'Close', onclick: () => toggleCalc() }, '×'));
      const el = h('div', { class: 'calc', style: { right: '40px', top: '20px' } }, head, body);
      R.calcEl = el;
      R.stageEl.append(el);
      head.addEventListener('mousedown', (e) => {
        if (e.target.closest('button')) return;
        e.preventDefault();
        const sr = R.stageEl.getBoundingClientRect(), er = el.getBoundingClientRect();
        const dx = e.clientX - er.left, dy = e.clientY - er.top;
        const mv = (ev) => { el.style.right = 'auto'; el.style.left = `${ev.clientX - sr.left - dx}px`; el.style.top = `${Math.max(0, ev.clientY - sr.top - dy)}px`; };
        const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); };
        document.addEventListener('mousemove', mv);
        document.addEventListener('mouseup', up);
      });
      if (!desmosLoading) {
        desmosLoading = new Promise((res, rej) => {
          const s = document.createElement('script');
          s.src = 'https://www.desmos.com/api/v1.9/calculator.js?apiKey=dcb31709b452b1cf9dc26972add0fda6';
          s.onload = res; s.onerror = rej;
          document.head.append(s);
        });
      }
      desmosLoading.then(() => {
        if (!R.calcEl) return;
        body.replaceChildren();
        if (!R.calcState) R.calcState = null;
        R.calc = window.Desmos.GraphingCalculator(body, { keypad: true, expressions: true, settingsMenu: false, zoomButtons: true, border: false });
        if (R.calcState) R.calc.setState(R.calcState);
      }).catch(() => { body.replaceChildren(h('div', { style: { padding: '16px', fontSize: '14px' } }, 'Could not load the Desmos calculator (needs internet). Use a handheld calculator for now.')); desmosLoading = null; });
    }
    R.el.tools.querySelector('[data-tool="calc"]').classList.toggle('on', !!R.calcEl);
  }

  // ---- popovers ----
  function closePops() {
    const R = RUN;
    document.querySelectorAll('.pop, .menu').forEach((p) => p.remove());
    if (R && R.hlBar && R.tool !== 'hl') { R.hlBar.remove(); R.hlBar = null; }
  }
  function qGrid(filter, onPick, big) {
    const R = RUN;
    const grid = h('div', { class: 'grid' });
    R.sec.questions.forEach((q, i) => {
      const ans = R.att.answers[q.n];
      if (filter === 'unanswered' && ans) return;
      if (filter === 'flagged' && !R.att.flags[q.n]) return;
      const cls = ['gq'];
      if (R.review && !R.preview) cls.push(ans && ans === q.answer ? 'rv-ok' : ans ? 'rv-bad' : '');
      else if (ans) cls.push('ans');
      if (R.att.flags[q.n]) cls.push('flag');
      if (i === R.idx && !R.endScreen) cls.push('cur');
      grid.append(h('button', { class: cls.join(' '), title: ans ? `Answered ${ans}` : 'Not answered', onclick: () => onPick(i) }, String(q.n)));
    });
    if (!grid.children.length) grid.append(h('div', { class: 'meta', style: { gridColumn: '1 / -1', padding: '8px 2px' } }, filter === 'flagged' ? 'No flagged questions.' : 'Every question has an answer.'));
    return grid;
  }
  function legend() {
    return h('div', { class: 'legend' }, h('span', null, h('i', { class: 'ans' }), 'Answered'), h('span', null, h('i'), 'Not answered'), h('span', null, h('i', { class: 'flag' }), 'Flagged'));
  }
  function toggleReviewPop() {
    const R = RUN;
    if (!R) return;
    if (document.querySelector('.pop')) { closePops(); return; }
    closePops();
    let filter = 'all';
    const pop = h('div', { class: 'pop' });
    const r = R.el.reviewB.getBoundingClientRect();
    pop.style.left = `${r.left}px`;
    pop.style.position = 'fixed';
    const draw = () => {
      const fb = (k, label) => h('button', { class: filter === k ? 'on' : '', onclick: () => { filter = k; draw(); } }, label);
      pop.replaceChildren(h('h4', null, `${R.sec.title} — review`), h('div', { class: 'filters' }, fb('all', 'All'), fb('unanswered', 'Unanswered'), fb('flagged', 'Flagged')),
        qGrid(filter, (i) => { closePops(); goTo(i); }), legend(),
        !R.review ? h('div', { style: { marginTop: '12px', textAlign: 'right' } }, h('button', { class: 'btn small', onclick: () => { closePops(); showEnd(); } }, 'Go to end-of-section review')) : null);
    };
    draw();
    document.body.append(pop);
  }
  function toggleMenu() {
    const R = RUN;
    if (document.querySelector('.menu')) { closePops(); return; }
    closePops();
    const prefs = TS.prefs.get();
    const seg = (key, opts, fmtL) => h('div', { class: 'seg' }, opts.map((v) => h('button', { class: prefs[key] === v ? 'on' : '', onclick: () => { TS.prefs.set({ [key]: v }); applyPrefs(); closePops(); } }, fmtL ? fmtL(v) : v)));
    const mi = (label, fn) => h('div', { class: 'mi', onclick: () => { closePops(); fn(); } }, label);
    const menu = h('div', { class: 'menu' },
      h('div', { class: 'lbl' }, 'Zoom'), seg('zoom', [90, 100, 115, 130, 150], (v) => `${v}%`),
      h('div', { class: 'lbl' }, 'Contrast'), seg('contrast', ['default', 'cream', 'dark'], (v) => ({ default: 'Black on white', cream: 'Cream', dark: 'Dark' }[v])),
      R.sec.kind === 'reading' ? [h('div', { class: 'lbl' }, 'Reading passages'), seg('readingLayout', ['paragraphs', 'booklet'], (v) => (v === 'paragraphs' ? 'Paragraphs' : 'Booklet line breaks'))] : null,
      h('div', { class: 'sep' }),
      mi('Directions', () => modal({ title: `${R.sec.title} directions`, text: R.sec.directions || defaultDirections(R.sec.kind) })),
      mi(document.fullscreenElement ? 'Exit full screen' : 'Full screen', () => { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => {}); }),
      !R.review && R.att.timed ? mi('Pause (practice only)', pause) : null,
      h('div', { class: 'sep' }),
      !R.review ? mi('Save and exit', () => { save(); stopRunner(); showLibrary(); }) : null,
      !R.review ? mi('Exit without saving', exitNoSave) : null,
      !R.review ? mi('End section and score it', () => showEnd()) : null,
      R.review && !R.preview ? mi('Back to results', () => showResults(R.att.id)) : null,
      R.preview ? mi(R.onExit ? 'Back to import' : 'Back to library', () => { const f = R.onExit; stopRunner(); if (f) f(); else showLibrary(); }) : null,
      R.review && !R.preview ? mi('Back to library', () => showLibrary()) : null);
    document.body.append(menu);
  }
  function applyPrefs() {
    const R = RUN;
    const prefs = TS.prefs.get();
    R.F.tn.dataset.contrast = prefs.contrast;
    R.F.tn.style.setProperty('--zoom', prefs.zoom / 100);
    R.shownPassage = undefined;
    if (R.endScreen) showEnd(); else renderQuestion();
  }
  async function exitNoSave() {
    const R = RUN;
    const fresh = R.isNew;
    const ok = await modal({
      title: 'Exit without saving?',
      text: fresh ? 'This attempt will be discarded — nothing from this session is kept.' : 'Everything you did since you resumed (answers, highlights, time) will be thrown away.',
      buttons: [{ label: 'Keep working', value: false }, { label: 'Exit without saving', value: true, primary: true }],
    });
    if (!ok || RUN !== R) return;
    R.preview = true; // stops stopRunner() from saving
    clearInterval(R.tick);
    if (fresh) await TS.store.deleteAttempt(R.att.id);
    else if (R.snapshot) await TS.store.putAttempt(JSON.parse(R.snapshot));
    stopRunner();
    showLibrary();
  }

  async function pause() {
    const R = RUN;
    R.paused = true;
    const cover = h('div', { class: 'modal-bg' });
    document.body.append(cover);
    await modal({ title: 'Paused', text: 'The timer is stopped and the test is hidden. The real test cannot be paused — use this only for practice.', buttons: [{ label: 'Resume', value: true, primary: true }] });
    cover.remove();
    R.paused = false;
    R.lastTick = performance.now();
  }

  // ---- end of section ----
  function showEnd() {
    const R = RUN;
    closePops();
    R.endScreen = true;
    R.att.onEnd = true;
    R.left = null; R.shownPassage = undefined;
    const qs = R.sec.questions;
    const answered = qs.filter((q) => R.att.answers[q.n]).length;
    const flagged = qs.filter((q) => R.att.flags[q.n]).length;
    let filter = 'all';
    const wrap = h('div', { class: 'endscreen' });
    const draw = () => {
      const fb = (k, label) => h('button', { class: filter === k ? 'on' : '', onclick: () => { filter = k; draw(); } }, label);
      wrap.replaceChildren(
        h('h2', null, 'Review your answers'),
        h('p', null, `You answered ${answered} of ${qs.length} questions${flagged ? ` and flagged ${flagged}` : ''}. Select a number to return to that question, or submit when you are finished.`),
        h('div', { class: 'filters' }, fb('all', `All (${qs.length})`), fb('unanswered', `Unanswered (${qs.length - answered})`), fb('flagged', `Flagged (${flagged})`)),
        qGrid(filter, (i) => goTo(i), true), legend(),
        h('div', { class: 'acts' },
          h('button', { class: 'btn big', onclick: () => goTo(qs.length - 1) }, 'Back to last question'),
          h('button', { class: 'btn primary big', onclick: submit }, 'Submit final answers')));
    };
    draw();
    R.F.card.replaceChildren(wrap);
    updateChrome();
    save();
  }
  async function submit() {
    const R = RUN;
    const un = R.sec.questions.filter((q) => !R.att.answers[q.n]).length;
    const ok = await modal({
      title: 'Submit this section?',
      text: un ? `You have ${un} unanswered question${un === 1 ? '' : 's'}. There is no penalty for guessing. After submitting you can’t change answers.` : 'After submitting you can’t change your answers.',
      buttons: [{ label: 'Keep working', value: false }, { label: 'Submit', value: true, primary: true }],
    });
    if (ok) finish();
  }
  async function finish() {
    const R = RUN;
    if (!R) return;
    clearInterval(R.tick);
    const att = R.att;
    att.done = true;
    att.finishedAt = Date.now();
    att.onEnd = false;
    att.score = scoreOf(R.sec, att);
    await TS.store.putAttempt(att);
    const id = att.id;
    stopRunner();
    showResults(id);
  }
  function scoreOf(sec, att) {
    let raw = 0, total = 0, answered = 0, correctAll = 0;
    for (const q of sec.questions) {
      if (att.answers[q.n]) answered++;
      if (!q.answer) continue;
      const ok = att.answers[q.n] === q.answer;
      if (ok) correctAll++;
      if (q.unscored) continue;
      total++;
      if (ok) raw++;
    }
    return { raw, total, answered, correctAll, keyed: sec.questions.filter((q) => q.answer).length };
  }

  // ================= Results =================
  async function showResults(attId) {
    stopRunner();
    const att = await TS.store.getAttempt(attId);
    const test = await TS.store.getTest(att.testId);
    const sec = test.sections[att.si];
    const sc = att.score || scoreOf(sec, att);
    const qs = sec.questions;
    const avg = att.elapsed / Math.max(1, qs.length);
    const maxT = Math.max(1, ...qs.map((q) => att.timeOn[q.n] || 0));
    const unscored = qs.filter((q) => q.unscored).length;
    const rows = qs.map((q, i) => {
      const a = att.answers[q.n];
      const t = att.timeOn[q.n] || 0;
      const res = !q.answer ? h('span', { class: 'skip-t' }, 'no key') : !a ? h('span', { class: 'skip-t' }, 'blank') : a === q.answer ? h('span', { class: 'ok-t' }, '✓') : h('span', { class: 'bad-t' }, '✗');
      return h('tr', { class: 'clk', onclick: () => openReview(test, att, i) },
        h('td', null, q.n, q.unscored ? h('span', { class: 'pill', style: { marginLeft: '6px' } }, 'unscored') : null),
        h('td', null, a || '—'), h('td', null, q.answer || '?'), h('td', null, res),
        h('td', { style: { width: '32%' } }, h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
          h('div', { class: 'tbar' + (t > avg * 1.8 ? ' slow' : ''), style: { width: `${(t / maxT) * 100}%` } }), h('span', { style: { fontVariantNumeric: 'tabular-nums', color: '#4a545b', fontSize: '13px' } }, fmt(t)))),
        h('td', null, att.flags[q.n] ? '⚑' : ''));
    });
    // per-passage breakdown
    const pRows = [];
    sec.passages.forEach((p, pi) => {
      if (p.stimulus) return;
      const pq = qs.filter((q) => q.passage === pi);
      if (!pq.length) return;
      const c = pq.filter((q) => q.answer && att.answers[q.n] === q.answer).length;
      const t = pq.reduce((s, q) => s + (att.timeOn[q.n] || 0), 0);
      pRows.push(h('tr', null, h('td', null, p.subtitle || p.title || `Passage ${pi + 1}`), h('td', null, `${c}/${pq.length}`), h('td', null, fmt(t))));
    });
    const next = att.group ? await nextInGroup(test, att) : null;
    root.replaceChildren(h('div', { class: 'lib' },
      h('div', { class: 'lib-head' },
        h('div', { class: 'logo', html: I.book(24) }),
        h('div', null, h('h1', null, `${sec.title} results`), h('p', null, `${test.title} · ${dateStr(att.finishedAt || Date.now())}`)),
        h('div', { class: 'spacer' }),
        next ? h('button', { class: 'btn primary', onclick: next.go }, next.label) : null,
        h('button', { class: 'btn', onclick: () => openReview(test, att, 0) }, 'Review answers'),
        h('button', { class: 'btn', onclick: () => startSection(test.id, att.si, {}) }, 'Retake'),
        h('button', { class: 'btn', onclick: showLibrary }, 'Library')),
      h('div', { class: 'res-top' },
        h('div', { class: 'stat' }, h('div', { class: 'v' }, `${sc.raw}/${sc.total}`), h('div', { class: 'l' }, 'raw score' + (unscored ? ' (scored items)' : ''))),
        h('div', { class: 'stat' }, h('div', { class: 'v' }, sc.total ? `${Math.round((sc.raw / sc.total) * 100)}%` : '—'), h('div', { class: 'l' }, 'accuracy')),
        h('div', { class: 'stat' }, h('div', { class: 'v' }, fmt(att.elapsed)), h('div', { class: 'l' }, att.timed ? `of ${fmt(att.limit)} allowed` : 'untimed')),
        h('div', { class: 'stat' }, h('div', { class: 'v' }, fmt(avg)), h('div', { class: 'l' }, 'average per question')),
        h('div', { class: 'stat' }, h('div', { class: 'v' }, qs.length - sc.answered), h('div', { class: 'l' }, 'left blank'))),
      unscored ? h('p', { class: 'meta', style: { marginTop: '12px' } }, `${unscored} field-test question${unscored === 1 ? ' was' : 's were'} not scored (as marked in the booklet’s key); you got ${sc.correctAll} of ${sc.keyed} right counting them.`) : null,
      sc.keyed < qs.length ? h('p', { class: 'meta', style: { color: '#9a5b00' } }, `${qs.length - sc.keyed} question(s) have no answer key, so they are not scored.`) : null,
      pRows.length ? h('div', { class: 'card' }, h('h3', null, 'By passage'), h('table', { class: 'rtable', style: { marginTop: '8px' } }, h('thead', null, h('tr', null, h('th', null, 'Passage'), h('th', null, 'Correct'), h('th', null, 'Time'))), h('tbody', null, pRows))) : null,
      h('div', { class: 'card' }, h('h3', null, 'Every question'), h('p', { class: 'meta' }, 'Click a row to see that question with the correct answer. Red bars mark questions that took much longer than your average.'),
        h('table', { class: 'rtable' }, h('thead', null, h('tr', null, ['#', 'You', 'Key', '', 'Time on question', ''].map((x) => h('th', null, x)))), h('tbody', null, rows)))));
  }
  async function openReview(test, att, i) {
    await loadTest(test.id);
    runSection(test, att.si, { att, review: true, startAt: i });
  }

  // ================= full test =================
  async function startFullTest(testId) {
    const test = await loadTest(testId);
    const group = TS.store.uid();
    showSectionIntro(test, 0, { group });
  }
  async function nextInGroup(test, att) {
    const si = att.si + 1;
    if (si >= test.sections.length) return null;
    const nextSec = test.sections[si];
    const go = () => {
      if (test.sections[att.si].kind === 'math') showBreak(test, si, att.group);
      else showSectionIntro(test, si, { group: att.group });
    };
    return { label: `Continue to ${nextSec.title} →`, go };
  }
  function showBreak(test, si, group) {
    stopRunner();
    let left = 600;
    const t = h('div', { style: { fontSize: '56px', fontWeight: 800, fontVariantNumeric: 'tabular-nums', margin: '10px 0 20px' } }, fmt(left));
    const iv = setInterval(() => { left--; t.textContent = fmt(left); if (left <= 0) { clearInterval(iv); showSectionIntro(test, si, { group }); } }, 1000);
    root.replaceChildren(h('div', { class: 'lib', style: { textAlign: 'center', paddingTop: '90px' } },
      h('h1', null, 'Break'), h('p', { style: { color: '#4a545b' } }, 'On test day there is a 10-minute break after the mathematics section.'), t,
      h('button', { class: 'btn primary big', onclick: () => { clearInterval(iv); showSectionIntro(test, si, { group }); } }, 'Skip break')));
  }

  // ================= boot =================
  window.addEventListener('beforeunload', () => { if (RUN && !RUN.preview) TS.store.putAttempt(RUN.att); });
  TS.app = { showLibrary, importFile, startSection, showResults, renderBlocks, get RUN() { return RUN; } };
  showLibrary();
})();
