// src/services/payments/manual.js
// Cash on delivery and manual bank transfer.
//
// These methods have no automated verification path — by definition the
// money moves outside the system. A payment therefore stays in
// "requires_review" until an authorised staff member confirms it in the
// dashboard, and that decision is written to the audit log.
//
// Cash on delivery marks nothing as paid at all: the order is simply
// allowed to ship and the money is collected on delivery.

export const id = "cash_on_delivery";
export const label = "Cash on delivery";
export const credentialFields = [];
export const requiresManualApproval = false;

export function isConfigured() {
  return true;
}

export async function createPaymentLink({ order, business }) {
  const instructions = [
    `Order ${order.order_number || order.id}`,
    `Amount to collect: ${Number(order.total_amount ?? order.amount)} ${order.currency || business.currency || "NPR"}`,
    "Please keep the exact amount ready. A receipt will be issued on delivery.",
  ];
  return {
    providerRef: `cod_${order.order_number || order.id}`,
    paymentUrl: null,
    instructions: instructions.join("\n"),
    raw: { method: "cash_on_delivery" },
  };
}

export async function verify() {
  return {
    verified: false,
    status: "requires_review",
    amount: null,
    detail: "Cash on delivery is collected by staff and confirmed manually.",
    raw: {},
  };
}

export const bankTransfer = {
  ...id ? {} : {},
  id: "bank_transfer",
  label: "Bank transfer / wallet (manual)",
  credentialFields: [
    { key: "instructions", label: "Payment instructions", hint: "Bank name, account number, QR code link…" },
  ],
  requiresManualApproval: true,
  isConfigured(credentials) {
    return Boolean(credentials?.instructions);
  },
  async createPaymentLink({ order, credentials, business }) {
    const text = [
      `Order ${order.order_number || order.id}`,
      `Amount: ${Number(order.total_amount ?? order.amount)} ${order.currency || business.currency || "NPR"}`,
      "",
      String(credentials.instructions || ""),
    ].join("\n");
    return {
      providerRef: `manual_${order.order_number || order.id}`,
      paymentUrl: null,
      instructions: text,
      raw: { method: "bank_transfer" },
    };
  },
  async verify() {
    return {
      verified: false,
      status: "requires_review",
      amount: null,
      detail: "Manual transfers are confirmed by an authorised staff member.",
      raw: {},
    };
  },
};
