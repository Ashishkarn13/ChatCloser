-- 003_commerce.sql
-- Catalog, inventory, CRM, orders, bookings, quotations, invoices and the
-- payments ledger.

-- ---------- customers (CRM) ----------

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  phone TEXT DEFAULT '',
  email TEXT DEFAULT '',
  alt_phone TEXT DEFAULT '',
  company TEXT DEFAULT '',
  province TEXT DEFAULT '',
  district TEXT DEFAULT '',
  municipality TEXT DEFAULT '',
  ward TEXT DEFAULT '',
  locality TEXT DEFAULT '',
  address TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  tags TEXT DEFAULT '[]',
  source TEXT DEFAULT '',
  is_vip INTEGER NOT NULL DEFAULT 0,
  lifetime_value REAL NOT NULL DEFAULT 0,
  total_orders INTEGER NOT NULL DEFAULT 0,
  last_order_at TEXT DEFAULT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT DEFAULT NULL,
  FOREIGN KEY (business_id) REFERENCES businesses(id)
);

CREATE INDEX IF NOT EXISTS idx_customers_business ON customers(business_id, name);
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(business_id, phone);
CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_business_phone
  ON customers(business_id, phone) WHERE phone <> '' AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS customer_tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  color TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (business_id, name),
  FOREIGN KEY (business_id) REFERENCES businesses(id)
);

CREATE TABLE IF NOT EXISTS customer_tag_links (
  business_id INTEGER NOT NULL,
  customer_id INTEGER NOT NULL,
  tag_id INTEGER NOT NULL,
  PRIMARY KEY (customer_id, tag_id),
  FOREIGN KEY (business_id) REFERENCES businesses(id),
  FOREIGN KEY (customer_id) REFERENCES customers(id),
  FOREIGN KEY (tag_id) REFERENCES customer_tags(id)
);

-- ---------- catalog ----------

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  slug TEXT DEFAULT '',
  sku TEXT DEFAULT '',
  barcode TEXT DEFAULT '',
  type TEXT NOT NULL DEFAULT 'product',
  category TEXT DEFAULT '',
  description TEXT DEFAULT '',
  unit TEXT DEFAULT 'pcs',
  price REAL NOT NULL DEFAULT 0,
  cost_price REAL NOT NULL DEFAULT 0,
  tax_rate REAL NOT NULL DEFAULT 0,
  track_inventory INTEGER NOT NULL DEFAULT 0,
  attributes TEXT NOT NULL DEFAULT '{}',
  tags TEXT NOT NULL DEFAULT '[]',
  image_url TEXT DEFAULT '',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT DEFAULT NULL,
  FOREIGN KEY (business_id) REFERENCES businesses(id)
);

CREATE INDEX IF NOT EXISTS idx_products_business ON products(business_id, name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_products_business_sku
  ON products(business_id, sku) WHERE sku <> '' AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS product_variants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  sku TEXT DEFAULT '',
  price REAL NOT NULL DEFAULT 0,
  attributes TEXT NOT NULL DEFAULT '{}',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (business_id) REFERENCES businesses(id),
  FOREIGN KEY (product_id) REFERENCES products(id)
);

CREATE INDEX IF NOT EXISTS idx_variants_product ON product_variants(product_id);

CREATE TABLE IF NOT EXISTS stock_levels (
  business_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  variant_id INTEGER NOT NULL DEFAULT 0,
  quantity_on_hand REAL NOT NULL DEFAULT 0,
  quantity_reserved REAL NOT NULL DEFAULT 0,
  reorder_level REAL NOT NULL DEFAULT 0,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (product_id, variant_id),
  FOREIGN KEY (business_id) REFERENCES businesses(id),
  FOREIGN KEY (product_id) REFERENCES products(id)
);

CREATE TABLE IF NOT EXISTS inventory_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  variant_id INTEGER NOT NULL DEFAULT 0,
  type TEXT NOT NULL,
  quantity REAL NOT NULL,
  balance_after REAL DEFAULT 0,
  reference_type TEXT DEFAULT '',
  reference_id INTEGER DEFAULT NULL,
  note TEXT DEFAULT '',
  actor TEXT DEFAULT 'system',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (business_id) REFERENCES businesses(id),
  FOREIGN KEY (product_id) REFERENCES products(id)
);

CREATE INDEX IF NOT EXISTS idx_movements_product
  ON inventory_movements(business_id, product_id, created_at DESC);

CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  contact_name TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  email TEXT DEFAULT '',
  address TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  balance REAL NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (business_id) REFERENCES businesses(id)
);

CREATE TABLE IF NOT EXISTS purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL,
  supplier_id INTEGER DEFAULT NULL,
  reference TEXT DEFAULT '',
  total REAL NOT NULL DEFAULT 0,
  paid REAL NOT NULL DEFAULT 0,
  status TEXT DEFAULT 'received',
  notes TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (business_id) REFERENCES businesses(id)
);

CREATE TABLE IF NOT EXISTS purchase_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  quantity REAL NOT NULL,
  unit_cost REAL NOT NULL DEFAULT 0,
  FOREIGN KEY (purchase_id) REFERENCES purchases(id),
  FOREIGN KEY (product_id) REFERENCES products(id)
);

-- ---------- orders ----------

-- The lifecycle is explicit and enforced in code (src/services/orders.js).
CREATE TABLE IF NOT EXISTS order_drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL,
  thread_id INTEGER DEFAULT NULL,
  chat_id TEXT DEFAULT '',
  customer_id INTEGER DEFAULT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  summary TEXT DEFAULT '',
  total REAL NOT NULL DEFAULT 0,
  currency TEXT DEFAULT 'NPR',
  state TEXT NOT NULL DEFAULT 'awaiting_confirmation',
  revision INTEGER NOT NULL DEFAULT 1,
  expires_at TEXT DEFAULT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (business_id) REFERENCES businesses(id)
);

