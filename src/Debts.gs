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
        phone: row[6] || "",
        dueDate: normalizeDebtDate_(row[7]),
        dateGiven,
        lastFollowUp: normalizeDebtDate_(row[9]),
        promiseCount: Number(row[10]) || 0,
        log: parseDebtLog_(row[11]),
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

    let note = `Payment received: ${applied} (remaining ${newRemaining})`;

    if (newRemaining <= 0) {
        sheet.getRange(row, 6).setValue(CONFIG.DEBT_STATUS.PAID); // Status
        note += " -- fully paid";
    }

    appendDebtLogEntry_(sheet, row, values, employee.name, note);

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

// Manually records a debtor from the separate notebook that never becomes
// a Daftra invoice -- edit-role only. Unlike Long Debtors, this is the
// ONLY way these rows get created or changed; refreshDebtsSnapshot() never
// touches them.
function addShortDebt(employeeName, employeePin, debtorName, amount, phone, dueDate, dateGiven, notes) {
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
    const clientId = "S-" + Utilities.getUuid();
    const given = String(dateGiven || "").trim() || today;
    const due = String(dueDate || "").trim();

    const openingNote =
        "Debt recorded" +
        (notes ? ` -- ${String(notes).trim()}` : "") +
        (due ? ` -- due ${due}` : "");

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
    ]);

    return { success: true, clientId };
}

// Edit-role employees only. Re-pulls live balances from Daftra -- can take
// a minute or two on an account with a lot of invoice history. Never
// touches Short Debtors.
function refreshDebtsFromApp(employeeName, employeePin) {
    requireEditAccess_(employeeName, employeePin);

    return refreshDebtsSnapshot();
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

    // Also log it locally so it shows up in this debtor's follow-up
    // history alongside notes/reschedules, if they're tracked as a Long
    // Debtor in the snapshot sheet too.
    try {
        const sheet = getDebtsSheet_();
        const row = findDebtRow_(sheet, clientId);
        if (row) {
            const values = sheet.getRange(row, 1, 1, DEBTS_HEADERS.length).getValues()[0];
            appendDebtLogEntry_(
                sheet,
                row,
                values,
                employee.name,
                `Payment recorded in Daftra: ${amt}${note ? " -- " + note : ""}`,
            );
        }
    } catch (e) {
        // Not being in the snapshot yet shouldn't block the real Daftra
        // payment that already succeeded above.
    }

    return { success: true, daftraResponse: result };
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
