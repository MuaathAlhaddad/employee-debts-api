// ============================================================
// Debtors list -- reads/writes the "Debts Snapshot" sheet that
// refreshDebtsSnapshot() (in Daftra.gs) populates with live Daftra
// balances. Every call here re-checks the employee's PIN server-side, so
// a view-only employee can't just edit the app's JS to save changes.
//
// Ported from the sales-tracker project's Debts.gs -- see that file's
// header comment for background. Column layout is DEBTS_HEADERS in
// Daftra.gs.
// ============================================================

function getDebtsSheet_() {
    const sheet = getSheet_().getSheetByName(CONFIG.SHEETS.DEBTS);

    if (!sheet) {
        throw new Error(
            'No debts snapshot yet. Ask the shop owner to run "refreshDebtsSnapshot" once from this editor.',
        );
    }

    return sheet;
}

function todayStr_() {
    return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");
}

function formatDebtDateTime_(value) {
    if (!value) return "";

    return Utilities.formatDate(
        new Date(value),
        Session.getScriptTimeZone(),
        "dd/MM/yyyy HH:mm",
    );
}

// Due Date / Date Given / Last Follow Up are written as plain "yyyy-MM-dd"
// strings, but Sheets sometimes auto-converts a recognizable date string
// into a real Date cell depending on locale -- normalize either shape back
// to a plain string so round-tripping is predictable.
function normalizeDebtDate_(value) {
    if (!value) return "";
    if (value instanceof Date) {
        return Utilities.formatDate(value, Session.getScriptTimeZone(), "yyyy-MM-dd");
    }
    return String(value);
}

function daysSince_(dateStr) {
    if (!dateStr) return 0;
    const then = new Date(dateStr + "T00:00:00");
    const now = new Date(todayStr_() + "T00:00:00");
    return Math.round((now - then) / 86400000);
}

function rowToDebt_(row) {
    const type = row[2] || "Long";
    const dateGiven = normalizeDebtDate_(row[8]);
    const status = row[5] || CONFIG.DEBT_STATUS.ACTIVE;

    // Short Debtors are meant to close within a couple of days or get
    // created as a real Daftra invoice -- flag one that's lingered so it
    // doesn't just quietly sit in the sheet.
    const isAgingShort =
        type === "Short" &&
        status === CONFIG.DEBT_STATUS.ACTIVE &&
        daysSince_(dateGiven) >= CONFIG.SHORT_DEBTOR_AGING_DAYS;

    return {
        clientName: row[0],
        // Always a string -- Daftra client IDs come back as numbers from
        // Sheets, but the frontend compares clientId against values it
        // already holds as strings, so this keeps that consistent.
        clientId: String(row[1]),
        type,
        amount: Number(row[3]) || 0,
        amountPaid: Number(row[4]) || 0,
        status,
        // String() -- the Phone column is now formatted plain-text at the
        // source (refreshDebtsSnapshot() in Daftra.gs) to stop Sheets
        // auto-converting a numeric-looking phone into an actual number
        // and dropping leading zeros, but this stays as a second line of
        // defense for any row written before that fix.
        phone: String(row[6] || ""),
        dueDate: normalizeDebtDate_(row[7]),
        dateGiven,
        lastFollowUp: normalizeDebtDate_(row[9]),
        promiseCount: Number(row[10]) || 0,
        log: parseDebtLog_(row[11]),
        // Appended as the 14th column rather than inserted among the
        // others (2026-08-25) -- existing rows written before this field
        // existed just come back as "" here, same as any other blank cell.
        creditor: row[13] || "",
        // Owner-set marker (2026-08-29) -- our balance calc can't detect
        // a Daftra journal-entry adjustment, so this is a manual flag
        // instead, shown as a warning tag until cleared by hand.
        needsReconciliation: row[14] === true,
        isAgingShort,
    };
}

