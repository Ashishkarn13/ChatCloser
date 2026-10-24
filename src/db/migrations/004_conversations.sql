-- 004_conversations.sql
-- Shared inbox: threads, assignment, human takeover, AI pause/resume and
-- handover notes. The legacy `conversations` table keeps storing the raw
-- messages (so the 1.x code paths and exports keep working) and gains a
-- link to the thread that owns them.

CREATE TABLE IF NOT EXISTS threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL,
  channel TEXT NOT NULL DEFAULT 'whatsapp',
  external_id TEXT NOT NULL,
  customer_id INTEGER DEFAULT NULL,
  customer_name TEXT DEFAULT '',
  contact_number TEXT DEFAULT '',
  subject TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  priority TEXT NOT NULL DEFAULT 'normal',
  assigned_to TEXT DEFAULT '',
  ai_mode TEXT NOT NULL DEFAULT 'auto',
  labels TEXT NOT NULL DEFAULT '[]',
  unread_count INTEGER NOT NULL DEFAULT 0,
  last_message_at TEXT DEFAULT '',
  last_message_preview TEXT DEFAULT '',
  handover_summary TEXT DEFAULT '',
  escalated_at TEXT DEFAULT NULL,
  closed_at TEXT DEFAULT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (business_id) REFERENCES businesses(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_threads_business_channel
  ON threads(business_id, channel, external_id);

CREATE INDEX IF NOT EXISTS idx_threads_business_status
  ON threads(business_id, status, last_message_at DESC);

CREATE TABLE IF NOT EXISTS thread_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL,
  thread_id INTEGER NOT NULL,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (business_id) REFERENCES businesses(id),
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_thread_notes_thread
  ON thread_notes(thread_id, id DESC);

CREATE TABLE IF NOT EXISTS thread_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL,
  thread_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  actor TEXT DEFAULT 'system',
  detail TEXT DEFAULT '{}',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (business_id) REFERENCES businesses(id),
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_thread_events_thread
  ON thread_events(thread_id, id DESC);

-- Templates for outbound messages (business-approved wording).
CREATE TABLE IF NOT EXISTS message_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  name TEXT DEFAULT '',
  body TEXT NOT NULL,
  channel TEXT DEFAULT 'whatsapp',
  locale TEXT DEFAULT '',
  variables TEXT NOT NULL DEFAULT '[]',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (business_id, key, channel),
  FOREIGN KEY (business_id) REFERENCES businesses(id)
);

-- Customer opt-in state per channel.
CREATE TABLE IF NOT EXISTS opt_ins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL,
  customer_id INTEGER DEFAULT NULL,
  channel TEXT NOT NULL,
  identifier TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'opted_in',
  source TEXT DEFAULT '',
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (business_id, channel, identifier),
  FOREIGN KEY (business_id) REFERENCES businesses(id)
);
