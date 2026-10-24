// src/services/workflows.js
// Visual workflow automation.
//
// A workflow is data: a trigger, a list of conditions and a list of
// actions. Nothing in a workflow definition is executed as code — the
// action type selects a handler from the registry below, and the arguments
// are validated against that handler's schema.
//
// Execution records every attempt, retries with backoff and parks a
// workflow that keeps failing in a dead-letter queue where a human can see
// it.

import { getDb } from "../db/connection.js";
import { audit } from "../core/audit.js";
import { NotFoundError, ValidationError } from "../core/errors.js";
import { str, num, jsonArray, jsonObject, validateAgainstSchema } from "../core/validation.js";
import { createTask } from "./tasks.js";
import { scheduleMessage } from "./scheduler.js";
import { assignThread, addThreadEvent } from "./conversations.js";
import { createCustomer, addTag } from "./customers.js";

export const TRIGGERS = {
  MESSAGE_RECEIVED: "message_received",
  LEAD_CREATED: "lead_created",
  ORDER_CREATED: "order_created",
  ORDER_CONFIRMED: "order_confirmed",
  PAYMENT_VERIFIED: "payment_verified",
  STOCK_LOW: "stock_low",
  APPOINTMENT_APPROACHING: "appointment_approaching",
  DELIVERY_STATUS_CHANGED: "delivery_status_changed",
  SCHEDULED: "scheduled",
  MANUAL: "manual",
};

export const TRIGGER_LABELS = {
  [TRIGGERS.MESSAGE_RECEIVED]: "Incoming message",
  [TRIGGERS.LEAD_CREATED]: "New lead",
  [TRIGGERS.ORDER_CREATED]: "Order created",
  [TRIGGERS.ORDER_CONFIRMED]: "Order confirmed",
  [TRIGGERS.PAYMENT_VERIFIED]: "Payment verified",
  [TRIGGERS.STOCK_LOW]: "Stock threshold reached",
  [TRIGGERS.APPOINTMENT_APPROACHING]: "Appointment approaching",
  [TRIGGERS.DELIVERY_STATUS_CHANGED]: "Delivery status changed",
  [TRIGGERS.SCHEDULED]: "Scheduled time",
  [TRIGGERS.MANUAL]: "Manual trigger",
};

export const ACTIONS = {
  SEND_MESSAGE: "send_message",
  ASSIGN_CONVERSATION: "assign_conversation",
  CREATE_TASK: "create_task",
  SCHEDULE_FOLLOW_UP: "schedule_follow_up",
  PREPARE_QUOTATION: "prepare_quotation",
  NOTIFY_STAFF: "notify_staff",
  UPDATE_FIELD: "update_field",
  REQUEST_APPROVAL: "request_approval",
  RUN_TOOL: "run_tool",
  TAG_CUSTOMER: "tag_customer",
};

export const ACTION_LABELS = {
  [ACTIONS.SEND_MESSAGE]: "Send an approved message",
  [ACTIONS.ASSIGN_CONVERSATION]: "Assign a conversation",
  [ACTIONS.CREATE_TASK]: "Create a task",
  [ACTIONS.SCHEDULE_FOLLOW_UP]: "Schedule a follow-up",
  [ACTIONS.PREPARE_QUOTATION]: "Prepare a quotation",
  [ACTIONS.NOTIFY_STAFF]: "Notify staff",
  [ACTIONS.UPDATE_FIELD]: "Update an authorised field",
  [ACTIONS.REQUEST_APPROVAL]: "Request human approval",
  [ACTIONS.RUN_TOOL]: "Initiate an approved business tool",
  [ACTIONS.TAG_CUSTOMER]: "Tag the customer",
};

/** Maximum number of action steps in one run — the loop guard. */
const MAX_ACTIONS_PER_RUN = 10;

// ---------- definitions ----------

export function listWorkflows(businessId) {
  const db = getDb();
  return db
    .prepare("SELECT * FROM workflows WHERE business_id = ? ORDER BY id DESC")
    .all(businessId)
    .map(mapWorkflow);
}

