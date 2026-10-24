// src/services/notifications.js
// In-app notifications for staff.

import { getDb } from "../db/connection.js";
import { audit } from "../core/audit.js";

export function createNotification(businessId, { title, body = "", category = "general", severity = "info", userId = null, entityType = "", entityId = "" }, actor = "system") {
  const db = getDb();
  const info = db
    .prepare(
      `INSERT INTO notifications (business_id, user_id, category, title, body, severity, entity_type, entity_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(businessId, userId, category, title, body, severity, entityType, String(entityId ?? ""));

  const id = Number(info.lastInsertRowid);
  audit({ businessId, actor, action: "notification.created", details: { notification_id: id, title } });
  return db.prepare("SELECT * FROM notifications WHERE id = ?").get(id);
}

export function listNotifications(businessId, username = null, { limit = 50 } = {}) {
  const db = getDb();
  const params = [businessId];
  let where = "business_id = ?";
  if (username) {
    where += " AND (user_id IS NULL OR user_id IN (SELECT id FROM users WHERE business_id = ? AND username = ?))";
    params.push(businessId, username);
  }
  params.push(Math.min(Number(limit) || 50, 200));
  return db
    .prepare(`SELECT * FROM notifications WHERE ${where} ORDER BY id DESC LIMIT ?`)
    .all(...params);
}

export function markNotificationRead(businessId, notificationId) {
  const db = getDb();
  db.prepare(
    "UPDATE notifications SET read_at = CURRENT_TIMESTAMP WHERE business_id = ? AND id = ? AND read_at IS NULL"
  ).run(businessId, notificationId);
  return true;
}

export function countUnread(businessId, username = null) {
  const db = getDb();
  const params = [businessId];
  let where = "business_id = ? AND read_at IS NULL";
  if (username) {
    where += " AND (user_id IS NULL OR user_id IN (SELECT id FROM users WHERE business_id = ? AND username = ?))";
    params.push(businessId, username);
  }
  const row = db.prepare(`SELECT COUNT(*) AS c FROM notifications WHERE ${where}`).get(...params);
  return row.c;
}
