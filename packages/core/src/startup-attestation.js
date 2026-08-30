// @ts-check

import { createHash, randomBytes } from 'node:crypto';
import { AppError } from './errors.js';

export const STARTUP_ATTESTATION_CONTRACT = 1;
export const STARTUP_MIGRATE_PERMISSION = 'schema:migrate';
export const STARTUP_CHALLENGE_TTL_MS = 30_000;

const HOSTILE_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype']);
const DISCOVER_OPERATIONS = Object.freeze(['discoverControlResource', 'discoverDataResource']);
const ATTEST_OPERATIONS = Object.freeze(['attestControlStartup', 'attestDataStartup']);
const PLANES = Object.freeze(['control', 'data']);

/**
 * @param {string} code
 * @param {string} message
 * @param {Record<string, unknown>} [details]
 * @returns {never}
 */
function refuse(code, message, details = { contract: STARTUP_ATTESTATION_CONTRACT }) {
  throw new AppError(message, { code, status: 500, details });
}

/** @param {unknown} value */
function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

/** @param {unknown} value */
function requiredString(value) {
  return typeof value === 'string' && value !== '' && !value.includes('\0') && value.length <= 128;
}

/** @param {unknown} value */
function fingerprintString(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

/** @param {unknown} value */
function closedNames(value, allowed) {
  if (!isPlainObject(value)) return false;
  const names = Object.getOwnPropertyNames(value);
  if (Object.getOwnPropertySymbols(value).length) return false;
  if (names.some((key) => HOSTILE_KEYS.includes(key))) return false;
  if (names.some((key) => !allowed.includes(key))) return false;
  return true;
}

/** @param {unknown} value */
export function canonicalFingerprint(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/** @param {unknown} value */
function canonicalJson(value) {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  if (!isPlainObject(value)) return JSON.stringify(null);
  const keys = Object.getOwnPropertyNames(value).filter((key) => !HOSTILE_KEYS.includes(key)).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(/** @type {any} */ (value)[key])}`).join(',')}}`;
}

/**
 * @param {unknown} migrations
 */
export function fingerprintMigrationSet(migrations) {
  if (!Array.isArray(migrations)) {
    refuse('STARTUP_MIGRATION_SET_MISMATCH', 'startup migration set is not a closed list');
  }
  return canonicalFingerprint(migrations.map((entry) => ({
    version: entry?.version ?? null,
    name: entry?.name ?? null,
    checksum: entry?.checksum ?? null,
  })));
}

/**
 * @param {{
 *   operation: string,
 *   tenantId: string,
 *   repositoryFingerprint: string,
 *   resourceFingerprint: string,
 *   migrationSetFingerprint: string,
 *   permission?: string,
 *   priorControlAttestation?: string | null,
 *   now?: () => number,
 * }} input
 */
export function mintStartupChallenge(input) {
  if (!ATTEST_OPERATIONS.includes(input.operation)) {
    refuse('STARTUP_OPERATION_MISMATCH', 'startup challenge operation is not a closed attest name');
  }
  if (!requiredString(input.tenantId) || !fingerprintString(input.repositoryFingerprint)
    || !fingerprintString(input.resourceFingerprint) || !fingerprintString(input.migrationSetFingerprint)) {
    refuse('STARTUP_ATTESTATION_REFUSED', 'startup challenge bindings are incomplete');
  }
  const permission = input.permission ?? STARTUP_MIGRATE_PERMISSION;
  if (permission !== STARTUP_MIGRATE_PERMISSION) {
    refuse('STARTUP_PERMISSION_MISSING', 'startup attestation requires schema:migrate');
  }
  if (input.operation === 'attestDataStartup') {
    if (!fingerprintString(input.priorControlAttestation)) {
      refuse('STARTUP_ATTESTATION_REFUSED', 'data-plane attestation requires the prior control evidence fingerprint');
    }
  } else if (input.priorControlAttestation != null) {
    refuse('STARTUP_ATTESTATION_REFUSED', 'control-plane attestation cannot carry a prior control fingerprint');
  }
  const now = input.now ?? Date.now;
  const issuedAt = now();
  const nonce = randomBytes(32).toString('hex');
  const challenge = Object.freeze({
    contract: STARTUP_ATTESTATION_CONTRACT,
    operation: input.operation,
    nonce,
    issuedAt: new Date(issuedAt).toISOString(),
    expiresAt: new Date(issuedAt + STARTUP_CHALLENGE_TTL_MS).toISOString(),
    repositoryFingerprint: input.repositoryFingerprint,
    tenantId: input.tenantId,
    resourceFingerprint: input.resourceFingerprint,
    permission,
    migrationSetFingerprint: input.migrationSetFingerprint,
    ...(input.operation === 'attestDataStartup'
      ? { priorControlAttestation: input.priorControlAttestation }
      : {}),
  });
  return Object.freeze({
    challenge,
    fingerprint: canonicalFingerprint(challenge),
  });
}

/**
 * @param {unknown} handle
 * @param {'control'|'data'} plane
 */
export function assertDiscoverHandle(handle, plane) {
  if (!PLANES.includes(plane)) refuse('STARTUP_OPERATION_MISMATCH', 'startup discovery plane is not closed');
  if (!closedNames(handle, ['plane', 'resourceClass']) || !isPlainObject(handle)) {
    refuse('STARTUP_ATTESTATION_REFUSED', 'startup discovery handle is not a closed opaque handle');
  }
  const object = /** @type {Record<string, unknown>} */ (handle);
  if (object.plane !== plane || object.resourceClass !== 'postgresql') {
    refuse('STARTUP_RESOURCE_MISMATCH', 'startup discovery handle does not match the selected plane');
  }
  return object;
}

/**
 * @param {unknown} discovered
 * @param {'control'|'data'} plane
 */
export function acceptDiscoveredResource(discovered, plane) {
  if (!closedNames(discovered, ['resourceId', 'resourceFingerprint']) || !isPlainObject(discovered)) {
    refuse('STARTUP_ATTESTATION_REFUSED', 'startup discovery did not return a closed resource identity');
  }
  const object = /** @type {Record<string, unknown>} */ (discovered);
  if (!requiredString(object.resourceId) || !fingerprintString(object.resourceFingerprint)) {
    refuse('STARTUP_ATTESTATION_REFUSED', 'startup discovery resource identity is incomplete');
  }
  void plane;
  return Object.freeze({
    resourceId: /** @type {string} */ (object.resourceId),
    resourceFingerprint: /** @type {string} */ (object.resourceFingerprint),
  });
}

/**
 * @param {{
 *   challenge: { fingerprint: string, challenge: Record<string, unknown> },
 *   evidence: unknown,
 *   seenNonces: Set<string>,
 *   now?: () => number,
 * }} input
 */
export function acceptStartupEvidence(input) {
  const { challenge } = input.challenge;
  const now = input.now ?? Date.now;
  if (!isPlainObject(input.evidence) || !closedNames(input.evidence, [
    'identityClass', 'identityFingerprint', 'evidenceFingerprint', 'permission', 'expiresAt',
    'challengeNonce', 'operation', 'tenantId', 'resourceFingerprint', 'migrationSetFingerprint',
  ])) {
    refuse('STARTUP_ATTESTATION_REFUSED', 'startup attestation evidence is not a closed document');
  }
  const evidence = /** @type {Record<string, unknown>} */ (input.evidence);
  if (evidence.identityClass !== 'startup'
    || evidence.operation === 'verifyRequest'
    || DISCOVER_OPERATIONS.includes(/** @type {string} */ (evidence.operation))) {
    refuse('STARTUP_EVIDENCE_INTERCHANGEABLE', 'request or discovery evidence cannot satisfy startup attestation');
  }
  if (evidence.operation !== challenge.operation) {
    refuse('STARTUP_OPERATION_MISMATCH', 'startup attestation evidence does not match the challenged operation');
  }
  if (evidence.tenantId !== challenge.tenantId) {
    refuse('STARTUP_TENANT_MISMATCH', 'startup attestation tenant does not match the challenge');
  }
  if (evidence.resourceFingerprint !== challenge.resourceFingerprint) {
    refuse('STARTUP_RESOURCE_MISMATCH', 'startup attestation resource does not match the challenge');
  }
  if (evidence.migrationSetFingerprint !== challenge.migrationSetFingerprint) {
    refuse('STARTUP_MIGRATION_SET_MISMATCH', 'startup attestation migration set does not match the challenge');
  }
  if (evidence.permission !== STARTUP_MIGRATE_PERMISSION) {
    refuse('STARTUP_PERMISSION_MISSING', 'startup attestation lacks schema:migrate');
  }
  if (!fingerprintString(evidence.identityFingerprint) || !fingerprintString(evidence.evidenceFingerprint)) {
    refuse('STARTUP_ATTESTATION_REFUSED', 'startup attestation fingerprints are incomplete');
  }
  if (evidence.challengeNonce !== challenge.nonce) {
    refuse('STARTUP_ATTESTATION_REFUSED', 'startup attestation does not bind the issued challenge');
  }
  if (input.seenNonces.has(/** @type {string} */ (challenge.nonce))) {
    refuse('STARTUP_CHALLENGE_REPLAYED', 'startup challenge has already been consumed');
  }
  const expiresAt = Date.parse(String(evidence.expiresAt ?? ''));
  const challengeExpiry = Date.parse(String(challenge.expiresAt ?? ''));
  if (!Number.isFinite(expiresAt) || !Number.isFinite(challengeExpiry) || now() > Math.min(expiresAt, challengeExpiry)) {
    refuse('STARTUP_CHALLENGE_EXPIRED', 'startup attestation evidence has expired');
  }
  input.seenNonces.add(/** @type {string} */ (challenge.nonce));
  return Object.freeze({
    identityFingerprint: /** @type {string} */ (evidence.identityFingerprint),
    evidenceFingerprint: /** @type {string} */ (evidence.evidenceFingerprint),
    permission: STARTUP_MIGRATE_PERMISSION,
    challengeFingerprint: input.challenge.fingerprint,
    operation: /** @type {string} */ (challenge.operation),
  });
}

/**
 * Run the ordered discover/attest sequence. Request verification is never a
 * substitute for any of these operations.
 *
 * @param {{
 *   operations: {
 *     verifyRequest?: Function,
 *     discoverControlResource: Function,
 *     attestControlStartup: Function,
 *     discoverDataResource: Function,
 *     attestDataStartup: Function,
 *   },
 *   tenantId: string,
 *   repositoryFingerprint: string,
 *   controlMigrations: Array<{version?: unknown, name?: unknown, checksum?: unknown}>,
 *   dataMigrations: Array<{version?: unknown, name?: unknown, checksum?: unknown}>,
 *   now?: () => number,
 *   phase?: 'control' | 'data' | 'both',
 *   priorControl?: { resource: { resourceId: string, resourceFingerprint: string }, evidence: { evidenceFingerprint: string } },
 * }} input
 */
export async function attestPostgresqlStartup(input) {
  if (!input?.operations || typeof input.operations.discoverControlResource !== 'function'
    || typeof input.operations.attestControlStartup !== 'function'
    || typeof input.operations.discoverDataResource !== 'function'
    || typeof input.operations.attestDataStartup !== 'function') {
    refuse('STARTUP_ATTESTATION_REFUSED', 'startup verifier operations are incomplete');
  }
  const seenNonces = new Set();
  const phase = input.phase ?? 'both';
  const controlHandle = Object.freeze({ plane: 'control', resourceClass: 'postgresql' });
  const dataHandle = Object.freeze({ plane: 'data', resourceClass: 'postgresql' });
  let controlDiscovered = input.priorControl?.resource ?? null;
  let controlEvidence = input.priorControl?.evidence ?? null;
  let controlMigrations = fingerprintMigrationSet(input.controlMigrations);
  let controlChallengeFingerprint = null;
  if (phase !== 'data') {
    controlDiscovered = acceptDiscoveredResource(
      await input.operations.discoverControlResource(controlHandle),
      'control',
    );
    const controlChallenge = mintStartupChallenge({
      operation: 'attestControlStartup',
      tenantId: input.tenantId,
      repositoryFingerprint: input.repositoryFingerprint,
      resourceFingerprint: controlDiscovered.resourceFingerprint,
      migrationSetFingerprint: controlMigrations,
      now: input.now,
    });
    controlEvidence = acceptStartupEvidence({
      challenge: controlChallenge,
      evidence: await input.operations.attestControlStartup(controlChallenge.challenge),
      seenNonces,
      now: input.now,
    });
    controlChallengeFingerprint = controlChallenge.fingerprint;
  }
  const control = Object.freeze({
    resource: controlDiscovered,
    evidence: controlEvidence,
    migrationSetFingerprint: controlMigrations,
    challengeFingerprint: controlChallengeFingerprint,
  });
  if (phase === 'control') {
    return Object.freeze({ contract: STARTUP_ATTESTATION_CONTRACT, control, data: null });
  }

  const dataDiscovered = acceptDiscoveredResource(
    await input.operations.discoverDataResource(dataHandle),
    'data',
  );
  if (dataDiscovered.resourceFingerprint === controlDiscovered.resourceFingerprint
    || dataDiscovered.resourceId === controlDiscovered.resourceId) {
    refuse('STARTUP_RESOURCE_MISMATCH', 'control and data resources must not share an identity');
  }
  const dataMigrations = fingerprintMigrationSet(input.dataMigrations);
  const dataChallenge = mintStartupChallenge({
    operation: 'attestDataStartup',
    tenantId: input.tenantId,
    repositoryFingerprint: input.repositoryFingerprint,
    resourceFingerprint: dataDiscovered.resourceFingerprint,
    migrationSetFingerprint: dataMigrations,
    priorControlAttestation: controlEvidence.evidenceFingerprint,
    now: input.now,
  });
  const dataEvidence = acceptStartupEvidence({
    challenge: dataChallenge,
    evidence: await input.operations.attestDataStartup(dataChallenge.challenge),
    seenNonces,
    now: input.now,
  });

  return Object.freeze({
    contract: STARTUP_ATTESTATION_CONTRACT,
    control,
    data: Object.freeze({
      resource: dataDiscovered,
      evidence: dataEvidence,
      migrationSetFingerprint: dataMigrations,
      challengeFingerprint: dataChallenge.fingerprint,
    }),
  });
}