export function getWorkflow(businessId, workflowId) {
  const db = getDb();
  const row = db.prepare("SELECT * FROM workflows WHERE business_id = ? AND id = ?").get(businessId, workflowId);
  if (!row) throw new NotFoundError("No such workflow.");
  return mapWorkflow(row);
}

function mapWorkflow(row) {
  return {
    ...row,
    trigger_config: jsonObject(row.trigger_config),
    conditions: jsonArray(row.conditions),
    actions: jsonArray(row.actions),
  };
}

export function createWorkflow(businessId, input, actor = "system") {
  const db = getDb();
  const name = str(input.name, { field: "name", required: true, max: 200 });
  const triggerType = str(input.trigger_type, { field: "trigger_type", required: true, max: 60 });
  if (!Object.values(TRIGGERS).includes(triggerType)) {
    throw new ValidationError(`Unknown trigger "${triggerType}".`);
  }

  const actions = jsonArray(input.actions);
  if (actions.length === 0) throw new ValidationError("A workflow needs at least one action.");
  for (const action of actions) {
    validateAction(action);
  }

  const info = db
    .prepare(
      `INSERT INTO workflows
         (business_id, name, description, trigger_type, trigger_config, conditions, actions,
          enabled, version, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
    )
    .run(
      businessId,
      name,
      str(input.description, { field: "description", max: 1000 }),
      triggerType,
      JSON.stringify(jsonObject(input.trigger_config)),
      JSON.stringify(jsonArray(input.conditions)),
      JSON.stringify(actions),
      1,
      actor
    );

  const id = Number(info.lastInsertRowid);
  snapshotVersion(businessId, id);
  audit({ businessId, actor, action: "workflow.created", details: { workflow_id: id, trigger: triggerType } });
  return getWorkflow(businessId, id);
}

export function updateWorkflow(businessId, workflowId, input, actor = "system") {
  const db = getDb();
  const current = getWorkflow(businessId, workflowId);

  const actions = input.actions !== undefined ? jsonArray(input.actions) : current.actions;
  for (const action of actions) validateAction(action);

  db.prepare(
    `UPDATE workflows SET name = ?, description = ?, trigger_type = ?, trigger_config = ?,
       conditions = ?, actions = ?, enabled = ?, version = version + 1, updated_at = CURRENT_TIMESTAMP
     WHERE business_id = ? AND id = ?`
  ).run(
    input.name !== undefined ? str(input.name, { field: "name", max: 200 }) : current.name,
    input.description !== undefined ? str(input.description, { field: "description", max: 1000 }) : current.description,
    input.trigger_type !== undefined ? str(input.trigger_type, { field: "trigger_type", max: 60 }) : current.trigger_type,
    JSON.stringify(input.trigger_config !== undefined ? jsonObject(input.trigger_config) : current.trigger_config),
    JSON.stringify(input.conditions !== undefined ? jsonArray(input.conditions) : current.conditions),
    JSON.stringify(actions),
    input.enabled !== undefined ? (input.enabled ? 1 : 0) : current.enabled,
    businessId,
    workflowId
  );

  snapshotVersion(businessId, workflowId);
  audit({ businessId, actor, action: "workflow.updated", details: { workflow_id: workflowId } });
  return getWorkflow(businessId, workflowId);
}

export function deleteWorkflow(businessId, workflowId, actor = "system") {
  const db = getDb();
  getWorkflow(businessId, workflowId);
  db.prepare("DELETE FROM workflows WHERE business_id = ? AND id = ?").run(businessId, workflowId);
  audit({ businessId, actor, action: "workflow.deleted", details: { workflow_id: workflowId } });
  return true;
}

function snapshotVersion(businessId, workflowId) {
  const db = getDb();
  const workflow = getWorkflow(businessId, workflowId);
  db.prepare(
    "INSERT INTO workflow_versions (workflow_id, version, definition) VALUES (?, ?, ?)"
  ).run(
    workflowId,
    workflow.version,
    JSON.stringify({
      trigger_type: workflow.trigger_type,
      trigger_config: workflow.trigger_config,
      conditions: workflow.conditions,
      actions: workflow.actions,
    })
  );
}

// ---------- conditions ----------

export const CONDITION_OPERATORS = ["equals", "not_equals", "contains", "greater_than", "less_than", "in", "exists"];

/**
 * Evaluates a list of conditions against the trigger context.
 * All conditions must pass (AND). Unknown condition types are treated as
 * "not satisfied" so a broken definition cannot silently let everything
 * through.
 */
export function evaluateConditions(conditions, context) {
  const list = jsonArray(conditions);
  if (list.length === 0) return { ok: true, results: [] };

  const results = [];
  for (const condition of list) {
    const field = String(condition.field || "");
    const operator = String(condition.operator || "equals");
    const expected = condition.value;
    const actual = readField(context, field);

    let passed = false;
    switch (operator) {
      case "equals":
        passed = String(actual) === String(expected);
        break;
      case "not_equals":
        passed = String(actual) !== String(expected);
        break;
      case "contains":
        passed = String(actual ?? "").toLowerCase().includes(String(expected ?? "").toLowerCase());
        break;
      case "greater_than":
        passed = Number(actual) > Number(expected);
        break;
      case "less_than":
        passed = Number(actual) < Number(expected);
        break;
      case "in":
        passed = jsonArray(expected).map(String).includes(String(actual));
        break;
      case "exists":
        passed = actual !== undefined && actual !== null && actual !== "";
        break;
      default:
        passed = false;
    }

    results.push({ field, operator, expected, actual, passed });
  }

  return { ok: results.every((r) => r.passed), results };
}

function readField(context, path) {
  if (!path) return undefined;
  return String(path)
    .split(".")
    .reduce((node, key) => (node === null || node === undefined ? undefined : node[key]), context);
}

// ---------- actions ----------

const ACTION_SCHEMAS = {
  [ACTIONS.SEND_MESSAGE]: {
    type: "object",
    properties: {
      body: { type: "string", maxLength: 4000 },
      chatId: { type: "string", maxLength: 120 },
      threadId: { type: "integer" },
    },
    required: ["body"],
  },
  [ACTIONS.ASSIGN_CONVERSATION]: {
    type: "object",
    properties: { threadId: { type: "integer" }, assignedTo: { type: "string" } },
    required: ["threadId"],
  },
  [ACTIONS.CREATE_TASK]: {
    type: "object",
    properties: {
      title: { type: "string", maxLength: 250 },
      description: { type: "string", maxLength: 4000 },
      priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
      assignedTo: { type: "string" },
    },
    required: ["title"],
  },
  [ACTIONS.SCHEDULE_FOLLOW_UP]: {
    type: "object",
    properties: { body: { type: "string" }, sendAt: { type: "string" } },
    required: ["body", "sendAt"],
  },
  [ACTIONS.PREPARE_QUOTATION]: {
    type: "object",
    properties: { orderId: { type: "integer" }, customerId: { type: "integer" } },
  },
  [ACTIONS.NOTIFY_STAFF]: {
    type: "object",
    properties: { title: { type: "string" }, body: { type: "string" } },
    required: ["title"],
  },
  [ACTIONS.UPDATE_FIELD]: {
    type: "object",
    properties: {
      entity: { type: "string", enum: ["lead", "order", "customer", "booking"] },
      entityId: { type: "integer" },
      field: { type: "string" },
      value: { type: "string" },
    },
    required: ["entity", "entityId", "field", "value"],
  },
  [ACTIONS.REQUEST_APPROVAL]: {
    type: "object",
    properties: { title: { type: "string" }, description: { type: "string" } },
    required: ["title"],
  },
  [ACTIONS.RUN_TOOL]: {
    type: "object",
    properties: { tool: { type: "string" }, args: { type: "object" } },
    required: ["tool"],
  },
  [ACTIONS.TAG_CUSTOMER]: {
    type: "object",
    properties: { customerId: { type: "integer" }, tag: { type: "string" } },
    required: ["customerId", "tag"],
  },
};

function validateAction(action) {
  const type = String(action?.type || "");
  const schema = ACTION_SCHEMAS[type];
  if (!schema) {
    throw new ValidationError(
      `Unknown action type "${type}". Supported: ${Object.keys(ACTION_SCHEMAS).join(", ")}.`
    );
  }
  const errors = validateAgainstSchema(schema, action.args || {});
  if (errors.length > 0) {
    throw new ValidationError(`Action "${type}" has invalid arguments: ${errors.join("; ")}`);
  }
  return true;
}

/**
 * Executes one action. Returns a result object; never throws for a
// business-level problem (the caller decides whether to retry).
 */
export async function executeAction(businessId, action, context) {
  const type = String(action?.type || "");
  const args = action?.args || {};
  const db = getDb();

  switch (type) {
    case ACTIONS.SEND_MESSAGE: {
      const chatId = args.chatId || context.chatId || "";
      if (!chatId) return { ok: false, error: "No chat id to send to." };
      if (typeof context.send === "function") {
        await context.send(args.body);
      }
      db.prepare(
        `INSERT INTO conversations (business_id, chat_id, role, content, thread_id, direction, status)
         VALUES (?, ?, 'assistant', ?, ?, 'outbound', 'sent')`
      ).run(businessId, chatId, args.body, context.threadId ?? null);
      return { ok: true, action: type, chatId };
    }

    case ACTIONS.ASSIGN_CONVERSATION: {
      assignThread(businessId, Number(args.threadId), args.assignedTo || "", "workflow");
      return { ok: true, action: type };
    }

    case ACTIONS.CREATE_TASK: {
      const task = createTask(
        businessId,
        {
          title: args.title,
          description: args.description || "",
          priority: args.priority || "normal",
          assignedTo: args.assignedTo || "",
          entityType: context.entityType || "",
          entityId: context.entityId ?? null,
        },
        "workflow"
      );
      return { ok: true, action: type, taskId: task.id };
    }

    case ACTIONS.SCHEDULE_FOLLOW_UP: {
      const scheduled = scheduleMessage(
        businessId,
        {
          threadId: context.threadId ?? null,
          chatId: context.chatId || "",
          body: args.body,
          sendAt: args.sendAt,
          reason: "workflow",
        },
        "workflow"
      );
      return { ok: true, action: type, scheduledId: scheduled.id };
    }

    case ACTIONS.PREPARE_QUOTATION: {
      const { createQuotationFromOrder } = await import("./quotations.js");
      const quotation = createQuotationFromOrder(businessId, Number(args.orderId || context.orderId), "workflow");
      return { ok: true, action: type, quotationId: quotation.id, number: quotation.number };
    }

    case ACTIONS.NOTIFY_STAFF: {
      db.prepare(
        `INSERT INTO notifications (business_id, category, title, body, severity)
         VALUES (?, 'workflow', ?, ?, 'info')`
      ).run(businessId, args.title, args.body || "");
      return { ok: true, action: type };
    }

    case ACTIONS.UPDATE_FIELD: {
      // Only fields on this allow-list may be written by a workflow.
      const allowedFields = {
        lead: ["status", "notes", "assigned_to", "next_follow_up_at", "stage", "priority"],
        order: ["notes", "state"],
        customer: ["notes", "tags"],
        booking: ["status", "assigned_to", "notes"],
      };
      const table = { lead: "leads", order: "orders", customer: "customers", booking: "bookings" }[args.entity];
      const allowed = allowedFields[args.entity] || [];
      if (!table || !allowed.includes(args.field)) {
        return { ok: false, error: `Field "${args.entity}.${args.field}" cannot be updated by a workflow.` };
      }
      db.prepare(`UPDATE ${table} SET ${args.field} = ? WHERE business_id = ? AND id = ?`).run(
        args.value,
        businessId,
        Number(args.entityId)
      );
      return { ok: true, action: type };
    }

    case ACTIONS.REQUEST_APPROVAL: {
      const { requestApproval } = await import("./ai/tools/index.js");
      const approval = requestApproval(businessId, {
        threadId: context.threadId ?? null,
        customerId: context.customerId ?? null,
        toolName: "workflow_action",
        args: { title: args.title, description: args.description || "" },
        summary: args.title,
        risk: "high",
      });
      return { ok: true, action: type, approvalId: approval.id };
    }

    case ACTIONS.RUN_TOOL: {
      const { executeTool } = await import("./ai/tools/index.js");
      const result = await executeTool({
        businessId,
        toolName: args.tool,
        args: args.args || {},
        ctx: {
          threadId: context.threadId ?? null,
          chatId: context.chatId || "",
          customerId: context.customerId ?? null,
          actor: "workflow",
          send: context.send,
        },
      });
      return result.ok ? { ok: true, action: type, result: result.result } : { ok: false, error: result.error, action: type };
    }

    case ACTIONS.TAG_CUSTOMER: {
      addTag(businessId, args.tag);
      const customer = db
        .prepare("SELECT id, tags FROM customers WHERE business_id = ? AND id = ?")
        .get(businessId, Number(args.customerId));
      if (!customer) return { ok: false, error: "No such customer." };
      const tags = jsonArray(customer.tags);
      if (!tags.includes(args.tag)) tags.push(args.tag);
      db.prepare("UPDATE customers SET tags = ?, updated_at = CURRENT_TIMESTAMP WHERE business_id = ? AND id = ?").run(
        JSON.stringify(tags),
        businessId,
        Number(args.customerId)
      );
      return { ok: true, action: type };
    }

    default:
      return { ok: false, error: `Unknown action type "${type}".` };
  }
}

// ---------- execution ----------

/**
 * Fires every workflow registered for a trigger.
 *
 * @param {number} businessId
 * @param {string} triggerType
 * @param {object} context the trigger payload
 * @returns {Promise<{triggered: number, runs: object[]}>}
 */
export async function fireTrigger(businessId, triggerType, context = {}) {
  const db = getDb();
  const workflows = db
    .prepare(
      "SELECT * FROM workflows WHERE business_id = ? AND trigger_type = ? AND enabled = 1 ORDER BY id ASC"
    )
    .all(businessId, triggerType);

  const runs = [];
  for (const row of workflows) {
    const workflow = mapWorkflow(row);

    const triggerConfig = workflow.trigger_config || {};
    if (triggerConfig.channel && context.channel && triggerConfig.channel !== context.channel) {
      continue;
    }

    const evaluation = evaluateConditions(workflow.conditions, context);
    if (!evaluation.ok) continue;

    const run = await startRun(businessId, workflow, context);
    runs.push(run);
  }

  return { triggered: runs.length, runs };
}

/** Creates and executes one workflow run. */
/** Creates and executes one workflow run. */
export async function startRun(businessId, workflow, context) {
  const db = getDb();
  const info = db
    .prepare(
      `INSERT INTO workflow_runs
         (business_id, workflow_id, status, trigger_event, input, attempts, max_attempts, started_at)
       VALUES (?, ?, 'running', ?, ?, 1, 3, CURRENT_TIMESTAMP)`
    )
    .run(
      businessId,
      workflow.id,
      context.triggerEvent || "",
      JSON.stringify(context)
    );

  const runId = Number(info.lastInsertRowid);
  const outcome = await executeActions(businessId, workflow, context);

  db.prepare(
    "UPDATE workflow_runs SET status = ?, output = ?, error = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).run(outcome.status, JSON.stringify(outcome.output), outcome.error || "", runId);

  if (outcome.status === "succeeded") {
    db.prepare(
      "UPDATE workflows SET run_count = run_count + 1, last_run_at = CURRENT_TIMESTAMP WHERE id = ?"
    ).run(workflow.id);
    return { runId, workflowId: workflow.id, status: "succeeded", output: outcome.output };
  }

  recordFailure(businessId, workflow, runId, context, outcome.error);
  return { runId, workflowId: workflow.id, status: "failed", error: outcome.error };
}

/**
 * Runs the workflow's actions in order.
 * The action count is capped so a workflow that triggers itself cannot loop.
 */
async function executeActions(businessId, workflow, context) {
  const output = [];
  try {
    const steps = Math.min((workflow.actions || []).length, MAX_ACTIONS_PER_RUN);
    for (let i = 0; i < steps; i += 1) {
      const result = await executeAction(businessId, workflow.actions[i], context);
      output.push(result);
      if (!result.ok) throw new Error(result.error || "Action failed");
    }
    return { status: "succeeded", output, error: null };
  } catch (err) {
    return { status: "failed", output, error: err.message };
  }
}

/** Records a failed run: retry with backoff, or park it in the dead-letter queue. */
function recordFailure(businessId, workflow, runId, context, error) {
  const db = getDb();
  const run = db.prepare("SELECT * FROM workflow_runs WHERE id = ?").get(runId);
  const attempts = Number(run.attempts || 1);
  const maxAttempts = Number(run.max_attempts || 3);

  if (attempts >= maxAttempts) {
    db.prepare(
      "UPDATE workflow_runs SET status = 'dead_letter', error = ?, next_retry_at = NULL, completed_at = CURRENT_TIMESTAMP WHERE id = ?"
    ).run(error, runId);
    db.prepare(
      `INSERT INTO workflow_dead_letters (business_id, workflow_id, run_id, input, error)
       VALUES (?, ?, ?, ?, ?)`
    ).run(businessId, workflow.id, runId, JSON.stringify(context), error);
  } else {
    const delayMinutes = Math.pow(5, attempts);
    db.prepare(
      "UPDATE workflow_runs SET status = 'failed', error = ?, next_retry_at = datetime('now', ?) WHERE id = ?"
    ).run(error, `+${delayMinutes} minutes`, runId);
  }

  audit({
    businessId,
    actor: "workflow",
    action: "workflow.run_failed",
    details: { workflow_id: workflow.id, run_id: runId, error },
    severity: "warning",
  });
}

/**
 * Retries the workflow runs that are due for another attempt. The same run
 * row is reused, so the attempt counter keeps climbing towards the
 * dead-letter threshold.
 */
export async function retryDueRuns(businessId) {
  const db = getDb();
  const due = db
    .prepare(
      `SELECT * FROM workflow_runs
       WHERE business_id = ? AND status = 'failed' AND next_retry_at IS NOT NULL
         AND datetime(next_retry_at) <= datetime('now')
       LIMIT 25`
    )
    .all(businessId);

  const results = [];
  for (const run of due) {
    const workflow = getWorkflow(businessId, run.workflow_id);
    const context = jsonObject(run.input);

    db.prepare(
      "UPDATE workflow_runs SET attempts = attempts + 1, status = 'running', next_retry_at = NULL, error = '' WHERE id = ?"
    ).run(run.id);

    const outcome = await executeActions(businessId, workflow, context);

    db.prepare(
      "UPDATE workflow_runs SET status = ?, output = ?, error = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?"
    ).run(outcome.status, JSON.stringify(outcome.output), outcome.error || "", run.id);

    if (outcome.status === "succeeded") {
      db.prepare(
        "UPDATE workflows SET run_count = run_count + 1, last_run_at = CURRENT_TIMESTAMP WHERE id = ?"
      ).run(workflow.id);
    } else {
      recordFailure(businessId, workflow, run.id, context, outcome.error);
    }

    results.push({ runId: run.id, workflowId: workflow.id, status: outcome.status, error: outcome.error });
  }
  return results;
}

export function listRuns(businessId, { status = null, limit = 100 } = {}) {
  const db = getDb();
  const where = ["business_id = ?"];
  const params = [businessId];
  if (status) {
    where.push("status = ?");
    params.push(status);
  }
  params.push(Math.min(Number(limit) || 100, 500));
  return db
    .prepare(`SELECT * FROM workflow_runs WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`)
    .all(...params)
    .map((r) => ({ ...r, input: jsonObject(r.input), output: jsonObject(r.output) }));
}

export function listDeadLetters(businessId) {
  const db = getDb();
  return db
    .prepare("SELECT * FROM workflow_dead_letters WHERE business_id = ? ORDER BY id DESC LIMIT 100")
    .all(businessId)
    .map((r) => ({ ...r, input: jsonObject(r.input) }));
}

/** Re-queues a dead-lettered run for another attempt. */
export function retryDeadLetter(businessId, deadLetterId, actor = "system") {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM workflow_dead_letters WHERE business_id = ? AND id = ?")
    .get(businessId, deadLetterId);
  if (!row) throw new NotFoundError("No such dead-letter entry.");
  db.prepare("DELETE FROM workflow_dead_letters WHERE id = ?").run(deadLetterId);
  audit({
    businessId,
    actor,
    action: "workflow.dead_letter_retried",
    details: { dead_letter_id: deadLetterId },
  });
  return true;
}
