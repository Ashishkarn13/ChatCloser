// src/services/payments/index.js
// Provider-independent payment orchestration.
//
// The contract every adapter implements:
//
//   createPaymentLink({ order, credentials, returnUrl, ... })
//        -> { providerRef, paymentUrl, instructions?, raw }
//
//   verify({ providerRef, amount, credentials })
//        -> { verified, status, amount, detail, raw }
//
// `status` is one of:
//   succeeded          the provider confirmed the money and the amount matches
//   pending            the provider knows about it but has not confirmed yet
//   failed             the provider rejected it
//   cancelled          the customer abandoned it
//   refunded           the provider refunded it
//   requires_review    something did not line up — a human must look
//
// Only "succeeded" ever marks an order as paid. There is no code path in
// this module that sets a paid status from a message, a screenshot, a
// browser redirect or an AI-generated sentence.

import { getDb, transaction } from "../../db/connection.js";
import { audit } from "../../core/audit.js";
import { NotFoundError, ValidationError } from "../../core/errors.js";
import { decrypt } from "../../../crypto-utils.js";
import { roundMoney } from "../../core/money.js";

import * as stripe from "./stripe.js";
import * as esewa from "./esewa.js";
import * as khalti from "./khalti.js";
import * as manual from "./manual.js";

export const PAYMENT_STATUSES = [
  "pending",
  "succeeded",
  "failed",
  "cancelled",
  "refunded",
  "requires_review",
];

const ADAPTERS = {
  [stripe.id]: stripe,
  [esewa.id]: esewa,
  [khalti.id]: khalti,
  [manual.id]: manual,
  [manual.bankTransfer.id]: manual.bankTransfer,
};

export function listAdapters() {
  return Object.values(ADAPTERS).map((a) => ({
    id: a.id,
    label: a.label,
    credentialFields: a.credentialFields || [],
    requiresManualApproval: Boolean(a.requiresManualApproval),
  }));
}

export function getAdapter(provider) {
  const adapter = ADAPTERS[provider];
  if (!adapter) {
    throw new ValidationError(
      `Unsupported payment provider "${provider}". Supported: ${Object.keys(ADAPTERS).join(", ")}.`
    );
  }
  return adapter;
}

/**
 * Reads a business' stored provider credentials.
 * Stripe keeps its own encrypted columns (1.x compatibility); every other
 * provider uses the generic gateway columns.
 */
export function getCredentials(business, provider) {
  if (provider === stripe.id) {
    return {
      secretKey: business.stripe_secret_key_encrypted
        ? safeDecrypt(business.stripe_secret_key_encrypted)
        : "",
      webhookSecret: business.stripe_webhook_secret_encrypted
        ? safeDecrypt(business.stripe_webhook_secret_encrypted)
        : "",
    };
  }
  return {
    merchantCode: business.payment_gateway_key_id || "",
    secretKey: business.payment_gateway_secret_encrypted
      ? safeDecrypt(business.payment_gateway_secret_encrypted)
      : "",
    instructions: business.settings?.paymentInstructions || "",
  };
}

function safeDecrypt(payload) {
  try {
    return decrypt(payload);
  } catch {
    return "";
  }
}

/**
 * Creates a payment for an order and stores the payment row.
 *
 * @param {object} params
 * @param {number} params.businessId
 * @param {object} params.order the order row (must already exist)
 * @param {string} params.provider
 * @param {string} [params.returnUrl]
 * @param {string} [params.cancelUrl]
 */
