// db.js
// SQLite setup + query helpers. Every table is scoped by business_id
// from day one, even though Stage 1 only ever runs one business — this
// means later stages (multi-industry, multi-tenant SaaS) never require a
// schema rewrite.
//
// Uses Node's BUILT-IN SQLite (node:sqlite, Node 22.5+) instead of the
// native better-sqlite3 package. This avoids the native-compile step
// entirely — no Visual Studio / build tools required on Windows, no
// prebuilt-binary download to fail. Requires Node 22.5 or newer.

import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync("./data.sqlite");
db.exec("PRAGMA journal_mode = WAL;");

db.exec(`
CREATE TABLE IF NOT EXISTS businesses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  system_prompt_extra TEXT DEFAULT '',
  knowledge_base TEXT DEFAULT '{}',          -- JSON blob
  escalation_keywords TEXT DEFAULT '[]',     -- JSON array
  escalation_message TEXT DEFAULT '',
  away_message TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL,
  chat_id TEXT NOT NULL,
  role TEXT NOT NULL,                        -- 'user' | 'assistant'
  content TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (business_id) REFERENCES businesses(id)
);

CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL,
  chat_id TEXT NOT NULL,
  customer_name TEXT,
  contact_number TEXT,
  service_requested TEXT,
  location TEXT,
  urgency TEXT,
  preferred_date TEXT,
  notes TEXT,
  status TEXT DEFAULT 'new',                 -- new | contacted | booked | closed
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (business_id) REFERENCES businesses(id)
);

CREATE INDEX IF NOT EXISTS idx_conversations_business_chat
  ON conversations(business_id, chat_id);

CREATE INDEX IF NOT EXISTS idx_leads_business_status
  ON leads(business_id, status);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS price_list (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL,
  item_name TEXT NOT NULL,
  price_amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  description TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (business_id) REFERENCES businesses(id)
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL,
  lead_id INTEGER,
  chat_id TEXT NOT NULL,
  item_name TEXT NOT NULL,
  amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  stripe_checkout_session_id TEXT,
  payment_url TEXT,
  payment_status TEXT DEFAULT 'pending',   -- pending | paid | failed | expired
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (business_id) REFERENCES businesses(id)
);

CREATE INDEX IF NOT EXISTS idx_price_list_business
  ON price_list(business_id);

CREATE INDEX IF NOT EXISTS idx_orders_business_status
  ON orders(business_id, payment_status);

CREATE TABLE IF NOT EXISTS webhooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  events TEXT NOT NULL DEFAULT '[]',   -- JSON array, e.g. ["lead.captured","order.paid","escalation.triggered"]
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (business_id) REFERENCES businesses(id)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL,
  actor TEXT NOT NULL,          -- username, or 'system' for automated actions
  action TEXT NOT NULL,         -- short label, e.g. "ai_settings.updated"
  details TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (business_id) REFERENCES businesses(id)
);

CREATE INDEX IF NOT EXISTS idx_audit_log_business
  ON audit_log(business_id, created_at DESC);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL,
  webhook_id INTEGER,
  event TEXT NOT NULL,
  url TEXT NOT NULL,
  success INTEGER NOT NULL DEFAULT 0,
  response_status INTEGER,
  error TEXT DEFAULT '',
  attempt INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_business
  ON webhook_deliveries(business_id, created_at DESC);
`);

// Migration: add AI provider columns if this DB was created before they
// existed. Safe to run every startup — ignored if columns already exist.
const existingColumns = db.prepare("PRAGMA table_info(businesses)").all().map((c) => c.name);
if (!existingColumns.includes("ai_provider")) {
  db.exec("ALTER TABLE businesses ADD COLUMN ai_provider TEXT DEFAULT ''");
}
if (!existingColumns.includes("ai_model")) {
  db.exec("ALTER TABLE businesses ADD COLUMN ai_model TEXT DEFAULT ''");
}
if (!existingColumns.includes("ai_api_key_encrypted")) {
  db.exec("ALTER TABLE businesses ADD COLUMN ai_api_key_encrypted TEXT DEFAULT ''");
}
if (!existingColumns.includes("stripe_secret_key_encrypted")) {
  db.exec("ALTER TABLE businesses ADD COLUMN stripe_secret_key_encrypted TEXT DEFAULT ''");
}
if (!existingColumns.includes("stripe_webhook_secret_encrypted")) {
  db.exec("ALTER TABLE businesses ADD COLUMN stripe_webhook_secret_encrypted TEXT DEFAULT ''");
}