// Any logged-in employee (view or edit) can see the list. Splits into
// "long" (Daftra) and "short" (hand-entered notebook) debtors -- see the
// header comment in Daftra.gs for what distinguishes them. Includes
// paid/dead debtors too (the app's tabs need them) -- only the outstanding
// total excludes anything not "active".
function getDebtsList(employeeName, employeePin) {
    authenticateEmployee(employeeName, employeePin);

    const sheet = getDebtsSheet_();
    const lastRow = sheet.getLastRow();

    if (lastRow <= 1) {
        return { long: [], short: [], total: 0, todayStr: todayStr_(), snapshotTime: "" };
    }

    const rows = sheet.getRange(2, 1, lastRow - 1, DEBTS_HEADERS.length).getValues();

    const debts = rows
        .filter((row) => row[1] !== "" && row[1] != null)
        .map(rowToDebt_);

    const long = debts.filter((d) => d.type !== "Short").sort((a, b) => b.amount - a.amount);
    const short = debts.filter((d) => d.type === "Short").sort((a, b) => b.amount - a.amount);

    const outstanding = (d) => (d.status === CONFIG.DEBT_STATUS.ACTIVE ? d.amount - d.amountPaid : 0);
    const total = debts.reduce((sum, d) => sum + outstanding(d), 0);

    const snapshotTime = rows.length ? formatDebtDateTime_(rows[0][12]) : "";

    return { long, short, total, todayStr: todayStr_(), snapshotTime };
}

function findDebtRow_(sheet, clientId) {
    const lastRow = sheet.getLastRow();
    if (lastRow <= 1) return null;

    const ids = sheet.getRange(2, 2, lastRow - 1, 1).getValues();

    for (let i = 0; i < ids.length; i++) {
        if (String(ids[i][0]) === String(clientId)) return 2 + i;
    }

    return null;
}

function loadDebtRow_(sheet, clientId) {
    const row = findDebtRow_(sheet, clientId);

    if (!row) {
        throw new Error("That client isn't in the current debts snapshot -- try refreshing first.");
    }

    return { row, values: sheet.getRange(row, 1, 1, DEBTS_HEADERS.length).getValues()[0] };
}

function appendDebtLogEntry_(sheet, row, values, actor, note) {
    const log = parseDebtLog_(values[11]);

    log.push({
        id: Utilities.getUuid(),
        date: todayStr_(),
        time: new Date().toISOString(),
        actor,
        note,
    });

    sheet.getRange(row, 10).setValue(todayStr_()); // Last Follow Up
    sheet.getRange(row, 12).setValue(JSON.stringify(log)); // Log
}

// Stamps Last Follow Up (drives the "Today" chase-list filter) WITHOUT
// also writing a text note into the Log column -- used for Short debtor
// money events, which already get a proper structured row in Short
// Debtor Transactions (owner's request, 2026-09-01: don't record the
// same payment/debt-added event twice, once as free text here and once
// as a clean row there).
function touchLastFollowUp_(sheet, row) {
    sheet.getRange(row, 10).setValue(todayStr_());
}

// Logs a plain follow-up note ("chased today") without changing amount,
// status, or due date. Edit-role only.
function addDebtFollowUp(employeeName, employeePin, clientId, note) {
    const employee = requireEditAccess_(employeeName, employeePin);
    const sheet = getDebtsSheet_();
    const { row, values } = loadDebtRow_(sheet, clientId);

    appendDebtLogEntry_(sheet, row, values, employee.name, (note || "").trim() || "Followed up");

    return { success: true };
}

// Records a payment against the LOCAL tracking snapshot only (caps at
// what's owed, auto-marks "paid" once nothing's left). For Long Debtors,
// this is separate from -- and doesn't replace -- actually recording the
// payment in Daftra itself; see addLongDebtorPayment() below for that.
function recordDebtPayment(employeeName, employeePin, clientId, amount) {
    const employee = requireEditAccess_(employeeName, employeePin);
    const amt = Number(amount);

    if (!amt || amt <= 0) {
        throw new Error("Enter an amount greater than zero.");
    }

    const sheet = getDebtsSheet_();
    const { row, values } = loadDebtRow_(sheet, clientId);

    const owed = Number(values[3]) || 0;
    const paidSoFar = Number(values[4]) || 0;
    const remaining = owed - paidSoFar;
    const applied = Math.min(amt, remaining);
    const newPaid = paidSoFar + applied;
    const newRemaining = owed - newPaid;

    sheet.getRange(row, 5).setValue(newPaid); // Amount Paid

    if (newRemaining <= 0) {
        sheet.getRange(row, 6).setValue(CONFIG.DEBT_STATUS.PAID); // Status
    }

    // Short debtors get a proper structured row in Short Debtor
    // Transactions instead of a text note here -- recording the same
    // payment in both places would just be a duplicate (owner's request,
    // 2026-09-01). Still stamps Last Follow Up either way, since that's
    // what drives the "Today" chase-list filter regardless of type.
    if (values[2] === "Short") {
        touchLastFollowUp_(sheet, row);
        logShortTransaction_(clientId, values[0], "payment", -applied, newRemaining, employee.name, "");
    } else {
        appendDebtLogEntry_(sheet, row, values, employee.name, `Payment received: ${applied} (remaining ${newRemaining})`);
    }

    return { success: true };
}

