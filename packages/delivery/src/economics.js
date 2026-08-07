// @ts-check

import { ValidationError } from '../../core/index.js';

/**
 * Delivery economics arithmetic (Milestone 14).
 *
 * **These are delivery-management estimates, not accounting.** The vocabulary
 * is fixed and used identically in the code, the schema, the Admin and the
 * docs:
 *
 *   one-time commercial value   what the signed order priced the *one-time*
 *                               delivery obligations at
 *   planned delivery cost       what the delivery team planned to spend
 *   actual delivery cost        what the recorded evidence says was spent
 *   contribution estimate       one-time value minus actual cost, as an estimate
 *   variance to plan            actual cost minus planned cost
 *
 * Never: recognized revenue, accounting margin, invoice amount, profit, ARR,
 * MRR or TCV.
 *
 * Money follows ADR-014 unchanged — integer minor units, safe integers,
 * uppercase three-letter currency shape. There is **no FX**, so two currencies
 * are never summed: every total is grouped by currency, and a group is a
 * complete answer for that currency alone.
 *
 * There is also **no term arithmetic**. A recurring delivery obligation prices
 * one period, and the execution costs recorded against a project are a one-time
 * spend to date. Subtracting the second from the first produces a number with
 * no meaning, so this milestone refuses to produce it: recurring commercial
 * input is preserved as evidence, grouped by charge type, interval and interval
 * count, and the contribution estimate for that currency is reported as
 * unavailable with a reason. Nothing is annualized, normalized or summed across
 * periods.
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

/**
 * Planned minutes on a plan *line*. A line budgets a whole stream of work, so
 * it is bounded by the project-scale limit rather than the one-entry limit: a
 * plan that cannot express more than one day of work is not a plan.
 * @param {unknown} value @param {string} field
 */
export function requirePlannedMinutes(value, field) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new ValidationError(`${field} must be a non-negative whole number of minutes`);
  }
  if (Number(value) > MAX_TOTAL_MINUTES) {
    throw new ValidationError(`${field} must be at most ${MAX_TOTAL_MINUTES} minutes`);
  }
  return Number(value);
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
 * The cost of a duration at an hourly rate:
 *
 * ```text
 * cost = roundHalfUp(ratePerHourCents × minutes / 60)
 * ```
 *
 * Integer arithmetic throughout. The product is checked *before* the division,
 * so an absurd input is refused rather than rounded into something plausible,
 * and the rounding rule is stated here and on the wire rather than left to
 * whichever floating-point path a reader assumes.
 *
 * Half-up on a non-negative numerator: `(product * 2 + 60) / 120` floored is
 * the same value with no float anywhere near it.
 *
 * @param {number} minutes @param {number} ratePerHourCents @param {string} label
 */
export function costOfMinutes(minutes, ratePerHourCents, label) {
  if (!Number.isSafeInteger(minutes) || minutes < 0) {
    throw new ValidationError(`${label}: minutes must be a non-negative whole number`);
  }
  if (!Number.isSafeInteger(ratePerHourCents) || ratePerHourCents < 0) {
    throw new ValidationError(`${label}: ratePerHourCents must be a non-negative whole number`);
  }
  const product = minutes * ratePerHourCents;
  if (!Number.isSafeInteger(product) || product > MAX_MINOR_UNITS * 60) {
    throw new ValidationError(`${label} exceeded the supported range for money arithmetic`);
  }
  const cost = Math.floor((product * 2 + 60) / 120);
  if (!Number.isSafeInteger(cost) || cost > MAX_MINOR_UNITS) {
    throw new ValidationError(`${label} exceeded the supported range for money arithmetic`);
  }
  return cost;
}

/** The rounding rule, published so nobody has to infer it from a number. */
export const ROUNDING_RULE = 'cost = roundHalfUp(ratePerHourCents × minutes / 60), computed in integers throughout';

/** The charge types a work-package snapshot may carry (M12/M13 vocabulary). */
const CHARGE_TYPES = ['one_time', 'recurring'];

/**
 * The basis a contribution estimate was computed on, published on every group
 * so no reader has to infer it from whether a number happens to be null.
 */
export const CONTRIBUTION_BASIS = {
  /** Every commercial input in this currency is a one-time amount. */
  ONE_TIME: 'one_time',
  /** No estimate is defensible; `contributionUnavailableReason` says why. */
  UNAVAILABLE: 'unavailable',
};

export const CONTRIBUTION_UNAVAILABLE_REASONS = {
  /**
   * At least one delivery obligation prices a *period*, not the engagement.
   * Recorded execution cost is a spend-to-date, so there is no term over which
   * the two are comparable. Normalizing would require contract-term semantics
   * this framework does not have.
   */
  RECURRING_COMMERCIAL_INPUT: 'recurring_commercial_input',
  /** Cost was recorded in a currency no delivery obligation is priced in. */
  NO_COMMERCIAL_INPUT: 'no_commercial_input',
  /**
   * A work-package snapshot carries no recognizable charge type. Guessing
   * "one-time" would turn a missing field into a confident wrong number.
   */
  UNKNOWN_COMMERCIAL_SHAPE: 'unknown_commercial_shape',
};

/**
 * Normalize the recurrence shape a work-package snapshot carries. A snapshot
 * predating the field, or carrying an unknown value, is treated as *unknown*
 * rather than quietly as one-time — guessing here is exactly the failure this
 * function exists to prevent.
 * @param {any} wp
 */
