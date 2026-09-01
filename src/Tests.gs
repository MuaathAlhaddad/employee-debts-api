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

    const passed = results.filter((r) => r.passed).length;
    return { passed, total: results.length, results };
}
