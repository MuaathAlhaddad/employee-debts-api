// ============================================================
// Notebook tags (2026-09-10) -- reusable tags/categories for Notebook
// (Short) debtor clients. Two dedicated sheets, same "one sheet per
// relation" pattern as Client Migrations / Short Debtor Transactions in
// this codebase, not a comma-separated or JSON-blob column on the Debts
// Snapshot row:
//   - "Notebook Tags"        -- the tag registry (id, name).
//   - "Notebook Client Tags" -- the many-to-many assignment: one row per
//                                (client id, tag id) pair.
//
// Access level mirrors the rest of this app's convention: viewing/
// filtering is open to any logged-in employee (view or edit role);
// creating, renaming, assigning, and removing a tag all require edit
// access (requireEditAccess_ -- "owner" included, since it's a superset).
// This feature is NOT owner-only, unlike Notebook deletion.
// ============================================================

const NOTEBOOK_TAG_HEADERS = ["ID", "Name", "Created At", "Created By"];
const NOTEBOOK_CLIENT_TAG_HEADERS = ["Client ID", "Tag ID", "Assigned At", "Assigned By"];

function getNotebookTagsSheet_() {
    const ss = getSheet_();
    let sheet = ss.getSheetByName(CONFIG.SHEETS.NOTEBOOK_TAGS);

    if (!sheet) {
        sheet = ss.insertSheet(CONFIG.SHEETS.NOTEBOOK_TAGS);
        sheet.getRange(1, 1, 1, NOTEBOOK_TAG_HEADERS.length).setValues([NOTEBOOK_TAG_HEADERS]).setFontWeight("bold");
        sheet.setFrozenRows(1);
    }

    return sheet;
}

function getNotebookClientTagsSheet_() {
    const ss = getSheet_();
    let sheet = ss.getSheetByName(CONFIG.SHEETS.NOTEBOOK_CLIENT_TAGS);

    if (!sheet) {
        sheet = ss.insertSheet(CONFIG.SHEETS.NOTEBOOK_CLIENT_TAGS);
        sheet.getRange(1, 1, 1, NOTEBOOK_CLIENT_TAG_HEADERS.length).setValues([NOTEBOOK_CLIENT_TAG_HEADERS]).setFontWeight("bold");
        sheet.setFrozenRows(1);
    }

    return sheet;
}

function findNotebookTagRow_(sheet, tagId) {
    const lastRow = sheet.getLastRow();
    if (lastRow <= 1) return null;

    const ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();

    for (let i = 0; i < ids.length; i++) {
        if (ids[i][0] !== "" && String(ids[i][0]) === String(tagId)) {
            return { row: 2 + i, values: sheet.getRange(2 + i, 1, 1, NOTEBOOK_TAG_HEADERS.length).getValues()[0] };
        }
    }

    return null;
}

// Case-insensitive -- used by createNotebookTag() so "Regulars" and
// "regulars" can't become two different tags by accident.
function findNotebookTagByName_(sheet, name) {
    const lastRow = sheet.getLastRow();
    if (lastRow <= 1) return null;

    const q = String(name).trim().toLowerCase();
    const rows = sheet.getRange(2, 1, lastRow - 1, NOTEBOOK_TAG_HEADERS.length).getValues();

    for (let i = 0; i < rows.length; i++) {
        if (String(rows[i][1] || "").trim().toLowerCase() === q) {
            return { row: 2 + i, values: rows[i] };
        }
    }

    return null;
}

