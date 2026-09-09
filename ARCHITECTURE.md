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

## Where to look next

- `CLAUDE.md` — file-by-file architecture detail and non-obvious Daftra-integration gotchas for
  this repo specifically.
- `DECISIONS.md` — dated log of business/architecture decisions and confirmed incidents.
- `KNOWN_ISSUES.md` — open bugs and gaps, including the story of why this file exists at all.
- `employee-debts-app`'s own `ARCHITECTURE.md`/`DECISIONS.md` — the frontend half of this system.
