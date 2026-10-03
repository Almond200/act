/* Testside — ACT booklet PDF → structured test.
 *
 * Pipeline: extract positioned text + vector graphics per page with pdf.js,
 * strip page chrome, group items into lines, order them by column, find the
 * four section headings, then walk each section's stream picking out
 * numbered questions (verified by their A–D / F–J choice ladders) and the
 * passages between them. English passages keep their underlines and question
 * markers; math (and anything with a figure) is carried as page-region crops.
 */
(function () {
  'use strict';
  const TS = (window.TS = window.TS || {});

  const KINDS = ['english', 'math', 'reading', 'science'];
  const KIND_NAMES = { english: 'English', math: 'Mathematics', reading: 'Reading', science: 'Science' };
  const HEADINGS = [
    ['english', /^ENGLISH TEST$/],
    ['math', /^MATHEMATICS TEST$/],
    ['reading', /^READING TEST$/],
    ['science', /^SCIENCE( REASONING)? TEST$/],
  ];
  const CHROME_RE = /GO\s*ON\s*TO\s*THE\s*NEXT\s*PAGE|DO\s*YOUR\s*FIGURING\s*HERE|DO\s*NOT\s*(TURN|RETURN)|^\s*ACT-[A-Z0-9]+\s*$|©\s*\d{4}\s*(by\s*)?ACT|Page \d+ of \d+|QU\d{5}|^\s*STOP!?\s*$|^\s*END OF (TEST|THE)/i;
  const END_RE = /END\s*OF\s*(TEST|THE\s*(ENGLISH|MATH\w*|READING|SCIENCE))|^\s*STOP!?\s*$/i;
  const NONTEST_RE = /Scoring Key|Answer Key|WRITING TEST|Practice Answer Document|How to Score|Scoring Guide|Calculating a Composite|Writing Test Scoring|Conversion of Raw Scores/i;
  const romanFix = (t) => t.replace(/^(\s*PASSAGE\s+)(\S+)/i, (m, a, r) => a + r.replace(/[l|1]/g, 'I'));
  const PASSAGE_RE = /^\s*PASSAGE\s+([IVX]{1,4}|[Il|1]{1,3}V?|V[Il|1]{0,3})(?=\s|$|[^A-Za-z])/i; // OCR reads I as l, | or 1
  const LADDERS = [['A', 'B', 'C', 'D', 'E'], ['F', 'G', 'H', 'J', 'K']];
  // "A. text", "12. F. text", and OCR variants with a stray glyph first ("» F. NO CHANGE", "te4. F.")
  const JUNK_LEAD = /^(?:[^A-Za-z\s]{1,4}\s+|[a-z]{0,2}\d{1,2}[.,]\s*)/;
  function labelInText(text) {
    let t = text.trim();
    for (let k = 0; k < 2; k++) {
      const m = t.match(/^([A-HJK])[.,](\s|$)/);
      if (m) return m[1];
      const j = t.match(JUNK_LEAD);
      if (!j) return null;
      t = t.slice(j[0].length);
    }
    const m = t.match(/^([A-K])[.,](\s|$)/);
    return m ? m[1] : null;
  }
  const DEFAULT_MINUTES = {
    english: { 75: 45, 50: 35 }, math: { 60: 60, 45: 50 }, reading: { 40: 35, 36: 40 }, science: { 40: 40 },
  };

  const clean = (s) => s
    .replace(/[‐‑]/g, '-').replace(/ /g, ' ')
    .replace(/ﬁ/g, 'fi').replace(/ﬂ/g, 'fl').replace(/ﬀ/g, 'ff').replace(/ﬃ/g, 'ffi').replace(/ﬄ/g, 'ffl');

  // ---------- measurement helper for mapping x-positions to characters ----------
  const mctx = document.createElement('canvas').getContext('2d');
  function charCenters(item) {
    const s = item.s;
    if (!s.length) return [];
    mctx.font = `${item.italic ? 'italic ' : ''}${item.bold ? 'bold ' : ''}100px ${item.serif ? '"Times New Roman", Times, serif' : 'Helvetica, Arial, sans-serif'}`;
    const total = mctx.measureText(s).width || 1;
    const k = item.w / total;
    const out = [];
    let acc = 0;
    for (let i = 0; i < s.length; i++) {
      const cw = mctx.measureText(s[i]).width;
      out.push(item.x + (acc + cw / 2) * k);
      acc += cw;
    }
    return out;
  }

  // ---------- page extraction ----------
  async function extractPage(pdf, pno) {
    const page = await pdf.getPage(pno);
    const vp = page.getViewport({ scale: 1 });
    const W = vp.width, H = vp.height;
    const ol = await page.getOperatorList();
    const tc = await page.getTextContent();
    const fontCache = {};
    const fontInfo = (id) => {
      if (fontCache[id]) return fontCache[id];
      let name = '';
      try { name = page.commonObjs.get(id).name || ''; } catch (e) { /* not loaded */ }
      return (fontCache[id] = {
        name,
        italic: /Italic|Oblique|-It\b|It$/i.test(name),
        bold: /Bold|Black|Heavy|Semibold|Demi/i.test(name),
        serif: !/Helvet|Arial|Sans|Montserrat|Univers|Frutiger|Myriad|Gothic/i.test(name),
        math: /Math|Symbol|MTExtra|MT Extra|Cambria/i.test(name),
        box: /BOX/i.test(name),
      });
    };

    const items = [];
    const seenItems = new Set();
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      const t = it.transform;
      const fs = Math.hypot(t[2], t[3]) || it.height || 10;
      if (Math.abs(t[1]) > 0.01 * fs) {
        // rotated text (axis titles, slanted tick labels) – only ever part of a figure
        const len = Math.hypot(t[0], t[1]) || 1;
        const ux = t[0] / len, uy = t[1] / len;
        const w = it.width, hgt = fs;
        const pts = [[0, 0], [ux * w, uy * w], [-uy * hgt, ux * hgt], [ux * w - uy * hgt, uy * w + ux * hgt]].map(([dx, dy]) => [t[4] + dx, H - (t[5] + dy)]);
        const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
        items.push({ s: clean(it.str), rot: true, x: Math.min(...xs), x1: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys), y: H - t[5], w: Math.max(...xs) - Math.min(...xs), h: fs, ...fontInfo(it.fontName) });
        continue;
      }
      const h = it.height || fs;
      const y = H - t[5];
      // some PDFs draw every string twice (fake bold / duplicate layer)
      const dk = `${it.str}|${Math.round(t[4])}|${Math.round(y)}`;
      if (seenItems.has(dk)) continue;
      seenItems.add(dk);
      const mk = (str, x, w) => ({
        s: clean(str), x, y, w, h, x1: x + w,
        top: y - h * (/^[_⏜‾⌢]+$/.test(str.trim()) ? 0.3 : 0.8), bottom: y + h * 0.22, ...fontInfo(it.fontName),
      });
      // strings padded with long runs of spaces ("5          C") are really separate pieces
      if (/\S\s{3,}\S/.test(it.str) && it.str.length) {
        const per = it.width / it.str.length;
        for (const m of it.str.matchAll(/\S(?:.*?\S)?(?=\s{3,}|\s*$)/g)) items.push(mk(m[0], t[4] + m.index * per, m[0].length * per));
        continue;
      }
      items.push(mk(it.str, t[4], it.width));
    }

    // ---- vector graphics & images with CTM tracking ----
    const O = pdfjsLib.OPS;
    let ctm = [1, 0, 0, 1, 0, 0];
    let fillWhite = false;
    const stack = [];
    const gfx = [];
    let cur = null;
    const mul = (a, b) => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
    const tp = (x, y) => [ctm[0] * x + ctm[2] * y + ctm[4], H - (ctm[1] * x + ctm[3] * y + ctm[5])];
    const paintOps = new Set([O.stroke, O.closeStroke, O.fill, O.eoFill, O.fillStroke, O.eoFillStroke, O.closeFillStroke, O.closeEOFillStroke, O.shadingFill]);
    const fillOnly = new Set([O.fill, O.eoFill]);
    for (let i = 0; i < ol.fnArray.length; i++) {
      const f = ol.fnArray[i], a = ol.argsArray[i];
      if (f === O.save) stack.push([ctm, fillWhite]);
      else if (f === O.restore) { const s = stack.pop(); if (s) [ctm, fillWhite] = s; }
      else if (f === O.transform) ctm = mul(ctm, a);
      else if (f === O.paintFormXObjectBegin) { stack.push([ctm, fillWhite]); if (a && a[0]) ctm = mul(ctm, a[0]); }
      else if (f === O.paintFormXObjectEnd) { const s = stack.pop(); if (s) [ctm, fillWhite] = s; }
      else if (f === O.setFillRGBColor) {
        const c = typeof a[0] === 'string' ? a[0] : null;
        if (c) fillWhite = /^#?f[a-f0-9]f[a-f0-9]f[a-f0-9]$/i.test(c) || c.toLowerCase() === '#ffffff';
        else fillWhite = a[0] > 240 && a[1] > 240 && a[2] > 240;
      } else if (f === O.setFillGray) fillWhite = a[0] > 0.94;
      else if (f === O.setFillCMYKColor) fillWhite = a[0] + a[1] + a[2] + a[3] < 0.06;
      else if (f === O.constructPath) {
        const [opsA, coords] = a;
        const xs = [], ys = [];
        let k = 0;
        for (const op of opsA) {
          const take = (n) => { for (let j = 0; j < n; j++) { const q = tp(coords[k], coords[k + 1]); k += 2; xs.push(q[0]); ys.push(q[1]); } };
          if (op === O.rectangle) {
            const [x, y, w, h] = coords.slice(k, k + 4); k += 4;
            for (const [px, py] of [[x, y], [x + w, y + h], [x + w, y], [x, y + h]]) { const q = tp(px, py); xs.push(q[0]); ys.push(q[1]); }
          } else if (op === O.moveTo || op === O.lineTo) take(1);
          else if (op === O.curveTo) take(3);
          else if (op === O.curveTo2 || op === O.curveTo3) take(2);
        }
        if (xs.length) cur = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
      } else if (paintOps.has(f)) {
        if (cur && !(fillOnly.has(f) && fillWhite)) gfx.push({ ...cur, stroke: !fillOnly.has(f) });
        cur = null;
      } else if (f === O.endPath) cur = null;
      else if (f === O.paintImageXObject || f === O.paintInlineImageXObject || f === O.paintImageMaskXObject || f === O.paintImageXObjectRepeat) {
        const q = [tp(0, 0), tp(1, 1), tp(0, 1), tp(1, 0)];
        gfx.push({ x0: Math.min(...q.map((p) => p[0])), y0: Math.min(...q.map((p) => p[1])), x1: Math.max(...q.map((p) => p[0])), y1: Math.max(...q.map((p) => p[1])), img: true });
      }
    }
    page.cleanup();
    return { pno, W, H, items, gfx };
  }

  // ---------- chrome, lines, clusters ----------
  function prepPage(pg) {
    const { W, H } = pg;
    const topCut = H * 0.1, botCut = H * 0.935;
    pg.hasEnd = false;
    const keep = [];
    // Detect whole chrome phrases first on joined line text (e.g. "GO ON TO THE NEXT PAGE.")
    for (const it of pg.items) {
      if (END_RE.test(it.s)) pg.hasEnd = true;
      if (it.h >= 28) continue; // giant section digits
      if (it.y < topCut || it.top > botCut) continue;
      if (CHROME_RE.test(it.s)) continue;
      keep.push(it);
    }
    // scanned pages: the header row with the big section digit (and its circles) is chrome too
    if (pg.ocr && keep.length) {
      const hs = keep.map((i) => i.h).sort((a, b) => a - b);
      const medH = hs[hs.length >> 1] || 10;
      const bands = keep.filter((i) => i.h >= medH * 2.4 && /^[\dOo○0\s]+$/.test(i.s)).map((i) => [i.top - 4, i.bottom + 6]);
      if (bands.length) {
        const inBand = (y0, y1) => bands.some(([a, b]) => (y0 + y1) / 2 > a && (y0 + y1) / 2 < b);
        for (let i = keep.length - 1; i >= 0; i--) if (inBand(keep[i].top, keep[i].bottom)) keep.splice(i, 1);
        pg.gfx = pg.gfx.filter((g) => !inBand(g.y0, g.y1));
      }
    }
    pg.body = keep;
    pg.mid = W / 2;
    const colOf = (x0, x1) => (x0 < pg.mid - 25 && x1 > pg.mid + 25 ? 'F' : (x0 + x1) / 2 < pg.mid ? 0 : 1);

    // lines
    const sorted = keep.filter((i) => !i.rot).sort((a, b) => a.y - b.y || a.x - b.x);
    let lines = [];
    for (const it of sorted) {
      const c = (it.x + it.x1) / 2 < pg.mid ? 0 : 1;
      let L = null;
      for (let j = lines.length - 1; j >= 0 && j >= lines.length - 8; j--) {
        const l = lines[j];
        if ((l.c === c || Math.abs(it.x - l.xr) < it.h * 1.5) && Math.abs(l.y - it.y) < 1.6) { L = l; break; }
      }
      if (L) { L.items.push(it); L.xr = Math.max(L.xr, it.x1); } else lines.push({ c, y: it.y, items: [it], page: pg.pno, xr: it.x1 });
    }
    // split lines at wide horizontal gaps (side-by-side choices, table cells, tick labels)
    const colMin = [Infinity, Infinity];
    // column left edges from items that sit wholly inside a column (full-width headings would skew them)
    for (const it of sorted) {
      if (it.x < pg.mid - 5 && it.x1 > pg.mid + 5) continue;
      const c = (it.x + it.x1) / 2 < pg.mid ? 0 : 1;
      if (c === 1 && it.x < pg.mid - 5) continue;
      colMin[c] = Math.min(colMin[c], it.x);
    }
    const split = [];
    for (const l of lines) {
      l.items.sort((a, b) => a.x - b.x);
      let cur = { ...l, items: [l.items[0]] };
      split.push(cur);
      for (let k = 1; k < l.items.length; k++) {
        const prev = l.items[k - 1], it = l.items[k];
        const h = Math.max(prev.h, it.h);
        const lineNo = k === 1 && /^\d{1,3}$/.test(prev.s.trim()) && prev.h < it.h - 0.5 && prev.x - colMin[l.c] < 24; // reading line numbers sit at the column's left edge
        const afterLabel = k === 1 && /^[A-K]\.$/.test(prev.s.trim()) && it.x - prev.x1 > 12;
        const afterNum = k === 1 && /^\d{1,2}\.$/.test(prev.s.trim()) && it.x - prev.x1 < 5 * h; // "32. [F. lost by OCR] NO CHANGE"
        if (!lineNo && !afterNum && (afterLabel || it.x - prev.x1 > Math.max(2.2 * h, 16))) { cur = { ...l, items: [it] }; split.push(cur); } else cur.items.push(it);
      }
    }
    lines = split;
    for (const l of lines) finishLine(l);
    // text scale of this page (1 ≈ 10pt body type; scans are often printed smaller)
    const k = (pg.k = Math.max(0.5, Math.min(1.6, modeH(lines) / 10)));

    // merge sub/superscripts into their host line
    const small = lines.filter((l) => l.h <= 7.6 * k);
    for (const s of small) {
      let best = null, bd = 99;
      for (const l of lines) {
        if (l === s || l.h <= 7.6 * k || l.c !== s.c) continue;
        const d = s.y - l.y;
        if (d < -6.5 * k || d > 4.2 * k) continue;
        if (s.x0 > l.x1 + 6 || s.x1 < l.x0 - 6) continue;
        if (Math.abs(d) < bd) { bd = Math.abs(d); best = l; }
      }
      if (best) {
        const d = s.y - best.y;
        for (const it of s.items) { if (d > 1) it.sub = true; else if (d < -1) it.sup = true; best.items.push(it); }
        finishLine(best);
        s.dead = true;
      }
    }
    lines = lines.filter((l) => !l.dead);
    // a line number printed on its own baseline ("55") belongs to the text line beside it
    for (const l of lines) {
      if (l.dead || !/^\d{1,3}$/.test(l.text) || +l.text % 5 || l.x0 - colMin[l.c] > 24) continue;
      const host = lines.find((o) => o !== l && !o.dead && o.c === l.c && Math.abs(o.y - l.y) < 6 && o.x0 > l.x1 && o.x0 - l.x1 < 30);
      if (host) { for (const it of l.items) { it.lnum = true; host.items.unshift(it); } finishLine(host); l.dead = true; }
    }
    // page furniture that OCR splits into separate words ("GO ON TO THE NEXT PAGE.")
    lines = lines.filter((l) => !l.dead && !CHROME_RE.test(l.text));
    for (const l of lines) l.c = colOf(l.x0, l.x1);

    // graphics → clusters
    const g = pg.gfx.filter((b) => {
      const w = b.x1 - b.x0, h = b.y1 - b.y0;
      if (b.y1 < topCut || b.y0 > botCut) return false;
      if (w > W * 0.8 && h < 2.5) return false; // page rules
      if (w > W * 0.8 && h > H * 0.7) return false; // page frames
      if (w < 0.3 && h < 0.3) return false;
      return true;
    });
    // a filled (unstroked) box with lines of text inside is a background panel, not a figure
    for (let i = g.length - 1; i >= 0; i--) {
      const b = g[i];
      if (b.img || (b.x1 - b.x0) * (b.y1 - b.y0) < 1500) continue;
      const inside = lines.filter((l) => {
        const cy = (l.top + l.bottom) / 2, ov = Math.min(l.x1, b.x1) - Math.max(l.x0, b.x0);
        return cy > b.y0 && cy < b.y1 && ov > 0.5 * (l.x1 - l.x0) && l.h >= 8 && /[a-z]{3,}/.test(l.text) &&
          (!b.stroke || l.text.split(/\s+/).length >= 5); // an outlined box only counts as a panel if it holds prose
      }).length;
      if (b.stroke && inside < 3) continue;
      if (inside >= 2) g.splice(i, 1);
    }
    pg.hlines = g.filter((b) => b.y1 - b.y0 < 1.6 && b.x1 - b.x0 > 3 && !b.img);
    pg.clusters = [];
    return { lines, g: g.filter((b) => !b.light) };
  }

  function finishLine(l) {
    l.items.sort((a, b) => a.x - b.x);
    l.x0 = Math.min(...l.items.map((i) => i.x));
    l.x1 = Math.max(...l.items.map((i) => i.x1));
    l.top = Math.min(...l.items.map((i) => i.top));
    l.bottom = Math.max(...l.items.map((i) => i.bottom));
    const main = l.items.filter((i) => !i.sub && !i.sup);
    l.h = Math.max(...(main.length ? main : l.items).map((i) => i.h));
    l.text = lineText(l.items);
  }

  function lineText(items) {
    let s = '', prev = null;
    for (const it of items) {
      if (prev) {
        const gap = it.x - prev.x1;
        if (gap > Math.max(prev.h, it.h) * 0.18 && !/\s$/.test(s) && !/^\s/.test(it.s)) s += ' ';
      }
      s += it.s;
      prev = it;
    }
    return s.replace(/\s+/g, ' ').trim();
  }

  // Build figure clusters from graphics, absorbing nearby labels / captions.
  function buildClusters(pg, lines, g, { skipUnderlines }) {
    pg.labelBoxes = lines.filter((l) => /^[A-K]\.(\s|$)/.test(l.text)).map((l) => ({ x0: l.x0, x1: l.x0 + 12, y0: l.top, y1: l.bottom }));
    // marks drawn on a text line (radical overlines, fraction bars, strike rules) belong to the text, not to a figure
    const inline = (b) => !b.img && b.y1 - b.y0 < 14 && lines.some((l) => l.top - 3 < b.y1 && b.y0 < l.bottom + 1 &&
      b.x0 < l.x1 + 2 && b.x1 > l.x0 - 2 && b.x1 - b.x0 < l.x1 - l.x0 + 20);
    let boxes = g.filter((b) => !(skipUnderlines && b.y1 - b.y0 < 1.6 && !b.img) && !inline(b));
    // drop tiny boxes drawn around English question numbers (they sit on text lines)
    boxes = boxes.map((b) => ({ ...b, m: [{ x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 }] }));
    const pad = 7;
    let merged = true;
    while (merged) {
      merged = false;
      outer: for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        if (shouldMerge(a, b, pad, pg)) {
          a.x0 = Math.min(a.x0, b.x0); a.y0 = Math.min(a.y0, b.y0); a.x1 = Math.max(a.x1, b.x1); a.y1 = Math.max(a.y1, b.y1);
          a.n = (a.n || 1) + (b.n || 1); a.img = a.img || b.img; a.m = a.m.concat(b.m);
          boxes.splice(j, 1); merged = true; break outer;
        }
      }
    }
    // a merged drawing that holds several answer labels is a grid of choice figures: split it,
    // giving each piece to the label above and to the left of it
    const labsHere = pg.labelBoxes || [];
    for (let i = boxes.length - 1; i >= 0; i--) {
      const b = boxes[i];
      const inL = labsHere.filter((L) => L.y0 >= b.y0 - 26 && L.y0 <= b.y1 && L.x0 >= b.x0 - 45 && L.x0 <= b.x1);
      if (inL.length < 2 || !b.m || b.m.length < 2) continue;
      const groups = new Map();
      // a single path spanning several of the figures (shared tick marks, etc.) can't be split — skip it
      const bw = b.x1 - b.x0, bh = b.y1 - b.y0;
      for (const p of b.m) {
        if (p.x1 - p.x0 > bw * 0.55 || p.y1 - p.y0 > bh * 0.55) continue;
        const cx = (p.x0 + p.x1) / 2, cy = (p.y0 + p.y1) / 2;
        let best = null;
        for (const L of inL) {
          if (L.y0 > cy + 6 || L.x0 > cx) continue;
          if (!best || L.y0 > best.y0 + 3 || (Math.abs(L.y0 - best.y0) <= 3 && L.x0 > best.x0)) best = L;
        }
        if (!best) best = inL.reduce((a, L) => (Math.hypot(L.x0 - cx, L.y0 - cy) < Math.hypot(a.x0 - cx, a.y0 - cy) ? L : a));
        if (!groups.has(best)) groups.set(best, []);
        groups.get(best).push(p);
      }
      if (groups.size < 2) continue;
      const parts = [...groups.values()].map((ps) => ({
        x0: Math.min(...ps.map((p) => p.x0)), y0: Math.min(...ps.map((p) => p.y0)), x1: Math.max(...ps.map((p) => p.x1)), y1: Math.max(...ps.map((p) => p.y1)),
        m: ps, n: ps.length, img: b.img, split: true,
      }));
      boxes.splice(i, 1, ...parts);
    }
    // ignore trivially small clusters (bullets, boxes around single numbers)
    const clusters = boxes.filter((b) => b.img || ((b.x1 - b.x0) > 14 && (b.y1 - b.y0) > 10));
    // absorb text into clusters
    const bodyH = modeH(lines);
    const labs = pg.labelBoxes;
    // a choice label between the drawing and some text means that text belongs to another choice
    const crossesLabel = (cl, top, bottom) => {
      const cy = (top + bottom) / 2;
      return labs.some((L) => {
        const lc = (L.y0 + L.y1) / 2;
        if (L.x0 > cl.raw[2] + 10 || L.x0 < cl.raw[0] - 60) return false;
        return (lc > cl.raw[3] - 4 && lc < cy - 2) || (lc < cl.raw[1] + 8 && lc > cy + 2);
      });
    };
    for (const cl of clusters) {
      cl.lines = new Set();
      cl.raw = [cl.x0, cl.y0, cl.x1, cl.y1];
      let changed = true, guard = 0;
      while (changed && guard++ < 12) {
        changed = false;
        for (const l of lines) {
          if (cl.lines.has(l)) continue;
          const onChoiceRow = labs.some((L) => Math.abs((L.y0 + L.y1) / 2 - (l.top + l.bottom) / 2) < 9 && l.x0 > L.x0 && l.x0 - L.x1 < 150);
          const smallText = !onChoiceRow && (l.h < bodyH - 0.6 || /^[\d\s.,−–\-%°$=+]+$/.test(l.text) ||
            (l.x1 - l.x0 < 60 && l.text.split(' ').length <= 4 && !/[A-Za-z].*[.?!:;]$/.test(l.text) && (l.text.length <= 3 || !/[.?!:;]$/.test(l.text))));
          const m = smallText ? 9 : 2.5;
          const below = smallText ? 14 : m;
          const inside = l.x0 < cl.x1 + m && l.x1 > cl.x0 - m && l.top < cl.y1 + below && l.bottom > cl.y0 - m;
          // tiny label right above a drawing and within its width (axis titles like "y") is part of it
          const axisTitle = l.text.length <= 3 && l.x0 >= cl.x0 - 4 && l.x1 <= cl.x1 + 4 && l.bottom <= cl.y0 + 2 && cl.y0 - l.bottom < 12 && !/^[A-K][.,]$/.test(l.text) && !/[?.:,;]$/.test(l.text);
          if (!inside && !axisTitle) continue;
          if (!axisTitle && crossesLabel(cl, l.top, l.bottom)) continue;
          if (labs.some((L) => l.x0 >= L.x0 && l.x0 - L.x1 < 16 && l.top < L.y1 + 6 && l.bottom > L.y0 - 6)) continue;
          // a body-size line only joins if it is mostly inside horizontally
          if (!smallText) {
            const ov = Math.min(l.x1, cl.x1) - Math.max(l.x0, cl.x0);
            if (ov < (l.x1 - l.x0) * 0.6) continue;
            // full-size text only joins when it sits inside the drawing itself (labels, table cells)
            const cy = (l.top + l.bottom) / 2;
            if (cy < cl.raw[1] || cy > cl.raw[3]) continue;
          }
          if (/^\s*(\d{1,2}\.|[A-K]\.)(\s|$)/.test(l.text) || PASSAGE_RE.test(l.text)) continue;
          if (/^\s*\d{1,2}\.\s/.test(l.text) && l.top < cl.y0 - 1) continue; // never swallow a question start
          cl.lines.add(l); changed = true;
          cl.x0 = Math.min(cl.x0, l.x0); cl.x1 = Math.max(cl.x1, l.x1); cl.y0 = Math.min(cl.y0, l.top); cl.y1 = Math.max(cl.y1, l.bottom);
        }
        // rotated axis titles
        for (const it of pg.body) if (it.rot && it.x < cl.x1 + 14 && it.x1 > cl.x0 - 14 && it.top < cl.y1 + 14 && it.bottom > cl.y0 - 14 && !crossesLabel(cl, it.top, it.bottom)) {
          if (it.x < cl.x0) { cl.x0 = it.x; changed = true; }
          if (it.x1 > cl.x1) { cl.x1 = it.x1; changed = true; }
          if (it.top < cl.y0) { cl.y0 = it.top; changed = true; }
          if (it.bottom > cl.y1) { cl.y1 = it.bottom; changed = true; }
        }
      }
      // captions: "Table 1", "Figure 2" directly above
      for (const l of lines) {
        if (cl.lines.has(l)) continue;
        if (!/^(Table|Figure|Diagram|Key)\s*\d*[A-Za-z]?\.?$/i.test(l.text.trim()) || l.x1 < cl.x0 - 10 || l.x0 > cl.x1 + 10) continue;
        const above = l.bottom <= cl.y0 + 2 && cl.y0 - l.bottom < 18;
        const under = l.top >= cl.y1 - 2 && l.top - cl.y1 < 18;
        if (above || under) {
          cl.lines.add(l);
          cl.x0 = Math.min(cl.x0, l.x0); cl.x1 = Math.max(cl.x1, l.x1); cl.y0 = Math.min(cl.y0, l.top); cl.y1 = Math.max(cl.y1, l.bottom);
        }
      }
      cl.c = cl.x0 < pg.mid - 25 && cl.x1 > pg.mid + 25 ? 'F' : (cl.x0 + cl.x1) / 2 < pg.mid ? 0 : 1;
    }
    // merge clusters that now overlap
    for (let i = 0; i < clusters.length; i++) for (let j = clusters.length - 1; j > i; j--) {
      const a = clusters[i], b = clusters[j];
      if (!(a.split && b.split) && shouldMerge(a, b, 3, pg)) {
        a.x0 = Math.min(a.x0, b.x0); a.y0 = Math.min(a.y0, b.y0); a.x1 = Math.max(a.x1, b.x1); a.y1 = Math.max(a.y1, b.y1);
        for (const l of b.lines) a.lines.add(l);
        clusters.splice(j, 1);
      }
    }
    return clusters;
  }

  function shouldMerge(a, b, pad, pg) {
    const labs = pg.labelBoxes || [];
    if (labs.length) {
      // never glue together two answer-choice figures: a choice label heading the lower/right box
      const upper = a.y0 <= b.y0 ? a : b, lower = upper === a ? b : a;
      if (labs.some((L) => L.y0 > upper.y0 + 4 && Math.abs(L.y0 - lower.y0) < 16 && L.x0 < lower.x0 + 12 && L.x0 > lower.x0 - 60)) return false;
      const left = a.x0 <= b.x0 ? a : b, right = left === a ? b : a;
      if (labs.some((L) => L.x0 > left.x0 + 4 && L.x0 < right.x0 + 12 && L.x0 > right.x0 - 60 && Math.abs(L.y0 - right.y0) < 16 && L.y0 < left.y1)) return false;
    }
    if (a.x0 - pad <= b.x1 && b.x0 - pad <= a.x1 && a.y0 - pad <= b.y1 && b.y0 - pad <= a.y1) return true;
    // parts of one figure drawn side by side in the same column
    const vOver = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
    const gx0 = Math.min(a.x1, b.x1), gx1 = Math.max(a.x0, b.x0);
    if ((pg.labelBoxes || []).some((L) => L.x0 >= gx0 - 4 && L.x0 <= gx1 && L.y1 > Math.max(a.y0, b.y0) - 12 && L.y0 < Math.min(a.y1, b.y1))) return false;
    return vOver > 0.4 * Math.min(a.y1 - a.y0, b.y1 - b.y0) && Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1) < 40 &&
      ((a.x0 + a.x1) / 2 < pg.mid) === ((b.x0 + b.x1) / 2 < pg.mid);
  }

  function modeH(lines) {
    const counts = {};
    for (const l of lines) { const k = Math.round(l.h * 2) / 2; counts[k] = (counts[k] || 0) + (l.x1 - l.x0); }
    let best = 10, bc = -1;
    for (const k in counts) if (counts[k] > bc) { bc = counts[k]; best = +k; }
    return best;
  }

  // Reading-order stream of elements (lines + figure clusters) for one page.
  function pageStream(pg, lines, clusters) {
    const used = new Set();
    for (const cl of clusters) for (const l of cl.lines) used.add(l);
    const els = [];
    for (const l of lines) if (!used.has(l)) els.push({ type: 'line', c: l.c, top: l.top, y: l.y, page: pg.pno, line: l, _ocr: !!pg.ocr });
    for (const cl of clusters) els.push({ type: 'fig', c: cl.c, top: cl.y0, y: cl.y0, page: pg.pno, rect: [cl.x0, cl.y0, cl.x1, cl.y1], cl, _ocr: !!pg.ocr });
    const full = els.filter((e) => e.c === 'F').sort((a, b) => a.top - b.top);
    const out = [];
    let lastY = -1;
    const cuts = [...full.map((f) => f.top), Infinity];
    let fi = 0;
    for (const cut of cuts) {
      const band = els.filter((e) => e.c !== 'F' && e.top >= lastY && e.top < cut);
      band.sort((a, b) => a.c - b.c || a.top - b.top);
      out.push(...band);
      if (fi < full.length) { out.push(full[fi]); lastY = full[fi].top; fi++; }
    }
    return out;
  }

  // ---------- document-level ----------
  async function inkMap(page, s) {
    const vp = page.getViewport({ scale: s });
    const c = document.createElement('canvas');
    c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp, intent: 'print' }).promise;
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    const d = new Uint8Array(c.width * c.height);
    for (let i = 0, j = 0; i < d.length; i++, j += 4) d[i] = data[j] * 0.3 + data[j + 1] * 0.59 + data[j + 2] * 0.11 < 110 ? 1 : 0;
    const out = { s, w: c.width, h: c.height, d };
    c.width = c.height = 0;
    return out;
  }

  // ---------- quick index (fast, text only) for picking a test out of a big book ----------
  async function scanPdf(data, onProgress) {
    const pdf = await pdfjsLib.getDocument({ data: data.slice(0) }).promise;
    const n = pdf.numPages;
    const texts = [];
    for (let p = 1; p <= n; p++) {
      const page = await pdf.getPage(p);
      const tc = await page.getTextContent();
      let t = '';
      for (const it of tc.items) { t += it.str; t += it.hasEOL ? '\n' : ''; }
      texts.push(clean(t));
      page.cleanup();
      if (p % 10 === 0 || p === n) onProgress && onProgress(p / n, `Indexing page ${p} of ${n}`);
    }
    await pdf.destroy();
    const chars = texts.map((t) => t.replace(/\s/g, '').length);
    const cands = [];
    // (a) tests with a text layer: runs of section headings
    const kindAt = (t) => HEADINGS.filter(([, re]) => t.split('\n').some((l) => re.test(l.replace(/\s+/g, ' ').trim()))).map(([k]) => k);
    let cur = null;
    for (let i = 0; i < n; i++) {
      for (const k of kindAt(texts[i])) {
        const ki = KINDS.indexOf(k);
        if (!cur || ki <= cur.lastKi) { cur = { scanned: false, start: i + 1, end: i + 1, kinds: [], lastKi: -1 }; cands.push(cur); }
        cur.kinds.push(k); cur.lastKi = ki; cur.end = i + 1;
      }
      if (cur && i + 1 > cur.end && !NONTEST_RE.test(texts[i]) && chars[i] > 40 && !/EXPLANATORY ANSWERS/i.test(texts[i])) cur.end = i + 1;
      if (cur && (NONTEST_RE.test(texts[i]) || /EXPLANATORY ANSWERS/i.test(texts[i])) && i + 1 > cur.end) cur = cur.closed ? cur : Object.assign(cur, { closed: true });
    }
    for (const c of cands) {
      // trim trailing pages that are clearly not the test
      while (c.end > c.start && (NONTEST_RE.test(texts[c.end - 1]) || /EXPLANATORY ANSWERS|best answer is/i.test(texts[c.end - 1]))) c.end--;
    }
    // (b) scanned tests: long runs of pages without text
    let runStart = null;
    for (let i = 0; i <= n; i++) {
      const empty = i < n && chars[i] < 40;
      if (empty && runStart == null) runStart = i;
      if (!empty && runStart != null) {
        if (i - runStart >= 8) cands.push({ scanned: true, start: runStart + 1, end: i, kinds: [] });
        runStart = null;
      }
    }
    cands.sort((a, b) => a.start - b.start);
    // labels, explanation pages, key pages
    let ordinal = 0;
    for (let ci = 0; ci < cands.length; ci++) {
      const c = cands[ci];
      const nextStart = ci + 1 < cands.length ? cands[ci + 1].start : n + 1;
      let label = null;
      for (const i of [c.end, c.end + 1, c.end + 2, c.start - 2, c.start - 3, c.start - 1, c.start]) {
        const t = texts[i - 1] || '';
        const m = t.match(/PRACTICE TEST\s*(\d+)/i) || (i === c.start || i === c.start - 1 ? t.match(/\bForm\s+([A-Z0-9]{2,6})\b/) : null);
        if (m) { label = /form/i.test(m[0]) ? `Form ${m[1]}` : `Practice Test ${m[1]}`; break; }
      }
      ordinal++;
      c.label = label;
      c.ordinal = ordinal;
      c.num = (label && label.match(/\d+/)) ? +label.match(/\d+/)[0] : ordinal;
      // explanatory answers right after the test
      // (sometimes behind a few scoring pages)
      const isExpl = (t) => /(best|correct) answer is\s+[A-K]\b/i.test(t);
      let e = c.end + 1;
      while (e < nextStart && e <= n && !isExpl(texts[e - 1]) && e - c.end < 30) e++;
      if (e < nextStart && e <= n && isExpl(texts[e - 1])) {
        const s0 = e;
        let last = e;
        while (e + 1 < nextStart && e + 1 <= n && e - last <= 4) {
          const t = texts[e];
          if (/^\s*(Chapter\s+\d|Part\s+\w+:|Scoring Your|Scoring Practice)/im.test(t.slice(0, 120))) break;
          e++;
          if (isExpl(t)) last = e;
        }
        c.expl = [s0, last];
      }
    }
    const anyPT = cands.some((c) => /Practice Test/.test(c.label || '')) || texts.some((t) => /Practice Test/i.test(t));
    for (const c of cands) if (!c.label) c.label = cands.length > 1 ? (anyPT ? `Practice Test ${c.ordinal}` : `Test ${c.ordinal}`) : '';
    // scoring-key pages: text keys labelled with the practice test, or scanned pages right after "Scoring Practice Test N"
    let lastKey = null;
    for (let i = 0; i < n; i++) {
      const t = texts[i];
      const lab = t.match(/PRACTICE TEST\s*(\d+)/i);
      const isKey = /Scoring Key|Answer Key/i.test(t) && (t.match(/\b\d{1,2}\.\s*[A-K]\b/g) || []).length + (t.match(/^\s*[A-K]\s*$/gm) || []).length >= 8;
      const target = (num) => cands.find((c) => c.num === num) || null;
      // a key that runs onto the next page: that page has only column headers ("English | Number | Correct Answer")
      const keyCont = !isKey && lastKey && lastKey.page === i && /Correct\s*Answer/i.test(t) && (t.match(/^\s*[A-K]\s*$/gm) || []).length + (t.match(/\b\d{1,2}\.?\s+[A-K]\b/g) || []).length >= 8;
      if (keyCont) { lastKey.c.keyPages.push(i + 1); lastKey.page = i + 1; continue; }
      if (isKey) {
        if (/Sample Questions/i.test(t)) continue;
        const c = lab ? target(+lab[1]) : (cands.length === 1 ? cands[0] : cands.filter((c) => c.end < i + 1 && i + 1 - c.end <= 12).pop());
        if (c) { (c.keyPages = c.keyPages || []).push(i + 1); lastKey = { c, page: i + 1 }; }
      } else if (/Scoring (Your )?Practice Test/i.test(t) || /Scoring Your (First )?Practice Test/i.test(t)) {
        const num = lab ? +lab[1] : null;
        const c = num != null ? target(num) : cands.filter((c) => c.end < i + 1).pop();
        if (!c) continue;
        for (let j = i + 1; j < Math.min(n, i + 7); j++) if (chars[j] < 40) (c.keyScans = c.keyScans || []).push(j + 1);
      }
    }
    return { numPages: n, texts, candidates: cands.map((c) => ({ label: c.label, start: c.start, end: c.end, scanned: c.scanned, kinds: c.kinds, expl: c.expl || null, keyPages: c.keyPages || [], keyScans: c.keyScans || [] })) };
  }

  // Answers (and their explanations) from "Explanatory Answers" pages.
  function parseExplanations(texts, range) {
    const out = {};
    if (!range) return out;
    const order = ['english', 'math', 'reading', 'science'];
    let kind = null, last = 0;
    for (let p = range[0]; p <= range[1]; p++) {
      const t = texts[p - 1] || '';
      const hk = t.match(/\b(ENGLISH|MATHEMATICS|READING|SCIENCE)\b[^\n]{0,40}EXPLANATORY ANSWERS/i);
      const re = /(?:^|\n)\s*(?:Question\s+)?(\d{1,2})\.\s+(?:The\s+)?(?:best|correct) answer is\s+([A-K])\b/gi;
      const ms = [...t.matchAll(re)];
      for (let k = 0; k < ms.length; k++) {
        const m = ms[k];
        const qn = +m[1];
        if (hk && (!kind || kind !== hk[1].toLowerCase().replace('mathematics', 'math'))) {
          const hkKind = hk[1].toLowerCase().replace('mathematics', 'math');
          if (!kind || (qn <= 2 && hkKind !== kind)) { kind = hkKind; last = 0; }
        }
        if (qn < last - 3 && qn <= 2) { kind = order[order.indexOf(kind) + 1] || kind; last = 0; }
        if (!kind) kind = 'english';
        last = qn;
        const endIdx = k + 1 < ms.length ? ms[k + 1].index : t.length;
        const text = t.slice(m.index, Math.min(endIdx, m.index + 1800)).replace(/\s*\n\s*/g, ' ').trim();
        const bucket = (out[kind] = out[kind] || {});
        if (!bucket[qn]) bucket[qn] = { ans: m[2].toUpperCase(), text };
        else if (bucket[qn].text.length < 1600) bucket[qn].text += ' ' + text.replace(/^(?:Question\s+)?\d{1,2}\.\s*/, '');
      }
      // continuation text on pages without a new "Question N." (explanations spill over)
    }
    return out;
  }

  async function analyzePdf(data, onProgress, opts = {}) {
    const pdf = await pdfjsLib.getDocument({ data: data.slice(0) }).promise;
    const n = pdf.numPages;
    const want = opts.pages ? new Set(opts.pages) : null;
    const ocrSet = new Set(opts.ocr || []);
    const pages = [];
    let done = 0;
    const total = want ? want.size : n;
    for (let p = 1; p <= n; p++) {
      if (want && !want.has(p)) { pages.push({ pno: p, W: 612, H: 792, items: [], gfx: [], stub: true }); continue; }
      pages.push(await extractPage(pdf, p));
      done++;
      onProgress && onProgress(done / total * (ocrSet.size ? 0.15 : 0.9), `Reading page ${p}`);
    }
    // scanned pages: replace with OCR output
    const toOcr = [...ocrSet].filter((p) => !want || want.has(p));
    if (toOcr.length) {
      if (!TS.ocr) throw new Error('OCR module missing');
      const res = await TS.ocr.ocrPages(pdf, toOcr, (k, tot, pno) => onProgress && onProgress(0.15 + (k / tot) * 0.8, `Recognizing text on scanned page ${pno} (${k} of ${tot})`));
      for (const [pno, r] of res) Object.assign(pages[pno - 1], { items: r.items, gfx: r.gfx, ocr: true });
    }
    await pdf.destroy();
    const real = pages.filter((p) => !p.stub);
    const textChars = real.reduce((m, p) => m + p.items.reduce((k, i) => k + i.s.length, 0), 0);
    if (textChars < real.length * 60) {
      throw new Error('This PDF has little or no selectable text (it looks scanned). Choose the scanned test in the list so Testside can recognize the text, or run OCR on the file first.');
    }
    for (const pg of pages) {
      if (pg.stub) { pg.lines = []; pg.g = []; pg.hlines = []; continue; }
      const { lines, g } = prepPage(pg);
      pg.lines = lines; pg.g = g;
    }
    // ink maps for math pages (lets the parser see symbols that have no text behind them)
    const detected = detectSections(pages);
    const mathPages = new Set();
    for (const d of detected) if (d.kind === 'math') for (let p = d.start; p <= d.end; p++) if (!pages[p - 1].stub && !pages[p - 1].ocr) mathPages.add(p);
    if (mathPages.size) {
      const pdf2 = await pdfjsLib.getDocument({ data: data.slice(0) }).promise;
      for (const p of mathPages) {
        const page = await pdf2.getPage(p);
        pages[p - 1].ink = await inkMap(page, 2);
        page.cleanup();
      }
      await pdf2.destroy();
    }
    const expl = opts.texts ? parseExplanations(opts.texts, opts.expl) : {};
    return { pages, numPages: n, keys: parseAnswerKeys(pages), expl, timing: parseTimingTable(pages), detected, title: guessTitle(pages), ocr: toOcr.length > 0 };
  }

  // Build one section from a page range. `f` = {kind, start, end, startY?, endY?, minutes?, count?}
  function buildSection(ctx, f) {
    const spec = { startY: -1, endY: Infinity, minutes: null, count: null, ...f };
    const sec = parseSection(ctx.pages, spec);
    const tm = ctx.timing[f.kind];
    if (!f.minutes && tm && (!tm.count || tm.count === sec.questions.length)) sec.minutes = tm.minutes;
    const key = ctx.keys[f.kind];
    const uns = ctx.keys[f.kind + ':unscored'] || {};
    const ex = (ctx.expl || {})[f.kind] || {};
    for (const q of sec.questions) {
      if (key && key[q.n]) q.answer = key[q.n];
      else if (ex[q.n]) q.answer = ex[q.n].ans;
      if (ex[q.n]) q.explanation = ex[q.n].text;
      if (uns[q.n]) q.unscored = true;
    }
    if (ctx.ocr) sec.ocr = true;
    sec.keyCount = sec.questions.filter((q) => q.answer).length;
    return sec;
  }

  async function parsePdf(data, onProgress) {
    const ctx = await analyzePdf(data, onProgress);
    const sections = [], warnings = [];
    for (const f of ctx.detected) {
      try { sections.push(buildSection(ctx, f)); } catch (e) { console.error(e); warnings.push(`${KIND_NAMES[f.kind]}: ${e.message}`); }
    }
    for (const s of sections) warnings.push(...s.warnings.map((w) => `${KIND_NAMES[s.kind]}: ${w}`));
    return { title: ctx.title, pageCount: ctx.numPages, sections, warnings, ctx };
  }

  function guessTitle(pages) {
    for (const pg of pages.slice(0, 3)) {
      for (const it of pg.items) {
        const m = it.s.match(/\bForm\s+([A-Z0-9]{2,6})\b/) || it.s.match(/Practice Test\s*\d+/i) || it.s.match(/PreACT\s*\d*/i);
        if (m) return m[0].replace(/^Form/, 'Form');
      }
    }
    return '';
  }

  function detectSections(pages, forceKind) {
    const hits = [];
    for (const pg of pages) for (const l of pg.lines) {
      const t = l.text.replace(/\s+/g, ' ').trim();
      for (const [kind, re] of HEADINGS) if (re.test(t)) {
        const pageText = pg.lines.map((x) => x.text).join(' ');
        const m = pageText.match(/(\d+)\s*Minutes\s*[—–-]\s*(\d+)\s*Questions/i);
        if (!hits.some((h) => h.kind === kind)) hits.push({ kind, start: pg.pno, startY: l.y, minutes: m ? +m[1] : null, count: m ? +m[2] : null });
      }
    }
    hits.sort((a, b) => a.start - b.start || a.startY - b.startY);
    if (!hits.length) {
      // a single section upload without a heading – guess its kind
      const kind = forceKind || guessKind(pages);
      const firstNonTest = pages.find((p) => p.pno > 1 && NONTEST_RE.test(p.lines.map((l) => l.text).join(' ')));
      return [{ kind, start: 1, startY: -1, end: firstNonTest ? firstNonTest.pno - 1 : pages.length, minutes: null, count: null, guessed: true }];
    }
    for (let i = 0; i < hits.length; i++) {
      const h = hits[i];
      let end = i + 1 < hits.length ? hits[i + 1].start : pages.length;
      const nextStartY = i + 1 < hits.length ? hits[i + 1].startY : Infinity;
      h.endY = i + 1 < hits.length && hits[i + 1].start === end ? nextStartY : Infinity;
      if (!(i + 1 < hits.length && hits[i + 1].start === end)) h.endY = Infinity;
      if (i + 1 < hits.length && hits[i + 1].start > h.start && hits[i + 1].startY > 200) { /* next section starts mid-page */ }
      for (let p = h.start; p <= end; p++) {
        const pg = pages[p - 1];
        const txt = pg.lines.map((l) => l.text).join(' ');
        if (p > h.start && NONTEST_RE.test(txt) && !pg.lines.some((l) => /^\d{1,2}\.\s/.test(l.text))) { end = p - 1; h.endY = Infinity; break; }
        if (pg.hasEnd && p >= h.start) { if (!(i + 1 < hits.length && hits[i + 1].start === p)) { end = p; h.endY = Infinity; } break; }
      }
      h.end = end;
    }
    return hits;
  }

  function guessKind(pages) {
    const txt = pages.map((p) => p.lines.map((l) => l.text).join(' ')).join(' ');
    if (/No Change|NO CHANGE/.test(txt)) return 'english';
    if (/Passage\s+I\b/i.test(txt) && /(Figure|Table)\s+1|Study\s+1|Experiment\s+1|Scientist\s+1/i.test(txt)) return 'science';
    if (/Passage\s+I\b/i.test(txt) || /\(lines?\s+\d+/.test(txt)) return 'reading';
    return 'math';
  }

  // "Modified Timing" tables in answer-key booklets (English 40 28 minutes …)
  function parseTimingTable(pages) {
    const out = {};
    const names = { English: 'english', Mathematics: 'math', Math: 'math', Reading: 'reading', Science: 'science' };
    for (const pg of pages.slice(0, 5)) {
      const txt = pg.items.map((i) => i.s).join(' ');
      if (!/Standard\s+Time|Modified\s+Timing/i.test(txt)) continue;
      const its = pg.items.filter((i) => !i.rot);
      for (const L of its) {
        const k = names[L.s.trim()];
        if (!k || out[k]) continue;
        // count cell: number just right of the subject name
        const C = its.filter((i) => /^\d{1,2}$/.test(i.s.trim()) && i.x > L.x1 && Math.abs(i.y - L.y) < 9).sort((a, b) => a.x - b.x)[0];
        if (!C) continue;
        // first time column after the count
        const cand = its.filter((i) => i.x > C.x1 + 3 && Math.abs(i.y - L.y) < 16 && /\d|minute|second|hour|and/i.test(i.s));
        if (!cand.length) continue;
        const minX = Math.min(...cand.map((i) => i.x));
        const cell = cand.filter((i) => i.x < minX + 25).sort((a, b) => a.y - b.y).map((i) => i.s).join(' ');
        const h = cell.match(/(\d+)\s*hours?/i), m = cell.match(/(\d+)\s*minutes?/i), sec = cell.match(/(\d+)\s*seconds?/i);
        if (!h && !m) continue;
        out[k] = { count: +C.s.trim(), minutes: (h ? +h[1] * 60 : 0) + (m ? +m[1] : 0) + (sec ? +sec[1] / 60 : 0) };
      }
    }
    return out;
  }

  // ---------- answer keys ----------
  function parseAnswerKeys(pages) {
    const keys = {};
    let lastKeyKind = null;
    for (const pg of pages) {
      const txt = pg.items.map((i) => i.s).join(' ');
      if (!/Scoring Key|Answer Key|Correct\s+Answer/i.test(txt)) continue;
      const headKind = (s) => (/English/i.test(s) ? 'english' : /Math/i.test(s) ? 'math' : /Reading/i.test(s) ? 'reading' : /Science/i.test(s) ? 'science' : null);
      const HK = /(English|Mathematics|Math|Reading|Science)(?:\s+Reasoning)?\s*[—–:-]?\s*(Scoring|Answer)\s+Key/i;
      // a page can hold two keys side by side: each answer belongs to the nearest heading above it
      const heads = pg.items.filter((i) => HK.test(i.s)).map((i) => ({ kind: headKind(i.s.match(HK)[1]), x: i.x, y: i.y }));
      if (!heads.length) { const hm = txt.match(HK); if (hm) heads.push({ kind: headKind(hm[1]), x: 0, y: -Infinity }); }
      // continuation pages have no "… Scoring Key" title, only column headers like "English | Number | Correct Answer"
      if (!heads.length) {
        const numHdr = pg.items.filter((i) => /^Number$/i.test(i.s.trim()));
        for (const i of pg.items) {
          const m = i.s.trim().match(/^(English|Mathematics|Math|Reading|Science)(?:\s+Number)?$/i);
          if (m && (/Number/i.test(i.s) || numHdr.some((n) => Math.abs(n.x - i.x) < 40 && Math.abs(n.y - i.y) < 20))) heads.push({ kind: headKind(m[1]), x: i.x, y: i.y - 1 });
        }
      }
      if (!heads.length && lastKeyKind && /Correct\s+Answer/i.test(txt)) heads.push({ kind: lastKeyKind, x: 0, y: -Infinity });
      if (!heads.length) continue;
      lastKeyKind = heads[heads.length - 1].kind;
      const kindFor = (t) => {
        const above = heads.filter((h) => h.y <= t.y + 2);
        const pool = above.length ? above : heads;
        const cost = (h) => Math.abs(h.x - t.x) + Math.abs(t.y - h.y) * 0.5;
        return pool.reduce((best, h) => (cost(h) < cost(best) ? h : best)).kind;
      };
      // pair every lone answer letter with the question number just left of it on (nearly) the same row
      const toks = [];
      for (const i of pg.items) {
        if (i.rot) continue;
        const m = i.s.trim().match(/^(\d{1,2})\.\s+([A-K])\b/);
        if (m) { const cut = i.x + i.w * (m[1].length + 1) / i.s.trim().length; toks.push({ s: m[1] + '.', x: i.x, x1: cut, y: i.y }, { s: m[2], x: cut + 1, x1: cut + 5, y: i.y }); }
        else toks.push({ s: i.s.trim(), x: i.x, x1: i.x1, y: i.y });
      }
      const nums = toks.filter((t) => /^\d{1,2}\.?$/.test(t.s));
      const lets = toks.filter((t) => /^[A-K]$/.test(t.s));
      const notScored = toks.filter((t) => /Not Scored/i.test(t.s));
      for (const L of lets) {
        let best = null, bd = 99;
        for (const n of nums) {
          if (n.x1 > L.x + 1 || L.x - n.x1 > 90) continue;
          const d = Math.abs(n.y - L.y) + (L.x - n.x1) * 0.01;
          if (Math.abs(n.y - L.y) < 5 && d < bd) { bd = d; best = n; }
        }
        if (!best) continue;
        const qn = parseInt(best.s, 10);
        const kind = kindFor(L);
        const key = (keys[kind] = keys[kind] || {});
        const unscored = (keys[kind + ':unscored'] = keys[kind + ':unscored'] || {});
        if (qn < 1 || qn > 75 || key[qn]) continue;
        key[qn] = L.s;
        if (notScored.some((t) => Math.abs(t.y - L.y) < 5 && t.x > L.x && t.x - L.x < 150)) unscored[qn] = true;
      }
    }
    // sanity: a key must have letters from the right ladder by parity
    for (const k of Object.keys(keys)) {
      if (k.includes(':')) continue;
      const ks = keys[k];
      const nums = Object.keys(ks).map(Number);
      if (nums.length < 10) delete keys[k];
    }
    return keys;
  }

  function parseKeyText(txt) {
    const key = {};
    const s = txt.toUpperCase();
    const pairs = [...s.matchAll(/(\d{1,2})\s*[.):\-]?\s*([A-K])\b/g)];
    if (pairs.length >= 3) { for (const m of pairs) key[+m[1]] = m[2]; return key; }
    const letters = s.replace(/[^A-K]/g, '');
    for (let i = 0; i < letters.length; i++) key[i + 1] = letters[i];
    return key;
  }

  // ---------- section parsing ----------
  function parseSection(pages, sec) {
    const kind = sec.kind;
    const warnings = [];
    const stream = [];
    const pageRange = [];
    for (let p = sec.start; p <= sec.end; p++) {
      const pg = pages[p - 1];
      pageRange.push(p);
      let lines = pg.lines.filter((l) => !(p === sec.start && l.y < sec.startY - 1) && !(p === sec.end && sec.endY !== Infinity && l.y >= sec.endY - 2));
      const g = pg.g.filter((b) => !(p === sec.start && b.y1 < sec.startY) && !(p === sec.end && sec.endY !== Infinity && b.y0 >= sec.endY - 2));
      const clusters = kind === 'english' ? [] : buildClusters(pg, lines, g, { skipUnderlines: false });
      pg.secClusters = clusters;
      stream.push(...pageStream(pg, lines, clusters));
    }

    if (kind === 'math' && stream.some((e) => e._ocr)) return scannedMathSection(pages, sec, stream, warnings);

    // ---- find question starts (sequential, verified) ----
    const questions = [];
    let expect = 1;
    const isLineEl = (e) => e.type === 'line';
    const qStartRe = /^(\d{1,2})\.\s*(.*)$/;
    const claimed = new Set();
    for (let i = 0; i < stream.length; i++) {
      const e = stream[i];
      if (!isLineEl(e) || claimed.has(e)) continue;
      const m = e.line.text.match(qStartRe);
      if (!m || +m[1] < expect || +m[1] > expect + (e._ocr ? 15 : 0)) continue;
      const q = buildQuestion(stream, i, +m[1], kind);
      if (!q) continue;
      for (const el of q.els) claimed.add(el);
      questions.push(q);
      expect = +m[1] + 1;
    }
    const anyOcr = stream.some((e) => e._ocr);
    if (anyOcr || (sec.count && questions.length < sec.count)) {
      const alt = ladderScan(stream, kind);
      if (alt.length > questions.length * 0.5) {
        // union: ladder scan is primary; number-found questions fill its gaps if they don't overlap
        const byN = new Map(alt.map((q) => [q.n, q]));
        const taken = new Set(alt.flatMap((q) => q.els));
        for (const q of questions) if (!byN.has(q.n) && !q.els.some((e) => taken.has(e))) { byN.set(q.n, q); q.els.forEach((e) => taken.add(e)); }
        const merged = [...byN.values()].sort((a, b) => a.n - b.n);
        questions.length = 0; questions.push(...merged);
        claimed.clear(); for (const q of merged) for (const el of q.els) claimed.add(el);
      }
    }
    if (sec.count && questions.length !== sec.count && !anyOcr) warnings.push(`found ${questions.length} of ${sec.count} questions`);

    // ---- passages / stimuli ----
    const passages = [];
    let directions = [];
    if (kind === 'english') buildEnglish(pages, sec, stream, claimed, questions, passages, directions, warnings);
    else {
      let cur = null;
      let started = false;
      const pending = []; // math stimuli waiting for their question
      for (const e of stream) {
        if (claimed.has(e)) {
          const q = questions.find((q) => q.start === e);
          if (q) started = true;
          if (q) {
            if (kind === 'math') {
              if (cur && cur.blocksEls.length) {
                // leftover non-question content before this question: shared stimulus
                const txt = cur.blocksEls.filter((x) => x.type === 'line').map((x) => x.line.text).join(' ');
                const rm = txt.match(/questions?\s+(\d+)\s*(?:[–—-]|through|and|to)\s*(\d+)/i);
                cur.range = rm ? [+rm[1], +rm[2]] : [q.n, q.n];
                // on scans, stray leftovers are OCR noise — only announced shared stimuli count
                if (rm || !cur.blocksEls.some((x) => x._ocr)) passages.push(cur);
                cur = null;
              }
              const st = passages.find((p) => p.range && q.n >= p.range[0] && q.n <= p.range[1]);
              q.passage = st ? passages.indexOf(st) : null;
            } else {
              q.passage = cur ? passages.indexOf(cur) : null;
              if (cur) cur.closed = true;
            }
          }
          continue;
        }
        if (e.type === 'line' && PASSAGE_RE.test(e.line.text) && e.line.text.length < 40) {
          cur = { title: romanFix(e.line.text.trim()), blocksEls: [] };
          passages.push(cur);
          started = true;
          continue;
        }
        if (!started) { if (e.type === 'line') directions.push(e); continue; }
        if (kind === 'math') {
          if (e.type === 'line' && /^\d+\s*Minutes/i.test(e.line.text)) continue;
          const q1 = questions[0];
          if (q1 && e.page === q1.page && e.top < q1.start.top && e.page === sec.start) { if (e.type === 'line') directions.push(e); continue; }
          if (!cur) cur = { title: '', blocksEls: [], stimulus: true };
          cur.blocksEls.push(e);
          continue;
        }
        if (cur && !cur.closed) cur.blocksEls.push(e);
      }
      for (const p of passages) p.blocks = elsToBlocks(p.blocksEls, kind);
      if (kind === 'math') {
        // stimuli are cropped whole
        for (const p of passages) p.blocks = cropBlocks(p.blocksEls);
      }
    }

    for (const p of passages) {
      delete p.blocksEls;
      delete p.closed;
    }
    // intro paragraph (LITERARY NARRATIVE: …) is shown above the passage box
    for (const p of passages) {
      const b0 = p.blocks[0];
      if (b0 && b0.t === 'p' && /^[A-Z][A-Z ]{3,}:/.test(runsText(b0.lines[0].runs)) && kind === 'reading') {
        p.intro = p.blocks.shift();
      }
      p.hasLineNumbers = p.blocks.some((b) => b.t === 'p' && b.lines.some((l) => l.num));
    }

    const finalQs = questions.map((q) => finalizeQuestion(q, kind, pages));
    // scanned sections: a question we couldn't take apart is still shown — as the scan of the region
    // between its neighbours, with plain answer bubbles — so the section stays complete
    if (anyOcr && questions.length) {
      const total = sec.count || Math.max(...questions.map((q) => q.n));
      const pos = new Map(stream.map((e, i) => [e, i]));
      const byN = new Map(questions.map((q) => [q.n, q]));
      for (let n = 1; n <= total; n++) {
        if (byN.has(n)) continue;
        let prev = null, next = null;
        for (let k = n - 1; k >= 1 && !prev; k--) prev = byN.get(k) || null;
        for (let k = n + 1; k <= total && !next; k++) next = byN.get(k) || null;
        const from = prev ? Math.max(...prev.els.map((e) => pos.get(e))) + 1 : 0;
        const to = next ? Math.min(...next.els.map((e) => pos.get(e))) : stream.length;
        const col = next ? next.col : prev ? prev.col : 0;
        // stay on the neighbour's page: the question sits right before `next` (or right after `prev`)
        const pageOk = (e) => (next ? e.page === next.page && e.top < next.start.top : e.page === prev.page);
        const els = stream.slice(from, to).filter((e) => !claimed.has(e) && e.c === col && pageOk(e) &&
          !(e.type === 'line' && PASSAGE_RE.test(e.line.text)));
        const ld = kind === 'math' ? (n % 2 ? LADDERS[0] : LADDERS[1]).slice(0, 5) : (n % 2 ? LADDERS[0] : LADDERS[1]).slice(0, 4);
        const near = els.length ? els[0].page : (next || prev).page;
        const fq = {
          n, passage: prev ? prev.passage ?? null : next ? next.passage ?? null : null, answer: null, page: near,
          stem: els.length ? cropBlocks(els, { pages })
            : [{ t: 'p', lines: [{ runs: [{ s: `This question couldn’t be picked out of the scan. It’s on PDF page ${near} — answer it from the book.` }] }] }], choices: ld.map((L) => ({ L, blocks: [] })), ladder: ld.join(''), fallback: true,
          region: els.length ? [...new Set(els.map((e) => e.page))].map((pn) => ({ page: pn, rect: rectOf(els.filter((e) => e.page === pn)) })) : [{ page: near, rect: [0, 0, pages[near - 1].W, pages[near - 1].H] }],
        };
        finalQs.push(fq);
      }
      // questions that came out with too few choices: show the scan with the full set of bubbles instead
      const counts = finalQs.map((q) => q.choices.length).sort((a, b) => a - b);
      const usual = counts[counts.length >> 1] || 4;
      for (const q of finalQs) {
        if (q.fallback || q.choices.length >= usual || !q.region) continue;
        const ld = (q.n % 2 || kind === 'english' && false ? LADDERS[0] : LADDERS[1]);
        const first = q.choices[0] ? q.choices[0].L : null;
        const lad = first && LADDERS[0].includes(first) ? LADDERS[0] : first && LADDERS[1].includes(first) ? LADDERS[1] : ld;
        q.stem = q.region.map((r) => ({ t: 'fig', page: r.page, rect: r.rect }));
        q.choices = lad.slice(0, usual).map((L) => ({ L, blocks: [] }));
        q.ladder = lad.slice(0, usual).join('');
        q.fallback = true;
      }
      finalQs.sort((a, b) => a.n - b.n);
      const fb = finalQs.filter((q) => q.fallback).map((q) => q.n);
      if (fb.length) warnings.push(`shown as scanned images (couldn't read the layout): ${fb.join(', ')}`);
    }
    const PACE = { english: 35 / 50, math: 50 / 45, reading: 40 / 36, science: 1 };
    const minutes = sec.minutes || (DEFAULT_MINUTES[kind] || {})[finalQs.length] || Math.round(finalQs.length * PACE[kind] * 2) / 2;
    const missing = finalQs.filter((q) => q.choices.length < 4).map((q) => q.n);
    if (missing.length) warnings.push(`questions with fewer than 4 choices: ${missing.join(', ')}`);
    return {
      kind, title: KIND_NAMES[kind], pages: [sec.start, sec.end], minutes,
      expected: sec.count, directions: directions.sort((a, b) => a.page - b.page || a.line.y - b.line.y || a.line.x0 - b.line.x0).map((e) => e.line.text).filter((t) => !/^\d+\s*Minutes/i.test(t)).join(' ').replace(/^(ENGLISH|MATHEMATICS|READING|SCIENCE( REASONING)?) TEST\s*/i, '').replace(/^DIRECTIONS:\s*/i, '').trim(),
      passages, questions: finalQs, warnings, guessed: !!sec.guessed,
    };
  }

  // Scanned math: OCR can't be trusted to take fractions, matrices and small labels apart, so each
  // question is shown whole, as an image of the booklet, with answer bubbles. Questions are found by
  // the blank space that separates them in the question column.
  function scannedMathSection(pages, sec, stream, warnings) {
    const count = sec.count || 60;
    const nChoices = count >= 60 ? 5 : 4;
    const segs = [];
    const byPage = new Map();
    for (const e of stream) {
      if (e.c === 1) continue; // right column is "DO YOUR FIGURING HERE" space
      if (!byPage.has(e.page)) byPage.set(e.page, []);
      byPage.get(e.page).push(e);
    }
    const dirRe = /DIRECTIONS|Unless otherwise stated|Illustrative figures|Geometric figures lie|The word .?line|The word .?average|MATHEMATICS TEST|Minutes\s*[—–-]\s*\d+\s*Questions/i;
    // question numbers hang outdented: a question starts at a line left of the body indent
    for (const [pno, allEls] of byPage) {
      allEls.sort((a, b) => a.top - b.top);
      // first page: skip the directions above question 1
      let els = allEls;
      if (pno === sec.start) {
        const q1 = allEls.findIndex((e) => e.type === 'line' && /^\S{0,3}1[.,]\s/.test(e.line.text));
        if (q1 > 0) els = allEls.slice(q1);
      }
      const xs = els.filter((e) => e.type === 'line').map((e) => Math.round(e.line.x0));
      const hist = {};
      for (const x of xs) hist[x] = (hist[x] || 0) + 1;
      const indent = +Object.entries(hist).sort((a, b) => b[1] - a[1])[0]?.[0] || 0;
      let cur = null;
      for (const e of els) {
        const isStart = e.type === 'line' && e.line.x0 <= indent - 3 && e.line.text.replace(/\s/g, '').length > 3 && !dirRe.test(e.line.text);
        if (isStart) { cur = { page: pno, els: [] }; segs.push(cur); }
        if (cur) cur.els.push(e);
      }
    }
    const qs = segs.filter((sg) => sg.els.filter((e) => e.type === 'line').length >= 2);
    // numbering: readable numbers that increase are anchors, the rest fill in order
    const read = qs.map((sg) => { const m = sg.els[0].type === 'line' && sg.els[0].line.text.match(/^(?:[^A-Za-z\s]{1,3}\s+)?[a-z]{0,2}(\d{1,2})[.,]/); return m ? +m[1] : null; });
    const nums = [];
    let n = 0;
    qs.forEach((sg, i) => {
      let next = read[i];
      if (next == null || next <= n || next > n + 3 || next > count) next = n + 1;
      nums.push(next); n = next;
    });
    const questions = [];
    qs.forEach((sg, i) => {
      const qn = nums[i];
      if (qn > count || questions.some((q) => q.n === qn)) return;
      const r = rectOf(sg.els);
      const rect = [Math.max(0, r[0] - 4), r[1] - 3, r[2] + 4, r[3] + 3].map((v) => Math.round(v * 10) / 10);
      const lad = (qn % 2 ? LADDERS[0] : LADDERS[1]).slice(0, nChoices);
      questions.push({ n: qn, passage: null, answer: null, page: sg.page, stem: [{ t: 'fig', page: sg.page, rect }],
        choices: lad.map((L) => ({ L, blocks: [] })), ladder: lad.join(''), region: [{ page: sg.page, rect }], scan: true });
    });
    // anything still missing: a placeholder pointing at the book
    for (let qn = 1; qn <= count; qn++) if (!questions.some((q) => q.n === qn)) {
      const near = questions.filter((q) => q.n < qn).pop() || questions[0];
      const pg = near ? near.page : sec.start;
      const lad = (qn % 2 ? LADDERS[0] : LADDERS[1]).slice(0, nChoices);
      questions.push({ n: qn, passage: null, answer: null, page: pg, fallback: true,
        stem: [{ t: 'p', lines: [{ runs: [{ s: `This question couldn’t be picked out of the scan. It’s near PDF page ${pg} — answer it from the book.` }] }] }],
        choices: lad.map((L) => ({ L, blocks: [] })), ladder: lad.join(''), region: [{ page: pg, rect: [0, 0, pages[pg - 1].W, pages[pg - 1].H] }] });
    }
    questions.sort((a, b) => a.n - b.n);
    const missing = questions.filter((q) => q.fallback).map((q) => q.n);
    if (missing.length) warnings.push(`couldn't find these questions in the scan: ${missing.join(', ')}`);
    const PACE = 50 / 45;
    const minutes = sec.minutes || (DEFAULT_MINUTES.math || {})[count] || Math.round(count * PACE * 2) / 2;
    return { kind: 'math', title: KIND_NAMES.math, pages: [sec.start, sec.end], minutes, expected: sec.count, directions: '',
      passages: [], questions, warnings, guessed: !!sec.guessed, scanned: true };
  }

  // Question finding that doesn't trust question numbers (OCR loses them): every run of choice
  // labels is a question; ACT alternates A–D (odd) and F–J (even), which keeps numbering on track.
  function ladderScan(stream, kind) {
    const labs = [];
    stream.forEach((e, i) => { if (e.type === 'line') { const L = labelInText(e.line.text); if (L) labs.push({ i, e, L }); } });
    const ladders = [];
    let cur = null;
    for (const x of labs) {
      const ld = LADDERS.find((l) => l.includes(x.L));
      const pos = ld.indexOf(x.L);
      if (cur && cur.ld === ld && pos > cur.last && pos - cur.last <= 2 && x.e.page === cur.page && x.e.c === cur.col) { cur.items.push(x); cur.last = pos; }
      else { cur = { ld, page: x.e.page, col: x.e.c, items: [x], last: pos, first: pos }; ladders.push(cur); }
    }
    const good = ladders.filter((l) => l.items.length >= 2 && l.first <= 1);
    // stem start + readable number for each ladder
    for (const ld of good) {
      const firstLab = ld.items[0];
      let si = firstLab.i, prev = firstLab.e;
      const numbered = (e) => e.type === 'line' && /^(?:[^A-Za-z\s]{1,4}\s+)?[a-z]{0,2}\d{1,2}[.,]\s/.test(e.line.text);
      if (!numbered(firstLab.e)) for (let j = firstLab.i - 1; j >= 0; j--) {
        const e = stream[j];
        if (e.page !== prev.page || e.c !== prev.c) break;
        const bot = e.type === 'fig' ? e.rect[3] : e.line.bottom;
        const h = prev.type === 'line' ? prev.line.h : 8;
        if (prev.top - bot > h * 0.9) break;
        if (e.type === 'line' && (labelInText(e.line.text) || PASSAGE_RE.test(e.line.text))) break;
        si = j; prev = e;
        if (numbered(e)) break; // reached this question's number
      }
      ld.si = si;
      const st = stream[si];
      const m = st.type === 'line' && st.line.text.match(/^(?:[^A-Za-z\s]{1,4}\s+)?[a-z]{0,2}(\d{1,2})[.,]/);
      const odd = ld.ld[0] === 'A';
      ld.r = m && +m[1] >= 1 && (kind === 'math' || (+m[1] % 2 === 1) === odd) ? +m[1] : null;
    }
    // anchors: readable numbers that increase along the stream (longest increasing run)
    const idx = good.map((l, i) => i).filter((i) => good[i].r != null);
    const best = [], prevOf = [];
    for (let a = 0; a < idx.length; a++) {
      best[a] = 1; prevOf[a] = -1;
      for (let b = 0; b < a; b++) {
        const gap = a - b, ia = idx[a], ib = idx[b];
        if (good[ia].r > good[ib].r && good[ia].r - good[ib].r >= ia - ib && best[b] + 1 > best[a]) { best[a] = best[b] + 1; prevOf[a] = b; }
      }
    }
    let end = best.length ? best.indexOf(Math.max(...best)) : -1;
    const anchors = new Set();
    while (end >= 0) { anchors.add(idx[end]); end = prevOf[end]; }
    // fill numbers between anchors, honouring the A–D / F–J alternation
    const fits = (n, ld) => kind === 'math' || (n % 2 === 1) === (ld.ld[0] === 'A');
    let n = 0;
    for (let i = 0; i < good.length; i++) {
      const ld = good[i];
      if (anchors.has(i)) { n = ld.r; ld.n = n; continue; }
      // next anchor bounds how far we may advance
      let nextA = null;
      for (let j = i + 1; j < good.length; j++) if (anchors.has(j)) { nextA = { j, r: good[j].r }; break; }
      let cand = n + 1;
      if (!fits(cand, ld)) cand++;
      if (nextA && cand > nextA.r - (nextA.j - i)) cand = Math.max(n + 1, nextA.r - (nextA.j - i));
      if (!fits(cand, ld) && kind !== 'math') cand = cand + 1 <= (nextA ? nextA.r - 1 : Infinity) ? cand + 1 : cand;
      n = cand; ld.n = n;
    }
    const out = [];
    const seen = new Set();
    for (const ld of good) {
      if (seen.has(ld.n)) continue;
      const startLine = stream[ld.si];
      if (startLine.type !== 'line') continue;
      const q = buildQuestion(stream, ld.si, ld.n, kind);
      if (!q) continue;
      q.start = startLine;
      q.numItem = ld.r != null ? startLine.line.items[0] : null;
      seen.add(ld.n);
      out.push(q);
    }
    return out;
  }

  // Collect a question block starting at stream[i]
  function buildQuestion(stream, i, n, kind) {
    const start = stream[i];
    const page = start.page, col = start.c;
    const numItem = start.line.items[0];
    // candidate elements: same page + column, below start, until next question start / passage heading
    const cands = [];
    for (let j = i + 1; j < stream.length; j++) {
      const e = stream[j];
      if (e.page !== page) break;
      if (e.c !== col && e.c !== 'F') { if (e.top > start.top) break; else continue; }
      if (e.c === 'F') break;
      if (e.top < start.top - 1) continue;
      if (e.type === 'line') {
        const m = e.line.text.match(/^(\d{1,2})\.\s/);
        if (m && (+m[1] === n + 1 || +m[1] === n)) break; // a second "n." means this start was a look-alike (e.g. a numbered directions note)
        if (PASSAGE_RE.test(e.line.text) && e.line.text.length < 40) break;
      }
      cands.push(e);
    }
    // choice labels
    const labelOf = (line) => labelInText(line.text);
    // also allow first choice on the start line: "1. A. NO CHANGE"
    const startRest = start.line.text.replace(/^\d{1,2}\.\s*/, '').replace(start._ocr ? JUNK_LEAD : /^$/, '');
    const inlineL = labelInText(start.line.text);
    const inlineFirst = inlineL === 'A' || inlineL === 'F' ? [null, inlineL] : null;
    let ladder = null, want = 0;
    const choiceStarts = [];
    if (inlineFirst) { ladder = LADDERS.find((l) => l[0] === inlineFirst[1]); want = 1; choiceStarts.push({ el: start, L: inlineFirst[1], inline: true }); }
    let lastIdx = -1;
    let labelEls = cands.map((e, k) => ({ e, k, L: e.type === 'line' ? labelOf(e.line) : null })).filter((x) => x.L);
    if (!ladder) { const f = labelEls.find((x) => LADDERS.some((l) => l[0] === x.L)); if (f) ladder = LADDERS.find((l) => l[0] === f.L); }
    if (ladder) {
      // stop at the next question's ladder (the other letter set)
      const firstOwn = labelEls.find((x) => ladder.includes(x.L));
      const cut = labelEls.find((x) => !ladder.includes(x.L) && (!firstOwn || x.k > firstOwn.k));
      if (cut) { labelEls = labelEls.filter((x) => x.k < cut.k); cands.length = cut.k; }
    }
    if (!ladder && labelEls.length >= 3) {
      // first label lost (OCR): pick the ladder the other labels belong to; the text after the number is choice one
      const ld = LADDERS.find((l) => labelEls.filter((x) => l.includes(x.L)).length >= 3);
      if (ld && /^(NO CHANGE|No Change)\b/.test(startRest)) { ladder = ld; want = 1; choiceStarts.push({ el: start, L: ld[0], inline: true }); }
    }
    if (ladder) {
      for (let w = want; w < ladder.length; w++) {
        const f = labelEls.find((x) => x.L === ladder[w] && !choiceStarts.some((c) => c.el === x.e));
        if (!f) break;
        choiceStarts.push({ el: f.e, L: f.L });
        lastIdx = Math.max(lastIdx, f.k);
      }
    }
    // labels lost or garbled by OCR: choices start at the label column, so recover them by position
    if (ladder && choiceStarts.length >= 1 && choiceStarts.length < 4 && pagesOcr(start)) {
      const found = choiceStarts.filter((c) => !c.inline);
      const lx = found.length ? found.map((c) => c.el.line.x0).sort((a, b) => a - b)[found.length >> 1] : null;
      const firstY = found.length ? Math.min(...found.map((c) => c.el.top)) : start.top;
      if (lx != null) {
        const colRight = Math.max(...stream.filter((e) => e.type === 'line' && e.page === page && e.c === col).map((e) => e.line.x1));
        const lineEls = cands.filter((e) => e.type === 'line');
        // a line indented to the text column is a new choice (whose label was lost) when the line
        // above it is short — i.e. it can't be a wrapped continuation
        const prevShort = (e) => {
          const i = lineEls.indexOf(e);
          const p = i > 0 ? lineEls[i - 1] : null;
          return p && p.line.x1 < colRight - 0.3 * (colRight - lx);
        };
        const rows = cands.filter((e) => {
          if (e.top <= firstY + 1 || choiceStarts.some((c) => c.el === e)) return false;
          const x0 = e.type === 'fig' ? e.rect[0] : e.line.x0;
          if (Math.abs(x0 - lx) <= 5) return true;
          return e.type === 'line' && x0 - lx > 5 && x0 - lx <= 22 && prevShort(e);
        });
        const all = [...choiceStarts.map((c) => ({ el: c.el, inline: c.inline, top: c.inline ? -1 : c.el.top, known: true })), ...rows.map((e) => ({ el: e, top: e.top }))]
          .sort((a, b) => a.top - b.top);
        if (all.length === 4 || all.length === 5) {
          choiceStarts.length = 0;
          all.forEach((r, i) => {
            if (r.el.type === 'fig' && !r.el.line) {
              const [x0, y0, x1, y1] = r.el.rect;
              r.el.line = { x0, x1, top: y0, bottom: y1, y: y1, h: y1 - y0, text: '', items: [] };
            }
            choiceStarts.push({ el: r.el, L: ladder[i], inline: r.inline, inferred: !r.known });
          });
          lastIdx = Math.max(lastIdx, ...all.map((r) => cands.indexOf(r.el)));
        }
      }
    }
    // English "N. NO CHANGE" questions whose other labels OCR lost entirely: rows by layout
    if (choiceStarts.length < 4 && pagesOcr(start) && /^(?:[A-HJK][.,]\s*)?NO CHANGE\b/i.test(startRest)) {
      const block = [];
      let prevB = start.line.bottom;
      for (const e of cands) {
        const top = e.top, bot = e.type === 'fig' ? e.rect[3] : e.line.bottom;
        if (top - prevB > (e.type === 'line' ? e.line.h : 7) * 0.9) break;
        block.push(e); prevB = bot;
      }
      const lines = [start, ...block];
      const lx = Math.min(...lines.map((e) => (e.type === 'fig' ? e.rect[0] : e.line.x0)));
      const colR = Math.max(...stream.filter((e) => e.type === 'line' && e.page === page && e.c === col).map((e) => e.line.x1));
      const rows = [start];
      for (let i = 1; i < lines.length; i++) {
        const p = lines[i - 1];
        const pLong = p.type === 'line' && p.line.x1 > colR - 0.25 * (colR - lx);
        if (!pLong) rows.push(lines[i]);
      }
      if (rows.length === 4) {
        const ld = LADDERS[n % 2 === 1 ? 0 : 1];
        choiceStarts.length = 0;
        rows.forEach((e, i) => {
          if (e.type === 'fig' && !e.line) { const [x0, y0, x1, y1] = e.rect; e.line = { x0, x1, top: y0, bottom: y1, y: y1, h: y1 - y0, text: '', items: [] }; }
          choiceStarts.push({ el: e, L: ld[i], inline: i === 0, inferred: i > 0 });
        });
        lastIdx = Math.max(lastIdx, cands.indexOf(block[block.length - 1]));
      }
    }
    if (choiceStarts.length < 4 && !(choiceStarts.length >= 2 && kind === 'math')) return null;
    // extend past the last label with continuation lines / figures
    const lastLabel = cands[lastIdx] || start;
    const els = [];
    // pieces of a built-up fraction/root that sit just above the number line belong to it
    for (let j = i - 1; j >= 0 && j >= i - 6; j--) {
      const e = stream[j];
      if (e.page !== page || e.c !== col || e.type !== 'line') continue;
      if (e.line.bottom > start.line.top - 1.5 && e.line.top < start.line.bottom && e.line.x0 > start.line.x0 + 4) els.unshift(e);
    }
    els.push(start);
    let lastBottom = lastLabel.line.bottom;
    const labelX = Math.min(...choiceStarts.map((c) => c.el.line.x0));
    for (let k = 0; k < cands.length; k++) {
      const e = cands[k];
      if (k <= lastIdx) { els.push(e); continue; }
      const gap = e.top - lastBottom;
      if (e.type === 'fig') { if (gap < 26 && e.cl.x0 > labelX - 4) { els.push(e); lastBottom = e.cl.y1; continue; } break; }
      if (gap < e.line.h * 0.9 && e.line.x0 > labelX + 4) { els.push(e); lastBottom = e.line.bottom; continue; }
      // math fractions: denominator line slightly below label line
      if (gap < 4 && kind === 'math') { els.push(e); lastBottom = Math.max(lastBottom, e.line.bottom); continue; }
      break;
    }
    // figures belonging to the stem that sit between start and first choice are already in cands; ensure
    // nothing from a different question got in (lines above start in the same column were skipped)
    return { n, els, choiceStarts, numItem, page, col, start, kind };
  }

  // Split a question's elements into stem and choices and render content.
  function pagesOcr(e) { return !!(e && e._ocr); }

  function finalizeQuestion(q, kind, pages) {
    const labels = q.choiceStarts;
    const stemEls = [], choiceEls = labels.map(() => []);
    const bodyHq = modeH(q.els.filter((e) => e.type === 'line').map((e) => e.line));
    const boxOf = (e) => (e.type === 'fig' ? { x0: e.rect[0], top: e.rect[1] } : { x0: e.line.x0, top: e.line.top });
    for (const e of q.els) {
      if (e === q.start && !labels[0].inline) { stemEls.push(e); continue; }
      const li = labels.findIndex((c) => c.el === e);
      if (li >= 0) { choiceEls[li].push(e); continue; }
      // owner = the label whose line is vertically nearest this element's centre (labels sit at the
      // middle of tall math choices and at the top of figure choices), preferring labels to the left
      const b = boxOf(e);
      const firstTop = Math.min(...labels.map((c) => c.el.line.top));
      const bot = e.type === 'fig' ? e.rect[3] : e.line.bottom;
      let idx = -1;
      const startsAbove = (e.type === 'fig' && e.rect[1] < firstTop - 8) ||
        // a diagram beside the choice list (spanning several labels, well right of them) is part of the stem
        (e.type === 'fig' && e.rect[0] > Math.min(...labels.map((c) => c.el.line.x0)) + 60 &&
          labels.filter((c) => c.el.line.top >= e.rect[1] - 4 && c.el.line.top <= e.rect[3]).length >= 2 &&
          !labels.some((c) => c.el.line.x0 > e.rect[0] - 30 && c.el.line.x0 < e.rect[2]));
      const minLX = Math.min(...labels.map((c) => c.el.line.x0));
      const stemLine = e.type === 'line' && e.line.top < firstTop - 1 && e.line.x0 <= minLX + 4;
      // a line of bare "_" glyphs is an overline/vinculum for the text just below it
      const bar = e.type === 'line' && /^[_⏜‾⌢\s]+$/.test(e.line.text);
      if ((bot > firstTop + 1 || (bar && bot + 7 > firstTop)) && !startsAbove && !stemLine) {
        const cy = e.type === 'fig' ? (e.rect[1] + e.rect[3]) / 2 : bar ? e.line.bottom + 7 : (e.line.top + e.line.bottom) / 2;
        const pick = (useX) => {
          let best = -1, bd = Infinity;
          for (let k = 0; k < labels.length; k++) {
            const L = labels[k].el.line;
            if (useX && L.x0 > b.x0 + 6) continue;
            const ly = (L.top + L.bottom) / 2;
            const d = Math.abs(cy - ly) + (ly > cy + 0.5 ? 3 : 0);
            if (d < bd - 0.01 || (Math.abs(d - bd) <= 0.01 && L.x0 > labels[best].el.line.x0)) { bd = d; best = k; }
          }
          return best;
        };
        const pickAbove = (useX) => {
          let best = -1;
          for (let k = 0; k < labels.length; k++) {
            const L = labels[k].el.line;
            if (L.top > b.top + 5 || (useX && L.x0 > b.x0 + 6)) continue;
            if (best < 0) { best = k; continue; }
            const B = labels[best].el.line;
            if (L.top > B.top + 3 || (Math.abs(L.top - B.top) <= 3 && L.x0 > B.x0)) best = k;
          }
          return best;
        };
        // wrapped text (full-size line) belongs to the label above; smaller pieces of built-up math
        // (fraction parts, matrix rows) sit around their label's centre
        const fullSize = e.type === 'line' && !bar && e.line.h >= bodyHq * 0.95 && e.line.items.some((it) => /[A-Za-z]{2,}/.test(it.s));
        if (e.type === 'line' && (kind !== 'math' || fullSize)) { idx = pickAbove(true); if (idx < 0) idx = pickAbove(false); }
        else if (e.type === 'fig') { idx = pickAbove(true); if (idx < 0) idx = pick(true); if (idx < 0) idx = pick(false); }
        else { idx = pick(true); if (idx < 0) idx = pick(false); }
      }
      if (idx < 0) stemEls.push(e); else choiceEls[idx].push(e);
    }
    const stemHasFig = stemEls.some((e) => e.type === 'fig');
    const out = { n: q.n, passage: q.passage ?? null, answer: null, page: q.page };
    const cropStem = kind === 'math' && !mathSafe(stemEls, pages, q.numItem);
    // stem content
    if (cropStem) {
      out.stem = cropBlocks(stemEls, { startEl: q.start, pages });
    } else {
      const lines = stemEls.map((e) => (e === q.start ? { ...e, line: stripLead(e.line, e._ocr ? JUNK_LEAD : /^\d{1,2}\.\s*/) } : e));
      out.stem = elsToBlocks(lines, kind, { question: true });
      if (kind === 'math') tidyMath(out.stem);
    }
    out.stemRect = rectOf(stemEls);
    // where the question sits in the booklet (for "view original")
    const pagesUsed = [...new Set(q.els.map((e) => e.page))];
    out.region = pagesUsed.map((pn) => ({ page: pn, rect: rectOf(q.els.filter((e) => e.page === pn)).map((v, k) => Math.round((v + (k < 2 ? -4 : 4)) * 10) / 10) }));
    out.choices = labels.map((c, k) => {
      const els = choiceEls[k];
      const hasFig = els.some((e) => e.type === 'fig');
      const shaky = c.inferred || els.some((e) => e.type === 'line' && e.line.items.some((it) => it.ocr && it.conf < 75 && !(e === c.el && it === e.line.items[0])));
      let blocks;
      if (shaky && !c.inline) {
        // OCR isn't sure about this choice: show the scan itself, starting after the label column
        // start at the first real word (skip the label and any stray OCR glyphs)
        const first = (c.el.line.items || []).find((it) => !/^[A-HJK][.,]$/.test(it.s) && !/^[^A-Za-z0-9]{1,3}$/.test(it.s));
        blocks = cropBlocks(els, { pages, fromX: first ? first.x - 1.5 : null });
      } else if (hasFig || (kind === 'math' && !mathSafe(els, pages, c.inline ? q.numItem : null))) {
        blocks = cropBlocks(els, { pages, dropLabel: true, startEl: c.inline ? q.start : null, startRe: /^\d{1,2}\.\s*(?:[A-K][.,]\s*)?/ });
      } else {
        const lines = els.map((e) => {
          if (c.inline && e === q.start) return { ...e, line: stripLead(e.line, /^(?:[^A-Za-z\s]{1,4}\s+)?(?:[a-z]{0,2}\d{1,2}[.,]\s*)?(?:[A-K][.,]\s*)?/) };
          if (e === c.el) return { ...e, line: stripLead(e.line, /^(?:[^A-Za-z\s]{1,4}\s+)?[A-K][.,]\s*/) };
          return e;
        });
        blocks = elsToBlocks(lines, kind, { question: true, choice: true });
        if (kind === 'math') tidyMath(blocks);
      }
      return { L: c.L, blocks };
    });
    // keep each choice's image between its neighbours' text (tall symbol glyphs, like an arc over
    // "TXU", report boxes much bigger than their ink)
    const textEdge = (els, which) => {
      let v = which === 'bottom' ? -Infinity : Infinity;
      for (const e of els) if (e.type === 'line') for (const it of e.line.items) {
        if (/^[_⏜‾⌢]+$/.test(it.s.trim()) || /[\u0000-\u001F]/.test(it.s)) continue;
        v = which === 'bottom' ? Math.max(v, it.bottom) : Math.min(v, it.top);
      }
      return v;
    };
    out.choices.forEach((c, k) => {
      const above = k === 0 ? stemEls : choiceEls[k - 1];
      const below = k + 1 < labels.length ? choiceEls[k + 1] : null;
      const lo = textEdge(above, 'bottom'), hi = below ? textEdge(below, 'top') : Infinity;
      for (const b of c.blocks) if (b.t === 'fig' && !b.fromFig) {
        if (Number.isFinite(lo) && b.page === (above[0] || {}).page && b.rect[1] < lo + 1) b.rect[1] = Math.round((lo + 1) * 10) / 10;
        if (Number.isFinite(hi) && below && b.page === (below[0] || {}).page && b.rect[3] > hi + 0.5) b.rect[3] = Math.round((hi + 0.5) * 10) / 10;
      }
    });
    out.ladder = labels.map((c) => c.L).join('');
    out.stemFig = stemHasFig;
    // English: a question with no stem text uses the default prompt
    return out;
  }

  // Can this bit of math be shown as plain text without losing notation?
  const RISKY_FONT = /STIX|MathematicalPi|SymbolStd|MTExtra|Euclid|CambriaMath|Cambria-Math|Wingding|Dingbat/i;
  function mathSafe(els, pages, skipItem) {
    if (els.some((e) => pages[e.page - 1].ocr)) return false; // OCR flattens superscripts and fractions
    // figures are cropped on their own; only the text lines have to survive as text
    const lines = els.filter((e) => e.type === 'line');
    if (!lines.length) return !els.length || true;
    const figRects = els.filter((e) => e.type === 'fig').map((e) => e.rect);
    for (const e of lines) {
      for (const it of e.line.items) {
        if (it === skipItem) continue;
        if (RISKY_FONT.test(it.name)) return false;
        if (/[_√⎪‾⏜∠△⊥∥≅∼]/.test(it.s)) return false;
        if (/[\u0000-\u001F\uE000-\uF8FF\uFFFD]/.test(it.s)) return false; // symbol-font glyphs with no real character (e.g. a radical sign)
        if (!it.sub && !it.sup && it.h < e.line.h - 0.8) return false;
      }
      const pg = pages[e.page - 1];
      const L = e.line;
      if (strayInk(pg, L, skipItem)) return false;
      for (const g of pg.g) {
        if (figRects.some((r) => g.x0 >= r[0] - 1 && g.x1 <= r[2] + 1 && g.y0 >= r[1] - 1 && g.y1 <= r[3] + 1)) continue;
        if (g.x0 < L.x1 - 1 && g.x1 > L.x0 + 1 && g.y0 < L.bottom - 1 && g.y1 > L.top + 1) return false;
      }
    }
    return true;
  }
  // Ink on the rendered page that none of the line's text items explain: a radical sign drawn as a
  // shape, a vinculum, a symbol with no text behind it. Any of that means the line can't be text.
  function strayInk(pg, L, skipItem) {
    const ink = pg.ink;
    if (!ink) return false;
    const s = ink.s;
    const X0 = Math.max(0, Math.floor((L.x0 - 3) * s)), X1 = Math.min(ink.w, Math.ceil((L.x1 + 3) * s));
    const Y0 = Math.max(0, Math.floor((L.top - 1.8) * s)), Y1 = Math.min(ink.h, Math.ceil((L.bottom + 0.3) * s));
    const w = X1 - X0, h = Y1 - Y0;
    if (w <= 0 || h <= 0) return false;
    const cover = new Uint8Array(w * h);
    // every text item near the line counts (neighbouring lines' glyphs can poke into the box)
    const near = (pg.body || L.items).filter((it) => !it.rot && it.x1 > L.x0 - 4 && it.x < L.x1 + 4 && it.bottom > L.top - 4 && it.top < L.bottom + 4);
    for (const it of near) {
      const bx0 = Math.max(0, Math.floor((it.x - 0.8) * s) - X0), bx1 = Math.min(w, Math.ceil((it.x1 + 0.8) * s) - X0);
      const by0 = Math.max(0, Math.floor((it.top - 1) * s) - Y0), by1 = Math.min(h, Math.ceil((it.bottom + 0.6) * s) - Y0);
      for (let y = by0; y < by1; y++) cover.fill(1, y * w + bx0, y * w + Math.max(bx0, bx1));
    }
    let stray = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (ink.d[(Y0 + y) * ink.w + X0 + x] && !cover[y * w + x]) stray++;
    return stray > 5;
  }

  function tidyMath(blocks) {
    for (const b of blocks) if (b.t === 'p') for (const l of b.lines) {
      const R = l.runs;
      for (let k = 0; k < R.length; k++) {
        const r = R[k];
        if (r.t === 'm') continue;
        r.s = r.s.replace(/\(\s+/g, '(').replace(/\s+([),.?;:°])/g, '$1').replace(/(\d) -(?=[a-z])/g, '$1-').replace(/(\d) (st|nd|rd|th)\b/g, '$1$2');
        const prev = R[k - 1];
        if (prev && prev.s && /\d\s+$/.test(prev.s) && r.i && /^[a-z]/i.test(r.s)) prev.s = prev.s.replace(/\s+$/, '');
        if (prev && prev.i && /^\s*[a-z]\s*$/i.test(prev.s) && /^\s+\(/.test(r.s)) { prev.s = prev.s.replace(/\s+$/, ''); r.s = r.s.replace(/^\s+/, ''); }
        if (prev && /^\s+°/.test(r.s)) r.s = r.s.replace(/^\s+/, '');
        if (prev && prev.s && /\d$/.test(prev.s) && r.i && /^\s+[a-z]/i.test(r.s)) r.s = r.s.replace(/^\s+/, '');
        if (prev && prev.i && /[a-z]$/i.test(prev.s) && /^\s+-[a-z]/.test(r.s)) r.s = r.s.replace(/^\s+/, '');
        if (prev && prev.s && /\($/.test(prev.s)) r.s = r.s.replace(/^\s+/, '');
        if (prev && /^\s+[),.?;:]/.test(r.s)) r.s = r.s.replace(/^\s+/, '');
      }
    }
  }

  function prevBottom(q, e, label) {
    // bottom of the stem text just before the first label
    const stemLines = q.els.filter((x) => x.type === 'line' && x.line.y < label.el.line.y - 0.5 && x.line.x0 <= label.el.line.x0 + 1);
    const lastStem = stemLines[stemLines.length - 1];
    return lastStem ? lastStem.line.y : label.el.line.y - 20;
  }

  function stripLead(line, re) {
    // remove leading "12." / "A." from a line while keeping item structure
    let need = (line.text.match(re) || [''])[0].length;
    const items = [];
    for (const it of line.items) {
      if (need <= 0) { items.push(it); continue; }
      const s = it.s.replace(/^\s+/, '');
      const lead = it.s.length - s.length;
      if (s.length <= need - 0 && /^[\dA-K.\s]+$/.test(s)) { need -= s.length; if (need > 0 && need <= 1) need = 0; continue; }
      // partial item
      const cut = Math.min(s.length, need);
      const rest = s.slice(cut).replace(/^\s+/, '');
      need = 0;
      if (rest) {
        const frac = (lead + (s.length - rest.length)) / it.s.length;
        items.push({ ...it, s: rest, x: it.x + it.w * frac, w: it.w * (1 - frac) });
      }
    }
    const L = { ...line, items };
    if (items.length) { L.x0 = Math.min(...items.map((i) => i.x)); L.text = lineText(items); } else L.text = '';
    return L;
  }

  function rectOf(els) {
    if (!els.length) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const e of els) {
      const r = e.type === 'fig' ? e.rect : [e.line.x0, e.line.top, e.line.x1, e.line.bottom];
      x0 = Math.min(x0, r[0]); y0 = Math.min(y0, r[1]); x1 = Math.max(x1, r[2]); y1 = Math.max(y1, r[3]);
    }
    return [x0, y0, x1, y1];
  }

  // Crop blocks: group consecutive elements on the same page into one rectangle.
  function cropBlocks(els, opts = {}) {
    const blocks = [];
    let cur = null;
    for (const e of els) {
      let r;
      if (e.type === 'fig') r = e.rect.slice();
      else {
        let items = e.line.items;
        if (opts.startEl && e === opts.startEl) items = stripLead(e.line, opts.startRe || /^\d{1,2}\.\s*/).items;
        if (opts.dropLabel) items = items.filter((it, k) => !(k === 0 && /^[A-K]\.?$/.test(it.s.trim())) && !/^\s*[A-K]\.\s*$/.test(it.s));
        if (opts.dropLead) items = items.filter((it) => !(it === opts.dropLead) && !/^\s*\d{1,2}\.\s*$/.test(it.s));
        if (!items.length) continue;
        r = [Math.min(...items.map((i) => i.x)), Math.min(...items.map((i) => i.top)), Math.max(...items.map((i) => i.x1)), Math.max(...items.map((i) => i.bottom))];
      }
      if (opts.fromX != null) r[0] = Math.max(r[0], opts.fromX);
      // figures get their own crop: a box around text + a side figure would also swallow whatever
      // sits beside the figure (e.g. the answer choices)
      if (e.type === 'fig') { cur = null; blocks.push({ t: 'fig', page: e.page, rect: r, fromFig: true }); continue; }
      if (cur && !cur.fromFig && cur.page === e.page && r[1] - cur.rect[3] < 40) {
        cur.rect = [Math.min(cur.rect[0], r[0]), Math.min(cur.rect[1], r[1]), Math.max(cur.rect[2], r[2]), Math.max(cur.rect[3], r[3])];
      } else {
        cur = { t: 'fig', page: e.page, rect: r };
        blocks.push(cur);
      }
    }
    // text that sits within a figure's horizontal span, right against it, is part of that figure
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i];
      if (b.fromFig) continue;
      const f = blocks.find((x) => x.fromFig && x.page === b.page && (
        (b.rect[0] >= x.rect[0] - 14 && b.rect[2] <= x.rect[2] + 4 && b.rect[1] < x.rect[3] + 10 && b.rect[3] > x.rect[1] - 10) ||
        // beside it (legend, side labels): overlapping vertically, close horizontally
        (Math.min(b.rect[3], x.rect[3]) - Math.max(b.rect[1], x.rect[1]) > 0.5 * (b.rect[3] - b.rect[1]) &&
          (Math.abs(b.rect[0] - x.rect[2]) < 20 || Math.abs(x.rect[0] - b.rect[2]) < 20))));
      if (f) {
        f.rect = [Math.min(f.rect[0], b.rect[0]), Math.min(f.rect[1], b.rect[1]), Math.max(f.rect[2], b.rect[2]), Math.max(f.rect[3], b.rect[3])];
        blocks.splice(i, 1);
      }
    }
    // figure crops stop where the neighbouring text crops start
    for (const f of blocks) if (f.fromFig) for (const b of blocks) {
      if (b.fromFig || b.page !== f.page || b.rect[2] < f.rect[0] || b.rect[0] > f.rect[2]) continue;
      if (b.rect[1] < f.rect[1] && b.rect[3] > f.rect[1] - 3.5 && b.rect[3] < f.rect[3]) f.rect[1] = Math.max(f.rect[1] - 3.5, b.rect[3] + 1) + 3.5;
      if (b.rect[3] > f.rect[3] && b.rect[1] < f.rect[3] + 3.5 && b.rect[1] > f.rect[1]) f.rect[3] = Math.min(f.rect[3] + 3.5, b.rect[1]) - 3.5;
    }
    // pull in drawn strokes touching the text (radical overlines, fraction bars)
    if (opts.pages) for (const b of blocks) {
      if (b.fromFig) continue;
      const g = opts.pages[b.page - 1].g;
      for (let pass = 0; pass < 2; pass++) for (const s of g) {
        if (s.y1 - s.y0 > 1.8 || s.x1 - s.x0 > 200) continue;
        const r = b.rect;
        if (s.x0 < r[2] && s.x1 > r[0] && s.y1 > r[1] - 6 && s.y0 < (r[1] + r[3]) / 2) {
          r[0] = Math.min(r[0], s.x0); r[1] = Math.min(r[1], s.y0); r[2] = Math.max(r[2], s.x1); r[3] = Math.max(r[3], s.y1);
        }
      }
    }
    for (const b of blocks) b.rect = [b.rect[0] - 2, b.rect[1] - (b.fromFig ? 3.5 : 1.5), b.rect[2] + 2, b.rect[3] + 1].map((v) => Math.round(v * 10) / 10);
    return blocks;
  }

  // ---------- text blocks ----------
  function itemsToRuns(items, marks) {
    const runs = [];
    let prev = null;
    for (const it of items) {
      let s = it.s;
      if (prev) {
        const gap = it.x - prev.x1;
        if (gap > Math.max(prev.h, it.h) * 0.18 && !/\s$/.test(prev.s) && !/^\s/.test(s) && !it.sub && !it.sup && !((prev.sub || prev.sup) && gap < prev.h * 0.35)) s = ' ' + s;
      }
      s = s.replace(/[\u0000-\u001F\uFFFD]/g, '');
      push(runs, { s, i: it.italic || undefined, b: it.bold || undefined, sub: it.sub || undefined, sup: it.sup || undefined });
      prev = it;
    }
    return runs;
  }
  function push(runs, r) {
    if (!r.s) return;
    const last = runs[runs.length - 1];
    if (last && last.t !== 'm' && !r.t && last.i === r.i && last.b === r.b && last.sub === r.sub && last.sup === r.sup && last.u === r.u) last.s += r.s;
    else runs.push(r);
  }
  const runsText = (runs) => runs.map((r) => r.s || '').join('');

  // Lines → paragraphs; figures → crops.
  function elsToBlocks(els, kind, opts = {}) {
    const blocks = [];
    let para = null, prevLine = null;
    const bodyX = leftMargins(els);
    const bodyH = modeH(els.filter((e) => e.type === 'line').map((e) => e.line));
    // body font family (serif vs sans) by volume of text
    let serifChars = 0, sansChars = 0;
    for (const e of els) if (e.type === 'line') for (const it of e.line.items) { if (it.serif) serifChars += it.s.length; else sansChars += it.s.length; }
    const bodySerif = serifChars >= sansChars;
    for (const e of els) {
      if (e.type === 'fig') {
        para = null; prevLine = null;
        const r = e.rect.map((v, k) => v + (k < 2 ? -3 : 3));
        // don't let the padding reach into neighbouring text lines
        const i = els.indexOf(e);
        const before = els.slice(0, i).reverse().find((x) => x.type === 'line' && x.page === e.page);
        const after = els.slice(i + 1).find((x) => x.type === 'line' && x.page === e.page);
        if (before && before.line.bottom <= e.rect[1] + 1) r[1] = Math.max(r[1], before.line.bottom + 0.5);
        if (after && after.line.top >= e.rect[3] - 1) r[3] = Math.min(r[3], after.line.top - 0.5);
        blocks.push({ t: 'fig', page: e.page, rect: r.map((v) => Math.round(v * 10) / 10) });
        continue;
      }
      const l = e.line;
      if (!l.items.length) continue;
      let items = l.items;
      let num = null;
      const marginHere = bodyX[`${e.page}:${e.c}`];
      // reading line numbers: numeric item leading the line, smaller type or left of the text margin
      if (items.length > 1 && /^\d{1,3}$/.test(items[0].s.trim()) && items[1].x - items[0].x1 > 1.5 &&
        (items[0].h < l.h - 0.5 || items[0].lnum || (marginHere != null && items[0].x1 < marginHere - 1 && +items[0].s.trim() % 5 === 0))) {
        num = +items[0].s.trim(); items = items.slice(1);
      } else if (/^\d{1,3}\s/.test(items[0].s) && items[0].h < l.h - 0.5) {
        // number merged into first item
        const m = items[0].s.match(/^(\d{1,3})\s+/);
        num = +m[1];
        const frac = m[0].length / items[0].s.length;
        items = [{ ...items[0], s: items[0].s.slice(m[0].length), x: items[0].x + items[0].w * frac }, ...items.slice(1)];
      }
      const x0 = Math.min(...items.map((i) => i.x));
      const colKey = `${e.page}:${e.c}`;
      const margin = bodyX[colKey] ?? x0;
      const indent = x0 - margin > 6;
      const text = lineText(items);
      const allBold = items.every((i) => i.bold || !i.s.trim());
      const centered = !indent ? false : false;
      const bullet = /^[•●▪◦]\s*/.test(text);
      const otherFamily = items.every((i) => i.serif !== bodySerif || !i.s.trim()) && text.split(' ').length <= 12 && l.h >= bodyH * 0.9;
      const heading = ((allBold || (otherFamily && !opts.question)) && text.length < 70 && !opts.choice) || (/^\[\d+\]$/.test(text)) ||
        (!opts.question && /^Passage [A-D](\s+by\b.*)?$/.test(text));
      const gap = prevLine && prevLine.page === e.page && prevLine.c === e.c ? l.top - prevLine.bottom : 0;
      const lh = l.h || 10;
      // consecutive lines at the same deeper indent are a block quote, not a new paragraph per line
      const sameBlock = indent && prevLine && prevLine.x0 != null && Math.abs(prevLine.x0 - x0) < 2 && gap < lh * 0.75 && prevLine.page === e.page;
      const newPara = !para || heading || para.heading || (indent && !para.hanging && !sameBlock) || (para.block && !indent) || bullet || gap > lh * 0.75 ||
        (prevLine && (prevLine.page !== e.page || prevLine.c !== e.c) && false);
      const runs = itemsToRuns(items);
      if (newPara) {
        para = { t: 'p', lines: [], indent: indent && !bullet, heading: heading || undefined, bullet: bullet || undefined, hanging: bullet || undefined };
        if (/^\[\d+\]$/.test(text)) { para.pnum = true; }
        blocks.push(para);
      }
      if (sameBlock && !newPara) para.block = true;
      para.lines.push({ runs, num: num || undefined });
      prevLine = { page: e.page, c: e.c, bottom: l.bottom, x0 };
    }
    for (const b of blocks) if (b.t === 'p') { delete b.hanging; delete b.block; }
    return blocks;
  }

  function leftMargins(els) {
    // most common line start x per page+column (the body margin)
    const hist = {};
    for (const e of els) if (e.type === 'line') {
      const k = `${e.page}:${e.c}`;
      let x = e.line.x0;
      const it = e.line.items;
      if (it.length > 1 && /^\d{1,3}$/.test(it[0].s.trim()) && (it[0].h < e.line.h - 0.5 || it[0].lnum || +it[0].s.trim() % 5 === 0)) x = it[1].x;
      hist[k] = hist[k] || {};
      const b = Math.round(x);
      hist[k][b] = (hist[k][b] || 0) + 1;
    }
    const out = {};
    for (const k in hist) {
      const entries = Object.entries(hist[k]).sort((a, b) => b[1] - a[1] || a[0] - b[0]);
      // choose the smallest x among frequent values
      const top = entries[0][1];
      // the body margin is the most common line start; a smaller x only wins if nearly as common
      out[k] = Math.min(...entries.filter((e) => e[1] >= top * 0.8).map((e) => +e[0]));
    }
    return out;
  }

  // ---------- English ----------
  function buildEnglish(pages, sec, stream, claimed, questions, passages, directions, warnings) {
    let cur = null;
    const qByN = new Map(questions.map((q) => [q.n, q]));
    const passageLines = []; // {e, passageIdx}
    for (const e of stream) {
      if (claimed.has(e)) continue;
      if (e.type === 'line' && PASSAGE_RE.test(e.line.text) && e.line.text.length < 30) {
        cur = { title: romanFix(e.line.text.trim()), els: [], start: e };
        passages.push(cur);
        continue;
      }
      if (!cur) { if (e.type === 'line') directions.push(e); continue; }
      if (e.c === 1) continue; // right column holds only questions
      cur.els.push(e);
    }
    // markers & underlines per passage
    for (let pi = 0; pi < passages.length; pi++) {
      const p = passages[pi];
      const els = [];
      const markers = [];
      for (const e of p.els) {
        if (e.type === 'line' && isMarkerLine(e.line, pages[e.page - 1].k || 1)) { markers.push(e); continue; }
        // OCR leaves unreadable bits of the tiny question markers as short stray lines
        if (e.type === 'line' && pages[e.page - 1].ocr && e.line.text.length <= 3 && !/^\[[\dA-Z]\]$/.test(e.line.text)) continue;
        els.push(e);
      }
      // subtitle: first bold line
      const first = els.find((e) => e.type === 'line');
      if (first && first.line.items.every((i) => i.bold || !i.s.trim()) && first.line.text.length < 80) {
        p.subtitle = first.line.text;
        els.splice(els.indexOf(first), 1);
      }
      // annotate each line's chars with underline + marker info
      const pageCache = {};
      for (const e of els) {
        if (e.type !== 'line') continue;
        const pg = pages[e.page - 1];
        const L = e.line;
        const kk = pg.k || 1;
        const unders = pg.hlines.filter((h) => h.y0 > L.y - 0.5 && h.y0 < L.y + 5.5 * kk && h.x1 > L.x0 - 2 && h.x0 < L.x1 + 2 && (h.x0 + h.x1) / 2 < pg.mid);
        const lineMarkers = [];
        for (const m of markers) {
          if (m.page !== e.page) continue;
          const d = m.line.y - L.y;
          if (d > 4 * (pg.k || 1) && d < 14 * (pg.k || 1)) for (const it of m.line.items) {
            for (const num of it.s.trim().split(/\s+/)) if (/^\d{1,2}$/.test(num)) lineMarkers.push({ n: +num, x: it.x + it.w / 2 });
          }
        }
        for (const it of L.items) if (it.box) lineMarkers.push({ n: null, x: it.x + it.w / 2, box: true, onLine: true });
        L.eng = { unders, markers: lineMarkers };
      }
      p.blocks = englishBlocks(els, pages);
      delete p.els;
      delete p.start;
    }

    function englishBlocks(els) {
      // Build blocks with elsToBlocks, then rebuild runs with underline/marker attributes.
      const blocks = [];
      let para = null, prevL = null;
      const qset = new Set();
      const margins = leftMargins(els);
      let openU = null; // question number carried across line breaks
      const alignUsed = new Set();
      for (const e of els) {
        if (e.type === 'fig') { blocks.push({ t: 'fig', page: e.page, rect: e.rect }); para = null; continue; }
        const L = e.line;
        const text = L.text;
        const margin = margins[`${e.page}:${e.c}`] ?? L.x0;
        const indent = L.x0 - margin > 6;
        const pnum = /^\[\d+\]$/.test(text);
        const gap = prevL && prevL.page === e.page ? L.top - prevL.bottom : 0;
        const startPara = !para || pnum || para.pnum || (indent && gap > -1) ;
        if (startPara) {
          para = { t: 'p', lines: [], indent: indent && !pnum, pnum: pnum || undefined };
          blocks.push(para);
        }
        prevL = { page: e.page, bottom: L.bottom };
        if (!L.eng) { para.lines.push({ runs: itemsToRuns(L.items) }); continue; }
        // character model
        const chars = [];
        let prev = null;
        for (const it of L.items) {
          if (it.box) continue;
          const cs = charCenters(it);
          if (prev && it.x - prev.x1 > Math.max(prev.h, it.h) * 0.18 && !/\s$/.test(prev.s) && !/^\s/.test(it.s)) chars.push({ ch: ' ', x: (prev.x1 + it.x) / 2, it });
          for (let k = 0; k < it.s.length; k++) chars.push({ ch: it.s[k], x: cs[k], it });
          prev = it;
        }
        // underline spans → question numbers
        const spans = L.eng.unders.map((u) => ({ x0: u.x0, x1: u.x1, n: null }));
        spans.sort((a, b) => a.x0 - b.x0);
        // merge touching spans
        for (let k = spans.length - 1; k > 0; k--) if (spans[k].x0 - spans[k - 1].x1 < 1.5) { spans[k - 1].x1 = Math.max(spans[k - 1].x1, spans[k].x1); spans.splice(k, 1); }
        const usedMarkers = new Set();
        for (const s of spans) {
          const m = L.eng.markers.find((m) => !m.box && m.x >= s.x0 - 3 && m.x <= s.x1 + 3);
          if (m) { s.n = m.n; usedMarkers.add(m); }
        }
        // spans without markers: continuation of an underline broken over lines
        for (let k = 0; k < spans.length; k++) {
          const s = spans[k];
          if (s.n != null) continue;
          if (k === 0 && openU != null && s.x0 - L.x0 < 4) s.n = openU;
        }
        // still unknown (marker unreadable, e.g. scans): the question printed level with the underline
        for (const s of spans) {
          if (s.n != null || (s === spans[spans.length - 1] && L.x1 - s.x1 < 4 && false)) continue;
          const near = questions.filter((q) => q.page === e.page && !alignUsed.has(q.n) && Math.abs(q.start.line.top - L.top) < 16)
            .sort((a, b) => a.n - b.n);
          if (near.length) { s.n = near[0].n; alignUsed.add(s.n); }
        }
        for (let k = spans.length - 1; k >= 0; k--) {
          const s = spans[k];
          if (s.n != null) continue;
          if (k === spans.length - 1 && L.x1 - s.x1 < 4) s.pendingNext = true;
        }
        const lastSpan = spans[spans.length - 1];
        openU = lastSpan && L.x1 - lastSpan.x1 < 4 && lastSpan.n != null ? lastSpan.n : null;
        for (const s of spans) if (s.n != null) qset.add(s.n);
        // point markers (no underline): insert at x
        const points = L.eng.markers.filter((m) => !usedMarkers.has(m) && !(m.box && spans.some((s) => m.x >= s.x0 - 3 && m.x <= s.x1 + 3)));
        for (const m of points) qset.add(m.n);
        // assign chars
        for (const c of chars) {
          const s = spans.find((s) => c.x >= s.x0 - 0.5 && c.x <= s.x1 + 0.5);
          if (s) c.u = s.n ?? s.pending ?? -1;
          if (s && s.pendingNext) c.pendingNext = true;
        }
        // trim spaces at underline edges
        for (let k = 0; k < chars.length; k++) if (chars[k].u != null && chars[k].ch === ' ') {
          const before = chars[k - 1] && chars[k - 1].u === chars[k].u;
          const after = chars[k + 1] && chars[k + 1].u === chars[k].u;
          if (!(before && after)) chars[k].u = undefined;
        }
        const runs = [];
        let lastU;
        const pointsSorted = points.slice().sort((a, b) => a.x - b.x);
        let pk = 0;
        for (let k = 0; k < chars.length; k++) {
          const c = chars[k];
          while (pk < pointsSorted.length && pointsSorted[pk].x < c.x && !(c.ch !== ' ' && k > 0 && chars[k - 1].ch !== ' ' && pointsSorted[pk].x > chars[k - 1].x)) {
            runs.push({ t: 'm', n: pointsSorted[pk].n, point: true }); pk++;
          }
          if (c.u != null && c.u !== lastU && c.u !== -1) runs.push({ t: 'm', n: c.u });
          lastU = c.u;
          push(runs, { s: c.ch, i: c.it.italic || undefined, b: c.it.bold || undefined, sub: c.it.sub || undefined, sup: c.it.sup || undefined, u: c.u });
        }
        while (pk < pointsSorted.length) { runs.push({ t: 'm', n: pointsSorted[pk].n, point: true }); pk++; }
        para.lines.push({ runs });
      }
      // resolve -1 (unknown) underlines that continue onto the next line: take the next span's number
      const allRuns = blocks.filter((b) => b.t === 'p').flatMap((b) => b.lines.flatMap((l) => l.runs));
      let nextN = null;
      for (let k = allRuns.length - 1; k >= 0; k--) {
        const r = allRuns[k];
        if (r.u != null && r.u !== -1) nextN = r.u;
        else if (r.u === -1) r.u = nextN;
        else if (r.t !== 'm' && r.s && r.s.trim()) nextN = null;
      }
      // Drop marker boxes for continuation of the same underline onto a new line
      for (const b of blocks) if (b.t === 'p') {
        let lastU = null;
        for (const l of b.lines) {
          l.runs = l.runs.filter((r) => {
            if (r.t === 'm' && !r.point) { if (r.n === lastU) return false; }
            if (r.t !== 'm' && r.s.trim()) lastU = r.u ?? null;
            return true;
          });
        }
      }
      return blocks;
    }
    // boxed numbers whose glyphs didn't survive extraction: infer from the gaps in the sequence
    {
      const all = [];
      for (const p of passages) for (const b of p.blocks || []) if (b.t === 'p') for (const l of b.lines) for (const r of l.runs) if (r.t === 'm') all.push(r);
      const present = new Set(all.filter((r) => r.n != null).map((r) => r.n));
      const qnums = questions.map((q) => q.n);
      for (let k = 0; k < all.length; k++) {
        if (all[k].n != null) continue;
        let prevN = 0;
        for (let j = k - 1; j >= 0; j--) if (all[j].n != null) { prevN = all[j].n; break; }
        const cand = qnums.find((n) => n > prevN && !present.has(n));
        if (cand != null) { all[k].n = cand; present.add(cand); } else all[k].drop = true;
      }
      for (const p of passages) for (const b of p.blocks || []) if (b.t === 'p') for (const l of b.lines) l.runs = l.runs.filter((r) => !r.drop);
    }
    for (const p of passages) {
      const nums = new Set();
      for (const b of p.blocks || []) if (b.t === 'p') for (const l of b.lines) for (const r of l.runs) if (r.t === 'm') nums.add(r.n); else if (r.u) nums.add(r.u);
      p.questionNums = [...nums].sort((a, b) => a - b);
    }
    for (const q of questions) {
      const pi = passages.findIndex((p) => p.questionNums.includes(q.n));
      if (pi >= 0) q.passage = pi;
    }
    for (const q of questions) {
      if (q.passage != null) continue;
      let best = null;
      for (let pi = 0; pi < passages.length; pi++) if (passages[pi].questionNums.length && passages[pi].questionNums[0] <= q.n) best = pi;
      q.passage = best ?? (passages.length ? 0 : null);
    }
    const unmatched = questions.filter((q) => !passages.some((p) => p.questionNums.includes(q.n))).map((q) => q.n);
    if (unmatched.length > Math.max(3, questions.length * 0.2)) warnings.push(`no underline/marker found in the passage for question${unmatched.length > 1 ? 's' : ''} ${unmatched.join(', ')}`);
  }

  function isMarkerLine(l, k = 1) {
    return l.h <= 7.6 * k && l.items.every((i) => /^\s*\d{1,2}(\s+\d{1,2})*\s*$/.test(i.s));
  }

  TS.parser = { VERSION: 7, parsePdf, analyzePdf, scanPdf, buildSection, guessKind: (ctx) => guessKind(ctx.pages), parseKeyText, KINDS, KIND_NAMES, runsText, _dev: { extractPage, prepPage, buildClusters, pageStream, buildQuestion, strayInk, inkMap } };
})();
