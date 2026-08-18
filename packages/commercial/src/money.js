// @ts-check

import {
  ValidationError,
  requireAmount,
  requireBps,
  requireQuantity,
  MAX_QUANTITY,
} from '../../core/index.js';

/**
 * Commercial money, discount and tier arithmetic (ADR-016).
 *
 * Money contract (unchanged from ADR-014): stored amounts are SAFE INTEGERS in
 * 1/100 currency units rendered with two decimals — deliberately not complete
 * ISO-4217 exponent support. Discounts are integer basis points (0–10000).
 * Every authoritative calculation is integer-only and overflow-checked: a
 * result outside the safe-integer range is a validation error, never a
 * silently wrong number. No floating point is used for any persisted amount.
 *
 * Rounding policy, exact and documented:
 *   componentList = per the pricing model below (integer arithmetic only)
 *   componentDiscount = trunc(componentList × bps ÷ 10000)   (never rounds up)
 *   componentNet      = componentList − componentDiscount     (authoritative)
 * A quote line's amounts are the checked sums of its components' amounts;
 * quote totals are the checked sums of line component amounts GROUPED by
 * commercial period (see groupComponentTotals) — unlike periods are never
 * added together.
 *
 * The domain-neutral value bounds (`requireAmount`, `requireBps`,
 * `requireQuantity` and the charge/pricing vocabulary) are the kernel's
 * ADR-014 money contract, imported from public core. Everything in this file
 * is Commercial's own pricing *semantics* and moved here with the extraction,
 * function bodies unchanged.
 */

/** The same spec constant `requireBps` is defined by (basis points per unit). */
export const MAX_DISCOUNT_BPS = 10_000;
export const MAX_TIERS = 50;
const CURRENCY_RE = /^[A-Z]{3}$/;

import { CHARGE_TYPES, PRICING_MODELS, RECURRING_INTERVALS, MAX_INTERVAL_COUNT } from '../../core/index.js';

// Re-published from the kernel contract so importers of this module keep one
// import site for the whole money vocabulary.
export { requireAmount, requireBps, requireQuantity, MAX_QUANTITY };
export { CHARGE_TYPES, PRICING_MODELS, RECURRING_INTERVALS, MAX_INTERVAL_COUNT };

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
 * Validate a tier schedule for a volume/graduated component.
 *
 * Representation (documented): tiers are ordered ascending; each tier's
 * `upTo` is the INCLUSIVE upper bound of its band and the implicit lower bound
 * is the previous tier's `upTo + 1`, so the first band always starts at
 * quantity 1 and the schedule is gap-free and overlap-free by construction.
 * Exactly one final tier carries `upTo: null` (open-ended). Amounts are
 * non-negative safe integers; `flatAmountCents` is optional and explicit.
 *
 * @param {unknown} tiers @param {string} label
 */
export function validateTierSchedule(tiers, label) {
  if (!Array.isArray(tiers) || tiers.length === 0) {
    throw new ValidationError(`${label}: volume and graduated components need a non-empty tier schedule`);
  }
  if (tiers.length > MAX_TIERS) {
    throw new ValidationError(`${label}: at most ${MAX_TIERS} tiers are supported`);
  }
  let previousUpTo = 0;
  let sawOpenEnded = false;
  const normalized = [];
  tiers.forEach((tier, index) => {
    if (!tier || typeof tier !== 'object' || Array.isArray(tier)) {
      throw new ValidationError(`${label}: tier ${index + 1} must be an object`);
    }
    if (sawOpenEnded) {
      throw new ValidationError(`${label}: the open-ended tier (upTo null) must be last`);
    }
    const upTo = tier.upTo === undefined ? null : tier.upTo;
    if (upTo === null) {
      sawOpenEnded = true;
    } else {
      if (!Number.isSafeInteger(upTo) || upTo < 1 || upTo > MAX_QUANTITY) {
        throw new ValidationError(`${label}: tier ${index + 1} upTo must be a positive integer up to ${MAX_QUANTITY}, or null for the final open-ended tier`);
      }
      if (upTo <= previousUpTo) {
        throw new ValidationError(`${label}: tier boundaries must strictly increase (tier ${index + 1} upTo ${upTo} follows ${previousUpTo})`);
      }
      previousUpTo = upTo;
    }
    const unitAmountCents = requireAmount(tier.unitAmountCents ?? 0, `${label}: tier ${index + 1} unitAmountCents`);
    const flatAmountCents = requireAmount(tier.flatAmountCents ?? 0, `${label}: tier ${index + 1} flatAmountCents`);
    normalized.push({ position: index + 1, upTo, unitAmountCents, flatAmountCents });
  });
  if (!sawOpenEnded) {
    throw new ValidationError(`${label}: the last tier must be open-ended (upTo null) so every quantity is priced`);
  }
  return normalized;
}

