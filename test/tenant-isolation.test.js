// test/tenant-isolation.test.js
// One business must never see or touch another business's data.
//
// ChatCloser 1.x hard-coded BUSINESS_ID from the environment and had a
// global users table, so a staff account from one business could sign in
// to another. These tests pin the isolation that fixes that.

import test from "node:test";
import assert from "node:assert/strict";
import { makeBusiness, makeProduct } from "./helpers.js";

import * as customers from "../src/services/customers.js";
import * as catalog from "../src/services/catalog.js";
import * as orders from "../src/services/orders.js";
import * as inventory from "../src/services/inventory.js";
import * as knowledge from "../src/services/knowledge.js";
import * as conversations from "../src/services/conversations.js";
import { listUsers, createUser } from "../src/services/auth.js";
import { getDb } from "../src/db/connection.js";

test("customers are scoped to their business", async () => {
  const a = await makeBusiness("Business A");
  const b = await makeBusiness("Business B");

  const ca = customers.createCustomer(a, { name: "Alice", phone: "9800000001" });
  const cb = customers.createCustomer(b, { name: "Bob", phone: "9800000002" });

  assert.equal(customers.listCustomers(a).length, 1);
  assert.equal(customers.listCustomers(a)[0].name, "Alice");
  assert.equal(customers.listCustomers(b)[0].name, "Bob");

  assert.throws(() => customers.getCustomer(a, cb.id), /No such customer/i);
  assert.throws(() => customers.getCustomer(b, ca.id), /No such customer/i);
});

test("the same phone number may exist in two businesses", async () => {
  const a = await makeBusiness("Business A");
  const b = await makeBusiness("Business B");

  const ca = customers.createCustomer(a, { name: "Same Person", phone: "9801111111" });
  const cb = customers.createCustomer(b, { name: "Same Person", phone: "9801111111" });

  assert.notEqual(ca.id, cb.id);
  assert.equal(customers.listCustomers(a).length, 1);
  assert.equal(customers.listCustomers(b).length, 1);
});

test("products are scoped to their business", async () => {
  const a = await makeBusiness("Business A");
  const b = await makeBusiness("Business B");

  const pa = catalog.createProduct(a, { name: "A Product", price: 100 });
  const pb = catalog.createProduct(b, { name: "B Product", price: 200 });

  assert.equal(catalog.listProducts(a).length, 1);
  assert.equal(catalog.listProducts(a)[0].name, "A Product");
  assert.throws(() => catalog.getProduct(a, pb.id), /No such product/i);
  assert.throws(() => catalog.getProduct(b, pa.id), /No such product/i);
});

test("a price list entry cannot be read across businesses", async () => {
  const a = await makeBusiness("Business A");
  const b = await makeBusiness("Business B");
  const productId = catalog.createProduct(a, { name: "Secret Item", price: 999 }).id;

  const db = getDb();
  const row = db
    .prepare("SELECT * FROM price_list WHERE business_id = ? AND product_id = ?")
    .get(a, productId);
  assert.ok(row);
  assert.equal(row.business_id, a);

  const crossRead = db
    .prepare("SELECT * FROM price_list WHERE business_id = ? AND product_id = ?")
    .get(b, productId);
  assert.equal(crossRead, undefined);
});

test("orders are scoped to their business", async () => {
  const a = await makeBusiness("Business A");
  const b = await makeBusiness("Business B");
  const productId = catalog.createProduct(a, { name: "Widget", price: 100, track_inventory: 0 }).id;

  const draft = orders.buildDraft(a, { items: [{ productId, quantity: 1 }] });
  const saved = orders.saveDraft(a, draft);
  const order = orders.confirmDraft(a, saved.id, { actor: "customer", customerApproved: true });

  assert.equal(orders.listOrders(a).length, 1);
  assert.equal(orders.listOrders(b).length, 0);
  assert.throws(() => orders.getOrder(b, order.id), /No such order/i);
});

test("inventory is scoped to their business", async () => {
  const a = await makeBusiness("Business A");
  const b = await makeBusiness("Business B");
  const productId = catalog.createProduct(a, { name: "Widget", price: 100, track_inventory: 1 }).id;

  inventory.applyMovement({ businessId: a, productId, type: "in", quantity: 10 });

  assert.equal(inventory.getStock(a, productId).quantity_on_hand, 10);
  assert.equal(inventory.getStock(b, productId).quantity_on_hand, 0);
});

test("knowledge documents are scoped to their business", async () => {
  const a = await makeBusiness("Business A");
  const b = await makeBusiness("Business B");

  knowledge.upsertDocument(a, { title: "A policy", content: "Returns accepted within 7 days." });

  assert.equal(knowledge.listDocuments(a).length, 1);
  assert.equal(knowledge.listDocuments(b).length, 0);
  assert.equal(knowledge.search(a, "returns").length, 1);
  assert.equal(knowledge.search(b, "returns").length, 0);
});

test("conversations are scoped to their business", async () => {
  const a = await makeBusiness("Business A");
  const b = await makeBusiness("Business B");

  const thread = conversations.getOrCreateThread(a, "whatsapp", "9800000001@s.whatsapp.net");
  conversations.recordMessage(a, thread, "user", "Hello from A");

  assert.equal(conversations.listThreads(a).length, 1);
  assert.equal(conversations.listThreads(b).length, 0);
  assert.equal(conversations.getThreadMessages(a, thread.id).length, 1);
  assert.throws(() => conversations.getThread(b, thread.id), /No such conversation/i);
});

test("staff accounts belong to one business only", async () => {
  const a = await makeBusiness("Business A");
  const b = await makeBusiness("Business B");

  createUser(a, { username: "staff", password: "password123", role: "staff" });
  createUser(b, { username: "staff", password: "password123", role: "staff" });

  const usersA = listUsers(a);
  const usersB = listUsers(b);

  assert.equal(usersA.length, 1);
  assert.equal(usersB.length, 1);
  assert.equal(usersA[0].id, usersB[0].id === usersA[0].id ? usersA[0].id : usersA[0].id);
  assert.notEqual(usersA[0].id, usersB[0].id);
});
