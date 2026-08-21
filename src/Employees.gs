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
                role: rowRole === "edit" ? "edit" : "view",
            };
        }
    }

    throw new Error("Name or PIN not recognized -- check with the shop owner.");
}

function requireEditAccess_(employeeName, employeePin) {
    const employee = authenticateEmployee(employeeName, employeePin);

    if (employee.role !== "edit") {
        throw new Error("You have view-only access and can't make changes.");
    }

    return employee;
}