/**
 * Validate one price component definition and return its normalized form.
 * Rejects incoherent combinations rather than approximating them.
 * @param {any} component @param {string} label
 */
export function validatePriceComponent(component, label) {
  if (!component || typeof component !== 'object') {
    throw new ValidationError(`${label} must be an object`);
  }
  if (!CHARGE_TYPES.includes(component.chargeType)) {
    throw new ValidationError(`${label}: chargeType must be one of: ${CHARGE_TYPES.join(', ')}`);
  }
  if (!PRICING_MODELS.includes(component.pricingModel)) {
    throw new ValidationError(`${label}: pricingModel must be one of: ${PRICING_MODELS.join(', ')}`);
  }
  const recurring = component.chargeType === 'recurring';
  const interval = component.interval ?? null;
  const intervalCount = component.intervalCount ?? null;
  if (recurring) {
    if (!RECURRING_INTERVALS.includes(interval)) {
      throw new ValidationError(`${label}: recurring components need interval "${RECURRING_INTERVALS.join('" or "')}"`);
    }
    if (!Number.isSafeInteger(intervalCount) || intervalCount < 1 || intervalCount > MAX_INTERVAL_COUNT) {
      throw new ValidationError(`${label}: recurring components need an intervalCount between 1 and ${MAX_INTERVAL_COUNT}`);
    }
  } else {
    if (interval !== null || intervalCount !== null) {
      throw new ValidationError(`${label}: one_time components must not declare interval or intervalCount`);
    }
  }
  const tiered = component.pricingModel === 'volume' || component.pricingModel === 'graduated';
  let tiers = [];
  if (tiered) {
    tiers = validateTierSchedule(component.tiers, label);
    if (component.unitAmountCents !== undefined && component.unitAmountCents !== null) {
      throw new ValidationError(`${label}: tiered components carry their amounts in tiers, not unitAmountCents`);
    }
  } else {
    if (Array.isArray(component.tiers) && component.tiers.length > 0) {
      throw new ValidationError(`${label}: only volume and graduated components may declare tiers`);
    }
    if (component.pricingModel === 'per_unit') {
      requireAmount(component.unitAmountCents, `${label}: unitAmountCents`);
      if (component.flatAmountCents !== undefined && component.flatAmountCents !== null && component.flatAmountCents !== 0) {
        throw new ValidationError(`${label}: per_unit components price by unitAmountCents; flatAmountCents is not supported`);
      }
    } else {
      // flat_fee
      requireAmount(component.flatAmountCents, `${label}: flatAmountCents`);
      if (component.unitAmountCents !== undefined && component.unitAmountCents !== null && component.unitAmountCents !== 0) {
        throw new ValidationError(`${label}: flat_fee components price by flatAmountCents; unitAmountCents is not supported`);
      }
    }
  }
  return {
    chargeType: component.chargeType,
    pricingModel: component.pricingModel,
    interval: recurring ? interval : null,
    intervalCount: recurring ? intervalCount : null,
    unitAmountCents: component.pricingModel === 'per_unit' ? component.unitAmountCents : null,
    flatAmountCents: component.pricingModel === 'flat_fee' ? component.flatAmountCents : null,
    tiers,
  };
}

/**
 * Deterministic list amount for one component at a quantity, with a tier
 * breakdown for explainability.
 *
 * Quantity semantics (documented, ADR-016):
 *   flat_fee  — charged ONCE per quote line; the line quantity does NOT
 *               multiply it;
 *   per_unit  — unitAmount × quantity;
 *   volume    — the single tier whose band contains the total quantity prices
 *               the ENTIRE quantity, plus that tier's flatAmount once;
 *   graduated — each band prices the quantity that falls inside it, plus that
 *               band's flatAmount once for every band that receives quantity.
 *
 * @param {{pricingModel: string, unitAmountCents: number|null, flatAmountCents: number|null, tiers: Array<{position: number, upTo: number|null, unitAmountCents: number, flatAmountCents: number}>}} component
 * @param {number} quantity
 */
