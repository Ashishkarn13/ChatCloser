// src/services/bootstrap.js
// First-run provisioning.
//
// A fresh installation has an empty database. Rather than refusing to
// start (or asking the user to run a seed script before they can log in),
// the platform provisions exactly one business and one owner account the
// first time it runs, then leaves everything untouched.
//
// This makes the desktop application usable the moment it is installed,
// and it makes a server deployment work with a single `npm start`.

import crypto from "node:crypto";
import { getDb } from "../db/connection.js";
import { audit } from "../core/audit.js";
import * as businesses from "./businesses.js";
import * as auth from "./auth.js";
import { applyTemplate } from "./industry.js";

function businessExists(businessId) {
  const db = getDb();
  return Boolean(db.prepare("SELECT id FROM businesses WHERE id = ?").get(businessId));
}

/**
 * Creates the default business when the database is empty.
 * Returns true when it created the row.
 */
export function ensureBusiness(businessId, { name, industryTemplate = "retail" } = {}) {
  if (businessExists(businessId)) return false;

  const db = getDb();
  db.prepare(
    `INSERT INTO businesses (id, name, industry_template, locale, country, timezone, currency, created_at)
     VALUES (?, ?, ?, 'en', 'NP', 'Asia/Kathmandu', 'NPR', CURRENT_TIMESTAMP)`
  ).run(businessId, name || "My Business", industryTemplate);

  audit({ businessId, actor: "system", action: "business.created", details: { name: name || "My Business" } });

  if (industryTemplate && industryTemplate !== "none") {
    try {
      applyTemplate(businessId, industryTemplate, "system");
    } catch {
      // An unknown template is not a reason to refuse to start: the
      // business simply keeps the default configuration.
    }
  }

  return true;
}

/**
 * Ensures the business has at least one owner account. When no password is
 * supplied a strong one is generated and returned once, so that the caller
 * can show it to the operator (and nobody else ever sees it).
 */
export function ensureOwner(businessId, { username, password, displayName } = {}) {
  const db = getDb();
  const existing = db.prepare("SELECT COUNT(*) AS c FROM users WHERE business_id = ?").get(businessId).c;
  if (existing > 0) return null;

  const generated = !password;
  const finalUsername = (username || "admin").trim() || "admin";
  const finalPassword = password || crypto.randomBytes(9).toString("base64url");
  const finalName = displayName || "Owner";

  const user = auth.createUser(businessId, {
    username: finalUsername,
    password: finalPassword,
    role: "owner",
    displayName: finalName,
    actor: "system",
  });

  return {
    user,
    username: finalUsername,
    password: finalPassword,
    generated,
  };
}

/**
 * Runs both provisioning steps and reports what it did. Callers use the
 * result to print first-run credentials and nothing else.
 */
export function ensureReady(businessId, options = {}) {
  const createdBusiness = ensureBusiness(businessId, options);

  if (!businessExists(businessId)) {
    throw new Error(`Could not provision business ${businessId}.`);
  }

  const owner = ensureOwner(businessId, {
    username: options.ownerUsername,
    password: options.ownerPassword,
    displayName: options.ownerDisplayName,
  });

  return { createdBusiness, owner, business: businesses.getBusinessConfig(businessId) };
}
