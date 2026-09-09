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
        // The top-level "message" is a generic "please fix the errors
        // below" -- the actual per-field reason lives in
        // "validation_errors" (confirmed 2026-08-25 against a real
        // rejected invoice in the main sales-tracker project's Bulk
        // Invoice tool, same Daftra account/API). Pull it out explicitly
        // rather than dumping the whole raw body.
        let detail = body;
        try {
            const parsed = JSON.parse(body);
            if (parsed && parsed.validation_errors) {
                detail = JSON.stringify(parsed.validation_errors);
            }
        } catch (e) {
            // Not JSON -- fall back to the raw body below.
        }

        throw new Error(
            `Daftra API error ${code} on POST ${path}: ${detail.slice(0, 1000)}`,
        );
    }

    return JSON.parse(body);
}

// PUT counterpart of daftraPost_ -- for editing an existing resource.
// Confirmed working 2026-08-31 via a real edit-and-restore test (see
// editDaftraClientPayment_/editDaftraDueInvoice_ below) -- Daftra's api2
// docs don't document update endpoints the way they document
// create/list ones, and it does a FULL REPLACE, not a partial patch: any
// field left out of the payload gets reset to a default rather than left
// alone. Every caller here must read the current record first and carry
// every meaningful field forward unchanged except what's actually being
// corrected.
function daftraPut_(path, payload) {
    const { subdomain, apiKey } = getDaftraConfig_();

    const url = `https://${subdomain}.daftra.com/api2/${path}`;

    const response = UrlFetchApp.fetch(url, {
        method: "put",
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

    return { code, body };
}

// DELETE counterpart -- lets the smoke-test suite (Tests.gs) clean up
// after itself instead of accumulating throwaway rows on the designated
// test client. Confirmed working 2026-09-01 for both invoices.json and
// client_payments.json against real (test-client) records.
function daftraDelete_(path) {
    const { subdomain, apiKey } = getDaftraConfig_();

    const url = `https://${subdomain}.daftra.com/api2/${path}`;

    const response = UrlFetchApp.fetch(url, {
        method: "delete",
        headers: {
            APIKEY: apiKey,
            Accept: "application/json",
        },
        muteHttpExceptions: true,
    });

    return { code: response.getResponseCode(), body: response.getContentText() };
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
// below rather than per-invoice. Also the authoritative source for phone
// now (confirmed 2026-08-28): the invoice-embedded guess below
// (client_phone1/client_phone/client_mobile) never covered "phone2",
// which is where this account's clients actually have their number on
// file more often than not (confirmed directly against a real client's
// edit form -- phone1 was empty, phone2 had the real number). Reading
// straight off the Client resource is also just more correct than
// hoping an invoice happens to embed it.
// A client's balance can also be adjusted through a manual Daftra
// "Journal Entry" (double-entry ledger adjustment, e.g. Reports > General
// Accounts > Journals) rather than an invoice or payment -- deliberately
// NOT accounted for here. Investigated 2026-08-29: journals.json is a
// real, working API endpoint (confirmed against a real entry), but each
// entry only references a journal_account_id (an internal chart-of-
// accounts id), not a client_id, so mapping one back to a specific client
// would need a further, unconfirmed API layer -- and this account has
// 42,000+ journal entries total, which is far too many to scan on every
// refresh regardless. If a client's balance is ever off after a manual
// journal entry, prefer recording that adjustment as an "Add invoice" on
// their card instead (a real Daftra invoice, which this DOES read
// correctly) -- a one-off correction can be applied by hand.
function getClientMetadata_() {
    const metadata = {};
    daftraPaginate_("clients.json", {}, "Client", (clients) => {
        clients.forEach((c) => {
            metadata[c.id] = {
                suspended: String(c.suspend) === "1",
                // String() -- Daftra sometimes hands these back as
                // numbers, not strings, and downstream code assumes a
                // string (.replace(), etc).
                phone: String(c.phone2 || c.phone1 || c.mobile || c.phone || ""),
            };
        });
    });
    return metadata;
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
            // Fallback only -- getClientMetadata_() below is the real
            // source now. Kept in case an invoice-embedded phone is ever
            // present for a client the metadata pass somehow missed.
            const phone = String(inv.client_phone2 || inv.client_phone1 || inv.client_phone || inv.client_mobile || "");

            if (!balances[id]) {
                balances[id] = { clientId: id, clientName: name, amount: 0, phone };
            }
            balances[id].amount += unpaid;
            if (!balances[id].phone && phone) balances[id].phone = phone;
        });
    });

    // REVERTED 2026-08-30 -- this used to also subtract a second,
    // full-account pass over client_payments.json here, added 2026-08-29
    // on the theory that summary_unpaid never reflects a payment credited
    // straight to the account (client 404: summing summary_unpaid gave
    // 309, but Daftra's own page said 328). That theory was wrong.
    // Checked both clients directly against their live Daftra pages
    // today: client 209 has 19,549 in direct client_payments against
    // 6,907 in currently-open invoices -- Daftra's own "Amount Due" is
    // 6,907, i.e. NOT netted against those payments, confirming Daftra
    // applies a client_payment into the relevant invoice's summary_unpaid
    // itself (already verified live in an earlier real test-payment check
    // on client 493 -- the balance moved immediately). The subtraction
    // was double-counting that, which had been silently corrupting every
    // Long debtor's balance for a day, in client 209's case hiding a real
    // 6,907 SAR debt entirely (amount went negative -> filtered out
    // below). Client 404's real page today is 328, vs this function's
    // 309 -- an 19 SAR gap, not the 100 the original theory blamed on a
    // manual journal entry, but still much closer than the netted 228 was
    // -- that gap is exactly what the manual "needs reconciliation" flag
    // (client 404 already has it set) exists to cover by hand.
    const metadata = getClientMetadata_();

    return Object.values(balances)
        .filter((d) => d.amount > 0)
        .filter((d) => !(metadata[d.clientId] && metadata[d.clientId].suspended))
        .map((d) => {
            const clientPhone = metadata[d.clientId] && metadata[d.clientId].phone;
            return clientPhone ? Object.assign({}, d, { phone: clientPhone }) : d;
        })
        .sort((a, b) => b.amount - a.amount);
}

