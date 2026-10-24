// src/services/orders.js
// Order lifecycle.
//
//   DRAFT → AWAITING_CUSTOMER_CONFIRMATION → CONFIRMED → PROCESSING
//         → DISPATCHED → DELIVERED
//   (plus CANCELLED, REJECTED, PAYMENT_FAILED, REFUNDED, RETURNED)
//
// Two rules drive the whole design:
//
//   1. Nothing becomes an order until the *customer* has explicitly
//      approved the summary. An AI message saying "your order is created"
//      is not an approval, and the backend refuses to treat it as one.
//   2. Every price is re-read from the catalog at confirmation time. If a
//      price or quantity changed since the draft was shown, the draft is
//      invalidated and the customer must confirm again.

import { getDb, transaction } from "../db/connection.js";
import { audit } from "../core/audit.js";
import {
  NotFoundError,
  ValidationError,
  ConflictError,
  StateTransitionError,
} from "../core/errors.js";
import { num, str, jsonObject, jsonArray } from "../core/validation.js";
import { computeTotals, computeDelivery, roundMoney } from "../core/money.js";
import { resolveProduct, syncPriceListEntry } from "./catalog.js";
import { checkAvailability, reserveForOrder, releaseReservation, consumeReservation } from "./inventory.js";
import { getBusinessConfig } from "./businesses.js";

export const ORDER_STATES = [
  "draft",
  "awaiting_confirmation",
  "confirmed",
  "processing",
  "dispatched",
  "delivered",
  "cancelled",
  "rejected",
  "payment_failed",
  "refunded",
  "returned",
];

/** Which state may follow which. Anything not listed is rejected. */
export const ORDER_TRANSITIONS = {
  draft: ["awaiting_confirmation", "cancelled"],
  awaiting_confirmation: ["confirmed", "rejected", "cancelled", "draft"],
  confirmed: ["processing", "cancelled", "payment_failed"],
  processing: ["dispatched", "cancelled"],
  dispatched: ["delivered", "returned"],
  delivered: ["returned", "refunded"],
  cancelled: [],
  rejected: [],
  payment_failed: ["confirmed", "cancelled"],
  refunded: [],
  returned: [],
};

export function canTransition(from, to) {
  return (ORDER_TRANSITIONS[from] || []).includes(to);
}

// ---------- order numbers ----------

function nextOrderNumber(businessId) {
  const db = getDb();
  const year = new Date().getFullYear();
  const prefix = `ORD-${year}-`;
  const row = db
    .prepare(
      "SELECT order_number FROM orders WHERE business_id = ? AND order_number LIKE ? ORDER BY id DESC LIMIT 1"
    )
    .get(businessId, `${prefix}%`);
  let next = 1;
  if (row?.order_number) {
    const tail = Number(row.order_number.slice(prefix.length));
    if (Number.isFinite(tail)) next = tail + 1;
  }
  return `${prefix}${String(next).padStart(4, "0")}`;
}

// ---------- idempotency ----------

/**
 * Runs `fn` at most once for a given (business, scope, key). A repeated call
 * with the same key returns the stored result instead of repeating the
 * side effect — this is what protects order creation from duplicate
 * webhook retries and double-tapped confirmation buttons.
 */
export function withIdempotency(businessId, scope, key, fn) {
  if (!key) return fn();

  const db = getDb();
  const existing = db
    .prepare("SELECT * FROM idempotency_keys WHERE business_id = ? AND scope = ? AND key = ?")
    .get(businessId, scope, key);

  if (existing) {
    if (existing.status === "done") {
      return existing.response ? JSON.parse(existing.response) : { replayed: true };
    }
    if (existing.status === "in_progress") {
      throw new ConflictError("This request is already being processed.");
    }
  } else {
    db.prepare(
      "INSERT INTO idempotency_keys (business_id, key, scope, status) VALUES (?, ?, ?, 'in_progress')"
    ).run(businessId, key, scope);
  }

  try {
    const result = fn();
    db.prepare(
      "UPDATE idempotency_keys SET status = 'done', response = ? WHERE business_id = ? AND scope = ? AND key = ?"
    ).run(JSON.stringify(result ?? {}), businessId, scope, key);
    return result;
  } catch (err) {
    db.prepare(
      "UPDATE idempotency_keys SET status = 'failed' WHERE business_id = ? AND scope = ? AND key = ?"
    ).run(businessId, scope, key);
    throw err;
  }
}

// ---------- drafts ----------

