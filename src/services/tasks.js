// src/services/tasks.js
// The human task queue: things a member of staff has to do.

import { getDb } from "../db/connection.js";
import { audit } from "../core/audit.js";
import { NotFoundError, ValidationError } from "../core/errors.js";
import { str } from "../core/validation.js";

export const TASK_STATUSES = ["open", "in_progress", "waiting", "completed", "cancelled"];

export function listTasks(businessId, { status = null, assignedTo = null, limit = 200 } = {}) {
  const db = getDb();
  const where = ["business_id = ?"];
  const params = [businessId];
  if (status) {
    where.push("status = ?");
    params.push(status);
  }
  if (assignedTo) {
    where.push("assigned_to = ?");
    params.push(assignedTo);
  }
  params.push(Math.min(Number(limit) || 200, 500));
  return db
    .prepare(`SELECT * FROM tasks WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`)
    .all(...params);
}

export function getTask(businessId, taskId) {
  const db = getDb();
  const row = db.prepare("SELECT * FROM tasks WHERE business_id = ? AND id = ?").get(businessId, taskId);
  if (!row) throw new NotFoundError("No such task.");
  return row;
}

export function createTask(businessId, input, actor = "system") {
  const db = getDb();
  const title = str(input.title, { field: "title", required: true, max: 250 });
  const status = input.status && TASK_STATUSES.includes(input.status) ? input.status : "open";

  const info = db
    .prepare(
      `INSERT INTO tasks
         (business_id, title, description, status, priority, assigned_to, due_at, entity_type, entity_id, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      businessId,
      title,
      str(input.description, { field: "description", max: 4000 }),
      status,
      input.priority || "normal",
      str(input.assignedTo, { field: "assignedTo", max: 100 }),
      input.dueAt || null,
      str(input.entityType, { field: "entityType", max: 40 }),
      input.entityId !== undefined && input.entityId !== null ? String(input.entityId) : "",
      actor
    );

  const id = Number(info.lastInsertRowid);
  audit({ businessId, actor, action: "task.created", details: { task_id: id, title } });
  return getTask(businessId, id);
}

export function updateTask(businessId, taskId, fields, actor = "system") {
  const db = getDb();
  const current = getTask(businessId, taskId);
  const status = fields.status !== undefined ? fields.status : current.status;
  if (!TASK_STATUSES.includes(status)) {
    throw new ValidationError(`Status must be one of: ${TASK_STATUSES.join(", ")}.`);
  }

  db.prepare(
    `UPDATE tasks SET status = ?, assigned_to = ?, priority = ?, description = ?,
       completed_at = CASE WHEN ? = 'completed' THEN CURRENT_TIMESTAMP ELSE completed_at END
     WHERE business_id = ? AND id = ?`
  ).run(
    status,
    fields.assignedTo !== undefined ? str(fields.assignedTo, { field: "assignedTo", max: 100 }) : current.assigned_to,
    fields.priority !== undefined ? fields.priority : current.priority,
    fields.description !== undefined ? str(fields.description, { field: "description", max: 4000 }) : current.description,
    status,
    businessId,
    taskId
  );

  audit({ businessId, actor, action: "task.updated", details: { task_id: taskId, status } });
  return getTask(businessId, taskId);
}

export function countOpenTasks(businessId) {
  const db = getDb();
  const row = db
    .prepare("SELECT COUNT(*) AS c FROM tasks WHERE business_id = ? AND status IN ('open','in_progress','waiting')")
    .get(businessId);
  return row.c;
}
