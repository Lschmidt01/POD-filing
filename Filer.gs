/**
 * Filer.gs — turns a decision into a stored file in Drive.
 *
 * Guarantees:
 *  - Original PDF bytes are written unchanged (FR-16).
 *  - Never overwrites: name collisions get a _vN suffix (FR-24).
 *  - Idempotent on retry: each stored file is stamped with its item_key in the
 *    Drive file description, so a crash-and-resume between filing and indexing
 *    reuses the same file instead of creating a spurious _v2.
 */

const Filer = {
  unsortedFolder() {
    return DriveApp.getFolderById(Config.get('UNSORTED_FOLDER_ID'));
  },

  /**
   * The filing destination for a BOL: Customer / Year / Month, creating each
   * level as needed. e.g. "US Foods - Salt Lake City" / "2026" / "06".
   * @param {object} customer a record from Customers.all()
   * @param {string} year  four-digit year, e.g. "2026"
   * @param {string} month two-digit month, e.g. "06"
   * @returns {GoogleAppsScript.Drive.Folder} the month folder
   */
  destinationFolder(customer, year, month) {
    const top = this._customerFolder(customer);
    const yearFolder = this._childFolder(top, String(year));
    return this._childFolder(yearFolder, String(month));
  },

  /**
   * The top-level customer folder, creating it under ROOT and persisting its id
   * back to the master list on first use (FR-13).
   */
  _customerFolder(customer) {
    if (customer.folder_id) {
      try { return DriveApp.getFolderById(customer.folder_id); }
      catch (e) { /* stale id — recreate below */ }
    }
    const root = DriveApp.getFolderById(Config.get('ROOT_FOLDER_ID'));
    const folder = this._childFolder(root, customer.canonical_name);
    Customers.setFolderId(customer, folder.getId());
    return folder;
  },

  /** Gets (or creates) a subfolder by name — never duplicates. */
  _childFolder(parent, name) {
    const safe = this._safeName(name);
    const it = parent.getFoldersByName(safe);
    return it.hasNext() ? it.next() : parent.createFolder(safe);
  },

  /** Folder-safe: no slashes (which Drive would otherwise allow into a name). */
  _safeName(name) {
    return String(name).replace(/[\/\\]+/g, '-').replace(/\s+/g, ' ').trim() || 'Unknown';
  },

  /**
   * Stores `blob` into `folder` under `baseName` (without extension).
   * @param {Blob} blob original PDF bytes
   * @param {Folder} folder destination
   * @param {string} baseName filename stem (no ".pdf")
   * @param {string} itemKey idempotency stamp
   * @returns {{file:File, link:string, finalName:string, versioned:boolean}}
   */
  place(blob, folder, baseName, itemKey) {
    const intended = baseName + '.pdf';

    // Fast path: no collision → just create. (Already-indexed items are skipped
    // upstream, so a fresh unique name can't belong to a prior run.)
    if (!this._nameExists(folder, intended)) {
      return this._create(blob, folder, intended, itemKey, false);
    }

    // Collision — either our own crash-retry, or a genuine re-scan (FR-24).
    // Only here do we pay the folder scan to tell them apart.
    const mine = this._findByItemKey(folder, itemKey);
    if (mine) {
      return { file: mine, link: mine.getUrl(),
               finalName: mine.getName(), versioned: false };
    }
    let v = 2;
    while (this._nameExists(folder, baseName + '_v' + v + '.pdf')) v++;
    return this._create(blob, folder, baseName + '_v' + v + '.pdf', itemKey, true);
  },

  _create(blob, folder, name, itemKey, versioned) {
    const pdf = blob.copyBlob().setName(name);
    pdf.setContentType('application/pdf');
    const file = folder.createFile(pdf);
    file.setDescription('item_key=' + itemKey);
    return { file, link: file.getUrl(), finalName: name, versioned };
  },

  _nameExists(folder, name) {
    return folder.getFilesByName(name).hasNext();
  },

  _findByItemKey(folder, itemKey) {
    const stamp = 'item_key=' + itemKey;
    const it = folder.getFiles();
    while (it.hasNext()) {
      const f = it.next();
      if (f.getDescription() === stamp) return f;
    }
    return null;
  }
};
