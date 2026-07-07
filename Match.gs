/**
 * Match.gs — maps an extracted Ship-To name to a customer folder identity.
 *
 * The Ship-To name reads reliably from Drive OCR, so this is a straightforward
 * normalized lookup, not fuzzy scoring: normalize the name, find an existing
 * customer with the same normalized name/alias, and file there. An unrecognized
 * (but readable) name creates a new customer folder (FR-12) — we file by
 * whatever we read. Only a blank/unreadable name routes to "_Unsorted" (NFR-1).
 *
 * Normalizing on lookup means OCR-level variance (case, spacing, trailing
 * punctuation) collapses to one folder instead of forking near-duplicates.
 */

/**
 * @typedef {Object} MatchDecision
 * @property {'file'|'new_customer'|'unsorted'} decision
 * @property {object|null} customer  master-list record when decision==='file'
 * @property {string} newCustomerName  proposed name when decision==='new_customer'
 * @property {string} status  one of STATUS.*
 * @property {string} reason
 */

const Match = {
  /**
   * @param {string} customerName raw extracted Ship-To name
   * @returns {MatchDecision}
   */
  resolve(customerName) {
    const query = this._normalize(customerName);
    if (!query) {
      return { decision: 'unsorted', customer: null, newCustomerName: '',
        status: STATUS.UNSORTED, reason: 'No customer name could be read.' };
    }

    const hit = Customers.all().find(c =>
      [c.canonical_name, ...c.aliases].map(this._normalize).indexOf(query) >= 0);

    if (hit) {
      return { decision: 'file', customer: hit, newCustomerName: '',
        status: STATUS.FILED, reason: '' };
    }

    return { decision: 'new_customer', customer: null,
      newCustomerName: String(customerName).replace(/\s+/g, ' ').trim(),
      status: STATUS.FILED_NEW_CUSTOMER, reason: 'First BOL seen for this customer.' };
  },

  _normalize(s) {
    return String(s || '')
      .toLowerCase()
      .replace(/\([^)]*\)/g, ' ')  // drop parenthetical dock/route codes, e.g. "(4H)"
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\b(inc|llc|co|corp|company|ltd)\b/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
};
