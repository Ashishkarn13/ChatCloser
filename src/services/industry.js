// src/services/industry.js
// Industry templates.
//
// A template is *data*: which modules a business starts with, which custom
// fields its customers/orders carry, the order states it uses, and the
// pricing/document defaults. Templates never contain code, so a business
// can copy, trim or extend one safely.
//
// The platform itself is one application: an industry is a configuration of
// the same shared core, not a separate build.

import { getDb } from "../db/connection.js";
import { audit } from "../core/audit.js";

export const MODULES = {
  OVERVIEW: "overview",
  COMMAND_CENTER: "command_center",
  INBOX: "inbox",
  CRM: "crm",
  ORDERS: "orders",
  CATALOG: "catalog",
  INVENTORY: "inventory",
  QUOTATIONS: "quotations",
  INVOICES: "invoices",
  PAYMENTS: "payments",
  CUSTOMERS: "customers",
  WORKFLOWS: "workflows",
  REPORTS: "reports",
  AI_CONFIG: "ai_config",
  INTEGRATIONS: "integrations",
  TEAM: "team",
  SECURITY: "security",
  SETTINGS: "settings",
};

const baseFields = [
  { key: "full_name", label: "Full name", type: "text", required: true },
  { key: "phone", label: "Phone number", type: "phone", required: true },
  { key: "province", label: "Province", type: "text", required: false },
  { key: "district", label: "District", type: "text", required: false },
  { key: "municipality", label: "Municipality / Rural Municipality", type: "text", required: false },
  { key: "ward", label: "Ward number", type: "text", required: false },
  { key: "locality", label: "Locality / tole", type: "text", required: false },
];

