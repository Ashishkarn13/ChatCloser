// src/services/conversations.js
// Shared inbox: threads, messages, assignment, human takeover and AI
// pause/resume.
//
// The legacy `conversations` table still holds every message, so the 1.x
// conversation pages keep working; a `threads` table groups those messages
// into a customer conversation and carries the operational state (who owns
// it, whether the AI is replying, what it is about).

import { getDb } from "../db/connection.js";
import { audit } from "../core/audit.js";
import { NotFoundError, ValidationError } from "../core/errors.js";
import { str, jsonArray } from "../core/validation.js";

export const THREAD_STATUSES = ["open", "pending", "closed"];
export const AI_MODES = ["auto", "assist", "off"];

/** Finds or creates the thread that owns a conversation on a channel. */
export function getOrCreateThread(businessId, channel, externalId, extra = {}) {
  const db = getDb();
  const existing = db
    .prepare("SELECT * FROM threads WHERE business_id = ? AND channel = ? AND external_id = ?")
    .get(businessId, channel, externalId);
  if (existing) return existing;

  const info = db
    .prepare(
      `INSERT INTO threads (business_id, channel, external_id, customer_id, customer_name, contact_number, subject, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open')`
    )
    .run(
      businessId,
      channel,
      externalId,
      extra.customerId ?? null,
      extra.customerName || "",
      extra.contactNumber || "",
      extra.subject || ""
    );

  return db.prepare("SELECT * FROM threads WHERE id = ?").get(Number(info.lastInsertRowid));
}

export function getThread(businessId, threadId) {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM threads WHERE business_id = ? AND id = ?")
    .get(businessId, threadId);
  if (!row) throw new NotFoundError("No such conversation.");
  return { ...row, labels: jsonArray(row.labels) };
}

export function findThreadByExternalId(businessId, channel, externalId) {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM threads WHERE business_id = ? AND channel = ? AND external_id = ?")
    .get(businessId, channel, externalId);
  return row ? { ...row, labels: jsonArray(row.labels) } : null;
}

/**
 * Stores a message. `direction` is "inbound" for the customer and
 * "outbound" for the business.
 */
