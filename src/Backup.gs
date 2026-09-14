// ============================================================
// Daily Notebook (Short debtor) backup to Google Drive (2026-09-13) --
// disaster recovery only. See DECISIONS.md's matching entry for why this
// exists and ARCHITECTURE.md for the full design writeup.
//
// SCOPE: "Notebook" here means exactly what the rest of this codebase calls
// a Short debtor (Type === "Short" on a Debts Snapshot row) -- see
// Daftra.gs's header comment on DEBTS_HEADERS for the Long/Short
// distinction. Long (Daftra) debtors are NOT backed up here: Daftra itself
// is their authoritative, independently-backed-up system of record (see
// DECISIONS.md). The Employees sheet is also deliberately excluded -- it
// holds plaintext PINs, a secret, and isn't needed to reconstruct Notebook
// data (every backed-up row already carries the acting employee's NAME,
// not their PIN).
//
// This process is READ-ONLY with respect to every financial record. It
// never writes to Debts Snapshot, Short Debtor Transactions, Notebook
// Tags/Client Tags, Client Migrations, or Daftra -- only to a brand new
// Drive folder tree and its own dedicated "Notebook Backup Status" sheet.
//
// Six files per successful daily backup, written into
// <ROOT_FOLDER_NAME>/<BACKUPS_FOLDER_NAME>/YYYY/YYYY-MM/YYYY-MM-DD/
// (CONFIG.BACKUP -- Config.gs -- is the single place that path is
// configured):
//   customers.json        -- every Notebook (Short) client row, INCLUDING
//                             soft-deleted ones (deletedAt/deletedBy kept).
//   transactions.json     -- every Short Debtor Transactions row, ALL of
//                             them (unlike getShortDebtorTransactions()'s
//                             API, which is filtered to one client and
//                             capped at 5 -- this reads the sheet directly,
//                             uncapped, including soft-deleted rows).
//   tags.json              -- full Notebook Tags registry.
//   tag_assignments.json   -- full Notebook Client Tags assignment table.
//   migrations.json         -- full Client Migrations sheet (explains a
//                             migrated Notebook client's opening balance).
//   review_log.json        -- full Debts Review Log (small; shared with
//                             Long debtors too, but directly documents
//                             which Notebook log entries were reviewed).
//   metadata.json           -- backup_version, created_at, source
//                             spreadsheet id, record counts, financial
//                             totals, and a SHA-256 checksum per file --
//                             the thing a restore should verify against
//                             before trusting the other six files.
// ============================================================

// Plain literal, NOT read from CONFIG at top level -- Apps Script
// concatenates .gs files in filename order when evaluating top-level
// statements ("Backup.gs" sorts before "Config.gs"), so a top-level const
// here that read CONFIG.* directly would see it before Config.gs has run.
// CONFIG.BACKUP.BACKUP_VERSION is read lazily instead, inside
// buildNotebookBackupPayload_() below, where that ordering doesn't matter.
const NOTEBOOK_BACKUP_SYSTEM_VERSION = "employee-debts-api@1.0.0";

const NOTEBOOK_BACKUP_STATUS_HEADERS = [
    "Date",
    "Started At",
    "Completed At",
    "Status", // "success" | "failed" | "skipped"
    "Customer Count",
    "Transaction Count",
    "Tag Count",
    "Assignment Count",
    "Migration Count",
    "Review Log Count",
    "Backup Folder URL",
    "Error",
];

// ============================================================
// Small shared helpers
// ============================================================

// Dates are stored as real Date objects in several sheets (Snapshot Time,
// Deleted At, Created At, ...) and as plain "yyyy-MM-dd" strings in others
// (Date Given, Due Date, ...) -- normalize whichever comes back from
// getValues() into an ISO string (Dates) or pass plain strings through
// unchanged, so every backup file is plain, formula-independent JSON.
function backupDateToIso_(value) {
    if (!value) return "";
    if (value instanceof Date) return value.toISOString();
    return String(value);
}

