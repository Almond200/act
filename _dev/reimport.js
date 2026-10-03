// Dev helper: wipe tests and re-import the sample PDFs with the current parser.
window.devReimport = async function (names = ['pt2.pdf', 'a1d.pdf']) {
  const out = [];
  for (const name of names) {
    const bytes = new Uint8Array(await (await fetch('/_dev/' + name)).arrayBuffer());
    const r = await TS.parser.parsePdf(bytes);
    const id = name.replace('.pdf', '');
    await TS.store.putPdf(id, bytes);
    await TS.store.putTest({ id, title: r.title || name, created: Date.now(), fileName: name, pageCount: r.pageCount, sections: r.sections.map((s) => ({ ...s, warnings: undefined })) });
    out.push(`${name}: ${r.sections.map((s) => `${s.kind} ${s.questions.length}q key ${s.keyCount}`).join(', ')} | ${r.warnings.join(' ; ')}`);
  }
  TS.app.showLibrary();
  return out.join('\n');
};

// Dev helper: analyze one candidate test from a big (possibly scanned) PDF and keep ctx around.
window.devScanned = async function (name, ci, save) {
  const bytes = window['BYTES_' + name] || (window['BYTES_' + name] = new Uint8Array(await (await fetch('/_dev/' + name)).arrayBuffer()));
  const idx = window['IDX_' + name] || (window['IDX_' + name] = await TS.parser.scanPdf(bytes));
  const c = idx.candidates[ci];
  const pages = new Set();
  for (let p = c.start; p <= c.end; p++) pages.add(p);
  c.keyPages.forEach((p) => pages.add(p));
  const ocr = [];
  if (c.scanned) for (let p = c.start; p <= c.end; p++) ocr.push(p);
  const t0 = performance.now();
  const ctx = await TS.parser.analyzePdf(bytes, (f, m) => { window.PROG = m; }, { pages: [...pages], ocr, texts: idx.texts, expl: c.expl });
  window.CTX = ctx;
  const secs = ctx.detected.map((f) => TS.parser.buildSection(ctx, f));
  window.SECS = secs;
  if (save) {
    const id = name.replace('.pdf', '') + '-' + ci;
    await TS.store.putPdf(id, bytes);
    await TS.store.putTest({ id, title: c.label, created: Date.now(), fileName: name, pageCount: idx.numPages, sections: secs.map((s) => ({ ...s, warnings: undefined })) });
  }
  return `${Math.round(performance.now() - t0)}ms ` + secs.map((s) => `${s.kind} p${s.pages} q=${s.questions.length}/${s.expected} pass=${s.passages.length} key=${s.keyCount} expl=${s.questions.filter((q) => q.explanation).length} | ${s.warnings.join('; ')}`).join('\n');
};

// Dev helper: re-parse a stored (text-layer) test in place, keeping its id/title.
window.devReparse = async function (id) {
  const t = await TS.store.getTest(id);
  const r = await TS.parser.parsePdf(await TS.store.getPdf(id));
  t.sections = r.sections.map((s) => ({ ...s, warnings: undefined }));
  await TS.store.putTest(t);
  return `${t.title}: ${r.sections.map((s) => `${s.kind} ${s.questions.length} key ${s.keyCount}`).join(', ')} | ${r.warnings.join('; ')}`;
};
