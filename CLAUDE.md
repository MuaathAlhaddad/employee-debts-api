# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A standalone Apps Script project (not container-bound to any Sheet) that's a pure JSON API for `employee-debts-app`, a separate PWA employees use on their phones to check debtors and product prices. It's deliberately split out from the owner's `pl-report-google-script-v2` sales-tracker project — see `Api.gs`'s header comment (page-size limits in that project's HtmlService sandbox, and employees shouldn't see the owner's sales/dashboard tabs at all).

For how this project fits together with `pl-report-google-script-v2` and `employee-debts-app` (shared Sheet, shared Daftra account), see the [architecture diagram](https://claude.ai/code/artifact/5fd8bd90-a0b1-4389-926a-859cb014fa91) and, for a version-controlled fallback that doesn't depend on that external link surviving, this repo's own [ARCHITECTURE.md](ARCHITECTURE.md).

**Before making a non-trivial change, check [DECISIONS.md](DECISIONS.md) and [KNOWN_ISSUES.md](KNOWN_ISSUES.md) first** — they capture business rules, confirmed incidents, and in-progress investigations that aren't otherwise visible from reading the current code, including a documented case of this repo's own git history materially understating what actually shipped (see "Documentation and process" below).

## Commands

- `npm run push` — `clasp push` (this project has no build step; `.clasp.json`'s `rootDir` is `src` directly, unlike the sales-tracker project).
- `npm run deploy` — `clasp deploy`. **A bare `clasp deploy` is not enough to reach employees — see "Deploying" below.**
- `npm run open` / `npm run logs` — thin `clasp` wrappers.
- No separate test runner: correctness is checked by running `runSmokeTests` (see "Testing" below) or the individual `test*()` functions in `Daftra.gs` from the Apps Script editor's function dropdown.

## Deploying — HEAD is not what the PWA calls

Apps Script's `@HEAD` deployment only serves whoever has edit access to the script itself, *regardless* of the webapp manifest's `access` setting (confirmed empirically: `ANYONE_ANONYMOUS` + HEAD still redirects an unauthenticated request to Google sign-in). The PWA calls a specific **versioned** deployment instead, currently:

```
AKfycbx5--YJ4IF6VEQqk14AGB0Pxfnv8mpQbmu_e5iTyebZSQKBg_pD7eP2C79Zdk9nor-zDQ
```

**Every backend change needs `clasp deploy -i <that id>` after `clasp push`**, or employees keep hitting the old code even though `clasp push` "succeeded." This is the opposite of `pl-report-google-script-v2`'s workflow, where HEAD *is* the live URL (that only holds there because only the owner, who has edit rights, ever opens it) — don't assume the two projects deploy the same way. Confirm the current deployment id/URL with `clasp deployments` if in doubt, and check `js/api.js`'s `API_URL` in `employee-debts-app` to see what URL the PWA actually points at.

Script Properties (`DAFTRA_SUBDOMAIN`, `DAFTRA_API_KEY`) are **not shared** with the sales-tracker project even though both talk to the same Daftra account — set them here separately (Project Settings → Script Properties).

**Hard rule, with one deliberate exception for debugging:**
- **An intentional deployment to the shared production URL** — i.e. `clasp deploy -i <the versioned id>`, the step that actually changes what employees hit — must correspond to a committed git checkpoint. Commit the change (with a `DECISIONS.md`/`KNOWN_ISSUES.md` update if it's the kind of change either file covers) *before or immediately after* that deploy — never batch up several sessions' worth of production deploys into one later catch-up commit. This is not a style preference: see `KNOWN_ISSUES.md`'s first entry for the real incident (commit `4d77bde`) where exactly that happened and the fine-grained "why" for eight bundled changes was already gone by the time anyone reconciled git.
- **A `clasp push` used only to test something in a live Apps Script execution** (e.g. running a diagnostic function from the editor, or checking a change against test client #630 before deciding it's right) does not itself require a commit first — but it also must never be described as a completed fix, a finished production change, or evidence that the repo is "deploy-safe" until it *has* been committed and deployed to the versioned id per the rule above. Don't let an uncommitted debugging push linger past the session that made it, either — resolve it one way or the other (commit-and-deploy, or revert) before moving on.

## Architecture

- **Shares the sales-tracker project's Google Sheet by ID** (`SHEET_ID` in `Config.gs`, opened via `SpreadsheetApp.openById()`, not container binding) — specifically the `Employees` sheet (same PIN roster, `Employees.gs`) and `Debts Snapshot` (`DEBTS_HEADERS` in `Daftra.gs`). Changing either sheet's column layout is a cross-repo breaking change; keep both projects' header constants in sync by hand (they're deliberately duplicated, not shared code, per `ImportShortDebts.gs`'s comment in the other repo — a header mismatch should fail loudly, not silently misfile columns).
- **API surface** (`Api.gs`): `doPost(e)` parses the body as JSON (`{ action, params }`, `params` applied positionally) regardless of declared content-type — the PWA deliberately sends `Content-Type: text/plain` so the browser treats it as a CORS "simple request" and skips a preflight `OPTIONS` call, which Apps Script Web Apps can't handle. `API_ACTIONS` is an explicit whitelist; never call a function by name without adding it there first.
- **Daftra client** (`Daftra.gs`) has matured past the sales-tracker project's version: generic `daftraGet_`/`daftraPost_`/`daftraPut_`/`daftraDelete_` plus `daftraPaginate_` (loops until Daftra reports no more pages, no fixed cap). Same wrapper-key inconsistency handling (`daftraExtractList_`/`daftraUnwrap_`) as the other project.
  - **`daftraPut_` does a full replace, not a partial patch** — any field left out of the payload gets reset to a default rather than left alone. Every editor function must read the current record first and carry every meaningful field forward unchanged except what's actually being corrected.
  - A 400's top-level `message` is a generic "fix the errors below"; the real reason is in `validation_errors`.
  - Client balance can also move via a manual Daftra Journal Entry, which is deliberately *not* accounted for here (investigated: `journals.json` exists but entries key off an internal `journal_account_id`, not `client_id`, and this account has 40,000+ of them) — a manual balance correction should be entered as a real Daftra invoice instead, since that path is read correctly.
  - Product purchase history is cached (`Products Cache` / `Product Price Cache` sheets, `PRODUCT_PRICE_CACHE_MAX_AGE_DAYS`) because this account has 56,000+ `stock_transactions` rows — computing live history for a whole catalog isn't practical, only for one product on demand.
- **Long vs. Short debtors**: Long = real Daftra clients with a live balance (from `refreshDebtsSnapshot()`); Short = hand-entered notebook debts that never become a real Daftra invoice, uniquely identified by an `S-<uuid>` id. Only Short debtors are edited directly in the Sheet by this app; Long debtor edits go through Daftra's own API (`addLongDebtorPayment`/`addLongDebtorInvoice` and their `edit*` counterparts).
- `SyncBundle.gs`'s `syncBundle()` is the PWA's one-call "sync now" payload (debtors + full product catalog for offline search) — deliberately excludes per-product price history for the whole catalog (same 56,000+-row reason above); that's fetched live, per product, on demand instead.

## Testing

Real writes are only trustworthy if they're exercised against the real Daftra API and the real Debts Snapshot sheet — mocks would miss exactly the kind of bug this project has hit before (a Daftra payload silently missing a required field, a `PUT` resetting a field it wasn't supposed to touch, a balance formula that's subtly wrong for some clients but not others).

**Never point a test at a real client or debtor.** Two records exist specifically for this:

| Type | Identifier | Notes |
|---|---|---|
| Long (Daftra) | client **#630** | Real Daftra client, zero balance. Fully self-cleaning (create → verify → edit → verify → delete) — confirmed Daftra's `api2` `DELETE` works for both `invoices.json` and `client_payments.json`, so repeated runs leave zero trace. |
| Short (Notebook) | **"TEST - ignore (ledger check)"**, clientId `S-c35f8951-c7a4-423e-aa31-80c48c8fb818` | Dedicated sandbox row. **Not** self-cleaning — its Amount Owed/Paid and transaction history grow with every run; that's expected. Never mark it paid or delete it. |

Run `runSmokeTests(employeeName, employeePin)` (whitelisted in `Api.gs`) after every change to `Debts.gs`, `Daftra.gs`, or `Api.gs`, right after deploying:

```bash
curl -s -X POST '<the deployed web app URL>' \
  -H 'Content-Type: text/plain' \
  -d '{"action":"runSmokeTests","params":["Owner","<pin>"]}'
```

Returns `{ passed, total, results: [{ name, passed, error? }] }` — anything short of `passed === total` needs investigating. It covers the Long debtor account-statement fetch and payment/invoice create-edit-delete round-trips, and the Short debtor transactions fetch and a debt-added-plus-payment round-trip with the running-balance math checked directly. It deliberately does **not** cover `employee-debts-app`'s own client-side behavior (WhatsApp prompts, offline/IndexedDB sync — those need a real browser) or anything requiring a second PIN/role.

When adding a new check, follow the existing pattern in `Tests.gs`: wrap the call in `check(name, fn)`, throw a descriptive `Error` on mismatch, and if it's a Daftra write, either target client #630 with a delete afterward or make it read-only/no-op — never write to a real client.
