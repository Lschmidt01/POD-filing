/**
 * Gemini.gs — reads scanned BOLs with Google's Gemini API (free tier).
 *
 * One call per scan: send the whole PDF and get back a structured list of the
 * BOLs it contains, each with its 1-based page range plus the fields we file and
 * search by. This replaces both OCR and the footer-regex splitter grouping — the
 * vision model reads the page directly and segments the stack itself.
 *
 * The API key lives in the GEMINI_API_KEY script property (never in code).
 * Requires the script.external_request scope.
 */

const GEMINI_PROMPT =
  'This scanned PDF contains one or more Bills of Lading (BOLs) stacked together. '
  + 'Each BOL has a "Page X of Y" footer at the bottom of every page: a page reading '
  + '"Page 1 of N" begins a new BOL that spans N pages. For every BOL, return:\n'
  + '- page_start and page_end: 1-based, inclusive page numbers covering that BOL.\n'
  + '- customer: the "Ship To" company name plus its city/location label only, e.g. '
  + '"US Foods - Salt Lake City". Do NOT include the street address, suite, state, or '
  + 'ZIP. Use the "Ship To", NOT the "Bill To" and NOT the letterhead company that '
  + 'issued the document.\n'
  + '- delivery_date: the Delivery Date, formatted strictly as YYYY-MM-DD (zero-padded, '
  + '4-digit year first). If only a Ship Date is present, use that.\n'
  + '- invoice_number: the "Driver Confirmation" number.\n'
  + '- customer_po: the "Customer PO Number".\n'
  + 'Use an empty string for any field you cannot read. Return the BOLs in document order.';

const GEMINI_SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      page_start: { type: 'INTEGER' },
      page_end: { type: 'INTEGER' },
      customer: { type: 'STRING' },
      delivery_date: { type: 'STRING' },
      invoice_number: { type: 'STRING' },
      customer_po: { type: 'STRING' }
    },
    required: ['page_start', 'page_end', 'customer', 'delivery_date',
      'invoice_number', 'customer_po']
  }
};

const Gemini = {
  /**
   * @param {Blob} pdfBlob the scanned PDF (one or more BOLs)
   * @returns {Array<{page_start:number, page_end:number, customer:string,
   *   delivery_date:string, invoice_number:string, customer_po:string}>}
   */
  readBols(pdfBlob) {
    const model = Config.get('GEMINI_MODEL');
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/'
      + encodeURIComponent(model) + ':generateContent';

    const payload = {
      contents: [{
        role: 'user',
        parts: [
          { inline_data: { mime_type: 'application/pdf',
                           data: Utilities.base64Encode(pdfBlob.getBytes()) } },
          { text: GEMINI_PROMPT }
        ]
      }],
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
        responseSchema: GEMINI_SCHEMA
      }
    };

    const res = this._fetchWithRetry(url, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-goog-api-key': this._apiKey() },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    const code = res.getResponseCode();
    const text = res.getContentText();
    if (code !== 200) {
      // Distinguish the per-DAY quota (won't clear until reset) from other errors,
      // so the pipeline can pause itself for the day instead of churning.
      if (code === 429 && /per\s*day|"[^"]*PerDay[^"]*"/i.test(text)) {
        throw new Error('GEMINI_QUOTA_EXHAUSTED: daily request limit reached. ' + text.slice(0, 300));
      }
      throw new Error('Gemini HTTP ' + code + ': ' + text.slice(0, 600));
    }

    const body = JSON.parse(text);
    const cand = body.candidates && body.candidates[0];
    if (!cand || !cand.content || !cand.content.parts || !cand.content.parts[0]) {
      throw new Error('Gemini returned no content: ' + text.slice(0, 600));
    }
    return JSON.parse(cand.content.parts[0].text);
  },

  /**
   * The free tier caps at ~15 requests/minute; a burst (e.g. reprocessing many
   * emails at once) gets 429s. Back off and retry so a rate limit waits it out
   * instead of dropping the scan into _Unsorted.
   */
  _fetchWithRetry(url, options) {
    let delayMs = 4000;
    for (let attempt = 0; ; attempt++) {
      const res = UrlFetchApp.fetch(url, options);
      const code = res.getResponseCode();
      if (code === 200) return res;
      // A per-day quota won't clear by waiting — bail immediately so the caller
      // can pause for the day instead of burning retries.
      if (code === 429 && /per\s*day|PerDay/i.test(res.getContentText())) return res;
      const retryable = code === 429 || code === 500 || code === 503;
      if (attempt >= 5 || !retryable) return res; // give up; caller surfaces the error
      Utilities.sleep(delayMs);
      delayMs = Math.min(delayMs * 2, 30000);
    }
  },

  _apiKey() {
    const k = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
    if (!k) throw new Error('GEMINI_API_KEY script property is not set.');
    return k;
  }
};

