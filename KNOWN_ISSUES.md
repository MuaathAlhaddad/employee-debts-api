# Known Issues

Open bugs, gaps, and process failures that don't belong in `DECISIONS.md` (which is for settled
decisions) but that a future session needs to know about rather than rediscover from scratch.
Update the relevant entry at the end of any session that touches one of these without fully
resolving it.

---

## Limitations (documented 2026-09-13) — Daily Notebook backup (Backup.gs)

Not bugs -- deliberate scope/design limits worth knowing before relying on this for recovery. See
`ARCHITECTURE.md`'s "Daily Notebook backup to Google Drive" section and `DECISIONS.md`'s matching
entry for the full design.

- **Creating the missing helper sheets is a (harmless) side effect of reading them.**
  `getNotebookTagsSheet_()`/`getNotebookClientTagsSheet_()`/`getClientMigrationsSheet_()`/
  `getDebtsReviewSheet_()` all lazily `insertSheet()` themselves if missing (the same pattern those
  features already use elsewhere) -- so the very first backup run on a spreadsheet that's never used
  Notebook tags/migrations/review-log yet will create those empty tabs. No financial data is
  touched; only empty header rows are added.
- **The daily trigger cannot be created by `clasp push`/`clasp deploy`.** `setupDailyBackupTrigger()`
  must be run once, by hand, from the Apps Script editor, as the shop owner's Google account -- there
  is no way to script trigger creation as part of the deploy process itself. If this is ever
  forgotten (e.g. after recreating the whole Apps Script project from scratch), backups silently
  stop with no error, since nothing is invoking `runNotebookBackupTrigger` at all.
  `listBackupTriggers_()` (run from the editor) confirms whether one currently exists.
- **Integrity validation catches a corrupted/truncated Drive write, not a wrong-but-consistent
  read.** The read-back checksum comparison in `runNotebookBackup()` would not detect a bug that
  produces the same wrong value on both the initial sheet read and Drive's read-back -- there is
  nothing else in this design to independently cross-check against at that instant.
  `testNotebookBackupCounts()` (Tests.gs, run by hand) is an independent read-path cross-check
  against `getDebtsList()`, but it only exercises non-deleted, non-Daftra-sourced data paths that
  overlap with what the app itself already reads.
- **No automated retention/cleanup.** Every daily backup is kept forever by design (explicit
  instruction, 2026-09-13) -- Drive storage cost was accepted in exchange for never losing an older
  recovery point automatically. If storage ever becomes a real constraint, that needs a new decision
  here (with an explicit retention policy) before any automatic deletion is added -- don't add one
  unilaterally.
- **Restore is manual and editor-only, by design** (`restoreNotebookBackupToNewSpreadsheet_()`,
  deliberately not in the `Api.gs` whitelist) -- there's no one-click "restore to production" and
  none should be added without a new decision here, given how easily that could overwrite live data.
- **Failure email depends on `Session.getEffectiveUser().getEmail()` resolving to something usable**
  unless `BACKUP_NOTIFY_EMAIL` is explicitly set as a Script Property -- in some Workspace domain
  configurations this can come back blank, in which case a failure is still recorded in the
  "Notebook Backup Status" sheet and Apps Script's own execution log, but no email goes out. Set
  `BACKUP_NOTIFY_EMAIL` explicitly if failure emails aren't arriving.
