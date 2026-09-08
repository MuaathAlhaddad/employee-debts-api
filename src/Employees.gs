// ============================================================
// Employee accounts -- ported from the sales-tracker project's Debts.gs.
// Same "Employees" sheet, same lightweight PIN check (not real auth --
// anyone with edit access to the Sheet can see every PIN in plain text).
//
// ONE-TIME SETUP: this reads the SAME "Employees" sheet the sales-tracker
// app already uses (Name | PIN | Role | Active), so no separate roster is
// needed -- employees use the same name/PIN here as there.
// ============================================================

function getEmployeesSheet_() {
    const sheet = getSheet_().getSheetByName(CONFIG.SHEETS.EMPLOYEES);

    if (!sheet) {
        throw new Error(
            'No "Employees" sheet found. Ask the shop owner to open the Debts page in the main sales-tracker app once to create it.',
        );
    }

    return sheet;
}

function getEmployeeRows_() {
    const sheet = getEmployeesSheet_();
    const lastRow = sheet.getLastRow();

    if (lastRow <= 1) return [];

    return sheet.getRange(2, 1, lastRow - 1, 4).getValues();
}

function getEmployeeNames() {
    return getEmployeeRows_()
        .filter((row) => row[0] && row[3] === true)
        .map((row) => ({ name: String(row[0]) }));
}

// Role column now supports three values -- "owner", "edit", anything else
// (blank/misspelled) collapses to "view", same as before. "owner" was added
// 2026-09-08 for the Daftra Client -> Notebook Client migration workflow,
// which needs a real server-side tier above "edit" -- see DECISIONS.md's
// 2026-09-08 entry, which supersedes the 2026-09-05 decision that there was
// no such tier. Set the shop owner's row's Role to "owner" by hand in the
// Employees sheet for this to take effect -- it stays "edit" (or whatever
// it is today) until that's done, and nothing else changes for anyone else.
function authenticateEmployee(name, pin) {
    const rows = getEmployeeRows_();

    for (const row of rows) {
        const [rowName, rowPin, rowRole, active] = row;

        if (
            active === true &&
            String(rowName).trim() === String(name || "").trim() &&
            String(rowPin).trim() === String(pin || "").trim()
        ) {
            return {
                name: String(rowName).trim(),
                role: rowRole === "owner" ? "owner" : rowRole === "edit" ? "edit" : "view",
            };
        }
    }

    throw new Error("Name or PIN not recognized -- check with the shop owner.");
}

// "owner" is a superset of "edit" -- the Owner can do everything an
// edit-role employee can, plus the owner-only actions gated by
// requireOwnerAccess_() below.
function requireEditAccess_(employeeName, employeePin) {
    const employee = authenticateEmployee(employeeName, employeePin);

    if (employee.role !== "edit" && employee.role !== "owner") {
        throw new Error("You have view-only access and can't make changes.");
    }

    return employee;
}

// Owner-only gate -- for the Daftra Client -> Notebook Client migration
// workflow (Migrations.gs). Never gate a server-side action on the
// employee's NAME instead of this real role check (see the comment above
// authenticateEmployee for why that was deliberately rejected here).
function requireOwnerAccess_(employeeName, employeePin) {
    const employee = authenticateEmployee(employeeName, employeePin);

    if (employee.role !== "owner") {
        throw new Error("Only the shop owner can do that.");
    }

    return employee;
}
