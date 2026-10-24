// src/services/ai/tools/legacy-tools.js
// The two tools ChatCloser 1.x exposed to the model. They are kept so an
// existing business does not lose behaviour, but the AI engine prefers the
// order-draft / explicit-confirmation tools.

import { createLead } from "../../../../db.js";
import { getPriceItemByName, createOrder as createLegacyOrder, attachStripeSession } from "../../../../db.js";
import { resolveProduct } from "../../catalog.js";
import { decrypt } from "../../../../crypto-utils.js";
import { getBusinessConfig } from "../../businesses.js";

export async function captureLead(ctx, args) {
  const lead = createLead(ctx.businessId, ctx.chatId || "", {
    customer_name: args.customer_name,
    contact_number: args.contact_number,
    service_requested: args.service_requested,
    location: args.location,
    urgency: args.urgency,
    preferred_date: args.preferred_date,
    notes: args.notes,
  });

  return { ok: true, leadId: lead.id };
}

export async function closeSale(ctx, args) {
  const business = getBusinessConfig(ctx.businessId);

  // The price always comes from the catalogue, never from the model.
  let item = null;
  const legacy = getPriceItemByName(ctx.businessId, args.item_name);
  if (legacy) {
    item = { id: legacy.product_id, name: legacy.item_name, price: legacy.price_amount, currency: legacy.currency };
  } else {
    const resolved = resolveProduct(ctx.businessId, args.item_name);
    if (resolved.product) {
      item = {
        id: resolved.product.id,
        name: resolved.product.name,
        price: resolved.product.price,
        currency: business.currency,
      };
    }
  }

  if (!item) {
    return { ok: false, message: "That item is not in the price list, so no payment link was created." };
  }

  const order = createLegacyOrder(ctx.businessId, ctx.chatId || "", null, {
    item_name: item.name,
    amount: item.price,
    currency: item.currency || business.currency,
  });

  // Only Stripe can be driven from here without a provider-specific
  // adapter; other providers go through the payments service.
  let paymentUrl = null;
  if (business.stripe_secret_key_encrypted) {
    try {
      const Stripe = (await import("stripe")).default;
      const stripe = new Stripe(decrypt(business.stripe_secret_key_encrypted));
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        line_items: [
          {
            price_data: {
              currency: String(item.currency || "npr").toLowerCase(),
              product_data: { name: item.name },
              unit_amount: Math.round(item.price * 100),
            },
            quantity: 1,
          },
        ],
        success_url: "https://example.com/payment-success",
        cancel_url: "https://example.com/payment-cancelled",
        metadata: { business_id: String(ctx.businessId), order_id: String(order.id) },
      });
      attachStripeSession(order.id, { stripeSessionId: session.id, paymentUrl: session.url });
      paymentUrl = session.url;
    } catch {
      paymentUrl = null;
    }
  }

  return {
    ok: true,
    orderId: order.id,
    amount: item.price,
    currency: item.currency || business.currency,
    paymentUrl,
    message: paymentUrl
      ? "A payment link was created for the verified catalogue price."
      : "The order was recorded. A payment link will be sent once a payment provider is configured.",
  };
}