function sha256Hex_(text) {
    const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8);
    return bytes.map((b) => ((b < 0 ? b + 256 : b) | 0).toString(16).padStart(2, "0")).join("");
}

// ============================================================
// Data extraction -- reads sheets DIRECTLY (never through getDebtsList()/
// getShortDebtorTransactions(), both of which filter out soft-deleted rows
// and the latter also caps at 5 entries per client -- neither is
// acceptable for a disaster-recovery backup, which must be complete).
// Every reader here is read-only: getRange()/getValues() only, never a
// write call.
// ============================================================

function getNotebookCustomersForBackup_() {
    const sheet = getDebtsSheet_();
    const lastRow = sheet.getLastRow();
    if (lastRow <= 1) return [];

    const rows = sheet.getRange(2, 1, lastRow - 1, DEBTS_HEADERS.length).getValues();

    return rows
        .filter((row) => row[1] !== "" && row[1] != null && row[2] === "Short")
        .map((row) => ({
            clientName: row[0],
            clientId: String(row[1]),
            amountOwed: Number(row[3]) || 0,
            amountPaid: Number(row[4]) || 0,
            status: row[5] || CONFIG.DEBT_STATUS.ACTIVE,
            phone: String(row[6] || ""),
            dueDate: normalizeDebtDate_(row[7]),
            dateGiven: normalizeDebtDate_(row[8]),
            lastFollowUp: normalizeDebtDate_(row[9]),
            promiseCount: Number(row[10]) || 0,
            // Parsed into a real array (not left as a JSON-in-a-cell
            // string) so this backup file is self-describing without
            // needing a second JSON.parse to be useful.
            log: parseDebtLog_(row[11]),
            snapshotTime: backupDateToIso_(row[12]),
            creditor: row[13] || "",
            needsReconciliation: row[14] === true,
            deletedAt: backupDateToIso_(row[15]),
            deletedBy: row[16] || "",
        }));
}

function getNotebookTransactionsForBackup_() {
    const sheet = getShortTransactionsSheet_();
    const lastRow = sheet.getLastRow();
    if (lastRow <= 1) return [];

    const rows = sheet.getRange(2, 1, lastRow - 1, SHORT_TX_HEADERS.length).getValues();

    return rows
        .filter((row) => row[2] !== "" && row[2] != null)
        .map((row) => ({
            id: row[9] || "",
            date: row[0] || "",
            time: row[1] || "",
            clientId: String(row[2]),
            clientName: row[3],
            type: row[4], // "debt_added" | "payment"
            // Signed: positive = debt added, negative = payment applied --
            // preserved exactly as recorded, not re-derived.
            amount: Number(row[5]) || 0,
            remaining: row[6] === "" ? null : Number(row[6]),
            actor: row[7],
            note: row[8] || "",
            deletedAt: backupDateToIso_(row[10]),
            deletedBy: row[11] || "",
        }));
}

function getNotebookTagsForBackup_() {
    const sheet = getNotebookTagsSheet_();
    const lastRow = sheet.getLastRow();
    if (lastRow <= 1) return [];

    const rows = sheet.getRange(2, 1, lastRow - 1, NOTEBOOK_TAG_HEADERS.length).getValues();

    return rows
        .filter((row) => row[0] !== "" && row[0] != null)
        .map((row) => ({
            id: String(row[0]),
            name: String(row[1] || ""),
            createdAt: backupDateToIso_(row[2]),
            createdBy: row[3] || "",
        }));
}

function getNotebookTagAssignmentsForBackup_() {
    const sheet = getNotebookClientTagsSheet_();
    const lastRow = sheet.getLastRow();
    if (lastRow <= 1) return [];

    const rows = sheet.getRange(2, 1, lastRow - 1, NOTEBOOK_CLIENT_TAG_HEADERS.length).getValues();

    return rows
        .filter((row) => row[0] !== "" && row[0] != null)
        .map((row) => ({
            clientId: String(row[0]),
            tagId: String(row[1]),
            assignedAt: backupDateToIso_(row[2]),
            assignedBy: row[3] || "",
        }));
}

