// @ts-check

import { ValidationError, normalizeCompanyName, normalizeEmail } from '../../core/index.js';

/**
 * **Bounded, control-safe input — and not one line of new normalization.**
 *
 * Customer data is PII-capable, so the string policy here is deliberately the
 * one this repository already settled on for the other PII it handles: the
 * signer policy from `packages/signature/src/operations.js`, which refuses C0
 * controls, DEL, the C1 range and the Unicode line/paragraph separators. It is
 * restated as one constant in one place rather than invented again, because
 * two policies that agree today are two policies that disagree later.
 *
 * Identity normalization is likewise *not* redefined here: `normalizeEmail`
 * and `normalizeCompanyName` come from `packages/core` — the same functions the
 * core adapters use to find records — so a value can never be matched by one
 * rule and stored under another.
 */

/** The repository's PII string policy (signer parity). */
export const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** Hard input bounds. An import is a bounded ask, not a pipe. */
export const MAX_ROWS = 500;
export const MAX_FIELD_LENGTH = 300;
export const MAX_SYSTEM_LENGTH = 64;
export const MAX_EXTERNAL_ID_LENGTH = 200;

/** A canonical system name: lowercase, bounded, no separators to smuggle. */
const SYSTEM_RE = /^[a-z][a-z0-9-]{0,63}$/;

export { normalizeEmail, normalizeCompanyName };

/**
 * A stored string that cannot break a console, a log line or a CSV cell.
 * @param {unknown} value @param {string} field @param {{max?: number, required?: boolean}} [options]
 */
export function safeString(value, field, options = {}) {
  const max = options.max ?? MAX_FIELD_LENGTH;
  if (value === undefined || value === null || value === '') {
    if (options.required) throw new ValidationError(`${field} is required`, { field });
    return null;
  }
  if (typeof value !== 'string') throw new ValidationError(`${field} must be a string`, { field });
  const trimmed = value.trim();
  if (trimmed === '') {
    if (options.required) throw new ValidationError(`${field} is required`, { field });
    return null;
  }
  if (trimmed.length > max) {
    throw new ValidationError(`${field} must be at most ${max} characters`, { field });
  }
  if (CONTROL_RE.test(trimmed)) {
    // The value is never echoed: it is attacker-controlled in exactly the case
    // this refusal exists for.
    throw new ValidationError(`${field} must not contain control characters`, { field });
  }
  return trimmed;
}

/** @param {unknown} value */
export function requireSystem(value) {
  const system = safeString(value, 'system', { max: MAX_SYSTEM_LENGTH, required: true });
  if (!SYSTEM_RE.test(/** @type {string} */ (system))) {
    throw new ValidationError('system must be a lowercase identifier such as "billing-export"', { field: 'system' });
  }
  return /** @type {string} */ (system);
}

/**
 * Email shape, deliberately conservative and explainable: one `@`, a local
 * part, a dotted domain, no consecutive dots, no whitespace. It decides
 * *shape* only — nothing here claims an address exists or is deliverable.
 * @param {unknown} value
 */
export function emailShape(value) {
  const raw = safeString(value, 'email', { max: MAX_FIELD_LENGTH });
  if (raw === null) return { ok: false, reason: 'missing', value: null };
  const email = normalizeEmail(raw);
  const valid = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email) && !email.includes('..');
  return { ok: valid, reason: valid ? null : 'shape', value: email };
}

/**
 * Domain shape. A company domain is compared exactly after normalization, so
 * the normalization has to be as boring as possible: lowercase, no scheme, no
 * path, no trailing dot.
 * @param {unknown} value
 */
export function domainShape(value) {
  const raw = safeString(value, 'domain', { max: MAX_FIELD_LENGTH });
  if (raw === null) return { ok: false, reason: 'missing', value: null };
  const domain = raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, '');
  const valid = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain);
  return { ok: valid, reason: valid ? null : 'shape', value: valid ? domain : domain || null };
}

/** @param {unknown} value */
export function requireExternalId(value) {
  return /** @type {string} */ (safeString(value, 'externalId', { max: MAX_EXTERNAL_ID_LENGTH, required: true }));
}