export function computeComponentAmount(component, quantity) {
  const qty = requireQuantity(quantity, 'quantity');
  const field = `component ${component.pricingModel}`;
  if (component.pricingModel === 'flat_fee') {
    const amount = requireAmount(component.flatAmountCents ?? 0, 'flatAmountCents');
    return {
      listAmountCents: amount,
      quantityPriced: 0, // flat fees are quantity-independent
      tierBreakdown: [],
    };
  }
  if (component.pricingModel === 'per_unit') {
    const unit = requireAmount(component.unitAmountCents ?? 0, 'unitAmountCents');
    return {
      listAmountCents: checkedMultiply(unit, qty, field),
      quantityPriced: qty,
      tierBreakdown: [],
    };
  }
  const tiers = component.tiers ?? [];
  if (tiers.length === 0) {
    throw new ValidationError('A tiered component needs a tier schedule', { field: 'tiers' });
  }
  if (component.pricingModel === 'volume') {
    const tier = tiers.find((candidate) => candidate.upTo === null || qty <= candidate.upTo);
    if (!tier) {
      throw new ValidationError('No tier covers the requested quantity', { field: 'quantity' });
    }
    const units = checkedMultiply(tier.unitAmountCents, qty, field);
    const listAmountCents = checkedAdd(units, tier.flatAmountCents, field);
    return {
      listAmountCents,
      quantityPriced: qty,
      tierBreakdown: [{
        position: tier.position,
        from: 1,
        to: tier.upTo,
        quantity: qty,
        unitAmountCents: tier.unitAmountCents,
        flatAmountCents: tier.flatAmountCents,
        amountCents: listAmountCents,
      }],
    };
  }
  // graduated
  let remaining = qty;
  let lowerBound = 1;
  let listAmountCents = 0;
  const tierBreakdown = [];
  for (const tier of tiers) {
    if (remaining <= 0) break;
    const bandCapacity = tier.upTo === null ? remaining : tier.upTo - lowerBound + 1;
    const bandQuantity = Math.min(remaining, bandCapacity);
    if (bandQuantity > 0) {
      const units = checkedMultiply(tier.unitAmountCents, bandQuantity, field);
      const bandAmount = checkedAdd(units, tier.flatAmountCents, field);
      listAmountCents = checkedAdd(listAmountCents, bandAmount, field);
      tierBreakdown.push({
        position: tier.position,
        from: lowerBound,
        to: tier.upTo,
        quantity: bandQuantity,
        unitAmountCents: tier.unitAmountCents,
        flatAmountCents: tier.flatAmountCents,
        amountCents: bandAmount,
      });
      remaining -= bandQuantity;
      lowerBound += bandQuantity;
    }
  }
  if (remaining > 0) {
    throw new ValidationError('The tier schedule does not cover the requested quantity', { field: 'quantity' });
  }
  return { listAmountCents, quantityPriced: qty, tierBreakdown };
}

/**
 * Apply a line's requested discount to one component's list amount.
 * Discount is computed AFTER tier/list calculation (documented v1 policy: the
 * line's basis points apply uniformly to every component of the line).
 * @param {number} listAmountCents @param {number} discountBps
 */
export function applyDiscount(listAmountCents, discountBps) {
  const list = requireAmount(listAmountCents, 'listAmountCents');
  const bps = requireBps(discountBps, 'discountBps');
  const discountAmountCents = Math.trunc(checkedMultiply(list, bps, 'discountAmountCents') / MAX_DISCOUNT_BPS);
  return { listAmountCents: list, discountAmountCents, netAmountCents: list - discountAmountCents };
}

/**
 * Price a whole quote line: every component of the selected offer at the line
 * quantity, with the line discount applied per component.
 * @param {{components: any[], quantity: number, discountBps: number}} input
 */