function getClientMigrationsForBackup_() {
    const sheet = getClientMigrationsSheet_();
    const lastRow = sheet.getLastRow();
    if (lastRow <= 1) return [];

    const rows = sheet.getRange(2, 1, lastRow - 1, MIGRATION_HEADERS.length).getValues();

    return rows
        .filter((row) => row[0] !== "" && row[0] != null)
        .map((row) => ({
            daftraClientId: String(row[0]),
            daftraClientName: row[1],
            notebookClientId: String(row[2]),
            notebookClientName: row[3],
            status: row[4],
            createdAt: backupDateToIso_(row[5]),
            createdBy: row[6] || "",
            disabledAt: backupDateToIso_(row[7]),
            disabledBy: row[8] || "",
            originalBalance: Number(row[9]) || 0,
            newDaftraName: row[10] || "",
            daftraPaymentId: row[11] || "",
        }));
}

function getDebtsReviewLogForBackup_() {
    const sheet = getDebtsReviewSheet_();
    const lastRow = sheet.getLastRow();
    if (lastRow <= 1) return [];

    const rows = sheet.getRange(2, 1, lastRow - 1, 3).getValues();

    return rows
        .filter((row) => row[0] !== "" && row[0] != null)
        .map((row) => ({
            entryId: row[0],
            reviewedBy: row[1] || "",
            reviewedAt: backupDateToIso_(row[2]),
        }));
}

// ============================================================
// Drive folder helpers -- find-or-create at every level, never blind
// create, so re-running never produces a duplicate folder.
// ============================================================

function findOrCreateFolder_(parent, name) {
    const existing = parent.getFoldersByName(name);
    if (existing.hasNext()) return existing.next();
    return parent.createFolder(name);
}

function getBackupDriveRoot_() {
    const parentId = PropertiesService.getScriptProperties().getProperty(CONFIG.BACKUP.PARENT_FOLDER_ID_PROPERTY);
    return parentId ? DriveApp.getFolderById(parentId) : DriveApp.getRootFolder();
}

// Returns the Drive folder for one calendar day, creating the whole
// AlFajr/Notebook Backups/YYYY/YYYY-MM/YYYY-MM-DD chain if any part of it
// doesn't exist yet. Safe to call any number of times for the same date --
// findOrCreateFolder_() never creates a sibling duplicate.
function getOrCreateNotebookBackupDayFolder_(dateStr) {
    const [year, month] = dateStr.split("-");
    const root = getBackupDriveRoot_();

    const appFolder = findOrCreateFolder_(root, CONFIG.BACKUP.ROOT_FOLDER_NAME);
    const backupsFolder = findOrCreateFolder_(appFolder, CONFIG.BACKUP.BACKUPS_FOLDER_NAME);
    const yearFolder = findOrCreateFolder_(backupsFolder, year);
    const monthFolder = findOrCreateFolder_(yearFolder, `${year}-${month}`);
    return findOrCreateFolder_(monthFolder, dateStr);
}

// Only SEARCHES for a day's folder -- never creates one. Used by restore,
// which must fail loudly if a requested backup date doesn't exist rather
// than silently creating an empty folder that looks like a real one.
function findNotebookBackupDayFolder_(dateStr) {
    const [year, month] = dateStr.split("-");
    const root = getBackupDriveRoot_();

    const findChild_ = (parent, name) => {
        const it = parent.getFoldersByName(name);
        return it.hasNext() ? it.next() : null;
    };

    const appFolder = findChild_(root, CONFIG.BACKUP.ROOT_FOLDER_NAME);
    const backupsFolder = appFolder && findChild_(appFolder, CONFIG.BACKUP.BACKUPS_FOLDER_NAME);
    const yearFolder = backupsFolder && findChild_(backupsFolder, year);
    const monthFolder = yearFolder && findChild_(yearFolder, `${year}-${month}`);
    return monthFolder && findChild_(monthFolder, dateStr);
}

