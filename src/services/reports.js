// src/services/reports.js
// Business intelligence.
//
// Every number here is computed from the database. Nothing is a
// demonstration value: an empty database produces zeros and an explicit
// "no data" flag rather than an invented trend.

import { getDb } from "../db/connection.js";
import { roundMoney } from "../core/money.js";
import { lowStockAlerts, inventoryValuation } from "./inventory.js";
import { listThreads } from "./conversations.js";

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

/** The dashboard summary for the Overview screen. */
export function overview(businessId) {
  const db = getDb();

  const revenue = db
    .prepare(
      `SELECT COALESCE(SUM(total_amount), 0) AS revenue, COUNT(*) AS orders
       FROM orders WHERE business_id = ? AND payment_status = 'paid'`
    )
    .get(businessId);

  const pendingOrders = db
    .prepare(
      `SELECT COUNT(*) AS c FROM orders
       WHERE business_id = ? AND state NOT IN ('delivered','cancelled','rejected','refunded','returned')`
    )
    .get(businessId);

  const awaitingPayment = db
    .prepare(
      `SELECT COUNT(*) AS c FROM orders WHERE business_id = ? AND payment_status = 'pending'`
    )
    .get(businessId);

  const unverifiedPayments = db
    .prepare(
      `SELECT COUNT(*) AS c FROM payments WHERE business_id = ? AND verified = 0 AND status NOT IN ('cancelled','failed')`
    )
    .get(businessId);

  const leads = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) AS new_leads,
         SUM(CASE WHEN status IN ('booked','closed') THEN 1 ELSE 0 END) AS converted
       FROM leads WHERE business_id = ?`
    )
    .get(businessId);

  const conversations = db
    .prepare(
      `SELECT COUNT(DISTINCT chat_id) AS c FROM conversations WHERE business_id = ? AND role = 'user'`
    )
    .get(businessId);

  const awaitingReply = db
    .prepare(
      `SELECT COUNT(*) AS c FROM threads
       WHERE business_id = ? AND status = 'open' AND unread_count > 0 AND assigned_to = ''`
    )
    .get(businessId);

  const lowStock = lowStockAlerts(businessId);

  const failedWorkflows = db
    .prepare(
      `SELECT COUNT(*) AS c FROM workflow_runs
       WHERE business_id = ? AND status IN ('failed','dead_letter')`
    )
    .get(businessId);

  const pendingApprovals = db
    .prepare(
      "SELECT COUNT(*) AS c FROM approvals WHERE business_id = ? AND status = 'pending'"
    )
    .get(businessId);

  const ai = db
    .prepare(
      `SELECT COUNT(*) AS runs, COALESCE(AVG(latency_ms), 0) AS avg_latency,
              COALESCE(SUM(estimated_cost), 0) AS cost,
              COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS tokens
       FROM ai_runs WHERE business_id = ? AND created_at >= datetime('now', '-30 days')`
    )
    .get(businessId);

  const aiErrors = db
    .prepare(
      `SELECT COUNT(*) AS c FROM ai_runs WHERE business_id = ? AND outcome <> 'replied'`
    )
    .get(businessId);

  const responseRow = db
    .prepare(
      `SELECT AVG((julianday(a.created_at) - julianday(u.created_at)) * 86400) AS avg_seconds
       FROM conversations a
       JOIN conversations u ON u.id = (
         SELECT MAX(id) FROM conversations u2
         WHERE u2.business_id = a.business_id AND u2.chat_id = a.chat_id
           AND u2.role = 'user' AND u2.id < a.id
       )
       WHERE a.business_id = ? AND a.role = 'assistant'`
    )
    .get(businessId);

  const repeatRate = db
    .prepare(
      `SELECT
         COUNT(*) AS customers_with_orders,
         SUM(CASE WHEN total_orders > 1 THEN 1 ELSE 0 END) AS repeat_customers
       FROM customers WHERE business_id = ? AND deleted_at IS NULL AND total_orders > 0`
    )
    .get(businessId);

  const totalLeads = Number(leads.total || 0);
  const convertedLeads = Number(leads.converted || 0);

  return {
    revenue: roundMoney(revenue.revenue || 0),
    paidOrders: Number(revenue.orders || 0),
    pendingOrders: Number(pendingOrders.c || 0),
    awaitingPayment: Number(awaitingPayment.c || 0),
    unverifiedPayments: Number(unverifiedPayments.c || 0),
    newLeads: Number(leads.new_leads || 0),
    totalLeads,
    leadConversionRate: totalLeads > 0 ? roundMoney((convertedLeads / totalLeads) * 100) : 0,
    conversations: Number(conversations.c || 0),
    awaitingReply: Number(awaitingReply.c || 0),
    lowStockCount: lowStock.length,
    failedWorkflows: Number(failedWorkflows.c || 0),
    pendingApprovals: Number(pendingApprovals.c || 0),
    avgResponseSeconds: responseRow.avg_seconds ? Math.round(responseRow.avg_seconds) : null,
    repeatPurchaseRate:
      Number(repeatRate.customers_with_orders || 0) > 0
        ? roundMoney((Number(repeatRate.repeat_customers || 0) / Number(repeatRate.customers_with_orders)) * 100)
        : 0,
    ai: {
      runs30d: Number(ai.runs || 0),
      avgLatencyMs: Math.round(Number(ai.avg_latency || 0)),
      estimatedCost30d: roundMoney(Number(ai.cost || 0) * 100) / 100,
      tokens30d: Number(ai.tokens || 0),
      problemRuns: Number(aiErrors.c || 0),
    },
    hasData: Number(revenue.orders || 0) > 0 || totalLeads > 0 || Number(conversations.c || 0) > 0,
  };
}

/** Daily revenue for the last `days` days. */
export function revenueTrend(businessId, days = 30) {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT date(created_at) AS day,
              COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN total_amount ELSE 0 END), 0) AS revenue,
              COUNT(*) AS orders
       FROM orders
       WHERE business_id = ? AND date(created_at) >= date('now', ?)
       GROUP BY date(created_at) ORDER BY day ASC`
    )
    .all(businessId, `-${days} days`);

  const byDay = new Map(rows.map((r) => [r.day, r]));
  const series = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const day = daysAgo(i);
    const row = byDay.get(day);
    series.push({
      day,
      revenue: roundMoney(row?.revenue || 0),
      orders: Number(row?.orders || 0),
    });
  }
  return series;
}

