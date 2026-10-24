-- 002_tenancy.sql
-- Multi-tenant foundation: per-business staff accounts, role/permission
-- model, server-side sessions, and an audit trail with request context.

-- The legacy `users` table had a global UNIQUE(username) and no business
-- scope, which meant staff of one business could sign in to another. The
-- table is rebuilt with a composite unique key instead.
CREATE TABLE IF NOT EXISTS users_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL DEFAULT 1,
  username TEXT NOT NULL,
  display_name TEXT DEFAULT '',
  email TEXT DEFAULT '',
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'staff',
  permissions TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active',
  last_login_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (business_id, username),
  FOREIGN KEY (business_id) REFERENCES businesses(id)
);

INSERT OR IGNORE INTO users_v2
  (id, business_id, username, display_name, password_hash, role, status)
SELECT id, 1, username, username, password_hash, role, 'active' FROM users;

DROP TABLE users;
ALTER TABLE users_v2 RENAME TO users;

CREATE INDEX IF NOT EXISTS idx_users_business ON users(business_id, role);

-- Server-side session store. The legacy app used express-session's
-- MemoryStore, which loses sessions on restart and leaks memory.
CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  business_id INTEGER DEFAULT NULL,
  username TEXT DEFAULT NULL,
  role TEXT DEFAULT NULL,
  data TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- Login throttling — the legacy login form had no rate limit at all.
CREATE TABLE IF NOT EXISTS login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  ip_address TEXT DEFAULT '',
  success INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_login_attempts ON login_attempts(username, created_at DESC);

-- Roles: named permission bundles. A user may additionally carry explicit
-- permission overrides in users.permissions.
CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  permissions TEXT NOT NULL DEFAULT '[]',
  is_system INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (business_id, name),
  FOREIGN KEY (business_id) REFERENCES businesses(id)
);

-- Industry templates: the configurable field/flow definitions a business
-- picks from when it sets up its workspace.
CREATE TABLE IF NOT EXISTS industry_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  category TEXT DEFAULT 'general',
  modules TEXT NOT NULL DEFAULT '[]',
  fields TEXT NOT NULL DEFAULT '[]',
  order_states TEXT NOT NULL DEFAULT '[]',
  order_required_fields TEXT NOT NULL DEFAULT '[]',
  pricing_rules TEXT NOT NULL DEFAULT '{}',
  document_templates TEXT NOT NULL DEFAULT '{}',
  default_tax_rate REAL DEFAULT 0,
  default_currency TEXT DEFAULT 'NPR'
);

-- A business' configuration on top of its template.
CREATE TABLE IF NOT EXISTS business_modules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL,
  module_key TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  settings TEXT NOT NULL DEFAULT '{}',
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (business_id, module_key),
  FOREIGN KEY (business_id) REFERENCES businesses(id)
);

-- Custom fields defined by the business (validated, versioned schemas —
-- never executable code).
CREATE TABLE IF NOT EXISTS custom_fields (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL,
  entity_type TEXT NOT NULL,
  field_key TEXT NOT NULL,
  label TEXT NOT NULL,
  field_type TEXT NOT NULL DEFAULT 'text',
  options TEXT NOT NULL DEFAULT '[]',
  required INTEGER NOT NULL DEFAULT 0,
  applies_to_states TEXT NOT NULL DEFAULT '[]',
  position INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (business_id, entity_type, field_key),
  FOREIGN KEY (business_id) REFERENCES businesses(id)
);

CREATE TABLE IF NOT EXISTS custom_field_values (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  field_key TEXT NOT NULL,
  value TEXT DEFAULT '',
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (business_id, entity_type, entity_id, field_key),
  FOREIGN KEY (business_id) REFERENCES businesses(id)
);

-- Notifications and the human task queue.
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL,
  user_id INTEGER DEFAULT NULL,
  category TEXT NOT NULL DEFAULT 'general',
  title TEXT NOT NULL,
  body TEXT DEFAULT '',
  severity TEXT DEFAULT 'info',
  entity_type TEXT DEFAULT '',
  entity_id TEXT DEFAULT '',
  read_at TEXT DEFAULT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (business_id) REFERENCES businesses(id)
);

CREATE INDEX IF NOT EXISTS idx_notifications_business
  ON notifications(business_id, created_at DESC);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  priority TEXT DEFAULT 'normal',
  assigned_to TEXT DEFAULT '',
  due_at TEXT DEFAULT NULL,
  entity_type TEXT DEFAULT '',
  entity_id TEXT DEFAULT '',
  created_by TEXT DEFAULT 'system',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT DEFAULT NULL,
  FOREIGN KEY (business_id) REFERENCES businesses(id)
);

CREATE INDEX IF NOT EXISTS idx_tasks_business ON tasks(business_id, status);
