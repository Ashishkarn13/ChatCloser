// src/services/auth.js
// Staff accounts, password handling and login throttling.
//
// Every account belongs to exactly one business. ChatCloser 1.x had a
// global users table with no business scope, which meant a staff account
// created for one business could sign in to another business's panel.
// The business id is now part of the (business_id, username) unique key
// and is always resolved from the session, never from a request parameter.

import { getDb } from "../db/connection.js";
import { hashPassword, verifyPassword } from "../../crypto-utils.js";
import { ValidationError, NotFoundError, ConflictError, ForbiddenError } from "../core/errors.js";
import { str, oneOf } from "../core/validation.js";
import { BUILT_IN_ROLES } from "../core/rbac.js";
import { audit } from "../core/audit.js";

const MAX_FAILED_ATTEMPTS = 8;
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;

export function listUsers(businessId) {
  const db = getDb();
  return db
    .prepare(
      `SELECT id, business_id, username, display_name, email, role, status, last_login_at, created_at
       FROM users WHERE business_id = ? ORDER BY id ASC`
    )
    .all(businessId);
}

export function getUser(businessId, username) {
  const db = getDb();
  return db
    .prepare("SELECT * FROM users WHERE business_id = ? AND username = ?")
    .get(businessId, username);
}

export function getUserById(id) {
  const db = getDb();
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id);
}

export function createUser(
  businessId,
  { username, password, role = "staff", displayName = "", email = "", permissions = {}, actor = "system" }
) {
  const db = getDb();
  const cleanUsername = str(username, { field: "username", required: true, min: 3, max: 64 });
  const cleanRole = oneOf(String(role).toLowerCase(), BUILT_IN_ROLES, {
    field: "role",
    required: true,
  });

  if (!password || String(password).length < 8) {
    throw new ValidationError("Password must be at least 8 characters.");
  }

  const existing = getUser(businessId, cleanUsername);
  if (existing) throw new ConflictError("That username is already taken in this workspace.");

  db.prepare(
    `INSERT INTO users (business_id, username, display_name, email, password_hash, role, permissions)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    businessId,
    cleanUsername,
    displayName || "",
    email || "",
    hashPassword(String(password)),
    cleanRole,
    JSON.stringify(permissions || {})
  );

  audit({ businessId, actor, action: "team.member_added", details: { username: cleanUsername, role: cleanRole } });
  return getUser(businessId, cleanUsername);
}

export function updateUser(businessId, username, fields, actor = "system") {
  const db = getDb();
  const user = getUser(businessId, username);
  if (!user) throw new NotFoundError("No such user in this workspace.");

  const role = fields.role !== undefined
    ? oneOf(String(fields.role).toLowerCase(), BUILT_IN_ROLES, { field: "role", required: true })
    : user.role;

  db.prepare(
    `UPDATE users SET role = ?, display_name = ?, email = ?, permissions = ?, status = ?
     WHERE business_id = ? AND username = ?`
  ).run(
    role,
    fields.displayName ?? user.display_name,
    fields.email ?? user.email,
    fields.permissions !== undefined ? JSON.stringify(fields.permissions) : user.permissions,
    fields.status ?? user.status,
    businessId,
    username
  );

  audit({ businessId, actor, action: "team.member_updated", details: { username, role } });
  return getUser(businessId, username);
}

export function setUserPassword(businessId, username, newPassword, actor = "system") {
  const db = getDb();
  const user = getUser(businessId, username);
  if (!user) throw new NotFoundError("No such user in this workspace.");
  if (!newPassword || String(newPassword).length < 8) {
    throw new ValidationError("Password must be at least 8 characters.");
  }
  db.prepare("UPDATE users SET password_hash = ? WHERE business_id = ? AND username = ?").run(
    hashPassword(String(newPassword)),
    businessId,
    username
  );
  audit({ businessId, actor, action: "team.password_changed", details: { username } });
  return getUser(businessId, username);
}

export function deleteUser(businessId, username, actor = "system") {
  const db = getDb();
  const user = getUser(businessId, username);
  if (!user) throw new NotFoundError("No such user in this workspace.");
  if (user.role === "owner") {
    const owners = db
      .prepare("SELECT COUNT(*) AS c FROM users WHERE business_id = ? AND role = 'owner'")
      .get(businessId).c;
    if (owners <= 1) throw new ForbiddenError("Can't remove the last owner account.");
  }
  db.prepare("DELETE FROM users WHERE business_id = ? AND username = ?").run(businessId, username);
  audit({ businessId, actor, action: "team.member_removed", details: { username } });
  return true;
}

export function countOwners(businessId) {
  const db = getDb();
  return db
    .prepare("SELECT COUNT(*) AS c FROM users WHERE business_id = ? AND role = 'owner'")
    .get(businessId).c;
}

// ---------- login throttling ----------

export function recordLoginAttempt(username, ipAddress, success) {
  const db = getDb();
  db.prepare(
    "INSERT INTO login_attempts (username, ip_address, success, created_at) VALUES (?, ?, ?, ?)"
  ).run(username, ipAddress || "", success ? 1 : 0, Date.now());
  db.prepare("DELETE FROM login_attempts WHERE created_at < ?").run(Date.now() - LOCKOUT_WINDOW_MS * 4);
}

/**
 * Returns true when the account is currently locked out after too many
 * failed attempts.
 */
export function isLockedOut(username, ipAddress) {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM login_attempts
       WHERE success = 0 AND created_at > ?
         AND (username = ? OR ip_address = ?)`
    )
    .get(Date.now() - LOCKOUT_WINDOW_MS, username, ipAddress || "");

  return row.c >= MAX_FAILED_ATTEMPTS;
}

/**
 * Verifies a username/password pair.
 * @returns {{ok: true, user: object} | {ok: false, reason: string}}
 */
export function authenticate(businessId, username, password, ipAddress = "") {
  if (!username || !password) {
    return { ok: false, reason: "invalid" };
  }
  if (isLockedOut(username, ipAddress)) {
    return { ok: false, reason: "locked" };
  }

  const user = getUser(businessId, username);
  if (!user || user.status !== "active" || !verifyPassword(String(password), user.password_hash)) {
    recordLoginAttempt(username, ipAddress, false);
    return { ok: false, reason: "invalid" };
  }

  recordLoginAttempt(username, ipAddress, true);
  const db = getDb();
  db.prepare("UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?").run(user.id);
  audit({ businessId, actor: user.username, action: "auth.login_success", ipAddress });
  return { ok: true, user };
}

/** Creates the first owner account for a business if it has no users. */
export function bootstrapOwner(businessId, { username, password, displayName = "" }) {
  const db = getDb();
  const existing = db.prepare("SELECT COUNT(*) AS c FROM users WHERE business_id = ?").get(businessId).c;
  if (existing > 0) return null;
  return createUser(businessId, {
    username,
    password,
    role: "owner",
    displayName: displayName || username,
    actor: "system",
  });
}
