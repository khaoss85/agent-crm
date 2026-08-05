// @ts-check

import { ValidationError } from './errors.js';

/**
 * Commercial money and discount arithmetic (ADR-016). The framework money
 * contract is unchanged from ADR-014: stored amounts are SAFE INTEGERS in
 * 1/100 currency units rendered with two decimals — deliberately not complete
 * ISO-4217 exponent support. Discounts are integer basis points (0–10000).
 *
 * Rounding policy, exact and documented: all inputs are non-negative safe
 * integers; `lineDiscount = trunc(lineSubtotal × bps ÷ 10000)` uses integer
 * division truncating toward zero, so a discount never rounds up;
 * `lineTotal = lineSubtotal − lineDiscount` is authoritative;
 * `netUnitAmount = trunc(listUnitAmount × (10000 − bps) ÷ 10000)` is stored as
 * informational per-unit rounding (netUnitAmount × quantity may differ from
 * lineTotal by sub-cent truncation). Every operation is overflow-checked:
 * a result outside the safe-integer range is a validation error, never a
 * silently wrong number.
 */

export const MAX_DISCOUNT_BPS = 10_000;
export const MAX_QUANTITY = 1_000_000;
const CURRENCY_RE = /^[A-Z]{3}$/;

/** @param {unknown} value @param {string} field — non-negative safe-integer amount */
export function requireAmount(value, field) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ValidationError(`${field} must be a non-negative safe integer in 1/100 currency units`, { field });
  }
  return value;
}

/** @param {unknown} value @param {string} field — integer basis points 0–10000 */
export function requireBps(value, field) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_DISCOUNT_BPS) {
    throw new ValidationError(`${field} must be an integer between 0 and ${MAX_DISCOUNT_BPS} basis points`, { field });
  }
  return value;
}

/** @param {unknown} value @param {string} field — positive bounded integer quantity */
export function requireQuantity(value, field) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_QUANTITY) {
    throw new ValidationError(`${field} must be an integer between 1 and ${MAX_QUANTITY}`, { field });
  }
  return value;
}

/** @param {unknown} value @param {string} field — uppercase ISO-shaped currency code */
export function requireCurrency(value, field = 'currency') {
  if (typeof value !== 'string' || !CURRENCY_RE.test(value)) {
    throw new ValidationError(`${field} must be an uppercase three-letter currency code`, { field });
  }
  return value;
}

/** Overflow-checked multiply of non-negative safe integers. */
export function checkedMultiply(a, b, field) {
  const result = a * b;
  if (!Number.isSafeInteger(result)) {
    throw new ValidationError(`${field} overflows the safe integer range`, { field });
  }
  return result;
}

/** Overflow-checked add of non-negative safe integers. */
export function checkedAdd(a, b, field) {
  const result = a + b;
  if (!Number.isSafeInteger(result)) {
    throw new ValidationError(`${field} overflows the safe integer range`, { field });
  }
  return result;
}

/**
 * Deterministic line arithmetic under the documented rounding policy.
 * @param {{listUnitAmountCents: unknown, quantity: unknown, discountBps: unknown}} input
 */
export function computeLineAmounts({ listUnitAmountCents, quantity, discountBps }) {
  const unit = requireAmount(listUnitAmountCents, 'listUnitAmountCents');
  const qty = requireQuantity(quantity, 'quantity');
  const bps = requireBps(discountBps ?? 0, 'discountBps');
  const lineSubtotalCents = checkedMultiply(unit, qty, 'lineSubtotalCents');
  const lineDiscountCents = Math.trunc(checkedMultiply(lineSubtotalCents, bps, 'lineDiscountCents') / MAX_DISCOUNT_BPS);
  const lineTotalCents = lineSubtotalCents - lineDiscountCents;
  const netUnitAmountCents = Math.trunc(checkedMultiply(unit, MAX_DISCOUNT_BPS - bps, 'netUnitAmountCents') / MAX_DISCOUNT_BPS);
  return { listUnitAmountCents: unit, quantity: qty, discountBps: bps, lineSubtotalCents, lineDiscountCents, lineTotalCents, netUnitAmountCents };
}

/**
 * Quote totals over active line amounts, with the effective discount in basis
 * points (`trunc(discountTotal × 10000 ÷ subtotal)`, 0 for an empty subtotal).
 * @param {Array<{lineSubtotalCents: number, lineDiscountCents: number, lineTotalCents: number, discountBps: number}>} lines
 */
export function computeQuoteTotals(lines) {
  let subtotalCents = 0;
  let discountCents = 0;
  let maxLineDiscountBps = 0;
  for (const line of lines) {
    subtotalCents = checkedAdd(subtotalCents, line.lineSubtotalCents, 'subtotalCents');
    discountCents = checkedAdd(discountCents, line.lineDiscountCents, 'discountCents');
    if (line.discountBps > maxLineDiscountBps) maxLineDiscountBps = line.discountBps;
  }
  const totalCents = subtotalCents - discountCents;
  const effectiveDiscountBps = subtotalCents > 0
    ? Math.trunc(checkedMultiply(discountCents, MAX_DISCOUNT_BPS, 'effectiveDiscountBps') / subtotalCents)
    : 0;
  return { subtotalCents, discountCents, totalCents, maxLineDiscountBps, effectiveDiscountBps };
}