// ============================================================
// Long Debtor account activity -- assembled from invoices + both kinds of
// payment, since Daftra has no single "client statement" API endpoint
// (confirmed by research; statements/aged-ledger are web-report-only).
//
// Shows the last 5 records by COUNT, not a date window -- a 30-day
// window (the original design) went empty for any client who'd simply
// gone quiet for over a month, which is common enough here that the
// owner asked for record-count-based recency instead (2026-08-26). The
// headline "Balance" the app shows stays the debtor's already-known total
// (from the Debts Snapshot / getDaftraOutstandingDebts, computed off
// Daftra's summary_unpaid) -- NOT recomputed from this list, since these
// are just the 5 most recent entries, not a full running total.
// ============================================================

// Daftra stamps its own running account balance onto extra_details at
// the moment each invoice/payment is written (confirmed 2026-08-30 while
// investigating the client_payments-subtraction bug) -- shown here
// purely as read-only context alongside each entry (like a bank
// statement's running-balance column), never used in any of this app's
// own balance math.
function daftraEntryRunningBalance_(item) {
    try {
        const parsed = JSON.parse(item.extra_details || "{}");
        return parsed.client_balance != null ? Number(parsed.client_balance) : null;
    } catch (e) {
        return null;
    }
}

function getDaftraClientStatement(clientId) {
    const entries = []; // { date, type, description, amount, remaining }

    fetchDaftraRecentEntries_("invoices.json", { client_id: clientId }, "Invoice").forEach((inv) => {
        entries.push({
            id: inv.id,
            date: inv.date || inv.created,
            type: "invoice",
            description: `Invoice #${inv.no || inv.id}`,
            amount: Number(inv.summary_total) || 0,
            remaining: daftraEntryRunningBalance_(inv),
        });
    });

    // "invoice_payment" and "client_payment" are the same underlying
    // Daftra record under two different API resource names (confirmed
    // 2026-08-31) -- both edit the same way, via editDaftraClientPayment_.
    fetchDaftraRecentEntries_("invoice_payments.json", { client_id: clientId }, "InvoicePayment").forEach((p) => {
        entries.push({
            id: p.id,
            date: p.date,
            type: "invoice_payment",
            description: `Payment on invoice #${p.invoice_id}`,
            amount: -(Number(p.amount) || 0),
            remaining: daftraEntryRunningBalance_(p),
        });
    });

    fetchDaftraRecentEntries_("client_payments.json", { client_id: clientId }, "ClientPayment").forEach((p) => {
        entries.push({
            id: p.id,
            date: p.date,
            type: "client_payment",
            description: p.notes || "Account payment",
            amount: -(Number(p.amount) || 0),
            remaining: daftraEntryRunningBalance_(p),
        });
    });

    entries.sort((a, b) => new Date(b.date) - new Date(a.date));

    return { entries: entries.slice(0, 5) };
}

