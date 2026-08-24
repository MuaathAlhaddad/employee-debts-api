// Daftra integration for the Employee app -- Long Debtors, account
// statements, payments, and product purchase-price search.
//
// ONE-TIME SETUP (this is a SEPARATE Apps Script project from the main
// sales-tracker app, so Script Properties are NOT shared -- set these here
// too, even though you already set them over there):
//   Apps Script editor -> Project Settings (gear icon, left sidebar)
//   -> Script Properties -> Add script property
//     DAFTRA_SUBDOMAIN = muaath20002024   (from https://muaath20002024.daftra.com)
//     DAFTRA_API_KEY   = <your Daftra API key, same one as the other project>
//
// BEFORE TRUSTING THE NUMBERS: run testDaftraConnection(), testProducts(),
// and testClientStatement() once from this editor (function dropdown at
// the top -> pick one -> Run, then View > Logs) and compare against your
// real Daftra reports. Daftra's API docs are a little inconsistent about
// response shapes, so this is worth a real check before it's making
// numbers employees act on. Payment CREATION isn't covered by an
// automated test on purpose -- that's a real financial write, so the
// first real test of it should be a small, verifiable payment made
// through the actual app once built, not an automated script.

function getDaftraConfig_() {
    const props = PropertiesService.getScriptProperties();
    const subdomain = props.getProperty("DAFTRA_SUBDOMAIN");
    const apiKey = props.getProperty("DAFTRA_API_KEY");

    if (!subdomain || !apiKey) {
        throw new Error(
            "Daftra not configured. Set DAFTRA_SUBDOMAIN and DAFTRA_API_KEY " +
                "in Project Settings > Script Properties.",
        );
    }

    return { subdomain, apiKey };
}

function daftraGet_(path, params) {
    const { subdomain, apiKey } = getDaftraConfig_();

    const query = Object.keys(params || {})
        .map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(params[k]))
        .join("&");

    const url =
        `https://${subdomain}.daftra.com/api2/${path}` +
        (query ? "?" + query : "");

    const response = UrlFetchApp.fetch(url, {
        method: "get",
        headers: {
            APIKEY: apiKey,
            Accept: "application/json",
        },
        muteHttpExceptions: true,
    });

    const code = response.getResponseCode();
    const body = response.getContentText();

    if (code < 200 || code >= 300) {
        throw new Error(
            `Daftra API error ${code} on ${path}: ${body.slice(0, 300)}`,
        );
    }

    return JSON.parse(body);
}

// POST counterpart of daftraGet_ -- used for creating a client payment.
// Field names here are a best-effort match against Daftra's documented
// POST shape for the symmetric "Add New Purchase Invoice" endpoint
// (payload wraps the resource under its capitalized key). Verify against
// a real, small, verifiable payment before relying on this -- see header.
function daftraPost_(path, payload) {
    const { subdomain, apiKey } = getDaftraConfig_();

    const url = `https://${subdomain}.daftra.com/api2/${path}`;

    const response = UrlFetchApp.fetch(url, {
        method: "post",
        contentType: "application/json",
        payload: JSON.stringify(payload),
        headers: {
            APIKEY: apiKey,
            Accept: "application/json",
        },
        muteHttpExceptions: true,
    });

    const code = response.getResponseCode();
    const body = response.getContentText();

    if (code < 200 || code >= 300) {
        throw new Error(
            `Daftra API error ${code} on POST ${path}: ${body.slice(0, 300)}`,
        );
    }

    return JSON.parse(body);
}

// Daftra's list endpoints aren't 100% consistent about the wrapper key
// across API versions/endpoints. Try the common shapes rather than
// assuming one, so a quirky response returns an empty list instead of
// throwing.
function daftraExtractList_(payload) {
    if (Array.isArray(payload)) return payload;

    if (payload && typeof payload === "object") {
        const candidates = [
            "data",
            "result",
            "Invoice",
            "InvoicePayment",
            "ClientPayment",
            "Product",
            "PurchaseOrder",
            "PurchaseOrderItem",
            "items",
        ];

        for (const key of candidates) {
            if (Array.isArray(payload[key])) return payload[key];
        }
    }

    return [];
}