export function computeLineBreakdown({ components, quantity, discountBps }) {
  const qty = requireQuantity(quantity, 'quantity');
  const bps = requireBps(discountBps ?? 0, 'discountBps');
  const breakdown = [];
  let listAmountCents = 0;
  let discountAmountCents = 0;
  for (const component of components) {
    const amounts = computeComponentAmount(component, qty);
    const discounted = applyDiscount(amounts.listAmountCents, bps);
    listAmountCents = checkedAdd(listAmountCents, discounted.listAmountCents, 'line listAmountCents');
    discountAmountCents = checkedAdd(discountAmountCents, discounted.discountAmountCents, 'line discountAmountCents');
    breakdown.push({
      componentId: component.id ?? null,
      componentKey: component.sourceKey ?? null,
      label: component.label ?? component.name ?? null,
      chargeType: component.chargeType,
      pricingModel: component.pricingModel,
      interval: component.interval ?? null,
      intervalCount: component.intervalCount ?? null,
      quantity: amounts.quantityPriced,
      unitAmountCents: component.unitAmountCents ?? null,
      flatAmountCents: component.flatAmountCents ?? null,
      tierBreakdown: amounts.tierBreakdown,
      listAmountCents: discounted.listAmountCents,
      discountAmountCents: discounted.discountAmountCents,
      netAmountCents: discounted.netAmountCents,
    });
  }
  return {
    components: breakdown,
    listAmountCents,
    discountAmountCents,
    netAmountCents: listAmountCents - discountAmountCents,
  };
}

/**
 * Group component amounts into commercial periods. **Unlike periods are never
 * summed**: the result is one one-time group plus one group per
 * (currency, interval, intervalCount). There is deliberately no single grand
 * total, and no ARR/MRR/TCV — contract term and normalization policy are not
 * modeled (ADR-016).
 *
 * @param {Array<{chargeType: string, interval: string|null, intervalCount: number|null, listAmountCents: number, discountAmountCents: number, netAmountCents: number}>} components
 * @param {string} currency
 */
export function groupComponentTotals(components, currency) {
  requireCurrency(currency);
  let oneTime = { currency, listAmountCents: 0, discountAmountCents: 0, netAmountCents: 0 };
  /** @type {Map<string, any>} */
  const recurring = new Map();
  for (const component of components) {
    if (component.chargeType === 'one_time') {
      oneTime = {
        currency,
        listAmountCents: checkedAdd(oneTime.listAmountCents, component.listAmountCents, 'oneTime listAmountCents'),
        discountAmountCents: checkedAdd(oneTime.discountAmountCents, component.discountAmountCents, 'oneTime discountAmountCents'),
        netAmountCents: checkedAdd(oneTime.netAmountCents, component.netAmountCents, 'oneTime netAmountCents'),
      };
      continue;
    }
    const key = `${currency}|${component.interval}|${component.intervalCount}`;
    const current = recurring.get(key) ?? {
      currency,
      interval: component.interval,
      intervalCount: component.intervalCount,
      listAmountCents: 0,
      discountAmountCents: 0,
      netAmountCents: 0,
    };
    recurring.set(key, {
      ...current,
      listAmountCents: checkedAdd(current.listAmountCents, component.listAmountCents, 'recurring listAmountCents'),
      discountAmountCents: checkedAdd(current.discountAmountCents, component.discountAmountCents, 'recurring discountAmountCents'),
      netAmountCents: checkedAdd(current.netAmountCents, component.netAmountCents, 'recurring netAmountCents'),
    });
  }
  const order = { month: 0, year: 1 };
  const recurringTotals = [...recurring.values()].sort((a, b) => (
    order[a.interval] === order[b.interval] ? a.intervalCount - b.intervalCount : order[a.interval] - order[b.interval]
  ));
  return { oneTimeTotal: oneTime, recurringTotals };
}

/** The maximum requested discount across a set of line records. */
export function maxLineDiscountBps(lines) {
  let max = 0;
  for (const line of lines) if ((line.discountBps ?? 0) > max) max = line.discountBps;
  return max;
}

/**
 * Effective discount across every group (list vs net), in basis points. Uses
 * the summed LIST and DISCOUNT amounts across all periods purely as a
 * discount-intensity signal for policy evaluation — it is NOT a monetary
 * total and is never displayed as one.
 */
export function effectiveDiscountBps({ oneTimeTotal, recurringTotals }) {
  let list = oneTimeTotal.listAmountCents;
  let discount = oneTimeTotal.discountAmountCents;
  for (const group of recurringTotals) {
    list = checkedAdd(list, group.listAmountCents, 'effective list');
    discount = checkedAdd(discount, group.discountAmountCents, 'effective discount');
  }
  if (list <= 0) return 0;
  return Math.trunc(checkedMultiply(discount, MAX_DISCOUNT_BPS, 'effectiveDiscountBps') / list);
}
