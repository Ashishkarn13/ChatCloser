// src/services/ai/tools/index.js
// The controlled tool registry.
//
// This is the boundary between the model and the business. A model may only
// *ask* for a tool to run. Before anything happens:
//
//   1. the tool must be enabled for this business (ai_tool_permissions)
//   2. the caller must hold the permissions the tool requires — checked
//      against the role the business has assigned to the AI
//   3. the arguments must validate against the tool's JSON Schema
//   4. tools that need approval are queued for a human instead of running
//   5. the call is written to the audit log
//
// The model never receives database access, credentials, shell access or
// the ability to run anything that is not in this registry.

import { getDb } from "../../../db/connection.js";
import { audit } from "../../../core/audit.js";
import { ValidationError, ForbiddenError, NotFoundError } from "../../../core/errors.js";
import { validateAgainstSchema } from "../../../core/validation.js";
import { can, ROLE_PERMISSIONS } from "../../../core/rbac.js";
import { TOOL_DEFINITIONS, TOOLS_BY_NAME } from "./definitions.js";
import { getBusinessConfig } from "../../businesses.js";

export { TOOL_DEFINITIONS, TOOLS_BY_NAME };

/**
 * The role the AI acts with for this business. A tool whose required
 * permissions are not in that role's bundle is not available to the model.
 */
export function operatorRole(business) {
  return String(business.ai_operator_role || "owner").toLowerCase();
}

function roleHasPermission(role, permission) {
  const bundle = ROLE_PERMISSIONS[role] || ROLE_PERMISSIONS.staff;
  if (role === "owner") return true;
  return bundle.includes(permission);
}

/** Reads the per-business overrides for a tool. */
export function getToolPermission(businessId, toolName) {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM ai_tool_permissions WHERE business_id = ? AND tool_name = ?")
    .get(businessId, toolName);
  if (!row) {
    // Defaults: the tool is available, but a tool that declares
    // approvalRequired still waits for a human.
    return {
      tool_name: toolName,
      enabled: 1,
      requires_approval: 0,
      allowed_roles: "[]",
      daily_limit: 0,
    };
  }
  return row;
}

/**
 * The tools the AI may use in this business, with the descriptions that
 * are sent to the model.
 */
export function listToolsForBusiness(businessId, { role = null } = {}) {
  const business = getBusinessConfig(businessId);
  const effectiveRole = role || operatorRole(business);

  return TOOL_DEFINITIONS.filter((tool) => {
    const permission = getToolPermission(businessId, tool.name);
    if (!permission.enabled) return false;
    if (permission.allowed_roles && permission.allowed_roles !== "[]") {
      let allowed = [];
      try {
        allowed = JSON.parse(permission.allowed_roles);
      } catch {
        allowed = [];
      }
      if (Array.isArray(allowed) && allowed.length > 0 && !allowed.includes(effectiveRole)) return false;
    }
    return (tool.requiredPermissions || []).every((p) => roleHasPermission(effectiveRole, p));
  });
}

/** The tool definitions in the shape the model adapters expect. */
export function toolSchemasFor(businessId, options = {}) {
  return listToolsForBusiness(businessId, options).map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));
}

/** Turns on or off a tool for a business, or requires human approval. */
export function setToolPermission(businessId, toolName, { enabled, requiresApproval, allowedRoles, dailyLimit }, actor = "system") {
  const db = getDb();
  if (!TOOLS_BY_NAME[toolName]) throw new NotFoundError(`No tool called "${toolName}".`);

  const current = getToolPermission(businessId, toolName);

  db.prepare(
    `INSERT INTO ai_tool_permissions
       (business_id, tool_name, enabled, requires_approval, allowed_roles, daily_limit, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(business_id, tool_name) DO UPDATE SET
       enabled = excluded.enabled,
       requires_approval = excluded.requires_approval,
       allowed_roles = excluded.allowed_roles,
       daily_limit = excluded.daily_limit,
       updated_at = CURRENT_TIMESTAMP`
  ).run(
    businessId,
    toolName,
    enabled === undefined ? Number(current.enabled) : enabled ? 1 : 0,
    requiresApproval === undefined ? Number(current.requires_approval) : requiresApproval ? 1 : 0,
    allowedRoles === undefined ? current.allowed_roles : JSON.stringify(allowedRoles || []),
    dailyLimit === undefined ? Number(current.daily_limit || 0) : Number(dailyLimit) || 0
  );

  audit({
    businessId,
    actor,
    action: "ai.tool_permission_updated",
    details: { tool: toolName, enabled, requiresApproval },
  });

  return getToolPermission(businessId, toolName);
}