const existingLeadColumns = db.prepare("PRAGMA table_info(leads)").all().map((c) => c.name);
if (!existingLeadColumns.includes("nudged_at")) {
  db.exec("ALTER TABLE leads ADD COLUMN nudged_at TEXT DEFAULT NULL");
}

const existingUserColumns = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
if (!existingUserColumns.includes("role")) {
  // Anyone created before roles existed is treated as an owner — safest
  // default, since they were already trusted with full admin access.
  db.exec("ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'owner'");
}

// ---------- businesses ----------

export function getBusiness(id) {
  const row = db.prepare("SELECT * FROM businesses WHERE id = ?").get(id);
  if (!row) return null;
  return {
    ...row,
    knowledge_base: JSON.parse(row.knowledge_base || "{}"),
    escalation_keywords: JSON.parse(row.escalation_keywords || "[]"),
  };
}

export function upsertBusiness(id, fields) {
  const existing = db.prepare("SELECT id FROM businesses WHERE id = ?").get(id);
  const knowledge_base = JSON.stringify(fields.knowledge_base ?? {});
  const escalation_keywords = JSON.stringify(fields.escalation_keywords ?? []);

  if (existing) {
    db.prepare(`
      UPDATE businesses SET
        name = ?, system_prompt_extra = ?, knowledge_base = ?,
        escalation_keywords = ?, escalation_message = ?, away_message = ?
      WHERE id = ?
    `).run(
      fields.name, fields.system_prompt_extra ?? "", knowledge_base,
      escalation_keywords, fields.escalation_message ?? "",
      fields.away_message ?? "", id
    );
  } else {
    db.prepare(`
      INSERT INTO businesses
        (id, name, system_prompt_extra, knowledge_base, escalation_keywords, escalation_message, away_message)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, fields.name, fields.system_prompt_extra ?? "", knowledge_base,
      escalation_keywords, fields.escalation_message ?? "", fields.away_message ?? ""
    );
  }
  return getBusiness(id);
}

export function updateAISettings(id, { provider, model, encryptedKey }) {
  db.prepare(`
    UPDATE businesses SET ai_provider = ?, ai_model = ?, ai_api_key_encrypted = ?
    WHERE id = ?
  `).run(provider ?? "", model ?? "", encryptedKey ?? "", id);
  return getBusiness(id);
}

// ---------- conversations ----------

export function saveMessage(businessId, chatId, role, content) {
  db.prepare(`
    INSERT INTO conversations (business_id, chat_id, role, content)
    VALUES (?, ?, ?, ?)
  `).run(businessId, chatId, role, content);
}

export function getHistory(businessId, chatId, limit = 10) {
  const rows = db.prepare(`
    SELECT role, content FROM conversations
    WHERE business_id = ? AND chat_id = ?
    ORDER BY id DESC LIMIT ?
  `).all(businessId, chatId, limit);
  return rows.reverse(); // chronological order for the AI call
}

export function getAllChatIds(businessId) {
  return db.prepare(`
    SELECT DISTINCT chat_id FROM conversations
    WHERE business_id = ? ORDER BY chat_id
  `).all(businessId).map((r) => r.chat_id);
}

export function getConversation(businessId, chatId) {
  return db.prepare(`
    SELECT role, content, created_at FROM conversations
    WHERE business_id = ? AND chat_id = ?
    ORDER BY id ASC
  `).all(businessId, chatId);
}

// ---------- leads ----------

export function createLead(businessId, chatId, fields) {
  const info = db.prepare(`
    INSERT INTO leads
      (business_id, chat_id, customer_name, contact_number, service_requested, location, urgency, preferred_date, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    businessId, chatId,
    fields.customer_name ?? null, fields.contact_number ?? null,
    fields.service_requested ?? null, fields.location ?? null,
    fields.urgency ?? null, fields.preferred_date ?? null, fields.notes ?? null
  );
  const newId = Number(info.lastInsertRowid);
  return db.prepare("SELECT * FROM leads WHERE id = ?").get(newId);
}

export function getLeads(businessId) {
  return db.prepare(`
    SELECT * FROM leads WHERE business_id = ? ORDER BY created_at DESC
  `).all(businessId);
}

export function getLead(businessId, leadId) {
  return db.prepare(`
    SELECT * FROM leads WHERE business_id = ? AND id = ?
  `).get(businessId, leadId);
}

export function updateLeadStatus(businessId, leadId, status) {
  db.prepare(`
    UPDATE leads SET status = ?, updated_at = CURRENT_TIMESTAMP
    WHERE business_id = ? AND id = ?
  `).run(status, businessId, leadId);
  return getLead(businessId, leadId);
}

export function getLeadStats(businessId) {
  const rows = db.prepare(`
    SELECT status, COUNT(*) as count FROM leads WHERE business_id = ? GROUP BY status
  `).all(businessId);
  const stats = { new: 0, contacted: 0, booked: 0, closed: 0, total: 0 };
  for (const row of rows) {
    stats[row.status] = row.count;
    stats.total += row.count;
  }
  return stats;
}

export function getConversationCount(businessId) {
  const row = db.prepare(`
    SELECT COUNT(DISTINCT chat_id) as count FROM conversations WHERE business_id = ?
  `).get(businessId);
  return row.count;
}

// ---------- business bootstrap (so a new company doesn't need seed.js) ----------

export function ensureBusiness(id, defaultName = "Your Company Name") {
  const existing = getBusiness(id);
  if (existing) return existing;
  return upsertBusiness(id, {
    name: defaultName,
    system_prompt_extra: `You are a helpful assistant for "${defaultName}". Only answer using the knowledge base below — never guess or invent prices, availability, or policies. If you don't know something, say so honestly and offer to connect the customer with a human. Keep replies short and conversational — this is WhatsApp, not email. Once you have enough information (at minimum, what they're interested in, plus a name or contact number), call the capture_lead tool. Never confirm a final price or booking yourself — a human always confirms those.`,
    knowledge_base: {
      services: "Describe what you offer here — edit this from the Company Profile tab.",
      hours: "e.g. Mon-Sat, 9am-6pm",
    },
    escalation_keywords: ["complaint", "refund", "speak to a human", "manager", "legal", "unsafe"],
    escalation_message: "Thanks for letting us know — I've flagged this for our team and someone will follow up shortly.",
    away_message: "Thanks for reaching out! We're currently closed. We'll get back to you as soon as we're open.",
  });
}

// ---------- users (admin panel login, with owner/staff roles) ----------

export function countUsers() {
  return db.prepare("SELECT COUNT(*) as count FROM users").get().count;
}

export function countOwners() {
  return db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'owner'").get().count;
}

export function getUserByUsername(username) {
  return db.prepare("SELECT * FROM users WHERE username = ?").get(username);
}

export function getAllUsers() {
  return db.prepare("SELECT id, username, role, created_at FROM users ORDER BY created_at ASC").all();
}

export function createUser(username, passwordHash, role = "staff") {
  db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)").run(username, passwordHash, role);
  return getUserByUsername(username);
}

export function updateUserPassword(username, passwordHash) {
  db.prepare("UPDATE users SET password_hash = ? WHERE username = ?").run(passwordHash, username);
  return getUserByUsername(username);
}

export function deleteUser(username) {
  db.prepare("DELETE FROM users WHERE username = ?").run(username);
}

// ---------- payments: Stripe settings (BYOK, same pattern as AI keys) ----------

export function updateStripeSettings(businessId, { secretKeyEncrypted, webhookSecretEncrypted }) {
  db.prepare(`
    UPDATE businesses SET stripe_secret_key_encrypted = ?, stripe_webhook_secret_encrypted = ?
    WHERE id = ?
  `).run(secretKeyEncrypted ?? "", webhookSecretEncrypted ?? "", businessId);
  return getBusiness(businessId);
}

// ---------- price list (the ONLY source of prices the AI is allowed to quote) ----------

export function getPriceList(businessId) {
  return db.prepare(`
    SELECT * FROM price_list WHERE business_id = ? ORDER BY item_name ASC
  `).all(businessId);
}

export function getPriceItemByName(businessId, itemName) {
  return db.prepare(`
    SELECT * FROM price_list WHERE business_id = ? AND LOWER(item_name) = LOWER(?)
  `).get(businessId, itemName);
}

export function upsertPriceItem(businessId, { id, item_name, price_amount, currency, description }) {
  if (id) {
    db.prepare(`
      UPDATE price_list SET item_name = ?, price_amount = ?, currency = ?, description = ?
      WHERE id = ? AND business_id = ?
    `).run(item_name, price_amount, currency || "USD", description || "", id, businessId);
    return db.prepare("SELECT * FROM price_list WHERE id = ?").get(id);
  }
  const info = db.prepare(`
    INSERT INTO price_list (business_id, item_name, price_amount, currency, description)
    VALUES (?, ?, ?, ?, ?)
  `).run(businessId, item_name, price_amount, currency || "USD", description || "");
  const newId = Number(info.lastInsertRowid);
  return db.prepare("SELECT * FROM price_list WHERE id = ?").get(newId);
}

export function deletePriceItem(businessId, id) {
  db.prepare("DELETE FROM price_list WHERE id = ? AND business_id = ?").run(id, businessId);
}

// ---------- orders / payments ----------
// Payment status is only ever set to "paid" by a verified Stripe webhook
// event — never by the AI's own text output. See index.js.

export function createOrder(businessId, chatId, leadId, { item_name, amount, currency }) {
  const info = db.prepare(`
    INSERT INTO orders (business_id, lead_id, chat_id, item_name, amount, currency)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(businessId, leadId ?? null, chatId, item_name, amount, currency || "USD");
  const newId = Number(info.lastInsertRowid);
  return db.prepare("SELECT * FROM orders WHERE id = ?").get(newId);
}

export function attachStripeSession(orderId, { stripeSessionId, paymentUrl }) {
  db.prepare(`
    UPDATE orders SET stripe_checkout_session_id = ?, payment_url = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(stripeSessionId, paymentUrl, orderId);
  return db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
}

export function getOrderByStripeSession(stripeSessionId) {
  return db.prepare("SELECT * FROM orders WHERE stripe_checkout_session_id = ?").get(stripeSessionId);
}

/**
 * Marks an order as paid based on a verified Stripe webhook event.
 * Returns the updated order, or null if no matching order was found
 * (e.g. session ID from an unrelated Stripe account).
 */
export function markOrderPaid(stripeSessionId) {
  const order = getOrderByStripeSession(stripeSessionId);
  if (!order) return null;
  db.prepare(`
    UPDATE orders SET payment_status = 'paid', updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(order.id);
  return db.prepare("SELECT * FROM orders WHERE id = ?").get(order.id);
}

export function getOrders(businessId) {
  return db.prepare(`
    SELECT * FROM orders WHERE business_id = ? ORDER BY created_at DESC
  `).all(businessId);
}

// ---------- autonomous follow-up: stale leads ----------

/** Leads still "new", not yet nudged, older than hoursThreshold. */
export function getStaleLeads(businessId, hoursThreshold = 24) {
  return db.prepare(`
    SELECT * FROM leads
    WHERE business_id = ? AND status = 'new' AND nudged_at IS NULL
      AND datetime(created_at) <= datetime('now', ?)
  `).all(businessId, `-${hoursThreshold} hours`);
}

export function markLeadNudged(leadId) {
  db.prepare("UPDATE leads SET nudged_at = CURRENT_TIMESTAMP WHERE id = ?").run(leadId);
}

// ---------- webhooks (outbound notifications for external systems) ----------

export function getWebhooks(businessId) {
  return db.prepare("SELECT * FROM webhooks WHERE business_id = ? ORDER BY created_at DESC").all(businessId)
    .map((w) => ({ ...w, events: JSON.parse(w.events || "[]") }));
}

export function getWebhooksForEvent(businessId, eventName) {
  return getWebhooks(businessId).filter((w) => w.events.includes(eventName));
}

export function createWebhook(businessId, { url, secret, events }) {
  const info = db.prepare(`
    INSERT INTO webhooks (business_id, url, secret, events) VALUES (?, ?, ?, ?)
  `).run(businessId, url, secret, JSON.stringify(events || []));
  const newId = Number(info.lastInsertRowid);
  const row = db.prepare("SELECT * FROM webhooks WHERE id = ?").get(newId);
  return { ...row, events: JSON.parse(row.events || "[]") };
}

export function deleteWebhook(businessId, id) {
  db.prepare("DELETE FROM webhooks WHERE id = ? AND business_id = ?").run(id, businessId);
}

// ---------- audit log ----------

export function logAudit(businessId, actor, action, details = "") {
  db.prepare(`
    INSERT INTO audit_log (business_id, actor, action, details) VALUES (?, ?, ?, ?)
  `).run(businessId, actor, action, typeof details === "string" ? details : JSON.stringify(details));
}

export function getAuditLog(businessId, limit = 100) {
  return db.prepare(`
    SELECT * FROM audit_log WHERE business_id = ? ORDER BY id DESC LIMIT ?
  `).all(businessId, limit);
}

// ---------- webhook delivery log (one row per attempt, retries included) ----------

export function logWebhookDelivery(businessId, { webhookId, event, url, success, responseStatus, error, attempt }) {
  db.prepare(`
    INSERT INTO webhook_deliveries (business_id, webhook_id, event, url, success, response_status, error, attempt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(businessId, webhookId ?? null, event, url, success ? 1 : 0, responseStatus ?? null, error || "", attempt || 1);
}

export function getWebhookDeliveries(businessId, limit = 100) {
  return db.prepare(`
    SELECT * FROM webhook_deliveries WHERE business_id = ? ORDER BY id DESC LIMIT ?
  `).all(businessId, limit);
}

// ---------- analytics ----------

/** Conversion rate as a percentage: leads that reached booked/closed vs. total. */
export function getConversionRate(businessId) {
  const stats = getLeadStats(businessId);
  if (stats.total === 0) return 0;
  return Math.round(((stats.booked + stats.closed) / stats.total) * 1000) / 10; // one decimal place
}

/**
 * Average time between a customer's message and the assistant's next
 * reply in the same chat, in seconds. Approximate (pairs each assistant
 * message with the most recent prior user message in that chat) but
 * good enough to spot response-time trends.
 */
export function getAverageResponseSeconds(businessId) {
  const row = db.prepare(`
    SELECT AVG(
      (julianday(a.created_at) - julianday(u.created_at)) * 86400
    ) as avg_seconds
    FROM conversations a
    JOIN conversations u
      ON u.id = (
        SELECT MAX(id) FROM conversations u2
        WHERE u2.business_id = a.business_id
          AND u2.chat_id = a.chat_id
          AND u2.role = 'user'
          AND u2.id < a.id
      )
    WHERE a.business_id = ? AND a.role = 'assistant'
  `).get(businessId);
  return row.avg_seconds ? Math.round(row.avg_seconds) : null;
}

export default db;