/** Revenue grouped by the items that were actually sold. */
export function revenueByProduct(businessId, { limit = 20 } = {}) {
  const db = getDb();
  return db
    .prepare(
      `SELECT oi.name AS name,
              SUM(oi.quantity) AS quantity,
              SUM(oi.line_total) AS revenue
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id AND o.business_id = oi.business_id
       WHERE oi.business_id = ? AND o.payment_status = 'paid'
       GROUP BY oi.name ORDER BY revenue DESC LIMIT ?`
    )
    .all(businessId, Math.min(Number(limit) || 20, 100))
    .map((r) => ({ ...r, revenue: roundMoney(r.revenue || 0) }));
}

/** Lead funnel. */
export function leadFunnel(businessId) {
  const db = getDb();
  const rows = db
    .prepare("SELECT status, COUNT(*) AS count FROM leads WHERE business_id = ? GROUP BY status")
    .all(businessId);
  const byStatus = Object.fromEntries(rows.map((r) => [r.status, Number(r.count)]));
  const total = rows.reduce((sum, r) => sum + Number(r.count), 0);
  const converted = (byStatus.booked || 0) + (byStatus.closed || 0);
  return {
    total,
    byStatus,
    converted,
    conversionRate: total > 0 ? roundMoney((converted / total) * 100) : 0,
  };
}