/**
 * Builds a priced draft from free-text items.
 *
 * Every item is resolved against the catalog; the unit price always comes
 * from the catalog row. An item that cannot be resolved is reported back
 * as a problem instead of being priced by guesswork.
 *
 * @param {object} input
 * @param {number} input.businessId
 * @param {Array<{name?:string, productId?:number, variantId?:number, quantity?:number, price?:number}>} input.items
 */
export function buildDraft(businessId, input, { threadId = null, chatId = "", customerId = null } = {}) {
  const business = getBusinessConfig(businessId);
  const rawItems = Array.isArray(input.items) ? input.items : [];
  if (rawItems.length === 0) throw new ValidationError("An order needs at least one item.");

  const lines = [];
  const problems = [];

  for (const raw of rawItems) {
    const quantity = num(raw.quantity, { field: "quantity", min: 0.0001 }) ?? 1;
    let product = null;
    let variant = null;

    if (raw.productId) {
      const db = getDb();
      product = db
        .prepare("SELECT * FROM products WHERE business_id = ? AND id = ? AND deleted_at IS NULL")
        .get(businessId, Number(raw.productId));
      if (product && raw.variantId) {
        variant = db
          .prepare(
            "SELECT * FROM product_variants WHERE business_id = ? AND product_id = ? AND id = ?"
          )
          .get(businessId, product.id, Number(raw.variantId));
      }
    } else if (raw.name) {
      const resolved = resolveProduct(businessId, raw.name);
      product = resolved.product;
      if (!product && resolved.candidates.length > 0) {
        problems.push({
          name: raw.name,
          message: `Did you mean: ${resolved.candidates.map((c) => c.name).join(", ")}?`,
          candidates: resolved.candidates.map((c) => ({ id: c.id, name: c.name, price: c.price })),
        });
        continue;
      }
      if (!product) {
        problems.push({ name: raw.name, message: `"${raw.name}" is not in our catalogue.` });
        continue;
      }
    }

    if (!product) {
      problems.push({ name: raw.name || "", message: "That item could not be found in the catalogue." });
      continue;
    }

    const unitPrice = variant && variant.price > 0 ? variant.price : product.price;

    lines.push({
      productId: product.id,
      variantId: variant?.id || 0,
      name: variant ? `${product.name} — ${variant.name}` : product.name,
      quantity,
      unitPrice: roundMoney(unitPrice),
      taxRate: product.tax_rate || 0,
      trackInventory: Boolean(product.track_inventory),
      priceSnapshot: {
        product_id: product.id,
        variant_id: variant?.id || 0,
        unit_price: roundMoney(unitPrice),
        currency: business.currency,
        captured_at: new Date().toISOString(),
      },
    });
  }

  const availability = checkAvailability(businessId, lines);
  if (!availability.ok) {
    problems.push(...availability.problems.map((p) => ({ productId: p.productId, message: p.message })));
  }

  const options = {
    discountAmount: num(input.discountAmount, { field: "discountAmount", min: 0 }) ?? 0,
    taxRate: business.tax_enabled ? business.tax_rate || 0 : 0,
    taxInclusive: Boolean(business.tax_inclusive),
  };

  const totals = computeTotals(lines, options);
  const deliveryAmount = computeDelivery(business, totals.total);
  const finalTotals = computeTotals(lines, { ...options, deliveryAmount });

  return {
    lines,
    problems,
    totals: finalTotals,
    currency: business.currency,
    delivery: jsonObject(input.delivery),
    notes: str(input.notes, { field: "notes", max: 2000 }),
    threadId,
    chatId,
    customerId,
  };
}

/** Persists a priced draft awaiting the customer's confirmation. */
export function saveDraft(businessId, draft, { actor = "system" } = {}) {
  const db = getDb();
  const payload = {
    lines: draft.lines,
    problems: draft.problems || [],
    delivery: draft.delivery || {},
    notes: draft.notes || "",
    currency: draft.currency,
    requiresConfirmation: true,
  };

  const info = db
    .prepare(
      `INSERT INTO order_drafts
         (business_id, thread_id, chat_id, customer_id, payload, summary, total, currency, state, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_confirmation', datetime('now', '+24 hours'))`
    )
    .run(
      businessId,
      draft.threadId ?? null,
      draft.chatId || "",
      draft.customerId ?? null,
      JSON.stringify(payload),
      buildSummary(draft.lines, draft.totals),
      draft.totals.total,
      draft.currency
    );

  const id = Number(info.lastInsertRowid);
  audit({
    businessId,
    actor,
    action: "order.draft_created",
    details: { draft_id: id, total: draft.totals.total },
  });
  return getDraft(businessId, id);
}