// Fetches just the TAIL of a client-filtered, paginated Daftra list --
// the last 2 pages, not a client's entire history -- since this account's
// list endpoints are consistently oldest-first (confirmed via
// stock_transactions.json, 2026-08-21), so the most recent activity sits
// at the END of the pagination. A single client here can have thousands
// of records (one has 2,680 invoices), so scanning everything just to
// find the 5 newest would reintroduce the exact 20-30+ second slowness
// this account statement was already fixed once for. Bounded to at most
// 2 requests regardless of how much history the client has.
function fetchDaftraRecentEntries_(path, params, unwrapKey) {
    const limit = 100;
    const first = daftraGet_(path, Object.assign({}, params, { page: 1, limit }));
    const firstItems = daftraExtractList_(first).map((item) => daftraUnwrap_(item, unwrapKey));

    const pageCount = first && first.pagination && Number(first.pagination.page_count);
    if (!pageCount || pageCount <= 1) return firstItems;

    const items = [];
    [pageCount - 1, pageCount].forEach((page) => {
        if (page < 1) return;
        const payload = page === 1 ? first : daftraGet_(path, Object.assign({}, params, { page, limit }));
        daftraExtractList_(payload)
            .map((item) => daftraUnwrap_(item, unwrapKey))
            .forEach((item) => items.push(item));
    });

    return items;
}

// Records a payment directly to a client's account (not tied to one
// invoice) -- what "Add payment" in the app calls.
//
// The original guess ({ClientPayment: {client_id, amount, date, notes}})
// was missing THREE required fields, confirmed one at a time against a
// real test client (id 493) on 2026-08-28:
//   - treasury_id (which cash/bank account the money lands in) and
//     payment_method -- without these Daftra returned a "successful"
//     202 response with id:null and created nothing at all (not even a
//     pending record).
//   - status -- without this the payment record WAS created (a real id,
//     correctly linked to the client) but sat in a "تأكيد الدفع"/Confirm
//     Payment pending state forever and never counted toward the
//     client's balance. 1 = "مكتمل" (Complete).
// All three field names/values came directly from Daftra's own "Add
// payment credit" web form (client page), not guessed. treasury_id 1 =
// "الخزينة الاساسية" (Main Treasury) -- reasonable default for a cash
// payment collected by an employee.
function addDaftraClientPayment(clientId, amount, note) {
    const payload = {
        ClientPayment: {
            client_id: clientId,
            amount: amount,
            date: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd"),
            notes: note || "",
            treasury_id: 1,
            payment_method: "cash",
            // Without this the payment is created but sits in a pending
            // "needs confirmation" state and never counts toward the
            // client's balance -- confirmed 2026-08-28 (a test payment
            // with no status showed a "تأكيد الدفع"/Confirm Payment button
            // and the balance never moved). 1 = "مكتمل" (Complete).
            status: 1,
            // Leaving this out made the payment land in a separate,
            // un-aggregated currency line on the client's account instead
            // of merging into the main SAR balance (confirmed 2026-08-28:
            // the payment counted, but a second "-1.00" summary row
            // appeared next to the real one instead of the total
            // decreasing). This account only uses SAR.
            currency_code: "SAR",
        },
    };

    return daftraPost_("client_payments.json", payload);
}

// Corrects the amount on an EXISTING Long Debtor payment, in Daftra
// itself -- owner's request, 2026-08-31. Covers both the "invoice_
// payment" and "client_payment" entries the account statement shows;
// confirmed 2026-08-31 (comparing the web UI's own edit form against both
// API resource names) they're the same underlying record, just exposed
// under two different API model-name wrappers, so client_payments/{id}
// .json works for either.
//
// Daftra's PUT here does a full replace, not a partial patch -- any field
// left out of the payload gets reset to a default rather than left alone
// (confirmed via a real edit-and-restore test against a throwaway test
// payment: an amount-only PUT silently wiped the payment's date to today
// and its staff attribution). So this always reads the current record
// first and carries every meaningful field forward unchanged except the
// amount being corrected.
function editDaftraClientPayment_(paymentId, clientId, newAmount) {
    // A single-resource GET comes back as {result, code, data:
    // {ClientPayment: {...}}} -- daftraUnwrap_ only handles the LIST
    // shape (each item's own model-name key), not this envelope, so this
    // reaches directly into .data instead.
    const current = daftraGet_(`client_payments/${paymentId}.json`, {});
    const p = current && current.data && current.data.ClientPayment;

    if (!p || !p.id) {
        throw new Error("That payment couldn't be found in Daftra.");
    }
    if (String(p.client_id) !== String(clientId)) {
        throw new Error("That payment doesn't belong to this client -- refresh and try again.");
    }

    const dateOnly = String(p.date || "").split(" ")[0];

    return daftraPut_(`client_payments/${paymentId}.json`, {
        ClientPayment: {
            amount: newAmount,
            date: dateOnly,
            payment_method: p.payment_method || "cash",
            treasury_id: p.treasury_id || 1,
            status: p.status || 1,
            currency_code: p.currency_code || "SAR",
            notes: p.notes || "",
        },
    });
}

