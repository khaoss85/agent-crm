// @ts-check

import { ValidationError } from './errors.js';

/**
 * The framework money contract (ADR-014/016): the domain-neutral value bounds
 * every package prices and stores against.
 *
 * Stored amounts are SAFE INTEGERS in 1/100 currency units rendered with two
 * decimals — deliberately not complete ISO-4217 exponent support. Discounts
 * are integer basis points (0–10000). Quantities are bounded positive
 * integers.
 *
 * This module holds exactly the bounds `packages/core/index.js` has always
 * published to packages. It carries no pricing *semantics*: tier schedules,
 * component amounts, discount application and grouped totals are Commercial
 * Operations' own arithmetic and live in the commercial package
 * (`packages/commercial/src/money.js`). The split is the same judgement the
 * neutral-helper move made for `computeDefinitionFingerprint` and
 * `withTimeout`: neutrality is assessed by what a function does, not where it
 * historically sat.
 */

export const MAX_DISCOUNT_BPS = 10_000;
export const MAX_QUANTITY = 1_000_000;
export const CHARGE_TYPES = Object.freeze(['one_time', 'recurring']);
export const PRICING_MODELS = Object.freeze(['flat_fee', 'per_unit', 'volume', 'graduated']);
export const RECURRING_INTERVALS = Object.freeze(['month', 'year']);
export const MAX_INTERVAL_COUNT = 60;

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
