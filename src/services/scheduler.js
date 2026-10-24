// src/services/scheduler.js
// Scheduled outbound messages.
//
// A scheduled message is data, not code. When it fires, the platform sends
// it through the channel adapter — the AI is not involved, so a delayed
// message can never "change its mind" at send time.

import { getDb } from "../db/connection.js";
import { audit } from "../core/audit.js";
import { NotFoundError, ValidationError } from "../core/errors.js";
import { str } from "../core/validation.js";

export function scheduleMessage(businessId, input, actor = "system") {
  const db = getDb();
  const body = str(input.body, { field: "body", required: true, max: 4000 });
  const sendAt = str(input.sendAt, { field: "sendAt", required: true, max: 40 });

  if (Number.isNaN(new Date(sendAt).getTime())) {
    throw new ValidationError("sendAt must be a valid date and time.");
  }

  const info = db
    .prepare(
      `INSERT INTO scheduled_messages (business_id, thread_id, chat_id, channel, body, send_at, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      businessId,
      input.threadId ?? null,
      str(input.chatId, { field: "chatId", max: 120 }),
      str(input.channel, { field: "channel", max: 30 }) || "whatsapp",
      body,
      sendAt,
      str(input.reason, { field: "reason", max: 200 })
    );

  const id = Number(info.lastInsertRowid);
  audit({ businessId, actor, action: "message.scheduled", details: { scheduled_id: id, send_at: sendAt } });
  return db.prepare("SELECT * FROM scheduled_messages WHERE id = ?").get(id);
}

export function listScheduled(businessId, { status = "scheduled", limit = 100 } = {}) {
  const db = getDb();
  const where = ["business_id = ?"];
  const params = [businessId];
  if (status) {
    where.push("status = ?");
    params.push(status);
  }
  params.push(Math.min(Number(limit) || 100, 500));
  return db
    .prepare(`SELECT * FROM scheduled_messages WHERE ${where.join(" AND ")} ORDER BY send_at ASC LIMIT ?`)
    .all(...params);
}

export function dueMessages(businessId, now = new Date()) {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM scheduled_messages
       WHERE business_id = ? AND status = 'scheduled' AND datetime(send_at) <= datetime(?)
       ORDER BY send_at ASC LIMIT 50`
    )
    .all(businessId, now.toISOString());
}

export function markSent(businessId, id, error = "") {
  const db = getDb();
  db.prepare(
    `UPDATE scheduled_messages SET status = ?, attempts = attempts + 1, sent_at = CURRENT_TIMESTAMP, error = ?
     WHERE business_id = ? AND id = ?`
  ).run(error ? "failed" : "sent", error, businessId, id);
}

export function cancelScheduled(businessId, id, actor = "system") {
  const db = getDb();
  const row = db.prepare("SELECT * FROM scheduled_messages WHERE business_id = ? AND id = ?").get(businessId, id);
  if (!row) throw new NotFoundError("No such scheduled message.");
  db.prepare("UPDATE scheduled_messages SET status = 'cancelled' WHERE business_id = ? AND id = ?").run(businessId, id);
  audit({ businessId, actor, action: "message.cancelled", details: { scheduled_id: id } });
  return true;
}
