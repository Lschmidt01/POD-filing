/**
 * Cleanup.gs — emergency undo for when intake was pointed at a shared/personal
 * mailbox instead of a dedicated intake address.
 *
 * emergencyUndo():
 *   1. Deletes all project triggers so nothing runs again until re-install.
 *   2. Removes the "pod-processed" label from every thread and moves those
 *      threads back to the inbox (best-effort restore of archived mail).
 *   3. Trashes the copies that were filed into "_Unsorted" (recoverable in
 *      Drive Trash for ~30 days).
 *   4. Clears all Index rows (keeps the header).
 *
 * Caveat: step 2 moves every previously-labelled thread to the inbox. If a few
 * of those PDF emails were already archived by you before this ran, they'll
 * reappear in the inbox — just re-archive them.
 */
function emergencyUndo() {
  const triggers = removeAllTriggers_();
  const threads = restoreLabelledThreads_();
  const trashed = trashUnsorted_();
  const rows = clearIndexRows_();
  Logger.log('Emergency undo complete: %s triggers removed, %s threads restored, '
    + '%s files trashed, %s index rows cleared.', triggers, threads, trashed, rows);
}

function removeAllTriggers_() {
  const ts = ScriptApp.getProjectTriggers();
  ts.forEach(t => ScriptApp.deleteTrigger(t));
  return ts.length;
}

function restoreLabelledThreads_() {
  const label = GmailApp.getUserLabelByName(Config.get('PROCESSED_LABEL'));
  if (!label) return 0;
  let total = 0, batch;
  do {
    batch = label.getThreads(0, 100); // always page 0 — we un-label as we go
    batch.forEach(t => { t.removeLabel(label); t.moveToInbox(); });
    total += batch.length;
  } while (batch.length === 100);
  return total;
}

function trashUnsorted_() {
  const folder = DriveApp.getFolderById(Config.get('UNSORTED_FOLDER_ID'));
  const files = folder.getFiles();
  let n = 0;
  while (files.hasNext()) { files.next().setTrashed(true); n++; }
  return n;
}

function clearIndexRows_() {
  const sheet = getWorkbook().getSheetByName(INDEX_TAB);
  const last = sheet.getLastRow();
  if (last <= 1) return 0;
  sheet.deleteRows(2, last - 1);
  return last - 1;
}

/**
 * clearErrored() — after re-filing the rate-limited scans, removes the leftovers
 * from the failed attempts: trashes the whole-scan copies parked in _Unsorted and
 * deletes the Index rows with status 'error'. Run this LAST, once the real files
 * are back in their customer folders.
 */
function clearErrored() {
  const trashed = trashUnsorted_();
  const sheet = getWorkbook().getSheetByName(INDEX_TAB);
  const si = INDEX_COLUMNS.indexOf('status');
  let removed = 0;
  const last = sheet.getLastRow();
  if (last > 1) {
    const vals = sheet.getRange(2, 1, last - 1, INDEX_COLUMNS.length).getValues();
    for (let r = vals.length - 1; r >= 0; r--) {            // bottom-up so row indices hold
      if (String(vals[r][si]) === STATUS.ERROR) { sheet.deleteRows(r + 2, 1); removed++; }
    }
  }
  Logger.log('clearErrored: %s _Unsorted files trashed, %s error rows removed.', trashed, removed);
}

function clearCustomersRows_() {
  const sheet = getWorkbook().getSheetByName(CUSTOMERS_TAB);
  const last = sheet.getLastRow();
  if (last <= 1) return 0;
  sheet.deleteRows(2, last - 1);
  return last - 1;
}

/**
 * redoAll() — re-files everything with the CURRENT code after a filing-logic fix.
 * Trashes all filed customer folders (keeps _Unsorted), clears the Index and
 * Customers tabs, and re-queues every processed email so the next run() reads the
 * attachments again and files them fresh. Trashed items recover in ~30 days.
 *
 * WARNING: every intake email still in the mailbox gets reprocessed — delete any
 * test/junk emails FIRST so they don't come back. After running this, run `run`
 * (or wait for the trigger) to re-file.
 */
function redoAll() {
  const root = DriveApp.getFolderById(Config.get('ROOT_FOLDER_ID'));
  const keepId = Config.get('UNSORTED_FOLDER_ID');
  let trashed = 0;
  const it = root.getFolders();
  while (it.hasNext()) {
    const f = it.next();
    if (f.getId() !== keepId) { f.setTrashed(true); trashed++; }
  }
  clearIndexRows_();
  clearCustomersRows_();
  const requeued = restoreLabelledThreads_();
  Logger.log('redoAll: %s customer folders trashed, Index + Customers cleared, %s '
    + 'emails re-queued. Now run `run` (or wait for the trigger) to re-file.',
    trashed, requeued);
}

/**
 * decommission() — removes everything the script created inside THIS account:
 * triggers, the "pod-processed" Gmail label, and the auto-created workbook and
 * "POD Customer Folders" root (including _Unsorted). After running this, the
 * Apps Script project itself is deleted separately (via clasp). Trashed Drive
 * items sit in Drive Trash for ~30 days in case you need to recover anything.
 *
 * Each step is independent so one failure doesn't block the rest.
 */
function decommission() {
  const results = [];

  // Capture Drive ids up front, before anything is trashed/cleared.
  let rootId = '', workbookId = '';
  try { rootId = Config.get('ROOT_FOLDER_ID'); } catch (e) { /* config may be gone */ }
  workbookId = PropertiesService.getScriptProperties().getProperty('WORKBOOK_ID') || '';

  try { results.push(removeAllTriggers_() + ' triggers removed'); }
  catch (e) { results.push('triggers: ' + e.message); }

  try {
    const label = GmailApp.getUserLabelByName(Config.get('PROCESSED_LABEL'));
    if (label) { label.deleteLabel(); results.push('label deleted'); }
    else results.push('label already gone');
  } catch (e) { results.push('label: ' + e.message); }

  try {
    if (rootId) { DriveApp.getFolderById(rootId).setTrashed(true); results.push('root folder trashed'); }
    else results.push('no root folder id');
  } catch (e) { results.push('root folder: ' + e.message); }

  try {
    if (workbookId) { DriveApp.getFileById(workbookId).setTrashed(true); results.push('workbook trashed'); }
    else results.push('no workbook id');
  } catch (e) { results.push('workbook: ' + e.message); }

  try { PropertiesService.getScriptProperties().deleteAllProperties(); results.push('properties cleared'); }
  catch (e) { results.push('properties: ' + e.message); }

  Logger.log('Decommission complete: %s', results.join('; '));
}
