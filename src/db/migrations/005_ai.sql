-- 005_ai.sql
-- Knowledge base (searchable, versioned, with source references), the
-- per-business AI tool permission registry, the AI run ledger (usage and
-- cost), the memory store and the human-approval queue.

CREATE TABLE IF NOT EXISTS knowledge_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  category TEXT DEFAULT 'general',
  content TEXT NOT NULL DEFAULT '',
  source TEXT DEFAULT '',
  source_url TEXT DEFAULT '',
  locale TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'published',
  version INTEGER NOT NULL DEFAULT 1,
  visibility TEXT NOT NULL DEFAULT 'ai',
  created_by TEXT DEFAULT '',
  updated_by TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT DEFAULT NULL,
  FOREIGN KEY (business_id) REFERENCES businesses(id)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_business
  ON knowledge_documents(business_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL,
  document_id INTEGER NOT NULL,
  heading TEXT DEFAULT '',
  content TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  token_estimate INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (business_id) REFERENCES businesses(id),
  FOREIGN KEY (document_id) REFERENCES knowledge_documents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_document
  ON knowledge_chunks(document_id);

-- Full-text search index over the chunks. Managed by
-- src/services/knowledge.js (rebuilt on write). A standalone (not
-- external-content) FTS5 table is used so the index can be rebuilt for a
-- single business without touching the others.
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
  chunk_id UNINDEXED,
  heading,
  content,
  tokenize='unicode61 remove_diacritics 2'
);

-- Per-business AI tool permissions. Every tool the AI may call must be
-- listed here (or be enabled by default in the registry) — the AI's own
-- output never grants itself permission.
CREATE TABLE IF NOT EXISTS ai_tool_permissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL,
  tool_name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  requires_approval INTEGER NOT NULL DEFAULT 0,
  allowed_roles TEXT NOT NULL DEFAULT '[]',
  daily_limit INTEGER NOT NULL DEFAULT 0,
  notes TEXT DEFAULT '',
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (business_id, tool_name),
  FOREIGN KEY (business_id) REFERENCES businesses(id)
);

-- Every AI run: provider, model, latency, tokens, cost, tool calls and
-- the outcome. Drives the AI usage/cost dashboard.
CREATE TABLE IF NOT EXISTS ai_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL,
  thread_id INTEGER DEFAULT NULL,
  customer_id INTEGER DEFAULT NULL,
  provider TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  intent TEXT DEFAULT '',
  language TEXT DEFAULT '',
  latency_ms INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost REAL NOT NULL DEFAULT 0,
  tool_calls TEXT NOT NULL DEFAULT '[]',
  retrieved_sources TEXT NOT NULL DEFAULT '[]',
  outcome TEXT DEFAULT 'replied',
  error TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (business_id) REFERENCES businesses(id)
);

CREATE INDEX IF NOT EXISTS idx_ai_runs_business ON ai_runs(business_id, created_at DESC);

-- AI memory. `kind` separates transient context, customer-approved
-- preferences and durable summaries. Nothing here is used for training.
CREATE TABLE IF NOT EXISTS ai_memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL,
  customer_id INTEGER DEFAULT NULL,
  thread_id INTEGER DEFAULT NULL,
  kind TEXT NOT NULL DEFAULT 'preference',
  content TEXT NOT NULL,
  source TEXT DEFAULT 'ai',
  expires_at TEXT DEFAULT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ai_memory_customer
  ON ai_memory(business_id, customer_id, kind);

-- Actions the AI proposes that require a human decision.
CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL,
  thread_id INTEGER DEFAULT NULL,
  customer_id INTEGER DEFAULT NULL,
  tool_name TEXT NOT NULL,
  arguments TEXT NOT NULL DEFAULT '{}',
  summary TEXT DEFAULT '',
  risk TEXT DEFAULT 'normal',
  status TEXT NOT NULL DEFAULT 'pending',
  requested_by TEXT DEFAULT 'ai',
  decided_by TEXT DEFAULT '',
  result TEXT DEFAULT '',
  decision_note TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  decided_at TEXT DEFAULT NULL,
  expires_at TEXT DEFAULT NULL,
  FOREIGN KEY (business_id) REFERENCES businesses(id)
);

CREATE INDEX IF NOT EXISTS idx_approvals_business
  ON approvals(business_id, status, created_at DESC);
