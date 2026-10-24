// src/core/validation.js
// Dependency-free input validation. Every request body, form field, tool
// argument and webhook payload passes through here before it reaches a
// service.

import { ValidationError } from "./errors.js";

export function str(value, { field = "value", required = false, max = 5000, min = 0, trim = true } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new ValidationError(`"${field}" is required.`, { field });
    return "";
  }
  if (typeof value !== "string" && typeof value !== "number") {
    throw new ValidationError(`"${field}" must be a string.`, { field });
  }
  let out = String(value);
  if (trim) out = out.trim();
  if (required && !out) throw new ValidationError(`"${field}" is required.`, { field });
  if (out.length < min) throw new ValidationError(`"${field}" must be at least ${min} characters.`, { field });
  if (out.length > max) throw new ValidationError(`"${field}" must be at most ${max} characters.`, { field });
  return out;
}

export function num(value, { field = "value", required = false, min = -Infinity, max = Infinity, integer = false } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) throw new ValidationError(`"${field}" is required.`, { field });
    return null;
  }
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) throw new ValidationError(`"${field}" must be a number.`, { field });
  if (integer && !Number.isInteger(n)) throw new ValidationError(`"${field}" must be a whole number.`, { field });
  if (n < min) throw new ValidationError(`"${field}" must be at least ${min}.`, { field });
  if (n > max) throw new ValidationError(`"${field}" must be at most ${max}.`, { field });
  return n;
}

export function bool(value, { field = "value" } = {}) {
  if (value === undefined || value === null || value === "") return false;
  if (typeof value === "boolean") return value;
  return /^(1|true|yes|on)$/i.test(String(value));
}

export function oneOf(value, allowed, { field = "value", required = false } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) throw new ValidationError(`"${field}" is required.`, { field, allowed });
    return null;
  }
  const v = String(value);
  if (!allowed.includes(v)) {
    throw new ValidationError(`"${field}" must be one of: ${allowed.join(", ")}.`, { field, allowed });
  }
  return v;
}

export function idList(value, { field = "value", max = 200 } = {}) {
  if (value === undefined || value === null) return [];
  const arr = Array.isArray(value) ? value : String(value).split(",");
  const cleaned = arr.map((v) => Number(v)).filter((v) => Number.isInteger(v) && v > 0);
  if (cleaned.length > max) throw new ValidationError(`"${field}" has too many entries.`, { field });
  return cleaned;
}

export function obj(value, { field = "value" } = {}) {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError(`"${field}" must be an object.`, { field });
  }
  return value;
}

export function jsonArray(value, fallback = []) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export function jsonObject(value, fallback = {}) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Very small JSON-Schema-ish validator used by the AI tool registry.
 * Supports the subset the tool schemas actually use: type, properties,
 * required, enum, minimum/maximum, minLength/maxLength, items.
 */
export function validateAgainstSchema(schema, value, path = "input") {
  const errors = [];
  if (!schema || typeof schema !== "object") return errors;

  const type = schema.type;
  if (type) {
    const types = Array.isArray(type) ? type : [type];
    const actual = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
    const ok = types.some((t) => {
      if (t === "integer") return Number.isInteger(value);
      if (t === "number") return typeof value === "number" && Number.isFinite(value);
      if (t === "object") return actual === "object";
      return actual === t;
    });
    if (!ok) {
      errors.push(`${path} must be of type ${types.join("|")} (got ${actual})`);
      return errors;
    }
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path} must be one of: ${schema.enum.join(", ")}`);
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path} must be at least ${schema.minLength} characters`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${path} must be at most ${schema.maxLength} characters`);
    }
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${path} must be >= ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${path} must be <= ${schema.maximum}`);
    }
  }

  if (Array.isArray(value) && schema.items) {
    value.forEach((item, i) => {
      errors.push(...validateAgainstSchema(schema.items, item, `${path}[${i}]`));
    });
  }

  if (value && typeof value === "object" && !Array.isArray(value) && schema.properties) {
    for (const key of schema.required || []) {
      if (value[key] === undefined || value[key] === null || value[key] === "") {
        errors.push(`${path}.${key} is required`);
      }
    }
    for (const [key, subSchema] of Object.entries(schema.properties)) {
      if (value[key] === undefined) continue;
      errors.push(...validateAgainstSchema(subSchema, value[key], `${path}.${key}`));
    }
  }

  return errors;
}
