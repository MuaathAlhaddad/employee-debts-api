# Known Issues

Open bugs, gaps, and process failures that don't belong in `DECISIONS.md` (which is for settled
decisions) but that a future session needs to know about rather than rediscover from scratch.
Update the relevant entry at the end of any session that touches one of these without fully
resolving it.

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

**Still needed before trusting this again:** the new allowlist is a best-effort field list, not a Daftra-documented one — **run `testClientRenameSuspendRoundTrip(630)` (Tests.gs) against the designated test client and confirm it passes before retrying "Disable Daftra Client" against any real client, including #526.** `daftraDisableClient_()` remains deliberately excluded from the automated `runSmokeTests` suite for this reason.

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

## Cross-reference — Long debtor card staleness investigation (owned by `employee-debts-app`)

An open bug where a Long debtor's card doesn't reflect a payment/invoice until a full "Refresh
from Daftra" was investigated on 2026-09-05, touching this repo's `Debts.gs` (a
`SpreadsheetApp.flush()` fix was added, verified via direct API testing against test client #630,
then reverted along with everything else per the owner's request pending further investigation).
Full details, what was ruled out, and the leading unconfirmed hypothesis (a client-side race in
`employee-debts-app`'s `doSync()`) live in `employee-debts-app`'s `KNOWN_ISSUES.md` — read that
before re-investigating, so the same ground isn't covered twice.
