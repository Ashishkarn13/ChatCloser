// src/services/backups.js
// Backup and restore.
//
// A backup is a consistent snapshot of the SQLite database, taken with
// VACUUM INTO (which is safe to run while the application is writing).
// Backups can optionally be encrypted with AES-256-GCM using the same
// ENCRYPTION_KEY that protects the stored provider credentials.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "../config.js";
import { getDb, closeDb } from "../db/connection.js";
import { audit } from "../core/audit.js";
import { NotFoundError } from "../core/errors.js";

const MAGIC = Buffer.from("CCBK1");

function ensureBackupDir() {
  fs.mkdirSync(config.backupDir, { recursive: true });
  return config.backupDir;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * Creates a backup.
 * @param {object} [options]
 * @param {boolean} [options.encrypt=true]
 * @param {number} [options.businessId] recorded in the audit log
 */
export function backupDatabase({ encrypt = true, businessId = null, actor = "system" } = {}) {
  const dir = ensureBackupDir();
  const name = `chatcloser-${timestamp()}.db${encrypt ? ".enc" : ""}`;
  const target = path.join(dir, name);

  const staging = path.join(dir, `.staging-${timestamp()}.db`);
  // VACUUM INTO writes a consistent snapshot without blocking writers.
  getDb().exec(`VACUUM INTO '${staging.replace(/'/g, "''")}'`);

  if (encrypt) {
    const key = getEncryptionKey();
    const data = fs.readFileSync(staging);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
    const tag = cipher.getAuthTag();
    fs.writeFileSync(target, Buffer.concat([MAGIC, iv, tag, ciphertext]));
    fs.rmSync(staging, { force: true });
  } else {
    fs.moveSync(staging, target);
  }

  const stat = fs.statSync(target);
  if (businessId) {
    audit({
      businessId,
      actor,
      action: "backup.created",
      details: { name, bytes: stat.size, encrypted: encrypt },
    });
  }

  return { name, path: target, bytes: stat.size, encrypted: encrypt, createdAt: stat.mtime.toISOString() };
}

export function listBackups() {
  const dir = ensureBackupDir();
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith("chatcloser-") && f.endsWith(".db") || f.endsWith(".db.enc"))
    .map((name) => {
      const stat = fs.statSync(path.join(dir, name));
      return {
        name,
        bytes: stat.size,
        createdAt: stat.mtime.toISOString(),
        encrypted: name.endsWith(".enc"),
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Restores a backup over the live database.
 *
 * The current database is copied aside first, so a restore can itself be
 * undone. The application must be restarted afterwards because the
 * replacement happens underneath the open connection.
 */
export function restoreBackup(name, { businessId = null, actor = "system" } = {}) {
  const dir = ensureBackupDir();
  const source = path.join(dir, path.basename(name));
  if (!fs.existsSync(source)) throw new NotFoundError("No such backup.");

  const staging = path.join(dir, `.restore-${timestamp()}.db`);
  if (name.endsWith(".enc")) {
    const payload = fs.readFileSync(source);
    if (!payload.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new NotFoundError("That backup file is not a ChatCloser backup.");
    }
    const iv = payload.subarray(MAGIC.length, MAGIC.length + 12);
    const tag = payload.subarray(MAGIC.length + 12, MAGIC.length + 28);
    const ciphertext = payload.subarray(MAGIC.length + 28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", getEncryptionKey(), iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    fs.writeFileSync(staging, plain);
  } else {
    fs.copyFileSync(source, staging);
  }

  // Keep the current database as a safety net.
  const safety = path.join(dir, `pre-restore-${timestamp()}.db`);
  try {
    fs.copyFileSync(config.dbPath, safety);
  } catch {
    /* no live database yet */
  }

  closeDb();

  // SQLite needs the WAL and shared-memory files gone before the main
  // database file can be replaced.
  for (const suffix of ["", "-wal", "-shm"]) {
    const target = `${config.dbPath}${suffix}`;
    if (fs.existsSync(target)) fs.rmSync(target, { force: true });
  }
  fs.copyFileSync(staging, config.dbPath);
  fs.rmSync(staging, { force: true });

  if (businessId) {
    audit({
      businessId,
      actor,
      action: "backup.restored",
      details: { name, safetyCopy: path.basename(safety) },
      severity: "warning",
    });
  }

  return true;
}

function getEncryptionKey() {
  const keyHex = config.encryptionKey;
  if (!keyHex || keyHex.length !== 64) {
    throw new Error(
      "ENCRYPTION_KEY must be a 64-character hex string to encrypt backups. Generate one with:\n" +
        '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  return Buffer.from(keyHex, "hex");
}

export { ensureBackupDir };
