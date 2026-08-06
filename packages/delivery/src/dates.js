// @ts-check

import { ValidationError } from '../../core/index.js';

/**
 * Delivery target dates are **post-sale planning data**.
 *
 * Nobody signed them. They are not the contract's operational term (which is
 * itself post-signature metadata — M12, ADR-018 addendum 2), and they are not
 * a promise to the customer. They are what the delivery team currently intends,
 * recorded with their provenance so no later reader can mistake them for a
 * commitment:
 *
 *   datesSource: "post-sale-delivery-planning"
 *
 * Calendar dates, no time, no timezone, and nothing in this milestone fires on
 * them: there is no scheduler.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const MAX_PLAN_DAYS = 3_650;
export const DATES_SOURCE = 'post-sale-delivery-planning';
export const DATES_NOTE =
  'Delivery target dates are post-sale planning data entered by the delivery team. They were not signed, they are not a customer commitment, and nothing schedules or fires on them.';

/** @param {unknown} value @param {string} field */
export function requireCalendarDate(value, field) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) {
    throw new ValidationError(`${field} must be a calendar date (YYYY-MM-DD)`, { field });
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new ValidationError(`${field} is not a real calendar date`, { field });
  }
  return value;
}

/** Whole days between two calendar dates (b − a); both must be canonical. */
export function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00.000Z`) - Date.parse(`${a}T00:00:00.000Z`)) / 86_400_000);
}

/**
 * Validate the optional delivery window. Both dates are optional — a handover
 * can be planned before the schedule is known — but a half-window is refused,
 * because "starts 2026-09-01, ends when it ends" is not a plan anyone can read.
 *
 * When the source contract has an operational term, the window must sit inside
 * it: delivery that starts before the agreement is effective, or ends after it
 * expires, is a planning mistake worth catching at entry.
 *
 * @param {{targetStartDate?: unknown, targetEndDate?: unknown}} input
 * @param {{effectiveDate?: string|null, termEndDate?: string|null}} [contract]
 */
export function requireDeliveryWindow(input, contract = {}) {
  const hasStart = input.targetStartDate !== undefined && input.targetStartDate !== null && input.targetStartDate !== '';
  const hasEnd = input.targetEndDate !== undefined && input.targetEndDate !== null && input.targetEndDate !== '';
  if (!hasStart && !hasEnd) {
    return { targetStartDate: null, targetEndDate: null, planDays: null, datesSource: DATES_SOURCE };
  }
  if (hasStart !== hasEnd) {
    throw new ValidationError('targetStartDate and targetEndDate must be supplied together', {
      field: hasStart ? 'targetEndDate' : 'targetStartDate',
    });
  }
  const targetStartDate = requireCalendarDate(input.targetStartDate, 'targetStartDate');
  const targetEndDate = requireCalendarDate(input.targetEndDate, 'targetEndDate');
  const planDays = daysBetween(targetStartDate, targetEndDate);
  if (planDays < 0) {
    throw new ValidationError('targetEndDate cannot precede targetStartDate', { field: 'targetEndDate' });
  }
  if (planDays > MAX_PLAN_DAYS) {
    throw new ValidationError(`the delivery window cannot exceed ${MAX_PLAN_DAYS} days`, { field: 'targetEndDate' });
  }
  if (contract.effectiveDate && daysBetween(contract.effectiveDate, targetStartDate) < 0) {
    throw new ValidationError('delivery cannot start before the contract is effective', { field: 'targetStartDate' });
  }
  if (contract.termEndDate && daysBetween(targetEndDate, contract.termEndDate) < 0) {
    throw new ValidationError('delivery cannot be planned to end after the contract term ends', { field: 'targetEndDate' });
  }
  return { targetStartDate, targetEndDate, planDays: planDays + 1, datesSource: DATES_SOURCE };
}
