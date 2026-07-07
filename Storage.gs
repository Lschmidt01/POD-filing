/**
 * Storage.gs — warns before the account's 15 GB fills up.
 *
 * Called at the end of each run. If Drive usage crosses STORAGE_WARN_THRESHOLD,
 * it emails an alert (at most once a day) so filing never silently fails for
 * lack of space. Recipient is STORAGE_ALERT_RECIPIENT, or this account itself.
 */

const Storage = {
  checkAndWarn() {
    const about = Drive.About.get(); // Drive advanced service (v2)
    const total = Number(about.quotaBytesTotal || 0);
    const used = Number(about.quotaBytesUsed || 0);
    if (!total) return;

    const ratio = used / total;
    if (ratio < Config.num('STORAGE_WARN_THRESHOLD')) return;

    // At most one alert per day.
    const props = PropertiesService.getScriptProperties();
    const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
    if (props.getProperty('STORAGE_WARNED_ON') === today) return;

    const to = Config.get('STORAGE_ALERT_RECIPIENT') || Session.getEffectiveUser().getEmail();
    const pct = Math.round(ratio * 100);
    const gb = b => (b / 1073741824).toFixed(1);

    GmailApp.sendEmail(to, 'POD Filing: Drive storage at ' + pct + '%',
      'The account that files your BOLs is at ' + pct + '% of its storage ('
      + gb(used) + ' GB of ' + gb(total) + ' GB used).\n\n'
      + 'When it fills up, new BOLs can no longer be filed. To free space:\n'
      + '  - lower your scanner resolution (biggest win),\n'
      + '  - empty Gmail Trash and Drive Trash,\n'
      + '  - move older BOLs off the account.');
    props.setProperty('STORAGE_WARNED_ON', today);
  }
};
