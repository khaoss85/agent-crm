// @ts-check

import { createHash } from 'node:crypto';
import { ValidationError, assertTenantId } from '../../core/index.js';
import { PAYMENT_PROVIDERS } from './adapter.js';

/**
 * Connection and request input validation (backlog:1972e16d33f2).
 *
 * A connection is the per-space binding of a payment adapter to an account:
 * `{spaceId, provider, account, adapter, adapterVersion, secretRef}`.
 * The connection — never the adapter definition — carries
 * space-specific data, and it carries a secret *reference*, never the
 * secret. The shape mirrors the channels connection (MEM_ACC_REUSE: one
 * discipline for every provider binding), re-stated here because a package
 * never imports another package's private source.
 */

export const CONNECTION_STATUSES = Object.freeze(['pending', 'active', 'suspended', 'revoked']);

/**
 * Explicit allowed-transition table, not a rank. `revoked` leaves only
 * through the explicit rebind-connection action (incident recovery back to
 * pending with a new secret reference): no status move targets pending, so
 * every other path from revoked still refuses.
 */
export const CONNECTION_TRANSITIONS = Object.freeze({
  pending: Object.freeze(['active', 'suspended', 'revoked']),
  active: Object.freeze(['suspended', 'revoked']),
  suspended: Object.freeze(['active', 'revoked']),
  revoked: Object.freeze(['pending']),
});

const HOSTILE_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype']);
const MAX_ACCOUNT = 256;
const MAX_SECRET_REF = 256;
// One bound for every key of the package. Each ':'-joined part stays at most
// 128 chars, the whole key at most 256 chars (the durable-jobs
// idempotencyRoot bound). Long parts are replaced by their sha256
// fingerprint, so short keys stay readable and long keys still dedup.
const KEY_COMPONENT_MAX = 128;
const KEY_TOTAL_MAX = 256;
// Every C0 control (including tab, LF and CR) and DEL is refused: keys,
// rows and audit stay single-line, matching the operations hasControlChar
// gate — a newline in a key would split line-oriented audit consumers.
const CONTROL_RE = /[\x00-\x1f\x7f]/;
const CURRENCY_RE = /^[A-Z]{3}$/;

/**
 * Join key parts with ':' keeping every part at most 128 chars and the whole
 * key at most 256 chars. Every part escapes '%' then ':' first, so the join
 * is injective: a separator inside a component can never collide with the
 * real separator or with another tuple's split. Parts longer than 128
 * become `sha256:<hex>`; when the joined form still exceeds 256, the tail
 * is folded into one sha256 so the key always fits. Deterministic: the same
 * parts always give the same key, and different parts give a different key.
 */
export function boundedKey(...parts) {
  if (parts.length === 0) {
    throw new ValidationError('boundedKey needs at least one part', { field: 'key' });
  }
  const texts = parts.map((part) => {
    if (typeof part !== 'string' || part === '' || part.length > 1024 || CONTROL_RE.test(part)) {
      throw new ValidationError('boundedKey parts must be bounded single-line text', { field: 'key' });
    }
    return part.replace(/%/g, '%25').replace(/:/g, '%3A');
  });
  const safe = texts.map((text) => (
    text.length <= KEY_COMPONENT_MAX
      ? text
      : `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`
  ));
  const joined = safe.join(':');
  if (joined.length <= KEY_TOTAL_MAX) return joined;
  const tailHash = createHash('sha256').update(safe.slice(1).join(':'), 'utf8').digest('hex');
  return `${safe[0]}:${tailHash}`;
}

// The declared locator shape: a namespaced reference, never a value —
// `vault://<space>/<name>` against the deployment's runtime-vault (or the
// `secret://` scheme where a deployment names its own). Deliberately
// stricter than a bare token: a raw value pasted in place of its locator
// fails validation and never lands in the row or the audit trail.
const SECRET_REF_PATTERN = /^(?:vault|secret):\/\/[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/;

function boundedLine(value, label, max) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max || CONTROL_RE.test(value)) {
    throw new ValidationError(`${label} must be bounded single-line text (at most ${max} characters)`, { field: label });
  }
  return value.trim();
}