export const TEMPLATES = [
  {
    key: "retail",
    name: "Retail & Wholesale",
    description: "Counter sales and bulk wholesale. Track stock, issue receipts, follow up on bulk enquiries.",
    category: "sales",
    modules: [
      MODULES.OVERVIEW, MODULES.INBOX, MODULES.CRM, MODULES.ORDERS, MODULES.CATALOG,
      MODULES.INVENTORY, MODULES.QUOTATIONS, MODULES.INVOICES, MODULES.PAYMENTS,
      MODULES.CUSTOMERS, MODULES.REPORTS,
    ],
    fields: baseFields,
    orderStates: ["draft", "awaiting_confirmation", "confirmed", "processing", "dispatched", "delivered", "cancelled"],
    orderRequiredFields: ["customer", "items", "delivery_address"],
    pricingRules: { taxRate: 0, taxInclusive: true, deliveryFee: 0 },
    documentTemplates: { invoice: "standard", quotation: "standard" },
    defaultTaxRate: 0,
    defaultCurrency: "NPR",
  },
  {
    key: "ecommerce",
    name: "E-commerce & Social Commerce",
    description: "Catalogue-driven selling from Instagram, Facebook and the website, with courier handover.",
    category: "sales",
    modules: [
      MODULES.OVERVIEW, MODULES.INBOX, MODULES.CRM, MODULES.ORDERS, MODULES.CATALOG,
      MODULES.INVENTORY, MODULES.QUOTATIONS, MODULES.INVOICES, MODULES.PAYMENTS,
      MODULES.CUSTOMERS, MODULES.REPORTS, MODULES.WORKFLOWS,
    ],
    fields: baseFields,
    orderStates: ["draft", "awaiting_confirmation", "confirmed", "processing", "dispatched", "delivered", "cancelled"],
    orderRequiredFields: ["customer", "items", "delivery_address"],
    pricingRules: { taxRate: 0.13, taxInclusive: true, deliveryFee: 100, deliveryFreeAbove: 5000 },
    documentTemplates: { invoice: "standard", quotation: "standard" },
    defaultTaxRate: 0.13,
    defaultCurrency: "NPR",
  },
  {
    key: "restaurant",
    name: "Restaurants, Cafés & Food Delivery",
    description: "Table bookings, takeaway orders and delivery with kitchen-style order states.",
    category: "food",
    modules: [
      MODULES.OVERVIEW, MODULES.INBOX, MODULES.CRM, MODULES.ORDERS, MODULES.CATALOG,
      MODULES.BOOKINGS, MODULES.INVOICES, MODULES.PAYMENTS, MODULES.CUSTOMERS, MODULES.REPORTS,
    ],
    fields: [
      ...baseFields,
      { key: "table_or_delivery", label: "Table number or delivery", type: "text", required: false },
      { key: "delivery_slot", label: "Preferred delivery slot", type: "text", required: false },
    ],
    orderStates: ["draft", "awaiting_confirmation", "confirmed", "preparing", "ready", "dispatched", "delivered", "cancelled"],
    orderRequiredFields: ["customer", "items"],
    pricingRules: { taxRate: 0.1, taxInclusive: true, deliveryFee: 50, deliveryFreeAbove: 2000 },
    documentTemplates: { invoice: "receipt" },
    defaultTaxRate: 0.1,
    defaultCurrency: "NPR",
  },
  {
    key: "construction",
    name: "Construction & Building Materials",
    description: "Enquiries, site visits, material quotations and milestone-based project orders.",
    category: "trades",
    modules: [
      MODULES.OVERVIEW, MODULES.INBOX, MODULES.CRM, MODULES.ORDERS, MODULES.CATALOG,
      MODULES.INVENTORY, MODULES.QUOTATIONS, MODULES.INVOICES, MODULES.PAYMENTS,
      MODULES.CUSTOMERS, MODULES.BOOKINGS, MODULES.REPORTS,
    ],
    fields: [
      ...baseFields,
      { key: "site_address", label: "Site address", type: "textarea", required: false },
      { key: "site_area", label: "Site area (sq. ft / ropani)", type: "text", required: false },
      { key: "scope_of_work", label: "Scope of work", type: "textarea", required: false },
    ],
    orderStates: ["draft", "awaiting_confirmation", "confirmed", "site_visit", "quoted", "processing", "dispatched", "delivered", "cancelled"],
    orderRequiredFields: ["customer", "items"],
    pricingRules: { taxRate: 0.13, taxInclusive: false, deliveryFee: 0 },
    documentTemplates: { invoice: "standard", quotation: "construction" },
    defaultTaxRate: 0.13,
    defaultCurrency: "NPR",
  },
  {
    key: "realestate",
    name: "Real Estate & Property Services",
    description: "Property listings, viewing appointments and brokerage quotations.",
    category: "trades",
    modules: [
      MODULES.OVERVIEW, MODULES.INBOX, MODULES.CRM, MODULES.ORDERS, MODULES.BOOKINGS,
      MODULES.QUOTATIONS, MODULES.INVOICES, MODULES.PAYMENTS, MODULES.CUSTOMERS, MODULES.REPORTS,
    ],
    fields: [
      ...baseFields,
      { key: "property_type", label: "Property type", type: "text", required: false },
      { key: "budget", label: "Budget (NPR)", type: "number", required: false },
      { key: "preferred_area", label: "Preferred area", type: "text", required: false },
    ],
    orderStates: ["draft", "awaiting_confirmation", "confirmed", "viewing_scheduled", "negotiation", "closed", "cancelled"],
    orderRequiredFields: ["customer"],
    pricingRules: { taxRate: 0, taxInclusive: true, deliveryFee: 0 },
    documentTemplates: { quotation: "realestate" },
    defaultTaxRate: 0,
    defaultCurrency: "NPR",
  },
  {
    key: "travel",
    name: "Travel & Tourism",
    description: "Trip enquiries, package quotations, bookings and payments.",
    category: "services",
    modules: [
      MODULES.OVERVIEW, MODULES.INBOX, MODULES.CRM, MODULES.ORDERS, MODULES.BOOKINGS,
      MODULES.QUOTATIONS, MODULES.INVOICES, MODULES.PAYMENTS, MODULES.CUSTOMERS, MODULES.REPORTS,
    ],
    fields: [
      ...baseFields,
      { key: "destination", label: "Destination", type: "text", required: false },
      { key: "travel_date", label: "Travel date", type: "date", required: false },
      { key: "travellers", label: "Number of travellers", type: "number", required: false },
    ],
    orderStates: ["draft", "awaiting_confirmation", "confirmed", "booked", "completed", "cancelled"],
    orderRequiredFields: ["customer", "items"],
    pricingRules: { taxRate: 0, taxInclusive: true, deliveryFee: 0 },
    documentTemplates: { invoice: "standard", quotation: "travel" },
    defaultTaxRate: 0,
    defaultCurrency: "NPR",
  },
  {
    key: "hospitality",
    name: "Hotels & Hospitality",
    description: "Room reservations, guest records, front-desk handover and invoices.",
    category: "services",
    modules: [
      MODULES.OVERVIEW, MODULES.INBOX, MODULES.CRM, MODULES.ORDERS, MODULES.BOOKINGS,
      MODULES.INVENTORY, MODULES.INVOICES, MODULES.PAYMENTS, MODULES.CUSTOMERS, MODULES.REPORTS,
    ],
    fields: [
      ...baseFields,
      { key: "guests", label: "Number of guests", type: "number", required: false },
      { key: "check_in", label: "Check-in date", type: "date", required: false },
      { key: "check_out", label: "Check-out date", type: "date", required: false },
    ],
    orderStates: ["draft", "awaiting_confirmation", "confirmed", "checked_in", "checked_out", "cancelled"],
    orderRequiredFields: ["customer", "items"],
    pricingRules: { taxRate: 0, taxInclusive: true, deliveryFee: 0 },
    documentTemplates: { invoice: "hotel" },
    defaultTaxRate: 0,
    defaultCurrency: "NPR",
  },
  {
    key: "professional",
    name: "Professional Services & Agencies",
    description: "Scope-based engagements, retainers, milestones and invoices.",
    category: "services",
    modules: [
      MODULES.OVERVIEW, MODULES.INBOX, MODULES.CRM, MODULES.ORDERS, MODULES.CATALOG,
      MODULES.QUOTATIONS, MODULES.INVOICES, MODULES.PAYMENTS, MODULES.CUSTOMERS,
      MODULES.BOOKINGS, MODULES.REPORTS,
    ],
    fields: [
      ...baseFields,
      { key: "company_name", label: "Company", type: "text", required: false },
      { key: "service_needed", label: "Service needed", type: "text", required: false },
    ],
    orderStates: ["draft", "awaiting_confirmation", "confirmed", "in_progress", "delivered", "cancelled"],
    orderRequiredFields: ["customer", "items"],
    pricingRules: { taxRate: 0.13, taxInclusive: false, deliveryFee: 0 },
    documentTemplates: { invoice: "standard", quotation: "services" },
    defaultTaxRate: 0.13,
    defaultCurrency: "NPR",
  },
  {
    key: "education",
    name: "Education & Training",
    description: "Course enquiries, admissions, batch scheduling and fee collection.",
    category: "services",
    modules: [
      MODULES.OVERVIEW, MODULES.INBOX, MODULES.CRM, MODULES.ORDERS, MODULES.BOOKINGS,
      MODULES.CATALOG, MODULES.INVOICES, MODULES.PAYMENTS, MODULES.CUSTOMERS, MODULES.REPORTS,
    ],
    fields: [
      ...baseFields,
      { key: "course", label: "Course of interest", type: "text", required: false },
      { key: "student_grade", label: "Current grade / level", type: "text", required: false },
    ],
    orderStates: ["draft", "awaiting_confirmation", "confirmed", "enrolled", "completed", "cancelled"],
    orderRequiredFields: ["customer", "items"],
    pricingRules: { taxRate: 0, taxInclusive: true, deliveryFee: 0 },
    documentTemplates: { invoice: "standard", quotation: "education" },
    defaultTaxRate: 0,
    defaultCurrency: "NPR",
  },
  {
    key: "clinic",
    name: "Clinics & Appointment Services",
    description: "Appointment booking, patient records, follow-ups and billing.",
    category: "services",
    modules: [
      MODULES.OVERVIEW, MODULES.INBOX, MODULES.CRM, MODULES.BOOKINGS, MODULES.ORDERS,
      MODULES.INVOICES, MODULES.PAYMENTS, MODULES.CUSTOMERS, MODULES.REPORTS,
    ],
    fields: [
      ...baseFields,
      { key: "appointment_type", label: "Appointment type", type: "text", required: false },
      { key: "preferred_slot", label: "Preferred slot", type: "text", required: false },
      { key: "notes", label: "Notes for the practitioner", type: "textarea", required: false },
    ],
    orderStates: ["draft", "awaiting_confirmation", "confirmed", "scheduled", "completed", "cancelled"],
    orderRequiredFields: ["customer"],
    pricingRules: { taxRate: 0, taxInclusive: true, deliveryFee: 0 },
    documentTemplates: { invoice: "clinic" },
    defaultTaxRate: 0,
    defaultCurrency: "NPR",
  },
  {
    key: "salon",
    name: "Salons & Personal Services",
    description: "Appointment slots, stylist assignments, package deals and receipts.",
    category: "services",
    modules: [
      MODULES.OVERVIEW, MODULES.INBOX, MODULES.CRM, MODULES.ORDERS, MODULES.BOOKINGS,
      MODULES.CATALOG, MODULES.INVOICES, MODULES.PAYMENTS, MODULES.CUSTOMERS, MODULES.REPORTS,
    ],
    fields: [
      ...baseFields,
      { key: "service_type", label: "Service", type: "text", required: false },
      { key: "preferred_stylist", label: "Preferred stylist / room", type: "text", required: false },
    ],
    orderStates: ["draft", "awaiting_confirmation", "confirmed", "scheduled", "in_service", "completed", "cancelled"],
    orderRequiredFields: ["customer", "items"],
    pricingRules: { taxRate: 0, taxInclusive: true, deliveryFee: 0 },
    documentTemplates: { invoice: "receipt" },
    defaultTaxRate: 0,
    defaultCurrency: "NPR",
  },
  {
    key: "repair",
    name: "Repair & Maintenance",
    description: "Job tickets, device/asset records, spare parts and service invoices.",
    category: "trades",
    modules: [
      MODULES.OVERVIEW, MODULES.INBOX, MODULES.CRM, MODULES.ORDERS, MODULES.CATALOG,
      MODULES.INVENTORY, MODULES.INVOICES, MODULES.PAYMENTS, MODULES.CUSTOMERS,
      MODULES.BOOKINGS, MODULES.REPORTS,
    ],
    fields: [
      ...baseFields,
      { key: "device_or_asset", label: "Device / asset", type: "text", required: false },
      { key: "fault_description", label: "Fault description", type: "textarea", required: false },
      { key: "serial_number", label: "Serial / IMEI", type: "text", required: false },
    ],
    orderStates: ["draft", "awaiting_confirmation", "confirmed", "diagnosing", "in_repair", "ready", "delivered", "cancelled"],
    orderRequiredFields: ["customer", "items"],
    pricingRules: { taxRate: 0.13, taxInclusive: false, deliveryFee: 0 },
    documentTemplates: { invoice: "standard", quotation: "repair" },
    defaultTaxRate: 0.13,
    defaultCurrency: "NPR",
  },
  {
    key: "manufacturing",
    name: "Manufacturing & Distribution",
    description: "B2B orders, production batches, wholesale pricing and dealer credit.",
    category: "trades",
    modules: [
      MODULES.OVERVIEW, MODULES.INBOX, MODULES.CRM, MODULES.ORDERS, MODULES.CATALOG,
      MODULES.INVENTORY, MODULES.QUOTATIONS, MODULES.INVOICES, MODULES.PAYMENTS,
      MODULES.CUSTOMERS, MODULES.REPORTS, MODULES.WORKFLOWS,
    ],
    fields: [
      ...baseFields,
      { key: "company_name", label: "Company / dealer", type: "text", required: false },
      { key: "batch_or_lot", label: "Batch / lot number", type: "text", required: false },
    ],
    orderStates: ["draft", "awaiting_confirmation", "confirmed", "in_production", "processing", "dispatched", "delivered", "cancelled"],
    orderRequiredFields: ["customer", "items"],
    pricingRules: { taxRate: 0.13, taxInclusive: false, deliveryFee: 0 },
    documentTemplates: { invoice: "standard", quotation: "b2b" },
    defaultTaxRate: 0.13,
    defaultCurrency: "NPR",
  },
  {
    key: "agriculture",
    name: "Agriculture & Agricultural Supplies",
    description: "Seasonal inputs, seed and fertiliser sales, farm delivery and dealer credit.",
    category: "trades",
    modules: [
      MODULES.OVERVIEW, MODULES.INBOX, MODULES.CRM, MODULES.ORDERS, MODULES.CATALOG,
      MODULES.INVENTORY, MODULES.QUOTATIONS, MODULES.INVOICES, MODULES.PAYMENTS,
      MODULES.CUSTOMERS, MODULES.REPORTS,
    ],
    fields: [
      ...baseFields,
      { key: "farm_area", label: "Farm area", type: "text", required: false },
      { key: "crop", label: "Crop", type: "text", required: false },
      { key: "season", label: "Season", type: "text", required: false },
    ],
    orderStates: ["draft", "awaiting_confirmation", "confirmed", "processing", "dispatched", "delivered", "cancelled"],
    orderRequiredFields: ["customer", "items"],
    pricingRules: { taxRate: 0, taxInclusive: true, deliveryFee: 500, deliveryFreeAbove: 10000 },
    documentTemplates: { invoice: "standard", quotation: "standard" },
    defaultTaxRate: 0,
    defaultCurrency: "NPR",
  },
  {
    key: "custom",
    name: "Custom Business Workflows",
    description: "Start from the shared core and configure the fields, states and modules you need.",
    category: "general",
    modules: [
      MODULES.OVERVIEW, MODULES.INBOX, MODULES.CRM, MODULES.ORDERS, MODULES.CATALOG,
      MODULES.QUOTATIONS, MODULES.INVOICES, MODULES.PAYMENTS, MODULES.CUSTOMERS, MODULES.REPORTS,
    ],
    fields: baseFields,
    orderStates: ["draft", "awaiting_confirmation", "confirmed", "processing", "delivered", "cancelled"],
    orderRequiredFields: ["customer"],
    pricingRules: { taxRate: 0, taxInclusive: true, deliveryFee: 0 },
    documentTemplates: {},
    defaultTaxRate: 0,
    defaultCurrency: "NPR",
  },
];