// Pushes the due date out and records it as a "promise" -- edit-role only.
function rescheduleDebtDueDate(employeeName, employeePin, clientId, newDueDate) {
    const employee = requireEditAccess_(employeeName, employeePin);
    const nextDate = String(newDueDate || "").trim();

    if (!nextDate) {
        throw new Error("Pick a new due date.");
    }

    const sheet = getDebtsSheet_();
    const { row, values } = loadDebtRow_(sheet, clientId);

    const oldDate = normalizeDebtDate_(values[7]) || "no date set";
    const promiseCount = (Number(values[10]) || 0) + 1;

    sheet.getRange(row, 8).setValue(nextDate); // Due Date
    sheet.getRange(row, 11).setValue(promiseCount); // Promise Count

    appendDebtLogEntry_(
        sheet,
        row,
        values,
        employee.name,
        `Promised new date: ${nextDate} (was ${oldDate})`,
    );

    return { success: true };
}

// Marks a debtor fully paid, writes it off as dead debt, or reopens either
// one back to active. Edit-role only.
function setDebtStatus(employeeName, employeePin, clientId, status) {
    const employee = requireEditAccess_(employeeName, employeePin);
    const valid = [CONFIG.DEBT_STATUS.ACTIVE, CONFIG.DEBT_STATUS.PAID, CONFIG.DEBT_STATUS.DEAD];

    if (valid.indexOf(status) === -1) {
        throw new Error("Unknown debt status.");
    }

    const sheet = getDebtsSheet_();
    const { row, values } = loadDebtRow_(sheet, clientId);

    sheet.getRange(row, 6).setValue(status); // Status

    if (status === CONFIG.DEBT_STATUS.PAID) {
        sheet.getRange(row, 5).setValue(Number(values[3]) || 0); // Amount Paid = Amount Owed
    }

    const note =
        status === CONFIG.DEBT_STATUS.PAID
            ? "Marked fully paid"
            : status === CONFIG.DEBT_STATUS.DEAD
              ? "Written off as dead debt"
              : "Reopened";

    appendDebtLogEntry_(sheet, row, values, employee.name, note);

    return { success: true };
}

// Case-insensitive name match against existing Short rows that are
// already resolved (paid/dead) -- used by addShortDebt() so a repeat
// debtor gets their same record reopened instead of a disconnected new
// one, once they're back for a new debt (owner's request, 2026-08-25). An
// ACTIVE Short row with the same name is deliberately NOT matched here --
// that means they already have an open debt, which is worth a fresh row
// (or the employee's judgment) rather than silently merging balances.
function findResolvedShortDebtByName_(sheet, name) {
    const lastRow = sheet.getLastRow();
    if (lastRow <= 1) return null;

    const q = name.toLowerCase();
    const rows = sheet.getRange(2, 1, lastRow - 1, DEBTS_HEADERS.length).getValues();

    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const resolved = row[5] === CONFIG.DEBT_STATUS.PAID || row[5] === CONFIG.DEBT_STATUS.DEAD;

        if (row[2] === "Short" && resolved && String(row[0]).trim().toLowerCase() === q) {
            return { row: 2 + i, values: row };
        }
    }

    return null;
}

