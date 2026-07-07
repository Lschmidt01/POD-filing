# Proof-of-Delivery Paperwork Filing System

Unattended pipeline that ingests scanned signed delivery papers (BOLs) emailed
as PDFs, files each into the right customer's Google Drive folder under a
consistent name, and logs every one in a searchable index. Built on Google Apps
Script + Drive OCR + Google Sheets, per the build requirements.

**The one hard rule (NFR-1):** never file a BOL under the wrong customer.
Anything the system can't resolve confidently goes to a `_Unsorted` catch-all
folder and is still indexed — never guessed into a customer folder.

## Current status

| Milestone | State |
|-----------|-------|
| 1. Scaffold + Setup | ✅ done |
| 2. Intake + Index (idempotent spine) | ✅ done |
| 3. OCR + Extract | ⏳ stubbed (`Ocr.gs`, `Extract.gs`) |
| 4. Match + File to customer folders | ⏳ matching is normalized-exact placeholder (`Match.gs`) |
| 5. Catch-all + duplicates + edge cases | ◐ duplicate/versioning + catch-all routing done; more edge cases with real OCR |
| 6. Daily summary + hardening | ⏳ stub (`Notify.gs`) |

Because OCR/extraction are stubbed to return nothing, **right now every ingested
PDF is filed to `_Unsorted` and gets one index row** — which is the correct safe
default and lets you exercise the whole intake → file → index → resume path end
to end before OCR is added.

## Files

| File | Role |
|------|------|
| `appsscript.json` | Manifest: least-privilege OAuth scopes + Drive advanced service |
| `Setup.gs` | One-time `install()` — creates workbook, folders, label, trigger |
| `Config.gs` | Reads settings from the `Config` sheet tab (operator-editable) |
| `Main.gs` | `run()` orchestrator: batch loop, time guard, idempotency |
| `Intake.gs` | Gmail: find threads, enumerate PDF attachments, label/archive |
| `Ocr.gs` | PDF → text (stub) |
| `Extract.gs` | Text → customer / order / date (stub) |
| `Match.gs` | Name → canonical customer + confidence (placeholder scoring) |
| `Customers.gs` | Customer master-list CRUD |
| `Filer.gs` | Store PDF, folders, no-overwrite versioning, retry-safe |
| `Naming.gs` | Build filename from the configured pattern |
| `Indexer.gs` | Append index rows; idempotency + duplicate lookups |
| `Notify.gs` | Optional daily summary email (stub, off by default) |
| `Tests.gs` | `test_pureLogic()` / `test_smoke()` runnable from the editor |

## Setup

Uses [`clasp`](https://github.com/google/clasp) to push local files to an Apps
Script project.

```bash
npm install -g @google/clasp
clasp login
clasp create --type standalone --title "POD Filing"   # writes .clasp.json
clasp push
```

Then, in the Apps Script editor:

1. Run **`install`** once and grant the requested scopes. This creates:
   - a master **workbook** with `Config`, `Customers`, `Index` tabs,
   - a Drive root folder **POD Customer Folders** with a **`_Unsorted`** child,
   - the Gmail **`pod-processed`** label, and
   - a time trigger calling `run()` every 10 minutes.
2. Point your scanner's scan-to-email at the Gmail account this script runs as
   (or adjust `GMAIL_QUERY` in the `Config` tab to target a label/address).
3. Seed the **`Customers`** tab with `canonical_name` + known `aliases`.
   (`folder_id`/`active` can be left blank.)

Everything tunable lives in the `Config` tab — threshold, filename pattern,
poll interval, summary email — editable without code changes (NFR-7).

## Verifying milestone 2

- Run `test_pureLogic()` → all pass (no setup needed).
- After `install()`, send a test email with one or more PDF attachments to the
  intake account, then run `run()` manually. Expect: each PDF copied into
  `_Unsorted`, one `Index` row per PDF (status `unsorted_unreadable`), and the
  email labelled `pod-processed` + archived.
- Re-run `run()` → no new files, no new rows, email already retired (proves
  idempotency, NFR-3 / FR-25).

## Open spec gaps (affect milestones 3–4)

1. **Confidence source.** Drive OCR returns no numeric confidence, so
   `confidence` is derived from the *match* (string similarity), not OCR
   quality. If true OCR confidence is needed, escalate to the Python/vision
   path noted in the requirements.
2. **Duplicate key without an order number.** FR-24's key is `customer + order
   (+ date)`; when order is absent, duplicates need another signal (e.g. a
   content hash). Currently a re-scan with no order number won't be detected as
   a duplicate.
3. **Auto-create new customer (FR-12)** needs a reliable "name read
   confidently" signal — see gap 1. Until then, an unrecognized name routes to
   `_Unsorted` (safe) rather than inventing a folder.
4. **Template layout / date format** (§10) drives the extraction regexes in
   `Extract.gs`.