export async function createPayment(params) {
  const { businessId, order, provider, returnUrl, cancelUrl, actor = "system", environment = "sandbox" } = params;

  const adapter = getAdapter(provider);
  const business = getBusinessRow(businessId);
  const credentials = getCredentials(business, provider);

  if (!adapter.isConfigured(credentials)) {
    throw new ValidationError(
      `${adapter.label} is not configured for this workspace. Add the provider credentials first.`
    );
  }

  const link = await adapter.createPaymentLink({
    order,
    business,
    credentials,
    returnUrl,
    cancelUrl,
    failUrl: cancelUrl,
    environment,
  });

  const db = getDb();
  const payment = transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO payments
           (business_id, order_id, customer_id, provider, method, provider_ref, merchant_ref,
            amount, currency, status, verified, raw)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)`
      )
      .run(
        businessId,
        order.id,
        order.customer_id ?? null,
        provider,
        provider,
        link.providerRef,
        String(order.order_number || order.id),
        Number(order.total_amount ?? order.amount),
        order.currency || business.currency || "NPR",
        JSON.stringify(link.raw || {})
      );

    const paymentId = Number(info.lastInsertRowid);

    db.prepare(
      "UPDATE orders SET payment_url = ?, payment_method = ?, updated_at = CURRENT_TIMESTAMP WHERE business_id = ? AND id = ?"
    ).run(link.paymentUrl || null, provider, businessId, order.id);

    return db.prepare("SELECT * FROM payments WHERE id = ?").get(paymentId);
  });

  audit({
    businessId,
    actor,
    action: "payment.link_created",
    details: {
      order_id: order.id,
      provider,
      provider_ref: link.providerRef,
      amount: payment.amount,
    },
  });

  return { ...payment, paymentUrl: link.paymentUrl, instructions: link.instructions || null };
}

/**
 * Verifies a payment with the provider and, only if the provider confirms
 * it, marks the order paid.
 *
 * @param {object} params
 * @param {number} params.businessId
 * @param {number} params.paymentId
 * @param {object} [params.amountOverride] the amount the provider reported
 */
export async function verifyPayment({ businessId, paymentId, actor = "system", environment = "sandbox" }) {
  const db = getDb();
  const payment = db
    .prepare("SELECT * FROM payments WHERE business_id = ? AND id = ?")
    .get(businessId, paymentId);
  if (!payment) throw new NotFoundError("No such payment in this workspace.");

  const adapter = getAdapter(payment.provider);
  const business = getBusinessRow(businessId);
  const credentials = getCredentials(business, payment.provider);

  if (!adapter.isConfigured(credentials)) {
    throw new ValidationError(`${adapter.label} is not configured for this workspace.`);
  }

  const result = await adapter.verify({
    providerRef: payment.provider_ref,
    amount: payment.amount,
    credentials,
    environment,
  });

  const status = PAYMENT_STATUSES.includes(result.status) ? result.status : "requires_review";

  db.prepare(
    `UPDATE payments SET status = ?, verified = ?, verified_at = CURRENT_TIMESTAMP,
       verification_detail = ?, raw = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(
    status,
    result.verified ? 1 : 0,
    result.detail || "",
    JSON.stringify(result.raw || {}),
    paymentId
  );

  if (status === "succeeded" && result.verified) {
    applySuccessfulPayment(businessId, payment.order_id, payment, result, actor);
  }

  audit({
    businessId,
    actor,
    action: "payment.verified",
    details: {
      payment_id: paymentId,
      provider: payment.provider,
      status,
      verified: Boolean(result.verified),
    },
    severity: status === "succeeded" ? "info" : "warning",
  });

  return {
    ...db.prepare("SELECT * FROM payments WHERE id = ?").get(paymentId),
    verification: result,
  };
}

/**
 * Applies a verified payment: marks the order paid, allocates the money
 * against the invoice, and refreshes the customer's totals. Runs in one
 * transaction so the order and the ledger cannot disagree.
 */
export function applySuccessfulPayment(businessId, orderId, payment, result, actor = "system") {
  const db = getDb();
  return transaction(() => {
    if (orderId) {
      db.prepare(
        "UPDATE orders SET payment_status = 'paid', updated_at = CURRENT_TIMESTAMP WHERE business_id = ? AND id = ?"
      ).run(businessId, orderId);

      db.prepare(
        `INSERT INTO order_transitions (business_id, order_id, from_state, to_state, actor, reason)
         VALUES (?, ?, (SELECT state FROM orders WHERE id = ?), (SELECT state FROM orders WHERE id = ?), ?, ?)`
      ).run(businessId, orderId, orderId, orderId, actor, "Payment verified by provider");

      const invoice = db
        .prepare("SELECT id, total, amount_paid FROM invoices WHERE business_id = ? AND order_id = ?")
        .get(businessId, orderId);
      if (invoice) {
        const paid = Number(invoice.amount_paid || 0) + Number(payment.amount || 0);
        db.prepare(
          "UPDATE invoices SET amount_paid = ?, balance = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
        ).run(
          roundMoney(paid),
          roundMoney(Number(invoice.total) - paid),
          paid >= Number(invoice.total) ? "paid" : "partial",
          invoice.id
        );
      }
    }

    if (payment.customer_id) {
      db.prepare(
        `UPDATE customers SET
           lifetime_value = lifetime_value + ?,
           total_orders = total_orders + 1,
           last_order_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
         WHERE business_id = ? AND id = ?`
      ).run(Number(payment.amount || 0), businessId, payment.customer_id);
    }

    return true;
  });
}