// ============================================================
// "Add invoice" -- creates a real Daftra due invoice against a Long
// Debtor's account (the Daftra-side counterpart to addDaftraClientPayment
// above). Every customer-debt invoice in this shop is recorded against
// this one fixed service instead of itemizing real products -- id
// confirmed directly from the product's own Daftra page
// (https://muaath20002024.daftra.com/owner/products/view/1615), the same
// service id the Bulk Invoice tool in the main sales-tracker project uses
// (src/GS/BulkInvoice.gs there).
// ============================================================

const DUE_INVOICE_SERVICE_ID = 1615;
const DUE_INVOICE_SERVICE_NAME = "فاتورة مستحقة";

function createDaftraDueInvoice_(clientId, amount, note) {
    const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd");

    const invoiceFields = {
        client_id: clientId,
        date: today,
        issue_date: today,
        draft: 0,
        // Always sent, even when not required -- Daftra rejects invoice
        // creation outright for a client whose "invoicing method" is set
        // to Email if this is missing (confirmed 2026-08-25, same Daftra
        // account, via the Bulk Invoice tool). ".invalid" is the domain
        // suffix RFC 2606 reserves for addresses that are never meant to
        // be real/deliverable.
        client_email: `client${clientId}@placeholder.invalid`,
    };

    const item = {
        item: note ? `${DUE_INVOICE_SERVICE_NAME} -- ${note}` : DUE_INVOICE_SERVICE_NAME,
        quantity: 1,
        unit_price: Number(amount) || 0,
        product_id: DUE_INVOICE_SERVICE_ID,
    };

    const result = daftraPost_("invoices.json", { Invoice: invoiceFields, InvoiceItem: [item] });
    const invoice = daftraUnwrap_(result, "Invoice") || result;

    return { id: invoice.id, no: invoice.no || invoice.invoice_number || invoice.id };
}

// Corrects the amount on an EXISTING Long Debtor invoice, in Daftra
// itself -- owner's request, 2026-08-31. Only handles the simple,
// single-line-item "due invoice" shape createDaftraDueInvoice_() above
// creates (every invoice this app writes looks like that) -- refuses
// anything else rather than guessing at a more complex invoice's
// structure.
//
// Same full-replace risk as editDaftraClientPayment_() above, confirmed
// worse here in real testing: an edit that only sent the changed
// unit_price silently reassigned the invoice to a brand new sequential
// invoice NUMBER and reset both dates to 01/01/1970. Explicitly carrying
// forward no/date/issue_date/due_after (Invoice) and
// id/item/product_id/tax1/store_id (InvoiceItem), changing only
// unit_price, fixed that in the same test -- restoring the original
// number and dates exactly. Also refuses to touch an invoice already
// submitted to e-invoicing (ZATCA) -- Saudi e-invoicing rules require a
// credit note for a correction after submission, not a silent edit.
function editDaftraDueInvoice_(invoiceId, clientId, newAmount) {
    // See editDaftraClientPayment_()'s comment -- same envelope shape.
    const current = daftraGet_(`invoices/${invoiceId}.json`, {});
    const inv = current && current.data && current.data.Invoice;

    if (!inv || !inv.id) {
        throw new Error("That invoice couldn't be found in Daftra.");
    }
    if (String(inv.client_id) !== String(clientId)) {
        throw new Error("That invoice doesn't belong to this client -- refresh and try again.");
    }
    if (inv.e_invoice_status) {
        throw new Error(
            "This invoice was already submitted to e-invoicing (ZATCA) -- it can't be silently edited. " +
                "Record a credit note in Daftra instead.",
        );
    }

    const items = inv.InvoiceItem || [];
    if (items.length !== 1 || String(items[0].product_id) !== String(DUE_INVOICE_SERVICE_ID)) {
        throw new Error(
            "This invoice isn't a simple due-invoice this app can edit -- correct it directly in Daftra instead.",
        );
    }

    const item = items[0];
    // date/issue_date come back as "dd/mm/yyyy" on the invoice detail
    // (unlike a payment's "yyyy-mm-dd hh:mm:ss") -- convert before
    // sending back, since the create path always sends "yyyy-MM-dd".
    const toIso = (d) => {
        const parts = String(d || "").split("/");
        return parts.length === 3 ? `${parts[2]}-${parts[1]}-${parts[0]}` : d;
    };

    return daftraPut_(`invoices/${invoiceId}.json`, {
        Invoice: {
            id: inv.id,
            client_id: inv.client_id,
            no: inv.no,
            date: toIso(inv.date),
            issue_date: toIso(inv.issue_date),
            due_after: inv.due_after || 0,
        },
        InvoiceItem: [
            {
                id: item.id,
                item: item.item,
                quantity: item.quantity || 1,
                unit_price: newAmount,
                product_id: item.product_id,
                tax1: item.tax1 || null,
                store_id: item.store_id || 1,
            },
        ],
    });
}