/** Writes the built-in templates into the database (idempotent). */
export function syncTemplates() {
  const db = getDb();
  const upsert = db.prepare(`
    INSERT INTO industry_templates
      (key, name, description, category, modules, fields, order_states, order_required_fields,
       pricing_rules, document_templates, default_tax_rate, default_currency)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      category = excluded.category,
      modules = excluded.modules,
      fields = excluded.fields,
      order_states = excluded.order_states,
      order_required_fields = excluded.order_required_fields,
      pricing_rules = excluded.pricing_rules,
      document_templates = excluded.document_templates,
      default_tax_rate = excluded.default_tax_rate,
      default_currency = excluded.default_currency
  `);

  for (const t of TEMPLATES) {
    upsert.run(
      t.key,
      t.name,
      t.description,
      t.category,
      JSON.stringify(t.modules),
      JSON.stringify(t.fields),
      JSON.stringify(t.orderStates),
      JSON.stringify(t.orderRequiredFields),
      JSON.stringify(t.pricingRules),
      JSON.stringify(t.documentTemplates),
      t.defaultTaxRate,
      t.defaultCurrency
    );
  }
}

export function listTemplates() {
  const db = getDb();
  return db
    .prepare("SELECT key, name, description, category FROM industry_templates ORDER BY category, name")
    .all();
}

