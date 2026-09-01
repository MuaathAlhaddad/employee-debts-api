// ============================================================
// Product search -- last purchase price + a short history. Any logged-in
// employee (view or edit) can look this up; it's read-only.
// ============================================================

function searchProducts(employeeName, employeePin, query) {
    authenticateEmployee(employeeName, employeePin);

    return searchDaftraProducts(query);
}

function getProductPurchaseHistory(employeeName, employeePin, productId) {
    authenticateEmployee(employeeName, employeePin);

    return getDaftraProductPurchaseHistoryCached_(productId);
}
