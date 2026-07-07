/**
 * Naming.gs — builds the stored filename stem from the configured pattern.
 * Default: {date}_{po}_{invoice}  →  e.g. 2026-06-24_9371944H_2178881
 *
 * The PO and invoice (driver-confirmation) numbers are baked into the filename
 * so Drive's own search box finds a BOL by either, in addition to the index.
 *
 * Rules:
 *  - Empty tokens are dropped (their segment collapses away).
 *  - If both PO and invoice are missing, a short stable suffix derived from the
 *    item_key is appended so distinct BOLs never collide.
 */

const Naming = {
  /**
   * @param {{date:string, po:string, invoice:string, itemKey:string}} f
   * @returns {string} filename stem WITHOUT extension
   */
  buildBaseName(f) {
    let stem = Config.get('FILENAME_PATTERN')
      .replace('{date}', this._clean(f.date))
      .replace('{po}', this._clean(f.po))
      .replace('{invoice}', this._clean(f.invoice));

    // Collapse any segments emptied by missing fields.
    stem = stem.split('_').filter(seg => seg !== '').join('_');

    if (!f.po && !f.invoice) stem += '_' + this._shortSuffix(f.itemKey);
    return stem || this._shortSuffix(f.itemKey);
  },

  /** Filesystem-friendly: no separators that would confuse the pattern. */
  _clean(v) {
    return String(v || '')
      .replace(/[\/\\_]+/g, '-')
      .replace(/\s+/g, ' ')
      .trim();
  },

  /** Deterministic 6-char suffix so retries produce the same name. */
  _shortSuffix(itemKey) {
    const bytes = Utilities.computeDigest(
      Utilities.DigestAlgorithm.MD5, String(itemKey || ''));
    return bytes.slice(0, 3)
      .map(b => ('0' + (b & 0xff).toString(16)).slice(-2))
      .join('');
  }
};
