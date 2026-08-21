// This is a standalone Apps Script project (not bound to the Sheet) so it
// can be deployed completely separately from the owner's sales-tracker web
// app -- see the plan doc for why (page-size ceiling in the other project's
// HtmlService sandbox, and employees shouldn't see the sales/dashboard
// tabs at all). It reaches the same Sheet by ID instead.
const SHEET_ID = "1-_38hOkQ6TAHmgjSuII8E1mMbs8ZjoXZVyHpB-wNQeg";

function getSheet_() {
    return SpreadsheetApp.openById(SHEET_ID);
}

const CONFIG = {
    SHEETS: {
        EMPLOYEES: "Employees",
        DEBTS: "Debts Snapshot",
        DEBTS_REVIEW: "Debts Review Log",
    },

    DEBT_STATUS: {
        ACTIVE: "active",
        PAID: "paid",
        DEAD: "dead",
    },

    // A Short Debtor open this many days without being closed or created
    // as a real Daftra invoice gets flagged in the app.
    SHORT_DEBTOR_AGING_DAYS: 3,
};
