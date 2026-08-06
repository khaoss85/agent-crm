// @ts-check

import { ValidationError } from '../../core/src/errors.js';

/**
 * Commercial term boundaries are **calendar dates**, not instants.
 *
 * A subscription that starts on 2026-09-01 starts on that date for the
 * customer regardless of the server's timezone, so the contract stores
 * `YYYY-MM-DD` and never infers a zone. Timestamps that record *when
 * something happened* (activation) stay canonical UTC instants — they are a
 * different kind of fact and use the framework's existing `nowIso()`.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const MAX_TERM_DAYS = 3_650; // ten years; a bound, not a policy
export const MAX_NOTICE_DAYS = 365;

/**
 * Validate a calendar date and return it canonically. The value must round
 * trip: JavaScript happily turns `2026-02-30` into March 2, and `2026-06-31`
 * into July 1, so a parsed date that does not reproduce its input exactly is
 * not a real calendar date.
 *
 * @param {unknown} value @param {string} field
 */
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
  const start = Date.parse(`${a}T00:00:00.000Z`);
  const end = Date.parse(`${b}T00:00:00.000Z`);
  return Math.round((end - start) / 86_400_000);
}

/**
 * Validate the whole term as one coherent object.
 *
 * Documented semantics, deliberately explicit:
 *   - `termEndDate` is **inclusive**: a term 2026-09-01 → 2027-08-31 covers
 *     both boundary days and lasts 365 days.
 *   - `termStartDate` may not precede `effectiveDate` — a commitment cannot
 *     start before the agreement it belongs to takes effect.
 *   - `renewalNoticeDays` is a bounded non-negative integer and is **recorded
 *     only**: no scheduler exists in this milestone, so nothing fires on it.
 *
 * @param {{effectiveDate?: unknown, termStartDate?: unknown, termEndDate?: unknown, autoRenew?: unknown, renewalNoticeDays?: unknown}} input
 */
export function requireTerm(input) {
  const effectiveDate = requireCalendarDate(input.effectiveDate, 'effectiveDate');
  const termStartDate = requireCalendarDate(input.termStartDate, 'termStartDate');
  const termEndDate = requireCalendarDate(input.termEndDate, 'termEndDate');

  if (daysBetween(effectiveDate, termStartDate) < 0) {
    throw new ValidationError('termStartDate cannot precede effectiveDate', { field: 'termStartDate' });
  }
  const termDays = daysBetween(termStartDate, termEndDate);
  if (termDays < 0) {
    throw new ValidationError('termEndDate cannot precede termStartDate', { field: 'termEndDate' });
  }
  if (termDays > MAX_TERM_DAYS) {
    throw new ValidationError(`the term cannot exceed ${MAX_TERM_DAYS} days`, { field: 'termEndDate' });
  }

  // Strict boolean: "true", 1 and "yes" are all refused rather than coerced.
  if (input.autoRenew !== undefined && typeof input.autoRenew !== 'boolean') {
    throw new ValidationError('autoRenew must be a boolean', { field: 'autoRenew' });
  }
  const renewalNoticeDays = input.renewalNoticeDays ?? 0;
  if (!Number.isSafeInteger(renewalNoticeDays) || renewalNoticeDays < 0 || renewalNoticeDays > MAX_NOTICE_DAYS) {
    throw new ValidationError(`renewalNoticeDays must be an integer 0-${MAX_NOTICE_DAYS}`, { field: 'renewalNoticeDays' });
  }
  if (renewalNoticeDays > termDays + 1) {
    throw new ValidationError('renewalNoticeDays cannot exceed the term length', { field: 'renewalNoticeDays' });
  }

  return {
    effectiveDate,
    termStartDate,
    termEndDate,
    // Inclusive end date: both boundary days are inside the term.
    termDays: termDays + 1,
    autoRenew: input.autoRenew === true,
    renewalNoticeDays: /** @type {number} */ (renewalNoticeDays),
  };
}
