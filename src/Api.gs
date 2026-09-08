// ============================================================
// JSON API router for the Employee PWA. Returns JSON, not HTML -- this
// project never uses HtmlService, so it never goes through the IFRAME
// sandbox rendering pipeline that had a real page-size bug in the main
// sales-tracker project. See the plan doc for that background.
//
// The PWA calls this with a plain POST whose body is a JSON string sent
// as Content-Type: text/plain (not application/json) -- that keeps the
// request a CORS "simple request" so the browser doesn't send a preflight
// OPTIONS call, which Apps Script Web Apps can't handle. doPost() below
// parses the body as JSON regardless of the declared content type.
//
// Request body shape: { "action": "getDebtsList", "params": [...] }
// (params is a positional array, applied directly to the target
// function -- matches how the old google.script.run calls were shaped,
// to keep porting low-risk.)
//
// Response shape: { "success": true, "data": ... } or
// { "success": false, "error": "message" }.
// ============================================================

// Explicit whitelist -- never eval/execute an arbitrary function name
// from the request. Only these are callable from the outside.
const API_ACTIONS = {
    // Auth / roster
    getEmployeeNames,
    authenticateEmployee,

    // Debtors (Long + Short) -- local tracking snapshot
    getDebtsList,
    addDebtFollowUp,
    recordDebtPayment,
    rescheduleDebtDueDate,
    setDebtStatus,
    addShortDebt,
    addToShortDebt,
    editShortDebt,
    getShortDebtorTransactions,
    refreshDebtsFromApp,
    getDebtsReviewLog,
    toggleDebtReviewEntry,

    // Long Debtor account (real Daftra data/writes)
    getLongDebtorAccount,
    addLongDebtorPayment,
    addLongDebtorInvoice,
    editLongDebtorPayment,
    editLongDebtorInvoice,
    toggleReconciliationFlag,

    // Daftra Client -> Notebook Client migration -- Owner-only (each
    // re-checks the role server-side; not just hidden in the frontend).
    convertDaftraClientToNotebook,
    disableDaftraClient,

    // Product search
    searchProducts,
    getProductPurchaseHistory,

    // Smoke tests -- see README.md. Self-cleaning writes against the two
    // designated test clients only -- NEVER call with a real client_id.
    runSmokeTests,

    // Offline sync
    syncBundle,
};

function jsonResponse_(body) {
    return ContentService.createTextOutput(JSON.stringify(body)).setMimeType(
        ContentService.MimeType.JSON,
    );
}

function doPost(e) {
    try {
        const body = JSON.parse((e.postData && e.postData.contents) || "{}");
        const action = body.action;
        const params = Array.isArray(body.params) ? body.params : [];

        const fn = API_ACTIONS[action];

        if (typeof fn !== "function") {
            return jsonResponse_({ success: false, error: `Unknown action: ${action}` });
        }

        const data = fn.apply(null, params);
        return jsonResponse_({ success: true, data });
    } catch (err) {
        return jsonResponse_({ success: false, error: err.message || String(err) });
    }
}

// Plain health check -- open the deployed URL directly in a browser to
// confirm the deployment is live.
function doGet(e) {
    return jsonResponse_({ success: true, data: { status: "ok", time: new Date().toISOString() } });
}
