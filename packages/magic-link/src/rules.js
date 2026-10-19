// @ts-check

import { createHmac, randomBytes } from 'node:crypto';
import { AppError, ValidationError } from '../../core/index.js';

/**
 * Magic-link login rules (backlog:0cbae947, BO-F0-05).
 *
 * Pure functions only: no database, no clock, no network. The operations in
 * `index.js` supply the rows, the directory answers and the timestamps;
 * everything decidable is decided here so the tests pin the rule without a
 * database.
 *
 * Six rules:
 * 1. **Closed token** — `ml1.<32-hex>`: 128 bits of CSPRNG material. Anything
 *    else is refused before a store is touched, so junk can never grow rows.
 * 2. **Ten minutes** — a link dies 10 minutes after issue, the backoffice
 *    brief's validity ("un link valido 10 minuti"). Expiry is compared with
 *    `>=`: the exact deadline instant is already dead.
 * 3. **Single use** — consuming marks the row spent in one conditional step;
 *    a second consume of the same token is refused, never replayed.
 * 4. **No enumeration in the receipt body** — the request receipt is
 *    byte-identical for a known and an unknown email, and both branches do
 *    the same store work (mint, save, then enqueue for a known address or
 *    spend-and-discard for an unknown one). Timing is explicitly OUT of this
 *    guarantee: the known branch awaits a persistent enqueue while the
 *    unknown branch awaits an in-process spend, so a latency oracle remains
 *    until per-address throttling lands (follow-up). The token travels only
 *    through the deployment's outbox edge, never in the API response.
 * 4b. **No brute-forceable mailbox artifact** — token rows carry an HMAC of
 *    the address under a deployment-held secret (same secret-by-reference
 *    custody as `site-forms` `hashIp`), never a fast unsalted hash and never
 *    the raw address. A table dump cannot be dictionary-attacked back to the
 *    mailbox without the deployment secret.
 * 5. **Claim first, send second** — the link email goes out only through the
 *    deployment's persistent outbox edge, enqueued under the deterministic
 *    key `magic-link:<tokenId>` with an actor. The persistent enqueue IS the
 *    cross-process claim: a re-enqueue under the same key returns the same
 *    job, never a second send. There is no second send path.
 * 6. **Fail-closed clock** — every clock reading the operations use must be
 *    finite integer milliseconds >= 0. A miswired clock refuses with
 *    `MAGIC_LINK_CLOCK_FAILED` (502), never a receipt: a non-finite clock
 *    must never mint an immortal link.
 */

export const MAGIC_LINK_CONTRACT = 1;

/** Ten minutes, in milliseconds: the brief's link validity. */
export const MAGIC_LINK_TTL_MS = 10 * 60 * 1000;

/** Token bounds. */
export const MAGIC_LINK_TOKEN_RE = /^ml1\.[0-9a-f]{32}$/;

/** Email bounds, the same as the site-forms intake: one rule everywhere. */
export const LOGIN_EMAIL_MAX = 200;

const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Stable refusal codes. A receipt names one of these, never free text alone. */
export const MAGIC_LINK_REASON = Object.freeze({
  INVALID: 'MAGIC_LINK_INVALID',
  EXPIRED: 'MAGIC_LINK_EXPIRED',
  NOT_CONFIGURED: 'MAGIC_LINK_NOT_CONFIGURED',
  CLOCK_FAILED: 'MAGIC_LINK_CLOCK_FAILED',
  SECRET_UNAVAILABLE: 'MAGIC_LINK_SECRET_UNAVAILABLE',
});

/** A deployment-held secret locator, never the value. Same locator shape as
 * `site-forms` `ipHashSecretRef` (`vault://<space>/<name>` or
 * `secret://<space>/<name>`), so one vault discipline covers both. */