// Manually records a debtor from the separate notebook that never becomes
// a Daftra invoice -- edit-role only. Unlike Long Debtors, this is the
// ONLY way these rows get created or changed; refreshDebtsSnapshot() never
// touches them. If this name already has a paid-off/dead-debt Short row,
// that SAME row is reopened (same Client ID, full log history kept) rather
// than adding a new disconnected one -- otherwise a brand new row is
// created as before.
function addShortDebt(employeeName, employeePin, debtorName, amount, phone, dueDate, dateGiven, notes, creditor) {
    const employee = requireEditAccess_(employeeName, employeePin);

    const name = String(debtorName || "").trim();
    const value = Number(amount) || 0;

    if (!name) {
        throw new Error("Enter who owes this money.");
    }

    if (value <= 0) {
        throw new Error("Enter an amount greater than zero.");
    }

    const sheet = getDebtsSheet_();
    const now = new Date();
    const today = todayStr_();
    const given = String(dateGiven || "").trim() || today;
    const due = String(dueDate || "").trim();

    const existing = findResolvedShortDebtByName_(sheet, name);

    const openingNote =
        (existing ? "New debt recorded (repeat debtor)" : "Debt recorded") +
        (notes ? ` -- ${String(notes).trim()}` : "") +
        (due ? ` -- due ${due}` : "");

    if (existing) {
        const clientId = String(existing.values[1]);
        const log = parseDebtLog_(existing.values[11]);
        log.push({
            id: Utilities.getUuid(),
            date: today,
            time: now.toISOString(),
            actor: employee.name,
            note: openingNote,
        });

        sheet.getRange(existing.row, 1, 1, DEBTS_HEADERS.length).setValues([
            [
                name,
                clientId,
                "Short",
                value,
                0,
                CONFIG.DEBT_STATUS.ACTIVE,
                String(phone || "").trim() || existing.values[6] || "",
                due,
                given,
                today,
                0,
                JSON.stringify(log),
                now,
                String(creditor || "").trim() || existing.values[13] || "",
            ],
        ]);

        logShortTransaction_(clientId, name, "debt_added", value, value, employee.name, notes || "");

        return { success: true, clientId, reopened: true };
    }

    const clientId = "S-" + Utilities.getUuid();

    const log = [
        {
            id: Utilities.getUuid(),
            date: today,
            time: now.toISOString(),
            actor: employee.name,
            note: openingNote,
        },
    ];

    sheet.appendRow([
        name,
        clientId,
        "Short",
        value,
        0,
        CONFIG.DEBT_STATUS.ACTIVE,
        String(phone || "").trim(),
        due,
        given,
        "",
        0,
        JSON.stringify(log),
        now,
        String(creditor || "").trim(),
    ]);

    logShortTransaction_(clientId, name, "debt_added", value, value, employee.name, notes || "");

    return { success: true, clientId, reopened: false };
}

// Adds MORE debt to an EXISTING Short Debtor (the "Add invoice" button's
// local-tracking counterpart to addLongDebtorInvoice below) -- e.g. they
// borrow again while some/all of a previous debt is already on the books.
// Increases Amount Owed on their existing row rather than creating a new
// one, and reopens them if they'd been marked paid/dead. Edit-role only.
function addToShortDebt(employeeName, employeePin, clientId, amount, note, creditor) {
    const employee = requireEditAccess_(employeeName, employeePin);
    const amt = Number(amount);

    if (!amt || amt <= 0) {
        throw new Error("Enter an amount greater than zero.");
    }

    const sheet = getDebtsSheet_();
    const { row, values } = loadDebtRow_(sheet, clientId);

    if (values[2] !== "Short") {
        throw new Error("Add invoice only works this way for Short (notebook) debtors -- Long Debtors go through Daftra.");
    }

    const newOwed = (Number(values[3]) || 0) + amt;

    sheet.getRange(row, 4).setValue(newOwed); // Amount Owed
    sheet.getRange(row, 6).setValue(CONFIG.DEBT_STATUS.ACTIVE); // Status -- reopens if paid/dead

    // Lets the owner reassign who's responsible for this debt each time
    // more is added, not just at creation (owner's request, 2026-08-27).
    // Only overwrites when a value was actually picked -- an empty string
    // leaves whatever creditor was already on file untouched.
    if (creditor) sheet.getRange(row, 14).setValue(String(creditor).trim());

    // A proper structured row in Short Debtor Transactions instead of a
    // text note here too -- see recordDebtPayment()'s comment above.
    touchLastFollowUp_(sheet, row);
    logShortTransaction_(clientId, values[0], "debt_added", amt, newOwed - (Number(values[4]) || 0), employee.name, note || "");

    return { success: true };
}

