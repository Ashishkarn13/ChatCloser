// test/workflows.test.js
// The workflow engine.
//
// Workflow definitions are data, never code. These tests check that a
// workflow only runs when its conditions are met, that its actions really
// do something, that a failing action is retried and eventually parked in
// the dead-letter queue, and that a definition cannot smuggle in an
// unknown action type.

import test from "node:test";
import assert from "node:assert/strict";
import { makeBusiness } from "./helpers.js";

import {
  createWorkflow,
  updateWorkflow,
  listWorkflows,
  fireTrigger,
  evaluateConditions,
  executeAction,
  listRuns,
  listDeadLetters,
  TRIGGERS,
  ACTIONS,
} from "../src/services/workflows.js";
import { getDb } from "../src/db/connection.js";

test("conditions are evaluated with the documented operators", () => {
  const context = { order: { total_amount: 6000, state: "confirmed" }, customer: { tag: "vip" } };

  assert.equal(
    evaluateConditions([{ field: "order.total_amount", operator: "greater_than", value: 5000 }], context).ok,
    true
  );
  assert.equal(
    evaluateConditions([{ field: "order.total_amount", operator: "less_than", value: 5000 }], context).ok,
    false
  );
  assert.equal(
    evaluateConditions([{ field: "order.state", operator: "equals", value: "confirmed" }], context).ok,
    true
  );
  assert.equal(
    evaluateConditions([{ field: "customer.tag", operator: "in", value: ["vip", "gold"] }], context).ok,
    true
  );
  assert.equal(
    evaluateConditions([{ field: "customer.tag", operator: "exists" }], context).ok,
    true
  );
  assert.equal(
    evaluateConditions([{ field: "customer.missing", operator: "exists" }], context).ok,
    false
  );
});

test("every condition must pass", () => {
  const context = { a: 1, b: 2 };
  const result = evaluateConditions(
    [
      { field: "a", operator: "equals", value: 1 },
      { field: "b", operator: "equals", value: 99 },
    ],
    context
  );
  assert.equal(result.ok, false);
  assert.equal(result.results.length, 2);
});

test("an unknown condition operator never lets a workflow through", () => {
  const result = evaluateConditions([{ field: "a", operator: "drop_everything", value: 1 }], { a: 1 });
  assert.equal(result.ok, false);
});

test("a workflow runs its action when the trigger fires", async () => {
  const businessId = await makeBusiness("Workflow Business");

  const workflow = createWorkflow(
    businessId,
    {
      name: "Big order follow-up",
      trigger_type: TRIGGERS.ORDER_CONFIRMED,
      conditions: [{ field: "order.total_amount", operator: "greater_than", value: 5000 }],
      actions: [
        {
          type: ACTIONS.CREATE_TASK,
          args: { title: "Call the customer about their large order", priority: "high" },
        },
      ],
    },
    "test"
  );

  assert.equal(workflow.version, 1);
  assert.equal(listWorkflows(businessId).length, 1);

  const result = await fireTrigger(businessId, TRIGGERS.ORDER_CONFIRMED, {
    order: { id: 1, total_amount: 6000 },
    triggerEvent: "order_confirmed",
  });

  assert.equal(result.triggered, 1);
  const runs = listRuns(businessId);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "succeeded");

  const db = getDb();
  const task = db.prepare("SELECT * FROM tasks WHERE business_id = ?").get(businessId);
  assert.ok(task);
  assert.match(task.title, /large order/);
});

test("a workflow whose conditions fail does not run", async () => {
  const businessId = await makeBusiness("Workflow Business");
  createWorkflow(
    businessId,
    {
      name: "Small order",
      trigger_type: TRIGGERS.ORDER_CONFIRMED,
      conditions: [{ field: "order.total_amount", operator: "greater_than", value: 5000 }],
      actions: [{ type: ACTIONS.CREATE_TASK, args: { title: "Should not exist" } }],
    },
    "test"
  );

  const result = await fireTrigger(businessId, TRIGGERS.ORDER_CONFIRMED, {
    order: { id: 1, total_amount: 100 },
    triggerEvent: "order_confirmed",
  });

  assert.equal(result.triggered, 0);
  const db = getDb();
  const task = db.prepare("SELECT * FROM tasks WHERE business_id = ?").get(businessId);
  assert.equal(task, undefined);
});

