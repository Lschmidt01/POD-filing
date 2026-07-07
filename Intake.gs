/**
 * Intake.gs — Gmail side of the pipeline (FR-1..FR-4).
 *
 * Finds unprocessed threads, enumerates their PDF attachments as atomic work
 * items, and (only once every attachment is confirmed indexed) marks the thread
 * processed by labelling + archiving it. Intake email is never deleted (FR-1a).
 */

const MAX_THREADS_PER_RUN = 50; // outer bound; the time guard usually stops first

const Intake = {
  /** @returns {GmailThread[]} unprocessed threads carrying PDF attachments. */
  fetchThreads() {
    return GmailApp.search(Config.get('GMAIL_QUERY'), 0, MAX_THREADS_PER_RUN);
  },

  /**
   * All PDF attachments in a thread as work items, each with a stable item_key.
   * Bytes are read once here and the key is reused for both processing and the
   * completion check, so we never hash the same attachment twice.
   * @returns {Array<{message:GmailMessage, attachment:GmailAttachment, key:string}>}
   */
  pdfItems(thread) {
    const items = [];
    thread.getMessages().forEach(message => {
      message.getAttachments({ includeInlineImages: false }).forEach(att => {
        if (!this._isPdf(att)) return;
        items.push({ message, attachment: att, key: this._itemKey(message, att) });
      });
    });
    return items;
  },

  /**
   * Retires the thread so it is never reprocessed. Labels it, then either trashes
   * it (DELETE_AFTER_FILING — reclaims storage; the filed Drive PDF is the kept
   * copy) or just archives it (keeps the original email). Trashed mail is
   * recoverable in Gmail Trash for ~30 days.
   */
  markThreadProcessed(thread) {
    thread.addLabel(this._processedLabel());
    if (Config.bool('DELETE_AFTER_FILING')) thread.moveToTrash();
    else thread.moveToArchive();
  },

  // --- internals ---

  _isPdf(att) {
    const type = att.getContentType();
    if (type === 'application/pdf') return true;
    // Some scanners send octet-stream; fall back to extension.
    return /\.pdf$/i.test(att.getName());
  },

  /** messageId::md5(bytes) — unique per physical attachment, stable on retry. */
  _itemKey(message, attachment) {
    const digest = Utilities.computeDigest(
      Utilities.DigestAlgorithm.MD5, attachment.copyBlob().getBytes());
    const hex = digest.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
    return message.getId() + '::' + hex;
  },

  _processedLabel() {
    const name = Config.get('PROCESSED_LABEL');
    return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
  }
};
