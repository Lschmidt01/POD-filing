/**
 * Splitter.gs — turns one scanned attachment into individual BOL PDFs.
 *
 * Gemini reads the whole scan and returns each BOL's page range + fields (see
 * Gemini.gs); pdf-lib then carves them into separate PDFs.
 *
 * We segment by each BOL's START page (the reliable signal — Gemini reads the
 * "Page 1 of N" header well, but its end-page count can be off on messy real
 * scans with separator/cover pages). BOL i then spans from its start to the page
 * before the next BOL's start (the last runs to the end of the scan). This tiles
 * the whole scan with no gaps or overlaps by construction, so an imperfect read
 * still files every BOL instead of dumping the stack to _Unsorted (NFR-1). Only a
 * scan Gemini returns nothing usable for goes to review.
 *
 * pdf-lib is async, and Apps Script awaits an async entry function, so callers
 * must `await Splitter.split(...)`.
 */

const Splitter = {
  /**
   * @param {Blob} pdfBlob the scanned PDF (one or more BOLs)
   * @returns {Promise<{ok:boolean, reason:string, bols:Array<{blob:Blob,
   *          fields:object, pageCount:number}>}>}
   */
  async split(pdfBlob) {
    const parsed = Gemini.readBols(pdfBlob);
    if (!parsed || !parsed.length) {
      return { ok: false, reason: 'Gemini found no BOLs in the scan.', bols: [] };
    }

    const src = await PDFLib.PDFDocument.load(new Uint8Array(pdfBlob.getBytes()));
    const total = src.getPageCount();

    const segs = this._segments(parsed, total);
    if (!segs.length) {
      return { ok: false, reason: 'No usable page numbers from Gemini.', bols: [] };
    }

    const bols = [];
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      const indices = [];
      for (let p = seg.start; p <= seg.end; p++) indices.push(p - 1); // pdf-lib is 0-based

      const out = await PDFLib.PDFDocument.create();
      (await out.copyPages(src, indices)).forEach(p => out.addPage(p));

      bols.push({
        blob: this._toBlob(await out.save(), 'bol-' + (i + 1) + '.pdf'),
        pageCount: indices.length,
        fields: seg.fields
      });
    }
    return { ok: true, reason: '', bols };
  },

  /**
   * Contiguous page segments covering the whole scan, one per BOL, derived from
   * BOL start pages. Dedupes/sorts starts, pins the first to page 1 (any leading
   * pages belong to the first BOL), and runs each segment up to the next start.
   */
  _segments(parsed, total) {
    const seen = {};
    const starts = parsed
      .map(b => ({ start: Math.max(1, Math.min(total, Math.round(b.page_start))), src: b }))
      .sort((a, z) => a.start - z.start)
      .filter(x => (seen[x.start] ? false : (seen[x.start] = true)));

    if (!starts.length) return [];
    starts[0].start = 1;

    const segs = [];
    for (let i = 0; i < starts.length; i++) {
      const start = starts[i].start;
      const end = (i + 1 < starts.length) ? starts[i + 1].start - 1 : total;
      if (start > end) continue;
      const b = starts[i].src;
      segs.push({
        start: start,
        end: end,
        fields: {
          customerName: b.customer || '',
          deliveryDate: b.delivery_date || '',
          shipDate: b.delivery_date || '', // Gemini already resolves ship->delivery
          invoiceNumber: b.invoice_number || '',
          customerPO: b.customer_po || ''
        }
      });
    }
    return segs;
  },

  /** Uint8Array (from pdf-lib .save) -> a Drive-ready PDF Blob (signed bytes). */
  _toBlob(u8, name) {
    const signed = new Array(u8.length);
    for (let i = 0; i < u8.length; i++) signed[i] = u8[i] > 127 ? u8[i] - 256 : u8[i];
    return Utilities.newBlob(signed, 'application/pdf', name);
  }
};
