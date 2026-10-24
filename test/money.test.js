// test/money.test.js
// Price, tax and delivery arithmetic.
//
// These calculations decide what a customer is charged, so they are tested
// against the cases that historically break naive implementations:
// inclusive tax, order-level discounts, rounding, and free delivery
// thresholds.

import test from "node:test";
import assert from "node:assert/strict";
import { computeTotals, computeTax, computeDelivery, roundMoney, formatMoney } from "../src/core/money.js";

test("roundMoney rounds to two decimals, half up", () => {
  assert.equal(roundMoney(10.005), 10.01);
  assert.equal(roundMoney(0.1 + 0.2), 0.3);
  assert.equal(roundMoney(1234.567), 1234.57);
});

test("computeTax adds tax when prices are exclusive", () => {
  assert.equal(computeTax(1000, 0.13, false), 130);
  assert.equal(computeTax(1000, 0.13, true), 115.04);
});

test("totals of a single line", () => {
  const totals = computeTotals([{ quantity: 2, unitPrice: 250 }]);
  assert.equal(totals.subtotal, 500);
  assert.equal(totals.taxAmount, 0);
  assert.equal(totals.total, 500);
});

test("tax is applied per line when lines have different rates", () => {
  const totals = computeTotals(
    [
      { quantity: 1, unitPrice: 1000, taxRate: 0.13 },
      { quantity: 1, unitPrice: 1000, taxRate: 0 },
    ],
    { taxRate: 0.13 }
  );
  assert.equal(totals.subtotal, 2000);
  assert.equal(totals.taxAmount, 130);
  assert.equal(totals.total, 2130);
});

test("an order-level discount reduces the taxable base", () => {
  const withoutDiscount = computeTotals([{ quantity: 1, unitPrice: 1000, taxRate: 0.13 }]);
  const withDiscount = computeTotals([{ quantity: 1, unitPrice: 1000, taxRate: 0.13 }], { discountAmount: 200 });

  assert.equal(withDiscount.subtotal, 1000);
  assert.equal(withDiscount.discountAmount, 200);
  // 13% of the discounted 800, not of the original 1000.
  assert.equal(withDiscount.taxAmount, 104);
  assert.equal(withDiscount.total, 904);
  assert.ok(withDiscount.total < withoutDiscount.total);
});

test("delivery is added after tax", () => {
  const totals = computeTotals(
    [{ quantity: 1, unitPrice: 1000, taxRate: 0.1 }],
    { deliveryAmount: 50 }
  );
  assert.equal(totals.taxAmount, 100);
  assert.equal(totals.deliveryAmount, 50);
  assert.equal(totals.total, 1150);
});

test("delivery is free above the configured threshold", () => {
  const business = { delivery_fee: 100, delivery_free_above: 1000 };
  assert.equal(computeDelivery(business, 999), 100);
  assert.equal(computeDelivery(business, 1000), 0);
  assert.equal(computeDelivery(business, 5000), 0);
});

test("delivery costs nothing when no fee is configured", () => {
  assert.equal(computeDelivery({ delivery_fee: 0 }, 100), 0);
});

test("a zero quantity line never produces a negative total", () => {
  const totals = computeTotals([{ quantity: 0, unitPrice: 500 }]);
  assert.equal(totals.total, 0);
});

test("discounts larger than the subtotal cannot make the total negative", () => {
  const totals = computeTotals([{ quantity: 1, unitPrice: 100 }], { discountAmount: 500 });
  assert.equal(totals.total, 0);
});

test("formatMoney renders rupees with separators", () => {
  assert.equal(formatMoney(1234.5, "NPR"), "Rs. 1,234.50");
});
