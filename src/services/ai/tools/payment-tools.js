// src/services/ai/tools/payment-tools.js
// Payment status — always the provider's verdict, never a claim.

import { listPayments, reconcileOrder } from "../../payments/index.js";
import { getOrder, listOrders } from "../../orders.js";

export async function getPaymentStatus(ctx, args) {
  let order = null;

  if (args.orderId) {
    order = getOrder(ctx.businessId, Number(args.orderId));
  } else if (args.orderNumber) {
    const rows = listOrders(ctx.businessId, { limit: 200 });
    const match = rows.find((o) => o.order_number === args.orderNumber);
    if (match) order = getOrder(ctx.businessId, match.id);
  } else if (ctx.chatId) {
    const rows = listOrders(ctx.businessId, { chatId: ctx.chatId, limit: 5 });
    order = rows[0] ? getOrder(ctx.businessId, rows[0].id) : null;
  }

  if (!order) {
    return { found: false, status: "unknown", message: "No matching order was found." };
  }

  const reconciliation = reconcileOrder(ctx.businessId, order.id);
  const payments = listPayments(ctx.businessId, { orderId: order.id });

  return {
    found: true,
    orderNumber: order.order_number,
    status: order.payment_status,
    verified: reconciliation.paid > 0 && reconciliation.reconciled,
    amountPaid: reconciliation.paid,
    amountExpected: reconciliation.expected,
    currency: order.currency,
    method: order.payment_method || "",
    payments: payments.map((p) => ({
      provider: p.provider,
      status: p.status,
      amount: p.amount,
      verified: Boolean(p.verified),
      detail: p.verification_detail || "",
    })),
    message:
      order.payment_status === "paid"
        ? "Payment confirmed by the payment provider."
        : order.payment_status === "pending"
          ? "Payment has not been confirmed yet."
          : `Payment status: ${order.payment_status}.`,
  };
}
