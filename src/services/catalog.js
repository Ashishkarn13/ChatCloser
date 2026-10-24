// src/services/catalog.js
// Products and services.
//
// The catalog is the AI's *only* source of product names and prices. The
// legacy app used a flat `price_list` table; that table is kept in sync
// (a product with a price also appears in the price list) so the 1.x
// admin pages and exports keep working.

import { getDb } from "../db/connection.js";
import { audit } from "../core/audit.js";
import { NotFoundError, ValidationError } from "../core/errors.js";
import { str, num, bool, jsonObject, jsonArray } from "../core/validation.js";
import { roundMoney } from "../core/money.js";

function mapProduct(row) {
  if (!row) return null;
  return {
    ...row,
    attributes: jsonObject(row.attributes),
    tags: jsonArray(row.tags),
  };
}

export function listProducts(
  businessId,
  { search = "", type = null, category = null, includeInactive = false, limit = 200, offset = 0 } = {}
) {
  const db = getDb();
  const where = ["business_id = ?", "deleted_at IS NULL"];
  const params = [businessId];

  if (!includeInactive) where.push("is_active = 1");
  if (type) {
    where.push("type = ?");
    params.push(type);
  }
  if (category) {
    where.push("category = ?");
    params.push(category);
  }
  if (search) {
    where.push("(LOWER(name) LIKE ? OR LOWER(sku) LIKE ? OR LOWER(barcode) LIKE ? OR LOWER(description) LIKE ?)");
    const like = `%${String(search).toLowerCase()}%`;
    params.push(like, like, like, like);
  }

  params.push(Math.min(Number(limit) || 200, 500), Number(offset) || 0);

  return db
    .prepare(`SELECT * FROM products WHERE ${where.join(" AND ")} ORDER BY name ASC LIMIT ? OFFSET ?`)
    .all(...params)
    .map(mapProduct);
}

export function getProduct(businessId, productId) {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM products WHERE business_id = ? AND id = ? AND deleted_at IS NULL")
    .get(businessId, productId);
  if (!row) throw new NotFoundError("No such product in this workspace.");
  const product = mapProduct(row);
  product.variants = listVariants(businessId, productId);
  return product;
}

export function listVariants(businessId, productId) {
  const db = getDb();
  return db
    .prepare(
      "SELECT * FROM product_variants WHERE business_id = ? AND product_id = ? AND is_active = 1 ORDER BY name"
    )
    .all(businessId, productId)
    .map((v) => ({ ...v, attributes: jsonObject(v.attributes) }));
}

