// @ts-check

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
// Same shape as the framework's own secret references
// (`packages/core/src/secret-provider.js` SECRET_REFERENCE): a reference is
// a bounded locator, never a value. Re-stated here because the secret
// provider is not on the public kernel surface; the deployment's resolver
// validates again at resolve time.
const SECRET_REF_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/;
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

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

/** A secret reference is a bounded locator. Anything else is refused before storage. */
export function assertSecretReference(value) {
  if (typeof value !== 'string' || value.length > MAX_SECRET_REF
    || !SECRET_REF_PATTERN.test(value) || HOSTILE_KEYS.includes(value)) {
    throw new ValidationError('secretRef must be a bounded reference locator (letters, digits, ., _, :, /, -), never a secret value', { field: 'secretRef' });
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
    sourceKey: `ch-conn:${spaceId}:${value.channel}:${account.toLowerCase()}`,
  });
}

/**
 * The deterministic idempotency key for one outbound message (the M11
 * pattern: derived from the local record it belongs to).
 */
export function channelSendIdempotencyKey({ spaceId, connectionKey, messageKey }) {
  const space = assertSpaceId(spaceId);
  const connection = boundedLine(connectionKey, 'connectionKey', 128);
  const message = boundedLine(messageKey, 'messageKey', 256);
  return `ch-send:${space}:${connection}:${message}`;
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
