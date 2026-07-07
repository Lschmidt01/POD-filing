/**
 * Customers.gs — the customer master list (Google Sheet, tab "Customers").
 * Owns all reads/writes to that tab. Matching logic lives in Match.gs.
 *
 * Columns: canonical_name | aliases | folder_id | active   (see FR/6.1)
 */

let _customersCache = null;

const Customers = {
  _sheet() { return getWorkbook().getSheetByName(CUSTOMERS_TAB); },

  /**
   * @returns {Array<{canonical_name:string, aliases:string[], folder_id:string,
   *                   active:boolean, rowIndex:number}>}
   * rowIndex is the 1-based sheet row (for write-back).
   */
  all() {
    if (_customersCache) return _customersCache;
    const sheet = this._sheet();
    _customersCache = [];
    if (sheet.getLastRow() > 1) {
      const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 4).getValues();
      values.forEach((r, i) => {
        const canonical = String(r[0]).trim();
        if (!canonical) return;
        _customersCache.push({
          canonical_name: canonical,
          aliases: String(r[1] || '').split(';').map(s => s.trim()).filter(Boolean),
          folder_id: String(r[2] || '').trim(),
          active: String(r[3]).toLowerCase() !== 'false', // default active
          rowIndex: i + 2
        });
      });
    }
    return _customersCache;
  },

  /** Adds a new canonical customer and returns the record. Invalidates cache. */
  add(canonicalName) {
    const sheet = this._sheet();
    sheet.appendRow([canonicalName, '', '', 'TRUE']);
    _customersCache = null;
    return this.all().find(c => c.canonical_name === canonicalName);
  },

  /** Persists a folder id back onto a customer row. */
  setFolderId(customer, folderId) {
    const col = 3; // folder_id
    this._sheet().getRange(customer.rowIndex, col).setValue(folderId);
    customer.folder_id = folderId;
    if (_customersCache) {
      const hit = _customersCache.find(c => c.rowIndex === customer.rowIndex);
      if (hit) hit.folder_id = folderId;
    }
  },

  reset() { _customersCache = null; }
};
