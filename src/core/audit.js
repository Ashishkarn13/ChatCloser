// src/core/audit.js
// Audit trail with automatic secret redaction.
//
// Every privileged action writes one row. Anything that looks like a
// credential is replaced before it is stored, so a leaked audit log cannot
// leak an API key.

import { getDb } from "../db/connection.js";

const SECRET_KEY_PATTERN =
  /(api[_-]?key|secret|password|passwd|pwd|token|authorization|signature|private[_-]?key|client[_-]?secret)/i;

const REDACTED = "[redacted]";

/**
 * Recursively replaces secret-looking values in a payload.
 * Strings that look like API keys (sk-…, whsec_…, long base64/hex blobs)
 * are masked even when the key name is innocent.
 */
export function redact(value, depth = 0) {
  if (depth > 6) return "[truncated]";
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    if (/^(sk|pk|rk)_(live|test)_[A-Za-z0-9]{8,}/.test(value)) return REDACTED;
    if (/^whsec_[A-Za-z0-9]{8,}/.test(value)) return REDACTED;
    if (/^(ghp|gho|github_pat)_[A-Za-z0-9_]{16,}$/.test(value)) return REDACTED;
    if (value.length >= 40 && /^[A-Za-z0-9+/=_-]{40,}$/.test(value)) return REDACTED;
    return value;
  }

  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));

  if (typeof value === "object") {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      if (SECRET_KEY_PATTERN.test(key)) {
        out[key] = REDACTED;
      } else {
        out[key] = redact(val, depth + 1);
      }
    }
    return out;
  }

  return value;
}

/**
 * Writes an audit row.
 * @param {object} params
 * @param {number} params.businessId
 * @param {string} params.actor username, or "system" for automated actions
 * @param {string} params.action short label, e.g. "orders.created"
 * @param {*} [params.details] any JSON-serialisable payload (redacted)
 * @param {string} [params.severity] info | warning | critical
 */
export function audit({
  businessId,
  actor = "system",
  action,
  details = "",
  severity = "info",
  entityType = "",
  entityId = "",
  ipAddress = "",
  userAgent = "",
}) {
  const db = getDb();
  let payload = details;
  if (typeof details !== "string") {
    payload = JSON.stringify(redact(details));
  }
  db.prepare(`
    INSERT INTO audit_log
      (business_id, actor, action, details, severity, entity_type, entity_id, ip_address, user_agent)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    businessId ?? 0,
    actor || "system",
    action,
    payload ?? "",
    severity,
    entityType,
    String(entityId ?? ""),
    ipAddress,
    userAgent
  );
}

/** Reads the audit trail for a business. */
export function listAudit(businessId, { limit = 200, offset = 0, action = null } = {}) {
  const db = getDb();
  const where = ["business_id = ?"];
  const params = [businessId];
  if (action) {
    where.push("action LIKE ?");
    params.push(`${action}%`);
  }
  const sql = `SELECT * FROM audit_log WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ? OFFSET ?`;
  params.push(Math.min(Number(limit) || 200, 1000), Number(offset) || 0);
  return db.prepare(sql).all(...params);
}

export { SECRET_KEY_PATTERN };