// Confirmed against a real account (Aug 2026, in the main sales-tracker
// project): each item in the "data" array comes back wrapped one level
// deeper, e.g. { "Invoice": { payment_status: "0", ... } } rather than the
// fields directly on the item. Unwrap defensively -- if a future response
// isn't wrapped, `item[key]` is just undefined and we fall back to the
// item itself.
function daftraUnwrap_(item, key) {
    return item && item[key] ? item[key] : item;
}

function daftraPaginate_(path, params, unwrapKey, onPage) {
    let page = 1;
    const limit = 100;
    const MAX_PAGES = 200;

    while (page <= MAX_PAGES) {
        const payload = daftraGet_(path, Object.assign({}, params, { page, limit }));
        const items = daftraExtractList_(payload).map((item) => daftraUnwrap_(item, unwrapKey));

        if (items.length === 0) break;

        onPage(items);

        const pagination = payload && payload.pagination;
        const pageCount = pagination && Number(pagination.page_count);

        if (!pageCount || page >= pageCount) break;
        page++;
    }
}

// ============================================================
// Long Debtors -- who currently owes the shop money, per client.
// ============================================================

// clients.json's Client resource has a "suspend" field ("0" = active,
// confirmed 2026-08-22 against a real account) -- invoices.json doesn't
// carry that flag on its embedded client fields, so this is a second,
// separate paginated fetch, done once per refresh and cached in the map
// below rather than per-invoice.
function getSuspendedClientIds_() {
    const suspended = {};
    daftraPaginate_("clients.json", {}, "Client", (clients) => {
        clients.forEach((c) => {
            if (String(c.suspend) === "1") suspended[c.id] = true;
        });
    });
    return suspended;
}

function getDaftraOutstandingDebts() {
    const balances = {}; // client_id -> { clientId, clientName, amount, phone }

    daftraPaginate_("invoices.json", {}, "Invoice", (invoices) => {
        invoices.forEach((inv) => {
            const unpaid = Number(inv.summary_unpaid) || 0;
            if (unpaid <= 0) return;

            const id = inv.client_id;
            const name =
                inv.client_business_name ||
                [inv.client_first_name, inv.client_last_name].filter(Boolean).join(" ") ||
                "Client #" + id;
            // String() -- Daftra sometimes hands this back as a number,
            // not a string (confirmed 2026-08-22 against a real account),
            // and downstream code assumes a string (.replace(), etc).
            const phone = String(inv.client_phone1 || inv.client_phone || inv.client_mobile || "");

            if (!balances[id]) {
                balances[id] = { clientId: id, clientName: name, amount: 0, phone };
            }
            balances[id].amount += unpaid;
            if (!balances[id].phone && phone) balances[id].phone = phone;
        });
    });

    const suspended = getSuspendedClientIds_();

    return Object.values(balances)
        .filter((d) => !suspended[d.clientId])
        .sort((a, b) => b.amount - a.amount);
}

// ============================================================
// Long Debtor account activity -- assembled from invoices + both kinds of
// payment, since Daftra has no single "client statement" API endpoint
// (confirmed by research; statements/aged-ledger are web-report-only).
//
// Scoped to the last 30 days only (owner's call, 2026-08-22): showing
// full history was both slow (20-30+ seconds for an active client,
// scanning everything) and not what's actually wanted day to day. The
// headline "Balance" the app shows is the debtor's already-known total
// (from the Debts Snapshot / getDaftraOutstandingDebts, computed off
// Daftra's summary_unpaid) -- NOT recomputed from this partial window,
// since a running total over just 30 days would be a confusingly wrong
// number for any debt older than that.
// ============================================================