// Directly overwrites a Short debtor's core fields -- unlike
// addToShortDebt() above (which only ever adds MORE debt on top of what's
// there), this corrects a mistake in what's already on the row: wrong
// name, wrong amount owed, wrong amount already paid, wrong phone, wrong
// dates, wrong creditor. Owner's request, 2026-08-30. Edit-role only.
//
// Short debtors have no per-transaction invoice/payment records (unlike
// Long debtors, which are real Daftra invoices/payments) -- just a
// running Amount Owed and Amount Paid on one row -- so "editing a mistyped
// invoice or payment amount" for a Short debtor means correcting one of
// these two totals directly, which is what amount/amountPaid do here.
function editShortDebt(employeeName, employeePin, clientId, debtorName, amount, amountPaid, phone, dueDate, dateGiven, creditor) {
    const employee = requireEditAccess_(employeeName, employeePin);

    const name = String(debtorName || "").trim();
    const owed = Number(amount);
    const paid = Number(amountPaid);

    if (!name) {
        throw new Error("Enter who owes this money.");
    }
    if (!Number.isFinite(owed) || owed <= 0) {
        throw new Error("Enter an amount owed greater than zero.");
    }
    if (!Number.isFinite(paid) || paid < 0) {
        throw new Error("Amount paid can't be negative.");
    }
    if (paid > owed) {
        throw new Error("Amount paid can't be more than the amount owed.");
    }

    const sheet = getDebtsSheet_();
    const { row, values } = loadDebtRow_(sheet, clientId);

    if (values[2] !== "Short") {
        throw new Error("Only Short (notebook) debtors can be edited directly -- Long Debtors go through Daftra.");
    }

    const oldName = values[0];
    const oldOwed = Number(values[3]) || 0;
    const oldPaid = Number(values[4]) || 0;
    const given = String(dateGiven || "").trim() || values[8] || "";
    const due = String(dueDate || "").trim();

    sheet.getRange(row, 1).setValue(name); // Client
    sheet.getRange(row, 4).setValue(owed); // Amount Owed
    sheet.getRange(row, 5).setValue(paid); // Amount Paid
    sheet.getRange(row, 7).setValue(String(phone || "").trim()); // Phone
    sheet.getRange(row, 8).setValue(due); // Due Date
    sheet.getRange(row, 9).setValue(given); // Date Given
    sheet.getRange(row, 14).setValue(String(creditor || "").trim()); // Creditor

    // A resolved (paid/dead) row that no longer nets to zero after the
    // edit is now genuinely open again -- same reopen convention
    // addToShortDebt() already uses.
    const currentStatus = values[5];
    const stillOwesSomething = owed - paid > 0;
    if (stillOwesSomething && currentStatus !== CONFIG.DEBT_STATUS.ACTIVE) {
        sheet.getRange(row, 6).setValue(CONFIG.DEBT_STATUS.ACTIVE);
    }

    const changes = [];
    if (oldName !== name) changes.push(`name "${oldName}" -> "${name}"`);
    if (oldOwed !== owed) changes.push(`amount owed ${oldOwed} -> ${owed}`);
    if (oldPaid !== paid) changes.push(`amount paid ${oldPaid} -> ${paid}`);

    appendDebtLogEntry_(
        sheet,
        row,
        values,
        employee.name,
        `Edited details${changes.length ? ": " + changes.join(", ") : " (no changes)"}`,
    );

    return { success: true };
}

// ============================================================
// Short Debtor Transactions -- a clean, one-row-per-event ledger, kept
// separate from the free-text log embedded in each Debts Snapshot row
// (owner's request, 2026-08-31: wanted Short debtors' "Client account"
// to read like Long debtors' real Daftra statement -- a bold amount plus
// the running balance right after it -- which isn't possible to
// reconstruct reliably from old free-text notes like "Payment received:
// 180 (remaining 0) -- fully paid"). Only records real money movements
// (debt added / payment received) -- edits, reopens, and status changes
// stay in the free-text log only, same as before, since they're
// corrections/bookkeeping rather than transactions. Starts empty --
// existing history before this sheet existed is NOT backfilled.
// ============================================================

const SHORT_TX_HEADERS = ["Date", "Time", "Client ID", "Client Name", "Type", "Amount", "Remaining", "Actor", "Note"];

