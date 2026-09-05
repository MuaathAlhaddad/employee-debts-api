# Employee Debts API

Standalone Apps Script backend for the Employee Debts PWA (`employee-debts-app`). Deployed
separately from the owner's sales-tracker project (`pl-report-google-script-v2`) — see
`Daftra.gs`'s header comment for why.

It's a pure JSON API with no UI of its own: `Api.gs` routes whitelisted actions
(`API_ACTIONS`), `Daftra.gs` talks to the shop's Daftra account, `Debts.gs`/`Employees.gs`/
`Products.gs` read and write the shared Google Sheet, and `SyncBundle.gs` assembles the PWA's
one-call sync payload.

**For anything beyond this short orientation — running/deploying commands, architecture detail,
the testing procedure, business decisions, and open issues — see:**
- [`CLAUDE.md`](CLAUDE.md) — the authoritative developer/instruction reference for this repo
  (commands, deployment, architecture, and the full testing procedure).
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — how this repo fits into the larger three-project system.
- [`DECISIONS.md`](DECISIONS.md) — dated business/architecture decisions and confirmed incidents.
- [`KNOWN_ISSUES.md`](KNOWN_ISSUES.md) — open bugs, gaps, and process notes.

## Testing, in one paragraph

Correctness here is checked by running real writes against two **designated test records** —
never a real client or debtor — and confirming `runSmokeTests(employeeName, employeePin)`
(`Tests.gs`) returns `passed === total`. See `CLAUDE.md`'s "Testing" section for the exact test
record identifiers, the command to run it, what it covers, and the pattern for adding a new check
— that section is the single source of truth for this procedure; this file intentionally doesn't
repeat it, to avoid the two drifting apart.
