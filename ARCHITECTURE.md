# Architecture

This repo is one of three that together run a small shop's debt-tracking and sales system. This
document exists so that fact doesn't depend solely on an external, unversioned link surviving —
see "The three-project system" below for the durable version of what the linked diagram shows.
(This file is intentionally near-identical to the copy in `employee-debts-app` and
`pl-report-google-script-v2` — each repo should be understandable without needing the other two
open.)

## This repo's role

`employee-debts-api` is a **standalone Apps Script JSON API** (no HtmlService, not container-bound
to any Sheet) that exists purely to back `employee-debts-app`, the employee-facing PWA. It has no
UI of its own. See `CLAUDE.md` for file-level detail (`Api.gs`, `Config.gs`, `Daftra.gs`,
`Debts.gs`, `Employees.gs`, `Products.gs`, `SyncBundle.gs`, `Tests.gs`).

## The three-project system

```
                    ┌──────────────────────────────┐
                    │   Google Sheet (one file)     │
                    │   opened by ID, not shared    │
                    │   code — two tabs are shared: │
                    │   "Debts Snapshot", "Employees"│
                    └───────┬───────────────┬────────┘
                            │               │
              container-bound              openById() (standalone)
                            │               │
         ┌──────────────────▼───┐   ┌───────▼───────────────┐
         │ pl-report-google-     │   │ employee-debts-api    │
         │ script-v2             │   │ (THIS REPO)           │
         │ (OWNER only)          │   │                       │
         │ HtmlService SPA,      │   │ Standalone JSON API,  │
         │ nightly cash/sales    │   │ no HtmlService, no    │
         │ entry + P&L dashboard │   │ Sheet UI of its own   │
         │ + bulk Daftra tools   │   │                       │
         └───────────┬───────────┘   └───────────┬───────────┘
                     │                            │
                     │      both talk to          │ fetch() over
                     └───────────►Daftra◄─────────┘ Content-Type: text/plain
                        (shared account,               │
                         api2/*.json, APIKEY)   ┌───────▼───────────────┐
                                                 │ employee-debts-app     │
                                                 │ (employee PWA)         │
                                                 │ IndexedDB cache,       │
                                                 │ service-worker shell   │
                                                 └────────────────────────┘
```

- **Shared Google Sheet, by ID**: `SHEET_ID` in `Config.gs`, opened via
  `SpreadsheetApp.openById()` — this repo is *not* container-bound to it, unlike
  `pl-report-google-script-v2`. Only two tabs are touched here: `Debts Snapshot`
  (`DEBTS_HEADERS` in `Daftra.gs`) and `Employees` (PIN roster, `Employees.gs`). Both tabs'
  column-header constants are **deliberately duplicated, not shared code**, between this repo and
  `pl-report-google-script-v2` (per that repo's `ImportShortDebts.gs` comment) — a mismatch should
  fail loudly, not silently misfile columns. Changing either tab's layout is a cross-repo breaking
  change requiring both projects' constants to be updated by hand.
- **Shared Daftra account**, reached via `api2/*.json` with `DAFTRA_SUBDOMAIN`/`DAFTRA_API_KEY`
  Script Properties — set independently here, **not shared** with
  `pl-report-google-script-v2`'s own Script Properties even though both hit the same account.
- **Why this repo exists separately from `pl-report-google-script-v2`** (per `Api.gs`'s header
  comment): page-size limits in that project's HtmlService IFRAME sandbox (its own
  `document.write`-based rendering has a real total-size ceiling), and employees should never see
  the owner's sales/dashboard tabs.
- **Deployment model — the one most likely to be gotten wrong across these three repos**: this
  repo must be deployed to a specific **versioned** deployment id after every `clasp push` —
  `@HEAD` only serves whoever has edit access to the script itself, regardless of the webapp
  manifest's access setting, so employees never reach it via `@HEAD`. Contrast with
  `pl-report-google-script-v2`, where `@HEAD` *is* the live URL and `npm run watch` auto-pushes on
  every save — that only works there because only the owner ever opens it. See "Deploying" in
  `CLAUDE.md` for the current versioned deployment id and the exact command.

## Data flow for a typical action

