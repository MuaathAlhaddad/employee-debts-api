// ============================================================
// Daftra Client -> Notebook Client migration workflow -- Owner-only
// (2026-09-08). Lets the Owner move a client's debt tracking from a real
// Daftra client (a "Long" debtor) to a hand-entered Notebook client (a
// "Short" debtor, same mechanism addShortDebt() in Debts.gs already
// creates), then formally disable the original Daftra client once the new
// one's been verified. Deliberately a two-step, non-atomic workflow -- see
// each function's header comment for why.
//
// "Client Migrations" sheet is the persistent link between the two clients
// AND doubles as this feature's audit trail (every field the feature spec
// asked to log lives on one row here): Daftra Client ID/Name, Notebook
// Client ID/Name, Status ("pending" until disabled, "completed" after),
// Created At/By, Disabled At/By, the balance actually cleared, the Daftra
// client's new name, and the Daftra payment id that cleared it.
// ============================================================

const MIGRATION_HEADERS = [
    "Daftra Client ID",
    "Daftra Client Name",
    "Notebook Client ID",
    "Notebook Client Name",
    "Status",
    "Created At",
    "Created By",
    "Disabled At",
    "Disabled By",
    "Original Balance",
    "New Daftra Name",
    "Daftra Payment ID",
];

function getClientMigrationsSheet_() {
    const ss = getSheet_();
    let sheet = ss.getSheetByName(CONFIG.SHEETS.CLIENT_MIGRATIONS);

    if (!sheet) {
        sheet = ss.insertSheet(CONFIG.SHEETS.CLIENT_MIGRATIONS);
        sheet.getRange(1, 1, 1, MIGRATION_HEADERS.length).setValues([MIGRATION_HEADERS]).setFontWeight("bold");
        sheet.setFrozenRows(1);
    }

    return sheet;
}

function findClientMigrationRow_(sheet, daftraClientId) {
    const lastRow = sheet.getLastRow();
    if (lastRow <= 1) return null;

    const ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();

    for (let i = 0; i < ids.length; i++) {
        if (String(ids[i][0]) === String(daftraClientId)) {
            return { row: 2 + i, values: sheet.getRange(2 + i, 1, 1, MIGRATION_HEADERS.length).getValues()[0] };
        }
    }

    return null;
}

// Used by getDebtsList() (Debts.gs) to attach migration state to every Long
// debtor's card without a second round trip from the app. Keyed by Daftra
// Client ID; only ever non-null for Long debtors.
function getClientMigrationsMap_() {
    const sheet = getClientMigrationsSheet_();
    const lastRow = sheet.getLastRow();
    if (lastRow <= 1) return {};

    const rows = sheet.getRange(2, 1, lastRow - 1, MIGRATION_HEADERS.length).getValues();
    const map = {};

    rows.forEach((row) => {
        if (row[0] === "" || row[0] == null) return;
        map[String(row[0])] = {
            notebookClientId: row[2],
            notebookClientName: row[3],
            status: row[4],
        };
    });

    return map;
}

// ============================================================
// Step 1 -- Convert to Notebook Client. Owner-only.
// ============================================================