function commercialShape(wp) {
  const chargeType = CHARGE_TYPES.includes(wp.chargeType) ? wp.chargeType : 'unknown';
  const recurring = chargeType === 'recurring';
  return {
    chargeType,
    interval: recurring && (wp.interval === 'month' || wp.interval === 'year') ? wp.interval : null,
    intervalCount: recurring && Number.isSafeInteger(wp.intervalCount) && wp.intervalCount > 0
      ? Number(wp.intervalCount)
      : null,
  };
}

/** Stable key for one commercial-input bucket within a currency. */
function shapeKey(shape) {
  return `${shape.chargeType}|${shape.interval ?? ''}|${shape.intervalCount ?? ''}`;
}

/**
 * Compute grouped economics for one delivery project.
 *
 * Deterministic and pure: it is handed the evidence and returns the numbers.
 * Nothing here reads a clock, a database or a catalog, so a snapshot recomputed
 * from the same inputs years later is byte-identical.
 *
 * Every group is one currency. There is no grand total, because adding EUR to
 * USD would require a rate this framework deliberately does not have. Within a
 * currency, commercial input is further split by charge type, interval and
 * interval count, and only the one-time bucket is ever set against cost.
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
        oneTimeCommercialValueCents: 0,
        commercialInputs: [],
        plannedCostCents: 0,
        actualTimeCostCents: 0,
        actualExpenseCostCents: 0,
        actualPartnerCostCents: 0,
        totalActualCostCents: 0,
        contributionBasis: CONTRIBUTION_BASIS.UNAVAILABLE,
        contributionUnavailableReason: CONTRIBUTION_UNAVAILABLE_REASONS.NO_COMMERCIAL_INPUT,
        deliveryContributionEstimateCents: null,
        varianceToPlanCents: 0,
        totalMinutes: 0,
        counts: { workPackages: 0, timeEntries: 0, expenses: 0, planLines: 0 },
      });
    }
    return groups.get(key);
  };

  /** currency -> shapeKey -> bucket, so recurrence is never flattened away. */
  /** @type {Map<string, Map<string, any>>} */
  const inputs = new Map();

  // The commercial value is the snapshot M13 copied from the immutable M12
  // obligation. Never a live catalog read, never a client-supplied number.
  for (const wp of workPackages) {
    const bucket = group(wp.currency);
    const shape = commercialShape(wp);
    if (!inputs.has(bucket.currency)) inputs.set(bucket.currency, new Map());
    const byShape = inputs.get(bucket.currency);
    const key = shapeKey(shape);
    if (!byShape.has(key)) {
      byShape.set(key, { ...shape, netAmountCents: 0, workPackageCount: 0 });
    }
    const input = byShape.get(key);
    input.netAmountCents = addMinorUnits(
      input.netAmountCents,
      requireMinorUnits(wp.netAmountCents, 'work package netAmountCents'),
      `commercial input (${shape.chargeType})`,
    );
    input.workPackageCount += 1;
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
    const byShape = inputs.get(bucket.currency) ?? new Map();
    // Sorted by identity so two runs over the same evidence are byte-identical.
    bucket.commercialInputs = [...byShape.values()].sort((a, b) => (
      shapeKey(a) < shapeKey(b) ? -1 : 1
    ));
    const oneTime = bucket.commercialInputs.find((input) => input.chargeType === 'one_time');
    bucket.oneTimeCommercialValueCents = oneTime ? oneTime.netAmountCents : 0;

    bucket.totalActualCostCents = addMinorUnits(
      bucket.actualTimeCostCents, bucket.actualExpenseCostCents, 'total actual delivery cost',
    );

    // A contribution estimate is only defensible where the commercial input is
    // a one-time amount in the same currency. Recorded cost covers *all* the
    // work in this currency, so setting it against a one-time subtotal while a
    // recurring obligation is also being delivered would understate the number
    // in a way no label can rescue. That case gets no number at all.
    const nonOneTime = bucket.commercialInputs.filter((input) => input.chargeType !== 'one_time');
    if (bucket.commercialInputs.length === 0) {
      bucket.contributionBasis = CONTRIBUTION_BASIS.UNAVAILABLE;
      bucket.contributionUnavailableReason = CONTRIBUTION_UNAVAILABLE_REASONS.NO_COMMERCIAL_INPUT;
      bucket.deliveryContributionEstimateCents = null;
    } else if (nonOneTime.length > 0) {
      bucket.contributionBasis = CONTRIBUTION_BASIS.UNAVAILABLE;
      bucket.contributionUnavailableReason = nonOneTime.some((input) => input.chargeType === 'recurring')
        ? CONTRIBUTION_UNAVAILABLE_REASONS.RECURRING_COMMERCIAL_INPUT
        : CONTRIBUTION_UNAVAILABLE_REASONS.UNKNOWN_COMMERCIAL_SHAPE;
      bucket.deliveryContributionEstimateCents = null;
    } else {
      bucket.contributionBasis = CONTRIBUTION_BASIS.ONE_TIME;
      bucket.contributionUnavailableReason = null;
      bucket.deliveryContributionEstimateCents = addMinorUnits(
        bucket.oneTimeCommercialValueCents, -bucket.totalActualCostCents, 'delivery contribution estimate',
      );
    }

    // Variance to plan compares two costs, so it is unaffected by recurrence
    // and stays available in every group.
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
  + 'no accounting or gross margin is computed, no profit is claimed, and amounts are never converted or summed '
  + 'across currencies. A contribution estimate is computed only where the commercial input for that currency is '
  + 'one-time; recurring input is preserved as evidence per charge type, interval and interval count, is never '
  + 'annualized or summed across periods, and leaves the estimate explicitly unavailable.';

export const ECONOMICS_BASIS = 'operational-delivery-estimate';
