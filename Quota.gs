/**
 * Quota.gs — circuit breaker for Gemini's daily request limit.
 *
 * When Gemini reports the per-day quota is exhausted (429 with a "PerDay" quota
 * metric), the pipeline pauses for the rest of the Pacific day rather than
 * hammering a dead quota (which wastes the script's daily runtime and, worse,
 * fails scans). The daily quota resets at midnight Pacific, so we key the pause
 * on the Pacific calendar date: once it rolls over, we resume automatically.
 */

/**
 * resumeNow() — clears the daily-quota pause immediately (e.g. after topping up
 * credit), so `run` stops skipping and processes again without waiting for the
 * midnight-Pacific reset.
 */
function resumeNow() {
  PropertiesService.getScriptProperties().deleteProperty('GEMINI_QUOTA_PAUSED_ON');
  Logger.log('Quota pause cleared — run will process again now (assuming Gemini credit is available).');
}

const Quota = {
  _PROP: 'GEMINI_QUOTA_PAUSED_ON',
  _TZ: 'America/Los_Angeles',

  /** True while we're paused for a daily-quota exhaustion that hasn't reset yet. */
  isPaused() {
    const props = PropertiesService.getScriptProperties();
    const pausedOn = props.getProperty(this._PROP);
    if (!pausedOn) return false;
    if (pausedOn === this._ptDate()) return true;   // still the same Pacific day
    props.deleteProperty(this._PROP);               // new Pacific day → quota reset
    return false;
  },

  /** Pause processing until the quota resets (next midnight Pacific). Notifies once. */
  pauseForToday() {
    const props = PropertiesService.getScriptProperties();
    if (props.getProperty(this._PROP) === this._ptDate()) return; // already paused today
    props.setProperty(this._PROP, this._ptDate());
    try {
      const to = Config.get('STORAGE_ALERT_RECIPIENT') || Session.getEffectiveUser().getEmail();
      GmailApp.sendEmail(to, 'POD Filing: paused — Gemini daily limit reached',
        'The BOL filing system hit Gemini\'s free daily request limit, so it paused '
        + 'itself for today. It resumes automatically after the limit resets (around '
        + 'midnight Pacific). Your scans are safe in the mailbox and will file then — '
        + 'nothing you need to do.');
    } catch (e) { /* notification is best-effort */ }
  },

  _ptDate() {
    return Utilities.formatDate(new Date(), this._TZ, 'yyyy-MM-dd');
  }
};
