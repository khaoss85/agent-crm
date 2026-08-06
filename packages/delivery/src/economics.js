// @ts-check

import { ValidationError } from '../../core/index.js';

/**
 * Delivery economics arithmetic (Milestone 14).
 *
 * **These are delivery-management estimates, not accounting.** The vocabulary
 * is fixed and used identically in the code, the schema, the Admin and the
 * docs:
 *
 *   commercial delivery value   what the signed order priced this work at
 *   planned delivery cost       what the delivery team planned to spend
 *   actual delivery cost        what the recorded evidence says was spent
 *   operational margin estimate value minus actual cost, as an estimate
 *   variance to plan            actual cost minus planned cost
 *
 * Never: recognized revenue, accounting margin, invoice amount, profit.
 *
 * Money follows ADR-014 unchanged — integer minor units, safe integers,
 * uppercase three-letter currency shape. There is **no FX**, so two currencies
 * are never summed: every total is grouped by currency, and a group is a
 * complete answer for that currency alone.
 */

const CURRENCY_RE = /^[A-Z]{3}$/;
/** Every intermediate stays well inside the safe-integer range. */
export const MAX_MINOR_UNITS = 1_000_000_000_000;
export const MAX_MINUTES_PER_ENTRY = 24 * 60;
export const MAX_TOTAL_MINUTES = 100_000_000;

/** @param {unknown} value @param {string} field */
export function requireCurrency(value, field) {
  if (typeof value !== 'string' || !CURRENCY_RE.test(value)) {
    throw new ValidationError(`${field} must be a three-letter uppercase currency code`);
  }
  return value;
}

/**
 * A money amount in minor units. Bounded on both sides so no stored number can
 * push a later sum out of the safe-integer range.
 * @param {unknown} value @param {string} field @param {{allowNegative?: boolean}} [options]
 */
export function requireMinorUnits(value, field, options = {}) {
  if (!Number.isSafeInteger(value)) {
    throw new ValidationError(`${field} must be an integer number of minor units`);
  }
  const amount = Number(value);
  if (!options.allowNegative && amount < 0) throw new ValidationError(`${field} must not be negative`);
  if (Math.abs(amount) > MAX_MINOR_UNITS) {
    throw new ValidationError(`${field} must be within ±${MAX_MINOR_UNITS} minor units`);
  }
  return amount;
}

/** @param {unknown} value @param {string} field */
export function requireMinutes(value, field) {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new ValidationError(`${field} must be a positive whole number of minutes`);
  }
  if (Number(value) > MAX_MINUTES_PER_ENTRY) {
    throw new ValidationError(`${field} must be at most ${MAX_MINUTES_PER_ENTRY} minutes (one day) in a single entry`);
  }
  return Number(value);
}

/**
 * Add two minor-unit amounts, refusing the moment the result leaves the bounded
 * range. Silent overflow in money arithmetic is the failure mode worth being
 * loud about: it produces a plausible wrong number rather than an error.
 * @param {number} left @param {number} right @param {string} label
 */
export function addMinorUnits(left, right, label) {
  const total = left + right;
  if (!Number.isSafeInteger(total) || Math.abs(total) > MAX_MINOR_UNITS) {
    throw new ValidationError(`${label} exceeded the supported range for money arithmetic`);
  }
  return total;
}

/**
 * Cost of a duration at a rate. Checked before multiplying, so an absurd
 * product is refused rather than rounded.
 * @param {number} minutes @param {number} ratePerMinuteCents @param {string} label
 */
export function costOfMinutes(minutes, ratePerMinuteCents, label) {
  const product = minutes * ratePerMinuteCents;
  if (!Number.isSafeInteger(product) || product > MAX_MINOR_UNITS) {
    throw new ValidationError(`${label} exceeded the supported range for money arithmetic`);
  }
  return product;
}

/**
 * Compute grouped economics for one delivery project.
 *
 * Deterministic and pure: it is handed the evidence and returns the numbers.
 * Nothing here reads a clock, a database or a catalog, so a snapshot recomputed
 * from the same inputs years later is byte-identical.
 *
 * Every group is one currency. There is no grand total, because adding EUR to
 * USD would require a rate this framework deliberately does not have.
 *
 * @param {{
 *   workPackages: any[], plan: any|null, planLines: any[],
 *   timeEntries: any[], expenses: any[],
 * }} evidence
 */