// Replaces (never appends to) a same-named file in this folder -- the old
// copy is moved to Drive trash (recoverable for ~30 days), not permanently
// deleted, and a brand new file is created with the full content in one
// call rather than incrementally patched. Only ever called for a date that
// does NOT already have a successful backup recorded (see
// runNotebookBackup()'s guard) -- a valid previous day's files are never
// touched by this at all, since each day gets its own folder.
function writeBackupFile_(folder, name, content) {
    const existing = folder.getFilesByName(name);
    while (existing.hasNext()) {
        existing.next().setTrashed(true);
    }
    return folder.createFile(name, content, "application/json");
}

// ============================================================
// Status log -- append-only, one row per attempt (success, failed, or
// skipped-because-already-done-today). Never edited or deleted, so it
// doubles as a full history of every backup run, not just today's.
// ============================================================

function getNotebookBackupStatusSheet_() {
    const ss = getSheet_();
    let sheet = ss.getSheetByName(CONFIG.SHEETS.NOTEBOOK_BACKUP_STATUS);

    if (!sheet) {
        sheet = ss.insertSheet(CONFIG.SHEETS.NOTEBOOK_BACKUP_STATUS);
        sheet
            .getRange(1, 1, 1, NOTEBOOK_BACKUP_STATUS_HEADERS.length)
            .setValues([NOTEBOOK_BACKUP_STATUS_HEADERS])
            .setFontWeight("bold");
        sheet.setFrozenRows(1);
        // Force the Date column (A) to plain text -- same fix Daftra.gs
        // already applies to the Phone column, for the same reason: Sheets
        // auto-converts a "yyyy-MM-dd"-looking string into a real Date cell
        // on write, which would silently break hasSuccessfulBackupToday_()'s
        // string comparison (see that function's own comment). Applied to a
        // generous row range up front, before any date is ever written.
        sheet.getRange(2, 1, 5000, 1).setNumberFormat("@");
    }

    return sheet;
}

function appendBackupStatusRow_(row) {
    getNotebookBackupStatusSheet_().appendRow([
        row.date,
        row.startedAt,
        row.completedAt || "",
        row.status,
        row.customerCount != null ? row.customerCount : "",
        row.transactionCount != null ? row.transactionCount : "",
        row.tagCount != null ? row.tagCount : "",
        row.assignmentCount != null ? row.assignmentCount : "",
        row.migrationCount != null ? row.migrationCount : "",
        row.reviewLogCount != null ? row.reviewLogCount : "",
        row.folderUrl || "",
        row.error || "",
    ]);
}

// True if a SUCCESSFUL backup has already been recorded for this date --
// the single check that makes re-running the trigger (or a manual backup)
// on the same day a safe no-op instead of a duplicate/overwrite risk.
function hasSuccessfulBackupToday_(dateStr) {
    const sheet = getNotebookBackupStatusSheet_();
    const lastRow = sheet.getLastRow();
    if (lastRow <= 1) return false;

    const rows = sheet.getRange(2, 1, lastRow - 1, NOTEBOOK_BACKUP_STATUS_HEADERS.length).getValues();
    // normalizeDebtDate_() (Debts.gs), not String() -- Sheets can silently
    // auto-convert a plain "yyyy-MM-dd" string into a real Date cell
    // depending on locale (the exact same class of bug DEBTS_HEADERS' date
    // columns already had to work around), which would make a raw string
    // comparison against dateStr fail even for today's own row and defeat
    // this whole guard. Confirmed live, 2026-09-13: without this, a second
    // same-day run re-ran the full backup instead of skipping.
    return rows.some((row) => normalizeDebtDate_(row[0]) === dateStr && row[3] === "success");
}

