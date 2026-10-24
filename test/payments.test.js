// test/payments.test.js
// Payment verification.
//
// The rule the whole design exists for: a payment is only ever "succeeded"
// when the provider itself says so. Screenshots, customer messages and AI
// statements are never accepted.
//
// The provider HTTP calls are stubbed so the tests never touch a live
// payment service and never spend real money.

import test from "node:test";
import assert from "node:assert/strict";
import { makeBusiness, makeProduct } from "./helpers.js";

import * as payments from "../src/services/payments/index.js";
import * as esewa from "../src/services/payments/esewa.js";
import * as khalti from "../src/services/payments/khalti.js";
import { buildDraft, saveDraft, confirmDraft, getOrder } from "../src/services/orders.js";
import { getDb } from "../src/db/connection.js";

const originalFetch = global.fetch;

function stubFetch(handler) {
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return handler(String(url), options, calls.length);
  };
  return calls;
}

test.afterEach(() => {
  global.fetch = originalFetch;
});

async function setupWithOrder() {
  const businessId = await makeBusiness("Payment Test");
  const productId = await makeProduct(businessId, { name: "Item", price: 1000 });
  const draft = buildDraft(businessId, { items: [{ productId, quantity: 1 }] });
  const saved = saveDraft(businessId, draft);
  const order = confirmDraft(businessId, saved.id, { actor: "customer", customerApproved: true });
  return { businessId, order };
}

test("the provider list contains the Nepal providers and cash on delivery", () => {
  const ids = payments.listAdapters().map((a) => a.id);
  assert.ok(ids.includes("stripe"));
  assert.ok(ids.includes("esewa"));
  assert.ok(ids.includes("khalti"));
  assert.ok(ids.includes("cash_on_delivery"));
  assert.ok(ids.includes("bank_transfer"));
});

test("an unknown provider is refused", async () => {
  await assert.rejects(
    async () => payments.getAdapter("western_union"),
    /Unsupported payment provider/i
  );
});

test("eSewa verification treats only COMPLETE as paid", async () => {
  const credentials = { merchantCode: "EPAYTEST", secretKey: "secret" };

  stubFetch(async () => ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({ status: "COMPLETE", total_amount: 1000, transaction_code: "000ABC" }),
  }));

  const result = await esewa.verify({ providerRef: "txn-1", amount: 1000, credentials });
  assert.equal(result.verified, true);
  assert.equal(result.status, "succeeded");
});

test("eSewa verification refuses a pending transaction", async () => {
  const credentials = { merchantCode: "EPAYTEST", secretKey: "secret" };

  stubFetch(async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ status: "PENDING" }),
  }));

  const result = await esewa.verify({ providerRef: "txn-1", amount: 1000, credentials });
  assert.equal(result.verified, false);
  assert.equal(result.status, "pending");
});

test("eSewa verification refuses a COMPLETE transaction with the wrong amount", async () => {
  const credentials = { merchantCode: "EPAYTEST", secretKey: "secret" };

  stubFetch(async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ status: "COMPLETE", total_amount: 500 }),
  }));

  const result = await esewa.verify({ providerRef: "txn-1", amount: 1000, credentials });
  assert.equal(result.verified, false);
  assert.equal(result.status, "requires_review");
  assert.match(result.detail, /mismatch/i);
});

test("Khalti verification treats only Completed as paid", async () => {
  const credentials = { secretKey: "test_secret" };

  stubFetch(async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ status: "Completed", total_amount: 100000 }),
  }));

  const result = await khalti.verify({ providerRef: "pidx-1", amount: 1000, credentials });
  assert.equal(result.verified, true);
  assert.equal(result.status, "succeeded");
  assert.equal(result.amount, 1000);
});

test("Khalti verification refuses an expired payment link", async () => {
  const credentials = { secretKey: "test_secret" };

  stubFetch(async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ status: "Expired" }),
  }));

  const result = await khalti.verify({ providerRef: "pidx-1", amount: 1000, credentials });
  assert.equal(result.verified, false);
  assert.equal(result.status, "requires_review");
});

