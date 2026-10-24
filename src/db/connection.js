// src/db/connection.js
// The single SQLite connection shared by every module in the application.
//
// The legacy code opened its own connection inside db.js. Keeping one
// connection here means the desktop app, the dashboard and the bot all
// share a single transaction boundary, which is what makes atomic
// order + inventory writes possible.
//
// Uses Node's BUILT-IN SQLite (node:sqlite, Node 22.5+). No native module
// is compiled, so there is no Visual Studio / build-tools requirement on
// Windows.

import { DatabaseSync } from "node:sqlite";
import { config, ensureDataDirs } from "../config.js";
import { runMigrations } from "./migrate.js";

let db = null;

export function getDb() {
  if (db) return db;

  ensureDataDirs();
  db = new DatabaseSync(config.dbPath);

  // WAL keeps the dashboard readable while the bot writes. foreign_keys is
  // OFF by default in SQLite and must be enabled per connection, otherwise
  // tenant-isolation constraints are silently unenforced.
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA synchronous = NORMAL;");

  runMigrations(db);

  return db;
}

/**
 * Runs `fn` inside a SQLite transaction. Nested calls join the outer
 * transaction (SQLite has no real nested transactions) so services can
 * compose without double-BEGIN errors.
 */
let txDepth = 0;
export function transaction(fn) {
  const database = getDb();
  if (txDepth > 0) return fn(database);

  database.exec("BEGIN IMMEDIATE");
  txDepth += 1;
  try {
    const result = fn(database);
    database.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      database.exec("ROLLBACK");
    } catch {
      /* the transaction was already aborted */
    }
    throw err;
  } finally {
    txDepth -= 1;
  }
}

/** Closes the connection (used by tests and by the desktop app on quit). */
export function closeDb() {
  if (!db) return;
  try {
    db.close();
  } catch {
    /* already closed */
  }
  db = null;
}

/** Convenience helpers that always go through the shared connection. */
export function all(sql, params = []) {
  return getDb().prepare(sql).all(...params);
}

export function get(sql, params = []) {
  return getDb().prepare(sql).get(...params);
}

export function run(sql, params = []) {
  return getDb().prepare(sql).run(...params);
}

export default getDb;
