// test/orders.test.js
// The order lifecycle: draft → explicit customer confirmation → confirmed.
//
// The rules under test are the ones that protect a business from a
// hallucinating assistant:
//   * no order exists until the customer confirms
//   * prices come from the catalogue, never from the caller
//   * a price change invalidates the draft
//   * stock is reserved atomically with the order
//   * confirming twice does not create two orders

import test from "node:test";
import assert from "node:assert/strict";
import { makeBusiness, makeProduct, setStock } from "./helpers.js";

import {
  buildDraft,
  saveDraft,
  getDraft,
  confirmDraft,
  transitionOrder,
  listOrders,
  getOrder,
  canTransition,
  ORDER_STATES,
} from "../src/services/orders.js";
import { getStock } from "../src/services/inventory.js";
import { getDb } from "../src/db/connection.js";

async function setup(options = {}) {
  const businessId = await makeBusiness("Order Test", options);
  const productId = await makeProduct(businessId, {
    name: "Blue Sari",
    price: 1500,
    tax_rate: 0,
    track_inventory: 1,
  });
  await setStock(businessId, productId, 100);
  return { businessId, productId };
}

test("a draft is priced from the catalogue, not from the caller's text", async () => {
  const { businessId } = await setup();
  const productId = await makeProduct(businessId, { name: "Kurta", price: 2500 });

  const draft = buildDraft(businessId, {
    items: [{ name: "Kurta", quantity: 2, price: 1 }],
  });

  assert.equal(draft.lines.length, 1);
  // The caller claimed a price of 1 — the catalogue price (2500) must win.
  assert.equal(draft.lines[0].unitPrice, 2500);
  assert.equal(draft.totals.total, 5000);
});

test("an unrecognised item is reported instead of being priced by guesswork", async () => {
  const { businessId } = await setup();
  const draft = buildDraft(businessId, { items: [{ name: "Nonexistent Widget", quantity: 1 }] });

  assert.equal(draft.lines.length, 0);
  assert.equal(draft.problems.length, 1);
  assert.match(draft.problems[0].message, /not in our catalogue/i);
});

test("no order exists until the customer confirms", async () => {
  const { businessId, productId } = await setup();
  const draft = buildDraft(businessId, { items: [{ productId, quantity: 1 }] });
  const saved = saveDraft(businessId, draft);

  assert.equal(listOrders(businessId).length, 0);

  // A draft with no explicit customer approval cannot be confirmed.
  await assert.rejects(
    async () => confirmDraft(businessId, saved.id, { actor: "customer" }),
    /explicit confirmation/i
  );

  assert.equal(listOrders(businessId).length, 0);
});

test("an approved draft becomes a real order with the catalogue total", async () => {
  const { businessId, productId } = await setup();
  const draft = buildDraft(businessId, { items: [{ productId, quantity: 2 }] });
  const saved = saveDraft(businessId, draft);

  const order = confirmDraft(businessId, saved.id, { actor: "customer", customerApproved: true });

  assert.equal(order.state, "confirmed");
  assert.equal(order.total_amount, 3000);
  assert.equal(order.items.length, 1);
  assert.equal(order.items[0].quantity, 2);
  assert.match(order.order_number, /^ORD-\d{4}-\d{4}$/);
  assert.equal(listOrders(businessId).length, 1);
});

test("a price change between the summary and the confirmation invalidates the draft", async () => {
  const { businessId, productId } = await setup();
  const draft = buildDraft(businessId, { items: [{ productId, quantity: 1 }] });
  const saved = saveDraft(businessId, draft);

  // The price changes while the customer is deciding.
  getDb()
    .prepare("UPDATE products SET price = 1700 WHERE id = ?")
    .run(productId);

  await assert.rejects(
    async () => confirmDraft(businessId, saved.id, { actor: "customer", customerApproved: true }),
    (err) => {
      assert.match(err.message, /price changed/i);
      assert.equal(err.details.changed[0].now, 1700);
      return true;
    }
  );

  // Nothing was created.
  assert.equal(listOrders(businessId).length, 0);
});

