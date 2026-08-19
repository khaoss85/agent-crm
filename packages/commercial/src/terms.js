// @ts-check

import { createHash } from 'node:crypto';
import { ValidationError, calendarDaysBetween, requireCalendarDate } from '../../core/index.js';

/**
 * The **signed** commercial term: dates and renewal facts that are negotiated
 * on the quote, frozen into the immutable quote version at submission,
 * embedded in the canonical signature document (so the documentHash covers
 * them), and copied onto the Order at verified completion.
 *
 * This validator deliberately mirrors the coherence rules of the contracts
 * package's operational term (`packages/contracts/src/dates.js`) so the two
 * provenances stay comparable — same inclusive `termEndDate`, same bounds —
 * but it is owned here because commercial cannot depend on contracts (the
 * dependency points the other way), and because the two terms differ in one
 * essential fact: a signed term has no `termsReason`. The reason a signed
 * term exists is the signature itself.
 *
 * Calendar dates are validated through the canonical round-trip authority
 * (`requireCalendarDate` in `packages/core`): `2026-02-30` is refused, never
 * silently reinterpreted, and no timezone is ever inferred — a term that
 * starts on 2026-09-01 starts on that date for the customer wherever the
 * server runs.
 *
 * Not modeled, deliberately: termination and non-renewal clauses (no document
 * this repository produces carries them, and inventing signed semantics for
 * unsigned clauses is exactly what this milestone exists to prevent),
 * billing, tax, payment terms, revenue recognition, usage commitments.
 * `renewalNoticeDays` is recorded only — no scheduler exists.
 */

export const SIGNED_TERMS_CONTRACT = 1;
export const MAX_TERM_DAYS = 3_650; // ten years; a bound, not a policy
export const MAX_NOTICE_DAYS = 365;

/** Whole days between two canonical calendar dates (b − a). */
function daysBetween(a, b) {
  const days = calendarDaysBetween(a, b);
  if (days === null) {
    throw new ValidationError('daysBetween requires two canonical calendar dates', { field: 'termEndDate' });
  }
  return days;
}

/**
 * Validate a draft term as one coherent object and return its canonical,
 * frozen form. Semantics, stated once:
 *   - `termEndDate` is **inclusive**: 2026-09-01 → 2027-08-31 covers both
 *     boundary days and lasts 365 days (`termDays` counts both ends);
 *   - `termStartDate` may not precede `effectiveDate`;
 *   - `renewalNoticeDays` is a bounded non-negative integer, requires
 *     `autoRenew`, and is recorded only.
 *
 * @param {{effectiveDate?: unknown, termStartDate?: unknown, termEndDate?: unknown, autoRenew?: unknown, renewalNoticeDays?: unknown}} input
 */
export function requireSignedTerm(input) {
  const effectiveDate = requireCalendarDate(input.effectiveDate, 'effectiveDate');
  const termStartDate = requireCalendarDate(input.termStartDate, 'termStartDate');
  const termEndDate = requireCalendarDate(input.termEndDate, 'termEndDate');

  if (daysBetween(effectiveDate, termStartDate) < 0) {
    throw new ValidationError('termStartDate cannot precede effectiveDate', { field: 'termStartDate' });
  }
  const spanDays = daysBetween(termStartDate, termEndDate);
  if (spanDays < 0) {
    throw new ValidationError('termEndDate cannot precede termStartDate', { field: 'termEndDate' });
  }
  if (spanDays > MAX_TERM_DAYS) {
    throw new ValidationError(`the term cannot exceed ${MAX_TERM_DAYS} days`, { field: 'termEndDate' });
  }

  // Strict boolean: "true", 1 and "yes" are refused rather than coerced. A
  // SQLite-stored draft answers 0/1, which the generated service already maps
  // back to a boolean, so null/undefined here means "not set".
  if (input.autoRenew !== undefined && input.autoRenew !== null && typeof input.autoRenew !== 'boolean') {
    throw new ValidationError('autoRenew must be a boolean', { field: 'autoRenew' });
  }
  const autoRenew = input.autoRenew === true;
  const renewalNoticeDays = input.renewalNoticeDays ?? 0;
  if (!Number.isSafeInteger(renewalNoticeDays) || renewalNoticeDays < 0 || renewalNoticeDays > MAX_NOTICE_DAYS) {
    throw new ValidationError(`renewalNoticeDays must be an integer 0-${MAX_NOTICE_DAYS}`, { field: 'renewalNoticeDays' });
  }
  if (renewalNoticeDays > spanDays + 1) {
    throw new ValidationError('renewalNoticeDays cannot exceed the term length', { field: 'renewalNoticeDays' });
  }
  if (!autoRenew && renewalNoticeDays > 0) {
    throw new ValidationError('renewalNoticeDays requires autoRenew: without renewal there is nothing to give notice of', {
      field: 'renewalNoticeDays',
    });
  }

  const term = {
    termsContract: SIGNED_TERMS_CONTRACT,
    effectiveDate,
    termStartDate,
    termEndDate,
    // Inclusive end date: both boundary days are inside the term.
    termDays: spanDays + 1,
    autoRenew,
    renewalNoticeDays: /** @type {number} */ (renewalNoticeDays),
  };
  return Object.freeze({ ...term, termsFingerprint: signedTermFingerprint(term) });
}

/**
 * A stable identity for one term's content, so a consumer can compare terms
 * across versions without re-canonicalizing a whole document. The tuple is
 * serialized in this literal, fixed field order — canonical by construction,
 * with no dependence on object key enumeration of caller-supplied data.
 *
 * @param {{termsContract: number, effectiveDate: string, termStartDate: string, termEndDate: string, termDays: number, autoRenew: boolean, renewalNoticeDays: number}} term
 */
export function signedTermFingerprint(term) {
  const canonical = JSON.stringify([
    'signed-commercial-term',
    term.termsContract,
    term.effectiveDate,
    term.termStartDate,
    term.termEndDate,
    term.termDays,
    term.autoRenew,
    term.renewalNoticeDays,
  ]);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
