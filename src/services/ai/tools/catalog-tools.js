// src/services/ai/tools/catalog-tools.js
// Read-only tools over the catalogue and stock.

import { listProducts, getProduct, resolveProduct } from "../../catalog.js";
import { getStock, checkAvailability } from "../../inventory.js";
import { buildDraft } from "../../orders.js";
import { getBusinessConfig } from "../../businesses.js";
import { formatMoney } from "../../../core/money.js";

export async function searchProducts(ctx, args) {
  const limit = Math.min(Number(args.limit) || 10, 20);
  const products = listProducts(ctx.businessId, { search: args.query, limit });

  // If a plain catalogue search finds nothing, try the fuzzy resolver so
  // that "sari dress blue" still reaches "Blue Sari Dress".
  let candidates = products;
  if (candidates.length === 0) {
    const resolved = resolveProduct(ctx.businessId, args.query);
    candidates = resolved.candidates.length > 0 ? resolved.candidates : resolved.product ? [resolved.product] : [];
  }

  return {
    count: candidates.length,
    results: candidates.slice(0, limit).map((p) => ({
      id: p.id,
      name: p.name,
      sku: p.sku || "",
      type: p.type,
      unit: p.unit,
      price: p.price,
      priceFormatted: formatMoney(p.price, ctx.business.currency),
      taxRate: p.tax_rate,
      description: p.description || "",
      available: p.track_inventory ? getStock(ctx.businessId, p.id).available : null,
    })),
  };
}

export async function getProductDetails(ctx, args) {
  let product = null;
  if (args.productId) {
    try {
      product = getProduct(ctx.businessId, Number(args.productId));
    } catch {
      product = null;
    }
  }
  if (!product && args.name) {
    const resolved = resolveProduct(ctx.businessId, args.name);
    product = resolved.product;
  }
  if (!product) {
    return { found: false, message: "No catalogue item matched that." };
  }

  const stock = getStock(ctx.businessId, product.id);
  return {
    found: true,
    product: {
      id: product.id,
      name: product.name,
      sku: product.sku || "",
      type: product.type,
      category: product.category || "",
      description: product.description || "",
      unit: product.unit,
      price: product.price,
      priceFormatted: formatMoney(product.price, ctx.business.currency),
      taxRate: product.tax_rate,
      trackInventory: Boolean(product.track_inventory),
      available: product.track_inventory ? stock.available : null,
      variants: (product.variants || []).map((v) => ({
        id: v.id,
        name: v.name,
        price: v.price,
        priceFormatted: formatMoney(v.price, ctx.business.currency),
        available: product.track_inventory ? getStock(ctx.businessId, product.id, v.id).available : null,
      })),
    },
  };
}

export async function checkStock(ctx, args) {
  let product = null;
  if (args.productId) {
    try {
      product = getProduct(ctx.businessId, Number(args.productId));
    } catch {
      product = null;
    }
  }
  if (!product && args.name) {
    const resolved = resolveProduct(ctx.businessId, args.name);
    product = resolved.product;
  }
  if (!product) {
    return { found: false, available: null, canSupply: false, message: "No catalogue item matched that." };
  }

  const quantity = Number(args.quantity) || 1;
  const variantId = Number(args.variantId) || 0;
  const stock = getStock(ctx.businessId, product.id, variantId);
  const availability = checkAvailability(ctx.businessId, [
    { productId: product.id, variantId, quantity },
  ]);

  return {
    found: true,
    productId: product.id,
    productName: product.name,
    trackInventory: Boolean(product.track_inventory),
    onHand: stock.quantity_on_hand,
    reserved: stock.quantity_reserved,
    available: stock.available,
    requested: quantity,
    canSupply: availability.ok,
    message: product.track_inventory
      ? availability.ok
        ? `${stock.available} available.`
        : availability.problems.map((p) => p.message).join(" ")
      : "This item is not stock-tracked.",
  };
}

export async function calculateQuote(ctx, args) {
  const draft = buildDraft(ctx.businessId, { items: args.items || [], discountAmount: args.discountAmount });
  const currency = draft.currency || ctx.business.currency;

  return {
    ...draft.totals,
    currency,
    totalFormatted: formatMoney(draft.totals.total, currency),
    lines: draft.lines.map((l) => ({
      name: l.name,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      lineTotal: round(draft.totals.lines.find((t) => t.unitPrice === l.unitPrice)?.lineTotal ?? l.unitPrice * l.quantity),
    })),
    problems: draft.problems,
    pricedFrom: "catalogue",
  };
}

export async function getDeliveryOptions(ctx) {
  const business = getBusinessConfig(ctx.businessId);
  const hours = business.business_hours || {};

  return {
    deliveryFee: business.delivery_fee || 0,
    freeDeliveryAbove: business.delivery_free_above || 0,
    currency: business.currency,
    serviceArea: business.knowledge_base?.service_area || business.knowledge_base?.delivery_area || "",
    deliveryAreas: business.knowledge_base?.delivery_zones || "",
    businessHours: hours,
    note:
      business.delivery_fee > 0
        ? `Delivery costs ${formatMoney(business.delivery_fee, business.currency)}${
            business.delivery_free_above > 0
              ? ` (free above ${formatMoney(business.delivery_free_above, business.currency)})`
              : ""
          }.`
        : "Delivery is free.",
  };
}

function round(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}
