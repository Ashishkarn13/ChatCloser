// src/services/ai/tools/order-tools.js
// Order tools. These are the ones that touch money and stock, so they are
// written to be safe even if the model misbehaves:
//
//   * prices always come from the catalogue,
//   * an order only exists after the customer's explicit approval,
//   * a price change between the summary and the confirmation invalidates
//     the draft instead of silently charging a different amount.

import {
  buildDraft,
  saveDraft,
  getDraft,
  findDrafts,
  confirmDraft,
  getOrder,
  listOrders,
  transitionOrder,
  renderOrderSummary,
} from "../../orders.js";
import { getBusinessConfig } from "../../businesses.js";
import { formatMoney } from "../../../core/money.js";
import { NotFoundError, ValidationError } from "../../../core/errors.js";

export async function createOrderDraft(ctx, args) {
  const business = getBusinessConfig(ctx.businessId);
  const items = Array.isArray(args.items) ? args.items : [];

  if (items.length === 0) {
    return { ok: false, message: "An order needs at least one item." };
  }

  const draft = buildDraft(
    ctx.businessId,
    {
      items,
      discountAmount: args.discountAmount,
      notes: args.notes,
      delivery: buildAddress(args),
    },
    { threadId: ctx.threadId, chatId: ctx.chatId, customerId: ctx.customerId }
  );

  if (draft.problems.length > 0) {
    return {
      ok: false,
      problems: draft.problems,
      message:
        "Some items could not be priced from the catalogue. Resolve them with the customer before continuing.",
    };
  }

  const saved = saveDraft(ctx.businessId, draft, { actor: ctx.actor });
  const currency = draft.currency || business.currency;

  return {
    ok: true,
    draftId: saved.id,
    total: draft.totals.total,
    currency,
    summary: renderOrderSummary(
      {
        id: saved.id,
        order_number: `DRAFT-${saved.id}`,
        items: draft.lines.map((l) => ({
          name: l.name,
          quantity: l.quantity,
          unit_price: l.unitPrice,
          line_total: l.unitPrice * l.quantity,
        })),
        subtotal: draft.totals.subtotal,
        discount_amount: draft.totals.discountAmount,
        tax_amount: draft.totals.taxAmount,
        delivery_amount: draft.totals.deliveryAmount,
        total_amount: draft.totals.total,
      },
      { currency }
    ),
    totalFormatted: formatMoney(draft.totals.total, currency),
    nextStep:
      "Show this summary to the customer and ask them to confirm. Do not create the order until they say yes.",
  };
}

export async function submitOrderForConfirmation(ctx, args) {
  const draft = getDraft(ctx.businessId, Number(args.draftId));
  if (!draft) throw new NotFoundError("No such order draft.");

  const currency = draft.currency || ctx.business.currency;
  const lines = draft.payload.lines || [];
  const summary = renderOrderSummary(
    {
      id: draft.id,
      order_number: `DRAFT-${draft.id}`,
      items: lines.map((l) => ({
        name: l.name,
        quantity: l.quantity,
        unit_price: l.unitPrice,
        line_total: l.unitPrice * l.quantity,
      })),
      subtotal: draft.payload.totals?.subtotal ?? 0,
      discount_amount: draft.payload.totals?.discountAmount ?? 0,
      tax_amount: draft.payload.totals?.taxAmount ?? 0,
      delivery_amount: draft.payload.totals?.deliveryAmount ?? 0,
      total_amount: draft.total,
    },
    { currency }
  );

  if (typeof ctx.sendMessage === "function") {
    await ctx.sendMessage(
      `${summary}\n\nTotal to pay: ${formatMoney(draft.total, currency)} ${currency}.\nPlease reply to confirm this order.`
    );
  }

  return { ok: true, sent: true, draftId: draft.id, summary, total: draft.total, currency };
}

export async function confirmCustomerOrder(ctx, args) {
  const draftId = Number(args.draftId);
  if (!draftId) throw new ValidationError("draftId is required.");

  // The approval must be the customer's own words. An empty confirmation
  // is refused outright — the backend never treats silence as consent.
  const confirmationText = String(args.confirmationText || "").trim();
  if (!confirmationText) {
    return {
      ok: false,
      message:
        "The customer has not confirmed yet. Ask them to confirm the summary and pass their exact reply as confirmationText.",
    };
  }

  const order = confirmDraft(ctx.businessId, draftId, {
    actor: "customer",
    customerApproved: true,
    idempotencyKey: `draft-${draftId}`,
  });

  const currency = order.currency || ctx.business.currency;

  return {
    ok: true,
    orderId: order.id,
    orderNumber: order.order_number,
    total: order.total_amount,
    currency,
    status: order.state,
    paymentStatus: order.payment_status,
    totalFormatted: formatMoney(order.total_amount, currency),
    message: `Order ${order.order_number} is confirmed.`,
  };
}

export async function getOrderStatus(ctx, args) {
  let order = null;

  if (args.orderId) {
    order = getOrder(ctx.businessId, Number(args.orderId));
  } else if (args.orderNumber) {
    const rows = listOrders(ctx.businessId, { limit: 200 });
    order = rows.find((o) => o.order_number === args.orderNumber) || null;
    if (order) order = getOrder(ctx.businessId, order.id);
  } else if (ctx.chatId) {
    const rows = listOrders(ctx.businessId, { chatId: ctx.chatId, limit: 5 });
    order = rows[0] ? getOrder(ctx.businessId, rows[0].id) : null;
  }

  if (!order) {
    return { found: false, message: "No matching order was found for this conversation." };
  }

  return {
    found: true,
    order: {
      id: order.id,
      orderNumber: order.order_number,
      state: order.state,
      paymentStatus: order.payment_status,
      total: order.total_amount,
      currency: order.currency,
      createdAt: order.created_at,
      items: order.items.map((i) => ({ name: i.name, quantity: i.quantity, lineTotal: i.line_total })),
      timeline: order.transitions.map((t) => ({
        from: t.from_state,
        to: t.to_state,
        at: t.created_at,
      })),
    },
  };
}

export async function cancelOrder(ctx, args) {
  const order = getOrder(ctx.businessId, Number(args.orderId));
  const updated = transitionOrder(ctx.businessId, order.id, "cancelled", {
    actor: ctx.actor,
    reason: args.reason || "Cancelled by customer request",
  });

  if (typeof ctx.sendMessage === "function") {
    await ctx.sendMessage(`Order ${updated.order_number} has been cancelled.`);
  }

  return {
    ok: true,
    cancelled: true,
    orderId: updated.id,
    orderNumber: updated.order_number,
  };
}

function buildAddress(args) {
  const address = {};
  for (const key of ["address", "locality", "district", "municipality", "ward", "province"]) {
    if (args[key]) address[key] = args[key];
  }
  if (args.customerName) address.name = args.customerName;
  if (args.phone) address.phone = args.phone;
  return address;
}
