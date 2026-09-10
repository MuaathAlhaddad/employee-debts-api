// ============================================================
// Smoke tests -- run these against the two designated test records
// after every deploy that touches Debts.gs, Daftra.gs, or Api.gs (see
// the project README for how). They exercise the real API surface
// (Daftra writes included) exactly the way the PWA does, not mocks, so
// they catch the kind of thing this project has actually broken before:
// a Daftra payload missing a required field, a PUT silently resetting a
// field it shouldn't, a formula regression in balance math.
//
// Designated test records -- NEVER point these at a real client:
//   Long (Daftra):    client #630
//   Short (Notebook): "TEST - ignore (ledger check)"
//                      (clientId S-c35f8951-c7a4-423e-aa31-80c48c8fb818)
//
// The Long-debtor checks are fully self-cleaning (create, verify, edit,
// verify, delete -- confirmed 2026-09-01 that Daftra's api2 DELETE
// works for both invoices.json and client_payments.json), so client
// #630's real balance is untouched by running this any number of times.
//
// The Short-debtor checks are NOT self-cleaning -- there's no sheet-row
// delete built for the local Debts Snapshot / Short Debtor Transactions
// sheets, so each run adds a small, clearly-labeled test transaction to
// that debtor's history. That's expected and fine -- it's a dedicated
// sandbox record, not a real debtor.
// ============================================================

const TEST_LONG_CLIENT_ID = "630";
const TEST_SHORT_CLIENT_ID = "S-c35f8951-c7a4-423e-aa31-80c48c8fb818";

