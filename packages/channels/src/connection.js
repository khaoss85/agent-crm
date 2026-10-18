// @ts-check

import { createHash } from 'node:crypto';
import { ValidationError, assertTenantId } from '../../core/index.js';
import { CHANNELS } from './adapter.js';

/**
 * Connection input validation (backlog:e5532d1c9146).
 *
 * A connection is the per-space binding of an adapter to an account:
 * `{spaceId, channel, account, adapter, adapterVersion, secretRef}`.
 * The connection — never the adapter definition — carries
 * space-specific data, and it carries a secret *reference*, never the
 * secret (INTEGRATION_RUNTIME.md §Secret reference).
 */

export const CONNECTION_STATUSES = Object.freeze(['pending', 'active', 'suspended', 'revoked']);

/** Explicit allowed-transition table, not a rank. Terminal states never regress. */
export const CONNECTION_TRANSITIONS = Object.freeze({
  pending: Object.freeze(['active', 'suspended', 'revoked']),
  active: Object.freeze(['suspended', 'revoked']),
  suspended: Object.freeze(['active', 'revoked']),
  revoked: Object.freeze([]),
});

const HOSTILE_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype']);
const MAX_ACCOUNT = 256;
const MAX_SECRET_REF = 256;
// One bound for every key of the package (MEM_ACC_REUSE: one definition).
// Each ':'-joined part stays at most 128 chars, the whole key at most 256
// (the durable-jobs idempotencyRoot bound). Long parts are replaced by their
// sha256 fingerprint, so short keys stay readable and long keys still dedup.
const KEY_COMPONENT_MAX = 128;
const KEY_TOTAL_MAX = 256;

/**
 * Join key parts with ':' keeping every part at most 128 chars and the whole
 * key at most 256 chars. Every part escapes '%' then ':' first, so the join
 * is injective: a separator inside a component (a nested connection key, a
 * provider event id, a caller message key) can never collide with the real
 * separator or with another tuple's split. Nothing else is escaped, so short
 * readable parts — phone accounts included — keep their exact shape. Parts
 * longer than 128 become `sha256:<hex>`; when the joined form still exceeds
 * 256, the tail is folded into one sha256 so the key always fits.
 * Deterministic: the same parts always give the same key, and different
 * parts give a different key.
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
// stricter than the framework's own `packages/core/src/secret-provider.js`
// SECRET_REFERENCE: that pattern also matches a bare token, so a raw value
// pasted in place of its locator would pass validation and land in the row
// and the audit trail. Re-stated here because the secret provider is not on
// the public kernel surface; the deployment's resolver validates again at
// resolve time.
const SECRET_REF_PATTERN = /^(?:vault|secret):\/\/[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/;
// The whole C0 range plus DEL, tab/newline/CR included: a key is single-line
// text, and a smuggled line break must refuse here, never land in a row.
// Same shape as the payments package fence (MEM_ACC_REUSE).
const CONTROL_RE = /[\x00-\x1f\x7f]/;

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

/**
 * Validate registration input. Returns the normalized canonical fields.
 * The adapter identity is resolved against the registries (unknown adapter
 * or version is 404 there); the channel must match the adapter's channel.
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
  if (!CHANNELS.includes(value.channel)) {
    throw new ValidationError(`channel must be one of: ${CHANNELS.join(', ')}`, { field: 'channel' });
  }
  const account = boundedLine(value.account, 'account', MAX_ACCOUNT);
  const secretRef = assertSecretReference(value.secretRef);
  if (typeof value.adapter !== 'string' || value.adapter === '') {
    throw new ValidationError('adapter must name a registered channel adapter', { field: 'adapter' });
  }
  if (!registries || typeof registries.getAdapter !== 'function') {
    throw new ValidationError('connection registration needs the channel registries', { field: 'adapter' });
  }
  const { definition: adapter, fingerprint } = registries.getAdapter(value.adapter, value.adapterVersion);
  if (adapter.channel !== value.channel) {
    throw new ValidationError(`adapter "${adapter.name}" serves channel "${adapter.channel}", not "${value.channel}"`, { field: 'channel' });
  }
  return Object.freeze({
    spaceId,
    channel: value.channel,
    account,
    adapter: adapter.name,
    adapterVersion: adapter.version,
    adapterFingerprint: fingerprint,
    secretRef,
    // DB-unique identity: one account bound once per space and channel.
    // Bounded through boundedKey so a max-length account still fits.
    sourceKey: boundedKey('ch-conn', spaceId, value.channel, account.toLowerCase()),
  });
}

/**
 * The deterministic idempotency key for one outbound message (the M11
 * pattern: derived from the local record it belongs to).
 *
 * Short keys stay readable (`ch-send:<space>:<connection>:<message>`). A
 * registered connection may legally carry a 256-char account, which alone
 * already overflows the old 128-char component bound — and a long pair
 * overflows the durable-jobs 256-char idempotencyRoot bound — so when the
 * readable form would exceed 256 chars the long components are replaced by
 * their sha256 fingerprints. Either form is deterministic, so redelivery
 * still dedups; the hashed form is at most 215 chars and always fits.
 */
export function channelSendIdempotencyKey({ spaceId, connectionKey, messageKey }) {
  const space = assertSpaceId(spaceId);
  const connection = boundedLine(connectionKey, 'connectionKey', 1024);
  const message = boundedLine(messageKey, 'messageKey', 1024);
  return boundedKey('ch-send', space, connection, message);
}

/** @param {string} from @param {string} to */
export function assertConnectionTransition(from, to) {
  if (!CONNECTION_STATUSES.includes(from) || !CONNECTION_STATUSES.includes(to)) {
    throw new ValidationError('connection status is invalid', { field: 'status' });
  }
  if (!CONNECTION_TRANSITIONS[from].includes(to)) {
    throw new ValidationError(`connection cannot move from "${from}" to "${to}"`, { field: 'status' });
  }
}
