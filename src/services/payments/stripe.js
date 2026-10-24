// src/services/payments/stripe.js
// Stripe adapter.
//
// The ChatCloser 1.x Stripe flow is preserved exactly: a Checkout Session
// is created for the verified order total, and the only thing that can
// mark an order paid is a Stripe webhook whose signature verifies against
// the business' own webhook signing secret.

import Stripe from "stripe";

export const id = "stripe";
export const label = "Stripe";
export const credentialFields = [
  { key: "secretKey", label: "Stripe secret key", hint: "sk_live_… or sk_test_…" },
  { key: "webhookSecret", label: "Stripe webhook signing secret", hint: "whsec_…" },
];

export function isConfigured(credentials) {
  return Boolean(credentials?.secretKey);
}

export async function createPaymentLink({ order, credentials, returnUrl, cancelUrl, business }) {
  const stripe = new Stripe(credentials.secretKey);

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [
      {
        price_data: {
          currency: String(order.currency || "npr").toLowerCase(),
          product_data: { name: order.item_name || `Order ${order.order_number || order.id}` },
          unit_amount: Math.round(Number(order.total_amount ?? order.amount) * 100),
        },
        quantity: 1,
      },
    ],
    success_url: returnUrl,
    cancel_url: cancelUrl,
    metadata: {
      business_id: String(business.id),
      order_id: String(order.id),
      order_number: String(order.order_number || ""),
    },
  });

  return {
    providerRef: session.id,
    paymentUrl: session.url,
    raw: { id: session.id, url: session.url, amount_total: session.amount_total },
  };
}

/**
 * Verifies a Checkout Session server-side. The webhook signature check is
 * performed by the caller (index.js / the webhook route) before this runs.
 */
export async function verify({ providerRef, amount, credentials }) {
  const stripe = new Stripe(credentials.secretKey);
  const session = await stripe.checkout.sessions.retrieve(providerRef);

  const paid = session.payment_status === "paid";
  const received = (session.amount_total || 0) / 100;
  const expected = Number(amount);

  // Amount and currency must match what the order says, otherwise the
  // payment belongs to a different transaction.
  const amountMatches = Math.abs(received - expected) < 0.005;

  return {
    verified: paid && amountMatches,
    status: paid ? (amountMatches ? "succeeded" : "requires_review") : "pending",
    amount: received,
    currency: String(session.currency || "").toUpperCase(),
    detail: paid
      ? amountMatches
        ? "Stripe Checkout Session completed and amount matches."
        : `Amount mismatch: Stripe reports ${received}, order expects ${expected}.`
      : `Stripe reports payment_status=${session.payment_status}.`,
    raw: {
      id: session.id,
      payment_status: session.payment_status,
      amount_total: session.amount_total,
      currency: session.currency,
    },
  };
}
