// src/core/rbac.js
// Role-based access control.
//
// Permissions are checked on the server for every privileged action. The
// dashboard hides links the signed-in user cannot use, but hiding a link is
// never the enforcement point — every route and every service call checks
// the permission again.
//
// A user may hold a role (a named bundle) plus explicit per-permission
// overrides, which lets a business give one person access to exactly one
// extra area without inventing a new role.

export const PERMISSIONS = {
  DASHBOARD_VIEW: "dashboard.view",

  LEADS_VIEW: "leads.view",
  LEADS_EDIT: "leads.edit",

  CONVERSATIONS_VIEW: "conversations.view",
  CONVERSATIONS_REPLY: "conversations.reply",
  CONVERSATIONS_TAKEOVER: "conversations.takeover",

  CUSTOMERS_VIEW: "customers.view",
  CUSTOMERS_EDIT: "customers.edit",
  CUSTOMERS_EXPORT: "customers.export",
  CUSTOMERS_DELETE: "customers.delete",

  CATALOG_VIEW: "catalog.view",
  CATALOG_EDIT: "catalog.edit",

  INVENTORY_VIEW: "inventory.view",
  INVENTORY_EDIT: "inventory.edit",

  ORDERS_VIEW: "orders.view",
  ORDERS_CREATE: "orders.create",
  ORDERS_EDIT: "orders.edit",
  ORDERS_CANCEL: "orders.cancel",

  BOOKINGS_VIEW: "bookings.view",
  BOOKINGS_EDIT: "bookings.edit",

  QUOTES_VIEW: "quotes.view",
  QUOTES_EDIT: "quotes.edit",

  INVOICES_VIEW: "invoices.view",
  INVOICES_EDIT: "invoices.edit",

  PAYMENTS_VIEW: "payments.view",
  PAYMENTS_MANAGE: "payments.manage",
  PAYMENTS_REFUND: "payments.refund",

  REPORTS_VIEW: "reports.view",

  AI_VIEW: "ai.view",
  AI_EDIT: "ai.edit",

  KNOWLEDGE_VIEW: "knowledge.view",
  KNOWLEDGE_EDIT: "knowledge.edit",

  WORKFLOWS_VIEW: "workflows.view",
  WORKFLOWS_EDIT: "workflows.edit",

  INTEGRATIONS_VIEW: "integrations.view",
  INTEGRATIONS_EDIT: "integrations.edit",

  TEAM_VIEW: "team.view",
  TEAM_EDIT: "team.edit",

  SETTINGS_VIEW: "settings.view",
  SETTINGS_EDIT: "settings.edit",

  AUDIT_VIEW: "audit.view",

  BACKUPS_VIEW: "backups.view",
  BACKUPS_MANAGE: "backups.manage",
};

export const ALL_PERMISSIONS = Object.values(PERMISSIONS);

/**
 * Built-in role bundles. "owner" is deliberately separate from the list of
 * individual permissions: an owner always has everything, even features
 * added after this file was written.
 */
