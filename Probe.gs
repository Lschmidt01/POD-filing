/**
 * Probe.gs — throwaway diagnostics for milestone 3. Not part of the pipeline.
 *
 * ocrProbe(): finds the newest PDF attachment in the mailbox, runs it through
 * Google Drive's native OCR (PDF -> temporary Google Doc with ocr:true), logs
 * the full extracted text, then deletes the temp doc. Lets us see exactly what
 * the production OCR yields for a real BOL — especially the Delivery Date cell.
 */
function ocrProbe() {
  const blobInfo = newestPdf_();
  if (!blobInfo) { Logger.log('No PDF attachment found in the mailbox.'); return; }
  Logger.log('Probing OCR on attachment: %s', blobInfo.name);

  // Upload the PDF and let Drive convert+OCR it into a Google Doc. Do NOT set
  // the target mimeType to a Doc, or Drive treats the source as a Doc and
  // rejects OCR ("OCR is not supported for files of type ...document").
  const inserted = Drive.Files.insert(
    { title: 'ocr-probe-tmp' },
    blobInfo.blob,
    { ocr: true, convert: true, ocrLanguage: 'en' }
  );

  try {
    const text = DocumentApp.openById(inserted.id).getBody().getText();
    Logger.log('===== OCR TEXT START =====');
    Logger.log(text);
    Logger.log('===== OCR TEXT END =====');
  } finally {
    Drive.Files.remove(inserted.id); // discard the working doc (FR-16 spirit)
  }
}

/**
 * extractProbe(): OCRs the newest PDF, runs the real Extract.parse on it, and
 * logs the parsed fields. Read-only — files nothing. Use this to confirm the
 * customer, dates, invoice #, and PO read correctly before wiring up filing.
 */
function extractProbe() {
  const blobInfo = newestPdf_();
  if (!blobInfo) { Logger.log('No PDF attachment found in the mailbox.'); return; }
  Logger.log('Extracting from: %s', blobInfo.name);

  const text = Ocr.extractText(blobInfo.blob);
  const f = Extract.parse(text);

  Logger.log('===== EXTRACTED FIELDS =====');
  Logger.log('Customer (Ship To) : %s', f.customerName || '(none)');
  Logger.log('Ship Date          : %s', f.shipDate || '(none)');
  Logger.log('Delivery Date       : %s', f.deliveryDate || '(none)');
  Logger.log('  -> Year / Month   : %s', f.deliveryDate ? f.deliveryDate.slice(0, 7) : '(none)');
  Logger.log('Invoice # (Driver Conf): %s', f.invoiceNumber || '(none)');
  Logger.log('Customer PO        : %s', f.customerPO || '(none)');
  Logger.log('============================');
}

/**
 * fileNewestProbe(): runs the newest PDF through the REAL filing pipeline
 * (OCR -> extract -> match -> file into Customer/Year/Month -> index). Use it to
 * test end-to-end without waiting for the trigger. Idempotent: refuses to double
 * -file if this exact attachment is already in the Index.
 *
 * Prereqs: install() has run, and reinitIndex() has been run once for the new
 * Index columns.
 */
async function fileNewestProbe() {
  const item = newestPdfItem_();
  if (!item) { Logger.log('No PDF attachment found in the mailbox.'); return; }
  const counts = { filed: 0, filed_new_customer: 0, unsorted: 0, duplicate: 0, error: 0 };
  await processItem_(item, counts, Date.now() + 300000);
  Logger.log('Processed "%s" -> %s', item.attachment.getName(), JSON.stringify(counts));
  Logger.log('Check the Index tab (new rows) and Drive (Customer/Year/Month) for each BOL. '
    + 'Idempotent: re-running files nothing already filed.');
}

/**
 * pdfLibSelfTest(): confirms the vendored pdf-lib actually loads and round-trips
 * (build a 2-page PDF, split out 1 page) inside Apps Script. Uses no OCR/Gmail.
 */
async function pdfLibSelfTest() {
  Logger.log('typeof PDFLib = %s', typeof PDFLib);
  const { PDFDocument } = PDFLib;
  const doc = await PDFDocument.create();
  doc.addPage([300, 300]); doc.addPage([300, 300]);
  const bytes = await doc.save();
  const src = await PDFDocument.load(bytes);
  const out = await PDFDocument.create();
  (await out.copyPages(src, [1])).forEach(p => out.addPage(p));
  const outBytes = await out.save();
  Logger.log('Built 2-page (%s bytes), split to 1-page (%s bytes). pdf-lib OK.',
    bytes.length, outBytes.length);
}

/**
 * splitProbe(): runs the real Splitter on the newest PDF and logs the BOLs it
 * found plus each one's fields. Read-only — files nothing.
 */
async function splitProbe() {
  const item = newestPdfItem_();
  if (!item) { Logger.log('No PDF attachment found in the mailbox.'); return; }
  Logger.log('Splitting: %s', item.attachment.getName());

  const res = await Splitter.split(item.attachment.copyBlob());
  if (!res.ok) { Logger.log('NOT SPLIT (would go to review): %s', res.reason); return; }

  Logger.log('Found %s BOL(s):', res.bols.length);
  res.bols.forEach(b => {
    const f = b.fields;
    const month = (f.deliveryDate || f.shipDate || '').slice(0, 7) || '(none)';
    Logger.log('  BOL %s [%s pg]: customer="%s"  month=%s  invoice=%s  po=%s',
      b.index + 1, b.pageCount, f.customerName || '(none)', month,
      f.invoiceNumber || '(none)', f.customerPO || '(none)');
  });
}

/**
 * geminiProbe(): sends the newest PDF to Gemini and logs the BOLs it found with
 * page ranges + fields. Read-only. Confirms the API key, model, and extraction
 * all work before wiring Gemini into the pipeline.
 */
function geminiProbe() {
  const item = newestPdfItem_();
  if (!item) { Logger.log('No PDF attachment found in the mailbox.'); return; }
  Logger.log('Reading with Gemini: %s', item.attachment.getName());

  const bols = Gemini.readBols(item.attachment.copyBlob());
  Logger.log('Gemini found %s BOL(s):', bols.length);
  bols.forEach((b, i) => {
    Logger.log('  BOL %s [pages %s-%s]: customer="%s"  delivery=%s  invoice=%s  po=%s',
      i + 1, b.page_start, b.page_end, b.customer || '(none)',
      b.delivery_date || '(none)', b.invoice_number || '(none)', b.customer_po || '(none)');
  });
}

/** Newest PDF attachment across all mail (inbox or archived). */
function newestPdf_() {
  const it = newestPdfItem_();
  return it ? { blob: it.attachment.copyBlob(), name: it.attachment.getName() } : null;
}

/** Newest PDF as a pipeline work item: { message, attachment, key }. */
function newestPdfItem_() {
  const threads = GmailApp.search('has:attachment filename:pdf', 0, 5);
  for (let t = 0; t < threads.length; t++) {
    const msgs = threads[t].getMessages();
    for (let m = msgs.length - 1; m >= 0; m--) {
      const atts = msgs[m].getAttachments({ includeInlineImages: false });
      for (let a = 0; a < atts.length; a++) {
        const isPdf = atts[a].getContentType() === 'application/pdf'
          || /\.pdf$/i.test(atts[a].getName());
        if (isPdf) {
          return { message: msgs[m], attachment: atts[a],
            key: Intake._itemKey(msgs[m], atts[a]) };
        }
      }
    }
  }
  return null;
}
