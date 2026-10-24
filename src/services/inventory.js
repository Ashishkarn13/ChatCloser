// src/services/inventory.js
// Stock levels, movements, reservations and low-stock alerts.
//
// Every stock change is written as a movement row *and* applied to the
// running balance inside the same transaction, so the balance can always
// be re-derived from the movement ledger. Concurrent reservations are
// serialised by the SQLite write lock plus an explicit re-read inside the
// transaction.

import { getDb, transaction } from "../db/connection.js";
import { audit } from "../core/audit.js";
import { NotFoundError, ValidationError, ConflictError } from "../core/errors.js";
import { num } from "../core/validation.js";

export const MOVEMENT_TYPES = ["in", "out", "adjust", "reserve", "release", "return", "sale", "purchase"];

function ensureStockRow(businessId, productId, variantId = 0) {
  const db = getDb();
  const existing = db
    .prepare("SELECT * FROM stock_levels WHERE product_id = ? AND variant_id = ?")
    .get(productId, variantId);
  if (existing) return existing;
  db.prepare(
    `INSERT INTO stock_levels (business_id, product_id, variant_id) VALUES (?, ?, ?)
     ON CONFLICT(product_id, variant_id) DO NOTHING`
  ).run(businessId, productId, variantId);
  return db
    .prepare("SELECT * FROM stock_levels WHERE product_id = ? AND variant_id = ?")
    .get(productId, variantId);
}

export function getStock(businessId, productId, variantId = 0) {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT * FROM stock_levels WHERE business_id = ? AND product_id = ? AND variant_id = ?"
    )
    .get(businessId, productId, variantId);
  if (!row) return { quantity_on_hand: 0, quantity_reserved: 0, reorder_level: 0, available: 0 };
  return { ...row, available: Number(row.quantity_on_hand) - Number(row.quantity_reserved) };
}

export function listStock(businessId, { onlyLow = false } = {}) {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT s.*, p.name AS product_name, p.sku, p.unit, p.track_inventory, p.price,
              v.name AS variant_name
       FROM stock_levels s
       JOIN products p ON p.id = s.product_id AND p.business_id = s.business_id
       LEFT JOIN product_variants v ON v.id = s.variant_id
       WHERE s.business_id = ? AND p.deleted_at IS NULL AND p.track_inventory = 1
       ORDER BY p.name`
    )
    .all(businessId);

  const withAvailable = rows.map((r) => ({
    ...r,
    available: Number(r.quantity_on_hand) - Number(r.quantity_reserved),
  }));

  return onlyLow
    ? withAvailable.filter((r) => Number(r.reorder_level) > 0 && r.available <= Number(r.reorder_level))
    : withAvailable;
}

export function lowStockAlerts(businessId) {
  return listStock(businessId, { onlyLow: true });
}

/**
 * Applies a stock movement and records it in the ledger.
 *
 * @param {object} input
 * @param {number} input.businessId
 * @param {number} input.productId
 * @param {number} [input.variantId]
 * @param {string} input.type one of MOVEMENT_TYPES
 * @param {number} input.quantity always positive; the type decides the sign
 * @param {string} [input.referenceType] e.g. "order"
 * @param {number} [input.referenceId]
 */
export function applyMovement({
  businessId,
  productId,
  variantId = 0,
  type,
  quantity,
  referenceType = "",
  referenceId = null,
  note = "",
  actor = "system",
}) {
  if (!MOVEMENT_TYPES.includes(type)) {
    throw new ValidationError(`Unknown stock movement type "${type}".`);
  }
  const qty = Number(quantity);
  if (!Number.isFinite(qty) || qty <= 0) {
    throw new ValidationError("Movement quantity must be a positive number.");
  }

  return transaction(() => {
    const db = getDb();
    const stock = ensureStockRow(businessId, productId, variantId);

    let onHand = Number(stock.quantity_on_hand);
    let reserved = Number(stock.quantity_reserved);

    switch (type) {
      case "in":
      case "purchase":
      case "return":
        onHand += qty;
        break;
      case "out":
      case "sale":
        if (onHand < qty) {
          throw new ConflictError(
            `Not enough stock: ${qty} requested but only ${onHand} available.`
          );
        }
        onHand -= qty;
        break;
      case "adjust":
        onHand = qty;
        break;
      case "reserve":
        if (onHand - reserved < qty) {
          throw new ConflictError(
            `Not enough stock to reserve: ${qty} requested but only ${onHand - reserved} available.`
          );
        }
        reserved += qty;
        break;
      case "release":
        reserved = Math.max(0, reserved - qty);
        break;
      default:
        break;
    }

    db.prepare(
      `UPDATE stock_levels SET quantity_on_hand = ?, quantity_reserved = ?, updated_at = CURRENT_TIMESTAMP
       WHERE business_id = ? AND product_id = ? AND variant_id = ?`
    ).run(onHand, reserved, businessId, productId, variantId);

    db.prepare(
      `INSERT INTO inventory_movements
         (business_id, product_id, variant_id, type, quantity, balance_after, reference_type, reference_id, note, actor)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      businessId,
      productId,
      variantId,
      type,
      qty,
      onHand,
      referenceType,
      referenceId,
      note,
      actor
    );

    return { quantity_on_hand: onHand, quantity_reserved: reserved, available: onHand - reserved };
  });
}

/** Sets the reorder level used by the low-stock alerts. */
export function setReorderLevel(businessId, productId, level, variantId = 0, actor = "system") {
  const db = getDb();
  ensureStockRow(businessId, productId, variantId);
  db.prepare(
    "UPDATE stock_levels SET reorder_level = ?, updated_at = CURRENT_TIMESTAMP WHERE business_id = ? AND product_id = ? AND variant_id = ?"
  ).run(num(level, { field: "reorder_level", min: 0 }) ?? 0, businessId, productId, variantId);
  audit({
    businessId,
    actor,
    action: "inventory.reorder_level_set",
    details: { product_id: productId, level },
  });
  return getStock(businessId, productId, variantId);
}