test("an unknown action type is refused when the workflow is saved", async () => {
  const businessId = await makeBusiness("Workflow Business");
  assert.throws(
    () =>
      createWorkflow(
        businessId,
        {
          name: "Dangerous",
          trigger_type: TRIGGERS.MANUAL,
          actions: [{ type: "run_shell_command", args: { cmd: "rm -rf /" } }],
        },
        "test"
      ),
    /Unknown action type/i
  );
});

test("a workflow cannot execute arbitrary code", async () => {
  const businessId = await makeBusiness("Workflow Business");
  const result = await executeAction(
    businessId,
    { type: "run_shell_command", args: { cmd: "echo hi" } },
    {}
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /Unknown action type/i);
});

test("a workflow may only update allow-listed fields", async () => {
  const businessId = await makeBusiness("Workflow Business");
  const result = await executeAction(
    businessId,
    { type: ACTIONS.UPDATE_FIELD, args: { entity: "order", entityId: 1, field: "total_amount", value: "1" } },
    {}
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /cannot be updated/i);
});

test("a failing action is retried and then parked in the dead-letter queue", async () => {
  const businessId = await makeBusiness("Workflow Business");

  createWorkflow(
    businessId,
    {
      name: "Broken workflow",
      trigger_type: TRIGGERS.MANUAL,
      actions: [
        {
          type: ACTIONS.UPDATE_FIELD,
          args: { entity: "lead", entityId: 99999, field: "password", value: "x" },
        },
      ],
    },
    "test"
  );

  await fireTrigger(businessId, TRIGGERS.MANUAL, { triggerEvent: "manual" });

  const runs = listRuns(businessId);
  assert.equal(runs[0].status, "failed");
  assert.equal(runs[0].attempts, 1);

  // Exhaust the retries. Each retry is due some minutes later, so the
  // backoff is moved into the past to simulate the wait.
  const { retryDueRuns } = await import("../src/services/workflows.js");
  for (let i = 0; i < 3; i += 1) {
    getDb()
      .prepare("UPDATE workflow_runs SET next_retry_at = datetime('now', '-1 minute') WHERE business_id = ?")
      .run(businessId);
    await retryDueRuns(businessId);
  }

  const deadLetters = listDeadLetters(businessId);
  assert.ok(deadLetters.length >= 1, "the workflow should end up in the dead-letter queue");

  const finalRuns = listRuns(businessId);
  assert.ok(finalRuns.some((r) => r.status === "dead_letter"));
});

test("a disabled workflow does not run", async () => {
  const businessId = await makeBusiness("Workflow Business");
  const workflow = createWorkflow(
    businessId,
    {
      name: "Off workflow",
      trigger_type: TRIGGERS.MANUAL,
      actions: [{ type: ACTIONS.CREATE_TASK, args: { title: "Nope" } }],
    },
    "test"
  );

  updateWorkflow(businessId, workflow.id, { enabled: false }, "test");

  const result = await fireTrigger(businessId, TRIGGERS.MANUAL, { triggerEvent: "manual" });
  assert.equal(result.triggered, 0);
});

test("every workflow version is snapshotted", async () => {
  const businessId = await makeBusiness("Workflow Business");
  const workflow = createWorkflow(
    businessId,
    {
      name: "Versioned",
      trigger_type: TRIGGERS.MANUAL,
      actions: [{ type: ACTIONS.CREATE_TASK, args: { title: "v1" } }],
    },
    "test"
  );

  updateWorkflow(businessId, workflow.id, { name: "Versioned v2" }, "test");

  const db = getDb();
  const versions = db
    .prepare("SELECT * FROM workflow_versions WHERE workflow_id = ? ORDER BY version")
    .all(workflow.id);
  assert.equal(versions.length, 2);
  assert.equal(versions[1].version, 2);
});
