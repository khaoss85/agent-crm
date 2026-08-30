// @ts-check

import { createHash, randomBytes } from 'node:crypto';
import { AppError, ValidationError } from './errors.js';
import { normalizeActor } from './actor.js';

/**
 * Caller-visible idempotency keys for PostgreSQL writes (Spine v2 M4A).
 *
 * Closed format: `v1.<yyyymmdd>.<32-hex>` — an issuance bucket plus 128 bits of
 * CSPRNG material. Short, free-form and predictable values refuse before lookup.
 * Unique lookup identity is canonical tenant namespace + this raw key. Keys are
 * tenant-local: reuse under another tenant is an independent outcome.
 */

export const IDEMPOTENCY_CONTRACT = 1;
export const IDEMPOTENCY_KEY_RE = /^v1\.\d{8}\.[0-9a-f]{32}$/;
export const WRITE_OUTCOME_CONTRACT = 'write.v1';
export const EXTERNAL_OPERATION_V2 = 2;

const TENANT_NS = 'accordo.tenant.v1';

/**
 * @param {unknown} value
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(/** @type {any} */ (value)[key])}`).join(',')}}`;
}

/**
 * @param {string} value
 */
export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * @param {unknown} tenantId
 */
export function tenantNamespace(tenantId) {
  if (typeof tenantId !== 'string' || tenantId.trim() === '') {
    throw new ValidationError('PostgreSQL writes require a canonical tenant', { field: 'tenantId' });
  }
  return sha256Hex(`${TENANT_NS}\0${tenantId}`);
}

/**
 * @param {() => string} [clock]
 */
export function issueIdempotencyKey(clock) {
  const instant = typeof clock === 'function' ? clock() : new Date().toISOString();
  if (typeof instant !== 'string' || instant.length < 10) {
    throw new ValidationError('Idempotency issuance clock must return an ISO instant');
  }
  const bucket = instant.slice(0, 10).replaceAll('-', '');
  if (!/^\d{8}$/.test(bucket)) {
    throw new ValidationError('Idempotency issuance clock must return an ISO instant');
  }
  return `v1.${bucket}.${randomBytes(16).toString('hex')}`;
}

/**
 * @param {unknown} value
 */
export function requireIdempotencyKey(value) {
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY_RE.test(value)) {
    throw new ValidationError(
      'Idempotency key must be v1.<yyyymmdd>.<32-hex>',
      { field: 'idempotencyKey' },
    );
  }
  return value;
}

/**
 * @param {unknown} supplied
 * @param {() => string} [clock]
 */
export function resolveIdempotencyKey(supplied, clock) {
  if (supplied === undefined || supplied === null || supplied === '') {
    return issueIdempotencyKey(clock);
  }
  return requireIdempotencyKey(supplied);
}

/**
 * Verified subject fingerprint. Never a credential. Used only as a stored
 * scope field for divergent-replay comparison.
 *
 * @param {any} identity
 * @param {unknown} actor
 */
export function subjectFingerprint(identity, actor) {
  if (identity && typeof identity === 'object') {
    if (typeof identity.claimsFingerprint === 'string' && /^[0-9a-f]{64}$/.test(identity.claimsFingerprint)) {
      return identity.claimsFingerprint;
    }
    if (typeof identity.kind === 'string' && typeof identity.subject === 'string') {
      return sha256Hex(`identity\0${identity.kind}\0${identity.subject}`);
    }
  }
  const normalized = normalizeActor(actor);
  return sha256Hex(`actor\0${normalized.type}\0${normalized.id}`);
}

/**
 * @param {{
 *   operation: string,
 *   target: string,
 *   contractVersion: string,
 *   input: unknown,
 * }} scope
 */
export function requestFingerprint(scope) {
  return sha256Hex(canonicalJson({
    operation: scope.operation,
    target: scope.target,
    contractVersion: scope.contractVersion,
    input: scope.input ?? null,
  }));
}

/**
 * Stable provider idempotency key derived from tenant namespace + caller key.
 * Never the raw caller key, never a credential.
 *
 * @param {string} tenantNs
 * @param {string} rawKey
 */
export function providerIdempotencyKey(tenantNs, rawKey) {
  return sha256Hex(`accordo.provider.v1\0${tenantNs}\0${rawKey}`);
}

/**
 * Deterministic child key for nested writes and Admin acknowledgement.
 * Same root + closed scope + child identity always yields the same key;
 * different children stay distinct. The bucket is inherited from the root.
 *
 * @param {unknown} rootKey
 * @param {string} scope
 * @param {string} childId
 */
export function deriveChildKey(rootKey, scope, childId) {
  const parent = requireIdempotencyKey(rootKey);
  if (typeof scope !== 'string' || scope.trim() === '' || scope.includes('\0')) {
    throw new ValidationError('Child key scope must be a closed non-empty token', { field: 'scope' });
  }
  if (typeof childId !== 'string' || childId.trim() === '' || childId.includes('\0')) {
    throw new ValidationError('Child key identity must be a closed non-empty token', { field: 'childId' });
  }
  const bucket = parent.split('.')[1];
  const digest = sha256Hex(`accordo.child.v1\0${parent}\0${scope}\0${childId}`).slice(0, 32);
  return `v1.${bucket}.${digest}`;
}

/**
 * @param {string} kind
 */
export function divergentReplayError(kind) {
  return new AppError('The idempotency key was reused with a different request', {
    code: 'DIVERGENT_REPLAY',
    status: 409,
    details: { mismatch: kind },
  });
}

/**
 * Compare stored immutable scope to the caller's. Mismatch is divergent replay,
 * never absence, and the error reveals neither prior response nor subject.
 *
 * @param {any} stored
 * @param {{
 *   subjectFingerprint: string,
 *   operation: string,
 *   target: string,
 *   contractVersion: string,
 *   requestFingerprint: string,
 * }} scope
 */
export function assertOutcomeScope(stored, scope) {
  if (stored.subjectFingerprint !== scope.subjectFingerprint) throw divergentReplayError('subject');
  if (stored.operation !== scope.operation) throw divergentReplayError('operation');
  if (stored.target !== scope.target) throw divergentReplayError('target');
  if (stored.contractVersion !== scope.contractVersion) throw divergentReplayError('contract');
  if (stored.requestFingerprint !== scope.requestFingerprint) throw divergentReplayError('request');
}

/**
 * @param {unknown} value
 */
export function encodeJsonSafe(value) {
  try {
    return JSON.parse(JSON.stringify(value ?? null));
  } catch {
    return { unserializable: true };
  }
}
