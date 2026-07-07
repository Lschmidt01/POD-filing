/**
 * Main.gs — orchestrator invoked by the time-based trigger.
 *
 * Per attachment: Gemini reads the scan and pdf-lib carves it into individual
 * BOLs (Splitter), then each BOL is FILED into Customer/Year/Month and INDEXED.
 * Filing precedes indexing and is idempotent per BOL (keyed on the invoice
 * number), so an interrupted run resumes with no duplicate files or rows
 * (NFR-2/NFR-3, FR-17, FR-25). Read/segmentation failures store the whole scan
 * in "_Unsorted" for review — nothing is ever lost. A per-run time guard keeps
 * each execution inside the platform limit (FR-4).
 *
 * run() is async because pdf-lib is; Apps Script awaits it to completion.
 */

async function run() {
  // Daily-quota circuit breaker: if we exhausted Gemini's per-day limit earlier,
  // skip cheaply until it resets after midnight Pacific (FR — self-protect).
  if (Quota.isPaused()) {
    Logger.log('Skipping run: Gemini daily quota exhausted; resumes after midnight Pacific.');
    return;
  }

  const deadline = Date.now() + Config.num('BATCH_MAX_MS');
  const counts = { filed: 0, filed_new_customer: 0, unsorted: 0, duplicate: 0, error: 0 };

  try {
    const threads = Intake.fetchThreads();
    for (const thread of threads) {
      if (Date.now() > deadline) break;

      const items = Intake.pdfItems(thread);
      let allDone = items.length > 0;
      for (const item of items) {
        if (Date.now() > deadline) { allDone = false; break; }
        const done = await processItem_(item, counts, deadline);
        if (!done) allDone = false;
      }

      // Retire the email only once every BOL in every attachment is stored + indexed.
      if (allDone) Intake.markThreadProcessed(thread);
    }
  } catch (err) {
    if (String((err && err.message) || err).indexOf('GEMINI_QUOTA_EXHAUSTED') >= 0) {
      Quota.pauseForToday(); // stop for the day; the current email stays queued, untouched
      Logger.log('Gemini daily quota exhausted — paused until it resets after midnight Pacific.');
    } else {
      throw err;
    }
  }

  try { Storage.checkAndWarn(); } catch (e) { Logger.log('Storage check failed: %s', e); }
  Notify.maybeSendSummary(counts);
  Logger.log('Run complete: %s', JSON.stringify(counts));
}

/**
 * Reads one attachment (which may hold several BOLs) and files+indexes each.
 * @returns {Promise<boolean>} true when the whole attachment is done (so its
 *   thread can be retired); false if the run ran out of time partway through.
 */
async function processItem_(item, counts, deadline) {
  const wholeKey = item.key + '::whole';
  if (Indexer.has(wholeKey)) return true; // parked in review on a prior run

  const blob = item.attachment.copyBlob();
  const ingest = formatDate_(item.message.getDate());

  let result;
  try {
    result = await Splitter.split(blob);
  } catch (err) {
    // Daily-quota exhaustion bubbles up to run() to pause the whole batch.
    if (String((err && err.message) || err).indexOf('GEMINI_QUOTA_EXHAUSTED') >= 0) throw err;
    // Any other transient error (e.g. a per-minute rate limit that outlasted the
    // in-call retry) — leave the email untouched and retry it on the next run,
    // rather than parking it in _Unsorted and letting the email get trashed.
    Logger.log('Read error on %s (will retry next run): %s', item.attachment.getName(), err);
    counts.error++;
    return false;
  }
  if (!result.ok) {
    reviewWhole_(item, wholeKey, blob, ingest, STATUS.UNSORTED, result.reason, counts);
    return true;
  }

  for (let i = 0; i < result.bols.length; i++) {
    if (Date.now() > deadline) return false; // finish the remaining BOLs next run
    fileOneBol_(item, i, result.bols[i], ingest, counts);
  }
  return true;
}

