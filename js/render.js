/* Testside — renders PDF regions (figures, math) as crisp images. */
(function () {
  'use strict';
  const TS = (window.TS = window.TS || {});
  const RENDER_SCALE = 3.2; // device pixels per PDF point
  let doc = null, docId = null;
  const pageCanvases = new Map(); // page -> Promise<canvas>
  const crops = new Map(); // key -> Promise<url>

  async function open(id, bytes) {
    if (docId === id && doc) return;
    close();
    docId = id;
    doc = await pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;
  }
  function close() {
    if (doc) doc.destroy();
    doc = null; docId = null;
    pageCanvases.clear();
    for (const p of crops.values()) p.then((u) => URL.revokeObjectURL(u)).catch(() => {});
    crops.clear();
  }

  function pageCanvas(n) {
    if (pageCanvases.has(n)) return pageCanvases.get(n);
    const p = (async () => {
      const page = await doc.getPage(n);
      const vp = page.getViewport({ scale: RENDER_SCALE });
      const c = document.createElement('canvas');
      c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      // 'print' intent renders without requestAnimationFrame, so it also completes in background tabs
      await page.render({ canvasContext: ctx, viewport: vp, intent: 'print' }).promise;
      return c;
    })();
    pageCanvases.set(n, p);
    // keep memory bounded
    if (pageCanvases.size > 8) pageCanvases.delete(pageCanvases.keys().next().value);
    return p;
  }

  function crop(page, rect) {
    const key = `${page}:${rect.join(',')}`;
    if (crops.has(key)) return crops.get(key);
    const p = (async () => {
      const src = await pageCanvas(page);
      const [x0, y0, x1, y1] = rect.map((v) => v * RENDER_SCALE);
      const w = Math.max(1, Math.round(x1 - x0)), h = Math.max(1, Math.round(y1 - y0));
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
      ctx.drawImage(src, Math.round(x0), Math.round(y0), w, h, 0, 0, w, h);
      // (toBlob waits ~1 s when the tab isn't in front; toDataURL is synchronous and fast)
      return c.toDataURL('image/png');
    })();
    crops.set(key, p);
    return p;
  }

  // Build an <img> for a crop; width follows the PDF size × scale (1pt ≈ scale px)
  function img(block, scale) {
    const el = document.createElement('img');
    el.className = 'crop';
    el.alt = 'Figure';
    el.draggable = false;
    const [x0, y0, x1, y1] = block.rect;
    el.style.width = `${(x1 - x0) * scale}px`;
    el.style.aspectRatio = `${x1 - x0} / ${y1 - y0}`;
    if (!doc) return el;
    crop(block.page, block.rect).then((u) => { el.src = u; }).catch((e) => console.error(e));
    return el;
  }

  // Warm the cache for blocks about to be shown (the next question's figures / scanned choices).
  function prefetch(blocks) {
    if (!doc) return;
    for (const b of blocks || []) if (b && b.t === 'fig' && b.rect) crop(b.page, b.rect).catch(() => {});
  }

  TS.render = { open, close, img, crop, prefetch, get openId() { return docId; } };
})();
