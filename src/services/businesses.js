// src/services/businesses.js
// Business profile, workspace configuration, enabled modules and custom
// fields.
//
// Every function takes businessId as its first argument and every query is
// scoped by it. There is no code path that reads a business id from a
// request body, a query string or an AI tool argument — the business is
// always derived from the signed-in session.

import { getDb } from "../db/connection.js";
import { audit } from "../core/audit.js";
import { NotFoundError, ValidationError } from "../core/errors.js";
import { str, num, bool, jsonObject, jsonArray } from "../core/validation.js";

export function getBusinessConfig(businessId) {
  const db = getDb();
  const row = db.prepare("SELECT * FROM businesses WHERE id = ?").get(businessId);
  if (!row) throw new NotFoundError(`No business with id ${businessId}.`);
  return {
    ...row,
    knowledge_base: jsonObject(row.knowledge_base),
    escalation_keywords: jsonArray(row.escalation_keywords),
    modules_enabled: jsonArray(row.modules_enabled),
    settings: jsonObject(row.settings),
    business_hours: jsonObject(row.business_hours),
  };
}

const UPDATABLE = {
  name: (v) => str(v, { field: "name", required: true, max: 200 }),
  locale: (v) => str(v, { field: "locale", max: 20 }) || "en",
  country: (v) => str(v, { field: "country", max: 4 }) || "NP",
  timezone: (v) => str(v, { field: "timezone", max: 60 }) || "Asia/Kathmandu",
  currency: (v) => str(v, { field: "currency", max: 8 }) || "NPR",
  system_prompt_extra: (v) => str(v, { field: "system_prompt_extra", max: 20000 }),
  knowledge_base: (v) => jsonObject(v),
  escalation_keywords: (v) => jsonArray(v).map((k) => String(k).trim()).filter(Boolean),
  escalation_message: (v) => str(v, { field: "escalation_message", max: 2000 }),
  away_message: (v) => str(v, { field: "away_message", max: 2000 }),
  ai_disclosure: (v) => str(v, { field: "ai_disclosure", max: 500 }),
  business_hours: (v) => jsonObject(v),
  settings: (v) => jsonObject(v),
};

export function updateBusinessConfig(businessId, fields, actor = "system") {
  const db = getDb();
  const current = getBusinessConfig(businessId);

  const sets = [];
  const params = [];

  for (const [key, parser] of Object.entries(UPDATABLE)) {
    if (fields[key] === undefined) continue;
    sets.push(`${key} = ?`);
    params.push(parser(fields[key]));
  }

  if (fields.tax_enabled !== undefined) {
    sets.push("tax_enabled = ?");
    params.push(bool(fields.tax_enabled) ? 1 : 0);
  }
  if (fields.tax_rate !== undefined) {
    sets.push("tax_rate = ?");
    params.push(num(fields.tax_rate, { field: "tax_rate", min: 0, max: 1 }) ?? 0);
  }
  if (fields.tax_inclusive !== undefined) {
    sets.push("tax_inclusive = ?");
    params.push(bool(fields.tax_inclusive) ? 1 : 0);
  }
  if (fields.delivery_fee !== undefined) {
    sets.push("delivery_fee = ?");
    params.push(num(fields.delivery_fee, { field: "delivery_fee", min: 0 }) ?? 0);
  }
  if (fields.delivery_free_above !== undefined) {
    sets.push("delivery_free_above = ?");
    params.push(num(fields.delivery_free_above, { field: "delivery_free_above", min: 0 }) ?? 0);
  }
  if (fields.requires_order_confirmation !== undefined) {
    sets.push("requires_order_confirmation = ?");
    params.push(bool(fields.requires_order_confirmation) ? 1 : 0);
  }
  if (fields.ai_local_only !== undefined) {
    sets.push("ai_local_only = ?");
    params.push(bool(fields.ai_local_only) ? 1 : 0);
  }
  if (fields.ai_temperature !== undefined) {
    sets.push("ai_temperature = ?");
    params.push(num(fields.ai_temperature, { field: "ai_temperature", min: 0, max: 2 }) ?? 0.4);
  }
  if (fields.ai_max_tokens !== undefined) {
    sets.push("ai_max_tokens = ?");
    params.push(num(fields.ai_max_tokens, { field: "ai_max_tokens", min: 64, max: 8000, integer: true }) ?? 500);
  }
  if (fields.ai_local_base_url !== undefined) {
    sets.push("ai_local_base_url = ?");
    params.push(str(fields.ai_local_base_url, { field: "ai_local_base_url", max: 300 }));
  }
  if (fields.industry_template !== undefined) {
    sets.push("industry_template = ?");
    params.push(str(fields.industry_template, { field: "industry_template", max: 60 }));
  }

  if (sets.length === 0) return current;

  params.push(businessId);
  db.prepare(`UPDATE businesses SET ${sets.join(", ")} WHERE id = ?`).run(...params);

  audit({ businessId, actor, action: "business.settings_updated", details: { fields: Object.keys(fields) } });
  return getBusinessConfig(businessId);
}

// ---------- modules ----------

export function listModules(businessId) {
  const db = getDb();
  return db
    .prepare("SELECT * FROM business_modules WHERE business_id = ? ORDER BY position, id")
    .all(businessId)
    .map((m) => ({ ...m, settings: jsonObject(m.settings) }));
}