// Creates a new Notebook (Short) debtor seeded from the Daftra client's
// name AND current balance, and records a persistent link between the two
// so a repeat click can't create a duplicate (feature spec #6). Starting
// balance IS carried over -- owner's explicit request, 2026-09-09,
// overriding this feature's original spec (which said not to copy it) --
// logged as a real "debt_added" Short Debtor Transaction so the Notebook
// client's own account statement shows where the opening balance came
// from, not just an unexplained non-zero number.
//
// Never touches the original Daftra client -- it stays a fully active Long
// debtor until disableDaftraClient() below is run separately, after the
// Owner has verified this new Notebook client is correct (feature spec #1:
// never auto-disable).
function convertDaftraClientToNotebook(employeeName, employeePin, daftraClientId) {
    const employee = requireOwnerAccess_(employeeName, employeePin);

    const debtsSheet = getDebtsSheet_();
    const { values: daftraRow } = loadDebtRow_(debtsSheet, daftraClientId);

    if (daftraRow[2] === "Short") {
        throw new Error("That's already a Notebook (Short) debtor, not a Daftra client.");
    }

    const daftraClientName = daftraRow[0];
    const migrationsSheet = getClientMigrationsSheet_();
    const existing = findClientMigrationRow_(migrationsSheet, daftraClientId);

    if (existing) {
        // Duplicate-conversion guard -- return the existing link instead of
        // creating a second Notebook client.
        return {
            success: true,
            alreadyExists: true,
            notebookClientId: existing.values[2],
            notebookClientName: existing.values[3],
            status: existing.values[4],
        };
    }

    const notebookClientId = "S-" + Utilities.getUuid();
    const now = new Date();
    const today = todayStr_();
    // Amount Paid always stays 0 for a Long/Daftra debtor (Daftra's
    // summary_unpaid is already net of payments -- see DEBTS_HEADERS'
    // comment in Daftra.gs), so daftraRow[3] alone is the full remaining
    // balance to carry over.
    const openingBalance = Number(daftraRow[3]) || 0;

    const log = [
        {
            id: Utilities.getUuid(),
            date: today,
            time: now.toISOString(),
            actor: employee.name,
            note: `Created from Daftra client #${daftraClientId} ("${daftraClientName}") via Convert to Notebook Client -- opening balance ${openingBalance} carried over.`,
        },
    ];

    // Appended directly rather than via addShortDebt() -- that function
    // does name-based reopen matching, which doesn't fit this "bootstrap a
    // fresh client" case (this is keyed off the Daftra Migrations link, not
    // a name match). Same row shape/columns as addShortDebt writes, though,
    // so it displays and behaves identically to any other Notebook client
    // from here on.
    debtsSheet.appendRow([
        daftraClientName,
        notebookClientId,
        "Short",
        openingBalance, // Amount Owed -- carried over from the Daftra client
        0, // Amount Paid
        CONFIG.DEBT_STATUS.ACTIVE,
        String(daftraRow[6] || ""), // Phone -- carried over, same person
        "", // Due Date
        today, // Date Given
        "", // Last Follow Up
        0, // Promise Count
        JSON.stringify(log),
        now, // Snapshot Time
        "", // Creditor
    ]);

    // Structured Short Debtor Transactions row, same as any other new debt
    // (addShortDebt) -- otherwise the Notebook client's own "Client
    // account" statement would show a non-zero balance with no
    // transaction explaining it.
    if (openingBalance > 0) {
        logShortTransaction_(
            notebookClientId,
            daftraClientName,
            "debt_added",
            openingBalance,
            openingBalance,
            employee.name,
            `Migrated from Daftra client #${daftraClientId}`,
        );
    }

    migrationsSheet.appendRow([
        daftraClientId,
        daftraClientName,
        notebookClientId,
        daftraClientName,
        "pending",
        now,
        employee.name,
        "", // Disabled At
        "", // Disabled By
        openingBalance, // Original Balance -- also the Notebook client's carried-over opening balance
        "", // New Daftra Name
        "", // Daftra Payment ID
    ]);

    return { success: true, alreadyExists: false, notebookClientId, notebookClientName: daftraClientName };
}

// ============================================================
// Step 2 -- Disable Daftra Client. Owner-only. Only runs once a matching
// Notebook client already exists (created above) and the Owner has
// verified it.
// ============================================================