export const EMAIL_HASH_SECRET_REF_MAX = 256;
const SECRET_REF_RE = /^(?:vault|secret):\/\/[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/;

/**
 * Require the email-hash secret locator. Anything else — a missing value, a
 * raw pasted secret, a bare token — is refused before any resolution, so a
 * secret value can never be mistaken for its reference.
 *
 * @param {unknown} value
 */
export function assertEmailHashSecretRef(value) {
  if (typeof value !== 'string' || value.length > EMAIL_HASH_SECRET_REF_MAX || !SECRET_REF_RE.test(value)) {
    throw new ValidationError(
      'emailHashSecretRef must be a bounded reference locator ("vault://<space>/<name>"), never a secret value',
      { field: 'emailHashSecretRef' },
    );
  }
  return value;
}

/**
 * Normalize one login email: trim, lowercase, bounded, no control
 * characters, one @ with a dotted domain. Refused otherwise.
 *
 * @param {unknown} value
 */
export function normalizeLoginEmail(value) {
  if (typeof value !== 'string') {
    throw new ValidationError('Login email must be a string', { field: 'email' });
  }
  const lower = value.trim().toLowerCase();
  if (lower === '' || lower.length > LOGIN_EMAIL_MAX || CONTROL_RE.test(lower)) {
    throw new ValidationError('Login email must be 1-200 characters without control characters', {
      field: 'email',
    });
  }
  if (!EMAIL_RE.test(lower)) {
    throw new ValidationError('Login email must be a valid email address', { field: 'email' });
  }
  return lower;
}

/**
 * Store only this, never the raw address: the login row needs to name the
 * subject's mailbox for audit, not to keep the mailbox itself.
 *
 * HMAC under a deployment-held secret (resolved at call time from
 * `emailHashSecretRef`, never stored): a fast unsalted hash over the small
 * email space would dictionary-attack back to the mailbox from any table
 * dump. The secret stays out of rows, logs and responses — only the HMAC
 * reaches the row.
 *
 * @param {string} normalizedEmail
 * @param {string} secret the resolved per-deployment value, never its reference
 */
export function hashLoginEmail(normalizedEmail, secret) {
  if (typeof normalizedEmail !== 'string' || normalizedEmail === '') {
    throw new ValidationError('Login email must be a non-empty string to hash', { field: 'email' });
  }
  if (typeof secret !== 'string' || secret === '') {
    // The message names the missing custody, never the value.
    throw new ValidationError('email hash custody is not wired: resolve the deployment secret first', {
      field: 'emailHashSecretRef',
    });
  }
  return createHmac('sha256', secret).update(`magic-link-login|${normalizedEmail}`, 'utf8').digest('hex');
}

/** Mint one closed-format token: 128 bits of CSPRNG, no metadata inside. */
export function mintMagicLinkToken() {
  return `ml1.${randomBytes(16).toString('hex')}`;
}

/**
 * Require the closed token shape. Malformed input is refused before any
 * store is touched, so junk tokens can neither grow rows nor time a lookup.
 *
 * @param {unknown} value
 */
export function requireMagicLinkToken(value) {
  if (typeof value !== 'string' || !MAGIC_LINK_TOKEN_RE.test(value)) {
    throw new ValidationError('Magic link token must be ml1.<32-hex>', { field: 'token' });
  }
  return value;
}

/**
 * @param {number} issuedAtMs
 */
export function magicLinkExpiry(issuedAtMs) {
  return issuedAtMs + MAGIC_LINK_TTL_MS;
}

/**
 * The deadline instant itself is already dead: `now >= expiresAt` refuses,
 * so a token is usable for strictly less than ten minutes, never more.
 *
 * @param {{ expiresAtMs: number }} record
 * @param {number} nowMs
 */
export function isMagicLinkExpired(record, nowMs) {
  return nowMs >= record.expiresAtMs;
}

/**
 * The deterministic idempotency key for one link email: derived from the
 * token it belongs to (the M11 pattern). The token is closed-format
 * (`ml1.<32-hex>`), so the key is always bounded. A re-enqueue under the
 * same key returns the same outbox job, never a second send.
 *
 * @param {string} tokenId
 */
export function magicLinkSendKey(tokenId) {
  return `magic-link:${requireMagicLinkToken(tokenId)}`;
}

/**
 * Require a usable clock reading: finite integer milliseconds >= 0. A
 * non-finite clock (NaN, Infinity, a non-number) would silently disable
 * expiry — `now >= expiresAt` is false for NaN — minting an immortal link.
 * Refuse fail-closed (502, never a receipt) instead.
 *
 * @param {unknown} value
 * @param {string} [field]
 */
export function requireClockMs(value, field = 'clock') {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new AppError('magic-link clock must read finite integer milliseconds >= 0', {
      code: MAGIC_LINK_REASON.CLOCK_FAILED, status: 502, details: { field },
    });
  }
  return value;
}

/**
 * The request receipt: byte-identical for a known and an unknown email.
 * Built fresh on every call so no caller can mutate a shared envelope into
 * an oracle. Italian copy, the backoffice's language.
 */
export function magicLinkRequestReceipt() {
  return {
    status: 'link-requested',
    message: "Se l'indirizzo è registrato, riceverai un link valido 10 minuti.",
  };
}