test("an unreachable provider results in manual review, never in a paid order", async () => {
  const credentials = { secretKey: "test_secret" };

  stubFetch(async () => {
    throw new Error("network unreachable");
  });

  const result = await khalti.verify({ providerRef: "pidx-1", amount: 1000, credentials });
  assert.equal(result.verified, false);
  assert.equal(result.status, "requires_review");
});

test("a verified payment marks the order paid and records it", async () => {
  const { businessId, order } = await setupWithOrder();

  const db = getDb();
  db.prepare(
    "UPDATE businesses SET payment_gateway_secret_encrypted = ?, payment_gateway_key_id = ? WHERE id = ?"
  ).run("encrypted", "EPAYTEST", businessId);

  // Store a real encrypted secret so the adapter can read it.
  const { encrypt } = await import("../crypto-utils.js");
  db.prepare(
    "UPDATE businesses SET payment_gateway_secret_encrypted = ?, payment_gateway_key_id = ? WHERE id = ?"
  ).run(encrypt("secret"), "EPAYTEST", businessId);

  stubFetch(async (url) => {
    if (url.includes("/initiate/")) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ redirect_url: "https://esewa.com.np/pay/test" }),
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ status: "COMPLETE", total_amount: 1000 }),
    };
  });

  const payment = await payments.createPayment({
    businessId,
    order: getOrder(businessId, order.id),
    provider: "esewa",
    actor: "test",
  });

  assert.equal(payment.status, "pending");
  assert.equal(payment.verified, 0);
  assert.equal(getOrder(businessId, order.id).payment_status, "pending");

  const result = await payments.verifyPayment({ businessId, paymentId: payment.id, actor: "test" });

  assert.equal(result.verification.verified, true);
  assert.equal(getOrder(businessId, order.id).payment_status, "paid");
});

test("the same provider event is only processed once", async () => {
  const businessId = await makeBusiness("Idempotency Test");

  const first = payments.recordProviderEvent(businessId, "stripe", "evt_1", "checkout.session.completed");
  assert.equal(first.duplicate, false);
  assert.equal(first.processed, true);

  const second = payments.recordProviderEvent(businessId, "stripe", "evt_1", "checkout.session.completed");
  assert.equal(second.duplicate, true);
  assert.equal(second.processed, false);
});

test("a manual payment needs a staff member before it is marked paid", async () => {
  const { businessId, order } = await setupWithOrder();

  const db = getDb();
  const info = db
    .prepare(
      `INSERT INTO payments (business_id, order_id, provider, method, provider_ref, amount, currency, status)
       VALUES (?, ?, 'bank_transfer', 'bank_transfer', 'manual-1', 1000, 'NPR', 'requires_review')`
    )
    .run(businessId, order.id);
  const paymentId = Number(info.lastInsertRowid);

  assert.equal(getOrder(businessId, order.id).payment_status, "pending");

  payments.approveManualPayment(businessId, paymentId, { actor: "owner", note: "Bank statement checked" });

  assert.equal(getOrder(businessId, order.id).payment_status, "paid");

  const db2 = getDb();
  const audit = db2
    .prepare("SELECT * FROM audit_log WHERE business_id = ? AND action = 'payment.approved_manually'")
    .get(businessId);
  assert.ok(audit);
});

test("reconciliation reports the difference between paid and expected", async () => {
  const { businessId, order } = await setupWithOrder();

  const db = getDb();
  db.prepare(
    `INSERT INTO payments (business_id, order_id, provider, provider_ref, amount, currency, status, verified)
     VALUES (?, ?, 'stripe', 'cs_1', 500, 'NPR', 'succeeded', 1)`
  ).run(businessId, order.id);

  const reconciliation = payments.reconcileOrder(businessId, order.id);
  assert.equal(reconciliation.expected, 1000);
  assert.equal(reconciliation.paid, 500);
  assert.equal(reconciliation.reconciled, false);
});
