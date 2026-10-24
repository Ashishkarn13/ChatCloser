// src/server/session-store.js
// A SQLite-backed express-session store.
//
// The 1.x app used express-session's default MemoryStore: every restart
// logged everybody out, and the store leaked memory in a long-running
// server deployment. This store persists sessions in the same database as
// the rest of the application and expires them properly.

import session from "express-session";
import { getDb } from "../db/connection.js";

export class SqliteSessionStore extends session.Store {
  constructor({ ttlMs = 12 * 60 * 60 * 1000 } = {}) {
    super();
    this.ttlMs = ttlMs;
    this.pruneTimer = setInterval(() => this.prune(), 10 * 60 * 1000);
    if (this.pruneTimer.unref) this.pruneTimer.unref();
  }

  prune() {
    try {
      getDb()
        .prepare("DELETE FROM sessions WHERE expires_at < ?")
        .run(Date.now());
    } catch {
      /* the database may be closing */
    }
  }

  get(sid, callback) {
    try {
      const row = getDb()
        .prepare("SELECT data, expires_at FROM sessions WHERE sid = ?")
        .get(sid);
      if (!row) return callback(null, null);
      if (row.expires_at && row.expires_at < Date.now()) {
        this.destroy(sid, () => {});
        return callback(null, null);
      }
      return callback(null, JSON.parse(row.data));
    } catch (err) {
      return callback(err);
    }
  }

  set(sid, sessionData, callback = () => {}) {
    try {
      const expiresAt = sessionData.cookie?.expires
        ? new Date(sessionData.cookie.expires).getTime()
        : Date.now() + this.ttlMs;

      getDb()
        .prepare(
          `INSERT INTO sessions (sid, business_id, username, role, data, expires_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(sid) DO UPDATE SET
             business_id = excluded.business_id,
             username = excluded.username,
             role = excluded.role,
             data = excluded.data,
             expires_at = excluded.expires_at`
        )
        .run(
          sid,
          sessionData.user?.businessId ?? null,
          sessionData.username ?? null,
          sessionData.role ?? null,
          JSON.stringify(sessionData),
          expiresAt
        );
      return callback(null);
    } catch (err) {
      return callback(err);
    }
  }

  destroy(sid, callback = () => {}) {
    try {
      getDb().prepare("DELETE FROM sessions WHERE sid = ?").run(sid);
      return callback(null);
    } catch (err) {
      return callback(err);
    }
  }

  touch(sid, sessionData, callback = () => {}) {
    try {
      const expiresAt = sessionData.cookie?.expires
        ? new Date(sessionData.cookie.expires).getTime()
        : Date.now() + this.ttlMs;
      getDb()
        .prepare("UPDATE sessions SET expires_at = ?, data = ? WHERE sid = ?")
        .run(expiresAt, JSON.stringify(sessionData), sid);
      return callback(null);
    } catch (err) {
      return callback(err);
    }
  }

  length(callback) {
    try {
      const row = getDb()
        .prepare("SELECT COUNT(*) AS c FROM sessions WHERE expires_at > ?")
        .get(Date.now());
      return callback(null, row.c);
    } catch (err) {
      return callback(err);
    }
  }

  clear(callback = () => {}) {
    try {
      getDb().prepare("DELETE FROM sessions").run();
      return callback(null);
    } catch (err) {
      return callback(err);
    }
  }
}

export default SqliteSessionStore;