export function recordMessage(businessId, thread, role, content, meta = {}) {
  const db = getDb();
  const chatId = typeof thread === "object" ? thread.external_id : thread;
  const threadId = typeof thread === "object" ? thread.id : null;

  const info = db
    .prepare(
      `INSERT INTO conversations (business_id, chat_id, role, content, thread_id, direction, status, meta)
       VALUES (?, ?, ?, ?, ?, ?, 'sent', ?)`
    )
    .run(
      businessId,
      chatId,
      role,
      content,
      threadId,
      role === "user" ? "inbound" : "outbound",
      JSON.stringify(meta || {})
    );

  if (threadId) {
    db.prepare(
      `UPDATE threads SET
         last_message_at = CURRENT_TIMESTAMP,
         last_message_preview = ?,
         unread_count = CASE WHEN ? = 'inbound' THEN unread_count + 1 ELSE unread_count END,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(String(content || "").slice(0, 160), role === "user" ? "inbound" : "outbound", threadId);
  }

  return { id: Number(info.lastInsertRowid), threadId, chatId };
}

export function getThreadMessages(businessId, threadId, limit = 200) {
  const db = getDb();
  const thread = getThread(businessId, threadId);
  return db
    .prepare(
      `SELECT id, role, content, created_at, direction, status
       FROM conversations WHERE business_id = ? AND thread_id = ? ORDER BY id ASC LIMIT ?`
    )
    .all(businessId, threadId, Math.min(Number(limit) || 200, 1000));
}

export function listThreads(
  businessId,
  { status = null, aiMode = null, assignedTo = null, priority = null, search = "", limit = 100, offset = 0 } = {}
) {
  const db = getDb();
  const where = ["business_id = ?"];
  const params = [businessId];

  if (status) {
    where.push("status = ?");
    params.push(status);
  }
  if (aiMode) {
    where.push("ai_mode = ?");
    params.push(aiMode);
  }
  if (assignedTo) {
    where.push("assigned_to = ?");
    params.push(assignedTo);
  }
  if (priority) {
    where.push("priority = ?");
    params.push(priority);
  }
  if (search) {
    where.push("(LOWER(customer_name) LIKE ? OR LOWER(last_message_preview) LIKE ? OR contact_number LIKE ?)");
    const like = `%${String(search).toLowerCase()}%`;
    params.push(like, like, `%${search}%`);
  }

  params.push(Math.min(Number(limit) || 100, 500), Number(offset) || 0);

  return db
    .prepare(`SELECT * FROM threads WHERE ${where.join(" AND ")} ORDER BY last_message_at DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...params)
    .map((t) => ({ ...t, labels: jsonArray(t.labels) }));
}

/** Assigns a conversation to a staff member. */
export function assignThread(businessId, threadId, username, actor = "system") {
  const db = getDb();
  getThread(businessId, threadId);
  db.prepare(
    "UPDATE threads SET assigned_to = ?, updated_at = CURRENT_TIMESTAMP WHERE business_id = ? AND id = ?"
  ).run(username || "", businessId, threadId);
  addThreadEvent(businessId, threadId, "assigned", actor, { assigned_to: username });
  audit({ businessId, actor, action: "conversation.assigned", details: { thread_id: threadId, assigned_to: username } });
  return getThread(businessId, threadId);
}

/**
 * Hands a conversation to a human: the AI stops replying, the thread is
 * marked as taken over and a handover note is recorded so whoever picks it
 * up knows what happened.
 */
export function takeoverThread(businessId, threadId, { actor = "system", reason = "", summary = "" } = {}) {
  const db = getDb();
  const thread = getThread(businessId, threadId);

  const existingSummary = thread.handover_summary || "";
  const combined = [existingSummary, summary].filter(Boolean).join("\n\n");

  db.prepare(
    `UPDATE threads SET ai_mode = 'off', status = 'open', escalated_at = CURRENT_TIMESTAMP,
       handover_summary = ?, updated_at = CURRENT_TIMESTAMP
     WHERE business_id = ? AND id = ?`
  ).run(combined, businessId, threadId);

  addThreadEvent(businessId, threadId, "taken_over", actor, { reason, summary });
  audit({
    businessId,
    actor,
    action: "conversation.taken_over",
    details: { thread_id: threadId, reason },
    severity: "warning",
  });

  return getThread(businessId, threadId);
}

/** Hands the conversation back to the AI. */
export function resumeAi(businessId, threadId, { actor = "system", note = "" } = {}) {
  const db = getDb();
  getThread(businessId, threadId);
  db.prepare(
    "UPDATE threads SET ai_mode = 'auto', updated_at = CURRENT_TIMESTAMP WHERE business_id = ? AND id = ?"
  ).run(businessId, threadId);
  addThreadEvent(businessId, threadId, "ai_resumed", actor, { note });
  audit({ businessId, actor, action: "conversation.ai_resumed", details: { thread_id: threadId } });
  return getThread(businessId, threadId);
}

/** Sets the AI mode: auto (reply), assist (draft only) or off. */
export function setAiMode(businessId, threadId, mode, { actor = "system" } = {}) {
  if (!AI_MODES.includes(mode)) throw new ValidationError(`AI mode must be one of: ${AI_MODES.join(", ")}.`);
  const db = getDb();
  getThread(businessId, threadId);
  db.prepare(
    "UPDATE threads SET ai_mode = ?, updated_at = CURRENT_TIMESTAMP WHERE business_id = ? AND id = ?"
  ).run(mode, businessId, threadId);
  addThreadEvent(businessId, threadId, "ai_mode_changed", actor, { mode });
  return getThread(businessId, threadId);
}

export function setThreadStatus(businessId, threadId, status, { actor = "system" } = {}) {
  if (!THREAD_STATUSES.includes(status)) {
    throw new ValidationError(`Status must be one of: ${THREAD_STATUSES.join(", ")}.`);
  }
  const db = getDb();
  getThread(businessId, threadId);
  db.prepare(
    `UPDATE threads SET status = ?, closed_at = CASE WHEN ? = 'closed' THEN CURRENT_TIMESTAMP ELSE NULL END,
       updated_at = CURRENT_TIMESTAMP WHERE business_id = ? AND id = ?`
  ).run(status, status, businessId, threadId);
  addThreadEvent(businessId, threadId, "status_changed", actor, { status });
  return getThread(businessId, threadId);
}

export function setPriority(businessId, threadId, priority, { actor = "system" } = {}) {
  if (!["low", "normal", "high", "urgent"].includes(priority)) {
    throw new ValidationError("Priority must be low, normal, high or urgent.");
  }
  const db = getDb();
  getThread(businessId, threadId);
  db.prepare(
    "UPDATE threads SET priority = ?, updated_at = CURRENT_TIMESTAMP WHERE business_id = ? AND id = ?"
  ).run(priority, businessId, threadId);
  addThreadEvent(businessId, threadId, "priority_changed", actor, { priority });
  return getThread(businessId, threadId);
}

export function setLabels(businessId, threadId, labels, { actor = "system" } = {}) {
  const db = getDb();
  getThread(businessId, threadId);
  const clean = jsonArray(labels).map((l) => String(l).trim()).filter(Boolean).slice(0, 20);
  db.prepare(
    "UPDATE threads SET labels = ?, updated_at = CURRENT_TIMESTAMP WHERE business_id = ? AND id = ?"
  ).run(JSON.stringify(clean), businessId, threadId);
  addThreadEvent(businessId, threadId, "labels_changed", actor, { labels: clean });
  return getThread(businessId, threadId);
}

/** Internal staff note on a conversation. */
export function addNote(businessId, threadId, author, body) {
  const db = getDb();
  getThread(businessId, threadId);
  const text = str(body, { field: "body", required: true, max: 4000 });
  const info = db
    .prepare("INSERT INTO thread_notes (business_id, thread_id, author, body) VALUES (?, ?, ?, ?)")
    .run(businessId, threadId, author, text);
  addThreadEvent(businessId, threadId, "note_added", author, {});
  return { id: Number(info.lastInsertRowid), author, body: text };
}

export function listNotes(businessId, threadId) {
  const db = getDb();
  return db
    .prepare("SELECT * FROM thread_notes WHERE business_id = ? AND thread_id = ? ORDER BY id DESC")
    .all(businessId, threadId);
}

export function addThreadEvent(businessId, threadId, type, actor, detail = {}) {
  const db = getDb();
  db.prepare(
    "INSERT INTO thread_events (business_id, thread_id, type, actor, detail) VALUES (?, ?, ?, ?, ?)"
  ).run(businessId, threadId, type, actor || "system", JSON.stringify(detail || {}));
}

/** Builds a handover summary from the last messages of a conversation. */
export function buildHandoverSummary(businessId, threadId, { limit = 12 } = {}) {
  const db = getDb();
  const messages = db
    .prepare(
      `SELECT role, content, created_at FROM conversations
       WHERE business_id = ? AND thread_id = ? ORDER BY id DESC LIMIT ?`
    )
    .all(businessId, threadId, limit)
    .reverse();

  if (messages.length === 0) return "";

  return messages
    .map((m) => `${m.role === "user" ? "Customer" : "Assistant"}: ${String(m.content).slice(0, 300)}`)
    .join("\n");
}

/**
 * Marks a thread as read for the current user.
 */
export function markThreadRead(businessId, threadId) {
  const db = getDb();
  db.prepare("UPDATE threads SET unread_count = 0 WHERE business_id = ? AND id = ?").run(businessId, threadId);
  return getThread(businessId, threadId);
}

/** Counts what is waiting for a human. */
export function inboxCounts(businessId) {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT
         SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open,
         SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN ai_mode = 'off' AND status <> 'closed' THEN 1 ELSE 0 END) AS taken_over,
         SUM(CASE WHEN unread_count > 0 THEN 1 ELSE 0 END) AS unread,
         COUNT(*) AS total
       FROM threads WHERE business_id = ?`
    )
    .get(businessId);

  return {
    open: Number(row.open || 0),
    pending: Number(row.pending || 0),
    takenOver: Number(row.taken_over || 0),
    unread: Number(row.unread || 0),
    total: Number(row.total || 0),
  };
}
