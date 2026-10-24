// src/core/money.js
// Money arithmetic for ChatCloser.
//
// All calculations happen in minor units (paisa) and are converted back to
// major units (rupees) at the boundary, so a 13% tax on 999.99 never
// drifts by a paisa between the quote, the order, the invoice and the
// receipt. Everything the AI quotes and everything the customer is charged
// comes from this module — the model never does arithmetic on prices.

export const MINOR_UNITS = 100;

/** Converts a major-unit amount (e.g. rupees) into integer paisa. */
export function toMinor(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * MINOR_UNITS);
}

/** Converts integer paisa back into a major-unit amount rounded to 2 dp. */
export function toMajor(minor) {
  return Math.round(minor) / MINOR_UNITS;
}

/** Rounds a major-unit amount to 2 decimal places using half-up rounding. */
export function roundMoney(amount) {
  return toMajor(toMinor(amount));
}

/**
 * Computes a tax amount from a taxable base.
 * @param {number} base minor-unit-safe major amount the tax applies to
 * @param {number} rate tax rate as a fraction (0.13 for 13%)
 * @param {boolean} inclusive true when `base` already contains the tax
 */
export function computeTax(base, rate, inclusive = false) {
  const r = Number(rate) || 0;
  if (r <= 0) return 0;
  if (inclusive) {
    // base = net + tax, net = base / (1 + r), tax = base - net
    const net = toMinor(base) / (1 + r);
    return toMajor(Math.round(toMinor(base) - net));
  }
  return roundMoney(base * r);
}

/**
 * The single source of truth for order/quotation/invoice totals.
 *
 * @param {object} input
 * @param {Array<{quantity:number, unitPrice:number, discountAmount?:number, taxRate?:number}>} input.items
 * @param {object} [input.options]
 * @param {number} [input.options.discountAmount] order-level discount
 * @param {number} [input.options.deliveryAmount] delivery charge
 * @param {number} [input.options.taxRate] fallback tax rate (per line wins)
 * @param {boolean} [input.options.taxInclusive] prices already include tax
 */
export function computeTotals(items = [], options = {}) {
  const {
    discountAmount = 0,
    deliveryAmount = 0,
    taxRate = 0,
    taxInclusive = false,
  } = options;

  let subtotalMinor = 0;
  let lineDiscountMinor = 0;
  let taxMinor = 0;

  const lines = items.map((item) => {
    const quantity = Number(item.quantity) || 0;
    const unitPrice = Number(item.unitPrice) || 0;
    const gross = toMinor(unitPrice) * quantity;
    const discount = toMinor(item.discountAmount || 0);
    const net = Math.max(0, gross - discount);

    const lineTaxRate = item.taxRate !== undefined && item.taxRate !== null
      ? Number(item.taxRate)
      : Number(taxRate) || 0;

    const tax = computeTax(toMajor(net), lineTaxRate, taxInclusive);

    subtotalMinor += gross;
    lineDiscountMinor += discount;
    taxMinor += toMinor(tax);

    return {
      quantity,
      unitPrice: roundMoney(unitPrice),
      discountAmount: roundMoney(discount),
      taxRate: lineTaxRate,
      taxAmount: roundMoney(tax),
      lineTotal: toMajor(net + toMinor(tax)),
      net: toMajor(net),
    };
  });

  const orderDiscountMinor = toMinor(discountAmount);

  // An order-level discount is spread across the lines so that the tax
  // base shrinks proportionally. Without this, an order-level discount
  // would still be charged tax on the pre-discount amount.
  const discountBase = Math.max(0, subtotalMinor - lineDiscountMinor);
  let effectiveTaxMinor = taxMinor;
  if (orderDiscountMinor > 0 && discountBase > 0) {
    const ratio = (discountBase - orderDiscountMinor) / discountBase;
    effectiveTaxMinor = Math.round(taxMinor * Math.max(0, ratio));
  }

  const deliveryMinor = toMinor(deliveryAmount);
  const totalMinor = Math.max(0, discountBase - orderDiscountMinor) + effectiveTaxMinor + deliveryMinor;

  return {
    lines,
    subtotal: toMajor(subtotalMinor),
    discountAmount: toMajor(lineDiscountMinor + orderDiscountMinor),
    taxAmount: toMajor(effectiveTaxMinor),
    deliveryAmount: toMajor(deliveryMinor),
    total: toMajor(totalMinor),
  };
}

/**
 * Applies the business's delivery rules.
 * @param {object} business business row (needs delivery_fee / delivery_free_above)
 * @param {number} orderTotal
 */
export function computeDelivery(business, orderTotal) {
  const fee = Number(business?.delivery_fee) || 0;
  const freeAbove = Number(business?.delivery_free_above) || 0;
  if (fee <= 0) return 0;
  if (freeAbove > 0 && orderTotal >= freeAbove) return 0;
  return roundMoney(fee);
}

/** Formats an amount for display, e.g. "Rs. 1,234.50". */
export function formatMoney(amount, currency = "NPR") {
  const n = roundMoney(amount);
  if (currency === "NPR" || currency === "NRs") {
    return `Rs. ${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  return `${currency} ${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