function runSmokeTests(employeeName, employeePin) {
    const results = [];

    const check = (name, fn) => {
        try {
            fn();
            results.push({ name, passed: true });
        } catch (e) {
            results.push({ name, passed: false, error: e.message || String(e) });
        }
    };

    check("Long: getLongDebtorAccount returns entries", () => {
        const statement = getLongDebtorAccount(employeeName, employeePin, TEST_LONG_CLIENT_ID);
        if (!statement || !Array.isArray(statement.entries)) {
            throw new Error("expected { entries: [...] }, got " + JSON.stringify(statement));
        }
    });

    check("Long: payment create -> edit -> delete round-trip", () => {
        const created = addDaftraClientPayment(TEST_LONG_CLIENT_ID, 1, "smoke test -- safe to ignore if seen");
        const id = created && created.id;
        if (!id) throw new Error("no id came back from creation: " + JSON.stringify(created));

        editDaftraClientPayment_(id, TEST_LONG_CLIENT_ID, 2);
        const afterEdit = daftraGet_(`client_payments/${id}.json`, {});
        const amt = afterEdit && afterEdit.data && afterEdit.data.ClientPayment && Number(afterEdit.data.ClientPayment.amount);
        if (amt !== 2) throw new Error(`edit didn't take -- amount is ${amt}, expected 2`);

        const del = daftraDelete_(`client_payments/${id}.json`);
        if (!del || del.code !== 200) throw new Error("delete failed: " + JSON.stringify(del));
    });

    check("Long: invoice create -> edit -> delete round-trip", () => {
        const created = createDaftraDueInvoice_(TEST_LONG_CLIENT_ID, 1, "smoke test -- safe to ignore if seen");
        const id = created && created.id;
        if (!id) throw new Error("no id came back from creation: " + JSON.stringify(created));

        editDaftraDueInvoice_(id, TEST_LONG_CLIENT_ID, 2);
        const afterEdit = daftraGet_(`invoices/${id}.json`, {});
        const total = afterEdit && afterEdit.data && afterEdit.data.Invoice && Number(afterEdit.data.Invoice.summary_total);
        if (total !== 2) throw new Error(`edit didn't take -- summary_total is ${total}, expected 2`);

        const del = daftraDelete_(`invoices/${id}.json`);
        if (!del || del.code !== 200) throw new Error("delete failed: " + JSON.stringify(del));
    });

    check("Short: getShortDebtorTransactions returns entries", () => {
        const tx = getShortDebtorTransactions(employeeName, employeePin, TEST_SHORT_CLIENT_ID);
        if (!tx || !Array.isArray(tx.entries)) {
            throw new Error("expected { entries: [...] }, got " + JSON.stringify(tx));
        }
    });

    check("Short: debt added + payment -- totals and running balance check out", () => {
        const sheet = getDebtsSheet_();
        const before = loadDebtRow_(sheet, TEST_SHORT_CLIENT_ID).values;
        const owedBefore = Number(before[3]) || 0;
        const paidBefore = Number(before[4]) || 0;

        addToShortDebt(employeeName, employeePin, TEST_SHORT_CLIENT_ID, 10, "smoke test", "");
        recordDebtPayment(employeeName, employeePin, TEST_SHORT_CLIENT_ID, 10);

        const after = loadDebtRow_(sheet, TEST_SHORT_CLIENT_ID).values;
        const owedAfter = Number(after[3]) || 0;
        const paidAfter = Number(after[4]) || 0;

        if (owedAfter !== owedBefore + 10) throw new Error(`Amount Owed is ${owedAfter}, expected ${owedBefore + 10}`);
        if (paidAfter !== paidBefore + 10) throw new Error(`Amount Paid is ${paidAfter}, expected ${paidBefore + 10}`);

        const tx = getShortDebtorTransactions(employeeName, employeePin, TEST_SHORT_CLIENT_ID);
        const latest = tx.entries[0];
        if (!latest || latest.type !== "payment" || latest.amount !== -10) {
            throw new Error("latest transaction doesn't look like the expected payment: " + JSON.stringify(latest));
        }
    });

    check("Short: editShortDebt no-op save doesn't throw", () => {
        const sheet = getDebtsSheet_();
        const values = loadDebtRow_(sheet, TEST_SHORT_CLIENT_ID).values;
        editShortDebt(
            employeeName,
            employeePin,
            TEST_SHORT_CLIENT_ID,
            values[0],
            values[3],
            values[4],
            values[6],
            values[7],
            values[8],
            values[13],
        );
    });

    check("Notebook deletion: transaction delete reverses balance, restore reapplies it", () => {
        const sheet = getDebtsSheet_();
        const before = loadDebtRow_(sheet, TEST_SHORT_CLIENT_ID).values;
        const owedBefore = Number(before[3]) || 0;

        addToShortDebt(employeeName, employeePin, TEST_SHORT_CLIENT_ID, 7, "smoke test -- deletion round trip", "");

        const tx = getShortDebtorTransactions(employeeName, employeePin, TEST_SHORT_CLIENT_ID);
        const created = tx.entries[0];
        if (!created || !created.id || created.type !== "debt_added" || created.amount !== 7) {
            throw new Error("expected a fresh debt_added transaction with a real id: " + JSON.stringify(created));
        }

        const afterAdd = loadDebtRow_(sheet, TEST_SHORT_CLIENT_ID).values;
        if ((Number(afterAdd[3]) || 0) !== owedBefore + 7) {
            throw new Error(`Amount Owed after add is ${afterAdd[3]}, expected ${owedBefore + 7}`);
        }

        const del = deleteShortTransaction(employeeName, employeePin, created.id);
        if (!del.success || del.alreadyDeleted) {
            throw new Error("delete didn't report a fresh success: " + JSON.stringify(del));
        }

        const afterDelete = loadDebtRow_(sheet, TEST_SHORT_CLIENT_ID).values;
        if ((Number(afterDelete[3]) || 0) !== owedBefore) {
            throw new Error(`Amount Owed after delete is ${afterDelete[3]}, expected it back to ${owedBefore}`);
        }

        const txAfterDelete = getShortDebtorTransactions(employeeName, employeePin, TEST_SHORT_CLIENT_ID);
        if (txAfterDelete.entries.some((e) => e.id === created.id)) {
            throw new Error("deleted transaction still shows up in getShortDebtorTransactions()");
        }

        const restore = restoreShortTransaction(employeeName, employeePin, created.id);
        if (!restore.success || restore.alreadyRestored) {
            throw new Error("restore didn't report a fresh success: " + JSON.stringify(restore));
        }

        const afterRestore = loadDebtRow_(sheet, TEST_SHORT_CLIENT_ID).values;
        if ((Number(afterRestore[3]) || 0) !== owedBefore + 7) {
            throw new Error(`Amount Owed after restore is ${afterRestore[3]}, expected ${owedBefore + 7}`);
        }

        // Leave the test client's balance exactly where this check found
        // it -- delete again (permanently, for this test's purposes) so
        // the restore above doesn't leave a net +7 behind on every run.
        const finalDelete = deleteShortTransaction(employeeName, employeePin, created.id);
        if (!finalDelete.success) throw new Error("final cleanup delete failed: " + JSON.stringify(finalDelete));
    });

    check("Notebook deletion: client soft delete hides it from getDebtsList, restore brings it back", () => {
        const before = getDebtsList(employeeName, employeePin);
        if (!before.short.some((d) => d.clientId === TEST_SHORT_CLIENT_ID)) {
            throw new Error("test client should be visible before this check even starts");
        }

        const del = deleteShortDebt(employeeName, employeePin, TEST_SHORT_CLIENT_ID);
        if (!del.success || del.alreadyDeleted) {
            throw new Error("delete didn't report a fresh success: " + JSON.stringify(del));
        }

        const afterDelete = getDebtsList(employeeName, employeePin);
        if (afterDelete.short.some((d) => d.clientId === TEST_SHORT_CLIENT_ID)) {
            throw new Error("soft-deleted test client still shows up in getDebtsList()");
        }

        // The ledger itself must survive the client-level delete untouched.
        const txWhileDeleted = getShortDebtorTransactions(employeeName, employeePin, TEST_SHORT_CLIENT_ID);
        if (txWhileDeleted.entries.length === 0) {
            throw new Error("Short Debtor Transactions history disappeared while the client was soft-deleted");
        }

        const restore = restoreShortDebt(employeeName, employeePin, TEST_SHORT_CLIENT_ID);
        if (!restore.success || restore.alreadyRestored) {
            throw new Error("restore didn't report a fresh success: " + JSON.stringify(restore));
        }

        const afterRestore = getDebtsList(employeeName, employeePin);
        if (!afterRestore.short.some((d) => d.clientId === TEST_SHORT_CLIENT_ID)) {
            throw new Error("restored test client doesn't show back up in getDebtsList()");
        }
    });

    check("Notebook tags: create/assign/view/remove round trip", () => {
        // Reuses the same tag across runs (createNotebookTag is idempotent
        // by name) rather than creating a fresh one every time -- there is
        // no tag-delete action anywhere in this API (deliberately, per this
        // feature's spec: only create/rename), so a brand-new tag per run
        // would permanently accumulate in the registry. This one stays in
        // "Notebook Tags" between runs, same "not fully self-cleaning, and
        // that's expected" caveat this file's other Short-debtor checks
        // already carry -- it's just never left ASSIGNED to the test
        // client afterward (removed at the end of this check).
        const tag = createNotebookTag(employeeName, employeePin, "TEST - smoke test tag (safe to ignore)");
        if (!tag.id) throw new Error("createNotebookTag didn't return an id: " + JSON.stringify(tag));

        const allTags = getNotebookTags(employeeName, employeePin);
        if (!allTags.some((t) => t.id === tag.id)) {
            throw new Error("new tag doesn't show up in getNotebookTags()");
        }

        const assign = assignNotebookTag(employeeName, employeePin, TEST_SHORT_CLIENT_ID, tag.id);
        if (!assign.success) throw new Error("assignNotebookTag failed: " + JSON.stringify(assign));

        const debts = getDebtsList(employeeName, employeePin);
        const client = debts.short.find((d) => d.clientId === TEST_SHORT_CLIENT_ID);
        if (!client || !client.tags || !client.tags.some((t) => t.id === tag.id)) {
            throw new Error("assigned tag doesn't show up on the test client's getDebtsList() entry: " + JSON.stringify(client && client.tags));
        }

        const remove = removeNotebookTag(employeeName, employeePin, TEST_SHORT_CLIENT_ID, tag.id);
        if (!remove.success) throw new Error("removeNotebookTag failed: " + JSON.stringify(remove));

        const debtsAfter = getDebtsList(employeeName, employeePin);
        const clientAfter = debtsAfter.short.find((d) => d.clientId === TEST_SHORT_CLIENT_ID);
        if (clientAfter && clientAfter.tags && clientAfter.tags.some((t) => t.id === tag.id)) {
            throw new Error("removed tag still shows up on the test client after removeNotebookTag()");
        }
    });

    check("Migration: convert creates a Notebook client, repeat call doesn't duplicate", () => {
        const migrationsSheet = getClientMigrationsSheet_();
        const debtsSheet = getDebtsSheet_();

        // Clean slate -- clear any leftover migration row for the test
        // client from a previous failed run before starting.
        const leftover = findClientMigrationRow_(migrationsSheet, TEST_LONG_CLIENT_ID);
        if (leftover) migrationsSheet.deleteRow(leftover.row);

        const first = convertDaftraClientToNotebook(employeeName, employeePin, TEST_LONG_CLIENT_ID);
        if (!first.notebookClientId || first.alreadyExists) {
            throw new Error("first conversion should create a new Notebook client: " + JSON.stringify(first));
        }

        const second = convertDaftraClientToNotebook(employeeName, employeePin, TEST_LONG_CLIENT_ID);
        if (!second.alreadyExists || second.notebookClientId !== first.notebookClientId) {
            throw new Error("repeat conversion should return the SAME Notebook client, not create a new one: " + JSON.stringify(second));
        }

        // Self-cleaning -- delete the Short debtor row and the Migrations
        // row this test created, so client #630 stays a clean sandbox
        // record (mirrors this suite's other self-cleaning checks above).
        const shortRow = findDebtRow_(debtsSheet, first.notebookClientId);
        if (shortRow) debtsSheet.deleteRow(shortRow);
        const migrationRow = findClientMigrationRow_(migrationsSheet, TEST_LONG_CLIENT_ID);
        if (migrationRow) migrationsSheet.deleteRow(migrationRow.row);
    });

    // NOT covered here, deliberately:
    //   - Owner-only rejection for a non-owner employee -- runSmokeTests
    //     only ever runs as one identity (see the curl example in
    //     CLAUDE.md), so there's no second non-owner credential available
    //     to call convertDaftraClientToNotebook/disableDaftraClient/
    //     deleteShortDebt/deleteShortTransaction with and confirm they
    //     throw for anything other than the "owner" role. Test this by
    //     hand once with a real edit-role (non-owner) PIN AND a real
    //     view-role PIN -- both must be rejected with "Only the shop owner
    //     can do that."
    //   - Edit-role rejection for a view-only employee calling
    //     createNotebookTag/renameNotebookTag/assignNotebookTag/
    //     removeNotebookTag -- same reason (only one identity available
    //     here). Test by hand with a real view-role PIN; expect
    //     "You have view-only access and can't make changes."
    //   - disableDaftraClient()'s balance-clear + rename/suspend, end to
    //     end -- gated on testClientRenameSuspendRoundTrip() below passing
    //     first (the rename/suspend field-name guess needs manual
    //     confirmation before ANY automated test touches a client's
    //     business_name/suspend field, even the designated test one).

    const passed = results.filter((r) => r.passed).length;
    return { passed, total: results.length, results };
}

