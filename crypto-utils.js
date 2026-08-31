// crypto-utils.js
// AES-256-GCM encryption for AI provider API keys stored in the database.
// Keys are never stored or logged in plaintext anywhere in the app.

import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";

function getKey() {
  const keyHex = process.env.ENCRYPTION_KEY;
  if (!keyHex || keyHex.length !== 64) {
    throw new Error(
      'ENCRYPTION_KEY must be a 64-character hex string (32 bytes). Generate one with:\n  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"\nand put it in your .env file.'
    );
  }
  return Buffer.from(keyHex, "hex");
}

/** Encrypt a plaintext string. Returns "iv:authTag:ciphertext", all hex. */
export function encrypt(plaintext) {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("hex"), authTag.toString("hex"), encrypted.toString("hex")].join(":");
}

/** Decrypt a string produced by encrypt(). */
export function decrypt(payload) {
  const key = getKey();
  const [ivHex, authTagHex, dataHex] = payload.split(":");
  if (!ivHex || !authTagHex || !dataHex) {
    throw new Error("Malformed encrypted payload.");
  }
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataHex, "hex")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

/** Mask a plaintext key for display, e.g. "sk-ant-a1…9f3d". Never call with ciphertext. */
export function maskKey(plaintext) {
  if (!plaintext || plaintext.length < 10) return "••••••••";
  return `${plaintext.slice(0, 6)}…${plaintext.slice(-4)}`;
}

// ---------- password hashing for admin login ----------
// Uses Node's built-in scrypt — no extra dependency (e.g. bcrypt) needed.

const SCRYPT_KEYLEN = 64;

/** Hash a plaintext password. Returns "salt:hash", both hex. */
export function hashPassword(plaintext) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(plaintext, salt, SCRYPT_KEYLEN).toString("hex");
  return `${salt}:${hash}`;
}

/** Verify a plaintext password against a hash produced by hashPassword(). */
export function verifyPassword(plaintext, stored) {
  const [salt, hash] = (stored || "").split(":");
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(plaintext, salt, SCRYPT_KEYLEN);
  const expected = Buffer.from(hash, "hex");
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}