1. `employee-debts-app`'s `apiCall()` POSTs `{ action, params }` to this project's versioned
   deployment URL as `Content-Type: text/plain` (deliberately, to dodge a CORS preflight `OPTIONS`
   request Apps Script Web Apps can't handle).
2. `Api.gs`'s `doPost(e)` looks the action up in the explicit `API_ACTIONS` whitelist — never
   callable by name without being added there first — and applies `params` positionally.
3. **Reads** (`syncBundle`, product search, account statements) go straight to the Sheet and/or
   Daftra and return.
4. **Financial writes** (`addLongDebtorPayment`, `addLongDebtorInvoice`, and their `edit*`
   counterparts) write to Daftra first, then patch a single Sheet row with a freshly-recomputed
   balance so the app doesn't have to wait for a full account rescan. See `DECISIONS.md`'s
   "Financial writes must be online-only" entry for the client-side contract this must uphold —
   in particular, this project's responses to these actions are expected to eventually return the
   authoritative post-write balance directly (not yet implemented — see `KNOWN_ISSUES.md`).

## Daftra Client → Notebook Client migration (Owner-only, added 2026-09-08)

Lets the Owner move a client's debt tracking from a real Daftra client (a "Long" debtor) to a hand-entered Notebook client (a "Short" debtor), then formally disable the original once the new one's been verified. Deliberately two separate, non-atomic API actions (`Migrations.gs`), never one:

1. `convertDaftraClientToNotebook` — creates a new Short debtor seeded from the Daftra client's name and current balance (opening balance IS carried over — owner's explicit request, 2026-09-09, overriding this feature's original spec; logged as a real Short Debtor Transaction), and records a link in a new "Client Migrations" sheet. Never touches the original Daftra client. Calling it again for the same Daftra client returns the existing link instead of creating a duplicate.
2. `disableDaftraClient` — only runs once step 1's link exists. Re-checks the *live* Daftra balance, clears it via a real `client_payments.json` payment if anything's outstanding (the only balance-clearing mechanism this codebase has — see `DECISIONS.md`'s 2026-09-08 entry), then renames and suspends the Daftra client (`daftraDisableClient_()`, Daftra.gs — UNVERIFIED, see `KNOWN_ISSUES.md`), then marks the migration "completed". A Daftra failure at any point stops everything after it; a retry re-reads the live balance so it can't double-pay.

Both actions require the `"owner"` role (`requireOwnerAccess_()`, Employees.gs) — a real per-employee role, not a name check; see `DECISIONS.md`'s 2026-09-08 entries for why this role was added (superseding the 2026-09-05 "no owner tier" decision) and for the balance-clearing trade-off. The "Client Migrations" sheet doubles as this feature's audit trail (every field the feature needed to log lives on one row: both client IDs/names, status, created/disabled at/by, the balance actually cleared, the new Daftra name, the Daftra payment id).

## Owner-only Notebook deletion + Notebook tags (added 2026-09-10)

**Deletion.** Only the `"owner"` role (`requireOwnerAccess_()`, Employees.gs) can delete a Notebook
(Short) client, one of their Notebook payments, or one of their Notebook invoices -- never a hard
delete. `deleteShortDebt()`/`restoreShortDebt()` (Debts.gs) toggle `Deleted At`/`Deleted By` on the
Debts Snapshot row (two new trailing columns, `DEBTS_HEADERS`); `deleteShortTransaction()`/
`restoreShortTransaction()` do the same on the matching row in Short Debtor Transactions (three new
trailing columns: `ID`, `Deleted At`, `Deleted By`). `getDebtsList()`/`getShortDebtorTransactions()`
both filter out anything with a `Deleted At` set, so a deleted record disappears from every normal
list/total but the row itself is never removed -- restoring is a real, working, symmetric action
(not wired into the frontend UI yet, but complete and tested server-side). Deleting/restoring a
transaction also reverses/reapplies its effect on the parent client's stored `Amount Owed`/
`Amount Paid`, since those are running totals, not derived by summing the ledger on every read --
see `deleteShortTransaction()`'s own comment for the exact clamp behavior on the one edge case this
doesn't fully replay (a later transaction still depending on the one being deleted).

Both the client-level and transaction-level actions require running `migrateNotebookDeletionAndTags()`
(Migrations.gs) once, before deploying, so the new columns actually exist on the real sheets --
`refreshDebtsSnapshot()` refuses to run against a header layout it doesn't recognize (see that
function's own comment), and the delete/restore actions write to fixed column numbers directly.

**Notebook tags.** Reusable tags/categories for Notebook (Short) clients only -- two new sheets
(`Tags.gs`): "Notebook Tags" (the registry: id/name) and "Notebook Client Tags" (the many-to-many
assignment: one row per client-id/tag-id pair), the same "dedicated sheet per relation" pattern as
Client Migrations/Short Debtor Transactions, not a comma-separated or JSON-blob column. Viewing/
filtering is open to any logged-in employee; create/rename/assign/remove need edit access
(`requireEditAccess_()` -- not owner-only, unlike deletion). `getDebtsList()` attaches each Short
client's own tags (`getClientTagsMap_()`) the same one-call way `getClientMigrationsMap_()` attaches
migration state to Long debtors; `syncBundle()` additionally bundles the full tag registry so the
frontend's filter row and "assign an existing tag" picker work from the synced cache.

## Daily Notebook backup to Google Drive (added 2026-09-13)

Disaster recovery for the Notebook (Short debtor) data specifically -- not a general Sheet backup,
and not a substitute for Daftra being its own system of record for Long debtors (see DECISIONS.md's
matching entry). Everything lives in `Backup.gs`.

**What's backed up**, read directly off the live sheets (never through `getDebtsList()`/
`getShortDebtorTransactions()`, both of which filter out soft-deleted rows and the latter also caps
at 5 entries per client -- neither is acceptable for a backup that must be complete):
- Every Debts Snapshot row with `Type === "Short"`, **including soft-deleted** ones.
- Every Short Debtor Transactions row, **all of them, uncapped, including soft-deleted**.
- The full Notebook Tags registry and Notebook Client Tags assignment table.
- The full Client Migrations sheet (explains a migrated Notebook client's carried-over opening
  balance).
- The full Debts Review Log (small; shared with Long debtors too, but documents which Notebook log
  entries were reviewed).

Deliberately **excluded**: the Employees sheet (plaintext PINs -- a secret, and not needed to
reconstruct Notebook data, since every backed-up row already carries the acting employee's *name*)
and the existing in-sheet "Short Debtors Backup" tab (`backupShortDebtRows_()`, Daftra.gs -- a
same-spreadsheet safety net for a *different* failure mode, already effectively covered by backing
up Debts Snapshot itself).

**Format**: seven JSON files per day (`customers.json`, `transactions.json`, `tags.json`,
`tag_assignments.json`, `migrations.json`, `review_log.json`, `metadata.json`) -- arrays of named
objects, not raw sheet rows, so a restore never depends on remembering column positions.
`metadata.json` carries `backup_version`, `created_at`, `source_spreadsheet_id`, record counts,
financial totals, and a SHA-256 checksum per file (`Utilities.computeDigest`).

**Where**: `My Drive/AlFajr/Notebook Backups/YYYY/YYYY-MM/YYYY-MM-DD/` -- the whole path is one
config block, `CONFIG.BACKUP` (Config.gs), not hardcoded around the codebase. Each level is
found-or-created (`findOrCreateFolder_()`), never blindly created, so re-running never produces a
duplicate folder. An optional Script Property (`BACKUP_PARENT_FOLDER_ID`) can root `AlFajr` under a
different Drive folder (e.g. a Shared Drive) instead of the script owner's My Drive.

**Trigger**: `setupDailyBackupTrigger()` deletes any existing trigger pointed at
`runNotebookBackupTrigger` before creating exactly one new time-based daily trigger (hour
configurable via `CONFIG.BACKUP.TRIGGER_HOUR`) -- safe to re-run any number of times, including
after every redeploy. `listBackupTriggers_()` confirms exactly one exists.

**Duplicate/failure safety**: a **"Notebook Backup Status"** sheet gets one append-only row per
attempt (date, started/completed at, status, counts, error). If a *successful* backup is already
recorded for today, `runNotebookBackup()` returns immediately without touching Drive again --
running the trigger twice, or re-running it by hand, is always a safe no-op. A prior *failed*
attempt's files can be overwritten on retry (they were never valid, so "never overwrite a valid
backup" doesn't apply) -- `writeBackupFile_()` moves any same-named file to Drive trash (recoverable
~30 days) rather than permanently deleting it first. On any failure, the error is logged to the
status sheet AND emailed (`MailApp`) to the script owner (or an override via the
`BACKUP_NOTIFY_EMAIL` Script Property) before the error is rethrown -- so a trigger-driven failure
also gets Apps Script's own built-in execution-failure email as a second channel. Tomorrow's backup
is entirely independent (a different day folder) and is never blocked by today's failure.

**Integrity**: after writing all seven files, each is read back from Drive and its SHA-256 checksum
recomputed and compared against what was computed before the write -- a backup is only marked
`success` if every file round-trips byte-for-byte. This catches a truncated/corrupted Drive write;
it cannot catch a bug that produces wrong data consistently on both the write and the read-back
(there's nothing else in this design to independently cross-check against at that instant) --
`testNotebookBackupCounts()` (Tests.gs) is the closest thing to that: an independent read-path
cross-check against `getDebtsList()`, run by hand.

**Owner-only API actions** (`Api.gs`, both read-only w.r.t. financial data): `getNotebookBackupStatus`
(recent attempt history, so "did today's backup succeed" is one call away, no Sheet/editor access
needed) and `runNotebookBackupNow` (manual on-demand backup, e.g. right after a schema change --
shares every safety property of the trigger since it calls the exact same function).

**Restoration**: never automatic, and never into the production spreadsheet. See "Restoration
procedure" below.

### Restoration procedure

1. Find the day's folder: `AlFajr/Notebook Backups/YYYY/YYYY-MM/YYYY-MM-DD/` in Drive, or run
   `getNotebookBackupStatus` for the folder URL.
2. From the Apps Script editor (never via the HTTP API -- this is deliberately not whitelisted in
   `Api.gs`), run `restoreNotebookBackupToNewSpreadsheet_("YYYY-MM-DD")` (Backup.gs). It:
   - Reads all seven files back from that day's folder and verifies every file's SHA-256 checksum
     against `metadata.json` first -- refuses to restore anything if a checksum doesn't match.
   - Creates a **brand new spreadsheet** (never touches `SHEET_ID`) named
     `Notebook Restore Test -- YYYY-MM-DD -- <timestamp>`, with one tab per data file.
   - Returns `{ spreadsheetUrl, metadata, restoredCounts }`.
3. Open that new spreadsheet and manually verify counts/balances/history look right (Test 9 in this
   feature's test plan) -- this is the "restore into a new/test environment" step.
4. **Only after that verification** would a real rebuild of production data be a deliberate, manual,
   human decision -- there is no automated "promote this to production" step, and there should not
   be one added without a new decision here first (see DECISIONS.md). A real rebuild means hand-
   copying/reconciling the verified rows into the production Debts Snapshot/Short Debtor
   Transactions/Notebook Tags/etc. sheets, which is exactly the kind of action this backup system
   exists to make *possible*, not something it does *for* you automatically.

### Manual setup required (once)

- Run `setupDailyBackupTrigger()` once from the Apps Script editor, as the shop owner's Google
  account (so backups land in the owner's Drive, private by default) -- see CLAUDE.md's "Deploying"
  section for why this can't be done through a `clasp push` alone.
- The first run of anything in `Backup.gs` (DriveApp/MailApp) will prompt for additional OAuth scope
  authorization -- accept it as the same account that owns the Sheet/script.
- Optionally set `BACKUP_PARENT_FOLDER_ID`/`BACKUP_NOTIFY_EMAIL` Script Properties if the defaults
  (My Drive root / the script's effective user) aren't right for this deployment.

## Where to look next

- `CLAUDE.md` — file-by-file architecture detail and non-obvious Daftra-integration gotchas for
  this repo specifically.
- `DECISIONS.md` — dated log of business/architecture decisions and confirmed incidents.
- `KNOWN_ISSUES.md` — open bugs and gaps, including the story of why this file exists at all.
- `employee-debts-app`'s own `ARCHITECTURE.md`/`DECISIONS.md` — the frontend half of this system.
