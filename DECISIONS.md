# Decisions

A curated, reverse-chronological log of business/architecture decisions and confirmed incidents
for this repo — the "why," not the "what" (git log/diff already has the what, though see
`KNOWN_ISSUES.md` for why this repo's git log specifically should not be fully trusted for that).
Add a new entry in the **same commit** as the change that implements it, and deploy it in that
same sitting — see "Deploying" in `CLAUDE.md` for the hard rule this repo now has about that.

Each entry: date, decision, why, where it's enforced/relevant in code.

---

## 2026-09-05 — Financial writes must be online-only; no offline queueing (client-facing decision, API-side contract)

**Decision (owned by `employee-debts-app`, documented here because this API must uphold it):**
Employees' PWA financial writes — payments, invoices, any operation that creates or modifies a
Daftra financial transaction — must never be treated as successful before this API confirms them,
and must never be queued client-side for later retry. Full requirements are documented in
`employee-debts-app`'s `DECISIONS.md`; the parts that constrain this repo specifically:

- A write action's response must be the sole source of truth for success/failure — no action
  should return `success: true` before the real Daftra write has actually been confirmed.
- Every financial write action should return, or make trivially retrievable, the **authoritative**
  post-write balance — not require the client to make a second round-trip and definitely not
  leave the client to guess.
- Financial write actions need duplicate-submission protection (an idempotency/request-ID
  mechanism), specifically for the case where Daftra applies the write but the HTTP response is
  lost before reaching the employee's phone.

**Why:** See `employee-debts-app`'s `DECISIONS.md` (2026-09-05 entry) — correct balance needed
immediately for WhatsApp receipts, minimizing financial-data-loss risk, and immediate
success/failure feedback to the employee.

**Current compliance status (documented 2026-09-05, not yet implemented):**
- ✅ Already true: writes go to Daftra first, and a Daftra-side failure throws before anything
  reports success (`addLongDebtorPayment`, `addLongDebtorInvoice`, and their `edit*`
  counterparts in `Debts.gs`).
- ❌ **Gap**: none of these actions return the authoritative post-write balance in their
  response today — only `{ success, sheetUpdated, ... }`. The client currently has to make a
  separate `syncBundle` call afterward, and (per `employee-debts-app`'s `KNOWN_ISSUES.md`)
  currently doesn't even wait for that before building a WhatsApp message. Daftra's own
  `extra_details.client_balance` field (see `daftraEntryRunningBalance_()` in `Daftra.gs`,
  currently read-only/display-only) is a promising authoritative source to return directly,
  possibly cheaper than `getSingleClientBalance_()`'s full paginated re-scan.
- ❌ **Gap**: no idempotency/request-ID handling anywhere in this API. Needs research into
  whether Daftra's `invoices.json`/`client_payments.json` create endpoints accept any kind of
  client-supplied reference that could be checked before creating a duplicate, or whether this
  needs to be tracked in our own Sheet/Apps Script layer instead.
- N/A here, but noted for completeness: this API has no async job queue or outbox of its own —
  every action is a synchronous request/response. This decision doesn't require building one; it
  requires that one never gets built for financial writes specifically if async processing is
  ever added for something else.

---

## 2026-09-02 — Reverted client_payments.json double-counting in balance calculations

**Decision:** `getDaftraOutstandingDebts()`/`getSingleClientBalance_()` sum only invoices'
`summary_unpaid` — a separate full pass subtracting `client_payments.json` was removed.

**Why:** Confirmed directly against two real clients: client 209 had 19,549 in direct
`client_payments` against 6,907 in currently-open invoices; Daftra's own "Amount Due" was 6,907,
*not* netted against those payments — Daftra already applies a `client_payment` into the relevant
invoice's own `summary_unpaid` itself. The extra subtraction was double-counting that, silently
corrupting every Long debtor's balance for about a day, and in client 209's case hiding a real
6,907 SAR debt entirely (the double-subtracted amount went negative and got filtered out).

**How to apply:** Never re-add a separate `client_payments.json`-based subtraction to a balance
calculation here — `summary_unpaid` already reflects payments. If a balance still looks wrong for
a specific client, suspect a manual Journal Entry (see "needs reconciliation" below) before
suspecting this math again.

## 2026-08-30/31 — Daftra `PUT` is a full replace; edit functions must read-then-write

**Decision:** Every `edit*`/correction function (`editDaftraClientPayment_`,
`editDaftraDueInvoice_`, `editLongDebtorPayment`, `editLongDebtorInvoice`) reads the current
record first and carries every other field forward unchanged, changing only what's actually being
corrected.

**Why:** `daftraPut_` does a full replace, not a partial patch — any field left out of the payload
silently resets to a default rather than staying untouched. Confirmed 2026-08-31 while building
the invoice-edit path (comparing Daftra's own web edit form against both a full-record read and a
partial payload).

## 2026-08-31 — ZATCA e-invoicing: an already-submitted invoice can never be silently edited

**Decision:** `editDaftraDueInvoice_()` refuses to edit an invoice whose `e_invoice_status` is
already set — the caller must be told to record a Daftra credit note instead.

**Why:** Saudi e-invoicing (ZATCA) rules require a credit note for a correction after submission,
not a silent edit. This is a **legal/compliance constraint**, not a design preference — do not
relax or work around this check.

## 2026-08-29 — "Needs reconciliation" is a manual-only flag

**Decision:** `toggleReconciliationFlag()` is the only way a Long debtor gets flagged as possibly
out of sync — there is no automatic detection.

**Why:** A client's Daftra balance can move via a manual Journal Entry, which this API
deliberately does not account for — investigated: `journals.json` entries key off an internal
`journal_account_id`, not `client_id`, and this account has 40,000+ of them, making
cross-referencing impractical. This is a permanent architectural gap.

## 2026-09-01/02 — Short debtors: dedicated ledger, no duplicate event logging, stay active at zero balance

**Decision:** Short (Notebook) debtor money events (`addToShortDebt`, `recordDebtPayment`) get a
proper structured row in "Short Debtor Transactions" instead of only a free-text note in the Log
column, and reaching a zero balance no longer auto-closes the debtor to "paid."

**Why:** Owner's request — recording the same event as both a text note and a structured row
would just be a duplicate; a paid-off Short debtor disappearing from the Active list made it
harder to spot a repeat debtor and add new debt to their existing row. Marking fully paid stays a
separate, deliberate action (`setDebtStatus`).

## Short debtors are intended to be temporary; flagged as "aging" past `SHORT_DEBTOR_AGING_DAYS`

**Decision (confirmed from code, 2026-09-05):** A Short (Notebook) debtor is expected to close
within a short period, or be converted into a real Daftra invoice — not stay open indefinitely as
a notebook entry. `rowToDebt_()` (`Debts.gs`) computes `isAgingShort` as true once an
**active, still-owing** Short debtor has been open `daysSince_(dateGiven) >=
CONFIG.SHORT_DEBTOR_AGING_DAYS` days (`Config.gs`: `SHORT_DEBTOR_AGING_DAYS: 3`). This flag is
surfaced to the employee in `employee-debts-app` (`js/app.js`'s `debtCardHtml()`) as a visible
"Open *N*d — consider a Daftra invoice" nudge on the card.

**Why:** The in-code comment states this directly: Short Debtors "are meant to close within a
couple of days or get created as a real Daftra invoice" — flagging one that's lingered so it
doesn't just quietly sit in the sheet. A debtor already paid down to zero is deliberately excluded
from this flag (`amount - amountPaid > 0` is required) — see the 2026-09-01/02 entry above for why
a zero-balance Short debtor stays "active" rather than auto-closing.

**UNVERIFIED:** the exact date this rule/constant was decided or first deployed. `Config.gs`'s
`SHORT_DEBTOR_AGING_DAYS` and `rowToDebt_()`'s `isAgingShort` logic both first appear in git in
commit `4d77bde` (2026-09-02) — the same "bundled catch-up commit" described in `KNOWN_ISSUES.md`
that squashes together several changes actually made across the preceding ~9 days. The rule itself
(3-day threshold, "consider a Daftra invoice" nudge) is confirmed present and active in the current
code; only its precise origination date is not.

**How to apply:** Don't change the 3-day threshold or remove the nudge without checking — it's a
business rule about how Short debts are supposed to be used, not an arbitrary default.

## Long vs. Short: confirmed technical distinction; business circumstance is UNKNOWN / NEEDS OWNER CONFIRMATION

**Confirmed from code (2026-09-05) — the technical distinction only:**
- **Long** = a real Daftra client with a live balance, populated by `refreshDebtsSnapshot()`
  from Daftra itself (`CLAUDE.md`'s "Architecture" section).
- **Short** = "a debtor from the separate notebook that never becomes a Daftra invoice" —
  `addShortDebt()`'s own header comment — created and edited only through this API
  (`refreshDebtsSnapshot()` never touches these rows), uniquely identified by an `S-<uuid>` id.

**UNKNOWN / NEEDS OWNER CONFIRMATION:** *why* a given debt is entered as Short rather than created
as a real Daftra invoice (Long) in the first place — i.e. what business circumstance leads an
employee to choose one over the other at the moment a debt is created. No code comment, commit
message, or existing documentation in any of the three repos states this. The aging-flag nudge
above ("consider a Daftra invoice" once a Short debt has lingered) implies Short debts are meant
as an informal, short-lived stopgap that should *graduate* to a real Daftra invoice over time, but
that is an inference from later behavior, not a stated rule about the original decision — **do not
present it as a confirmed business reason**. If this matters for a future change, ask the owner
directly rather than guessing.

## Employee permission model: exactly two roles, no separate "owner" tier (confirmed from code, 2026-09-05)

**Confirmed from `Employees.gs`:**
- The shared `Employees` sheet has exactly four columns: Name | PIN | Role | Active.
- `authenticateEmployee(name, pin)` matches a row where `Active === true` and both name and PIN
  match (trimmed string equality) — there is no password hashing; this is a lightweight PIN check,
  not real authentication (stated directly in this file's own header comment: "anyone with edit
  access to the Sheet can see every PIN in plain text").
- The returned role collapses to exactly one of two values: `role: rowRole === "edit" ? "edit" :
  "view"` — **any** value in the Role column other than the literal string `"edit"` (blank,
  misspelled, anything else) becomes `"view"`. There is no third tier.
- `requireEditAccess_()` re-runs `authenticateEmployee()` and throws unless `role === "edit"` —
  every write-capable API action calls this before doing anything.
- `getEmployeeNames()` (used for the login dropdown and the Creditor picker) only returns rows
  where the Name is non-empty **and** `Active === true`.
- **"Owner" is not a distinct permission level anywhere in this code.** It is only ever the *name*
  of one particular employee row that happens to have `Role = "edit"`, same mechanism as any other
  edit-role employee — confirmed by reading `Employees.gs` in full; there is no code path that
  special-cases the string `"Owner"`. Do not invent owner-specific server-side logic based on the
  name alone.

**Client-side (`employee-debts-app/js/app.js`):** `APP.employee.role` is checked the same binary
way (`=== "edit"`) to gate UI affordances — confirmed at minimum for the "Add" button, the
Outstanding total, and the "Client account" payment/reconciliation controls; there may be
additional call sites not enumerated here since this list wasn't produced by an exhaustive
cross-reference of every UI element.

## 2026-08-25 → 2026-08-26 — Account statement changed from a 30-day window to record-count-based recency

**Decision (current):** `fetchDaftraRecentEntries_()` returns the last 2 pages of each Daftra list
endpoint (Daftra's lists are oldest-first, confirmed via `stock_transactions.json`), and
`getDaftraClientStatement()` slices to the 5 most recent entries overall — **not** a calendar-day
window.

**Why this note exists:** `employee-debts-app`'s commit `5c676e2` (2026-08-24) shipped and
described a **date-based 30-day window** for this feature — but the actual windowing logic
(`fetchDaftraRecentEntries_()`) lives here, in this repo's `Daftra.gs`, whose in-code comment says
the owner asked for record-count-based recency instead the very next day (2026-08-26). No commit
in either repo describes that follow-up change (confirmed via `git log` in both, 2026-09-05) — the
only surviving record is that in-code comment. **Do not trust `5c676e2`'s message as a description
of current behavior.**

**UNVERIFIED:** the exact mechanism and date by which the 2026-08-26 change reached production —
whether via `clasp push`/`clasp deploy` specifically or some other route — cannot be confirmed
from either repo alone. Contrast with commit `4d77bde` below, whose message *explicitly* confirms
a `clasp`-before-commit sequence — that one is directly evidenced; this one is inferred only from
the absence of a matching commit plus the in-code comment's date, and should be treated with
correspondingly less certainty. Both are still worth the same caution: treat any commit message
describing a tunable window/threshold with suspicion and verify against the actual current
code/comment.

## 2026-08-24 — Fixed pagination cap removed everywhere

**Decision:** No client/product/list lookup here uses a fixed page cap — `daftraPaginate_()` loops
until Daftra reports no more pages.

**Why:** A fixed cap previously hid real records once an account grew past it (the sibling
`pl-report-google-script-v2` project hit this concretely: a 5-page/500-record client-lookup cap
silently hid an active real debtor, client #27, once the account passed ~500 clients). Applied
here from the start given that confirmed incident.
