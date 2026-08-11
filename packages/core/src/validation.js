// @ts-check

import { ValidationError } from './errors.js';

/** @param {unknown} value @param {string} field */
export function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`${field} is required`, { field });
  }
  return value.trim();
}

/** @param {unknown} value @param {string} field */
export function optionalString(value, field) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new ValidationError(`${field} must be a string`, { field });
  }
  return value.trim();
}

/** @param {unknown} value @param {string} field */
export function requiredEmail(value, field = 'email') {
  const email = requiredString(value, field).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ValidationError(`${field} must be a valid email`, { field });
  }
  return email;
}

/** @param {unknown} value @param {string} field */
export function nonNegativeInteger(value, field) {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new ValidationError(`${field} must be a non-negative integer`, { field });
  }
  return Number(value);
}

/** @param {unknown} value @param {string[]} allowed @param {string} field */
export function enumValue(value, allowed, field) {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new ValidationError(`${field} must be one of: ${allowed.join(', ')}`, {
      field,
      allowed,
    });
  }
  return value;
}

/** @param {unknown} value @param {string} field */
export function optionalIsoDate(value, field) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new ValidationError(`${field} must be an ISO date`, { field });
  }
  return new Date(value).toISOString();
}

/** @param {unknown} value @param {string} field */
export function optionalBoolean(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'boolean') {
    throw new ValidationError(`${field} must be a boolean`, { field });
  }
  return value;
}

/** @param {unknown} value @param {string} field */
export function requiredInteger(value, field) {
  if (!Number.isInteger(value)) {
    throw new ValidationError(`${field} must be an integer`, { field });
  }
  return Number(value);
}

/** @param {unknown} value @param {string} field */
export function optionalInteger(value, field) {
  if (value === undefined || value === null) return null;
  return requiredInteger(value, field);
}

/** @param {unknown} value @param {string[]} allowed @param {string} field */
export function optionalEnum(value, allowed, field) {
  if (value === undefined || value === null || value === '') return null;
  return enumValue(value, allowed, field);
}

/** @param {unknown} value @param {string} field */
export function optionalEmail(value, field = 'email') {
  if (value === undefined || value === null || value === '') return null;
  return requiredEmail(value, field);
}

/** @param {unknown} value @param {string} field */
export function requiredIsoDate(value, field) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new ValidationError(`${field} must be an ISO date`, { field });
  }
  return new Date(value).toISOString();
}

/** @param {unknown} value @param {string} field */
export function requiredBoolean(value, field) {
  if (typeof value !== 'boolean') {
    throw new ValidationError(`${field} must be a boolean`, { field });
  }
  return value;
}

// ---- calendar dates ----
//
// A **calendar date** is a different kind of fact from an instant. A term that
// ends on 2027-08-31 ends on that day for the customer whatever the server's
// timezone is, so it is stored as `YYYY-MM-DD` and never resolved to a zone.
//
// The shape is not the check, and this is the whole reason this lives here.
// `Date.parse('2027-02-30T00:00:00.000Z')` does not fail: JavaScript rolls the
// value over to March 2, so a string that matches `/^\d{4}-\d{2}-\d{2}$/` can
// still name a day that never existed. Anything that accepted it would store a
// date nobody could have acted on, next to arithmetic measured from a
// *different* day — one record whose own two fields disagree.
//
// The rule is therefore a **round trip**: a parsed date that does not reproduce
// its input exactly is not a real calendar date. It was independently
// re-implemented in four packages before this became the one authority; a
// validator is a runtime primitive and carries no domain vocabulary, so it
// belongs beside the other validators the kernel's own services use (ADR-018).

const CALENDAR_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Whether `value` is a canonical, real calendar date — no exception, for the
 * paths that must degrade to "unknown" rather than refuse.
 *
 * Deliberately strict about shape as well as existence: a date-time string, a
 * whitespace-padded date and a single-digit month are all refused, because
 * accepting them would mean two records could name the same day with two
 * different bytes and no longer collide on a key built from it.
 *
 * @param {unknown} value
 */
export function isCalendarDate(value) {
  if (typeof value !== 'string' || !CALENDAR_DATE_RE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * Validate a calendar date and return it canonically.
 * @param {unknown} value @param {string} field
 */
export function requireCalendarDate(value, field) {
  if (typeof value !== 'string' || !CALENDAR_DATE_RE.test(value)) {
    throw new ValidationError(`${field} must be a calendar date (YYYY-MM-DD)`, { field });
  }
  if (!isCalendarDate(value)) {
    throw new ValidationError(`${field} is not a real calendar date`, { field });
  }
  return value;
}

/**
 * Whole days from `a` to `b`, or `null` when either is not a real day.
 *
 * Returning `null` rather than a number is the point: a confident integer
 * measured from a date JavaScript invented is worse than an admitted gap.
 *
 * @param {unknown} a @param {unknown} b
 */
export function calendarDaysBetween(a, b) {
  if (!isCalendarDate(a) || !isCalendarDate(b)) return null;
  const from = Date.parse(`${a}T00:00:00.000Z`);
  const to = Date.parse(`${b}T00:00:00.000Z`);
  return Math.round((to - from) / 86_400_000);
}