/** Files + indexes a single BOL into its Customer/Year/Month folder. */
function fileOneBol_(item, index, bol, ingestDate, counts) {
  const f = bol.fields;
  const invoice = f.invoiceNumber || '';
  // Idempotency key: invoice # is unique per BOL and stable across re-splits;
  // fall back to position only when no invoice was read.
  const bolKey = item.key + '::' + (invoice || ('b' + index));
  if (Indexer.has(bolKey)) return; // already filed on a prior run

  // Delivery date drives Year/Month; parse whatever format Gemini returned into
  // yyyy-MM-dd, and fall back to the email's date if unreadable (FR-15).
  let date = normalizeDate_(f.deliveryDate) || normalizeDate_(f.shipDate);
  let dateInferred = false;
  if (!date) { date = ingestDate; dateInferred = true; }
  const year = date.slice(0, 4), month = date.slice(5, 7);

  const decision = Match.resolve(f.customerName);
  let folder, customer = '', status;
  if (decision.decision === 'file') {
    customer = decision.customer.canonical_name;
    folder = Filer.destinationFolder(decision.customer, year, month);
    status = STATUS.FILED;
  } else if (decision.decision === 'new_customer') {
    const created = Customers.add(decision.newCustomerName);
    customer = created.canonical_name;
    folder = Filer.destinationFolder(created, year, month);
    status = STATUS.FILED_NEW_CUSTOMER;
  } else {
    folder = Filer.unsortedFolder(); // customer name unreadable
    status = STATUS.UNSORTED;
  }

  // Re-scan duplicate detection (FR-24): same invoice already filed.
  if (Indexer.invoiceAlreadyFiled(invoice)) status = STATUS.DUPLICATE;

  const stem = Naming.buildBaseName({ date, po: f.customerPO, invoice, itemKey: bolKey });
  const placed = Filer.place(bol.blob, folder, stem, bolKey);

  Indexer.append({
    processed_at: formatDate_(new Date(), true),
    original_filename: item.attachment.getName(),
    customer,
    year_month: year + '-' + month,
    delivery_date: date,
    date_inferred: dateInferred ? 'TRUE' : '',
    customer_po: f.customerPO || '',
    invoice_number: invoice,
    status,
    reason: decision.reason || '',
    file_link: placed.link,
    item_key: bolKey
  });
  tally_(counts, status);
}

/** Stores the whole scan in "_Unsorted" for review (read or segmentation failed). */
function reviewWhole_(item, wholeKey, blob, ingestDate, status, reason, counts) {
  const stem = Naming.buildBaseName({ date: ingestDate, po: '', invoice: '', itemKey: wholeKey });
  const placed = Filer.place(blob, Filer.unsortedFolder(), stem, wholeKey);
  Indexer.append({
    processed_at: formatDate_(new Date(), true),
    original_filename: item.attachment.getName(),
    customer: '', year_month: ingestDate.slice(0, 7), delivery_date: ingestDate,
    date_inferred: 'TRUE', customer_po: '', invoice_number: '',
    status, reason, file_link: placed.link, item_key: wholeKey
  });
  tally_(counts, status);
}

function tally_(counts, status) {
  if (status === STATUS.FILED) counts.filed++;
  else if (status === STATUS.FILED_NEW_CUSTOMER) counts.filed_new_customer++;
  else if (status === STATUS.DUPLICATE) counts.duplicate++;
  else if (status === STATUS.ERROR) counts.error++;
  else counts.unsorted++;
}

/** yyyy-MM-dd (or full timestamp) in the workbook's script timezone. */
function formatDate_(date, withTime) {
  const tz = Session.getScriptTimeZone();
  return Utilities.formatDate(date, tz, withTime ? "yyyy-MM-dd'T'HH:mm:ss" : 'yyyy-MM-dd');
}

/**
 * Normalizes a date string from Gemini into yyyy-MM-dd, whatever format it came
 * in (Gemini isn't consistent — sometimes ISO, sometimes US MM/DD/YYYY). Returns
 * '' if unrecognizable so the caller can fall back to the email date.
 */
function normalizeDate_(s) {
  s = String(s || '').trim();
  let m;
  if ((m = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/))) return isoParts_(m[1], m[2], m[3]);        // yyyy-mm-dd
  if ((m = s.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})$/))) return isoParts_(m[3], m[1], m[2]);        // mm/dd/yyyy
  if ((m = s.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{2})$/))) return isoParts_('20' + m[3], m[1], m[2]); // mm/dd/yy
  return '';
}

function isoParts_(y, mo, d) {
  const p = n => ('0' + Number(n)).slice(-2);
  if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31) return '';
  return y + '-' + p(mo) + '-' + p(d);
}
