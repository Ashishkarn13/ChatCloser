// src/services/customers.js
// Customer records (CRM).
//
// A customer is the business' record of a real person or company: contact
// details, the Nepal address structure, tags, and the history of what they
// bought. Leads (which the AI captures from a conversation) are linked to a
// customer so that the same person is not recorded twice.

import { getDb } from "../db/connection.js";
import { audit } from "../core/audit.js";
import { NotFoundError, ValidationError } from "../core/errors.js";
import { str, num, jsonArray, jsonObject } from "../core/validation.js";

const ADDRESS_FIELDS = [
  "province",
  "district",
  "municipality",
  "ward",
  "locality",
  "address",
];

export function listCustomers(businessId, { search = "", limit = 100, offset = 0, includeDeleted = false } = {}) {
  const db = getDb();
  const where = ["business_id = ?"];
  const params = [businessId];

  if (!includeDeleted) where.push("deleted_at IS NULL");

  if (search) {
    where.push("(LOWER(name) LIKE ? OR phone LIKE ? OR email LIKE ? OR company LIKE ? OR locality LIKE ?)");
    const like = `%${String(search).toLowerCase()}%`;
    params.push(like, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
  }

  params.push(Math.min(Number(limit) || 100, 500), Number(offset) || 0);

  const rows = db
    .prepare(
      `SELECT * FROM customers WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ? OFFSET ?`
    )
    .all(...params);

  return rows.map((row) => ({ ...row, tags: jsonArray(row.tags) }));
}

export function getCustomer(businessId, customerId) {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM customers WHERE business_id = ? AND id = ?")
    .get(businessId, customerId);
  if (!row) throw new NotFoundError("No such customer in this workspace.");
  return { ...row, tags: jsonArray(row.tags) };
}

export function findCustomerByPhone(businessId, phone) {
  if (!phone) return null;
  const db = getDb();
  const row = db
    .prepare(
      "SELECT * FROM customers WHERE business_id = ? AND phone = ? AND deleted_at IS NULL LIMIT 1"
    )
    .get(businessId, phone);
  return row ? { ...row, tags: jsonArray(row.tags) } : null;
}

/**
 * Finds possible duplicates: same phone, or a very similar name.
 * Used before creating a customer so a business does not end up with
 * three records for the same person.
 */
export function findDuplicates(businessId, { phone = "", name = "" }) {
  const db = getDb();
  const results = [];

  if (phone) {
    results.push(
      ...db
        .prepare(
          "SELECT * FROM customers WHERE business_id = ? AND phone = ? AND deleted_at IS NULL LIMIT 5"
        )
        .all(businessId, phone)
    );
  }

  if (name && name.length >= 3) {
    const like = `%${String(name).toLowerCase()}%`;
    results.push(
      ...db
        .prepare(
          `SELECT * FROM customers WHERE business_id = ? AND deleted_at IS NULL
             AND LOWER(name) LIKE ? AND (phone <> ? OR phone = '')
           LIMIT 5`
        )
        .all(businessId, like, phone || "\u0000")
    );
  }

  const seen = new Set();
  return results.filter((r) => (seen.has(r.id) ? false : seen.add(r.id)));
}

export function createCustomer(businessId, fields, actor = "system") {
  const db = getDb();
  const name = str(fields.name, { field: "name", required: true, max: 200 });
  const phone = str(fields.phone, { field: "phone", max: 40 });

  const existing = findCustomerByPhone(businessId, phone);
  if (existing) {
    return { ...existing, deduplicated: true };
  }

  const insert = db.prepare(`
    INSERT INTO customers
      (business_id, name, phone, email, alt_phone, company, province, district,
       municipality, ward, locality, address, notes, tags, source, is_vip)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const info = insert.run(
    businessId,
    name,
    phone,
    str(fields.email, { field: "email", max: 200 }),
    str(fields.alt_phone, { field: "alt_phone", max: 40 }),
    str(fields.company, { field: "company", max: 200 }),
    ...ADDRESS_FIELDS.map((f) => str(fields[f], { field: f, max: 200 })),
    str(fields.notes, { field: "notes", max: 4000 }),
    JSON.stringify(jsonArray(fields.tags).map(String)),
    str(fields.source, { field: "source", max: 60 }),
    fields.is_vip ? 1 : 0
  );

  const id = Number(info.lastInsertRowid);
  audit({ businessId, actor, action: "customer.created", details: { customer_id: id, name } });
  return getCustomer(businessId, id);
}

export function updateCustomer(businessId, customerId, fields, actor = "system") {
  const db = getDb();
  const current = getCustomer(businessId, customerId);

  const next = {
    name: fields.name !== undefined ? str(fields.name, { field: "name", max: 200 }) : current.name,
    phone: fields.phone !== undefined ? str(fields.phone, { field: "phone", max: 40 }) : current.phone,
    email: fields.email !== undefined ? str(fields.email, { field: "email", max: 200 }) : current.email,
    alt_phone:
      fields.alt_phone !== undefined ? str(fields.alt_phone, { field: "alt_phone", max: 40 }) : current.alt_phone,
    company:
      fields.company !== undefined ? str(fields.company, { field: "company", max: 200 }) : current.company,
    notes: fields.notes !== undefined ? str(fields.notes, { field: "notes", max: 4000 }) : current.notes,
    tags:
      fields.tags !== undefined
        ? JSON.stringify(jsonArray(fields.tags).map(String))
        : JSON.stringify(jsonArray(current.tags)),
    is_vip: fields.is_vip !== undefined ? (fields.is_vip ? 1 : 0) : current.is_vip,
  };

  for (const f of ADDRESS_FIELDS) {
    next[f] = fields[f] !== undefined ? str(fields[f], { field: f, max: 200 }) : current[f];
  }

  db.prepare(`
    UPDATE customers SET
      name = ?, phone = ?, email = ?, alt_phone = ?, company = ?,
      province = ?, district = ?, municipality = ?, ward = ?, locality = ?, address = ?,
      notes = ?, tags = ?, is_vip = ?, updated_at = CURRENT_TIMESTAMP
    WHERE business_id = ? AND id = ?
  `).run(
    next.name, next.phone, next.email, next.alt_phone, next.company,
    next.province, next.district, next.municipality, next.ward, next.locality, next.address,
    next.notes, next.tags, next.is_vip,
    businessId, customerId
  );

  audit({ businessId, actor, action: "customer.updated", details: { customer_id: customerId } });
  return getCustomer(businessId, customerId);
}

/** Soft delete. Historical orders and payments keep referring to the row. */
export function deleteCustomer(businessId, customerId, actor = "system") {
  const db = getDb();
  getCustomer(businessId, customerId);
  db.prepare(
    "UPDATE customers SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE business_id = ? AND id = ?"
  ).run(businessId, customerId);
  audit({ businessId, actor, action: "customer.deleted", details: { customer_id: customerId } });
  return true;
}

// ---------- tags ----------

export function listTags(businessId) {
  const db = getDb();
  return db.prepare("SELECT * FROM customer_tags WHERE business_id = ? ORDER BY name").all(businessId);
}

export function addTag(businessId, name, color = "") {
  const db = getDb();
  const clean = str(name, { field: "name", required: true, max: 60 });
  db.prepare(
    `INSERT INTO customer_tags (business_id, name, color) VALUES (?, ?, ?)
     ON CONFLICT(business_id, name) DO UPDATE SET color = excluded.color`
  ).run(businessId, clean, color);
  return listTags(businessId);
}

export function tagCustomer(businessId, customerId, tagName) {
  const db = getDb();
  const tag = db
    .prepare("SELECT id FROM customer_tags WHERE business_id = ? AND name = ?")
    .get(businessId, tagName);
  if (!tag) throw new NotFoundError(`No tag called "${tagName}".`);
  db.prepare(
    "INSERT OR IGNORE INTO customer_tag_links (business_id, customer_id, tag_id) VALUES (?, ?, ?)"
  ).run(businessId, customerId, tag.id);
  const customer = getCustomer(businessId, customerId);
  const names = db
    .prepare(
      `SELECT t.name FROM customer_tag_links l JOIN customer_tags t ON t.id = l.tag_id WHERE l.customer_id = ?`
    )
    .all(customerId)
    .map((r) => r.name);
  db.prepare("UPDATE customers SET tags = ?, updated_at = CURRENT_TIMESTAMP WHERE business_id = ? AND id = ?").run(
    JSON.stringify(names),
    businessId,
    customerId
  );
  return { ...customer, tags: names };
}

// ---------- history ----------

export function getCustomerHistory(businessId, customerId) {
  const db = getDb();
  const customer = getCustomer(businessId, customerId);

  const orders = db
    .prepare(
      "SELECT id, order_number, item_name, amount, currency, payment_status, state, created_at FROM orders WHERE business_id = ? AND customer_id = ? ORDER BY id DESC"
    )
    .all(businessId, customerId);

  const payments = db
    .prepare(
      "SELECT id, provider, method, amount, currency, status, verified, created_at FROM payments WHERE business_id = ? AND customer_id = ? ORDER BY id DESC"
    )
    .all(businessId, customerId);

  const messages = db
    .prepare(
      `SELECT c.id, c.chat_id, c.role, c.content, c.created_at
       FROM conversations c
       JOIN threads t ON t.external_id = c.chat_id AND t.business_id = c.business_id
       WHERE c.business_id = ? AND t.customer_id = ?
       ORDER BY c.id DESC LIMIT 50`
    )
    .all(businessId, customerId);

  const leads = db
    .prepare("SELECT * FROM leads WHERE business_id = ? AND customer_id = ? ORDER BY id DESC")
    .all(businessId, customerId);

  return { customer, orders, payments, messages, leads };
}

/** Recomputes the cached lifetime value / order counters from real orders. */
export function refreshCustomerTotals(businessId, customerId) {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS orders, COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN amount ELSE 0 END), 0) AS revenue,
              MAX(created_at) AS last_order
       FROM orders WHERE business_id = ? AND customer_id = ?`
    )
    .get(businessId, customerId);

  db.prepare(
    `UPDATE customers SET lifetime_value = ?, total_orders = ?, last_order_at = ?, updated_at = CURRENT_TIMESTAMP
     WHERE business_id = ? AND id = ?`
  ).run(row.revenue || 0, row.orders || 0, row.last_order || null, businessId, customerId);

  return getCustomer(businessId, customerId);
}

/**
 * Validates a phone number against the business' configured rule.
 * Nepal numbers are 10 digits (98XXXXXXXX) when written without the
 * country code, but businesses differ, so the rule is configurable.
 */
export function validatePhone(business, phone) {
  const value = str(phone, { field: "phone", max: 40 });
  if (!value) return { ok: true, normalized: "" };

  const rule = jsonObject(business?.settings).phoneValidation || {};
  const digits = value.replace(/[^\d+]/g, "");

  if (rule.minDigits && digits.replace("+", "").length < Number(rule.minDigits)) {
    return { ok: false, normalized: value, reason: `must be at least ${rule.minDigits} digits` };
  }
  if (rule.maxDigits && digits.replace("+", "").length > Number(rule.maxDigits)) {
    return { ok: false, normalized: value, reason: `must be at most ${rule.maxDigits} digits` };
  }
  if (rule.prefixes?.length) {
    const ok = rule.prefixes.some((p) => digits.replace("+", "").startsWith(String(p)));
    if (!ok) {
      return {
        ok: false,
        normalized: value,
        reason: `must start with one of: ${rule.prefixes.join(", ")}`,
      };
    }
  }
  return { ok: true, normalized: value };
}
