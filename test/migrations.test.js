// test/migrations.test.js
// Schema migrations.
//
// A ChatCloser 1.x database must upgrade in place without losing data,
// and a fresh database must end up with the same shape.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { getDb, closeDb } from "../src/db/connection.js";
import { currentSchemaVersion } from "../src/db/migrate.js";

test("the migrations have been applied and recorded", () => {
  const db = getDb();
  const version = currentSchemaVersion(db);
  assert.ok(version, "a schema version must be recorded");

  const rows = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
  assert.ok(rows.length >= 6);
  for (const row of rows) assert.match(row.version, /^\d{3}_/);
});

test("every table the 2.0 modules need exists", () => {
  const db = getDb();
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((r) => r.name);

  const required = [
    "businesses", "users", "sessions", "roles", "industry_templates", "business_modules",
    "custom_fields", "notifications", "tasks", "customers", "customer_tags",
    "products", "product_variants", "stock_levels", "inventory_movements", "suppliers",
    "purchases", "orders", "order_items", "order_transitions", "order_drafts",
    "idempotency_keys", "bookings", "quotations", "invoices", "payments",
    "payment_events", "expenses", "threads", "thread_notes", "thread_events",
    "message_templates", "opt_ins", "knowledge_documents", "knowledge_chunks",
    "knowledge_fts", "ai_tool_permissions", "ai_runs", "ai_memory", "approvals",
    "workflows", "workflow_runs", "workflow_dead_letters", "workflow_versions",
    "scheduled_messages", "audit_log",
  ];

  for (const table of required) {
    assert.ok(tables.includes(table), `missing table: ${table}`);
  }
});

test("the orders table has the columns the 2.0 order lifecycle needs", () => {
  const db = getDb();
  const columns = db.prepare("PRAGMA table_info(orders)").all().map((c) => c.name);
  for (const column of [
    "order_number", "customer_id", "state", "subtotal", "discount_amount", "tax_amount",
    "delivery_amount", "total_amount", "payment_method", "idempotency_key",
    "confirmed_at", "cancelled_at", "stock_reserved",
  ]) {
    assert.ok(columns.includes(column), `missing column: ${column}`);
  }
});

test("the users table is scoped to a business", () => {
  const db = getDb();
  const columns = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
  assert.ok(columns.includes("business_id"));
  assert.ok(columns.includes("role"));
  assert.ok(columns.includes("permissions"));
});

test("foreign keys are enforced", () => {
  const db = getDb();
  const row = db.prepare("PRAGMA foreign_keys").get();
  assert.ok(Number(Object.values(row)[0]) === 1, "foreign_keys must be ON");
});

test("a ChatCloser 1.x database is upgraded in place without losing data", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chatcloser-legacy-"));
  const legacyPath = path.join(dir, "legacy.sqlite");

  // Recreate the ChatCloser 1.x schema exactly.
  const legacy = new DatabaseSync(legacyPath);
  legacy.exec(`
    CREATE TABLE businesses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      locale TEXT DEFAULT 'en',
      country TEXT DEFAULT 'NP',
      timezone TEXT DEFAULT 'Asia/Kathmandu',
      stripe_secret_key_encrypted TEXT DEFAULT '',
      stripe_webhook_secret_encrypted TEXT DEFAULT '',
      npr_payment_method TEXT DEFAULT '',
      system_prompt_extra TEXT DEFAULT '',
      knowledge_base TEXT DEFAULT '{}',
      escalation_keywords TEXT DEFAULT '[]',
      escalation_message TEXT DEFAULT '',
      away_message TEXT DEFAULT '',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_id INTEGER NOT NULL,
      chat_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT DEFAULT 'owner',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_id INTEGER NOT NULL,
      lead_id INTEGER,
      chat_id TEXT NOT NULL,
      item_name TEXT NOT NULL,
      amount REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      stripe_checkout_session_id TEXT,
      payment_url TEXT,
      payment_status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE price_list (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_id INTEGER NOT NULL,
      item_name TEXT NOT NULL,
      price_amount REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      description TEXT DEFAULT '',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  legacy
    .prepare(
      "INSERT INTO businesses (id, name, locale, knowledge_base, escalation_keywords) VALUES (1, 'Legacy Shop', 'ne', ?, ?)"
    )
    .run(JSON.stringify({ hours: "9-6" }), JSON.stringify(["complaint"]));
  legacy
    .prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)")
    .run("legacy", "hash", "owner");
  legacy
    .prepare(
      "INSERT INTO orders (business_id, chat_id, item_name, amount, currency, payment_status) VALUES (1, 'chat1', 'Old Item', 500, 'NPR', 'paid')"
    )
    .run();
  legacy.close();

  // Point the application at the legacy database and let the migrations run.
  const previousPath = process.env.CHATCLOSER_DB_PATH;
  const previousDir = process.env.CHATCLOSER_DATA_DIR;
  closeDb();
  process.env.CHATCLOSER_DB_PATH = legacyPath;
  process.env.CHATCLOSER_DATA_DIR = dir;

  try {
    const db = getDb();
    const business = db.prepare("SELECT * FROM businesses WHERE id = 1").get();
    assert.equal(business.name, "Legacy Shop");
    assert.equal(business.locale, "ne");

    const user = db.prepare("SELECT * FROM users WHERE username = 'legacy'").get();
    assert.ok(user, "the legacy user must survive the upgrade");
    assert.equal(Number(user.business_id), 1);

    const order = db.prepare("SELECT * FROM orders WHERE chat_id = 'chat1'").get();
    assert.ok(order, "the legacy order must survive the upgrade");
    assert.equal(order.payment_status, "paid");

    // The 2.0 columns must now exist on the legacy tables.
    const orderColumns = db.prepare("PRAGMA table_info(orders)").all().map((c) => c.name);
    assert.ok(orderColumns.includes("state"));
    assert.ok(orderColumns.includes("total_amount"));

    // And the 2.0 tables must exist too.
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => r.name);
    assert.ok(tables.includes("knowledge_documents"));
    assert.ok(tables.includes("workflows"));
  } finally {
    closeDb();
    process.env.CHATCLOSER_DB_PATH = previousPath;
    process.env.CHATCLOSER_DATA_DIR = previousDir;
    getDb();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
