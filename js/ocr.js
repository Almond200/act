/* Testside — on-device OCR for scanned pages (Tesseract.js).
 * Produces the same {items, gfx} shape as text-layer extraction, so the
 * layout parser runs unchanged: words become text items, and page ink not
 * covered by words becomes graphics (underlines → thin rules, figures → boxes).
 */
(function () {
  'use strict';
  const TS = (window.TS = window.TS || {});
  const SCALE = 4;      // render scale for recognition (ACT scans are ~100 dpi; upscaling helps a lot)
  const A = 2;          // scale for pixel analysis
  // one Tesseract worker per spare pair of cores (each holds ~100 MB)
  const WORKERS = Math.max(2, Math.min(4, Math.floor((navigator.hardwareConcurrency || 4) / 2)));
  const VERSION = 2; // bump when recognition output changes (item sizing below doesn't need a bump) // bump when recognition output changes
  let loading = null;
  let pool = null;

  function loadLib() {
    if (window.Tesseract) return Promise.resolve();
    if (!loading) loading = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
      s.onload = res; s.onerror = () => { loading = null; rej(new Error('Could not load the OCR engine (needs an internet connection the first time).')); };
      document.head.append(s);
    });
    return loading;
  }
  async function getPool() {
    await loadLib();
    if (!pool) pool = Promise.all(Array.from({ length: WORKERS }, () => window.Tesseract.createWorker('eng')));
    return pool;
  }

  async function renderPage(page, scale) {
    const vp = page.getViewport({ scale });
    const c = document.createElement('canvas');
    c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp, intent: 'print' }).promise;
    return c;
  }

  // Recognise one page. Returns { items, gfx } in PDF points (top-left origin).
  async function ocrPage(page, worker) {
    const vp = page.getViewport({ scale: 1 });
    const W = vp.width, H = vp.height;
    const big = await renderPage(page, SCALE);
    const r = await worker.recognize(big, {}, { blocks: true, text: false });
    const words = [];
    for (const b of r.data.blocks || []) for (const p of b.paragraphs) for (const l of p.lines) for (const w of l.words) words.push({ w, l });
    // compact raw words: [text, x0, y0, x1, y1, baselineY, conf, rowHeight, italic, bold] in render pixels
    const rawOf = () => words.map(({ w, l }) => [w.text, w.bbox.x0, w.bbox.y0, w.bbox.x1, w.bbox.y1,
      (w.baseline && w.baseline.has_baseline ? w.baseline.y0 : l.baseline.y0), Math.round(w.confidence), l.rowAttributes.row_height, w.is_italic ? 1 : 0, w.is_bold ? 1 : 0]);
    let gfx = inkGraphics(big, words, W, H);
    // second pass: text-sized ink the page-level layout analysis skipped (very short lines such as
    // "J. If") gets re-read as a small text block
    const holes = gfx.filter((g) => g.ink && g.y1 - g.y0 < 40 && g.x1 - g.x0 > 6 && (g.x1 - g.x0) * (g.y1 - g.y0) < 5000);
    if (holes.length && holes.length < 40) {
      await worker.setParameters({ tessedit_pageseg_mode: '6' });
      let added = 0;
      for (const g of holes) {
        // recognize a small crop: passing the whole page with a `rectangle` re-sends the full
        // ~10 MP bitmap to the worker every time (~200 ms per hole)
        const left = Math.max(0, Math.round(g.x0 * SCALE - 8)), top = Math.max(0, Math.round(g.y0 * SCALE - 8));
        const width = Math.min(big.width - left, Math.round((g.x1 - g.x0) * SCALE + 16)), height = Math.min(big.height - top, Math.round((g.y1 - g.y0) * SCALE + 16));
        if (width < 4 || height < 4) continue;
        const crop = document.createElement('canvas');
        crop.width = width; crop.height = height;
        crop.getContext('2d').drawImage(big, left, top, width, height, 0, 0, width, height);
        const rr = await worker.recognize(crop, {}, { blocks: true, text: false });
        const shift = (bb) => ({ x0: bb.x0 + left, x1: bb.x1 + left, y0: bb.y0 + top, y1: bb.y1 + top });
        for (const b of rr.data.blocks || []) for (const p of b.paragraphs) for (const l of p.lines) for (const w of l.words) {
          if (w.confidence >= 60 && w.text.trim()) {
            const bl = (o) => o && { ...o, y0: o.y0 + top, y1: o.y1 + top };
            words.push({ w: { ...w, bbox: shift(w.bbox), baseline: bl(w.baseline) }, l: { ...l, bbox: shift(l.bbox), baseline: bl(l.baseline) } });
            added++;
          }
        }
      }
      await worker.setParameters({ tessedit_pageseg_mode: '3' });
      if (added) gfx = inkGraphics(big, words, W, H);
    }
    big.width = big.height = 0; // release the bitmap right away (these are ~30 MB each)
    return { raw: rawOf(), gfx };
  }

  // Raw OCR words → text items (points). Kept separate from recognition so cached pages
  // pick up any change to these heuristics.
  function itemsFromRaw(raw) {
    const rows = raw.map((r) => r[7]).sort((a, b) => a - b);
    const medRow = rows.length ? rows[rows.length >> 1] : 30;
    const items = [];
    // the second pass can re-read a word the first pass already had: keep the more confident copy
    const kept = [];
    for (const r of raw) {
      const dup = kept.findIndex((k) => {
        const ox = Math.min(k[3], r[3]) - Math.max(k[1], r[1]), oy = Math.min(k[4], r[4]) - Math.max(k[2], r[2]);
        return ox > 0 && oy > 0 && ox * oy > 0.5 * Math.min((k[3] - k[1]) * (k[4] - k[2]), (r[3] - r[1]) * (r[4] - r[2]));
      });
      if (dup < 0) kept.push(r); else if (r[6] > kept[dup][6]) kept[dup] = r;
    }
    raw = kept;
    for (const [text, x0, y0, x1, y1, base, conf, rowH, it, bd] of raw) {
      const t = text.trim();
      if (!t) continue;
      const bh = y1 - y0;
      if (conf < 35 && !/^[A-K]\.$|^\d{1,2}\.$/.test(t)) continue;
      if (bh < medRow * 0.45 && !/^[.,;:'’"”—-]+$/.test(t)) continue; // tiny question markers under underlines are unreadable at scan resolution
      let h = rowH / SCALE; // Tesseract's row height ≈ 1 em
      // digits have no descenders: their box height is the cap height (~0.7 em), which reveals
      // smaller-type numbers such as reading-passage line numbers
      if (/^\d{1,3}$/.test(t)) h = Math.min(h, bh / SCALE / 0.72);
      const baseY = base / SCALE;
      items.push({
        s: t, x: x0 / SCALE, x1: x1 / SCALE, w: (x1 - x0) / SCALE, y: baseY, h,
        top: baseY - h * 0.8, bottom: baseY + h * 0.22,
        name: 'OCR', italic: !!it && conf > 80, bold: !!bd && conf > 80, serif: true, ocr: true, conf,
      });
    }
    return items;
  }
  // page ink is recomputed on every import (cheap), so only recognized words are cached
  async function finish(res, page) {
    if (!res.raw) return res;
    const vp = page.getViewport({ scale: 1 });
    const cv = await renderPage(page, A);
    // inkGraphics expects word boxes in SCALE pixels and resamples its source to A
    const gfx = inkGraphics(cv, res.raw, vp.width, vp.height);
    cv.width = cv.height = 0;
    return { items: itemsFromRaw(res.raw), gfx };
  }

  // Find rules/underlines and non-text ink (figures) from pixels.
  function inkGraphics(big, words, W, H) {
    const src = big;
    const c = document.createElement('canvas');
    c.width = Math.round(W * A); c.height = Math.round(H * A);
    const cw = c.width, ch = c.height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(src, 0, 0, c.width, c.height);
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    c.width = c.height = 0;
    const dark = new Uint8Array(cw * ch);
    const light = new Uint8Array(cw * ch); // scanned rules (underlines) are often light gray
    for (let i = 0, j = 0; i < dark.length; i++, j += 4) {
      const lum = data[j] * 0.3 + data[j + 1] * 0.59 + data[j + 2] * 0.11;
      dark[i] = lum < 150 ? 1 : 0;
      light[i] = lum < 215 ? 1 : 0;
    }

    // 1) horizontal rules: long thin dark runs
    const gfx = [];
    const minLen = 5 * A;
    const segs = [];
    for (let y = 0; y < ch; y++) {
      let x = 0;
      while (x < cw) {
        if (!light[y * cw + x]) { x++; continue; }
        let e = x, dk = 0;
        while (e < cw && light[y * cw + e]) { dk += dark[y * cw + e]; e++; }
        if (e - x >= minLen) segs.push({ x0: x, x1: e, y0: y, y1: y + 1, dk, n: e - x });
        x = e;
      }
    }
    // merge vertically adjacent runs into rules
    segs.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
    const rules = [];
    for (const s of segs) {
      const r = rules.find((r) => r.y1 >= s.y0 && r.y1 <= s.y0 + 1 && Math.min(r.x1, s.x1) - Math.max(r.x0, s.x0) > 0.7 * Math.min(r.x1 - r.x0, s.x1 - s.x0));
      if (r) { r.y1 = s.y1; r.x0 = Math.min(r.x0, s.x0); r.x1 = Math.max(r.x1, s.x1); r.dk += s.dk; r.n += s.n; } else rules.push({ ...s });
    }
    // word boxes in analysis pixels (a "rule" through the middle of words is just bold text)
    const k0 = A / SCALE;
    const wboxes = words.map((wd) => (Array.isArray(wd) ? [wd[1], wd[2], wd[3], wd[4], wd[6]] : [wd.w.bbox.x0, wd.w.bbox.y0, wd.w.bbox.x1, wd.w.bbox.y1, wd.w.confidence]))
      .filter((b) => b[4] >= 40).map((b) => b.slice(0, 4).map((v) => v * k0));
    const inText = (r) => {
      const cy = (r.y0 + r.y1) / 2;
      let cover = 0;
      for (const [x0, y0, x1, y1] of wboxes) if (cy > y0 + (y1 - y0) * 0.15 && cy < y1 - (y1 - y0) * 0.2) cover += Math.max(0, Math.min(x1, r.x1) - Math.max(x0, r.x0));
      return cover > (r.x1 - r.x0) * 0.4;
    };
    const thin = rules.filter((r) => r.y1 - r.y0 <= 2.4 * A && !inText(r));
    // rules seen only at the light threshold (gray scan underlines) are marked so the parser uses
    // them for English underlines but not for building figures
    for (const r of thin) gfx.push({ x0: r.x0 / A, x1: r.x1 / A, y0: r.y0 / A, y1: Math.max(r.y0 / A + 0.3, r.y1 / A - 0.5), stroke: true, light: r.dk < r.n * 0.5 });

    // 2) figure ink: dark cells not explained by words or thin rules
    const cell = 3 * A;
    const gw = Math.ceil(cw / cell), gh = Math.ceil(ch / cell);
    const grid = new Uint8Array(gw * gh);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) if (dark[y * cw + x]) grid[((y / cell) | 0) * gw + ((x / cell) | 0)] = 1;
    const clear = (x0, y0, x1, y1) => {
      for (let gy = Math.max(0, (y0 / cell) | 0); gy <= Math.min(gh - 1, (y1 / cell) | 0); gy++)
        for (let gx = Math.max(0, (x0 / cell) | 0); gx <= Math.min(gw - 1, (x1 / cell) | 0); gx++) grid[gy * gw + gx] = 0;
    };
    const k = A / SCALE;
    for (const wd of words) {
      const [text, x0, y0, x1, y1, , conf] = Array.isArray(wd) ? wd : [wd.w.text, wd.w.bbox.x0, wd.w.bbox.y0, wd.w.bbox.x1, wd.w.bbox.y1, 0, wd.w.confidence];
      if (conf >= 55 && text.trim().length) clear(x0 * k - 1, y0 * k - 1, x1 * k + 1, y1 * k + 1);
    }
    for (const r of thin) if (r.dk >= r.n * 0.5) clear(r.x0 - 1, r.y0 - 1, r.x1 + 1, r.y1 + 1);
    // connected components (8-neighbour)
    const seen = new Uint8Array(gw * gh);
    const stack = [];
    for (let i = 0; i < grid.length; i++) {
      if (!grid[i] || seen[i]) continue;
      let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1, n = 0;
      stack.push(i); seen[i] = 1;
      while (stack.length) {
        const j = stack.pop();
        const gx = j % gw, gy = (j / gw) | 0;
        n++; x0 = Math.min(x0, gx); x1 = Math.max(x1, gx); y0 = Math.min(y0, gy); y1 = Math.max(y1, gy);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = gx + dx, ny = gy + dy;
          if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
          const q = ny * gw + nx;
          if (grid[q] && !seen[q]) { seen[q] = 1; stack.push(q); }
        }
      }
      if (n < 5) continue; // specks, stray glyph fragments
      gfx.push({ x0: (x0 * cell) / A, y0: (y0 * cell) / A, x1: ((x1 + 1) * cell) / A, y1: ((y1 + 1) * cell) / A, ink: true });
    }
    return gfx;
  }

  // OCR many pages with a small worker pool. pages: array of pdf.js page numbers.
  async function ocrPages(pdf, pnos, onEach) {
    const out = new Map();
    const fp = (pdf.fingerprints && pdf.fingerprints[0]) || 'doc';
    const keyOf = (pno) => `${fp}:${pno}:v${VERSION}`;
    // reuse earlier recognition of the same file
    const todo = [];
    let done = 0;
    for (const pno of pnos) {
      let hit = null;
      try { hit = TS.store && (await TS.store.getOcr(keyOf(pno))); } catch (e) { /* no cache */ }
      if (hit) { const page = await pdf.getPage(pno); out.set(pno, await finish(hit, page)); page.cleanup(); done++; onEach && onEach(done, pnos.length, pno); } else todo.push(pno);
    }
    if (!todo.length) return out;
    const workers = await getPool();
    let next = 0;
    await Promise.all(workers.map(async (w) => {
      while (next < todo.length) {
        const pno = todo[next++];
        const page = await pdf.getPage(pno);
        const res = await ocrPage(page, w);
        out.set(pno, await finish(res, page));
        try { TS.store && (await TS.store.putOcr(keyOf(pno), { raw: res.raw })); } catch (e) { /* cache is optional */ }
        page.cleanup();
        done++;
        onEach && onEach(done, pnos.length, pno);
      }
    }));
    return out;
  }

  TS.ocr = { ocrPages, loadLib, WORKERS };
})();
