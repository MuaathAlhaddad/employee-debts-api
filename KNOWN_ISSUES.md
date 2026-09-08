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

## UNVERIFIED (added 2026-09-08, blocks trusting "Disable Daftra Client" against a real client) — Daftra Client resource's writable field names have never been confirmed

`daftraDisableClient_()` (`Daftra.gs`, backs `disableDaftraClient()` in `Migrations.gs`) guesses the client's display-name field is `business_name` — unlike every other Daftra write in this file, this has never been confirmed against a real client record. `testRawClient()` and `testClientRenameSuspendRoundTrip()` (`Tests.gs`) were added specifically to close this gap — **run both by hand against the designated test client (#630) and confirm the round trip actually renames/suspends/restores correctly before ever calling `disableDaftraClient()` against a real client.** If the field name guess is wrong, fix `daftraDisableClient_()`'s payload before trusting it. This function was deliberately left OUT of the automated `runSmokeTests` suite for this same reason (see that function's own comment).

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