function getDaftraClientStatement(clientId) {
    const entries = []; // { date, type, description, amount }
    const from = Utilities.formatDate(addDays_(new Date(), -30), Session.getScriptTimeZone(), "yyyy-MM-dd");

    daftraPaginate_("invoices.json", { client_id: clientId, date_from: from }, "Invoice", (invoices) => {
        invoices.forEach((inv) => {
            entries.push({
                date: inv.date || inv.created,
                type: "invoice",
                description: `Invoice #${inv.no || inv.id}`,
                amount: Number(inv.summary_total) || 0,
            });
        });
    });

    daftraPaginate_("invoice_payments.json", { client_id: clientId, date_from: from }, "InvoicePayment", (payments) => {
        payments.forEach((p) => {
            entries.push({
                date: p.date,
                type: "invoice_payment",
                description: `Payment on invoice #${p.invoice_id}`,
                amount: -(Number(p.amount) || 0),
            });
        });
    });

    daftraPaginate_("client_payments.json", { client_id: clientId, date_from: from }, "ClientPayment", (payments) => {
        payments.forEach((p) => {
            entries.push({
                date: p.date,
                type: "client_payment",
                description: p.notes || "Account payment",
                amount: -(Number(p.amount) || 0),
            });
        });
    });

    entries.sort((a, b) => new Date(b.date) - new Date(a.date));

    return { entries, periodDays: 30 };
}

function addDays_(date, n) {
    const d = new Date(date);
    d.setDate(d.getDate() + n);
    return d;
}

// Records a payment directly to a client's account (not tied to one
// invoice) -- what "Add payment" in the app calls. See the header comment
// about verifying this against a real, small, verifiable payment before
// trusting it in daily use.
function addDaftraClientPayment(clientId, amount, note) {
    const payload = {
        ClientPayment: {
            client_id: clientId,
            amount: amount,
            date: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd"),
            notes: note || "",
        },
    };

    return daftraPost_("client_payments.json", payload);
}

// ============================================================
// Product search -- name/SKU search plus last purchase price(s).
//
// The purchase_invoices.json LIST endpoint does NOT include line items
// (confirmed 2026-08-21 against a real account) -- only the SINGLE
// invoice detail endpoint does, which would mean one Daftra round trip
// per invoice to build a price history (too slow/expensive at scale).
// stock_transactions.json turned out to be the right source instead: it's
// one paginated, per-product-filterable list of stock movements that
// already includes `price`/`purchase_price`, `quantity`, `date`, and
// `product_id` directly -- no N+1 needed. Passing `product_id` as a query
// param is untested against Daftra's real filtering behavior, so this
// also filters client-side per page as a safety net and stops early once
// enough matches are found, bounding worst-case latency either way.
// ============================================================

function searchDaftraProducts(query) {
    const q = String(query || "").trim().toLowerCase();
    if (!q) return [];

    const matches = [];

    daftraPaginate_("products.json", {}, "Product", (products) => {
        products.forEach((p) => {
            if (String(p.deactivate) === "1") return; // e.g. "[ قديم ]"-prefixed retired products
            const name = p.name || p.product_name || "";
            const sku = p.product_code || p.sku || "";
            if (name.toLowerCase().includes(q) || sku.toLowerCase().includes(q)) {
                matches.push({ id: p.id, name, sku });
            }
        });
    });

    return matches.slice(0, 25);
}

// Full product list (no price -- see getDaftraProductPurchaseHistory for
// that, fetched on demand per product since scanning price history for
// the ENTIRE catalog upfront isn't practical: this account alone has
// 56,000+ stock_transactions rows). This is what the offline sync bundle
// uses so Product Search can match by name/SKU from the local cache
// without a live connection; viewing a specific product's price needs one.
function getAllProducts() {
    const products = [];
    daftraPaginate_("products.json", {}, "Product", (items) => {
        items.forEach((p) => {
            if (String(p.deactivate) === "1") return; // e.g. "[ قديم ]"-prefixed retired products
            products.push({ id: p.id, name: p.name || p.product_name || "", sku: p.product_code || p.sku || "" });
        });
    });
    return products;
}

