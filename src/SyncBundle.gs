// ============================================================
// One-call bundle for the PWA's "sync now" / on-open sync -- cached
// client-side in IndexedDB. Includes the Debtors list and the full
// Product catalog (names/SKUs, for offline search-by-name), but NOT
// price history for every product -- computing that for the whole
// catalog isn't practical (this account alone has 56,000+
// stock_transactions rows; see Daftra.gs's getDaftraProductPurchaseHistory
// comment). Product prices and Long Debtor account statements are both
// fetched fresh, on demand, once the employee taps into one specific
// product/debtor -- both need a live connection, same tradeoff.
// ============================================================

function syncBundle(employeeName, employeePin) {
    authenticateEmployee(employeeName, employeePin);

    const debts = getDebtsList(employeeName, employeePin);
    const products = getAllProducts();
    // Full tag registry (2026-09-10) -- bundled the same one-call way as
    // debts/products so the tag filter row and "add existing tag" picker
    // work straight from the synced cache, no extra round trip. Each
    // Short debtor's OWN assigned tags already come back on debts.short
    // (see getDebtsList()'s getClientTagsMap_() attachment); this is the
    // full registry, including tags nothing is currently tagged with.
    const tags = getNotebookTags_();

    return {
        debts,
        products,
        tags,
        syncedAt: new Date().toISOString(),
    };
}