/**
 * Executes a tool.
 *
 * @param {object} params
 * @param {number} params.businessId
 * @param {string} params.toolName
 * @param {object} params.args
 * @param {object} params.ctx execution context (thread, chat, customer, sender…)
 * @returns {Promise<{ok:boolean, result?:object, error?:string, status?:string}>}
 */
export async function executeTool({ businessId, toolName, args, ctx = {} }) {
  const tool = TOOLS_BY_NAME[toolName];
  if (!tool) {
    return { ok: false, error: `Unknown tool "${toolName}".`, code: "unknown_tool" };
  }

  const business = getBusinessConfig(businessId);
  const permission = getToolPermission(businessId, toolName);

  if (!permission.enabled) {
    audit({
      businessId,
      actor: ctx.actor || "ai",
      action: "ai.tool_denied",
      details: { tool: toolName, reason: "disabled_for_business" },
      severity: "warning",
    });
    return { ok: false, error: `The tool "${toolName}" is not enabled for this business.`, code: "tool_disabled" };
  }

  // The role the assistant acts as is a business setting. It is never taken
  // from the caller, so nothing the model (or a caller) passes in can raise
  // the assistant's privileges.
  const effectiveRole = operatorRole(business);
  const missing = (tool.requiredPermissions || []).filter((p) => !roleHasPermission(effectiveRole, p));
  if (missing.length > 0) {
    audit({
      businessId,
      actor: ctx.actor || "ai",
      action: "ai.tool_denied",
      details: { tool: toolName, reason: "missing_permission", missing },
      severity: "warning",
    });
    return {
      ok: false,
      error: `The tool "${toolName}" needs a permission this workspace has not granted to the AI.`,
      code: "missing_permission",
    };
  }

  // Validate the model's arguments against the declared schema.
  const input = args && typeof args === "object" ? args : {};
  const schemaErrors = validateAgainstSchema(tool.inputSchema, input);
  if (schemaErrors.length > 0) {
    audit({
      businessId,
      actor: ctx.actor || "ai",
      action: "ai.tool_rejected",
      details: { tool: toolName, errors: schemaErrors },
      severity: "warning",
    });
    return {
      ok: false,
      error: `Invalid arguments for "${toolName}": ${schemaErrors.join("; ")}`,
      code: "invalid_arguments",
      details: schemaErrors,
    };
  }

  // Approval gate.
  const needsApproval = Boolean(tool.approvalRequired) || Boolean(permission.requires_approval);
  if (needsApproval) {
    const approval = requestApproval(businessId, {
      threadId: ctx.threadId,
      customerId: ctx.customerId,
      toolName,
      args: input,
      summary: ctx.approvalSummary || `Run ${toolName}`,
    });
    return {
      ok: true,
      status: "awaiting_approval",
      approvalId: approval.id,
      result: {
        approved: false,
        message: "This action needs a staff member's approval before it can run.",
      },
    };
  }

  // Daily limit.
  if (Number(permission.daily_limit) > 0) {
    const used = countToolCallsToday(businessId, toolName);
    if (used >= Number(permission.daily_limit)) {
      return {
        ok: false,
        error: `The daily limit for "${toolName}" has been reached.`,
        code: "limit_reached",
      };
    }
  }

  const startedAt = Date.now();
  try {
    const result = await tool.handler({ businessId, business, ...ctx }, input);

    const outputErrors = tool.outputSchema
      ? validateAgainstSchema(tool.outputSchema, result).filter((e) => !e.includes("is required"))
      : [];

    audit({
      businessId,
      actor: ctx.actor || "ai",
      action: "ai.tool_executed",
      details: {
        tool: toolName,
        sideEffects: tool.sideEffects,
        durationMs: Date.now() - startedAt,
        args: input,
        outputWarnings: outputErrors,
      },
    });

    return { ok: true, result, durationMs: Date.now() - startedAt };
  } catch (err) {
    audit({
      businessId,
      actor: ctx.actor || "ai",
      action: "ai.tool_failed",
      details: { tool: toolName, error: err.message },
      severity: "warning",
    });
    return { ok: false, error: err.message, code: err.code || "tool_error" };
  }
}