// Sum of summary_unpaid across just ONE client's invoices. Used right
// after createDaftraDueInvoice_()/addDaftraClientPayment() to refresh
// that single row's balance in the Debts Snapshot sheet without paying
// for a full refreshDebtsSnapshot() (which re-scans the whole account).
// See getDaftraOutstandingDebts()'s comment above -- no longer subtracts
// client_payments.json here either, for the same reason (double-counts a
// reduction Daftra already applies into summary_unpaid itself).
function getSingleClientBalance_(clientId) {
    let total = 0;

    daftraPaginate_("invoices.json", { client_id: clientId }, "Invoice", (invoices) => {
        invoices.forEach((inv) => {
            total += Number(inv.summary_unpaid) || 0;
        });
    });

    return Math.max(0, total);
}

// ============================================================
// Client rename + suspend -- added 2026-09-08 for the Daftra Client ->
// Notebook Client migration workflow (disableDaftraClient() in
// Migrations.gs).
//
// "business_name" IS the right field -- confirmed 2026-09-09 via
// testRawClient() against the designated test client. The FIRST version of
// this function instead PUT the entire GET response back (every field
// clients/{id}.json returns, via Object.assign), on the theory that
// carrying everything forward unchanged was the safest guess when the
// writable-field shape wasn't known -- confirmed WRONG the same day, live
// against a real client (#526): Daftra rejected it with a 400
// error_type "extra_data". Some of what a GET returns is clearly
// read-only/computed (id, site_id, client_number, created, modified,
// last_login, last_ip, link) or a static UI caption, not data at all
// (bn1_label/bn2_label literally return "الرقم الضريبي"/"Unified Tax
// Number") -- Daftra's PUT validator rejects a payload containing those.
// Fixed below to an explicit allowlist of genuine profile fields instead
// (same pattern editDaftraClientPayment_/editDaftraDueInvoice_ already use
// for their own resources) -- still a best-effort list, not confirmed
// exhaustive, so run testClientRenameSuspendRoundTrip() (Tests.gs) against
// the designated test client after any future change here, before trusting
// it against a real client again.
// ============================================================

function getDaftraClient_(clientId) {
    const current = daftraGet_(`clients/${clientId}.json`, {});
    const client = current && current.data && current.data.Client;

    if (!client || !client.id) {
        throw new Error("That Daftra client couldn't be found.");
    }

    return client;
}

// Explicit allowlist of genuine profile fields -- NOT the whole GET
// response. See this section's header comment for why (a full-record
// spread got a real 400 "extra_data" from Daftra, since some of what GET
// returns is read-only/computed metadata or a static UI caption, not
// writable client data). Deliberately excludes: id, is_offline,
// client_number, site_id, staff_id, created, modified, last_login,
// last_ip, link, follow_up_status/secondary_follow_up_status,
// original_site_id, group_price_id, timezone, bn1_label/bn2_label (UI
// captions, not data), starting_balance, photo, birth_date, gender,
// map_location, language_code, extra_details. Shared by
// daftraDisableClient_() below and Tests.gs's
// testClientRenameSuspendRoundTrip() (its restore step needs the exact
// same allowlist, not a second copy of it).
function daftraClientProfilePayload_(client, overrides) {
    return Object.assign(
        {
            first_name: client.first_name,
            last_name: client.last_name,
            email: client.email,
            address1: client.address1,
            address2: client.address2,
            city: client.city,
            state: client.state,
            postal_code: client.postal_code,
            phone1: client.phone1,
            phone2: client.phone2,
            country_code: client.country_code,
            notes: client.notes,
            default_currency_code: client.default_currency_code,
            national_id: client.national_id,
            category: client.category,
            category_id: client.category_id,
            bn1: client.bn1,
            bn2: client.bn2,
            type: client.type,
            credit_limit: client.credit_limit,
            credit_period: client.credit_period,
            branch_id: client.branch_id,
            active_secondary_address: client.active_secondary_address,
            secondary_name: client.secondary_name,
            secondary_address1: client.secondary_address1,
            secondary_address2: client.secondary_address2,
            secondary_city: client.secondary_city,
            secondary_state: client.secondary_state,
            secondary_postal_code: client.secondary_postal_code,
            secondary_country_code: client.secondary_country_code,
            business_name: client.business_name,
            suspend: client.suspend,
        },
        overrides,
    );
}