// Last 3 purchases for one product: date, supplier name, purchase price.
// Three-phase, confirmed against real account data 2026-08-21:
//   1. stock_transactions.json is NOT sorted newest-first and its
//      product_id filter isn't honored server-side (confirmed -- scanning
//      forward from page 1 surfaced Jan/Feb 2025 rows for an account with
//      2026 activity, and results included other products). It IS stored
//      oldest-first by id/date, though, so scanning BACKWARD from the
//      last page finds the most recent matches fast without needing
//      server-side filtering to work.
//   2. That scan is just to find the most recent purchase order ids for
//      this product -- filtered client-side, and only from
//      positive-quantity rows (purchases add stock; negative-quantity
//      rows are sales, which was the original bug here).
//   3. Fetch each of those (at most 3) order's full detail from
//      purchase_invoices/{id}.json -- confirmed to include supplier name
//      and, per line item, unit_price/unit_name/unit_factor. Only 3
//      requests regardless of catalog size, so this stays fast.
// unit_price is Daftra's "per smallest unit" cost; when a line item's
// unit is a multi-piece unit (حبة/درزن here -- confirmed via a real
// dozen-priced item earlier), the real per-purchase price the owner
// thinks in is unit_price * unit_factor, not the raw field.
function getDaftraProductPurchaseHistory(productId) {
    const NEEDED = 3;
    const orderIds = [];
    const limit = 100;

    // A cheap first call just to learn the total page count at this limit
    // (pagination metadata only comes back attached to a real page fetch).
    const probe = daftraGet_("stock_transactions.json", { page: 1, limit });
    const pageCount = Number((probe.pagination && probe.pagination.page_count) || 1);

    const MAX_PAGES_SCANNED = 80; // 8,000 most-recent rows -- bounds latency
    let scanned = 0;

    for (let page = pageCount; page >= 1 && orderIds.length < NEEDED && scanned < MAX_PAGES_SCANNED; page--) {
        const payload = page === 1 ? probe : daftraGet_("stock_transactions.json", { page, limit });
        scanned++;

        const items = daftraExtractList_(payload).map((item) => daftraUnwrap_(item, "StockTransaction"));

        items
            .filter((t) => String(t.product_id) === String(productId) && Number(t.quantity) > 0 && t.order_id)
            .sort((a, b) => new Date(b.date) - new Date(a.date))
            .forEach((t) => {
                if (orderIds.indexOf(t.order_id) === -1) orderIds.push(t.order_id);
            });
    }

    const purchases = orderIds.slice(0, NEEDED).map((orderId) => {
        const detail = daftraGet_(`purchase_invoices/${orderId}.json`, {});
        const order = daftraUnwrap_(detail.data, "PurchaseOrder") || {};
        const items = order.PurchaseOrderItem || order.items || [];
        const item = items.find((i) => String(i.product_id) === String(productId));

        if (!item) return null;

        const unitFactor = Number(item.unit_factor) || 1;
        const isMultiPieceUnit = item.unit_name === "حبة" || item.unit_name === "درزن" || item.unit_small_name === "حبة" || item.unit_small_name === "درزن";
        const unitPrice = Number(item.unit_price) || 0;

        return {
            date: order.date || order.created,
            supplierName: order.supplier_business_name || order.supplier_name || "",
            purchasePrice: isMultiPieceUnit ? unitPrice * unitFactor : unitPrice,
            unitName: item.unit_name || "",
            orderId,
        };
    }).filter(Boolean);

    purchases.sort((a, b) => new Date(b.date) - new Date(a.date));

    return purchases;
}

