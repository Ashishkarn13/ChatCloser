// src/server/routes/api.js
// The JSON API for the ChatCloser 2.0 modules.
//
// Every route resolves the business from the session (never from the
// request body or query string) and checks the signed-in user's
// permissions before touching anything.

import express from "express";
import { asyncHandler } from "../app.js";
import { PERMISSIONS, resolvePermissions } from "../../core/rbac.js";
import { AppError } from "../../core/errors.js";
import * as businesses from "../../services/businesses.js";
import * as customers from "../../services/customers.js";
import * as catalog from "../../services/catalog.js";
import * as inventory from "../../services/inventory.js";
import * as orders from "../../services/orders.js";
import * as bookings from "../../services/bookings.js";
import * as quotations from "../../services/quotations.js";
import * as conversations from "../../services/conversations.js";
import * as tasks from "../../services/tasks.js";
import * as workflows from "../../services/workflows.js";
import * as reports from "../../services/reports.js";
import * as knowledge from "../../services/knowledge.js";
import * as payments from "../../services/payments/index.js";
import * as industry from "../../services/industry.js";
import { listToolsForBusiness, setToolPermission, listApprovals, decideApproval, TOOL_DEFINITIONS } from "../../services/ai/tools/index.js";
import { testModel, localRuntimeHealth } from "../../services/ai/model-adapter.js";
import { backupDatabase, listBackups, restoreBackup } from "../../services/backups.js";
import { listNotifications, markNotificationRead } from "../../services/notifications.js";