export function getDraft(businessId, draftId) {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM order_drafts WHERE business_id = ? AND id = ?")
    .get(businessId, draftId);
  if (!row) throw new NotFoundError("No such order draft.");
  return { ...row, payload: jsonObject(row.payload) };
}

export function findDrafts(businessId, { chatId = null, threadId = null, state = "awaiting_confirmation" } = {}) {
  const db = getDb();
  const where = ["business_id = ?"];
  const params = [businessId];
  if (chatId) {
    where.push("chat_id = ?");
    params.push(chatId);
  }
  if (threadId) {
    where.push("thread_id = ?");
    params.push(threadId);
  }
  if (state) {
    where.push("state = ?");
    params.push(state);
  }
  return db
    .prepare(`SELECT * FROM order_drafts WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT 10`)
    .all(businessId)
    .map((r) => ({ ...r, payload: jsonObject(r.payload) }));
}

export function discardDraft(businessId, draftId, { actor = "system" } = {}) {
  const db = getDb();
  db.prepare(
    "UPDATE order_drafts SET state = 'discarded', updated_at = CURRENT_TIMESTAMP WHERE business_id = ? AND id = ?"
  ).run(businessId, draftId);
  audit({ businessId, actor, action: "order.draft_discarded", details: { draft_id: draftId } });
  return true;
}

// ---------- creating a real order ----------

/**
 * Confirms a draft and creates the order atomically.
 *
 * Re-validates, inside the transaction:
 *   - that every line still exists and is still priced the same way,
 *   - that stock is still available,
 *   - that the business still requires confirmation.
 *
 * @param {object} options
 * @param {string} [options.idempotencyKey] guards against double submission
 * @param {boolean} [options.customerApproved] must be true — it asserts
 *        that the customer has explicitly approved this summary. Staff
 *        acting on a customer's behalf pass it too, and the audit log
 *        records them as the actor.
 */