export function computeEconomics({ workPackages, plan, planLines, timeEntries, expenses }) {
  /** @type {Map<string, any>} */
  const groups = new Map();
  const group = (currency) => {
    const key = requireCurrency(currency, 'currency');
    if (!groups.has(key)) {
      groups.set(key, {
        currency: key,
        commercialDeliveryValueCents: 0,
        plannedCostCents: 0,
        actualTimeCostCents: 0,
        actualExpenseCostCents: 0,
        actualPartnerCostCents: 0,
        totalActualCostCents: 0,
        operationalMarginEstimateCents: 0,
        varianceToPlanCents: 0,
        totalMinutes: 0,
        counts: { workPackages: 0, timeEntries: 0, expenses: 0, planLines: 0 },
      });
    }
    return groups.get(key);
  };

  // The commercial value is the snapshot M13 copied from the immutable M12
  // obligation. Never a live catalog read, never a client-supplied number.
  for (const wp of workPackages) {
    const bucket = group(wp.currency);
    bucket.commercialDeliveryValueCents = addMinorUnits(
      bucket.commercialDeliveryValueCents,
      requireMinorUnits(wp.netAmountCents, 'work package netAmountCents'),
      'commercial delivery value',
    );
    bucket.counts.workPackages += 1;
  }

  for (const line of planLines) {
    const bucket = group(line.currency);
    bucket.plannedCostCents = addMinorUnits(
      bucket.plannedCostCents,
      requireMinorUnits(line.plannedTotalCostCents, 'plan line plannedTotalCostCents'),
      'planned delivery cost',
    );
    bucket.counts.planLines += 1;
  }

  for (const entry of timeEntries) {
    const bucket = group(entry.currency);
    const cost = requireMinorUnits(entry.costCents, 'time entry costCents');
    bucket.actualTimeCostCents = addMinorUnits(bucket.actualTimeCostCents, cost, 'actual time cost');
    // Partner-delivered time is also counted separately, so a reader can see
    // how much of the actual cost is subcontracted without a second query.
    if (entry.partnerEngagementId) {
      bucket.actualPartnerCostCents = addMinorUnits(bucket.actualPartnerCostCents, cost, 'actual partner cost');
    }
    const minutes = requireMinutes(entry.minutes, 'time entry minutes');
    bucket.totalMinutes += minutes;
    if (bucket.totalMinutes > MAX_TOTAL_MINUTES) {
      throw new ValidationError('recorded minutes exceeded the supported range');
    }
    bucket.counts.timeEntries += 1;
  }

  for (const expense of expenses) {
    const bucket = group(expense.currency);
    const amount = requireMinorUnits(expense.amountCents, 'expense amountCents');
    bucket.actualExpenseCostCents = addMinorUnits(bucket.actualExpenseCostCents, amount, 'actual expense cost');
    if (expense.partnerEngagementId) {
      bucket.actualPartnerCostCents = addMinorUnits(bucket.actualPartnerCostCents, amount, 'actual partner cost');
    }
    bucket.counts.expenses += 1;
  }

  for (const bucket of groups.values()) {
    bucket.totalActualCostCents = addMinorUnits(
      bucket.actualTimeCostCents, bucket.actualExpenseCostCents, 'total actual delivery cost',
    );
    bucket.operationalMarginEstimateCents = addMinorUnits(
      bucket.commercialDeliveryValueCents, -bucket.totalActualCostCents, 'operational margin estimate',
    );
    bucket.varianceToPlanCents = addMinorUnits(
      bucket.totalActualCostCents, -bucket.plannedCostCents, 'variance to plan',
    );
  }

  return {
    basis: 'operational-delivery-estimate',
    note: ECONOMICS_NOTE,
    plan: plan ? { id: plan.id, version: plan.version, sourceKey: plan.sourceKey } : null,
    groups: [...groups.values()].sort((a, b) => (a.currency < b.currency ? -1 : 1)),
  };
}

export const ECONOMICS_NOTE =
  'Operational delivery-management estimates, not accounting: no revenue is recognized, no invoice amount is implied, '
  + 'no accounting margin is computed, and amounts are never converted or summed across currencies.';

export const ECONOMICS_BASIS = 'operational-delivery-estimate';
