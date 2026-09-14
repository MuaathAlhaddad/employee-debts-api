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
        SHORT_DEBTS_BACKUP: "Short Debtors Backup",
        SHORT_TRANSACTIONS: "Short Debtor Transactions",
        DEBTS_REVIEW: "Debts Review Log",
        PRODUCTS_CACHE: "Products Cache",
        PRODUCT_PRICE_CACHE: "Product Price Cache",
        // Daftra Client -> Notebook Client migration links (2026-09-08) --
        // see Migrations.gs.
        CLIENT_MIGRATIONS: "Client Migrations",
        // Notebook tags (2026-09-10) -- see Tags.gs. NOTEBOOK_TAGS is the
        // tag registry (id/name), NOTEBOOK_CLIENT_TAGS is the many-to-many
        // assignment sheet (client id / tag id), same "dedicated sheet for
        // a relation" pattern as CLIENT_MIGRATIONS/SHORT_TRANSACTIONS above
        // rather than a comma-separated/JSON blob on the Debts Snapshot row.
        NOTEBOOK_TAGS: "Notebook Tags",
        NOTEBOOK_CLIENT_TAGS: "Notebook Client Tags",
        // Daily Notebook backup status log (2026-09-13) -- see Backup.gs.
        // Append-only: one row per backup attempt, never edited/deleted, so
        // it's a full history of every run, not just today's.
        NOTEBOOK_BACKUP_STATUS: "Notebook Backup Status",
    },

    DEBT_STATUS: {
        ACTIVE: "active",
        PAID: "paid",
        DEAD: "dead",
    },

    // A Short Debtor open this many days without being closed or created
    // as a real Daftra invoice gets flagged in the app.
    SHORT_DEBTOR_AGING_DAYS: 3,

    // How long a cached product purchase-price lookup stays trusted before
    // it's treated as stale and re-fetched live -- see
    // getDaftraProductPurchaseHistoryCached_() in Daftra.gs.
    PRODUCT_PRICE_CACHE_MAX_AGE_DAYS: 7,

    // Daily Notebook (Short debtor) backup to Google Drive (2026-09-13) --
    // see Backup.gs. This is the SINGLE place the backup location/schedule
    // is configured; nothing below should be hardcoded again elsewhere.
    BACKUP: {
        // Folder path under Drive, created (once) on first run --
        // findOrCreateBackupFolder_() never creates a duplicate if it
        // already exists. Change this to move where future backups land;
        // it does not move backups that already exist.
        ROOT_FOLDER_NAME: "AlFajr",
        BACKUPS_FOLDER_NAME: "Notebook Backups",
        // Optional escape hatch: a Script Property (Project Settings ->
        // Script Properties) named BACKUP_PARENT_FOLDER_ID pointing at an
        // existing Drive folder ID (e.g. a Shared Drive folder) to root
        // ROOT_FOLDER_NAME under, instead of the script owner's My Drive
        // root. Leave unset to use My Drive.
        PARENT_FOLDER_ID_PROPERTY: "BACKUP_PARENT_FOLDER_ID",
        // Hour of day (0-23, script timezone -- see appsscript.json's
        // "timeZone") the daily trigger targets. setupDailyBackupTrigger()
        // reads this at setup time; changing it requires re-running that
        // function.
        TRIGGER_HOUR: 3,
        // Optional Script Property overriding who gets the failure email
        // (BACKUP_NOTIFY_EMAIL). Falls back to the script's own effective
        // user (whoever authorized/owns the trigger) if unset.
        NOTIFY_EMAIL_PROPERTY: "BACKUP_NOTIFY_EMAIL",
        BACKUP_VERSION: "1.0.0",
    },
};
