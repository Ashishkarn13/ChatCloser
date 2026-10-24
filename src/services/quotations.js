// src/services/quotations.js
// Quotations, invoices and expenses.
//
// A quotation is a priced document sent to a customer before they commit.
// An invoice is the same thing once money is owed. Both are built from the
// same pricing code as orders, so the three can never disagree about what
// something costs.

import { getDb } from "../db/connection.js";
import { audit } from "../core/audit.js";
import { NotFoundError, ValidationError } from "../core/errors.js";
import { str, num, jsonArray, jsonObject } from "../core/validation.js";
import { computeTotals, roundMoney } from "../core/money.js";
import { getBusinessConfig } from "./businesses.js";

function nextNumber(businessId, table, prefix) {
  const db = getDb();
  const year = new Date().getFullYear();
  const fullPrefix = `${prefix}-${year}-`;
  const row = db
    .prepare(`SELECT number FROM ${table} WHERE business_id = ? AND number LIKE ? ORDER BY id DESC LIMIT 1`)
    .get(businessId, `${fullPrefix}%`);
  let next = 1;
  if (row?.number) {
    const tail = Number(String(row.number).slice(fullPrefix.length));
    if (Number.isFinite(tail)) next = tail + 1;
  }
  return `${fullPrefix}${String(next).padStart(4, "0")}`;
}

// ---------- quotations ----------

export function listQuotations(businessId, { status = null, customerId = null, limit = 100 } = {}) {
  const db = getDb();
  const where = ["business_id = ?"];
  const params = [businessId];
  if (status) {
    where.push("status = ?");
    params.push(status);
  }
if (customerId) {
    where.push("customer_id = ?");
    params.push(customerId);
  }
  params.push(Math.min(Number(limit) || 100, 500));
  return db
    .prepare(`SELECT * FROM quotations WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`)
    .all(...params)
    .map((r) => ({ ...r, items: jsonArray(r.items) }));
}

export function getQuotation(businessId, quotationId) {
  const db = getDb();
  const row = db.prepare("SELECT * FROM quotations WHERE business_id = ? AND id = ?").get(businessId, quotationId);
  if (!row) throw new NotFoundError("No such quotation.");
  return { ...row, items: jsonArray(row.items) };
}