export function confirmDraft(businessId, draftId, options = {}) {
  const { actor = "customer", idempotencyKey = null, customerApproved = false, notes = "" } = options;

  return withIdempotency(businessId, "order.confirm", idempotencyKey, () => {
    const draft = getDraft(businessId, draftId);

    if (draft.state !== "awaiting_confirmation") {
      throw new ConflictError(
        `This draft is ${draft.state} and can no longer be confirmed.`
      );
    }

    const business = getBusinessConfig(businessId);
    if (business.requires_order_confirmation && !customerApproved) {
      // The only way past this check is an explicit statement that the
      // customer approved the summary. The assistant cannot supply that
      // on its own — it comes from the customer's own words.
      throw new ValidationError(
        "This order still needs the customer's explicit confirmation."
      );
    }

    const lines = draft.payload.lines || [];

    const result = transaction(() => {
      const db = getDb();

      // Re-read every price from the catalog. A changed price invalidates
      // the draft — the customer must see and approve the new number.
      const revalidated = [];
      const changed = [];
      for (const line of lines) {
        const product = db
          .prepare(
            "SELECT * FROM products WHERE business_id = ? AND id = ? AND deleted_at IS NULL AND is_active = 1"
          )
          .get(businessId, line.productId);
        if (!product) {
          throw new ConflictError(`"${line.name}" is no longer available.`);
        }
        const variant = line.variantId
          ? db
              .prepare("SELECT * FROM product_variants WHERE business_id = ? AND id = ? AND is_active = 1")
              .get(businessId, line.variantId)
          : null;
        const currentPrice = variant && variant.price > 0 ? variant.price : product.price;
        if (roundMoney(currentPrice) !== roundMoney(line.unitPrice)) {
          changed.push({ name: line.name, was: line.unitPrice, now: roundMoney(currentPrice) });
        }
        revalidated.push({ ...line, unitPrice: roundMoney(currentPrice) });
      }

      if (changed.length > 0) {
        throw new ConflictError(
          "The price changed since this order was prepared, so it needs to be confirmed again.",
          { changed }
        );
      }

      const availability = checkAvailability(businessId, revalidated);
      if (!availability.ok) {
        throw new ConflictError("Some items are no longer available in the requested quantity.", {
          problems: availability.problems,
        });
      }

      const options2 = {
        discountAmount: num(draft.payload.discountAmount, { field: "discountAmount", min: 0 }) ?? 0,
        taxRate: business.tax_enabled ? business.tax_rate || 0 : 0,
        taxInclusive: Boolean(business.tax_inclusive),
        deliveryAmount: computeDelivery(business, computeTotals(revalidated).total),
      };
      const totals = computeTotals(revalidated, options2);

      const orderNumber = nextOrderNumber(businessId);
      const summary = buildSummary(revalidated, totals);

      const info = db
        .prepare(
          `INSERT INTO orders
             (business_id, customer_id, chat_id, order_number, item_name, amount, currency,
              state, channel, subtotal, discount_amount, tax_amount, delivery_amount, total_amount,
              notes, address_json, payment_status, payment_method, idempotency_key, stock_reserved)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?, ?, ?, ?, ?, ?, 'pending', '', ?, ?)`
        )
        .run(
          businessId,
          draft.customer_id ?? null,
          draft.chat_id || "",
          orderNumber,
          summary,
          totals.total,
          totals.currency || business.currency,
          draft.channel || "whatsapp",
          totals.subtotal,
          totals.discountAmount,
          totals.taxAmount,
          totals.deliveryAmount,
          totals.total,
          notes || draft.payload.notes || "",
          JSON.stringify(draft.payload.delivery || {}),
          idempotencyKey || "",
          0
        );

      const orderId = Number(info.lastInsertRowid);

      const insertItem = db.prepare(
        `INSERT INTO order_items
           (business_id, order_id, product_id, variant_id, name, quantity, unit_price,
            discount_amount, tax_rate, tax_amount, line_total, price_snapshot)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const line of revalidated) {
        const lineTotals = totals.lines.find((l) => l.quantity === line.quantity) || {};
        insertItem.run(
          businessId,
          orderId,
          line.productId,
          line.variantId || 0,
          line.name,
          line.quantity,
          line.unitPrice,
          0,
          line.taxRate || 0,
          lineTotals.taxAmount ?? 0,
          lineTotals.lineTotal ?? roundMoney(line.unitPrice * line.quantity),
          JSON.stringify(line.priceSnapshot || {})
        );
      }

      // Reserve stock inside the same transaction as the order insert.
      reserveForOrder(
        businessId,
        revalidated.map((l) => ({ productId: l.productId, variantId: l.variantId, quantity: l.quantity })),
        "order",
        orderId,
        actor
      );
      db.prepare("UPDATE orders SET stock_reserved = 1 WHERE id = ?").run(orderId);

      db.prepare(
        `INSERT INTO order_transitions (business_id, order_id, from_state, to_state, actor, reason)
         VALUES (?, ?, 'draft', 'confirmed', ?, ?)`
      ).run(businessId, orderId, actor, `Confirmed from draft #${draftId}`);

      db.prepare(
        "UPDATE order_drafts SET state = 'confirmed', updated_at = CURRENT_TIMESTAMP WHERE business_id = ? AND id = ?"
      ).run(businessId, draftId);

      return { orderId, orderNumber, totals };
    });

    audit({
      businessId,
      actor,
      action: "order.created",
      details: {
        order_id: result.orderId,
        order_number: result.orderNumber,
        total: result.totals.total,
      },
    });

    return getOrder(businessId, result.orderId);
  });
}

// ---------- reading orders ----------

export function getOrder(businessId, orderId) {
  const db = getDb();
  const row = db.prepare("SELECT * FROM orders WHERE business_id = ? AND id = ?").get(businessId, orderId);
  if (!row) throw new NotFoundError("No such order in this workspace.");
  const items = db
    .prepare("SELECT * FROM order_items WHERE order_id = ? ORDER BY id")
    .all(orderId)
    .map((i) => ({ ...i, price_snapshot: jsonObject(i.price_snapshot) }));
  const transitions = db
    .prepare("SELECT * FROM order_transitions WHERE order_id = ? ORDER BY id")
    .all(orderId);
  const payments = db
    .prepare("SELECT * FROM payments WHERE business_id = ? AND order_id = ? ORDER BY id")
    .all(businessId, orderId);

  return {
    ...row,
    address_json: jsonObject(row.address_json),
    items,
    transitions,
    payments,
  };
}

export function listOrders(
  businessId,
  { state = null, paymentStatus = null, customerId = null, chatId = null, limit = 100, offset = 0 } = {}
) {
  const db = getDb();
  const where = ["business_id = ?"];
  const params = [businessId];
  if (state) {
    where.push("state = ?");
    params.push(state);
  }
  if (paymentStatus) {
    where.push("payment_status = ?");
    params.push(paymentStatus);
  }
  if (customerId) {
    where.push("customer_id = ?");
    params.push(customerId);
  }
  if (chatId) {
    where.push("chat_id = ?");
    params.push(chatId);
  }
  params.push(Math.min(Number(limit) || 100, 500), Number(offset) || 0);

  return db
    .prepare(`SELECT * FROM orders WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...params);
}

// ---------- state transitions ----------

export function transitionOrder(businessId, orderId, toState, { actor = "system", reason = "" } = {}) {
  const order = getOrder(businessId, orderId);

  if (!ORDER_STATES.includes(toState)) {
    throw new ValidationError(`Unknown order state "${toState}".`);
  }
  if (!canTransition(order.state, toState)) {
    throw new StateTransitionError(order.state, toState, ORDER_TRANSITIONS[order.state] || []);
  }

  transaction(() => {
    const db = getDb();
    const sets = ["state = ?", "updated_at = CURRENT_TIMESTAMP"];
    const params = [toState];

    if (toState === "confirmed") {
      sets.push("confirmed_at = CURRENT_TIMESTAMP");
    }
    if (toState === "cancelled" || toState === "rejected") {
      sets.push("cancelled_at = CURRENT_TIMESTAMP");
    }
    if (toState === "refunded") {
      sets.push("payment_status = 'refunded'");
    }
    if (toState === "payment_failed") {
      sets.push("payment_status = 'failed'");
    }

    params.push(businessId, orderId);
    db.prepare(`UPDATE orders SET ${sets.join(", ")} WHERE business_id = ? AND id = ?`).run(...params);

    db.prepare(
      `INSERT INTO order_transitions (business_id, order_id, from_state, to_state, actor, reason)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(businessId, orderId, order.state, toState, actor, reason);
  });

  // Stock side effects happen outside the state write so that a stock
  // failure does not leave the order half-transitioned.
  const lines = order.items.map((i) => ({
    productId: i.product_id,
    variantId: i.variant_id,
    quantity: i.quantity,
  }));

  if (toState === "cancelled" || toState === "rejected") {
    if (order.stock_reserved) {
      releaseReservation(businessId, lines, "order", orderId, actor);
    }
  } else if (toState === "dispatched") {
    if (order.stock_reserved) {
      consumeReservation(businessId, lines, "order", orderId, actor);
    }
  }

  audit({
    businessId,
    actor,
    action: "order.state_changed",
    details: { order_id: orderId, from: order.state, to: toState, reason },
  });

  return getOrder(businessId, orderId);
}

