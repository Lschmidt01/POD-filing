/**
 * Setup.gs — one-time installer, run manually from the Apps Script editor.
 *
 * Creates the workbook (Config / Customers / Index tabs), the Drive folder
 * layout (root + "_Unsorted"), the Gmail processed-label, and the time-based
 * trigger. Safe to re-run: it finds existing artifacts instead of duplicating.
 */

/** Entry point: wire up everything needed to run. */
function install() {
  const workbook = ensureWorkbook_();
  PropertiesService.getScriptProperties().setProperty('WORKBOOK_ID', workbook.getId());
  Config.reset();

  ensureConfigTab_(workbook);
  ensureCustomersTab_(workbook);
  ensureIndexTab_(workbook);
  ensureFolders_(workbook);
  ensureLabel_();
  ensureTrigger_();

  Logger.log('Setup complete. Workbook: %s', workbook.getUrl());
  Logger.log('Fill in ROOT_FOLDER_ID / UNSORTED_FOLDER_ID in the Config tab if you want '
    + 'to point at existing folders; otherwise the auto-created ones are already set.');
}

function ensureWorkbook_() {
  const existingId = PropertiesService.getScriptProperties().getProperty('WORKBOOK_ID');
  if (existingId) {
    try { return SpreadsheetApp.openById(existingId); } catch (e) { /* recreate below */ }
  }
  return SpreadsheetApp.create('POD Filing — Master (Config / Customers / Index)');
}

/**
 * Rewrites the Index tab to the current column schema. Run once after a schema
 * change during development. Clears existing rows — safe here because prior rows
 * were stub/_Unsorted test data. Leave commented out of the normal flow.
 */
function reinitIndex() {
  const sheet = getWorkbook().getSheetByName(INDEX_TAB);
  sheet.clear();
  sheet.appendRow(INDEX_COLUMNS);
  sheet.setFrozenRows(1);
  Logger.log('Index tab reset to %s columns.', INDEX_COLUMNS.length);
}

/**
 * catchUpMode() — speeds the trigger to every 5 minutes to work through a
 * backlog faster. Run normalMode() once you're caught up. (Throughput is still
 * capped by the free-tier limits — see notes — this just uses the daily budget
 * sooner rather than spreading it thin.)
 */
function catchUpMode() {
  setConfigValue_(getWorkbook().getSheetByName(CONFIG_TAB), 'POLL_MINUTES', '5');
  Config.reset();
  ensureTrigger_();
  Logger.log('Catch-up mode ON: trigger now every 5 minutes. Run normalMode() when done.');
}

/** normalMode() — returns the trigger to every 10 minutes for steady-state use. */
function normalMode() {
  setConfigValue_(getWorkbook().getSheetByName(CONFIG_TAB), 'POLL_MINUTES', '10');
  Config.reset();
  ensureTrigger_();
  Logger.log('Normal mode: trigger back to every 10 minutes.');
}

function ensureConfigTab_(workbook) {
  const sheet = getOrCreateSheet_(workbook, CONFIG_TAB);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['key', 'value']);
    // Seed the tab with defaults so the operator sees every knob.
    Object.keys(CONFIG_DEFAULTS).forEach(k => sheet.appendRow([k, CONFIG_DEFAULTS[k]]));
    sheet.setFrozenRows(1);
    sheet.autoResizeColumns(1, 2);
  }
  return sheet;
}

function ensureCustomersTab_(workbook) {
  const sheet = getOrCreateSheet_(workbook, CUSTOMERS_TAB);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['canonical_name', 'aliases', 'folder_id', 'active']);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function ensureIndexTab_(workbook) {
  const sheet = getOrCreateSheet_(workbook, INDEX_TAB);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(INDEX_COLUMNS);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/** Creates ROOT + "_Unsorted" folders and records their IDs in Config (if blank). */
function ensureFolders_(workbook) {
  const configSheet = workbook.getSheetByName(CONFIG_TAB);
  const rootId = Config.get('ROOT_FOLDER_ID');
  let root;
  if (rootId) {
    root = DriveApp.getFolderById(rootId);
  } else {
    root = DriveApp.createFolder('POD Customer Folders');
    setConfigValue_(configSheet, 'ROOT_FOLDER_ID', root.getId());
  }

  if (!Config.get('UNSORTED_FOLDER_ID')) {
    const unsorted = getOrCreateChildFolder_(root, '_Unsorted');
    setConfigValue_(configSheet, 'UNSORTED_FOLDER_ID', unsorted.getId());
  }
  Config.reset();
}

function ensureLabel_() {
  const name = Config.get('PROCESSED_LABEL');
  if (!GmailApp.getUserLabelByName(name)) GmailApp.createLabel(name);
}

/** Installs a single time-based trigger for run(), replacing any prior one. */
function ensureTrigger_() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'run')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('run')
    .timeBased()
    .everyMinutes(nearestAllowedInterval_(Config.num('POLL_MINUTES')))
    .create();
}

/** Apps Script only allows 1/5/10/15/30 minute intervals. */
function nearestAllowedInterval_(minutes) {
  const allowed = [1, 5, 10, 15, 30];
  return allowed.reduce((best, m) =>
    Math.abs(m - minutes) < Math.abs(best - minutes) ? m : best, 10);
}

// --- small helpers ---

function getOrCreateSheet_(workbook, name) {
  return workbook.getSheetByName(name) || workbook.insertSheet(name);
}

function getOrCreateChildFolder_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}

/** Sets a key's value in the Config tab, appending the row if absent. */
function setConfigValue_(configSheet, key, value) {
  const last = configSheet.getLastRow();
  if (last > 1) {
    const keys = configSheet.getRange(2, 1, last - 1, 1).getValues();
    for (let i = 0; i < keys.length; i++) {
      if (String(keys[i][0]).trim() === key) {
        configSheet.getRange(i + 2, 2).setValue(value);
        return;
      }
    }
  }
  configSheet.appendRow([key, value]);
}
