/**
 * Notify.gs — optional daily summary email (FR-23a). Off by default. This is a
 * push so the operator stays informed without checking anything.
 *
 * STUB (milestone 6). The run loop collects per-run counts; a separate daily
 * trigger would aggregate the day's index rows and send. Left inert for now.
 */

const Notify = {
  /**
   * @param {{filed:number, filed_new_customer:number, unsorted:number,
   *          duplicate:number, error:number}} counts
   */
  maybeSendSummary(counts) {
    if (!Config.bool('SUMMARY_ENABLED')) return;
    const to = Config.get('SUMMARY_RECIPIENT');
    if (!to) return;
    // TODO(milestone 6): build a real digest with links; likely a daily trigger.
    MailApp.sendEmail(to, 'POD filing — run summary',
      JSON.stringify(counts, null, 2));
  }
};
