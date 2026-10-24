-- 001_core.sql
-- Baseline schema. Written with CREATE TABLE IF NOT EXISTS so that a
-- ChatCloser 1.x database (which already has these tables) and a brand-new
-- database converge on the same shape.

CREATE TABLE IF NOT EXISTS businesses (
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

CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL,
  chat_id TEXT NOT NULL,
  role TEXT NOT NULL,
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
  status TEXT DEFAULT 'new',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (business_id) REFERENCES businesses(id)
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT DEFAULT 'owner',
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
  payment_status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (business_id) REFERENCES businesses(id)
);

CREATE TABLE IF NOT EXISTS webhooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  events TEXT NOT NULL DEFAULT '[]',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (business_id) REFERENCES businesses(id)
);

CREATE TABLE IF NOT EXISTS nepal_payment_methods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  merchant_id TEXT,
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (business_id) REFERENCES businesses(id)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  details TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (business_id) REFERENCES businesses(id)
);

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

CREATE INDEX IF NOT EXISTS idx_conversations_business_chat
  ON conversations(business_id, chat_id);

CREATE INDEX IF NOT EXISTS idx_leads_business_status
  ON leads(business_id, status);

CREATE INDEX IF NOT EXISTS idx_price_list_business
  ON price_list(business_id);

CREATE INDEX IF NOT EXISTS idx_orders_business_status
  ON orders(business_id, payment_status);

CREATE INDEX IF NOT EXISTS idx_audit_log_business
  ON audit_log(business_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_business
  ON webhook_deliveries(business_id, created_at DESC);