function getShortTransactionsSheet_() {
    const ss = getSheet_();
    let sheet = ss.getSheetByName(CONFIG.SHEETS.SHORT_TRANSACTIONS);

    if (!sheet) {
        sheet = ss.insertSheet(CONFIG.SHEETS.SHORT_TRANSACTIONS);
        sheet.getRange(1, 1, 1, SHORT_TX_HEADERS.length).setValues([SHORT_TX_HEADERS]).setFontWeight("bold");
        sheet.setFrozenRows(1);
    }

    return sheet;
}

// amount is signed (+ debt added, - payment); remaining is the debtor's
// Amount Owed minus Amount Paid immediately after this event.
function logShortTransaction_(clientId, clientName, type, amount, remaining, actor, note) {
    const sheet = getShortTransactionsSheet_();
    const now = new Date();

    sheet.appendRow([todayStr_(), now.toISOString(), clientId, clientName, type, amount, remaining, actor, note || ""]);
}

// Any logged-in employee can view -- matches getLongDebtorAccount()'s
// access level (only the writes that create these rows are edit-gated).
function getShortDebtorTransactions(employeeName, employeePin, clientId) {
    authenticateEmployee(employeeName, employeePin);

    const sheet = getShortTransactionsSheet_();
    const lastRow = sheet.getLastRow();
    if (lastRow <= 1) return { entries: [] };

    const rows = sheet.getRange(2, 1, lastRow - 1, SHORT_TX_HEADERS.length).getValues();

    const entries = rows
        .filter((row) => String(row[2]) === String(clientId))
        .map((row) => ({
            id: null, // not individually editable -- these are local totals, not real Daftra records
            date: row[1] || row[0],
            type: row[4],
            description: (row[4] === "payment" ? "Payment received" : "Debt added") + (row[8] ? ` -- ${row[8]}` : ""),
            amount: Number(row[5]) || 0,
            remaining: row[6] === "" ? null : Number(row[6]),
        }))
        .sort((a, b) => new Date(b.date) - new Date(a.date))
        .slice(0, 5);

    return { entries };
}

// Edit-role employees only. Re-pulls live balances from Daftra -- can take
// a minute or two on an account with a lot of invoice history. Never
// touches Short Debtors. Also refreshes the Products Cache sheet (see
// refreshProductsCache() in Daftra.gs) so this one button keeps both the
// debtor snapshot and the product catalog that syncBundle() reads current.
function refreshDebtsFromApp(employeeName, employeePin) {
    requireEditAccess_(employeeName, employeePin);

    const debtsResult = refreshDebtsSnapshot();
    const productsResult = refreshProductsCache();

    return Object.assign({}, debtsResult, productsResult);
}

// ============================================================
// Long Debtor account -- statement + a real Daftra payment. Separate from
// the local tracking above: this talks to Daftra directly (see Daftra.gs),
// not the Debts Snapshot sheet.
// ============================================================

// Any logged-in employee can view a Long Debtor's account statement.
function getLongDebtorAccount(employeeName, employeePin, clientId) {
    authenticateEmployee(employeeName, employeePin);

    return getDaftraClientStatement(clientId);
}

// Manual "needs reconciliation" flag -- our balance calc has no way to
// detect a Daftra journal-entry adjustment (see getClientMetadata_()'s
// header comment in Daftra.gs for why that can't be automated), so this
// is a plain owner-set marker instead, toggled by hand and shown as a
// warning tag on the card until cleared. Edit-role only. Returns the new
// state so the app can update without a full resync.
function toggleReconciliationFlag(employeeName, employeePin, clientId) {
    const employee = requireEditAccess_(employeeName, employeePin);

    const sheet = getDebtsSheet_();
    const { row, values } = loadDebtRow_(sheet, clientId);

    const newState = values[14] !== true;
    sheet.getRange(row, 15).setValue(newState); // Needs Reconciliation

    appendDebtLogEntry_(
        sheet,
        row,
        values,
        employee.name,
        newState ? "Flagged: balance may not match Daftra (manual journal entry)" : "Reconciliation flag cleared",
    );

    return { success: true, needsReconciliation: newState };
}