test("stock is reserved when the order is created and released when it is cancelled", async () => {
  const { businessId, productId } = await setup();

  const draft = buildDraft(businessId, { items: [{ productId, quantity: 2 }] });
  const saved = saveDraft(businessId, draft);
  const order = confirmDraft(businessId, saved.id, { actor: "customer", customerApproved: true });

  const afterConfirm = getStock(businessId, productId);
  assert.equal(afterConfirm.quantity_on_hand, 100);
  assert.equal(afterConfirm.quantity_reserved, 2);
  assert.equal(afterConfirm.available, 98);

  transitionOrder(businessId, order.id, "cancelled", { actor: "staff", reason: "test" });

  const afterCancel = getStock(businessId, productId);
  assert.equal(afterCancel.quantity_reserved, 0);
  assert.equal(afterCancel.available, 100);
});

test("an order that exceeds available stock cannot be created", async () => {
  const { businessId } = await setup();
  const scarceId = await makeProduct(businessId, { name: "Last One", price: 500, track_inventory: 1 });

  const draft = buildDraft(businessId, { items: [{ productId: scarceId, quantity: 3 }] });
  const saved = saveDraft(businessId, draft);

  await assert.rejects(
    async () => confirmDraft(businessId, saved.id, { actor: "customer", customerApproved: true }),
    /available/i
  );
  assert.equal(listOrders(businessId).length, 0);
});

test("confirming the same draft twice does not create two orders", async () => {
  const { businessId, productId } = await setup();
  const draft = buildDraft(businessId, { items: [{ productId, quantity: 1 }] });
  const saved = saveDraft(businessId, draft);

  const first = confirmDraft(businessId, saved.id, { actor: "customer", customerApproved: true, idempotencyKey: "draft-1" });
  const second = confirmDraft(businessId, saved.id, { actor: "customer", customerApproved: true, idempotencyKey: "draft-1" });

  assert.equal(first.id, second.id);
  assert.equal(listOrders(businessId).length, 1);
});

test("invalid state transitions are rejected", async () => {
  const { businessId, productId } = await setup();
  const draft = buildDraft(businessId, { items: [{ productId, quantity: 1 }] });
  const saved = saveDraft(businessId, draft);
  const order = confirmDraft(businessId, saved.id, { actor: "customer", customerApproved: true });

  await assert.rejects(
    async () => transitionOrder(businessId, order.id, "delivered", { actor: "staff" }),
    /Cannot move an order/i
  );

  assert.equal(canTransition("confirmed", "processing"), true);
  assert.equal(canTransition("confirmed", "delivered"), false);
  assert.equal(canTransition("cancelled", "confirmed"), false);
});

test("the full fulfilment path is recorded as a timeline", async () => {
  const { businessId, productId } = await setup();

  const draft = buildDraft(businessId, { items: [{ productId, quantity: 1 }] });
  const saved = saveDraft(businessId, draft);
  const order = confirmDraft(businessId, saved.id, { actor: "customer", customerApproved: true });

  transitionOrder(businessId, order.id, "processing", { actor: "staff" });
  transitionOrder(businessId, order.id, "dispatched", { actor: "staff" });
  const delivered = transitionOrder(businessId, order.id, "delivered", { actor: "staff" });

  assert.equal(delivered.state, "delivered");
  assert.ok(delivered.transitions.length >= 4);

  // Dispatching consumes the reservation and takes the goods off the shelf.
  const stock = getStock(businessId, productId);
  assert.equal(stock.quantity_on_hand, 99);
  assert.equal(stock.quantity_reserved, 0);
});

test("every known state is reachable and no unknown state is accepted", async () => {
  const { businessId, productId } = await setup();
  const draft = buildDraft(businessId, { items: [{ productId, quantity: 1 }] });
  const saved = saveDraft(businessId, draft);
  const order = confirmDraft(businessId, saved.id, { actor: "customer", customerApproved: true });

  await assert.rejects(
    async () => transitionOrder(businessId, order.id, "teleported", { actor: "staff" }),
    /Unknown order state/i
  );
  assert.ok(ORDER_STATES.includes(order.state));
});

test("a draft belongs to one business and cannot be confirmed by another", async () => {
  const { businessId, productId } = await setup();
  const otherBusiness = await makeBusiness("Other Business");

  const draft = buildDraft(businessId, { items: [{ productId, quantity: 1 }] });
  const saved = saveDraft(businessId, draft);

  await assert.rejects(async () => getDraft(otherBusiness, saved.id), /No such order draft/i);
  await assert.rejects(
    async () => confirmDraft(otherBusiness, saved.id, { actor: "customer", customerApproved: true }),
    /No such order draft/i
  );
});