// ============================================================
// Client rename+suspend diagnostics -- NOT part of runSmokeTests. Run
// these ONCE by hand (function dropdown -> pick one -> Run -> View Logs)
// against TEST_LONG_CLIENT_ID before trusting daftraDisableClient_()
// (Daftra.gs) -- and therefore "Disable Daftra Client" -- against any real
// client. Same "verify against a real account before trusting the numbers"
// discipline this file's other Daftra-facing tests already follow (see
// Daftra.gs's header comment) -- kept manual rather than automated because
// the field-name guess this relies on (business_name) has never been
// confirmed here, unlike the payment/invoice fields the automated checks
// above exercise.
// ============================================================

// Dumps the RAW clients/{id}.json response so the real field name for a
// client's display name (and anything else daftraDisableClient_() might
// need to carry forward more carefully) can be read directly.
function testRawClient(clientId) {
    clientId = clientId || TEST_LONG_CLIENT_ID;
    Logger.log("RAW clients/%s.json: %s", clientId, JSON.stringify(daftraGet_(`clients/${clientId}.json`, {}), null, 2));
}

// Self-cleaning round trip: renames+suspends the TEST client, verifies both
// stuck, then renames+unsuspends it back to its original state. NEVER pass
// a real client_id here.
function testClientRenameSuspendRoundTrip(clientId) {
    clientId = clientId || TEST_LONG_CLIENT_ID;

    const before = getDaftraClient_(clientId);
    const originalName = before.business_name;

    daftraDisableClient_(clientId, "TEST - rename round trip (safe to ignore if seen)");

    const afterDisable = getDaftraClient_(clientId);
    if (afterDisable.business_name !== "TEST - rename round trip (safe to ignore if seen)") {
        throw new Error("Rename didn't take -- got " + JSON.stringify(afterDisable.business_name));
    }
    if (String(afterDisable.suspend) !== "1") {
        throw new Error("Suspend didn't take -- got " + JSON.stringify(afterDisable.suspend));
    }

    const client = getDaftraClient_(clientId);
    const restore = daftraClientProfilePayload_(client, { business_name: originalName, suspend: 0 });
    const result = daftraPut_(`clients/${clientId}.json`, { Client: restore });

    if (result.code < 200 || result.code >= 300) {
        throw new Error(
            `Round trip succeeded but RESTORE failed -- fix client ${clientId} by hand in Daftra (original name: "${originalName}", suspend: 0). Daftra said: ${result.body}`,
        );
    }

    Logger.log("Rename+suspend round trip OK for client %s (restored to name=%s, suspend=0).", clientId, originalName);
}
