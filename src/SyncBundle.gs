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

    return {
        debts,
        products,
        syncedAt: new Date().toISOString(),
    };
}
