/**
 * Ocr.gs — reads printed text off a scanned PDF using Google Drive's built-in
 * OCR (free, and the bytes never leave this Google account).
 *
 * Converts the PDF to a temporary Google Doc with OCR enabled, reads the text,
 * then deletes the working Doc — only the original PDF is ever retained (FR-16).
 */

const Ocr = {
  /**
   * @param {Blob} pdfBlob original PDF bytes
   * @returns {string} extracted text ('' if unreadable)
   */
  extractText(pdfBlob) {
    const inserted = this._insertWithRetry(pdfBlob);
    try {
      return DocumentApp.openById(inserted.id).getBody().getText() || '';
    } finally {
      try { Drive.Files.remove(inserted.id); } catch (e) { /* best-effort cleanup */ }
    }
  },

  /**
   * Upload + convert to a Google Doc with OCR. Do NOT set the target mimeType to
   * a Doc, or Drive treats the source as a Doc and rejects OCR. Drive imposes a
   * short-term OCR rate limit, so back off and retry a few times before giving up.
   */
  _insertWithRetry(pdfBlob) {
    let delayMs = 2000;
    for (let attempt = 0; ; attempt++) {
      try {
        return Drive.Files.insert(
          { title: 'ocr-tmp-' + Date.now() },
          pdfBlob,
          { ocr: true, convert: true, ocrLanguage: 'en' }
        );
      } catch (e) {
        const msg = String((e && e.message) || e);
        const transient = /rate limit|ratelimit|user rate|quota|backend|try again|internal error/i.test(msg);
        if (attempt >= 4 || !transient) throw e;
        Utilities.sleep(delayMs);
        delayMs = Math.min(delayMs * 2, 20000);
      }
    }
  }
};