export function createProduct(businessId, fields, actor = "system") {
  const db = getDb();
  const name = str(fields.name, { field: "name", required: true, max: 200 });
  const type = fields.type === "service" ? "service" : "product";
  const price = roundMoney(num(fields.price, { field: "price", min: 0 }) ?? 0);
  const cost = roundMoney(num(fields.cost_price, { field: "cost_price", min: 0 }) ?? 0);
  const taxRate = num(fields.tax_rate, { field: "tax_rate", min: 0, max: 1 }) ?? 0;
  const sku = str(fields.sku, { field: "sku", max: 80 });

  if (sku) {
    const clash = db
      .prepare("SELECT id FROM products WHERE business_id = ? AND sku = ? AND deleted_at IS NULL")
      .get(businessId, sku);
    if (clash) throw new ValidationError(`SKU "${sku}" is already used by another product.`);
  }

  const info = db
    .prepare(
      `INSERT INTO products
         (business_id, name, slug, sku, barcode, type, category, description, unit,
          price, cost_price, tax_rate, track_inventory, attributes, tags, image_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      businessId,
      name,
      slugify(fields.slug || name),
      sku,
      str(fields.barcode, { field: "barcode", max: 80 }),
      type,
      str(fields.category, { field: "category", max: 80 }),
      str(fields.description, { field: "description", max: 4000 }),
      str(fields.unit, { field: "unit", max: 20 }) || (type === "service" ? "job" : "pcs"),
      price,
      cost,
      taxRate,
      fields.track_inventory === undefined ? (type === "product" ? 1 : 0) : (bool(fields.track_inventory) ? 1 : 0),
      JSON.stringify(jsonObject(fields.attributes)),
      JSON.stringify(jsonArray(fields.tags).map(String)),
      str(fields.image_url, { field: "image_url", max: 500 })
    );

  const id = Number(info.lastInsertRowid);
  syncPriceListEntry(businessId, id);
  audit({ businessId, actor, action: "product.created", details: { product_id: id, name } });
  return getProduct(businessId, id);
}

export function updateProduct(businessId, productId, fields, actor = "system") {
  const db = getDb();
  const current = getProduct(businessId, productId);

  const next = {
    name: fields.name !== undefined ? str(fields.name, { field: "name", max: 200 }) : current.name,
    sku: fields.sku !== undefined ? str(fields.sku, { field: "sku", max: 80 }) : current.sku,
    barcode: fields.barcode !== undefined ? str(fields.barcode, { field: "barcode", max: 80 }) : current.barcode,
    category: fields.category !== undefined ? str(fields.category, { field: "category", max: 80 }) : current.category,
    description:
      fields.description !== undefined ? str(fields.description, { field: "description", max: 4000 }) : current.description,
    unit: fields.unit !== undefined ? str(fields.unit, { field: "unit", max: 20 }) : current.unit,
    price: fields.price !== undefined ? roundMoney(num(fields.price, { field: "price", min: 0 }) ?? 0) : current.price,
    cost_price:
      fields.cost_price !== undefined
        ? roundMoney(num(fields.cost_price, { field: "cost_price", min: 0 }) ?? 0)
        : current.cost_price,
    tax_rate:
      fields.tax_rate !== undefined ? (num(fields.tax_rate, { field: "tax_rate", min: 0, max: 1 }) ?? 0) : current.tax_rate,
    track_inventory:
      fields.track_inventory !== undefined ? (bool(fields.track_inventory) ? 1 : 0) : current.track_inventory,
    attributes:
      fields.attributes !== undefined ? JSON.stringify(jsonObject(fields.attributes)) : JSON.stringify(current.attributes),
    tags: fields.tags !== undefined ? JSON.stringify(jsonArray(fields.tags).map(String)) : JSON.stringify(current.tags),
    image_url:
      fields.image_url !== undefined ? str(fields.image_url, { field: "image_url", max: 500 }) : current.image_url,
    is_active: fields.is_active !== undefined ? (bool(fields.is_active) ? 1 : 0) : current.is_active,
  };

  db.prepare(
    `UPDATE products SET
       name = ?, sku = ?, barcode = ?, category = ?, description = ?, unit = ?,
       price = ?, cost_price = ?, tax_rate = ?, track_inventory = ?, attributes = ?,
       tags = ?, image_url = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP
     WHERE business_id = ? AND id = ?`
  ).run(
    next.name, next.sku, next.barcode, next.category, next.description, next.unit,
    next.price, next.cost_price, next.tax_rate, next.track_inventory,
    next.attributes, next.tags, next.image_url, next.is_active,
    businessId, productId
  );

  syncPriceListEntry(businessId, productId);
  audit({ businessId, actor, action: "product.updated", details: { product_id: productId } });
  return getProduct(businessId, productId);
}

export function deleteProduct(businessId, productId, actor = "system") {
  const db = getDb();
  getProduct(businessId, productId);
  db.prepare(
    "UPDATE products SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE business_id = ? AND id = ?"
  ).run(businessId, productId);
  audit({ businessId, actor, action: "product.deleted", details: { product_id: productId } });
  return true;
}

export function createVariant(businessId, productId, fields, actor = "system") {
  const db = getDb();
  getProduct(businessId, productId);
  const name = str(fields.name, { field: "name", required: true, max: 120 });
  const price = roundMoney(num(fields.price, { field: "price", min: 0 }) ?? 0);

  const info = db
    .prepare(
      `INSERT INTO product_variants (business_id, product_id, name, sku, price, attributes)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      businessId,
      productId,
      name,
      str(fields.sku, { field: "sku", max: 80 }),
      price,
      JSON.stringify(jsonObject(fields.attributes))
    );

  audit({
    businessId,
    actor,
    action: "product.variant_created",
    details: { product_id: productId, variant_id: Number(info.lastInsertRowid) },
  });
  return listVariants(businessId, productId);
}

/**
 * Keeps the legacy `price_list` table in sync with the catalog so the
 * ChatCloser 1.x sales pages, CSV exports and the AI's price lookup keep
 * working unchanged.
 */