// Most recent N attempts, newest first -- backs getNotebookBackupStatus()
// (the owner-only API action) so "did today's backup succeed" is a single
// call away instead of requiring the owner to open the Sheet.
function getRecentNotebookBackupStatus_(limit) {
    const sheet = getNotebookBackupStatusSheet_();
    const lastRow = sheet.getLastRow();
    if (lastRow <= 1) return [];

    const n = Math.min(limit || 14, lastRow - 1);
    const startRow = lastRow - n + 1;
    const rows = sheet.getRange(startRow, 1, n, NOTEBOOK_BACKUP_STATUS_HEADERS.length).getValues();

    return rows
        .map((row) => ({
            date: normalizeDebtDate_(row[0]),
            startedAt: backupDateToIso_(row[1]),
            completedAt: backupDateToIso_(row[2]),
            status: row[3],
            customerCount: row[4],
            transactionCount: row[5],
            tagCount: row[6],
            assignmentCount: row[7],
            migrationCount: row[8],
            reviewLogCount: row[9],
            folderUrl: row[10],
            error: row[11],
        }))
        .reverse();
}

// ============================================================
// Failure visibility -- emailed to the script owner (or an explicit
// override) so a failed backup is never silent. Never includes any
// secret/credential; only counts, the date, and the error message.
// ============================================================

function notifyNotebookBackupFailure_(dateStr, error) {
    const overrideEmail = PropertiesService.getScriptProperties().getProperty(CONFIG.BACKUP.NOTIFY_EMAIL_PROPERTY);
    const email = overrideEmail || Session.getEffectiveUser().getEmail();

    if (!email) return; // Nothing we can do without an address -- status sheet/logs still have the failure.

    try {
        MailApp.sendEmail({
            to: email,
            subject: `Notebook backup FAILED -- ${dateStr}`,
            body:
                `The daily Notebook (Short debtor) backup failed for ${dateStr}.\n\n` +
                `Error: ${(error && error.message) || String(error)}\n\n` +
                `The previous successful backup (if any) was NOT touched or deleted -- this only ` +
                `affects today's backup attempt. See the "Notebook Backup Status" sheet for the full ` +
                `attempt history, and Apps Script's own execution log (Executions, in the editor) for ` +
                `the full stack trace.\n\n` +
                `Tomorrow's scheduled backup will still run normally.`,
        });
    } catch (mailErr) {
        // A failed notification must never mask the original backup failure --
        // it's already recorded in the status sheet regardless of whether this
        // email goes out.
        Logger.log(`notifyNotebookBackupFailure_: failed to send email -- ${mailErr.message || mailErr}`);
    }
}

// ============================================================
// The backup itself.
// ============================================================

function buildNotebookBackupPayload_() {
    const customers = getNotebookCustomersForBackup_();
    const transactions = getNotebookTransactionsForBackup_();
    const tags = getNotebookTagsForBackup_();
    const tagAssignments = getNotebookTagAssignmentsForBackup_();
    const migrations = getClientMigrationsForBackup_();
    const reviewLog = getDebtsReviewLogForBackup_();

    const activeCustomers = customers.filter((c) => !c.deletedAt && c.status === CONFIG.DEBT_STATUS.ACTIVE);
    const totalAmountOwedActive = activeCustomers.reduce((sum, c) => sum + c.amountOwed, 0);
    const totalAmountPaidActive = activeCustomers.reduce((sum, c) => sum + c.amountPaid, 0);

    const liveTransactions = transactions.filter((t) => !t.deletedAt);
    const totalDebtAddedAmount = liveTransactions.filter((t) => t.type === "debt_added").reduce((sum, t) => sum + t.amount, 0);
    const totalPaymentAmount = liveTransactions.filter((t) => t.type === "payment").reduce((sum, t) => sum - t.amount, 0); // payment amounts are stored negative

    return {
        customers,
        transactions,
        tags,
        tagAssignments,
        migrations,
        reviewLog,
        totals: {
            customerCount: customers.length,
            activeCustomerCount: activeCustomers.length,
            deletedCustomerCount: customers.filter((c) => c.deletedAt).length,
            totalAmountOwedActive,
            totalAmountPaidActive,
            totalOutstandingActive: totalAmountOwedActive - totalAmountPaidActive,
            transactionCount: transactions.length,
            deletedTransactionCount: transactions.filter((t) => t.deletedAt).length,
            totalDebtAddedAmount,
            totalPaymentAmount,
        },
    };
}