// ============================================================
// "Debts Snapshot" sheet -- ported verbatim from the sales-tracker
// project's Daftra.gs. Same sheet, same schema, same refresh behavior.
// Two kinds of row share it:
//   Type "Long"  -- pulled from Daftra by this function. Phone/Amount
//                   Owed/Snapshot Time are overwritten from fresh Daftra
//                   data on every refresh; Status/Due Date/Date Given/
//                   Last Follow Up/Promise Count/Log are follow-up info an
//                   employee enters and must be preserved across refreshes.
//                   Amount Paid always stays 0 for Long debts -- Daftra's
//                   summary_unpaid is already net of payments.
//   Type "Short" -- entered by hand (addShortDebt() in Debts.gs) for
//                   debts from a separate notebook that never becomes a
//                   Daftra invoice. This function never touches those rows.
//
// Log is a JSON array of {id, date, time, actor, note} follow-up entries,
// newest last.
const DEBTS_HEADERS = [
    "Client",
    "Client ID",
    "Type",
    "Amount Owed",
    "Amount Paid",
    "Status",
    "Phone",
    "Due Date",
    "Date Given",
    "Last Follow Up",
    "Promise Count",
    "Log",
    "Snapshot Time",
];

function refreshDebtsSnapshot() {
    const debts = getDaftraOutstandingDebts();

    const ss = getSheet_();
    let sheet = ss.getSheetByName(CONFIG.SHEETS.DEBTS);

    if (!sheet) {
        sheet = ss.insertSheet(CONFIG.SHEETS.DEBTS);
    }

    const lastRow = sheet.getLastRow();
    const existingLong = {}; // clientId -> preserved follow-up fields
    const shortRows = []; // carried forward untouched

    const currentHeaders =
        lastRow >= 1
            ? sheet.getRange(1, 1, 1, DEBTS_HEADERS.length).getValues()[0]
            : [];
    const headerMatches =
        JSON.stringify(currentHeaders) === JSON.stringify(DEBTS_HEADERS);

    if (headerMatches && lastRow > 1) {
        sheet
            .getRange(2, 1, lastRow - 1, DEBTS_HEADERS.length)
            .getValues()
            .forEach((row) => {
                const clientId = row[1];
                if (clientId === "" || clientId == null) return;

                if (row[2] === "Short") {
                    shortRows.push(row);
                    return;
                }

                existingLong[clientId] = {
                    status: row[5] || "",
                    dueDate: row[7] || "",
                    dateGiven: row[8] || "",
                    lastFollowUp: row[9] || "",
                    promiseCount: row[10] || 0,
                    log: row[11] || "",
                };
            });
    }

    sheet.clear();

    const now = new Date();

    sheet
        .getRange(1, 1, 1, DEBTS_HEADERS.length)
        .setValues([DEBTS_HEADERS])
        .setFontWeight("bold");

    const longRows = debts.map((d) => {
        const prev = existingLong[d.clientId] || {};

        const wasResolved = prev.status === "paid" || prev.status === "dead";
        const status = wasResolved ? CONFIG.DEBT_STATUS.ACTIVE : prev.status || CONFIG.DEBT_STATUS.ACTIVE;

        let log = prev.log || "[]";
        if (wasResolved) {
            const entries = parseDebtLog_(log);
            entries.push({
                id: Utilities.getUuid(),
                date: Utilities.formatDate(now, Session.getScriptTimeZone(), "yyyy-MM-dd"),
                time: now.toISOString(),
                actor: "System",
                note: `Daftra still shows this unpaid -- reopened from "${prev.status}".`,
            });
            log = JSON.stringify(entries);
        }

        return [
            d.clientName,
            d.clientId,
            "Long",
            d.amount,
            0,
            status,
            d.phone || "",
            prev.dueDate || "",
            prev.dateGiven || "",
            prev.lastFollowUp || "",
            prev.promiseCount || 0,
            log,
            now,
        ];
    });

    const allRows = longRows.concat(shortRows);

    if (allRows.length > 0) {
        sheet.getRange(2, 1, allRows.length, DEBTS_HEADERS.length).setValues(allRows);
    }

    sheet.autoResizeColumns(1, DEBTS_HEADERS.length);
    sheet.setFrozenRows(1);

    const total = debts.reduce((sum, d) => sum + d.amount, 0);

    Logger.log(
        `Debts snapshot done: ${debts.length} long debts totaling ${total} ` +
            `(plus ${shortRows.length} short debts carried forward unchanged).`,
    );

    return { longCount: debts.length, longTotal: total, shortCount: shortRows.length };
}