export function setModuleEnabled(businessId, moduleKey, enabled, actor = "system") {
  const db = getDb();
  const existing = db
    .prepare("SELECT id FROM business_modules WHERE business_id = ? AND module_key = ?")
    .get(businessId, moduleKey);
  if (existing) {
    db.prepare("UPDATE business_modules SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, existing.id);
  } else {
    db.prepare(
      "INSERT INTO business_modules (business_id, module_key, enabled) VALUES (?, ?, ?)"
    ).run(businessId, moduleKey, enabled ? 1 : 0);
  }
  audit({
    businessId,
    actor,
    action: "business.module_toggled",
    details: { module: moduleKey, enabled: Boolean(enabled) },
  });
  return listModules(businessId);
}

export function isModuleEnabled(businessId, moduleKey) {
  const db = getDb();
  const row = db
    .prepare("SELECT enabled FROM business_modules WHERE business_id = ? AND module_key = ?")
    .get(businessId, moduleKey);
  return row ? Boolean(row.enabled) : false;
}

// ---------- custom fields ----------

export function listCustomFields(businessId, entityType = null) {
  const db = getDb();
  const sql = entityType
    ? "SELECT * FROM custom_fields WHERE business_id = ? AND entity_type = ? ORDER BY position, id"
    : "SELECT * FROM custom_fields WHERE business_id = ? ORDER BY entity_type, position, id";
  const params = entityType ? [businessId, entityType] : [businessId];
  return db
    .prepare(sql)
    .all(...params)
    .map((f) => ({ ...f, options: jsonArray(f.options) }));
}

export function upsertCustomField(businessId, field, actor = "system") {
  const db = getDb();
  const key = str(field.field_key ?? field.key, { field: "field_key", required: true, max: 64 });
  const entityType = str(field.entity_type ?? "customer", { field: "entity_type", required: true, max: 40 });
  const label = str(field.label ?? key, { field: "label", required: true, max: 120 });
  const fieldType = str(field.field_type ?? field.type ?? "text", { field: "field_type", max: 40 });
  const options = jsonArray(field.options).map(String);
  const required = bool(field.required) ? 1 : 0;
  const appliesTo = jsonArray(field.applies_to_states).map(String);
  const position = num(field.position, { field: "position", min: 0 }) ?? 0;

  db.prepare(`
    INSERT INTO custom_fields
      (business_id, entity_type, field_key, label, field_type, options, required, applies_to_states, position)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(business_id, entity_type, field_key) DO UPDATE SET
      label = excluded.label,
      field_type = excluded.field_type,
      options = excluded.options,
      required = excluded.required,
      applies_to_states = excluded.applies_to_states,
      position = excluded.position,
      version = custom_fields.version + 1
  `).run(
    businessId,
    entityType,
    key,
    label,
    fieldType,
    JSON.stringify(options),
    required,
    JSON.stringify(appliesTo),
    position
  );

  audit({
    businessId,
    actor,
    action: "business.custom_field_saved",
    details: { entityType, key, version: "bumped" },
  });
  return listCustomFields(businessId, entityType);
}

export function deleteCustomField(businessId, fieldKey, entityType = "customer", actor = "system") {
  const db = getDb();
  db.prepare(
    "DELETE FROM custom_fields WHERE business_id = ? AND entity_type = ? AND field_key = ?"
  ).run(businessId, entityType, fieldKey);
  audit({
    businessId,
    actor,
    action: "business.custom_field_deleted",
    details: { entityType, fieldKey },
  });
  return listCustomFields(businessId, entityType);
}

/** Reads the stored values of custom fields for one record. */
export function getCustomFieldValues(businessId, entityType, entityId) {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT field_key, value FROM custom_field_values WHERE business_id = ? AND entity_type = ? AND entity_id = ?"
    )
    .all(businessId, entityType, entityId);
  const out = {};
  for (const row of rows) out[row.field_key] = row.value;
  return out;
}

/** Writes the stored values of custom fields for one record. */
export function setCustomFieldValues(businessId, entityType, entityId, values) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO custom_field_values (business_id, entity_type, entity_id, field_key, value, updated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(business_id, entity_type, entity_id, field_key) DO UPDATE SET
      value = excluded.value,
      updated_at = CURRENT_TIMESTAMP
  `);
  for (const [key, value] of Object.entries(values || {})) {
    stmt.run(businessId, entityType, entityId, key, String(value ?? ""));
  }
  return getCustomFieldValues(businessId, entityType, entityId);
}

/**
 * Validates a payload against the business' custom field definitions.
 * @returns {{values: object, errors: Array<{field:string,message:string}>}}
 */
export function validateCustomFields(businessId, entityType, payload) {
  const definitions = listCustomFields(businessId, entityType);
  const values = {};
  const errors = [];

  for (const def of definitions) {
    const raw = payload?.[def.field_key];
    const value = raw === undefined || raw === null ? "" : String(raw);

    if (def.required && !value) {
      errors.push({ field: def.field_key, message: `${def.label} is required` });
    }
    if (value && def.options.length && !def.options.includes(value)) {
      errors.push({
        field: def.field_key,
        message: `${def.label} must be one of: ${def.options.join(", ")}`,
      });
    }
    if (value) values[def.field_key] = value;
  }

  return { values, errors };
}