// The one function a daily trigger (or a manual run) should call. Returns
// { skipped: true, ... } if today already has a successful backup;
// otherwise builds, writes, and validates a fresh one, recording the
// outcome either way in "Notebook Backup Status". Throws on failure (after
// logging it) so both the trigger's own failure email and this function's
// explicit one fire -- never swallows an error silently.
function runNotebookBackup() {
    const date = todayStr_();
    const startedAt = new Date();

    if (hasSuccessfulBackupToday_(date)) {
        Logger.log(`runNotebookBackup: ${date} already has a successful backup -- skipping (no Drive access made).`);
        return { skipped: true, date };
    }

    try {
        const payload = buildNotebookBackupPayload_();

        const files = {
            "customers.json": JSON.stringify(payload.customers, null, 2),
            "transactions.json": JSON.stringify(payload.transactions, null, 2),
            "tags.json": JSON.stringify(payload.tags, null, 2),
            "tag_assignments.json": JSON.stringify(payload.tagAssignments, null, 2),
            "migrations.json": JSON.stringify(payload.migrations, null, 2),
            "review_log.json": JSON.stringify(payload.reviewLog, null, 2),
        };

        const checksums = {};
        Object.keys(files).forEach((name) => {
            checksums[name] = sha256Hex_(files[name]);
        });

        const metadata = {
            backup_version: CONFIG.BACKUP.BACKUP_VERSION,
            system_version: NOTEBOOK_BACKUP_SYSTEM_VERSION,
            created_at: startedAt.toISOString(),
            source_spreadsheet_id: SHEET_ID,
            record_counts: {
                customers: payload.customers.length,
                transactions: payload.transactions.length,
                tags: payload.tags.length,
                tag_assignments: payload.tagAssignments.length,
                migrations: payload.migrations.length,
                review_log: payload.reviewLog.length,
            },
            totals: payload.totals,
            checksum: {
                algorithm: "SHA-256",
                per_file: checksums,
                combined: sha256Hex_(Object.keys(checksums).sort().map((k) => `${k}:${checksums[k]}`).join("|")),
            },
        };

        files["metadata.json"] = JSON.stringify(metadata, null, 2);

        const folder = getOrCreateNotebookBackupDayFolder_(date);

        Object.keys(files).forEach((name) => {
            writeBackupFile_(folder, name, files[name]);
        });

        // Validate by reading back what Drive actually stored -- catches a
        // truncated/corrupted write, not just a bug in the code that built
        // the in-memory payload (which this can't detect, since it would
        // reproduce the same bug on read-back too).
        const validationErrors = [];

        Object.keys(files).forEach((name) => {
            const found = folder.getFilesByName(name);
            if (!found.hasNext()) {
                validationErrors.push(`${name}: file missing after write`);
                return;
            }
            const stored = found.next().getBlob().getDataAsString();
            const expectedChecksum = name === "metadata.json" ? sha256Hex_(files[name]) : checksums[name];
            const actualChecksum = sha256Hex_(stored);
            if (actualChecksum !== expectedChecksum) {
                validationErrors.push(`${name}: checksum mismatch after write (expected ${expectedChecksum}, got ${actualChecksum})`);
                return;
            }
            if (name !== "metadata.json") {
                let parsed;
                try {
                    parsed = JSON.parse(stored);
                } catch (e) {
                    validationErrors.push(`${name}: stored content isn't valid JSON`);
                    return;
                }
                if (!Array.isArray(parsed)) {
                    validationErrors.push(`${name}: expected a JSON array`);
                }
            }
        });

        if (validationErrors.length > 0) {
            throw new Error(`Backup validation failed: ${validationErrors.join("; ")}`);
        }

        const completedAt = new Date();
        const folderUrl = folder.getUrl();

        appendBackupStatusRow_({
            date,
            startedAt,
            completedAt,
            status: "success",
            customerCount: metadata.record_counts.customers,
            transactionCount: metadata.record_counts.transactions,
            tagCount: metadata.record_counts.tags,
            assignmentCount: metadata.record_counts.tag_assignments,
            migrationCount: metadata.record_counts.migrations,
            reviewLogCount: metadata.record_counts.review_log,
            folderUrl,
        });

        Logger.log(
            `runNotebookBackup: success for ${date} -- ${metadata.record_counts.customers} customers, ` +
                `${metadata.record_counts.transactions} transactions -- ${folderUrl}`,
        );

        return { skipped: false, date, folderUrl, recordCounts: metadata.record_counts, totals: metadata.totals };
    } catch (err) {
        const message = err && err.message ? err.message : String(err);

        appendBackupStatusRow_({
            date,
            startedAt,
            completedAt: new Date(),
            status: "failed",
            error: message,
        });

        Logger.log(`runNotebookBackup: FAILED for ${date} -- ${message}`);
        notifyNotebookBackupFailure_(date, err);

        // Rethrown deliberately -- a trigger-invoked failure should also
        // trigger Apps Script's own built-in execution-failure email as a
        // second, independent notification channel; a caller through the
        // API (runNotebookBackupNow) sees it as a normal doPost() error.
        throw err;
    }
}