export const ROLE_PERMISSIONS = {
  owner: ALL_PERMISSIONS,
  manager: [
    PERMISSIONS.DASHBOARD_VIEW,
    PERMISSIONS.LEADS_VIEW,
    PERMISSIONS.LEADS_EDIT,
    PERMISSIONS.CONVERSATIONS_VIEW,
    PERMISSIONS.CONVERSATIONS_REPLY,
    PERMISSIONS.CONVERSATIONS_TAKEOVER,
    PERMISSIONS.CUSTOMERS_VIEW,
    PERMISSIONS.CUSTOMERS_EDIT,
    PERMISSIONS.CATALOG_VIEW,
    PERMISSIONS.INVENTORY_VIEW,
    PERMISSIONS.ORDERS_VIEW,
    PERMISSIONS.ORDERS_CREATE,
    PERMISSIONS.ORDERS_EDIT,
    PERMISSIONS.ORDERS_CANCEL,
    PERMISSIONS.BOOKINGS_VIEW,
    PERMISSIONS.BOOKINGS_EDIT,
    PERMISSIONS.QUOTES_VIEW,
    PERMISSIONS.QUOTES_EDIT,
    PERMISSIONS.INVOICES_VIEW,
    PERMISSIONS.PAYMENTS_VIEW,
    PERMISSIONS.REPORTS_VIEW,
    PERMISSIONS.AI_VIEW,
    PERMISSIONS.KNOWLEDGE_VIEW,
    PERMISSIONS.WORKFLOWS_VIEW,
    PERMISSIONS.INTEGRATIONS_VIEW,
    PERMISSIONS.TEAM_VIEW,
    PERMISSIONS.SETTINGS_VIEW,
  ],
  staff: [
    PERMISSIONS.DASHBOARD_VIEW,
    PERMISSIONS.LEADS_VIEW,
    PERMISSIONS.LEADS_EDIT,
    PERMISSIONS.CONVERSATIONS_VIEW,
    PERMISSIONS.CONVERSATIONS_REPLY,
    PERMISSIONS.CUSTOMERS_VIEW,
    PERMISSIONS.ORDERS_VIEW,
    PERMISSIONS.BOOKINGS_VIEW,
    PERMISSIONS.CATALOG_VIEW,
    PERMISSIONS.INVENTORY_VIEW,
    PERMISSIONS.QUOTES_VIEW,
    PERMISSIONS.INVOICES_VIEW,
    PERMISSIONS.KNOWLEDGE_VIEW,
  ],
  accountant: [
    PERMISSIONS.DASHBOARD_VIEW,
    PERMISSIONS.CUSTOMERS_VIEW,
    PERMISSIONS.CUSTOMERS_EXPORT,
    PERMISSIONS.ORDERS_VIEW,
    PERMISSIONS.INVOICES_VIEW,
    PERMISSIONS.INVOICES_EDIT,
    PERMISSIONS.PAYMENTS_VIEW,
    PERMISSIONS.PAYMENTS_MANAGE,
    PERMISSIONS.PAYMENTS_REFUND,
    PERMISSIONS.REPORTS_VIEW,
    PERMISSIONS.QUOTES_VIEW,
  ],
  viewer: [
    PERMISSIONS.DASHBOARD_VIEW,
    PERMISSIONS.LEADS_VIEW,
    PERMISSIONS.CONVERSATIONS_VIEW,
    PERMISSIONS.CUSTOMERS_VIEW,
    PERMISSIONS.CATALOG_VIEW,
    PERMISSIONS.ORDERS_VIEW,
    PERMISSIONS.BOOKINGS_VIEW,
    PERMISSIONS.QUOTES_VIEW,
    PERMISSIONS.INVOICES_VIEW,
    PERMISSIONS.PAYMENTS_VIEW,
    PERMISSIONS.REPORTS_VIEW,
  ],
};

export const BUILT_IN_ROLES = Object.keys(ROLE_PERMISSIONS);

/**
 * Resolves the effective permission set for a user record.
 * @param {{role?:string, permissions?:object|string}} user
 * @returns {Set<string>}
 */
export function resolvePermissions(user) {
  const role = String(user?.role || "staff").toLowerCase();
  const base = ROLE_PERMISSIONS[role] || ROLE_PERMISSIONS.staff;

  let overrides = {};
  const raw = user?.permissions;
  if (raw && typeof raw === "object") {
    overrides = raw;
  } else if (typeof raw === "string" && raw.trim()) {
    try {
      overrides = JSON.parse(raw);
    } catch {
      overrides = {};
    }
  }

  const result = new Set(base);
  for (const [key, value] of Object.entries(overrides)) {
    if (value === true) result.add(key);
    else if (value === false) result.delete(key);
  }
  return result;
}

/** True when the user holds the permission. */
export function can(user, permission) {
  if (!user) return false;
  if (String(user.role || "").toLowerCase() === "owner") return true;
  return resolvePermissions(user).has(permission);
}

/** True when the user holds at least one of the listed permissions. */
export function canAny(user, permissions) {
  return (permissions || []).some((p) => can(user, p));
}
