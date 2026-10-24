// test/helpers.js
// Test bootstrap.
//
// Each test file runs in its own process (Node's test runner does this by
// default), so every file gets a private data directory and a private
// SQLite database. Nothing here touches a real workspace.
//
// IMPORTANT: import this file FIRST in a test file — it sets the
// environment before src/config.js is evaluated.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatcloser-test-"));

process.env.CHATCLOSER_DATA_DIR = tmpDir;
process.env.CHATCLOSER_DB_PATH = path.join(tmpDir, "test.sqlite");
process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
process.env.SESSION_SECRET = crypto.randomBytes(32).toString("hex");
process.env.NODE_ENV = "test";
process.env.CHATCLOSER_STRICT_SECRETS = "0";
process.env.CHATCLOSER_NO_LISTEN = "1";

export const dataDir = tmpDir;
export const dbPath = process.env.CHATCLOSER_DB_PATH;

export function cleanup() {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

process.on("exit", cleanup);

/** Creates a business row for tests and returns its id. */
export async function makeBusiness(name = "Test Business", overrides = {}) {
  const { getDb } = await import("../src/db/connection.js");
  const db = getDb();
  const info = db
    .prepare(
      `INSERT INTO businesses (name, locale, country, timezone, currency, tax_enabled, tax_rate,
         tax_inclusive, delivery_fee, delivery_free_above, requires_order_confirmation, escalation_keywords)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      name,
      overrides.locale ?? "en",
      overrides.country ?? "NP",
      overrides.timezone ?? "Asia/Kathmandu",
      overrides.currency ?? "NPR",
      overrides.tax_enabled ?? 0,
      overrides.tax_rate ?? 0,
      overrides.tax_inclusive ?? 0,
      overrides.delivery_fee ?? 0,
      overrides.delivery_free_above ?? 0,
      overrides.requires_order_confirmation ?? 1,
      JSON.stringify(overrides.escalation_keywords ?? ["complaint", "manager"])
    );
  return Number(info.lastInsertRowid);
}

/** Creates a product in a business catalogue. */
export async function makeProduct(businessId, overrides = {}) {
  const { getDb } = await import("../src/db/connection.js");
  const db = getDb();
  const info = db
    .prepare(
      `INSERT INTO products (business_id, name, sku, type, price, cost_price, tax_rate, track_inventory, unit)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      businessId,
      overrides.name ?? "Test Item",
      overrides.sku ?? "",
      overrides.type ?? "product",
      overrides.price ?? 100,
      overrides.cost_price ?? 50,
      overrides.tax_rate ?? 0,
      overrides.track_inventory ?? 0,
      overrides.unit ?? "pcs"
    );
  return Number(info.lastInsertRowid);
}

/** Puts stock on the shelf for a product. */
export async function setStock(businessId, productId, quantity, variantId = 0) {
  const { applyMovement } = await import("../src/services/inventory.js");
  return applyMovement({
    businessId,
    productId,
    variantId,
    type: "in",
    quantity,
    actor: "test",
  });
}