// Internal, no-auth -- reused by getDebtsList() (Debts.gs, via
// getClientTagsMap_() below) and getNotebookTags() below, same
// "authenticate once at the public entry point, share the no-auth
// internal helper" pattern getClientMigrationsMap_() uses (Migrations.gs).
function getNotebookTags_() {
    const sheet = getNotebookTagsSheet_();
    const lastRow = sheet.getLastRow();
    if (lastRow <= 1) return [];

    const rows = sheet.getRange(2, 1, lastRow - 1, NOTEBOOK_TAG_HEADERS.length).getValues();

    return rows
        .filter((row) => row[0] !== "" && row[0] != null)
        .map((row) => ({ id: String(row[0]), name: String(row[1] || "") }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

// Any logged-in employee (view or edit) can view the full tag registry --
// needed for the filter-by-tag UI and the "assign an existing tag" picker.
function getNotebookTags(employeeName, employeePin) {
    authenticateEmployee(employeeName, employeePin);
    return getNotebookTags_();
}

// Edit-role only. Creates a new tag, or returns the existing one if a tag
// with the same name (case-insensitive) already exists -- same "don't
// create a disconnected duplicate" convention addShortDebt() uses for a
// repeat debtor's name.
function createNotebookTag(employeeName, employeePin, name) {
    const employee = requireEditAccess_(employeeName, employeePin);

    const trimmed = String(name || "").trim();
    if (!trimmed) {
        throw new Error("Enter a tag name.");
    }

    const sheet = getNotebookTagsSheet_();
    const existing = findNotebookTagByName_(sheet, trimmed);

    if (existing) {
        return { id: String(existing.values[0]), name: String(existing.values[1]), alreadyExists: true };
    }

    const id = Utilities.getUuid();
    sheet.appendRow([id, trimmed, new Date(), employee.name]);

    return { id, name: trimmed, alreadyExists: false };
}

// Edit-role only. Renames a tag everywhere it's used -- assignments are
// keyed by tag id, not name, so every client already carrying this tag
// shows the new name immediately on their next sync, no re-assignment
// needed.
function renameNotebookTag(employeeName, employeePin, tagId, newName) {
    requireEditAccess_(employeeName, employeePin);

    const trimmed = String(newName || "").trim();
    if (!trimmed) {
        throw new Error("Enter a tag name.");
    }

    const sheet = getNotebookTagsSheet_();
    const found = findNotebookTagRow_(sheet, tagId);

    if (!found) {
        throw new Error("That tag wasn't found -- try refreshing first.");
    }

    const clash = findNotebookTagByName_(sheet, trimmed);
    if (clash && String(clash.values[0]) !== String(tagId)) {
        throw new Error(`A tag named "${trimmed}" already exists.`);
    }

    sheet.getRange(found.row, 2).setValue(trimmed);

    return { success: true, id: String(tagId), name: trimmed };
}

function findClientTagRow_(sheet, clientId, tagId) {
    const lastRow = sheet.getLastRow();
    if (lastRow <= 1) return null;

    const rows = sheet.getRange(2, 1, lastRow - 1, 2).getValues();

    for (let i = 0; i < rows.length; i++) {
        if (String(rows[i][0]) === String(clientId) && String(rows[i][1]) === String(tagId)) {
            return { row: 2 + i };
        }
    }

    return null;
}

// Edit-role only. Idempotent -- assigning an already-assigned tag is a
// no-op, not a duplicate row (supports a double-tap/retry safely, same as
// this app's other write actions).
function assignNotebookTag(employeeName, employeePin, clientId, tagId) {
    const employee = requireEditAccess_(employeeName, employeePin);

    if (!findNotebookTagRow_(getNotebookTagsSheet_(), tagId)) {
        throw new Error("That tag wasn't found -- try refreshing first.");
    }

    const sheet = getNotebookClientTagsSheet_();
    if (findClientTagRow_(sheet, clientId, tagId)) {
        return { success: true, alreadyAssigned: true };
    }

    sheet.appendRow([clientId, tagId, new Date(), employee.name]);

    return { success: true, alreadyAssigned: false };
}

// Edit-role only. Un-assigns one tag from one client -- does NOT delete
// the tag itself from the registry (there is no tag-deletion action; only
// create/rename, per this feature's spec).
function removeNotebookTag(employeeName, employeePin, clientId, tagId) {
    requireEditAccess_(employeeName, employeePin);

    const sheet = getNotebookClientTagsSheet_();
    const found = findClientTagRow_(sheet, clientId, tagId);

    if (!found) {
        return { success: true, alreadyRemoved: true };
    }

    sheet.deleteRow(found.row);

    return { success: true, alreadyRemoved: false };
}

// clientId -> [{id, name}] for every Short (Notebook) client that has at
// least one tag -- attached to every Short debtor by getDebtsList()
// (Debts.gs), same one-call-bundling design as getClientMigrationsMap_()
// attaching migration state to every Long debtor.
function getClientTagsMap_() {
    const assignSheet = getNotebookClientTagsSheet_();
    const lastRow = assignSheet.getLastRow();
    if (lastRow <= 1) return {};

    const tagsById = {};
    getNotebookTags_().forEach((t) => {
        tagsById[t.id] = t;
    });

    const rows = assignSheet.getRange(2, 1, lastRow - 1, 2).getValues();
    const map = {};

    rows.forEach((row) => {
        const clientId = String(row[0]);
        const tag = tagsById[String(row[1])];
        // A dangling assignment (tag id no longer in the registry)
        // shouldn't be reachable -- there's no tag-delete action -- but
        // don't let one bad row blow up every client's tag list if it
        // ever happens (e.g. hand-edited sheet data).
        if (!tag) return;

        if (!map[clientId]) map[clientId] = [];
        map[clientId].push(tag);
    });

    return map;
}