// Records a real payment in Daftra against a Long Debtor's account --
// amount + an optional note, nothing else (kept to one field for speed on
// a phone). Edit-role only, since this is a real financial write.
function addLongDebtorPayment(employeeName, employeePin, clientId, amount, note) {
    const employee = requireEditAccess_(employeeName, employeePin);
    const amt = Number(amount);

    if (!amt || amt <= 0) {
        throw new Error("Enter an amount greater than zero.");
    }

    const result = addDaftraClientPayment(clientId, amt, note);

    // Also refresh this one client's balance and log it locally, so it
    // shows up in this debtor's follow-up history alongside notes/
    // reschedules and the card's balance is correct without waiting for
    // a full "Refresh from Daftra" -- same pattern addLongDebtorInvoice()
    // already uses. Confirmed 2026-08-28: this used to only log the
    // payment, never touch Amount Owed, so the card kept showing the
    // pre-payment balance until the next full refresh.
    // sheetUpdated is reported back to the app (owner's request,
    // 2026-08-28: a visible indicator for each sync target) -- this used
    // to fail completely silently, so a sheet-side problem here was
    // invisible even though the real Daftra write above had succeeded.
    let sheetUpdated = false;
    try {
        const sheet = getDebtsSheet_();
        const row = findDebtRow_(sheet, clientId);
        if (row) {
            const values = sheet.getRange(row, 1, 1, DEBTS_HEADERS.length).getValues()[0];
            sheet.getRange(row, 4).setValue(getSingleClientBalance_(clientId)); // Amount Owed
            appendDebtLogEntry_(
                sheet,
                row,
                values,
                employee.name,
                `Payment recorded in Daftra: ${amt}${note ? " -- " + note : ""}`,
            );
            sheetUpdated = true;
        }
    } catch (e) {
        // Not being in the snapshot yet shouldn't block the real Daftra
        // payment that already succeeded above -- sheetUpdated just stays
        // false so the app can say so.
    }

    return { success: true, daftraResponse: result, sheetUpdated };
}

// Corrects the amount on an existing Long Debtor payment in Daftra
// itself -- owner's request, 2026-08-31. Edit-role only, since this is a
// real financial write. paymentId comes from an entry in
// getLongDebtorAccount()'s statement list.
function editLongDebtorPayment(employeeName, employeePin, clientId, paymentId, newAmount) {
    const employee = requireEditAccess_(employeeName, employeePin);
    const amt = Number(newAmount);

    if (!amt || amt <= 0) {
        throw new Error("Enter an amount greater than zero.");
    }

    editDaftraClientPayment_(paymentId, clientId, amt);

    let sheetUpdated = false;
    try {
        const sheet = getDebtsSheet_();
        const row = findDebtRow_(sheet, clientId);
        if (row) {
            const values = sheet.getRange(row, 1, 1, DEBTS_HEADERS.length).getValues()[0];
            sheet.getRange(row, 4).setValue(getSingleClientBalance_(clientId)); // Amount Owed
            appendDebtLogEntry_(sheet, row, values, employee.name, `Payment #${paymentId} corrected to ${amt} in Daftra`);
            sheetUpdated = true;
        }
    } catch (e) {
        // Not being in the snapshot yet shouldn't block the real Daftra
        // edit that already succeeded above.
    }

    return { success: true, sheetUpdated };
}

// Creates a real Daftra due invoice against a Long Debtor's account (the
// Daftra-side counterpart to addToShortDebt above) -- amount + an
// optional note, matching addLongDebtorPayment's one-field-for-speed
// shape. Edit-role only, since this is a real financial write.
function addLongDebtorInvoice(employeeName, employeePin, clientId, amount, note) {
    const employee = requireEditAccess_(employeeName, employeePin);
    const amt = Number(amount);

    if (!amt || amt <= 0) {
        throw new Error("Enter an amount greater than zero.");
    }

    const result = createDaftraDueInvoice_(clientId, amt, note);

    // Refresh just this one client's balance rather than the whole sheet
    // -- refreshDebtsSnapshot() re-scans every invoice in the account,
    // too slow to run after a single new invoice. Also logged locally,
    // same as addLongDebtorPayment does. sheetUpdated is reported back to
    // the app (owner's request, 2026-08-28: a visible indicator for each
    // sync target) -- this used to fail completely silently, so a sheet
    // -side problem here was invisible even though the real Daftra write
    // above had already succeeded.
    let sheetUpdated = false;
    try {
        const sheet = getDebtsSheet_();
        const row = findDebtRow_(sheet, clientId);
        if (row) {
            const values = sheet.getRange(row, 1, 1, DEBTS_HEADERS.length).getValues()[0];
            sheet.getRange(row, 4).setValue(getSingleClientBalance_(clientId)); // Amount Owed
            appendDebtLogEntry_(
                sheet,
                row,
                values,
                employee.name,
                `New invoice added in Daftra: ${amt}${note ? " -- " + note : ""}`,
            );
            sheetUpdated = true;
        }
    } catch (e) {
        // Not being in the snapshot yet shouldn't block the real Daftra
        // invoice that already succeeded above -- sheetUpdated just stays
        // false so the app can say so.
    }

    return { success: true, invoiceId: result.id, invoiceNo: result.no, sheetUpdated };
}