export function syncPriceListEntry(businessId, productId) {
  const db = getDb();
  const product = db
    .prepare("SELECT * FROM products WHERE business_id = ? AND id = ? AND deleted_at IS NULL")
    .get(businessId, productId);
  if (!product) return;

  const business = db.prepare("SELECT currency FROM businesses WHERE id = ?").get(businessId);
  const currency = business?.currency || "NPR";

  const existing = db
    .prepare("SELECT id FROM price_list WHERE business_id = ? AND product_id = ?")
    .get(businessId, productId);

  if (existing) {
    db.prepare(
      `UPDATE price_list SET item_name = ?, price_amount = ?, currency = ?, description = ?, tax_rate = ?
       WHERE id = ? AND business_id = ?`
    ).run(
      product.name,
      product.price,
      currency,
      product.description || "",
      product.tax_rate || 0,
      existing.id,
      businessId
    );
  } else {
    db.prepare(
      `INSERT INTO price_list (business_id, item_name, price_amount, currency, description, product_id, tax_rate)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      businessId,
      product.name,
      product.price,
      currency,
      product.description || "",
      productId,
      product.tax_rate || 0
    );
  }
}

/**
 * Resolves a free-text product name to a catalog entry.
 *
 * This is what the AI's `search_products` tool and `calculate_quote` tool
 * call. The match is exact-first, then case-insensitive, then fuzzy — but
 * the *price* always comes from the catalog row, never from the caller's
 * text.
 *
 * @returns {{product: object|null, matchedBy: string|null, candidates: object[]}}
 */
export function resolveProduct(businessId, query) {
  const text = str(query, { field: "query", max: 200 });
  if (!text) return { product: null, matchedBy: null, candidates: [] };

  const db = getDb();
  const base = "FROM products WHERE business_id = ? AND deleted_at IS NULL AND is_active = 1";

  const exact = db
    .prepare(`SELECT * ${base} AND LOWER(name) = LOWER(?) LIMIT 1`)
    .get(businessId, text);
  if (exact) return { product: mapProduct(exact), matchedBy: "exact", candidates: [] };

  const ci = db
    .prepare(`SELECT * ${base} AND LOWER(name) LIKE LOWER(?) ORDER BY LENGTH(name) LIMIT 1`)
    .get(businessId, `%${text}%`);
  if (ci) return { product: mapProduct(ci), matchedBy: "name_contains", candidates: [] };

  const bySku = db
    .prepare(`SELECT * ${base} AND LOWER(sku) = LOWER(?) LIMIT 1`)
    .get(businessId, text);
  if (bySku) return { product: mapProduct(bySku), matchedBy: "sku", candidates: [] };

  const byBarcode = db
    .prepare(`SELECT * ${base} AND barcode = ? LIMIT 1`)
    .get(businessId, text);
  if (byBarcode) return { product: mapProduct(byBarcode), matchedBy: "barcode", candidates: [] };

  // Loose match: every word of the query appears somewhere in the product
  // name, description or tags. Used for messages like "sari dress blue".
  const words = text.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  if (words.length > 0) {
    const candidates = db
      .prepare(
        `SELECT * ${base} AND (LOWER(name) LIKE ? OR LOWER(description) LIKE ? OR LOWER(tags) LIKE ?)
         ORDER BY LENGTH(name) LIMIT 5`
      )
      .all(businessId, ...words.map((w) => `%${w}%`))
      .map(mapProduct);

    const scored = candidates
      .map((p) => {
        const haystack = `${p.name} ${p.description} ${p.tags.join(" ")}`.toLowerCase();
        const hits = words.filter((w) => haystack.includes(w)).length;
        return { product: p, score: hits / words.length };
      })
      .filter((s) => s.score >= 0.6)
      .sort((a, b) => b.score - a.score);

    if (scored.length > 0) {
      return { product: scored[0].product, matchedBy: "fuzzy", candidates: scored.slice(1, 4).map((s) => s.product) };
    }
    if (candidates.length > 0) {
      return { product: null, matchedBy: null, candidates };
    }
  }

  return { product: null, matchedBy: null, candidates: [] };
}

export function listCategories(businessId) {
  const db = getDb();
  return db
    .prepare(
      `SELECT category, COUNT(*) AS count FROM products
       WHERE business_id = ? AND deleted_at IS NULL AND category <> ''
       GROUP BY category ORDER BY category`
    )
    .all(businessId);
}

function slugify(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}