CREATE INDEX IF NOT EXISTS idx_order_drafts_business
  ON order_drafts(business_id, chat_id, state);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL,
  order_id INTEGER NOT NULL,
  product_id INTEGER DEFAULT NULL,
  variant_id INTEGER DEFAULT NULL,
  name TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1,
  unit_price REAL NOT NULL DEFAULT 0,
  discount_amount REAL NOT NULL DEFAULT 0,
  tax_rate REAL NOT NULL DEFAULT 0,
  tax_amount REAL NOT NULL DEFAULT 0,
  line_total REAL NOT NULL DEFAULT 0,
  price_snapshot TEXT NOT NULL DEFAULT '{}',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (business_id) REFERENCES businesses(id),
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);

CREATE TABLE IF NOT EXISTS order_transitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL,
  order_id INTEGER NOT NULL,
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  actor TEXT DEFAULT 'system',
  reason TEXT DEFAULT '',
  meta TEXT DEFAULT '{}',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (business_id) REFERENCES businesses(id),
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_order_transitions_order
  ON order_transitions(order_id, id);

-- Idempotency ledger — protects order creation from webhook retries and
-- duplicate customer confirmations.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'default',
  request_hash TEXT DEFAULT '',
  response TEXT DEFAULT '',
  status TEXT DEFAULT 'in_progress',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (business_id, scope, key),
  FOREIGN KEY (business_id) REFERENCES businesses(id)
);

-- ---------- bookings ----------

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL,
  customer_id INTEGER DEFAULT NULL,
  service_id INTEGER DEFAULT NULL,
  title TEXT DEFAULT '',
  starts_at TEXT NOT NULL,
  ends_at TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'scheduled',
  assigned_to TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  reminder_sent INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (business_id) REFERENCES businesses(id)
);

CREATE INDEX IF NOT EXISTS idx_bookings_business
  ON bookings(business_id, starts_at);

-- ---------- quotations & invoices ----------

CREATE TABLE IF NOT EXISTS quotations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL,
  number TEXT NOT NULL,
  customer_id INTEGER DEFAULT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  currency TEXT DEFAULT 'NPR',
  items TEXT NOT NULL DEFAULT '[]',
  subtotal REAL NOT NULL DEFAULT 0,
  discount_amount REAL NOT NULL DEFAULT 0,
  tax_amount REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  valid_until TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  terms TEXT DEFAULT '',
  created_by TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (business_id) REFERENCES businesses(id)
);

CREATE INDEX IF NOT EXISTS idx_quotations_business
  ON quotations(business_id, created_at DESC);

CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL,
  number TEXT NOT NULL,
  order_id INTEGER DEFAULT NULL,
  customer_id INTEGER DEFAULT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  currency TEXT DEFAULT 'NPR',
  items TEXT NOT NULL DEFAULT '[]',
  subtotal REAL NOT NULL DEFAULT 0,
  discount_amount REAL NOT NULL DEFAULT 0,
  tax_amount REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  amount_paid REAL NOT NULL DEFAULT 0,
  balance REAL NOT NULL DEFAULT 0,
  issued_at TEXT DEFAULT '',
  due_at TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  created_by TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (business_id) REFERENCES businesses(id)
);

CREATE INDEX IF NOT EXISTS idx_invoices_business
  ON invoices(business_id, created_at DESC);

-- ---------- payments ----------

-- A payment row only ever reaches status='succeeded' when the provider's
-- own verification path produced it. AI text and screenshots are not proof.
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL,
  order_id INTEGER DEFAULT NULL,
  invoice_id INTEGER DEFAULT NULL,
  customer_id INTEGER DEFAULT NULL,
  provider TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT 'unknown',
  provider_ref TEXT DEFAULT '',
  merchant_ref TEXT DEFAULT '',
  amount REAL NOT NULL,
  currency TEXT DEFAULT 'NPR',
  status TEXT NOT NULL DEFAULT 'pending',
  verified INTEGER NOT NULL DEFAULT 0,
  verified_at TEXT DEFAULT NULL,
  verification_detail TEXT DEFAULT '',
  raw TEXT NOT NULL DEFAULT '{}',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (business_id) REFERENCES businesses(id)
);

CREATE INDEX IF NOT EXISTS idx_payments_business ON payments(business_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_provider_ref
  ON payments(provider, provider_ref) WHERE provider_ref <> '';

-- Webhook intake ledger: guarantees idempotent processing of provider
-- callbacks (the same event may arrive many times).
CREATE TABLE IF NOT EXISTS payment_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL,
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT DEFAULT '',
  payload_hash TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'received',
  error TEXT DEFAULT '',
  received_at TEXT DEFAULT CURRENT_TIMESTAMP,
  processed_at TEXT DEFAULT NULL,
  UNIQUE (provider, event_id),
  FOREIGN KEY (business_id) REFERENCES businesses(id)
);

-- Expense / cash-book records used by the accounting-support reports.
CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id INTEGER NOT NULL,
  category TEXT NOT NULL DEFAULT 'other',
  amount REAL NOT NULL DEFAULT 0,
  currency TEXT DEFAULT 'NPR',
  paid_to TEXT DEFAULT '',
  note TEXT DEFAULT '',
  spent_at TEXT DEFAULT '',
  created_by TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (business_id) REFERENCES businesses(id)
);

CREATE INDEX IF NOT EXISTS idx_expenses_business ON expenses(business_id, spent_at DESC);