export function createQuotation(businessId, input, actor = "system") {
  const db = getDb();
  const business = getBusinessConfig(businessId);
  const items = jsonArray(input.items).map((item) => ({
    name: String(item.name || ""),
    quantity: Number(item.quantity) || 0,
    unitPrice: Number(item.unitPrice) || 0,
    taxRate: Number(item.taxRate ?? business.tax_rate ?? 0),
    discountAmount: Number(item.discountAmount) || 0,
  }));

  if (items.length === 0) throw new ValidationError("A quotation needs at least one line item.");

  const totals = computeTotals(items, {
    taxRate: business.tax_enabled ? business.tax_rate || 0 : 0,
    taxInclusive: Boolean(business.tax_inclusive),
    discountAmount: num(input.discountAmount, { field: "discountAmount", min: 0 }) ?? 0,
    deliveryAmount: num(input.deliveryAmount, { field: "deliveryAmount", min: 0 }) ?? 0,
  });

  const number = nextNumber(businessId, "quotations", "QUO");
  const info = db
    .prepare(
      `INSERT INTO quotations
         (business_id, number, customer_id, status, currency, items, subtotal, discount_amount,
          tax_amount, total, valid_until, notes, terms, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      businessId,
      number,
      input.customerId ?? null,
      input.status || "draft",
      business.currency,
      JSON.stringify(items),
      totals.subtotal,
      totals.discountAmount,
      totals.taxAmount,
      totals.total,
      str(input.valid_until, { field: "valid_until", max: 40 }),
      str(input.notes, { field: "notes", max: 4000 }),
      str(input.terms, { field: "terms", max: 4000 }),
      actor
    );

  const id = Number(info.lastInsertRowid);
  audit({ businessId, actor, action: "quotation.created", details: { quotation_id: id, number, total: totals.total } });
  return getQuotation(businessId, id);
}

/** Builds a quotation from an existing order's lines. */
export function createQuotationFromOrder(businessId, orderId, actor = "system") {
  const db = getDb();
  const order = db.prepare("SELECT * FROM orders WHERE business_id = ? AND id = ?").get(businessId, orderId);
  if (!order) throw new NotFoundError("No such order.");

  const items = db
    .prepare("SELECT * FROM order_items WHERE order_id = ? ORDER BY id")
    .all(orderId)
    .map((i) => ({
      name: i.name,
      quantity: i.quantity,
      unitPrice: i.unit_price,
      taxRate: i.tax_rate,
      discountAmount: i.discount_amount,
    }));

  return createQuotation(
    businessId,
    {
      customerId: order.customer_id,
      items,
      notes: `Quotation for order ${order.order_number || order.id}`,
      status: "sent",
    },
    actor
  );
}

export function updateQuotationStatus(businessId, quotationId, status, actor = "system") {
  const allowed = ["draft", "sent", "accepted", "rejected", "expired"];
  if (!allowed.includes(status)) {
    throw new ValidationError(`Status must be one of: ${allowed.join(", ")}.`);
  }
  const db = getDb();
  getQuotation(businessId, quotationId);
  db.prepare(
    "UPDATE quotations SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE business_id = ? AND id = ?"
  ).run(status, businessId, quotationId);
  audit({ businessId, actor, action: "quotation.status_changed", details: { quotation_id: quotationId, status } });
  return getQuotation(businessId, quotationId);
}

// ---------- invoices ----------

export function listInvoices(businessId, { status = null, customerId = null, limit = 100 } = {}) {
  const db = getDb();
  const where = ["business_id = ?"];
  const params = [businessId];
  if (status) {
    where.push("status = ?");
    params.push(status);
  }
  if (customerId) {
    where.push("customer_id = ?");
    params.push(customerId);
  }
  params.push(Math.min(Number(limit) || 100, 500));
  return db
    .prepare(`SELECT * FROM invoices WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`)
    .all(...params)
    .map((r) => ({ ...r, items: jsonArray(r.items) }));
}

export function getInvoice(businessId, invoiceId) {
  const db = getDb();
  const row = db.prepare("SELECT * FROM invoices WHERE business_id = ? AND id = ?").get(businessId, invoiceId);
  if (!row) throw new NotFoundError("No such invoice.");
  return { ...row, items: jsonArray(row.items) };
}

export function createInvoice(businessId, input, actor = "system") {
  const db = getDb();
  const business = getBusinessConfig(businessId);
  const items = jsonArray(input.items).map((item) => ({
    name: String(item.name || ""),
    quantity: Number(item.quantity) || 0,
    unitPrice: Number(item.unitPrice) || 0,
    taxRate: Number(item.taxRate ?? business.tax_rate ?? 0),
    discountAmount: Number(item.discountAmount) || 0,
  }));

  if (items.length === 0) throw new ValidationError("An invoice needs at least one line item.");

  const totals = computeTotals(items, {
    taxRate: business.tax_enabled ? business.tax_rate || 0 : 0,
    taxInclusive: Boolean(business.tax_inclusive),
    discountAmount: num(input.discountAmount, { field: "discountAmount", min: 0 }) ?? 0,
    deliveryAmount: num(input.deliveryAmount, { field: "deliveryAmount", min: 0 }) ?? 0,
  });

  const number = nextNumber(businessId, "invoices", "INV");
  const info = db
    .prepare(
      `INSERT INTO invoices
         (business_id, number, order_id, customer_id, status, currency, items, subtotal,
          discount_amount, tax_amount, total, amount_paid, balance, issued_at, due_at, notes, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`
    )
    .run(
      businessId,
      number,
      input.orderId ?? null,
      input.customerId ?? null,
      input.status || "issued",
      business.currency,
      JSON.stringify(items),
      totals.subtotal,
      totals.discountAmount,
      totals.taxAmount,
      totals.total,
      totals.total,
      str(input.issued_at, { field: "issued_at", max: 40 }) || new Date().toISOString(),
      str(input.due_at, { field: "due_at", max: 40 }),
      str(input.notes, { field: "notes", max: 4000 }),
      actor
    );

  const id = Number(info.lastInsertRowid);
  audit({ businessId, actor, action: "invoice.created", details: { invoice_id: id, number, total: totals.total } });
  return getInvoice(businessId, id);
}

export function createInvoiceFromOrder(businessId, orderId, actor = "system") {
  const db = getDb();
  const order = db.prepare("SELECT * FROM orders WHERE business_id = ? AND id = ?").get(businessId, orderId);
  if (!order) throw new NotFoundError("No such order.");

  const items = db
    .prepare("SELECT * FROM order_items WHERE order_id = ? ORDER BY id")
    .all(orderId)
    .map((i) => ({
      name: i.name,
      quantity: i.quantity,
      unitPrice: i.unit_price,
      taxRate: i.tax_rate,
      discountAmount: i.discount_amount,
    }));

  const invoice = createInvoice(
    businessId,
    {
      orderId: order.id,
      customerId: order.customer_id,
      items,
      notes: `Invoice for order ${order.order_number || order.id}`,
    },
    actor
  );

  db.prepare(
    "UPDATE orders SET payment_method = COALESCE(NULLIF(payment_method,''), ''), updated_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).run(order.id);

  return invoice;
}

export function updateInvoiceStatus(businessId, invoiceId, status, actor = "system") {
  const allowed = ["draft", "issued", "partial", "paid", "overdue", "cancelled", "refunded"];
  if (!allowed.includes(status)) {
    throw new ValidationError(`Status must be one of: ${allowed.join(", ")}.`);
  }
  const db = getDb();
  getInvoice(businessId, invoiceId);
  db.prepare(
    "UPDATE invoices SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE business_id = ? AND id = ?"
  ).run(status, businessId, invoiceId);
  audit({ businessId, actor, action: "invoice.status_changed", details: { invoice_id: invoiceId, status } });
  return getInvoice(businessId, invoiceId);
}

// ---------- printable documents ----------

/** Renders a quotation or invoice as a printable HTML document. */
export function renderDocument(business, document, kind = "invoice") {
  const items = document.items || [];
  const rows = items
    .map(
      (item) => `<tr>
        <td>${escape(item.name)}</td>
        <td class="num">${item.quantity}</td>
        <td class="num">${formatNumber(item.unitPrice)}</td>
        <td class="num">${formatNumber(item.lineTotal ?? item.unitPrice * item.quantity)}</td>
      </tr>`
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8" />
<title>${kind === "invoice" ? "Invoice" : "Quotation"} ${escape(document.number)} — ${escape(business.name)}</title>
<style>
  body { font-family: "Segoe UI", system-ui, sans-serif; color: #15130E; margin: 40px; }
  h1 { font-size: 1.4rem; margin: 0 0 4px; }
  .muted { color: #8A8474; font-size: 0.85rem; }
  table { width: 100%; border-collapse: collapse; margin-top: 24px; }
  th, td { padding: 10px 8px; border-bottom: 1px solid #E2DAC8; font-size: 0.9rem; text-align: left; }
  .num { text-align: right; }
  .totals { margin-top: 18px; margin-left: auto; width: 320px; }
  .totals div { display: flex; justify-content: space-between; padding: 4px 0; }
  .totals .grand { font-weight: 700; font-size: 1.05rem; border-top: 2px solid #15130E; padding-top: 8px; margin-top: 6px; }
  @media print { body { margin: 0; } }
</style></head>
<body>
  <h1>${escape(business.name)}</h1>
  <p class="muted">${escape(business.address || "")}<br />${escape(business.phone || "")}</p>
  <h2 style="margin-top:28px;">${kind === "invoice" ? "Invoice" : "Quotation"} ${escape(document.number)}</h2>
  <p class="muted">Issued ${escape(document.issued_at || document.created_at || "")}${document.due_at ? ` · Due ${escape(document.due_at)}` : ""}</p>
  <table>
    <thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Amount</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="totals">
    <div><span>Subtotal</span><span>${formatNumber(document.subtotal)}</span></div>
    ${Number(document.discount_amount) > 0 ? `<div><span>Discount</span><span>-${formatNumber(document.discount_amount)}</span></div>` : ""}
    ${Number(document.tax_amount) > 0 ? `<div><span>Tax</span><span>${formatNumber(document.tax_amount)}</span></div>` : ""}
    <div class="grand"><span>Total</span><span>${formatNumber(document.total)} ${escape(document.currency || business.currency)}</span></div>
  </div>
  ${document.notes ? `<p class="muted" style="margin-top:28px;">${escape(document.notes)}</p>` : ""}
</body></html>`;
}

function escape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ---------- expenses ----------

export function listExpenses(businessId, { limit = 200 } = {}) {
  const db = getDb();
  return db
    .prepare("SELECT * FROM expenses WHERE business_id = ? ORDER BY spent_at DESC, id DESC LIMIT ?")
    .all(businessId, Math.min(Number(limit) || 200, 500));
}

export function createExpense(businessId, input, actor = "system") {
  const db = getDb();
  const amount = num(input.amount, { field: "amount", required: true, min: 0 });
  const business = getBusinessConfig(businessId);

  const info = db
    .prepare(
      `INSERT INTO expenses (business_id, category, amount, currency, paid_to, note, spent_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      businessId,
      str(input.category, { field: "category", max: 60 }) || "other",
      amount,
      business.currency,
      str(input.paid_to, { field: "paid_to", max: 200 }),
      str(input.note, { field: "note", max: 1000 }),
      str(input.spent_at, { field: "spent_at", max: 40 }) || new Date().toISOString().slice(0, 10),
      actor
    );

  const id = Number(info.lastInsertRowid);
  audit({ businessId, actor, action: "expense.created", details: { expense_id: id, amount } });
  return db.prepare("SELECT * FROM expenses WHERE id = ?").get(id);
}

export { jsonObject };