// Full-replace PUT, same discipline as editDaftraClientPayment_/
// editDaftraDueInvoice_ above -- reads the current record first and
// carries every genuine profile field forward unchanged except
// business_name (rename) and suspend (disable), since daftraPut_ resets
// any omitted field to a default rather than leaving it alone.
function daftraDisableClient_(clientId, newName) {
    const client = getDaftraClient_(clientId);
    const payload = daftraClientProfilePayload_(client, { business_name: newName, suspend: 1 });

    const result = daftraPut_(`clients/${clientId}.json`, { Client: payload });

    // daftraPut_ doesn't throw on a non-2xx response (unlike daftraGet_/
    // daftraPost_) -- checked explicitly here since this backs a
    // destructive operation that must never be reported as successful
    // unless Daftra actually confirmed it.
    if (result.code < 200 || result.code >= 300) {
        throw new Error(
            `Daftra API error ${result.code} renaming/suspending client ${clientId}: ${String(result.body).slice(0, 500)}`,
        );
    }

    return result;
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
//
// Reads from the "Products Cache" sheet rather than paginating Daftra live
// -- with 1,500+ products that was ~16 sequential Daftra API calls on
// EVERY sync (every app open / "Sync now" tap), which is what made the app
// feel slow (2026-08-25). The cache is refreshed by
// refreshProductsCache(), piggybacked on the existing "Refresh from
// Daftra" button. Falls back to a live fetch if the cache is empty (e.g.
// the very first run before anyone has hit refresh) so this never just
// returns nothing.
function getAllProducts() {
    const sheet = getSheet_().getSheetByName(CONFIG.SHEETS.PRODUCTS_CACHE);
    const lastRow = sheet && sheet.getLastRow();

    if (!sheet || lastRow < 2) {
        return fetchAllProductsFromDaftra_();
    }

    return sheet
        .getRange(2, 1, lastRow - 1, 3)
        .getValues()
        .filter((row) => row[0] !== "" && row[0] != null)
        // Sheets hands back a numeric-looking cell (a common SKU shape,
        // e.g. "2038") as a JS number, not a string -- confirmed
        // 2026-08-26 as the cause of product search crashing outright on
        // .toLowerCase() client-side. String() everything read from a
        // sheet cell, not just SKU, since the same trap applies to any of
        // them.
        .map((row) => ({ id: row[0], name: String(row[1] || ""), sku: String(row[2] || "") }));
}

// Live pagination through Daftra's product catalog -- see getAllProducts()
// for why this is cached rather than called on every sync.
function fetchAllProductsFromDaftra_() {
    const products = [];
    daftraPaginate_("products.json", {}, "Product", (items) => {
        items.forEach((p) => {
            if (String(p.deactivate) === "1") return; // e.g. "[ قديم ]"-prefixed retired products
            products.push({
                id: p.id,
                name: String(p.name || p.product_name || ""),
                sku: String(p.product_code || p.sku || ""),
            });
        });
    });
    return products;
}

// Re-pulls the full product catalog from Daftra and overwrites the
// "Products Cache" sheet -- called from refreshDebtsFromApp() so the
// existing "Refresh from Daftra" button keeps both debtor balances and the
// product catalog current in one tap.
function refreshProductsCache() {
    const products = fetchAllProductsFromDaftra_();

    const ss = getSheet_();
    let sheet = ss.getSheetByName(CONFIG.SHEETS.PRODUCTS_CACHE);

    if (!sheet) {
        sheet = ss.insertSheet(CONFIG.SHEETS.PRODUCTS_CACHE);
    }

    sheet.clear();
    sheet.getRange(1, 1, 1, 3).setValues([["Product ID", "Name", "SKU"]]).setFontWeight("bold");

    if (products.length > 0) {
        sheet
            .getRange(2, 1, products.length, 3)
            .setValues(products.map((p) => [p.id, p.name, p.sku]));
    }

    sheet.autoResizeColumns(1, 3);
    sheet.setFrozenRows(1);

    return { productCount: products.length };
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
// Product price cache -- getDaftraProductPurchaseHistory() above is a
// real, slow live Daftra lookup (a stock_transactions scan across up to
// 80 pages, then a purchase-invoice detail fetch per match). There's no
// practical way to pre-compute this for the WHOLE catalog upfront (this
// account alone has 56,000+ stock_transactions rows -- see that
// function's header comment), so instead each product's result is cached
// the FIRST time anyone looks it up. Every search after that -- from any
// employee, any device -- reads a sheet row instead of repeating the
// slow scan (owner's request, 2026-08-27: "loading last price and
// supplier is really slow, cache it"). Entries expire after
// PRODUCT_PRICE_CACHE_MAX_AGE_DAYS so prices don't go stale forever.
// ============================================================

function getDaftraProductPurchaseHistoryCached_(productId) {
    const cached = getCachedProductPurchaseHistory_(productId);
    if (cached) return cached;

    const history = getDaftraProductPurchaseHistory(productId);
    setCachedProductPurchaseHistory_(productId, history);
    return history;
}

function getCachedProductPurchaseHistory_(productId) {
    const sheet = getSheet_().getSheetByName(CONFIG.SHEETS.PRODUCT_PRICE_CACHE);
    const lastRow = sheet && sheet.getLastRow();
    if (!sheet || lastRow < 2) return null;

    const rows = sheet.getRange(2, 1, lastRow - 1, 3).getValues();

    for (const row of rows) {
        if (String(row[0]) !== String(productId)) continue;

        const cachedAt = row[2];
        const ageDays = cachedAt ? (Date.now() - new Date(cachedAt).getTime()) / 86400000 : Infinity;
        if (ageDays > CONFIG.PRODUCT_PRICE_CACHE_MAX_AGE_DAYS) return null; // stale -- fall through to a live re-fetch

        try {
            return JSON.parse(row[1]);
        } catch (e) {
            return null; // corrupt cell -- treat as a miss rather than throwing
        }
    }

    return null;
}

function setCachedProductPurchaseHistory_(productId, history) {
    const ss = getSheet_();
    let sheet = ss.getSheetByName(CONFIG.SHEETS.PRODUCT_PRICE_CACHE);

    if (!sheet) {
        sheet = ss.insertSheet(CONFIG.SHEETS.PRODUCT_PRICE_CACHE);
        sheet.getRange(1, 1, 1, 3).setValues([["Product ID", "History JSON", "Cached At"]]).setFontWeight("bold");
        sheet.setFrozenRows(1);
    }

    const lastRow = sheet.getLastRow();
    const now = new Date();

    if (lastRow >= 2) {
        const ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
        for (let i = 0; i < ids.length; i++) {
            if (String(ids[i][0]) === String(productId)) {
                sheet.getRange(2 + i, 1, 1, 3).setValues([[productId, JSON.stringify(history), now]]);
                return;
            }
        }
    }

    sheet.appendRow([productId, JSON.stringify(history), now]);
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
    // Appended rather than inserted among the others (2026-08-25) so
    // existing column-index reads elsewhere in this file/Debts.gs didn't
    // all need renumbering. Who extended this debt on credit -- mainly
    // meaningful for Short (notebook) debtors; Long debtors don't have a
    // per-sale staff attribution in Daftra, so this is usually blank for
    // them, just preserved across refreshes like the other follow-up
    // fields in case an owner wants to set it there too.
    "Creditor",
    // Manual flag (owner's request, 2026-08-29): our balance calc has no
    // way to detect a client whose Daftra balance includes a manual
    // journal entry (see getClientMetadata_()'s header comment for why
    // that can't be automated) -- this is a plain owner-set marker,
    // shown as a warning tag on the card, cleared by hand once resolved.
    "Needs Reconciliation",
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
    // A PREFIX match, not an exact one -- appending a new column to
    // DEBTS_HEADERS (e.g. "Needs Reconciliation" on 2026-08-29) must not
    // make this treat the on-disk sheet as a foreign layout, or the
    // preserve-existing-rows block below gets skipped entirely and
    // sheet.clear() wipes every hand-entered Short debtor (confirmed real
    // data loss, 2026-08-29 -- exact-match check required identical
    // length, so a single appended header column silently discarded the
    // whole Short debtor list on the next refresh).
    const headerMatches =
        currentHeaders.length > 0 &&
        currentHeaders.every((h, i) => h === DEBTS_HEADERS[i]);

    // Fail loud instead of silently wiping -- if the on-disk header is
    // neither a match nor a recognized prefix of DEBTS_HEADERS, this is an
    // incompatible layout (e.g. a column got renamed/reordered, not just
    // appended). Proceeding would clear() the sheet and rewrite only the
    // Long/Daftra rows, discarding every Short debtor -- exactly what
    // happened 2026-08-29. Whoever changes the header layout from here on
    // must write a one-off migration and run it once so this check passes.
    if (lastRow > 1 && currentHeaders.length > 0 && !headerMatches) {
        throw new Error(
            "Debts Snapshot header layout doesn't match DEBTS_HEADERS -- refusing to run " +
                "refreshDebtsSnapshot to avoid silently wiping existing rows. Write a one-off " +
                "migration for the new layout, run it once, then this will pass automatically.",
        );
    }

    // Independent safety net, decoupled from the preserve logic above --
    // mirrors whatever Short debtor rows are on disk right now into a
    // separate backup sheet before anything here touches the main sheet.
    // If a future bug (in this function or anywhere else) corrupts or
    // drops Short debtors again, this tab is a same-spreadsheet recovery
    // point that doesn't require digging through Sheets version history.
    backupShortDebtRows_(sheet);

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
                    creditor: row[13] || "",
                    needsReconciliation: row[14] === true,
                };
            });
    }

    sheet.clear();

    const now = new Date();

    sheet
        .getRange(1, 1, 1, DEBTS_HEADERS.length)
        .setValues([DEBTS_HEADERS])
        .setFontWeight("bold");

    // Force the Phone column to plain text -- sheet.clear() above wipes
    // any number format along with the content, and Sheets auto-converts
    // a numeric-looking value (any phone starting with a country/area
    // code like "9665...") to an actual number on write, silently
    // dropping leading zeros (confirmed 2026-08-28: "00966537680173"
    // came back as the number 966537680173). "@" is Sheets' plain-text
    // format code. Applied to a generous row range since this runs
    // before we know exactly how many rows will be written.
    sheet.getRange(2, 7, 5000, 1).setNumberFormat("@");

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
            prev.creditor || "",
            prev.needsReconciliation || false,
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