// Order of operations matters here (feature spec #11/#12):
//   1. Re-check the LIVE Daftra balance (not the last snapshot) and, if
//      anything is still outstanding, clear it the same way "Add Payment"
//      already does elsewhere in this app -- addDaftraClientPayment(), a
//      real, auditable Daftra client_payment for the full amount. This is
//      the only balance-clearing mechanism that exists anywhere in this
//      codebase (see Daftra.gs's header comment on client balances) --
//      there is no write-off/credit-note API implemented or verified here.
//      Recording it this way means Daftra's books show a real payment, not
//      a silently zeroed field -- confirmed acceptable 2026-09-08 (the
//      alternative -- leaving this unimplemented -- was explicitly not
//      chosen). This step throws, stopping everything below, if Daftra
//      doesn't confirm the payment.
//   2. Only once that's confirmed does the rename+suspend PUT
//      (daftraDisableClient_, Daftra.gs) run.
//   3. Only once THAT's confirmed does the migration get marked
//      "completed" and the local Debts Snapshot row updated.
// Retry-safe by construction: step 1 always re-reads the LIVE balance, so
// a retry after a partial failure (e.g. the payment succeeded but the
// rename PUT then failed/timed out) sees balance 0 next time and skips
// straight to the rename/suspend step instead of double-paying (feature
// spec #13).
function disableDaftraClient(employeeName, employeePin, daftraClientId, newDaftraName) {
    const employee = requireOwnerAccess_(employeeName, employeePin);

    const newName = String(newDaftraName || "").trim();
    if (!newName) {
        throw new Error("Enter a new name for the Daftra client before disabling it.");
    }

    const migrationsSheet = getClientMigrationsSheet_();
    const migration = findClientMigrationRow_(migrationsSheet, daftraClientId);

    if (!migration) {
        throw new Error("No Notebook client migration found for this Daftra client -- convert it first.");
    }

    if (migration.values[4] === "completed") {
        // Already done -- idempotent no-op, protects a retried/double-
        // clicked request from re-running the operation (feature spec #13).
        return {
            success: true,
            alreadyCompleted: true,
            notebookClientId: migration.values[2],
            notebookClientName: migration.values[3],
        };
    }

    const debtsSheet = getDebtsSheet_();
    const { row: daftraRow, values: daftraValues } = loadDebtRow_(debtsSheet, daftraClientId);

    const liveBalance = getSingleClientBalance_(daftraClientId);
    let paymentId = "";

    if (liveBalance > 0) {
        const payment = addDaftraClientPayment(
            daftraClientId,
            liveBalance,
            `Balance cleared -- migrated to Notebook client ${migration.values[2]}`,
        );
        paymentId = (payment && payment.id) || "";
    }

    // Only reached once the balance is confirmed clear (or was already
    // zero) -- a Daftra failure above throws before this point, so the
    // client is never renamed/disabled with an unconfirmed balance
    // (feature spec #12).
    daftraDisableClient_(daftraClientId, newName);

    // Local Sheet update -- mirrors the single-row-refresh pattern
    // addLongDebtorPayment/addLongDebtorInvoice already use (Debts.gs), so
    // the card doesn't show stale data until the next full "Refresh from
    // Daftra" (which will also naturally drop this client from the Long
    // list entirely from here on -- getDaftraOutstandingDebts already
    // filters out suspended clients, see Daftra.gs's getClientMetadata_).
    debtsSheet.getRange(daftraRow, 1).setValue(newName); // Client
    debtsSheet.getRange(daftraRow, 4).setValue(0); // Amount Owed
    debtsSheet.getRange(daftraRow, 6).setValue(CONFIG.DEBT_STATUS.DEAD); // Status
    appendDebtLogEntry_(
        debtsSheet,
        daftraRow,
        daftraValues,
        employee.name,
        `Disabled -- migrated to Notebook client ${migration.values[2]}, balance cleared (${liveBalance}), renamed to "${newName}".`,
    );

    const now = new Date();
    migrationsSheet
        .getRange(migration.row, 5, 1, 8)
        .setValues([["completed", migration.values[5], migration.values[6], now, employee.name, liveBalance, newName, paymentId]]);

    return {
        success: true,
        alreadyCompleted: false,
        clearedBalance: liveBalance,
        paymentId,
        notebookClientId: migration.values[2],
        notebookClientName: migration.values[3],
    };
}