/** The Accordo space slug. Same rule as a tenant id: lowercase slug, never inferred. */
export function assertSpaceId(value) {
  try {
    return assertTenantId(value);
  } catch {
    throw new ValidationError('spaceId must be a lowercase slug (letters, digits, hyphens, starting with a letter, at most 63 characters)', { field: 'spaceId' });
  }
}

/** A secret reference is a namespaced locator. Anything else is refused before storage. */
export function assertSecretReference(value) {
  if (typeof value !== 'string' || value.length > MAX_SECRET_REF
    || !SECRET_REF_PATTERN.test(value) || HOSTILE_KEYS.includes(value)) {
    throw new ValidationError('secretRef must be a bounded reference locator ("vault://<space>/<name>"), never a secret value', { field: 'secretRef' });
  }
  return value;
}

/** Uppercase three-letter currency code (ADR-014: amounts are integer minor units). */
export function assertCurrency(value) {
  if (typeof value !== 'string' || !CURRENCY_RE.test(value)) {
    throw new ValidationError('currency must be an uppercase three-letter currency code', { field: 'currency' });
  }
  return value;
}

/**
 * Validate registration input. Returns the normalized canonical fields.
 * The adapter identity is resolved against the registries (unknown adapter
 * or version is 404 there); the provider must match the adapter's provider.
 */
export function assertConnectionInput(input, registries) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('connection input must be a plain object', { field: 'input' });
  }
  const value = /** @type {Record<string, any>} */ (input);
  if (Object.getOwnPropertyNames(value).some((key) => HOSTILE_KEYS.includes(key))) {
    throw new ValidationError('connection input carries a hostile key', { field: 'input' });
  }
  const spaceId = assertSpaceId(value.spaceId);
  if (!PAYMENT_PROVIDERS.includes(value.provider)) {
    throw new ValidationError(`provider must be one of: ${PAYMENT_PROVIDERS.join(', ')}`, { field: 'provider' });
  }
  const account = boundedLine(value.account, 'account', MAX_ACCOUNT);
  const secretRef = assertSecretReference(value.secretRef);
  if (typeof value.adapter !== 'string' || value.adapter === '') {
    throw new ValidationError('adapter must name a registered payment adapter', { field: 'adapter' });
  }
  if (!registries || typeof registries.getAdapter !== 'function') {
    throw new ValidationError('connection registration needs the payment registries', { field: 'adapter' });
  }
  const { definition: adapter, fingerprint } = registries.getAdapter(value.adapter, value.adapterVersion);
  if (adapter.provider !== value.provider) {
    throw new ValidationError(`adapter "${adapter.name}" serves provider "${adapter.provider}", not "${value.provider}"`, { field: 'provider' });
  }
  return Object.freeze({
    spaceId,
    provider: value.provider,
    account,
    adapter: adapter.name,
    adapterVersion: adapter.version,
    adapterFingerprint: fingerprint,
    secretRef,
    // DB-unique identity: one account bound once per space and provider.
    // Bounded through boundedKey so a max-length account still fits.
    sourceKey: boundedKey('pay-conn', spaceId, value.provider, account.toLowerCase()),
  });
}

/**
 * The deterministic idempotency key for one payment request (the M11
 * pattern: derived from the local record it belongs to). The external
 * provider call reuses it, so a retried intent mints no second checkout.
 */
export function paymentIntentKey({ spaceId, connectionKey, requestKey }) {
  const space = assertSpaceId(spaceId);
  const connection = boundedLine(connectionKey, 'connectionKey', 1024);
  const request = boundedLine(requestKey, 'requestKey', 1024);
  return boundedKey('pay-req', space, connection, request);
}

/** @param {string} from @param {string} to */
export function assertConnectionTransition(from, to) {
  if (!CONNECTION_STATUSES.includes(from) || !CONNECTION_STATUSES.includes(to)) {
    throw new ValidationError('connection status is invalid', { field: 'status' });
  }
  if (!CONNECTION_TRANSITIONS[from].includes(to)) {
    throw new ValidationError(`connection cannot move from "${from}" to "${to}"`, { field: 'status' });
  }
  return to;
}