function countToolCallsToday(businessId, toolName) {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM audit_log
       WHERE business_id = ? AND action = 'ai.tool_executed'
         AND details LIKE ? AND created_at >= datetime('now', '-1 day')`
    )
    .get(businessId, `%"tool":"${toolName}"%`);
  return row.c;
}

/** Queues an action for a human to approve. */
export function requestApproval(businessId, { threadId, customerId, toolName, args, summary, risk = "normal" }) {
  const db = getDb();
  const info = db
    .prepare(
      `INSERT INTO approvals (business_id, thread_id, customer_id, tool_name, arguments, summary, risk, requested_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'ai')`
    )
    .run(
      businessId,
      threadId ?? null,
      customerId ?? null,
      toolName,
      JSON.stringify(args || {}),
      summary || "",
      risk,
    );

  const id = Number(info.lastInsertRowid);

  db.prepare(
    `INSERT INTO tasks (business_id, title, description, priority, entity_type, entity_id, created_by)
     VALUES (?, ?, ?, 'high', 'approval', ?, 'ai')`
  ).run(businessId, `Approval needed: ${toolName}`, summary || "", String(id));

  audit({
    businessId,
    actor: "ai",
    action: "ai.approval_requested",
    details: { approval_id: id, tool: toolName },
    severity: "warning",
  });

  return { id, toolName, args };
}

/** Approves or rejects a queued action. */
export function decideApproval(businessId, approvalId, { decision, actor, note = "" }) {
  const db = getDb();
  const approval = db
    .prepare("SELECT * FROM approvals WHERE business_id = ? AND id = ?")
    .get(businessId, approvalId);
  if (!approval) throw new NotFoundError("No such approval request.");
  if (approval.status !== "pending") {
    throw new ValidationError(`That request was already ${approval.status}.`);
  }

  const status = decision === "approve" ? "approved" : "rejected";
  db.prepare(
    `UPDATE approvals SET status = ?, decided_by = ?, decision_note = ?, decided_at = CURRENT_TIMESTAMP
     WHERE business_id = ? AND id = ?`
  ).run(status, actor, note, businessId, approvalId);

  db.prepare(
    "UPDATE tasks SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE business_id = ? AND entity_type = 'approval' AND entity_id = ?"
  ).run(businessId, String(approvalId));

  audit({
    businessId,
    actor,
    action: `ai.approval_${status}`,
    details: { approval_id: approvalId, tool: approval.tool_name, note },
    severity: "warning",
  });

  return { ...approval, status, decided_by: actor, decision_note: note };
}

export function listApprovals(businessId, { status = "pending", limit = 100 } = {}) {
  const db = getDb();
  const where = ["business_id = ?"];
  const params = [businessId];
  if (status) {
    where.push("status = ?");
    params.push(status);
  }
  params.push(Math.min(Number(limit) || 100, 500));
  return db
    .prepare(`SELECT * FROM approvals WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`)
    .all(...params)
    .map((a) => ({ ...a, arguments: JSON.parse(a.arguments || "{}") }));
}