// Corrects the amount on an existing Long Debtor invoice in Daftra
// itself -- owner's request, 2026-08-31. Edit-role only, since this is a
// real financial write. Only works for the simple single-line "due
// invoice" shape this app creates -- see editDaftraDueInvoice_()'s
// comment for why (and the ZATCA e-invoicing guard). invoiceId comes
// from an entry in getLongDebtorAccount()'s statement list.
function editLongDebtorInvoice(employeeName, employeePin, clientId, invoiceId, newAmount) {
    const employee = requireEditAccess_(employeeName, employeePin);
    const amt = Number(newAmount);

    if (!amt || amt <= 0) {
        throw new Error("Enter an amount greater than zero.");
    }

    editDaftraDueInvoice_(invoiceId, clientId, amt);

    let sheetUpdated = false;
    try {
        const sheet = getDebtsSheet_();
        const row = findDebtRow_(sheet, clientId);
        if (row) {
            const values = sheet.getRange(row, 1, 1, DEBTS_HEADERS.length).getValues()[0];
            sheet.getRange(row, 4).setValue(getSingleClientBalance_(clientId)); // Amount Owed
            appendDebtLogEntry_(sheet, row, values, employee.name, `Invoice #${invoiceId} corrected to ${amt} in Daftra`);
            sheetUpdated = true;
        }
    } catch (e) {
        // Not being in the snapshot yet shouldn't block the real Daftra
        // edit that already succeeded above.
    }

    return { success: true, sheetUpdated };
}

// ============================================================
// Owner-style review checklist -- lets whoever's checking up on the team
// tick off which follow-up log entries they've already seen, without
// deleting or hiding them. Available to any edit-role employee for now.
// ============================================================

function getDebtsReviewSheet_() {
    const ss = getSheet_();
    let sheet = ss.getSheetByName(CONFIG.SHEETS.DEBTS_REVIEW);

    if (!sheet) {
        sheet = ss.insertSheet(CONFIG.SHEETS.DEBTS_REVIEW);
        sheet
            .getRange(1, 1, 1, 3)
            .setValues([["Entry ID", "Reviewed By", "Reviewed At"]])
            .setFontWeight("bold");
        sheet.setFrozenRows(1);
    }

    return sheet;
}

// Returns { entryId: { by, at } } for every log entry marked reviewed.
function getDebtsReviewLog(employeeName, employeePin) {
    authenticateEmployee(employeeName, employeePin);

    const sheet = getDebtsReviewSheet_();
    const lastRow = sheet.getLastRow();

    if (lastRow <= 1) return {};

    const rows = sheet.getRange(2, 1, lastRow - 1, 3).getValues();
    const result = {};

    rows.forEach((row) => {
        if (!row[0]) return;
        result[row[0]] = { by: row[1], at: formatDebtDateTime_(row[2]) };
    });

    return result;
}

// Toggles one log entry's reviewed state. Edit-role only.
function toggleDebtReviewEntry(employeeName, employeePin, entryId) {
    const employee = requireEditAccess_(employeeName, employeePin);
    const sheet = getDebtsReviewSheet_();
    const lastRow = sheet.getLastRow();

    if (lastRow > 1) {
        const ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();

        for (let i = 0; i < ids.length; i++) {
            if (String(ids[i][0]) === String(entryId)) {
                sheet.deleteRow(2 + i);
                return { reviewed: false };
            }
        }
    }

    sheet.appendRow([entryId, employee.name, new Date()]);
    return { reviewed: true };
}