/**
 * Checks that every line of an order can be satisfied right now.
 * @returns {{ok: boolean, problems: Array<{productId:number, message:string}>}}
 */
export function checkAvailability(businessId, lines) {
  const problems = [];

  for (const line of lines) {
    const productId = Number(line.productId);
    if (!productId) continue;

    const db = getDb();
    const product = db
      .prepare(
        "SELECT id, name, track_inventory FROM products WHERE business_id = ? AND id = ? AND deleted_at IS NULL"
      )
      .get(businessId, productId);
    if (!product) {
      problems.push({ productId, message: "This item is no longer available." });
      continue;
    }
    if (!product.track_inventory) continue;

    const stock = getStock(businessId, productId, Number(line.variantId) || 0);
    const wanted = Number(line.quantity) || 0;
    if (stock.available < wanted) {
      problems.push({
        productId,
        message: stock.available <= 0
          ? `${product.name} is out of stock.`
          : `Only ${stock.available} of ${product.name} available (${wanted} requested).`,
      });
    }
  }

  return { ok: problems.length === 0, problems };
}

/**
 * Reserves stock for an order. Runs inside the caller's transaction when
 * one is open, so the reservation and the order row commit together.
 */
export function reserveForOrder(businessId, lines, referenceType = "order", referenceId = null, actor = "system") {
  const reserved = [];
  for (const line of lines) {
    const productId = Number(line.productId);
    if (!productId) continue;

    const db = getDb();
    const product = db
      .prepare("SELECT id, track_inventory FROM products WHERE business_id = ? AND id = ?")
      .get(businessId, productId);
    if (!product || !product.track_inventory) continue;

    const result = applyMovement({
      businessId,
      productId,
      variantId: Number(line.variantId) || 0,
      type: "reserve",
      quantity: Number(line.quantity) || 0,
      referenceType,
      referenceId,
      note: "Order reservation",
      actor,
    });
    reserved.push({ productId, ...result });
  }
  return reserved;
}

/** Releases a reservation (order cancelled or stock reservation expired). */
export function releaseReservation(businessId, lines, referenceType = "order", referenceId = null, actor = "system") {
  const released = [];
  for (const line of lines) {
    const productId = Number(line.productId);
    if (!productId) continue;

    const db = getDb();
    const product = db
      .prepare("SELECT id, track_inventory FROM products WHERE business_id = ? AND id = ?")
      .get(businessId, productId);
    if (!product || !product.track_inventory) continue;

    const result = applyMovement({
      businessId,
      productId,
      variantId: Number(line.variantId) || 0,
      type: "release",
      quantity: Number(line.quantity) || 0,
      referenceType,
      referenceId,
      note: "Order reservation released",
      actor,
    });
    released.push({ productId, ...result });
  }
  return released;
}

/** Turns a reservation into a real stock issue (the order ships). */
export function consumeReservation(businessId, lines, referenceType = "order", referenceId = null, actor = "system") {
  const consumed = [];
  for (const line of lines) {
    const productId = Number(line.productId);
    if (!productId) continue;

    const db = getDb();
    const product = db
      .prepare("SELECT id, track_inventory FROM products WHERE business_id = ? AND id = ?")
      .get(businessId, productId);
    if (!product || !product.track_inventory) continue;

    const qty = Number(line.quantity) || 0;
    const variantId = Number(line.variantId) || 0;

    applyMovement({
      businessId,
      productId,
      variantId,
      type: "release",
      quantity: qty,
      referenceType,
      referenceId,
      note: "Reservation converted to sale",
      actor,
    });
    const result = applyMovement({
      businessId,
      productId,
      variantId,
      type: "out",
      quantity: qty,
      referenceType,
      referenceId,
      note: "Stock issued",
      actor,
    });
    consumed.push({ productId, ...result });
  }
  return consumed;
}

export function listMovements(businessId, { productId = null, limit = 100 } = {}) {
  const db = getDb();
  const where = ["m.business_id = ?"];
  const params = [businessId];
  if (productId) {
    where.push("m.product_id = ?");
    params.push(productId);
  }
  params.push(Math.min(Number(limit) || 100, 500));

  return db
    .prepare(
      `SELECT m.*, p.name AS product_name FROM inventory_movements m
       JOIN products p ON p.id = m.product_id
       WHERE ${where.join(" AND ")}
       ORDER BY m.id DESC LIMIT ?`
    )
    .all(...params);
}

/** Approximate stock valuation using the product's cost price. */
export function inventoryValuation(businessId) {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(s.quantity_on_hand * p.cost_price), 0) AS cost_value,
              COALESCE(SUM(s.quantity_on_hand * p.price), 0) AS retail_value,
              COALESCE(SUM(s.quantity_on_hand), 0) AS units
       FROM stock_levels s
       JOIN products p ON p.id = s.product_id AND p.business_id = s.business_id
       WHERE s.business_id = ? AND p.deleted_at IS NULL AND p.track_inventory = 1`
    )
    .get(businessId);

  return {
    costValue: Number(row.cost_value || 0),
    retailValue: Number(row.retail_value || 0),
    units: Number(row.units || 0),
  };
}

export function getProductOrThrow(businessId, productId) {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM products WHERE business_id = ? AND id = ?")
    .get(businessId, productId);
  if (!row) throw new NotFoundError("No such product in this workspace.");
  return row;
}