// Trigger entry point -- ScriptApp.newTrigger() needs a bare, no-argument
// global function name to call. Kept as a thin wrapper (rather than
// pointing the trigger at runNotebookBackup directly) so the trigger's
// target function name is stable even if runNotebookBackup()'s own
// signature ever needs to change.
function runNotebookBackupTrigger() {
    runNotebookBackup();
}

// ============================================================
// Daily trigger setup -- safe to run any number of times. Always removes
// every existing trigger pointed at runNotebookBackupTrigger first, so
// re-running this (e.g. after changing CONFIG.BACKUP.TRIGGER_HOUR, or
// during a redeploy) can never leave two triggers both firing the same
// day's backup.
// ============================================================

function setupDailyBackupTrigger() {
    const existing = ScriptApp.getProjectTriggers().filter((t) => t.getHandlerFunction() === "runNotebookBackupTrigger");
    existing.forEach((t) => ScriptApp.deleteTrigger(t));

    ScriptApp.newTrigger("runNotebookBackupTrigger").timeBased().atHour(CONFIG.BACKUP.TRIGGER_HOUR).everyDays(1).create();

    const message =
        `Removed ${existing.length} existing trigger(s); created 1 new daily trigger targeting ` +
        `~${CONFIG.BACKUP.TRIGGER_HOUR}:00 (script timezone). Run listBackupTriggers_() to confirm.`;
    Logger.log(message);
    return message;
}

// Run from the editor at any time to confirm exactly one trigger exists
// and see when it's next expected to fire (Apps Script doesn't expose an
// exact "next run" time via API, only the configured hour).
function listBackupTriggers_() {
    const triggers = ScriptApp.getProjectTriggers()
        .filter((t) => t.getHandlerFunction() === "runNotebookBackupTrigger")
        .map((t) => ({ id: t.getUniqueId(), eventType: String(t.getEventType()) }));

    Logger.log(JSON.stringify(triggers, null, 2));
    return triggers;
}

// ============================================================
// Restore -- deliberately NEVER writes into the production spreadsheet
// (SHEET_ID). Reads a given day's backup files back from Drive and writes
// them into a BRAND NEW spreadsheet this function creates itself, purely
// for verification (counts/balances/history match) or as the starting
// point for a manual, deliberate rebuild -- see ARCHITECTURE.md's
// "Restoration procedure" for the full manual steps around this. Not
// exposed via the HTTP API on purpose -- run from the Apps Script editor
// only (function dropdown -> restoreNotebookBackupToNewSpreadsheet_ ->
// set the date below -> Run), so it can never be triggered remotely.
// ============================================================