- **Verified live against production, 2026-09-13/14** (real data: 117 Notebook customers, 314
  transactions, 4 tags, 5 assignments, 30 migrations, 239 review-log entries): manual backup
  generation, record counts, soft-delete preservation (2 deleted customers + 9 deleted transactions
  correctly included), tag/assignment backup, exactly-one-successful-backup-per-day (a real bug was
  found and fixed here -- see below), simulated failure (bad `BACKUP_PARENT_FOLDER_ID`, confirmed
  logged + emailed + previous state untouched), and restore into a brand-new spreadsheet (checksum
  verification passed, all six files' counts matched the original backup exactly). Not independently
  re-verified since: that the failure email actually arrives in the owner's inbox (the send call
  succeeded without throwing, per the status sheet, but the inbox itself wasn't checked), and running
  the actual `runNotebookBackupTrigger` from a real fired time-based trigger rather than a manual
  invocation of the same underlying function.
  - **Bug found and fixed during this verification**: `hasSuccessfulBackupToday_()` originally
    compared the Status sheet's Date column with `String(row[0]) === dateStr`. Sheets silently
    auto-converts a "yyyy-MM-dd"-looking string into a real Date cell on write (the same class of
    bug `DEBTS_HEADERS`' date columns already had to work around elsewhere in this codebase) --
    confirmed live: a second same-day manual backup did NOT skip, it silently re-ran the full
    pipeline and wrote a second "success" row. Fixed by comparing with `normalizeDebtDate_()`
    instead of `String()`, plus formatting the Date column as plain text on sheet creation as a
    second line of defense. Re-verified after the fix: a second run correctly skipped in ~2 seconds
    with no Drive access. If this function is ever touched again, re-test the same-day-duplicate
    case live, not just by reading the code -- this exact bug looked correct on inspection.

---

## PROCESS FAILURE (mitigated 2026-09-05, watch for recurrence) — Git history materially understates real history here

**What happened:** Commit `4d77bde` (2026-09-02) is titled, verbatim: *"Bundled catch-up commit
for changes deployed via clasp throughout this session but never committed to git."* Its message
lists eight distinct features/fixes (reconciliation flags, a header-migration bug fix, the
`client_payments.json` double-counting revert, `editShortDebt`, `editLongDebtorPayment`/
`editLongDebtorInvoice`, the Short Debtor Transactions ledger, the smoke test suite) that were all
live in production before any of them had a corresponding git commit. Similarly, the
2026-08-25→2026-08-26 account-statement windowing change (see `DECISIONS.md`) was deployed and
never separately committed at all — its only record is an in-code comment.

**Why this matters:** Between `clasp push`/`clasp deploy` and `git commit`, there is no
enforcement tying the two together — a session can ship real, live changes to employees and
simply never commit them, and by the time someone reconciles git afterward, the fine-grained
"why" for each individual change is already gone, leaving only whatever survived in code comments
(if anything).

**Mitigation, 2026-09-05:** `CLAUDE.md` now states a hard rule: never let `clasp push`/
`clasp deploy` outrun a git commit. This entry stays here as the concrete evidence for *why* that
rule exists — don't let it get relaxed as "bureaucratic" without reading this first.

## FORGOTTEN — Referenced "plan doc" does not exist in any of the three repos

`Api.gs`'s header comment says "see the plan doc for that background" (regarding page-size limits
in `pl-report-google-script-v2`'s HtmlService sandbox). Searched all three repos
(`employee-debts-api`, `employee-debts-app`, `pl-report-google-script-v2`) on 2026-09-05: no file
matching "plan" exists anywhere. Either it lived outside version control (a Google Doc, a chat
thread) and was never checked in, or it's simply gone. The underlying technical fact (HtmlService
`document.write`'s total-size ceiling) is still documented independently in
`pl-report-google-script-v2`'s own `CLAUDE.md` ("Lazy-loaded tabs" section), so nothing load-bearing
is actually lost here — but the dangling reference itself should probably be removed or repointed
next time `Api.gs`'s header comment is touched.

---

## RESOLVED, but re-verify before next use — Daftra client PUT rejected a full-record payload with a real 400 ("extra_data")

**What happened (2026-09-09):** `daftraDisableClient_()`'s first version PUT the *entire* `clients/{id}.json` GET response back (`Object.assign` of every field), the same "carry everything forward" caution `daftraPut_`'s other callers use. Tried live against a real client (#526, via "Disable Daftra Client") — Daftra rejected it: `400 { "error_type": "extra_data" }`. Confirmed via `testRawClient()` (run against test client #630) that several returned fields are read-only/computed (`id`, `site_id`, `client_number`, `created`, `modified`, `last_login`, `last_ip`, `link`) or static UI captions, not data at all (`bn1_label`/`bn2_label` literally return `"الرقم الضريبي"`/`"Unified Tax Number"`) — Daftra's client-update validator rejects a payload containing those. `business_name` itself was confirmed correct as the rename field.

**Fix:** `daftraClientProfilePayload_()` (`Daftra.gs`) now builds an explicit allowlist of genuine profile fields instead of spreading the whole record — same pattern `editDaftraClientPayment_`/`editDaftraDueInvoice_` already use for their own resources. Shared by `daftraDisableClient_()` and `Tests.gs`'s `testClientRenameSuspendRoundTrip()` restore step (which had the identical bug).

**Client #526's state after the failed attempt:** its balance-clearing payment (the step *before* the rename/suspend PUT) had already succeeded before the PUT failed — confirmed safe to retry (the "Client Migrations" row stayed `status: pending` with a payment id recorded but no `Disabled At`; `disableDaftraClient()` re-checks the live balance on retry, so it will not double-pay).

**Second round, same investigation (2026-09-09):** `testClientRenameSuspendRoundTrip(630)` then hit a second, different 400 -- `validation_errors.email`: `"Email is required if you chose to send the invoice via email"`. Test client #630's `email` is blank, and this account rejects a blank email on ANY client write if that client's invoicing method is set to Email -- the exact same account-level quirk `createDaftraDueInvoice_()` already documented and worked around for invoice creation. `daftraClientProfilePayload_()` now falls back to the same placeholder shape (`client<id>@placeholder.invalid`) when `email` is blank.

**Still needed before trusting this again:** the allowlist + email fallback are still a best-effort guess, not Daftra-documented — **run `testClientRenameSuspendRoundTrip(630)` (Tests.gs) again and confirm it passes end to end before retrying "Disable Daftra Client" against any real client, including #526.** `daftraDisableClient_()` remains deliberately excluded from the automated `runSmokeTests` suite for this reason.

## GAP (documented 2026-09-08, not implemented, deliberately) — No write-off/credit-note API for clearing a Daftra client's balance

Investigated as part of the Daftra Client → Notebook Client migration feature: the only existing mechanism anywhere in this codebase (or `pl-report-google-script-v2`, per that repo's own Daftra integration) that reduces a client's `summary_unpaid` is recording a real `client_payments.json` payment (`addDaftraClientPayment()`). No credit-note, write-off, or balance-adjustment endpoint is implemented or verified. `disableDaftraClient()` therefore clears a balance by recording a real full-amount payment — see `DECISIONS.md`'s 2026-09-08 entry for why that trade-off was accepted rather than left unimplemented. If Daftra's api2 turns out to expose a real write-off mechanism later, this is the function to revisit.

## GAP — Financial write actions don't return the authoritative balance directly

See `DECISIONS.md`'s 2026-09-05 entry ("Financial writes must be online-only"). Today,
`addLongDebtorPayment`/`addLongDebtorInvoice`/`editLongDebtorPayment`/`editLongDebtorInvoice`
return `{ success, sheetUpdated, ... }` — never the actual updated balance. The client currently
has to make a separate `syncBundle` round-trip to learn it. **Not yet implemented** — documented
only, per explicit instruction alongside the decision.

## GAP — No idempotency/request-ID protection on any write action

Same decision, requirement 7. No action in `Api.gs` has any duplicate-submission protection today.
Needs research into Daftra's own API for a client-supplied reference/idempotency mechanism before
this can be designed properly. **Not yet implemented.**

## GAP (documented 2026-09-10, deliberate) — Notebook deletion has no restore UI, and no idempotency issue on retry, but a known replay limitation

**Restore has no frontend UI yet.** `restoreShortDebt()`/`restoreShortTransaction()` (Debts.gs) are
real, tested, whitelisted API actions — not stubs — but nothing in `employee-debts-app` calls them.
Today, an owner who deletes a Notebook client/payment/invoice by mistake can only be restored via a
direct API call (`curl`, same shape as the `runSmokeTests` example in `CLAUDE.md`) until a "trash"
browsing UI is built. Not urgent — the data is never actually lost — but worth knowing before
telling anyone "you can undo this" without also knowing how, today.

**Known limitation, not a bug:** `deleteShortTransaction()`/`restoreShortTransaction()` reverse/
reapply only the ONE transaction being toggled, not a full replay of the client's whole Short Debtor
Transactions history. See `DECISIONS.md`'s 2026-09-10 entry for why this was chosen deliberately
(the reopen-reset behavior in `addShortDebt()` makes a naive full-ledger-sum replay actively wrong,
not just slower) and the exact clamp behavior for the one edge case it doesn't handle perfectly
(deleting an old transaction after a later one already depended on it). If this ever becomes a real
problem in practice, the fix is a proper replay that's aware of the reopen boundary, not a naive
sum.

## Cross-reference — Long debtor card staleness investigation (owned by `employee-debts-app`)

An open bug where a Long debtor's card doesn't reflect a payment/invoice until a full "Refresh
from Daftra" was investigated on 2026-09-05, touching this repo's `Debts.gs` (a
`SpreadsheetApp.flush()` fix was added, verified via direct API testing against test client #630,
then reverted along with everything else per the owner's request pending further investigation).
Full details, what was ruled out, and the leading unconfirmed hypothesis (a client-side race in
`employee-debts-app`'s `doSync()`) live in `employee-debts-app`'s `KNOWN_ISSUES.md` — read that
before re-investigating, so the same ground isn't covered twice.
