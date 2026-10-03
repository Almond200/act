/* Testside — IndexedDB persistence: parsed tests, their source PDFs, attempts. */
(function () {
  'use strict';
  const TS = (window.TS = window.TS || {});
  let dbp = null;

  function db() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open('testside', 2);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('tests')) d.createObjectStore('tests', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('pdfs')) d.createObjectStore('pdfs');
        if (!d.objectStoreNames.contains('ocr')) d.createObjectStore('ocr');
        if (!d.objectStoreNames.contains('attempts')) {
          const s = d.createObjectStore('attempts', { keyPath: 'id' });
          s.createIndex('testId', 'testId');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }

  async function tx(store, mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction(store, mode);
      const r = fn(t.objectStore(store));
      t.oncomplete = () => resolve(r instanceof IDBRequest ? r.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }
  const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  TS.store = {
    uid,
    async listTests() { const d = await db(); return reqP(d.transaction('tests').objectStore('tests').getAll()); },
    async getTest(id) { const d = await db(); return reqP(d.transaction('tests').objectStore('tests').get(id)); },
    async putTest(t) { return tx('tests', 'readwrite', (s) => s.put(t)); },
    async deleteTest(id) {
      const t = await this.getTest(id);
      const pid = (t && t.pdfId) || id;
      await tx('tests', 'readwrite', (s) => s.delete(id));
      // a book PDF is shared by every test imported from it: keep it while another test uses it
      const others = (await this.listTests()).some((o) => (o.pdfId || o.id) === pid);
      if (!others) await tx('pdfs', 'readwrite', (s) => s.delete(pid));
      const atts = await this.listAttempts(id);
      await tx('attempts', 'readwrite', (s) => { for (const a of atts) s.delete(a.id); });
    },
    async getPdf(id) { const d = await db(); return reqP(d.transaction('pdfs').objectStore('pdfs').get(id)); },
    async putPdf(id, bytes) { return tx('pdfs', 'readwrite', (s) => s.put(bytes, id)); },
    // PDF bytes for a test (tests from the same book share one stored copy)
    async testPdf(t) { return this.getPdf(t.pdfId || t.id); },
    async hasPdf(id) { const d = await db(); return (await reqP(d.transaction('pdfs').objectStore('pdfs').getKey(id))) !== undefined; },
    // content key for a PDF: size + samples of its bytes (cheap, stable across re-uploads)
    pdfKey(bytes) {
      let h = 2166136261;
      const step = Math.max(1, Math.floor(bytes.length / 65536));
      for (let i = 0; i < bytes.length; i += step) { h ^= bytes[i]; h = Math.imul(h, 16777619); }
      for (let i = Math.max(0, bytes.length - 4096); i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 16777619); }
      return `pdf:${bytes.length}:${(h >>> 0).toString(36)}`;
    },
    async getOcr(key) { const d = await db(); return reqP(d.transaction('ocr').objectStore('ocr').get(key)); },
    async putOcr(key, val) { return tx('ocr', 'readwrite', (s) => s.put(val, key)); },
    async listAttempts(testId) {
      const d = await db();
      const s = d.transaction('attempts').objectStore('attempts');
      return reqP(testId ? s.index('testId').getAll(testId) : s.getAll());
    },
    async getAttempt(id) { const d = await db(); return reqP(d.transaction('attempts').objectStore('attempts').get(id)); },
    async putAttempt(a) { return tx('attempts', 'readwrite', (s) => s.put(a)); },
    async deleteAttempt(id) { return tx('attempts', 'readwrite', (s) => s.delete(id)); },
  };

  // small synchronous prefs
  const PREF_KEY = 'testside:prefs';
  const defaults = { zoom: 100, name: 'Student', lineNumbers: true, readingLayout: 'paragraphs', timerHidden: false, contrast: 'default' };
  TS.prefs = {
    get() { try { return { ...defaults, ...JSON.parse(localStorage.getItem(PREF_KEY) || '{}') }; } catch (e) { return { ...defaults }; } },
    set(patch) { const v = { ...this.get(), ...patch }; try { localStorage.setItem(PREF_KEY, JSON.stringify(v)); } catch (e) { /* ignore */ } return v; },
  };
})();