function restoreNotebookBackupToNewSpreadsheet_(dateStr) {
    const folder = findNotebookBackupDayFolder_(dateStr);
    if (!folder) {
        throw new Error(`No backup folder found for ${dateStr} -- check the date and CONFIG.BACKUP folder settings.`);
    }

    const readJsonFile_ = (name) => {
        const found = folder.getFilesByName(name);
        if (!found.hasNext()) throw new Error(`${name} is missing from the ${dateStr} backup folder.`);
        return found.next().getBlob().getDataAsString();
    };

    const metadata = JSON.parse(readJsonFile_("metadata.json"));
    const fileNames = ["customers.json", "transactions.json", "tags.json", "tag_assignments.json", "migrations.json", "review_log.json"];

    const contents = {};
    const checksumErrors = [];
    fileNames.forEach((name) => {
        const content = readJsonFile_(name);
        const expected = metadata.checksum && metadata.checksum.per_file && metadata.checksum.per_file[name];
        const actual = sha256Hex_(content);
        if (expected && expected !== actual) {
            checksumErrors.push(`${name}: checksum mismatch (expected ${expected}, got ${actual}) -- file may be corrupted or hand-edited.`);
        }
        contents[name] = JSON.parse(content);
    });

    if (checksumErrors.length > 0) {
        throw new Error(`Refusing to restore -- integrity check failed: ${checksumErrors.join("; ")}`);
    }

    const ss = SpreadsheetApp.create(`Notebook Restore Test -- ${dateStr} -- ${Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd HHmmss")}`);

    const writeSheet_ = (name, rows) => {
        const sheet = ss.insertSheet(name);
        if (rows.length === 0) return sheet;
        const headers = Object.keys(rows[0]);
        const values = rows.map((row) =>
            headers.map((h) => (row[h] === null ? "" : typeof row[h] === "object" ? JSON.stringify(row[h]) : row[h])),
        );
        sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight("bold");
        sheet.getRange(2, 1, values.length, headers.length).setValues(values);
        sheet.setFrozenRows(1);
        return sheet;
    };

    writeSheet_("Customers", contents["customers.json"]);
    writeSheet_("Transactions", contents["transactions.json"]);
    writeSheet_("Tags", contents["tags.json"]);
    writeSheet_("Tag Assignments", contents["tag_assignments.json"]);
    writeSheet_("Migrations", contents["migrations.json"]);
    writeSheet_("Review Log", contents["review_log.json"]);
    // Apps Script creates every new spreadsheet with one default "Sheet1" --
    // remove it now that the real tabs above exist, purely for tidiness.
    const defaultSheet = ss.getSheetByName("Sheet1");
    if (defaultSheet) ss.deleteSheet(defaultSheet);

    const result = {
        spreadsheetUrl: ss.getUrl(),
        metadata,
        restoredCounts: {
            customers: contents["customers.json"].length,
            transactions: contents["transactions.json"].length,
            tags: contents["tags.json"].length,
            tagAssignments: contents["tag_assignments.json"].length,
            migrations: contents["migrations.json"].length,
            reviewLog: contents["review_log.json"].length,
        },
    };

    Logger.log(JSON.stringify(result, null, 2));
    return result;
}

// ============================================================
// Owner-only, whitelisted API actions (Api.gs). Both are read-only with
// respect to Notebook/Daftra financial data -- runNotebookBackupNow only
// ever writes to the Drive backup folder and the status sheet, same as
// the trigger.
// ============================================================

// Lets the owner check "did today's backup succeed" from a phone/curl
// without opening the Sheet or the Apps Script editor.
function getNotebookBackupStatus(employeeName, employeePin, limit) {
    requireOwnerAccess_(employeeName, employeePin);
    return getRecentNotebookBackupStatus_(limit);
}

// Manual on-demand backup -- e.g. right after a schema change, or to
// verify the whole pipeline works before trusting the daily trigger.
// Shares every safety property of the trigger path (skips if today's
// already succeeded, validates before recording success, notifies on
// failure) because it calls the exact same function.
function runNotebookBackupNow(employeeName, employeePin) {
    requireOwnerAccess_(employeeName, employeePin);
    return runNotebookBackup();
}