export function createApiRouter() {
  const router = express.Router();

  const businessId = (req) => req.session.businessId ?? req.user.businessId;
  const require = (permission) => (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Sign in required." });
    if (hasPermission(req.user, permission)) return next();
    return res.status(403).json({ error: `You do not have the "${permission}" permission.` });
  };

  // ---------- overview & reports ----------

  router.get(
    "/overview",
    require(PERMISSIONS.DASHBOARD_VIEW),
    asyncHandler(async (req, res) => {
      res.json(reports.overview(businessId(req)));
    })
  );

  router.get(
    "/reports/revenue",
    require(PERMISSIONS.REPORTS_VIEW),
    asyncHandler(async (req, res) => {
      res.json(reports.revenueTrend(businessId(req), Number(req.query.days) || 30));
    })
  );

  router.get(
    "/reports/revenue-by-product",
    require(PERMISSIONS.REPORTS_VIEW),
    asyncHandler(async (req, res) => {
      res.json(reports.revenueByProduct(businessId(req)));
    })
  );

  router.get(
    "/reports/leads",
    require(PERMISSIONS.REPORTS_VIEW),
    asyncHandler(async (req, res) => {
      res.json(reports.leadFunnel(businessId(req)));
    })
  );

  router.get(
    "/reports/ai-usage",
    require(PERMISSIONS.REPORTS_VIEW),
    asyncHandler(async (req, res) => {
      res.json(reports.aiUsage(businessId(req), { days: Number(req.query.days) || 30 }));
    })
  );

  router.get(
    "/reports/accounting",
    require(PERMISSIONS.REPORTS_VIEW),
    asyncHandler(async (req, res) => {
      res.json(reports.accountingSummary(businessId(req), { from: req.query.from, to: req.query.to }));
    })
  );

  router.get(
    "/reports/forecast",
    require(PERMISSIONS.REPORTS_VIEW),
    asyncHandler(async (req, res) => {
      res.json(reports.demandForecast(businessId(req)));
    })
  );

  router.get(
    "/reports/inventory",
    require(PERMISSIONS.REPORTS_VIEW),
    asyncHandler(async (req, res) => {
      res.json(reports.inventoryRisk(businessId(req)));
    })
  );

  // ---------- business configuration ----------

  router.get(
    "/business",
    require(PERMISSIONS.SETTINGS_VIEW),
    asyncHandler(async (req, res) => {
      res.json(businesses.getBusinessConfig(businessId(req)));
    })
  );

  router.put(
    "/business",
    require(PERMISSIONS.SETTINGS_EDIT),
    asyncHandler(async (req, res) => {
      res.json(
        businesses.updateBusinessConfig(businessId(req), req.body || {}, req.user.username)
      );
    })
  );

  router.get(
    "/business/modules",
    require(PERMISSIONS.SETTINGS_VIEW),
    asyncHandler(async (req, res) => {
      res.json(businesses.listModules(businessId(req)));
    })
  );

  router.post(
    "/business/modules",
    require(PERMISSIONS.SETTINGS_EDIT),
    asyncHandler(async (req, res) => {
      const { moduleKey, enabled } = req.body || {};
      if (!moduleKey) throw new AppError("moduleKey is required.", { status: 422 });
      res.json(
        businesses.setModuleEnabled(businessId(req), moduleKey, Boolean(enabled), req.user.username)
      );
    })
  );

  router.get(
    "/business/templates",
    require(PERMISSIONS.SETTINGS_VIEW),
    asyncHandler(async (req, res) => {
      res.json(industry.listTemplates());
    })
  );

  router.post(
    "/business/template",
    require(PERMISSIONS.SETTINGS_EDIT),
    asyncHandler(async (req, res) => {
      const { templateKey } = req.body || {};
      if (!templateKey) throw new AppError("templateKey is required.", { status: 422 });
      res.json(industry.applyTemplate(businessId(req), templateKey, req.user.username));
    })
  );

  router.get(
    "/business/fields",
    require(PERMISSIONS.SETTINGS_VIEW),
    asyncHandler(async (req, res) => {
      res.json(businesses.listCustomFields(businessId(req), req.query.entityType || null));
    })
  );

  router.post(
    "/business/fields",
    require(PERMISSIONS.SETTINGS_EDIT),
    asyncHandler(async (req, res) => {
      res.json(businesses.upsertCustomField(businessId(req), req.body || {}, req.user.username));
    })
  );

  // ---------- customers ----------

  router.get(
    "/customers",
    require(PERMISSIONS.CUSTOMERS_VIEW),
    asyncHandler(async (req, res) => {
      res.json(
        customers.listCustomers(businessId(req), {
          search: req.query.search || "",
          limit: Number(req.query.limit) || 100,
          offset: Number(req.query.offset) || 0,
        })
      );
    })
  );

  router.get(
    "/customers/duplicates",
    require(PERMISSIONS.CUSTOMERS_VIEW),
    asyncHandler(async (req, res) => {
      res.json(
        customers.findDuplicates(businessId(req), {
          phone: req.query.phone || "",
          name: req.query.name || "",
        })
      );
    })
  );

  router.get(
    "/customers/:id",
    require(PERMISSIONS.CUSTOMERS_VIEW),
    asyncHandler(async (req, res) => {
      res.json(customers.getCustomerHistory(businessId(req), Number(req.params.id)));
    })
  );

  router.post(
    "/customers",
    require(PERMISSIONS.CUSTOMERS_EDIT),
    asyncHandler(async (req, res) => {
      res.status(201).json(
        customers.createCustomer(businessId(req), req.body || {}, req.user.username)
      );
    })
  );

  router.put(
    "/customers/:id",
    require(PERMISSIONS.CUSTOMERS_EDIT),
    asyncHandler(async (req, res) => {
      res.json(
        customers.updateCustomer(businessId(req), Number(req.params.id), req.body || {}, req.user.username)
      );
    })
  );

  router.delete(
    "/customers/:id",
    require(PERMISSIONS.CUSTOMERS_DELETE),
    asyncHandler(async (req, res) => {
      res.json({ ok: customers.deleteCustomer(businessId(req), Number(req.params.id), req.user.username) });
    })
  );

  router.get(
    "/customers/:id/export.csv",
    require(PERMISSIONS.CUSTOMERS_EXPORT),
    asyncHandler(async (req, res) => {
      const history = customers.getCustomerHistory(businessId(req), Number(req.params.id));
      const rows = [
        ["Field", "Value"],
        ["Name", history.customer.name],
        ["Phone", history.customer.phone],
        ["Email", history.customer.email],
        ["Province", history.customer.province],
        ["District", history.customer.district],
        ["Municipality", history.customer.municipality],
        ["Ward", history.customer.ward],
        ["Locality", history.customer.locality],
        ["Lifetime value", history.customer.lifetime_value],
        ["Orders", history.customer.total_orders],
      ];
      const csv = rows
        .map((r) => r.map((c) => (/[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : c)).join(","))
        .join("\r\n");
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="customer-${req.params.id}.csv"`);
      res.send(csv);
    })
  );

  // ---------- catalogue ----------

  router.get(
    "/products",
    require(PERMISSIONS.CATALOG_VIEW),
    asyncHandler(async (req, res) => {
      res.json(
        catalog.listProducts(businessId(req), {
          search: req.query.search || "",
          type: req.query.type || null,
          category: req.query.category || null,
          includeInactive: req.query.includeInactive === "true",
        })
      );
    })
  );

  router.post(
    "/products",
    require(PERMISSIONS.CATALOG_EDIT),
    asyncHandler(async (req, res) => {
      res.status(201).json(catalog.createProduct(businessId(req), req.body || {}, req.user.username));
    })
  );

  router.get(
    "/products/:id",
    require(PERMISSIONS.CATALOG_VIEW),
    asyncHandler(async (req, res) => {
      res.json(catalog.getProduct(businessId(req), Number(req.params.id)));
    })
  );

  router.put(
    "/products/:id",
    require(PERMISSIONS.CATALOG_EDIT),
    asyncHandler(async (req, res) => {
      res.json(catalog.updateProduct(businessId(req), Number(req.params.id), req.body || {}, req.user.username));
    })
  );

  router.delete(
    "/products/:id",
    require(PERMISSIONS.CATALOG_EDIT),
    asyncHandler(async (req, res) => {
      res.json({ ok: catalog.deleteProduct(businessId(req), Number(req.params.id), req.user.username) });
    })
  );

  // ---------- inventory ----------

  router.get(
    "/inventory",
    require(PERMISSIONS.INVENTORY_VIEW),
    asyncHandler(async (req, res) => {
      res.json(inventory.listStock(businessId(req), { onlyLow: req.query.low === "true" }));
    })
  );

  router.post(
    "/inventory/movement",
    require(PERMISSIONS.INVENTORY_EDIT),
    asyncHandler(async (req, res) => {
      const body = req.body || {};
      res.json(
        inventory.applyMovement({
          businessId: businessId(req),
          productId: Number(body.productId),
          variantId: Number(body.variantId) || 0,
          type: body.type,
          quantity: Number(body.quantity),
          note: body.note || "",
          actor: req.user.username,
        })
      );
    })
  );

  router.get(
    "/inventory/movements",
    require(PERMISSIONS.INVENTORY_VIEW),
    asyncHandler(async (req, res) => {
      res.json(inventory.listMovements(businessId(req), { productId: req.query.productId ? Number(req.query.productId) : null }));
    })
  );

  // ---------- orders ----------

  router.get(
    "/orders",
    require(PERMISSIONS.ORDERS_VIEW),
    asyncHandler(async (req, res) => {
      res.json(
        orders.listOrders(businessId(req), {
          state: req.query.state || null,
          paymentStatus: req.query.paymentStatus || null,
          customerId: req.query.customerId ? Number(req.query.customerId) : null,
          limit: Number(req.query.limit) || 100,
        })
      );
    })
  );

  router.get(
    "/orders/:id",
    require(PERMISSIONS.ORDERS_VIEW),
    asyncHandler(async (req, res) => {
      res.json(orders.getOrder(businessId(req), Number(req.params.id)));
    })
  );

  router.post(
    "/orders/drafts",
    require(PERMISSIONS.ORDERS_CREATE),
    asyncHandler(async (req, res) => {
      const body = req.body || {};
      const draft = orders.buildDraft(businessId(req), body, {
        chatId: body.chatId || "",
        customerId: body.customerId || null,
      });
      res.status(201).json(orders.saveDraft(businessId(req), draft, { actor: req.user.username }));
    })
  );

  router.get(
    "/orders/drafts",
    require(PERMISSIONS.ORDERS_VIEW),
    asyncHandler(async (req, res) => {
      res.json(orders.findDrafts(businessId(req), { chatId: req.query.chatId || null }));
    })
  );

  router.post(
    "/orders/drafts/:id/confirm",
    require(PERMISSIONS.ORDERS_CREATE),
    asyncHandler(async (req, res) => {
      res.json(
        orders.confirmDraft(businessId(req), Number(req.params.id), {
          actor: req.user.username,
          customerApproved: true,
          idempotencyKey: `staff-${req.params.id}`,
        })
      );
    })
  );

  router.post(
    "/orders/:id/state",
    require(PERMISSIONS.ORDERS_EDIT),
    asyncHandler(async (req, res) => {
      const { state, reason } = req.body || {};
      res.json(
        orders.transitionOrder(businessId(req), Number(req.params.id), state, {
          actor: req.user.username,
          reason: reason || "",
        })
      );
    })
  );

  // ---------- bookings ----------

  router.get(
    "/bookings",
    require(PERMISSIONS.BOOKINGS_VIEW),
    asyncHandler(async (req, res) => {
      res.json(bookings.listBookings(businessId(req), { status: req.query.status || null }));
    })
  );

  router.post(
    "/bookings",
    require(PERMISSIONS.BOOKINGS_EDIT),
    asyncHandler(async (req, res) => {
      res.status(201).json(
        bookings.createBooking(businessId(req), req.body || {}, req.user.username)
      );
    })
  );

  router.put(
    "/bookings/:id",
    require(PERMISSIONS.BOOKINGS_EDIT),
    asyncHandler(async (req, res) => {
      res.json(
        bookings.updateBooking(businessId(req), Number(req.params.id), req.body || {}, req.user.username)
      );
    })
  );

  // ---------- quotations & invoices ----------

  router.get(
    "/quotations",
    require(PERMISSIONS.QUOTES_VIEW),
    asyncHandler(async (req, res) => {
      res.json(quotations.listQuotations(businessId(req)));
    })
  );

  router.post(
    "/quotations",
    require(PERMISSIONS.QUOTES_EDIT),
    asyncHandler(async (req, res) => {
      res.status(201).json(
        quotations.createQuotation(businessId(req), req.body || {}, req.user.username)
      );
    })
  );

  router.get(
    "/invoices",
    require(PERMISSIONS.INVOICES_VIEW),
    asyncHandler(async (req, res) => {
      res.json(quotations.listInvoices(businessId(req)));
    })
  );

  router.post(
    "/invoices",
    require(PERMISSIONS.INVOICES_EDIT),
    asyncHandler(async (req, res) => {
      res.status(201).json(
        quotations.createInvoice(businessId(req), req.body || {}, req.user.username)
      );
    })
  );

  router.get(
    "/invoices/:id/document",
    require(PERMISSIONS.INVOICES_VIEW),
    asyncHandler(async (req, res) => {
      const business = businesses.getBusinessConfig(businessId(req));
      const invoice = quotations.getInvoice(businessId(req), Number(req.params.id));
      res.type("html").send(quotations.renderDocument(business, invoice, "invoice"));
    })
  );

  router.get(
    "/expenses",
    require(PERMISSIONS.REPORTS_VIEW),
    asyncHandler(async (req, res) => {
      res.json(quotations.listExpenses(businessId(req)));
    })
  );

  router.post(
    "/expenses",
    require(PERMISSIONS.INVOICES_EDIT),
    asyncHandler(async (req, res) => {
      res.status(201).json(
        quotations.createExpense(businessId(req), req.body || {}, req.user.username)
      );
    })
  );

  // ---------- payments ----------

  router.get(
    "/payments",
    require(PERMISSIONS.PAYMENTS_VIEW),
    asyncHandler(async (req, res) => {
      res.json(payments.listPayments(businessId(req), { status: req.query.status || null }));
    })
  );

  router.get(
    "/payments/providers",
    require(PERMISSIONS.INTEGRATIONS_VIEW),
    asyncHandler(async (req, res) => {
      res.json(payments.listAdapters());
    })
  );

  router.post(
    "/payments/:id/verify",
    require(PERMISSIONS.PAYMENTS_MANAGE),
    asyncHandler(async (req, res) => {
      res.json(
        await payments.verifyPayment({
          businessId: businessId(req),
          paymentId: Number(req.params.id),
          actor: req.user.username,
        })
      );
    })
  );

  router.post(
    "/payments/:id/approve",
    require(PERMISSIONS.PAYMENTS_MANAGE),
    asyncHandler(async (req, res) => {
      res.json(
        payments.approveManualPayment(businessId(req), Number(req.params.id), {
          actor: req.user.username,
          note: req.body?.note || "",
        })
      );
    })
  );

  router.get(
    "/orders/:id/reconciliation",
    require(PERMISSIONS.PAYMENTS_VIEW),
    asyncHandler(async (req, res) => {
      res.json(payments.reconcileOrder(businessId(req), Number(req.params.id)));
    })
  );

  // ---------- conversations ----------

  router.get(
    "/threads",
    require(PERMISSIONS.CONVERSATIONS_VIEW),
    asyncHandler(async (req, res) => {
      res.json(
        conversations.listThreads(businessId(req), {
          status: req.query.status || null,
          aiMode: req.query.aiMode || null,
          search: req.query.search || "",
        })
      );
    })
  );

  router.get(
    "/threads/counts",
    require(PERMISSIONS.CONVERSATIONS_VIEW),
    asyncHandler(async (req, res) => {
      res.json(conversations.inboxCounts(businessId(req)));
    })
  );

  router.get(
    "/threads/:id",
    require(PERMISSIONS.CONVERSATIONS_VIEW),
    asyncHandler(async (req, res) => {
      const thread = conversations.getThread(businessId(req), Number(req.params.id));
      res.json({
        thread,
        messages: conversations.getThreadMessages(businessId(req), Number(req.params.id)),
        notes: conversations.listNotes(businessId(req), Number(req.params.id)),
      });
    })
  );

  router.post(
    "/threads/:id/takeover",
    require(PERMISSIONS.CONVERSATIONS_TAKEOVER),
    asyncHandler(async (req, res) => {
      res.json(
        conversations.takeoverThread(businessId(req), Number(req.params.id), {
          actor: req.user.username,
          reason: req.body?.reason || "Taken over by staff",
          summary: req.body?.summary || "",
        })
      );
    })
  );

  router.post(
    "/threads/:id/resume",
    require(PERMISSIONS.CONVERSATIONS_TAKEOVER),
    asyncHandler(async (req, res) => {
      res.json(
        conversations.resumeAi(businessId(req), Number(req.params.id), { actor: req.user.username })
      );
    })
  );

  router.post(
    "/threads/:id/assign",
    require(PERMISSIONS.CONVERSATIONS_REPLY),
    asyncHandler(async (req, res) => {
      res.json(
        conversations.assignThread(businessId(req), Number(req.params.id), req.body?.assignedTo || "", req.user.username)
      );
    })
  );

  router.post(
    "/threads/:id/notes",
    require(PERMISSIONS.CONVERSATIONS_REPLY),
    asyncHandler(async (req, res) => {
      res.status(201).json(
        conversations.addNote(businessId(req), Number(req.params.id), req.user.username, req.body?.body || "")
      );
    })
  );

  // ---------- tasks ----------

  router.get(
    "/tasks",
    require(PERMISSIONS.DASHBOARD_VIEW),
    asyncHandler(async (req, res) => {
      res.json(tasks.listTasks(businessId(req), { status: req.query.status || null }));
    })
  );

  router.post(
    "/tasks",
    require(PERMISSIONS.DASHBOARD_VIEW),
    asyncHandler(async (req, res) => {
      res.status(201).json(tasks.createTask(businessId(req), req.body || {}, req.user.username));
    })
  );

  router.put(
    "/tasks/:id",
    require(PERMISSIONS.DASHBOARD_VIEW),
    asyncHandler(async (req, res) => {
      res.json(tasks.updateTask(businessId(req), Number(req.params.id), req.body || {}, req.user.username));
    })
  );

  // ---------- knowledge ----------

  router.get(
    "/knowledge",
    require(PERMISSIONS.KNOWLEDGE_VIEW),
    asyncHandler(async (req, res) => {
      res.json(knowledge.listDocuments(businessId(req)));
    })
  );

  router.get(
    "/knowledge/search",
    require(PERMISSIONS.KNOWLEDGE_VIEW),
    asyncHandler(async (req, res) => {
      res.json(knowledge.search(businessId(req), req.query.q || "", { limit: Number(req.query.limit) || 10 }));
    })
  );

  router.post(
    "/knowledge",
    require(PERMISSIONS.KNOWLEDGE_EDIT),
    asyncHandler(async (req, res) => {
      res.status(201).json(knowledge.upsertDocument(businessId(req), req.body || {}, req.user.username));
    })
  );

  router.delete(
    "/knowledge/:id",
    require(PERMISSIONS.KNOWLEDGE_EDIT),
    asyncHandler(async (req, res) => {
      res.json({ ok: knowledge.deleteDocument(businessId(req), Number(req.params.id), req.user.username) });
    })
  );

  router.post(
    "/knowledge/reindex",
    require(PERMISSIONS.KNOWLEDGE_EDIT),
    asyncHandler(async (req, res) => {
      res.json(knowledge.reindexBusiness(businessId(req)));
    })
  );

  // ---------- AI configuration ----------

  router.get(
    "/ai/tools",
    require(PERMISSIONS.AI_VIEW),
    asyncHandler(async (req, res) => {
      const business = businesses.getBusinessConfig(businessId(req));
      res.json({
        operatorRole: business.ai_operator_role,
        tools: TOOL_DEFINITIONS.map((t) => {
          const permission = req.app.locals.toolPermission
            ? req.app.locals.toolPermission(businessId(req), t.name)
            : null;
          return {
            name: t.name,
            description: t.description,
            sideEffects: t.sideEffects,
            approvalRequired: Boolean(t.approvalRequired),
            requiredPermissions: t.requiredPermissions,
            available: listToolsForBusiness(businessId(req)).some((x) => x.name === t.name),
          };
        }),
      });
    })
  );

  router.post(
    "/ai/tools/:name",
    require(PERMISSIONS.AI_EDIT),
    asyncHandler(async (req, res) => {
      res.json(
        setToolPermission(businessId(req), req.params.name, req.body || {}, req.user.username)
      );
    })
  );

  router.post(
    "/ai/test",
    require(PERMISSIONS.AI_EDIT),
    asyncHandler(async (req, res) => {
      res.json(
        await testModel({
          businessId: businessId(req),
          provider: req.body?.provider,
          model: req.body?.model,
          apiKey: req.body?.apiKey,
        })
      );
    })
  );

  router.get(
    "/ai/local-health",
    require(PERMISSIONS.AI_VIEW),
    asyncHandler(async (req, res) => {
      res.json(await localRuntimeHealth());
    })
  );

  // ---------- approvals ----------

  router.get(
    "/approvals",
    require(PERMISSIONS.AI_VIEW),
    asyncHandler(async (req, res) => {
      res.json(listApprovals(businessId(req), { status: req.query.status || "pending" }));
    })
  );

  router.post(
    "/approvals/:id/decision",
    require(PERMISSIONS.AI_EDIT),
    asyncHandler(async (req, res) => {
      res.json(
        decideApproval(businessId(req), Number(req.params.id), {
          decision: req.body?.decision === "approve" ? "approve" : "reject",
          actor: req.user.username,
          note: req.body?.note || "",
        })
      );
    })
  );

  // ---------- workflows ----------

  router.get(
    "/workflows",
    require(PERMISSIONS.WORKFLOWS_VIEW),
    asyncHandler(async (req, res) => {
      res.json({
        workflows: workflows.listWorkflows(businessId(req)),
        triggers: workflows.TRIGGER_LABELS,
        actions: workflows.ACTION_LABELS,
      });
    })
  );

  router.post(
    "/workflows",
    require(PERMISSIONS.WORKFLOWS_EDIT),
    asyncHandler(async (req, res) => {
      res.status(201).json(workflows.createWorkflow(businessId(req), req.body || {}, req.user.username));
    })
  );

  router.put(
    "/workflows/:id",
    require(PERMISSIONS.WORKFLOWS_EDIT),
    asyncHandler(async (req, res) => {
      res.json(workflows.updateWorkflow(businessId(req), Number(req.params.id), req.body || {}, req.user.username));
    })
  );

  router.delete(
    "/workflows/:id",
    require(PERMISSIONS.WORKFLOWS_EDIT),
    asyncHandler(async (req, res) => {
      res.json({ ok: workflows.deleteWorkflow(businessId(req), Number(req.params.id), req.user.username) });
    })
  );

  router.get(
    "/workflows/runs",
    require(PERMISSIONS.WORKFLOWS_VIEW),
    asyncHandler(async (req, res) => {
      res.json(workflows.listRuns(businessId(req), { status: req.query.status || null }));
    })
  );

  router.post(
    "/workflows/trigger",
    require(PERMISSIONS.WORKFLOWS_EDIT),
    asyncHandler(async (req, res) => {
      const { triggerType, context } = req.body || {};
      if (!triggerType) throw new AppError("triggerType is required.", { status: 422 });
      res.json(await workflows.fireTrigger(businessId(req), triggerType, context || {}));
    })
  );

  // ---------- notifications ----------

  router.get(
    "/notifications",
    require(PERMISSIONS.DASHBOARD_VIEW),
    asyncHandler(async (req, res) => {
      res.json(listNotifications(businessId(req), req.user.username));
    })
  );

  router.post(
    "/notifications/:id/read",
    require(PERMISSIONS.DASHBOARD_VIEW),
    asyncHandler(async (req, res) => {
      res.json({ ok: markNotificationRead(businessId(req), Number(req.params.id)) });
    })
  );

  // ---------- backups ----------

  router.get(
    "/backups",
    require(PERMISSIONS.BACKUPS_VIEW),
    asyncHandler(async (req, res) => {
      res.json(listBackups());
    })
  );

  router.post(
    "/backups",
    require(PERMISSIONS.BACKUPS_MANAGE),
    asyncHandler(async (req, res) => {
      res.status(201).json(backupDatabase());
    })
  );

  router.post(
    "/backups/:name/restore",
    require(PERMISSIONS.BACKUPS_MANAGE),
    asyncHandler(async (req, res) => {
      res.json({ ok: restoreBackup(req.params.name), restartRequired: true });
    })
  );

  return router;
}

function hasPermission(user, permission) {
  if (user.role === "owner") return true;
  return resolvePermissions(user).has(permission);
}
