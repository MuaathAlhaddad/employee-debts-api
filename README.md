# Employee Debts API

Standalone Apps Script backend for the Employee Debts PWA (`employee-debts-app`). Deployed
separately from the owner's sales-tracker project — see `Daftra.gs`'s header comment for why.

## Testing

Real writes are only trustworthy if they're actually exercised against the real Daftra API and
the real Debts Snapshot sheet — mocks would miss exactly the kind of bug this project has hit
before (a Daftra payload silently missing a required field, a PUT resetting a field it wasn't
supposed to touch, a balance formula that's subtly wrong for some clients but not others).

### Designated test records

**Never point a test at a real client or debtor.** Two records exist specifically for this:

| Type | Identifier | Notes |
|---|---|---|
| Long (Daftra) | client **#630** | A real Daftra client with a zero current balance. Tests write to it and clean up after themselves (see below) — safe to run any number of times. |
| Short (Notebook) | **"TEST - ignore (ledger check)"** clientId `S-c35f8951-c7a4-423e-aa31-80c48c8fb818` | A dedicated sandbox row in the Debts Snapshot sheet. Its Amount Owed/Paid totals and its Short Debtor Transactions history grow with every test run — that's expected, not a bug. Never mark this one "paid" or delete it. |

### Running the smoke tests

`Tests.gs` defines `runSmokeTests(employeeName, employeePin)`, whitelisted in `Api.gs`. Run it
after every change to `Debts.gs`, `Daftra.gs`, or `Api.gs`, right after deploying:

```bash
curl -s -X POST '<the deployed web app URL — see js/api.js API_URL in employee-debts-app>' \
  -H 'Content-Type: text/plain' \
  -d '{"action":"runSmokeTests","params":["Owner","<pin>"]}'
```

Or from a browser/page already signed into the PWA:

```js
await apiCall("runSmokeTests", APP.employee.name, APP.employee.pin);
```

It returns `{ passed, total, results: [{ name, passed, error? }] }`. Anything short of
`passed === total` needs investigating before you consider the change safe.

What it covers:
- **Long debtor**: fetching the account statement; a payment create → edit → delete round-trip;
  an invoice create → edit → delete round-trip. Confirmed 2026-09-01 that Daftra's `api2` DELETE
  works for both `invoices.json` and `client_payments.json`, so these leave **zero trace** on
  client #630 — verified by diffing its statement before/after a run.
- **Short debtor**: fetching the transactions ledger; a debt-added + payment round-trip with the
  resulting Amount Owed/Amount Paid and the ledger's running-balance math checked directly; an
  `editShortDebt` no-op save (confirms the full-detail edit path doesn't throw).

### What it deliberately doesn't cover

- WhatsApp follow-up prompts, offline/IndexedDB sync, and anything else that's pure
  `employee-debts-app` client-side behavior — those need a real browser (see the main session's
  established pattern: `npx http-server` against `employee-debts-app` locally, or test directly
  against the deployed GitHub Pages app, always signing out of any leftover service worker/cache
  first — see `sw.js`'s header comment for that gotcha).
- Anything that needs a second employee PIN or role (view-only vs edit) — run those by hand.

### Adding a new check

Follow the existing pattern in `Tests.gs`: wrap the real API/Daftra call in `check(name, fn)`,
throw a descriptive `Error` on any mismatch, and if it's a Daftra write, make sure it either
targets client #630 with a delete afterward, or is a no-op / read-only call. Never add a check
that writes to a real client.
