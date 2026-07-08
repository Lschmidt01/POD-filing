/**
 * Recheck.gs — one-time pass to re-read already-filed BOLs with the current
 * (Pro) model and correct the PO / invoice numbers in the Index that the old
 * Flash model mangled.
 *
 * Safe + resumable:
 *  - Backs up each row's original PO/invoice into "po_original" / "invoice_original"
 *    columns before changing anything (nothing is lost).
 *  - Only overwrites when the re-read returns a non-blank value, so a good number
 *    is never replaced with a blank.
 *  - Marks each row done in a "rechecked_at" column, so it resumes where it left
 *    off across runs and never re-does a row.
 *  - Bounded to the rows that existed when startRecheck() ran, so it doesn't chase
 *    newly-arriving rows (those are already read with Pro and correct).
 *
 * Usage: run startRecheck() once. It installs a temporary 5-minute trigger that
 * drives recheckIndex() until every row is done, then removes itself.
 */

function startRecheck() {
  const sheet = getWorkbook().getSheetByName(INDEX_TAB);
  const rows = Math.max(0, sheet.getLastRow() - 1);
  PropertiesService.getScriptProperties().setProperty('RECHECK_MAX_ROW', String(sheet.getLastRow()));

  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'recheckIndex')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('recheckIndex').timeBased().everyMinutes(5).create();

  Logger.log('Recheck started for %s existing rows. recheckIndex() will run every 5 min, '
    + 'correcting PO/invoice with the Pro model, and stop itself when done. Watch the Index.', rows);
}

function stopRecheck() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'recheckIndex')
    .forEach(t => ScriptApp.deleteTrigger(t));
  Logger.log('Recheck trigger removed.');
}

function recheckIndex() {
  const sheet = getWorkbook().getSheetByName(INDEX_TAB);
  const props = PropertiesService.getScriptProperties();
  const maxRow = Number(props.getProperty('RECHECK_MAX_ROW')) || sheet.getLastRow();
  if (maxRow < 2) { Logger.log('Nothing to recheck.'); return; }

  const cols = INDEX_COLUMNS.length;
  const poIdx = INDEX_COLUMNS.indexOf('customer_po');
  const invIdx = INDEX_COLUMNS.indexOf('invoice_number');
  const linkIdx = INDEX_COLUMNS.indexOf('file_link');
  const statusIdx = INDEX_COLUMNS.indexOf('status');
  const origPoCol = cols + 1, origInvCol = cols + 2, flagCol = cols + 3; // M, N, O

  sheet.getRange(1, origPoCol, 1, 3).setValues([['po_original', 'invoice_original', 'rechecked_at']]);

  const data = sheet.getRange(2, 1, maxRow - 1, cols).getValues();
  const flags = sheet.getRange(2, flagCol, maxRow - 1, 1).getValues();
  const isFiled = s => s === STATUS.FILED || s === STATUS.FILED_NEW_CUSTOMER || s === STATUS.DUPLICATE;

  const deadline = Date.now() + 300000; // ~5 min, under the 6-min execution cap
  let reread = 0, changed = 0;

  for (let i = 0; i < data.length; i++) {
    const rowNum = i + 2;
    if (flags[i][0]) continue;                         // already handled
    if (!isFiled(String(data[i][statusIdx]))) {         // skip _Unsorted/error whole-scans
      sheet.getRange(rowNum, flagCol).setValue('n/a');
      continue;
    }
    if (Date.now() > deadline) break;                   // out of time; resume next run

    const m = String(data[i][linkIdx]).match(/[-\w]{25,}/);
    if (!m) { sheet.getRange(rowNum, flagCol).setValue('no-file'); continue; }

    let bols;
    try {
      bols = Gemini.readBols(DriveApp.getFileById(m[0]).getBlob());
    } catch (e) {
      if (String((e && e.message) || e).indexOf('GEMINI_QUOTA_EXHAUSTED') >= 0) {
        Logger.log('Daily quota hit — pausing recheck; it resumes on the next trigger after reset.');
        return;
      }
      sheet.getRange(rowNum, flagCol).setValue('read-error');
      continue;
    }

    const f = (bols && bols[0]) || {};
    sheet.getRange(rowNum, origPoCol, 1, 2).setValues([[data[i][poIdx], data[i][invIdx]]]);
    if (f.customer_po)     sheet.getRange(rowNum, poIdx + 1).setValue(f.customer_po);
    if (f.invoice_number)  sheet.getRange(rowNum, invIdx + 1).setValue(f.invoice_number);
    sheet.getRange(rowNum, flagCol).setValue(new Date());
    reread++;
    if ((f.customer_po && f.customer_po !== data[i][poIdx])
        || (f.invoice_number && f.invoice_number !== data[i][invIdx])) changed++;
  }

  // How many filed rows still need a recheck?
  const flags2 = sheet.getRange(2, flagCol, maxRow - 1, 1).getValues();
  let left = 0;
  for (let i = 0; i < flags2.length; i++) {
    if (!flags2[i][0] && isFiled(String(data[i][statusIdx]))) left++;
  }

  Logger.log('recheckIndex: %s re-read this run (%s numbers changed); %s rows left.', reread, changed, left);
  if (left === 0) {
    stopRecheck();
    props.deleteProperty('RECHECK_MAX_ROW');
    Logger.log('RECHECK COMPLETE. Spot-check the po_original / invoice_original columns against the '
      + 'corrected values, then delete those backup columns whenever you\'re satisfied.');
  }
}