/** AI usage and estimated cost by model. */
export function aiUsage(businessId, { days = 30 } = {}) {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT provider, model,
              COUNT(*) AS runs,
              COALESCE(AVG(latency_ms), 0) AS avg_latency,
              COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
              COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
              COALESCE(SUM(estimated_cost), 0) AS cost
       FROM ai_runs
       WHERE business_id = ? AND created_at >= datetime('now', ?)
       GROUP BY provider, model ORDER BY runs DESC`
    )
    .all(businessId, `-${days} days`);

  return rows.map((r) => ({
    ...r,
    avg_latency: Math.round(r.avg_latency),
    cost: Math.round(Number(r.cost) * 100000) / 100000,
  }));
}

/** Inventory risk: items at or below their reorder level. */
export function inventoryRisk(businessId) {
  const alerts = lowStockAlerts(businessId);
  const valuation = inventoryValuation(businessId);
  return {
    lowStock: alerts,
    valuation,
  };
}

/**
 * A forecast is only produced when there is enough history to justify one.
 * Otherwise the caller is told there is not enough data — no invented
 * numbers.
 */
export function demandForecast(businessId, { days = 14, minHistoryDays = 14 } = {}) {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT date(created_at)) AS d FROM orders
       WHERE business_id = ? AND created_at >= datetime('now', ?)`
    )
    .get(businessId, `-${90} days`);

  const historyDays = Number(row.d || 0);
  if (historyDays < minHistoryDays) {
    return {
      available: false,
      reason: `Only ${historyDays} day(s) of order history — at least ${minHistoryDays} are needed for a forecast.`,
      points: [],
    };
  }

  const series = revenueTrend(businessId, days);
  const values = series.map((s) => s.revenue).filter((v) => v > 0);
  if (values.length < 7) {
    return { available: false, reason: "Not enough non-empty days to project from.", points: [] };
  }

  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  const stdDev = Math.sqrt(variance);

  return {
    available: true,
    method: "mean ± 1 standard deviation of observed daily revenue",
    confidence: "low — sales volumes in this business are still small",
    averageDailyRevenue: roundMoney(mean),
    lowerBound: roundMoney(Math.max(0, mean - stdDev)),
    upperBound: roundMoney(mean + stdDev),
    points: series,
  };
}

/** Orders that are waiting on something. */
export function ordersNeedingAttention(businessId) {
  const db = getDb();
  return db
    .prepare(
      `SELECT id, order_number, state, payment_status, total_amount, currency, created_at, customer_id
       FROM orders
       WHERE business_id = ?
         AND (state NOT IN ('delivered','cancelled','rejected','refunded','returned')
              OR (payment_status = 'pending' AND created_at < datetime('now', '-1 day')))
       ORDER BY created_at ASC LIMIT 100`
    )
    .all(businessId);
}

/** Conversations that are waiting for a human. */
export function conversationsNeedingAttention(businessId) {
  return listThreads(businessId, { status: "open", limit: 50 }).filter(
    (t) => t.unread_count > 0 || t.ai_mode === "off" || t.priority === "high" || t.priority === "urgent"
  );
}

/** Accounting-support summary. Explicitly not a statutory tax return. */
export function accountingSummary(businessId, { from = null, to = null } = {}) {
  const db = getDb();
  const params = [businessId];
  const range = [];
  if (from) {
    range.push("date(created_at) >= date(?)");
    params.push(from);
  }
  if (to) {
    range.push("date(created_at) <= date(?)");
    params.push(to);
  }
  const where = range.length ? `AND ${range.join(" AND ")}` : "";

  const income = db
    .prepare(
      `SELECT COALESCE(SUM(total_amount), 0) AS total, COUNT(*) AS count
       FROM orders WHERE business_id = ? AND payment_status = 'paid' ${where}`
    )
    .get(...params);

  const expenses = db
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM expenses WHERE business_id = ? ${where}`
    )
    .get(...params);

  const cogs = db
    .prepare(
      `SELECT COALESCE(SUM(oi.quantity * p.cost_price), 0) AS total
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id AND o.business_id = oi.business_id
       JOIN products p ON p.id = oi.product_id
       WHERE oi.business_id = ? AND o.payment_status = 'paid' ${where}`
    )
    .get(...params);

  const tax = db
    .prepare(
      `SELECT COALESCE(SUM(tax_amount), 0) AS total FROM orders
       WHERE business_id = ? AND payment_status = 'paid' ${where}`
    )
    .get(...params);

  const revenue = Number(income.total || 0);
  const cost = Number(cogs.total || 0);

  return {
    revenue: roundMoney(revenue),
    costOfGoods: roundMoney(cost),
    grossProfit: roundMoney(revenue - cost),
    grossMarginPercent: revenue > 0 ? roundMoney(((revenue - cost) / revenue) * 100) : 0,
    expenses: roundMoney(Number(expenses.total || 0)),
    operatingResult: roundMoney(revenue - cost - Number(expenses.total || 0)),
    taxCollected: roundMoney(Number(tax.total || 0)),
    orders: Number(income.count || 0),
    disclaimer:
      "This is an operational estimate computed from the records in ChatCloser. It is not a statutory accounting or tax filing and has not been verified against Nepal Inland Revenue Department requirements.",
  };
}