// Mirrors whatever Short debtor rows currently exist in the Debts Snapshot
// sheet into a separate "Short Debtors Backup" tab, overwriting it each
// time. Called at the very start of refreshDebtsSnapshot(), before that
// function touches the main sheet at all -- deliberately independent of
// its preserve-existing-rows logic, so a future bug there doesn't take
// this safety net down with it. Skips overwriting if it finds zero Short
// rows, so a genuine bug that empties the main sheet doesn't also erase
// the one copy that could recover from it.
function backupShortDebtRows_(sheet) {
    const lastRow = sheet.getLastRow();
    if (lastRow <= 1) return;

    const rows = sheet.getRange(2, 1, lastRow - 1, DEBTS_HEADERS.length).getValues();
    const shortRows = rows.filter(
        (row) => row[1] !== "" && row[1] != null && row[2] === "Short",
    );

    if (shortRows.length === 0) return;

    const ss = getSheet_();
    let backupSheet = ss.getSheetByName(CONFIG.SHEETS.SHORT_DEBTS_BACKUP);
    if (!backupSheet) {
        backupSheet = ss.insertSheet(CONFIG.SHEETS.SHORT_DEBTS_BACKUP);
    }

    backupSheet.clear();
    backupSheet
        .getRange(1, 1, 1, DEBTS_HEADERS.length)
        .setValues([DEBTS_HEADERS])
        .setFontWeight("bold");
    backupSheet
        .getRange(1, DEBTS_HEADERS.length + 2, 1, 1)
        .setValue(`Backed up ${Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm")}`);
    backupSheet.getRange(2, 7, shortRows.length, 1).setNumberFormat("@");
    backupSheet.getRange(2, 1, shortRows.length, DEBTS_HEADERS.length).setValues(shortRows);
    backupSheet.autoResizeColumns(1, DEBTS_HEADERS.length);
    backupSheet.setFrozenRows(1);
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

// One-off diagnostic for the "عميل جملة" (client 4) balance bug
// (2026-08-25): the PWA showed 252,515 owed, but Daftra's own Aged Ledger
// / account statement say 20.03. Confirmed by hand in the Daftra web UI
// that invoice #008689 (site id 8773) for this client is a DRAFT
// ("مسودة") worth ~252,515, with its payment later deleted -- theory is
// getDaftraOutstandingDebts() sums summary_unpaid from EVERY invoice
// invoices.json returns, including drafts, which Daftra's own reports
// correctly exclude. This dumps the raw invoice object so we can see
// which field actually marks it as a draft before writing the filter.
function testDraftInvoiceIssue() {
    daftraPaginate_("invoices.json", { client_id: 4 }, "Invoice", (invoices) => {
        invoices.forEach((inv) => {
            if (String(inv.no) === "008689" || Number(inv.summary_unpaid) > 100000) {
                Logger.log("Found suspect invoice: %s", JSON.stringify(inv, null, 2));
            }
        });
    });
}
