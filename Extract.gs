/**
 * Extract.gs — pulls the filing/searching fields out of Drive-OCR text.
 *
 * What we file/search by (all confirmed against real Drive-OCR output):
 *   - customerName   Ship-To location, e.g. "US Foods - Salt Lake City" (folder)
 *   - shipDate       top-right "Ship Date" — reads cleanly; drives Year/Month
 *   - deliveryDate   best-effort from the flattened date row; falls back to ship
 *   - invoiceNumber  "Driver Confirmation" number (== invoice #), searchable
 *   - customerPO     "Customer PO Number", searchable (best-effort)
 *
 * Why this shape: Drive OCR reads isolated, labelled fields (Ship To, Driver
 * Confirmation, Ship Date, Customer PO) reliably, but flattens the bordered
 * table — so the three dates come out as a bare vertical cluster in column
 * order (Order, Ship, Delivery). We only need Year+Month to file, which the
 * top ship date gives us reliably; the exact delivery date is recovered
 * best-effort from the cluster with a sanity check, else we fall back.
 */

const DATE_LINE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/; // a cell that is only a date

const Extract = {
  /**
   * @param {string} text OCR output
   * @returns {{customerName:string, invoiceNumber:string, customerPO:string,
   *            shipDate:string, deliveryDate:string}}
   */
  parse(text) {
    const raw = String(text || '').replace(/\r/g, '');
    const lines = raw.split('\n').map(l => l.trim());
    const nonEmpty = lines.filter(Boolean);

    const customerName = this._shipTo(lines);
    const invoiceNumber = this._match(raw, /Driver\s*Confirmation\s*#?\s*(\d{4,})/i);
    const customerPO = this._customerPO(lines);

    // Ship date (top-right, isolated) → the reliable anchor for Year/Month.
    let shipDate = this._labelDate(lines, /^Ship\s*Date/i);

    // Delivery date, best-effort, from the flattened Order/Ship/Delivery cluster.
    let deliveryDate = this._deliveryDate(nonEmpty, shipDate);

    // Fallbacks so a date is always available for foldering.
    if (!shipDate && deliveryDate) shipDate = deliveryDate;
    if (!deliveryDate) deliveryDate = shipDate;

    return { customerName, invoiceNumber, customerPO, shipDate, deliveryDate };
  },

  /** First non-empty line after a "Ship To" label (handles same-line too). */
  _shipTo(lines) {
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^ship\s*to\s*:?\s*(.*)$/i);
      if (!m) continue;
      if (m[1]) return this._cleanName(m[1]);           // "Ship To: US Foods ..."
      for (let j = i + 1; j < lines.length; j++) {      // name on the next line
        if (lines[j]) return this._cleanName(lines[j]);
      }
    }
    return '';
  },

  /**
   * Customer PO — search the region just after its label, bounded by the start
   * of the line-items table (so we never grab an item/customer-item number).
   */
  _customerPO(lines) {
    const start = lines.findIndex(l => /customer\s*po\s*number/i.test(l));
    if (start < 0) return '';
    for (let j = start + 1; j < lines.length; j++) {
      if (/quantity|ordered|description|^item\b/i.test(lines[j])) break; // hit items
      const m = lines[j].match(/\b(\d{5,}[A-Z]?)\b/);
      if (m) return m[1];
    }
    return '';
  },

  /** A date value sitting on the same line as its label, e.g. "Ship Date 6/24/2026". */
  _labelDate(lines, labelRe) {
    for (const line of lines) {
      if (!labelRe.test(line)) continue;
      const m = line.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
      if (m) return this._toIso(m[1], m[2], m[3]);
    }
    return '';
  },

  /**
   * The flattened table emits Order/Ship/Delivery dates as consecutive
   * date-only lines. Take the last of the first run of >=3 as the delivery
   * date, but only trust it if it is >= the ship date (calendar order).
   */
  _deliveryDate(nonEmpty, shipDateIso) {
    const run = this._firstDateRun(nonEmpty);
    if (run.length < 3) return '';           // blank cell shifted positions — don't guess
    const candidate = run[run.length - 1];
    if (shipDateIso && candidate < shipDateIso) return ''; // fails sanity check
    return candidate;
  },

  /** ISO dates of the first run of >=2 consecutive date-only lines. */
  _firstDateRun(nonEmpty) {
    let run = [];
    for (const line of nonEmpty) {
      const m = line.match(DATE_LINE);
      if (m) {
        run.push(this._toIso(m[1], m[2], m[3]));
      } else if (run.length >= 2) {
        return run;                          // first real run ends
      } else {
        run = [];
      }
    }
    return run.length >= 2 ? run : [];
  },

  _match(text, re) {
    const m = text.match(re);
    return m ? m[1].trim() : '';
  },

  _cleanName(s) {
    return String(s).replace(/\s+/g, ' ').trim();
  },

  /** m/d/yyyy parts → yyyy-MM-dd (sortable, and comparable as strings). */
  _toIso(mm, dd, yyyy) {
    const p = n => ('0' + n).slice(-2);
    return yyyy + '-' + p(mm) + '-' + p(dd);
  }
};
