// scripts/migrate.js
// Applies pending database migrations and reports what changed.
//
//   npm run migrate
//
// This is safe to run as often as you like: the runner records every
// applied version and skips the ones already present.

import "dotenv/config";
import { config } from "../src/config.js";
import { getDb } from "../src/db/connection.js";

const db = getDb();

const applied = db
  .prepare("SELECT version, applied_at FROM schema_migrations ORDER BY version")
  .all();

console.log(`Database: ${config.dbPath}`);
console.log(`Applied migrations: ${applied.length}`);
for (const row of applied) {
  console.log(`  ${row.version}  ${row.applied_at}`);
}

const tables = db
  .prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  )
  .all()
  .map((r) => r.name);

console.log(`Tables: ${tables.length}`);
console.log(`  ${tables.join(", ")}`);

db.close();
