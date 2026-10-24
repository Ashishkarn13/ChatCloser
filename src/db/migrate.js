// src/db/migrate.js
// Versioned, forward-only schema migrations.
//
// Every migration is a .sql file in ./migrations named NN_description.sql.
// Applying them is idempotent at the *runner* level: the version is recorded
// in schema_migrations and never applied twice.
//
// The SQL itself is written so that a brand-new database and a database
// created by ChatCloser 1.x converge on the same shape — legacy tables are
// created with CREATE TABLE IF NOT EXISTS, and any column that legacy code
// added at runtime is re-checked by the ensureColumn() list below (SQLite
// has no "ADD COLUMN IF NOT EXISTS").

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(here, "migrations");

/**
 * Columns that must exist on pre-existing tables. Each entry is checked
 * against PRAGMA table_info before an ALTER is attempted, so this is safe
 * to run on every startup regardless of the database's history.
 */
const ENSURE_COLUMNS = [
  ["businesses", "slug", "TEXT DEFAULT ''"],
  ["businesses", "industry_template", "TEXT DEFAULT 'retail'"],
  ["businesses", "currency", "TEXT DEFAULT 'NPR'"],
  ["businesses", "tax_enabled", "INTEGER DEFAULT 0"],
  ["businesses", "tax_rate", "REAL DEFAULT 0"],
  ["businesses", "tax_inclusive", "INTEGER DEFAULT 0"],
  ["businesses", "delivery_fee", "REAL DEFAULT 0"],
  ["businesses", "delivery_free_above", "REAL DEFAULT 0"],
  ["businesses", "ai_disclosure", "TEXT DEFAULT ''"],
  ["businesses", "ai_operator_role", "TEXT DEFAULT 'owner'"],
  ["businesses", "ai_local_only", "INTEGER DEFAULT 0"],
  ["businesses", "ai_temperature", "REAL DEFAULT 0.4"],
  ["businesses", "ai_max_tokens", "INTEGER DEFAULT 500"],
  ["businesses", "ai_fallback_provider", "TEXT DEFAULT ''"],
  ["businesses", "ai_fallback_model", "TEXT DEFAULT ''"],
  ["businesses", "ai_local_base_url", "TEXT DEFAULT 'http://127.0.0.1:11434'"],
  ["businesses", "modules_enabled", "TEXT DEFAULT '[]'"],
  ["businesses", "settings", "TEXT DEFAULT '{}'"],
  ["businesses", "payment_gateway_secret_encrypted", "TEXT DEFAULT ''"],
  ["businesses", "payment_gateway_key_id", "TEXT DEFAULT ''"],
  ["businesses", "requires_order_confirmation", "INTEGER DEFAULT 1"],
  ["businesses", "business_hours", "TEXT DEFAULT '{}'"],
  ["businesses", "is_active", "INTEGER DEFAULT 1"],

  ["users", "business_id", "INTEGER DEFAULT 1"],
  ["users", "display_name", "TEXT DEFAULT ''"],
  ["users", "email", "TEXT DEFAULT ''"],
  ["users", "status", "TEXT DEFAULT 'active'"],
  ["users", "permissions", "TEXT DEFAULT '{}'"],
  ["users", "last_login_at", "TEXT DEFAULT NULL"],

  ["conversations", "thread_id", "INTEGER DEFAULT NULL"],
  ["conversations", "direction", "TEXT DEFAULT 'outbound'"],
  ["conversations", "status", "TEXT DEFAULT 'sent'"],
  ["conversations", "external_id", "TEXT DEFAULT ''"],
  ["conversations", "meta", "TEXT DEFAULT '{}'"],

  ["leads", "customer_id", "INTEGER DEFAULT NULL"],
  ["leads", "source", "TEXT DEFAULT 'whatsapp'"],
  ["leads", "stage", "TEXT DEFAULT ''"],
  ["leads", "score", "INTEGER DEFAULT 0"],
  ["leads", "score_reasons", "TEXT DEFAULT '[]'"],
  ["leads", "assigned_to", "TEXT DEFAULT ''"],
  ["leads", "next_follow_up_at", "TEXT DEFAULT NULL"],

  ["orders", "order_number", "TEXT DEFAULT ''"],
  ["orders", "customer_id", "INTEGER DEFAULT NULL"],
  ["orders", "state", "TEXT DEFAULT 'draft'"],
  ["orders", "channel", "TEXT DEFAULT 'whatsapp'"],
  ["orders", "subtotal", "REAL DEFAULT 0"],
  ["orders", "discount_amount", "REAL DEFAULT 0"],
  ["orders", "tax_amount", "REAL DEFAULT 0"],
  ["orders", "delivery_amount", "REAL DEFAULT 0"],
  ["orders", "total_amount", "REAL DEFAULT 0"],
  ["orders", "payment_method", "TEXT DEFAULT ''"],
  ["orders", "notes", "TEXT DEFAULT ''"],
  ["orders", "address_json", "TEXT DEFAULT '{}'"],
  ["orders", "idempotency_key", "TEXT DEFAULT ''"],
  ["orders", "confirmed_at", "TEXT DEFAULT NULL"],
  ["orders", "cancelled_at", "TEXT DEFAULT NULL"],
  ["orders", "refunded_amount", "REAL DEFAULT 0"],
  ["orders", "stock_reserved", "INTEGER DEFAULT 0"],

  ["price_list", "product_id", "INTEGER DEFAULT NULL"],
  ["price_list", "tax_rate", "REAL DEFAULT 0"],

  ["audit_log", "ip_address", "TEXT DEFAULT ''"],
  ["audit_log", "user_agent", "TEXT DEFAULT ''"],
  ["audit_log", "severity", "TEXT DEFAULT 'info'"],
  ["audit_log", "entity_type", "TEXT DEFAULT ''"],
  ["audit_log", "entity_id", "TEXT DEFAULT ''"],

  ["webhooks", "is_active", "INTEGER DEFAULT 1"],
];

function ensureColumns(db) {
  for (const [table, column, definition] of ENSURE_COLUMNS) {
    const exists = db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .some((c) => c.name === column);
    if (!exists) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }
}

export function runMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const applied = new Set(
    db.prepare("SELECT version FROM schema_migrations").all().map((r) => r.version)
  );

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const version = file.replace(/\.sql$/, "");
    if (applied.has(version)) continue;

    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(version);
      db.exec("COMMIT");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* already rolled back */
      }
      throw new Error(`Migration ${version} failed: ${err.message}`);
    }
  }

  // Idempotent column checks run after the versioned migrations so that a
  // database created by ChatCloser 1.x ends up with the same columns as a
  // freshly created one.
  ensureColumns(db);
}

export function currentSchemaVersion(db) {
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get();
  return row?.v || null;
}
