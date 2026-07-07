/**
 * Indexer.gs — the master index/log (Google Sheet). This is the operator's
 * primary retrieval surface (FR-18..FR-20). Exactly one row per processed item.
 *
 * An extra trailing "item_key" column (messageId::attachmentHash) is the
 * idempotency spine: an attachment is "already done" iff its item_key is present
 * here. Reading the file link back out also lets us locate prior versions.
 */

// Order matters: this is the header row written by Setup.
const INDEX_COLUMNS = [
  'processed_at',      // A
  'original_filename', // B  the source scan's filename
  'customer',          // C  Ship-To customer (blank if unreadable)
  'year_month',        // D  e.g. "2026-06" — the delivery month it was filed under
  'delivery_date',     // E  yyyy-MM-dd
  'date_inferred',     // F  TRUE if fell back to ingest date
  'customer_po',       // G  searchable
  'invoice_number',    // H  driver-confirmation # == invoice, searchable
  'status',            // I  see STATUS.*
  'reason',            // J  free-text detail
  'file_link',         // K  direct Drive link
  'item_key'           // L  idempotency key (last column)
];

const STATUS = {
  FILED: 'filed',
  FILED_NEW_CUSTOMER: 'filed_new_customer',
  UNSORTED: 'unsorted',        // customer name couldn't be read
  DUPLICATE: 'duplicate',
  ERROR: 'error'
};

/** Per-execution cache of item_keys already present in the index. */
let _itemKeySet = null;

const Indexer = {
  _sheet() { return getWorkbook().getSheetByName(INDEX_TAB); },

  /** @returns {Set<string>} all item_keys currently in the index. */
  itemKeys() {
    if (_itemKeySet) return _itemKeySet;
    const sheet = this._sheet();
    _itemKeySet = new Set();
    const keyCol = INDEX_COLUMNS.indexOf('item_key') + 1;
    if (sheet.getLastRow() > 1) {
      sheet.getRange(2, keyCol, sheet.getLastRow() - 1, 1)
        .getValues()
        .forEach(([k]) => { if (k) _itemKeySet.add(String(k)); });
    }
    return _itemKeySet;
  },

  /** @returns {boolean} whether this attachment was already logged. */
  has(itemKey) { return this.itemKeys().has(itemKey); },

  /**
   * Appends one row. `record` uses the same field names as INDEX_COLUMNS.
   * Missing fields become blank. Keeps the in-memory item_key set fresh.
   */
  append(record) {
    const row = INDEX_COLUMNS.map(col => (col in record ? record[col] : ''));
    this._sheet().appendRow(row);
    if (record.item_key) this.itemKeys().add(String(record.item_key));
  },

  /**
   * Whether a BOL with this invoice (driver-confirmation) number has already
   * been filed — the basis for re-scan duplicate detection (FR-24). The invoice
   * number is unique per BOL, so it alone identifies a repeat.
   */
  invoiceAlreadyFiled(invoiceNumber) {
    if (!invoiceNumber) return false;
    const sheet = this._sheet();
    if (sheet.getLastRow() < 2) return false;
    const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, INDEX_COLUMNS.length).getValues();
    const ii = INDEX_COLUMNS.indexOf('invoice_number');
    const si = INDEX_COLUMNS.indexOf('status');
    return values.some(r => {
      const isFiling = r[si] === STATUS.FILED || r[si] === STATUS.FILED_NEW_CUSTOMER
        || r[si] === STATUS.DUPLICATE;
      return isFiling && String(r[ii]) === String(invoiceNumber);
    });
  }
};