function parseDebtLog_(raw) {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
        return [];
    }
}

// ============================================================
// Test functions -- run once from the editor (function dropdown -> pick
// one -> Run, then View > Logs) to sanity-check real field names/shapes
// before the app depends on them. Read-only; safe to run any time.
// ============================================================

function testDaftraConnection() {
    Logger.log("Outstanding debts (first 5): %s", JSON.stringify(getDaftraOutstandingDebts().slice(0, 5), null, 2));
}

// Pass a real product name/SKU fragment you know exists.
function testProducts(query) {
    query = query || "";
    const matches = searchDaftraProducts(query);
    Logger.log("Product matches for %s: %s", query, JSON.stringify(matches, null, 2));

    if (matches.length) {
        const history = getDaftraProductPurchaseHistory(matches[0].id);
        Logger.log("Purchase history for %s (id %s): %s", matches[0].name, matches[0].id, JSON.stringify(history, null, 2));
    } else {
        Logger.log("No product matches -- see testRawProducts() to check the raw response shape.");
    }
}

// Dumps the RAW, unprocessed first page of products.json and
// purchase_invoices.json so we can see Daftra's actual field names
// directly, rather than guessing through daftraExtractList_/daftraUnwrap_.
// Run this if testProducts() comes back empty or missing history.
function testRawProducts() {
    const productsPayload = daftraGet_("products.json", { page: 1, limit: 5 });
    Logger.log("RAW products.json (first page): %s", JSON.stringify(productsPayload, null, 2));

    const purchasesPayload = daftraGet_("purchase_invoices.json", { page: 1, limit: 5 });
    Logger.log("RAW purchase_invoices.json (first page): %s", JSON.stringify(purchasesPayload, null, 2));
}

// The purchase_invoices.json LIST endpoint turned out to return invoice
// headers only, no line items (confirmed 2026-08-21 against a real
// account -- the PurchaseOrder object goes straight from due_date to
// Supplier/Staff, nothing about items). This checks two candidates for
// where line items actually live: (a) the SINGLE invoice detail endpoint,
// and (b) a dedicated stock-transactions endpoint. Pass a real purchase
// invoice id (e.g. one you saw in testRawProducts()' purchase_invoices
// dump, like 5359).
function testRawPurchaseDetail(purchaseInvoiceId) {
    try {
        const detail = daftraGet_(`purchase_invoices/${purchaseInvoiceId}.json`, {});
        Logger.log("RAW single purchase_invoices/%s.json: %s", purchaseInvoiceId, JSON.stringify(detail, null, 2));
    } catch (e) {
        Logger.log("Single purchase invoice fetch failed: %s", e.message);
    }

    try {
        const stock = daftraGet_("stock_transactions.json", { page: 1, limit: 5 });
        Logger.log("RAW stock_transactions.json (first page): %s", JSON.stringify(stock, null, 2));
    } catch (e) {
        Logger.log("stock_transactions.json fetch failed: %s", e.message);
    }
}

// Pass a real client_id you can also look up in the Daftra web UI
// (Reports -> Client Aged Ledger) to compare the balance by hand.
function testClientStatement(clientId) {
    const statement = getDaftraClientStatement(clientId);
    Logger.log("Statement for client %s: %s", clientId, JSON.stringify(statement, null, 2));
}
