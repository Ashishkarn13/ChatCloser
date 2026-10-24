// test/tools.test.js
// The AI tool registry.
//
// The tool registry is the boundary between the model and the business.
// These tests check that the boundary holds: unknown tools are refused,
// arguments are validated, permissions are enforced independently of the
// model's output, and sensitive tools wait for a human.

import test from "node:test";
import assert from "node:assert/strict";
import { makeBusiness, makeProduct, setStock } from "./helpers.js";

import {
  executeTool,
  listToolsForBusiness,
  setToolPermission,
  listApprovals,
  decideApproval,
  TOOL_DEFINITIONS,
} from "../src/services/ai/tools/index.js";
import { getDb } from "../src/db/connection.js";

async function setup(role = "owner") {
  const businessId = await makeBusiness("Tool Test");
  const productId = await makeProduct(businessId, { name: "Sari", price: 1200 });
  await setStock(businessId, productId, 10);
  const db = getDb();
  db.prepare("UPDATE businesses SET ai_operator_role = ? WHERE id = ?").run(role, businessId);
  return { businessId, productId };
}

test("the registry contains the tools the brief calls for", () => {
  const names = TOOL_DEFINITIONS.map((t) => t.name);
  for (const expected of [
    "search_products",
    "get_product_details",
    "check_stock",
    "calculate_quote",
    "get_delivery_options",
    "create_order_draft",
    "submit_order_for_confirmation",
    "confirm_customer_order",
    "get_order_status",
    "create_booking",
    "create_support_ticket",
    "get_payment_status",
    "request_human_takeover",
    "schedule_follow_up",
  ]) {
    assert.ok(names.includes(expected), `missing tool: ${expected}`);
  }
});

test("every tool declares an input schema and a handler", () => {
  for (const tool of TOOL_DEFINITIONS) {
    assert.ok(tool.inputSchema, `${tool.name} has no input schema`);
    assert.equal(typeof tool.handler, "function", `${tool.name} has no handler`);
    assert.ok(Array.isArray(tool.requiredPermissions));
  }
});

test("an unknown tool is refused", async () => {
  const { businessId } = await setup();
  const result = await executeTool({
    businessId,
    toolName: "drop_database",
    args: {},
    ctx: {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "unknown_tool");
});

test("arguments are validated against the schema", async () => {
  const { businessId } = await setup();

  const missing = await executeTool({
    businessId,
    toolName: "search_products",
    args: {},
    ctx: {},
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, "invalid_arguments");

  const wrongType = await executeTool({
    businessId,
    toolName: "search_products",
    args: { query: 42, limit: "many" },
    ctx: {},
  });
  assert.equal(wrongType.ok, false);
  assert.equal(wrongType.code, "invalid_arguments");
});

test("a valid search returns catalogue prices, not model-supplied ones", async () => {
  const { businessId } = await setup();
  const result = await executeTool({
    businessId,
    toolName: "search_products",
    args: { query: "Sari" },
    ctx: {},
  });

  assert.equal(result.ok, true);
  assert.equal(result.result.count, 1);
  assert.equal(result.result.results[0].price, 1200);
});

test("a disabled tool is refused even if the model asks for it", async () => {
  const { businessId } = await setup();
  setToolPermission(businessId, "search_products", { enabled: false }, "test");

  const result = await executeTool({
    businessId,
    toolName: "search_products",
    args: { query: "Sari" },
    ctx: {},
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "tool_disabled");
  assert.ok(!listToolsForBusiness(businessId).some((t) => t.name === "search_products"));
});

test("a tool the AI's role is not allowed to use is refused", async () => {
  const { businessId } = await setup("viewer");

  const result = await executeTool({
    businessId,
    toolName: "create_order_draft",
    args: { items: [{ name: "Sari", quantity: 1 }] },
    ctx: {},
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "missing_permission");
});

test("a tool that requires approval does not run, it queues a request", async () => {
  const { businessId } = await setup();
  const db = getDb();
  const orderId = db.prepare("SELECT id FROM orders LIMIT 1").get()?.id ?? null;
  void orderId;

  const productId = await makeProduct(businessId, { name: "Cancellable", price: 100 });
  const draft = await import("../src/services/orders.js");
  const built = draft.buildDraft(businessId, { items: [{ productId, quantity: 1 }] });
  const saved = draft.saveDraft(businessId, built);
  const order = draft.confirmDraft(businessId, saved.id, {
    actor: "customer",
    customerApproved: true,
  });

  const result = await executeTool({
    businessId,
    toolName: "cancel_order",
    args: { orderId: order.id, reason: "customer changed their mind" },
    ctx: {},
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "awaiting_approval");
  assert.ok(result.approvalId);

  // Nothing was cancelled.
  assert.equal(draft.getOrder(businessId, order.id).state, "confirmed");

  const pending = listApprovals(businessId, { status: "pending" });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].tool_name, "cancel_order");

  decideApproval(businessId, result.approvalId, { decision: "approve", actor: "owner", note: "ok" });
  assert.equal(listApprovals(businessId, { status: "pending" }).length, 0);
});

test("every executed tool is written to the audit log", async () => {
  const { businessId } = await setup();
  await executeTool({
    businessId,
    toolName: "search_products",
    args: { query: "Sari" },
    ctx: { actor: "ai" },
  });

  const db = getDb();
  const row = db
    .prepare(
      "SELECT * FROM audit_log WHERE business_id = ? AND action = 'ai.tool_executed' ORDER BY id DESC LIMIT 1"
    )
    .get(businessId);
  assert.ok(row);
  assert.match(row.details, /search_products/);
});

test("the AI can never grant itself a permission", async () => {
  const { businessId } = await setup("viewer");

  // Even if the model somehow asks for a restricted tool with elevated
  // arguments, the check is made against the configured operator role.
  const result = await executeTool({
    businessId,
    toolName: "cancel_order",
    args: { orderId: 1, role: "owner" },
    ctx: { role: "owner" },
  });

  // The ctx.role override is only honoured when it matches the business
  // configuration; a caller cannot smuggle a role in.
  assert.equal(result.ok, false);
});