/** Convenience wrapper used by the payments layer once money is verified. */
export function markOrderPaymentState(businessId, orderId, paymentStatus, { actor = "system" } = {}) {
  const db = getDb();
  const order = getOrder(businessId, orderId);
  db.prepare(
    "UPDATE orders SET payment_status = ?, updated_at = CURRENT_TIMESTAMP WHERE business_id = ? AND id = ?"
  ).run(paymentStatus, businessId, orderId);
  audit({
    businessId,
    actor,
    action: "order.payment_status_changed",
    details: { order_id: orderId, from: order.payment_status, to: paymentStatus },
  });
  return getOrder(businessId, orderId);
}

// ---------- summaries ----------

export function buildSummary(lines, totals) {
  const names = lines.map((l) => `${l.name} × ${l.quantity}`).join(", ");
  return names.length > 120 ? `${names.slice(0, 117)}…` : names;
}

/** Renders the customer-facing order summary that must be approved. */
export function renderOrderSummary(order, { currency = "NPR" } = {}) {
  const lines = order.items || [];
  const itemLines = lines.map(
    (i) => `• ${i.name} — ${i.quantity} × ${roundMoney(i.unit_price)} = ${roundMoney(i.line_total)}`
  );
  const parts = [];
  parts.push(`Order ${order.order_number || order.id}`);
  parts.push(...itemLines);
  parts.push(`Subtotal: ${roundMoney(order.subtotal)} ${currency}`);
  if (Number(order.discount_amount) > 0) {
    parts.push(`Discount: -${roundMoney(order.discount_amount)} ${currency}`);
  }
  if (Number(order.tax_amount) > 0) {
    parts.push(`Tax: ${roundMoney(order.tax_amount)} ${currency}`);
  }
  if (Number(order.delivery_amount) > 0) {
    parts.push(`Delivery: ${roundMoney(order.delivery_amount)} ${currency}`);
  }
  parts.push(`Total: ${roundMoney(order.total_amount)} ${currency}`);
  return parts.join("\n");
}

/** Re-prices an existing order from its items (used by quotations/invoices). */
export function priceLines(businessId, items) {
  const business = getBusinessConfig(businessId);
  return computeTotals(items, {
    taxRate: business.tax_enabled ? business.tax_rate || 0 : 0,
    taxInclusive: Boolean(business.tax_inclusive),
  });
}