/**
 * Records the outcome of a manual review (cash/bank transfer confirmed by
 * staff). Only an owner or a user with payments.manage may call this —
 * the permission check lives in the route layer.
 */
export function approveManualPayment(businessId, paymentId, { actor, note = "" }) {
  const db = getDb();
  const payment = db
    .prepare("SELECT * FROM payments WHERE business_id = ? AND id = ?")
    .get(businessId, paymentId);
  if (!payment) throw new NotFoundError("No such payment in this workspace.");

  db.prepare(
    `UPDATE payments SET status = 'succeeded', verified = 1, verified_at = CURRENT_TIMESTAMP,
       verification_detail = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(note || "Confirmed by staff review.", paymentId);

  applySuccessfulPayment(businessId, payment.order_id, payment, { verified: true }, actor);

  audit({
    businessId,
    actor,
    action: "payment.approved_manually",
    details: { payment_id: paymentId, note },
    severity: "warning",
  });

  return db.prepare("SELECT * FROM payments WHERE id = ?").get(paymentId);
}

export function listPayments(businessId, { status = null, orderId = null, limit = 100 } = {}) {
  const db = getDb();
  const where = ["business_id = ?"];
  const params = [businessId];
  if (status) {
    where.push("status = ?");
    params.push(status);
  }
  if (orderId) {
    where.push("order_id = ?");
    params.push(orderId);
  }
  params.push(Math.min(Number(limit) || 100, 500));
  return db
    .prepare(`SELECT * FROM payments WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`)
    .all(...params);
}

/**
 * Webhook intake. The same provider event may arrive any number of times,
 * so every event is recorded in payment_events with a unique key and only
 * processed the first time.
 *
 * @returns {{duplicate: boolean, processed: boolean, result?: object}}
 */
export function recordProviderEvent(businessId, provider, eventId, eventType, payloadHash) {
  const db = getDb();
  const existing = db
    .prepare("SELECT * FROM payment_events WHERE provider = ? AND event_id = ?")
    .get(provider, eventId);

  if (existing) {
    return { duplicate: true, processed: false, event: existing };
  }

  db.prepare(
    `INSERT INTO payment_events (business_id, provider, event_id, event_type, payload_hash, status)
     VALUES (?, ?, ?, ?, ?, 'received')`
  ).run(businessId, provider, eventId, eventType || "", payloadHash || "");

  return { duplicate: false, processed: true };
}

export function markProviderEventProcessed(businessId, provider, eventId, status = "processed", error = "") {
  const db = getDb();
  db.prepare(
    `UPDATE payment_events SET status = ?, error = ?, processed_at = CURRENT_TIMESTAMP
     WHERE business_id = ? AND provider = ? AND event_id = ?`
  ).run(status, error, businessId, provider, eventId);
}

/** Reconciles an order against its recorded payments. */
export function reconcileOrder(businessId, orderId) {
  const db = getDb();
  const order = db
    .prepare("SELECT * FROM orders WHERE business_id = ? AND id = ?")
    .get(businessId, orderId);
  if (!order) throw new NotFoundError("No such order in this workspace.");

  const payments = db
    .prepare("SELECT * FROM payments WHERE business_id = ? AND order_id = ? ORDER BY id")
    .all(businessId, orderId);

  const paid = payments
    .filter((p) => p.status === "succeeded")
    .reduce((sum, p) => sum + Number(p.amount || 0), 0);
  const refunded = payments
    .filter((p) => p.status === "refunded")
    .reduce((sum, p) => sum + Number(p.amount || 0), 0);

  const expected = Number(order.total_amount ?? order.amount ?? 0);
  const difference = roundMoney(paid - expected);

  return {
    order,
    payments,
    expected,
    paid: roundMoney(paid),
    refunded: roundMoney(refunded),
    difference,
    reconciled: Math.abs(difference) < 0.005,
    unverified: payments.filter((p) => !p.verified).length,
  };
}

function getBusinessRow(businessId) {
  const db = getDb();
  const row = db.prepare("SELECT * FROM businesses WHERE id = ?").get(businessId);
  if (!row) throw new NotFoundError(`No business with id ${businessId}.`);
  return {
    ...row,
    settings: (() => {
      try {
        return JSON.parse(row.settings || "{}");
      } catch {
        return {};
      }
    })(),
  };
}

export { ADAPTERS };
