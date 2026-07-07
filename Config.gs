/**
 * Config.gs — single source of truth for all tunable settings.
 *
 * Bootstrap: Script Properties holds only WORKBOOK_ID (the Google Sheet that
 * contains the Config, Customers, and Index tabs). Everything else lives in the
 * "Config" tab as key/value rows so the operator can edit it without touching
 * code (NFR-7). Defaults below are used whenever a key is missing.
 */

const CONFIG_DEFAULTS = {
  // --- Intake (Gmail) ---
  GMAIL_QUERY: 'has:attachment filename:pdf -label:pod-processed',
  PROCESSED_LABEL: 'pod-processed',

  // --- Drive ---
  ROOT_FOLDER_ID: '',      // parent of all customer folders
  UNSORTED_FOLDER_ID: '',  // catch-all "_Unsorted" folder

  // --- Reading (Gemini free tier) ---
  GEMINI_MODEL: 'gemini-2.5-flash',   // free-tier vision model; override if needed

  // --- Filing ---
  // Filename tokens: {date} (yyyy-MM-dd), {po} (customer PO), {invoice} (driver
  // confirmation #). Empty tokens are dropped. Folders are Customer/Year/Month.
  FILENAME_PATTERN: '{date}_{po}_{invoice}',

  // --- Scheduling / batching ---
  POLL_MINUTES: '10',       // trigger interval (FR-3)
  BATCH_MAX_MS: '270000',   // stop taking new work after 4.5 min (6-min hard limit)

  // --- Notifications (FR-23a) ---
  SUMMARY_ENABLED: 'false',
  SUMMARY_RECIPIENT: '',

  // --- Storage / retention ---
  DELETE_AFTER_FILING: 'true',     // trash the intake email once filed (reclaims space)
  STORAGE_WARN_THRESHOLD: '0.85',  // email an alert when Drive passes this fraction full
  STORAGE_ALERT_RECIPIENT: ''      // who gets the alert (defaults to this account's own address)
};

const CONFIG_TAB = 'Config';
const CUSTOMERS_TAB = 'Customers';
const INDEX_TAB = 'Index';

/** Per-execution cache so we read the Config tab at most once per run. */
let _configCache = null;

/** @returns {GoogleAppsScript.Spreadsheet.Spreadsheet} the workbook. */
function getWorkbook() {
  const id = PropertiesService.getScriptProperties().getProperty('WORKBOOK_ID');
  if (!id) {
    throw new Error('WORKBOOK_ID script property is not set. Run Setup.install() first.');
  }
  return SpreadsheetApp.openById(id);
}

/** Reads the Config tab into a { key: value } map, merged over defaults. */
function _loadConfig() {
  const map = Object.assign({}, CONFIG_DEFAULTS);
  const sheet = getWorkbook().getSheetByName(CONFIG_TAB);
  if (sheet && sheet.getLastRow() > 1) {
    const rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues();
    rows.forEach(([key, value]) => {
      if (key !== '' && value !== '') map[String(key).trim()] = String(value).trim();
    });
  }
  return map;
}

const Config = {
  /** @param {string} key @returns {string} */
  get(key) {
    if (!_configCache) _configCache = _loadConfig();
    if (!(key in _configCache)) throw new Error('Unknown config key: ' + key);
    return _configCache[key];
  },
  num(key) { return Number(this.get(key)); },
  bool(key) { return String(this.get(key)).toLowerCase() === 'true'; },
  /** Clears the per-execution cache (used by tests). */
  reset() { _configCache = null; }
};