export function getTemplate(key) {
  const db = getDb();
  const row = db.prepare("SELECT * FROM industry_templates WHERE key = ?").get(key);
  if (!row) return null;
  return {
    ...row,
    modules: JSON.parse(row.modules || "[]"),
    fields: JSON.parse(row.fields || "[]"),
    order_states: JSON.parse(row.order_states || "[]"),
    order_required_fields: JSON.parse(row.order_required_fields || "[]"),
    pricing_rules: JSON.parse(row.pricing_rules || "{}"),
    document_templates: JSON.parse(row.document_templates || "{}"),
  };
}

/**
 * Applies a template to a business: enables the template's modules, creates
 * the template's custom fields and seeds the pricing defaults. Existing
 * records are never modified or deleted — modules that the business has
 * disabled stay disabled unless the template explicitly turns them on.
 */
export function applyTemplate(businessId, templateKey, actor = "system") {
  const template = getTemplate(templateKey);
  if (!template) throw new Error(`Unknown industry template: ${templateKey}`);

  const db = getDb();

  const upsertModule = db.prepare(`
    INSERT INTO business_modules (business_id, module_key, enabled, settings, position)
    VALUES (?, ?, 1, '{}', ?)
    ON CONFLICT(business_id, module_key) DO UPDATE SET enabled = 1
  `);
  template.modules.forEach((moduleKey, index) => {
    upsertModule.run(businessId, moduleKey, index);
  });

  const insertField = db.prepare(`
    INSERT INTO custom_fields (business_id, entity_type, field_key, label, field_type, options, required, position)
    VALUES (?, 'customer', ?, ?, ?, '[]', ?, ?)
    ON CONFLICT(business_id, entity_type, field_key) DO UPDATE SET
      label = excluded.label,
      field_type = excluded.field_type,
      required = excluded.required,
      position = excluded.position,
      version = custom_fields.version + 1
  `);
  template.fields.forEach((field, index) => {
    insertField.run(
      businessId,
      field.key,
      field.label,
      field.type || "text",
      field.required ? 1 : 0,
      index
    );
  });

  db.prepare(
    `UPDATE businesses SET
       industry_template = ?,
       tax_rate = ?,
       tax_enabled = ?,
       tax_inclusive = ?,
       delivery_fee = ?,
       delivery_free_above = ?,
       currency = ?
     WHERE id = ?`
  ).run(
    template.key,
    template.default_taxRate,
    template.default_taxRate > 0 ? 1 : 0,
    template.pricing_rules.taxInclusive ? 1 : 0,
    template.pricing_rules.deliveryFee || 0,
    template.pricing_rules.deliveryFreeAbove || 0,
    template.defaultCurrency || "NPR",
    businessId
  );

  audit({
    businessId,
    actor,
    action: "business.template_applied",
    details: { template: template.key, modules: template.modules.length },
  });

  return template;
}
