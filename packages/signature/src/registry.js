// @ts-check

import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  AppError,
  ValidationError,
  NotFoundError,
  createDefinitionVersionStore,
  computeDefinitionFingerprint,
  validateDeclaredConfig,
} from '../../core/index.js';

/**
 * Signature provider registry (ADR-017): bounded, versioned, fingerprinted
 * definitions on the ADR-015 declared-definition mechanism — Map-backed
 * per-app registries, fail-closed startup, canonical fingerprints over source
 * plus declared JSON-safe config, persisted in `definition_versions`.
 *
 * A provider declares four handlers:
 *
 *   createEnvelope({idempotencyKey, document, signers})  → provider envelope
 *   getEnvelope({providerEnvelopeId, idempotencyKey})    → normalized state
 *   verifyEvent({rawBody, headers, config})              → verified event
 *   getSignedArtifact({providerEnvelopeId})              → artifact metadata
 *
 * The fingerprint proves **provider code and declared config integrity** — it
 * says nothing about the remote service's behavior, which is why every remote
 * result is re-validated into the normalized contract below before it can
 * touch local state.
 *
 * Only a deterministic offline fixture provider ships. No DocuSign, Adobe Sign
 * or Dropbox Sign integration exists or is claimed.
 */

const NAME_RE = /^[a-z][a-z0-9-]*$/;
const MAX_LABEL = 80;
const MAX_VERSION = 1_000_000;
const MAX_TEXT = 500;
const REQUIRED_HANDLERS = ['createEnvelope', 'getEnvelope', 'verifyEvent', 'getSignedArtifact'];

/** Normalized envelope states. Ordering between them is a TABLE, not a rank. */
export const ENVELOPE_STATES = Object.freeze(['preparing', 'failed', 'sent', 'delivered', 'completed', 'declined', 'voided']);
export const TERMINAL_ENVELOPE_STATES = Object.freeze(['completed', 'declined', 'voided']);
export const SIGNER_STATES = Object.freeze(['pending', 'signed', 'declined']);
export const MAX_SIGNERS = 5;

/**
 * The explicit allowed-transition table. Branching states (completed vs
 * declined vs voided) are NOT ordered relative to each other, so a numeric
 * rank cannot express them: `completed → declined` and `declined → completed`
 * must both be impossible even though they would compare equal. The table is
 * the contract, and it is what the documentation publishes.
 *
 *   preparing  the local intent exists; the provider may or may not have it
 *   failed     a LOCAL phase failed; recoverable only through reconciliation
 *   sent       the provider accepted the envelope
 *   delivered  the provider reached the signers
 *   completed  terminal — every signer signed
 *   declined   terminal — a signer refused
 *   voided     terminal — the envelope was cancelled at the provider
 */
const ALLOWED_TRANSITIONS = Object.freeze({
  // A provider truth observed by reconciliation may jump straight to any
  // provider state, including a terminal one: the local intent simply had not
  // learned it yet.
  preparing: Object.freeze(['failed', 'sent', 'delivered', 'completed', 'declined', 'voided']),
  failed: Object.freeze(['sent', 'delivered', 'completed', 'declined', 'voided']),
  sent: Object.freeze(['delivered', 'completed', 'declined', 'voided']),
  delivered: Object.freeze(['completed', 'declined', 'voided']),
  completed: Object.freeze([]),
  declined: Object.freeze([]),
  voided: Object.freeze([]),
});

/** The states reachable from `state`, as published in the schema and docs. */
export function allowedTransitions(state) {
  if (!Object.prototype.hasOwnProperty.call(ALLOWED_TRANSITIONS, state)) {
    throw new ValidationError(`Unknown envelope state "${state}"`);
  }
  return ALLOWED_TRANSITIONS[state];
}

/**
 * Decide whether `next` may be applied on top of `current`, by table lookup —
 * never by comparing ranks. Unknown states, self-transitions and every
 * transition out of a terminal state are refused.
 * @param {string} current @param {string} next
 */
export function canTransition(current, next) {
  if (!ENVELOPE_STATES.includes(current) || !ENVELOPE_STATES.includes(next)) return false;
  return allowedTransitions(current).includes(next);
}

/** @param {string} label @param {any} definition */
function assertIdentity(label, definition) {
  if (!definition || typeof definition !== 'object') {
    throw new ValidationError(`${label} definition must be an object`);
  }
  if (typeof definition.name !== 'string' || !NAME_RE.test(definition.name)) {
    throw new ValidationError(`${label} "${String(definition.name)}": name must match ${NAME_RE}`);
  }
  if (!Number.isSafeInteger(definition.version) || definition.version < 1 || definition.version > MAX_VERSION) {
    throw new ValidationError(`${label} "${definition.name}": version must be a positive integer (1–${MAX_VERSION})`);
  }
  if (definition.label !== undefined && (typeof definition.label !== 'string' || definition.label.length === 0 || definition.label.length > MAX_LABEL)) {
    throw new ValidationError(`${label} "${definition.name}": label must be a non-empty string of at most ${MAX_LABEL} characters`);
  }
  validateDeclaredConfig(`${label} "${definition.name}@${definition.version}"`, definition.config);
}

/** @param {any} definition */
export function validateSignatureProvider(definition) {
  assertIdentity('signature provider', definition);
  for (const handler of REQUIRED_HANDLERS) {
    if (typeof definition[handler] !== 'function') {
      throw new ValidationError(`signature provider "${definition.name}@${definition.version}": ${handler} must be a function`);
    }
  }
  return definition;
}

/** Provider results are third-party data: bounded, canonical or refused. */
function providerText(value, field, { optional = false, max = MAX_TEXT } = {}) {
  if (value === undefined || value === null) {
    if (optional) return null;
    throw new AppError(`Signature provider returned no "${field}"`, { code: 'PROVIDER_INVALID', status: 502, details: { field } });
  }
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) {
    throw new AppError(`Signature provider returned an invalid "${field}"`, { code: 'PROVIDER_INVALID', status: 502, details: { field } });
  }
  return value.trim();
}

/** @param {unknown} value @param {string} field */
function providerInteger(value, field, { optional = false, min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null) {
    if (optional) return null;
    throw new AppError(`Signature provider returned no "${field}"`, { code: 'PROVIDER_INVALID', status: 502, details: { field } });
  }
  if (!Number.isSafeInteger(value) || /** @type {number} */ (value) < min || /** @type {number} */ (value) > max) {
    throw new AppError(`Signature provider returned an invalid "${field}"`, { code: 'PROVIDER_INVALID', status: 502, details: { field } });
  }
  return /** @type {number} */ (value);
}

/** @param {unknown} raw */
export function normalizeProviderEnvelope(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AppError('Signature provider returned a non-object envelope', { code: 'PROVIDER_INVALID', status: 502 });
  }
  const value = /** @type {Record<string, any>} */ (raw);
  const status = providerText(value.status, 'status');
  if (!ENVELOPE_STATES.includes(status) || status === 'preparing' || status === 'failed') {
    throw new AppError(`Signature provider returned an unsupported envelope status "${status}"`, {
      code: 'PROVIDER_INVALID', status: 502, details: { field: 'status' },
    });
  }
  return {
    providerEnvelopeId: providerText(value.providerEnvelopeId, 'providerEnvelopeId', { max: 200 }),
    status,
    sequence: providerInteger(value.sequence, 'sequence', { optional: true, min: 0 }) ?? 0,
    signers: normalizeProviderSigners(value.signers),
    completedAt: providerText(value.completedAt, 'completedAt', { optional: true, max: 40 }),
    // Echoed identity: what the provider believes it is holding. Used to prove
    // the envelope answering our idempotency key is genuinely ours.
    documentHash: providerText(value.documentHash, 'documentHash', { optional: true, max: 128 }),
  };
}

/**
 * An idempotency key is a lookup, not a proof of identity. Before a provider
 * envelope is adopted it must agree with the local intent on the document that
 * was signed and on the signer set. Anything else is a semantic mismatch and
 * fails closed rather than binding a foreign envelope to a quote version.
 *
 * @param {{documentHash: string, signerKeys: string[]}} local
 * @param {{providerEnvelopeId: string, documentHash: string | null, signers: Array<{signerKey: string}>}} provider
 * @param {{expectedProviderEnvelopeId?: string | null}} [options]
 */
export function assertProviderEnvelopeMatches(local, provider, options = {}) {
  const mismatch = (field, detail) => {
    throw new AppError(
      `The provider envelope does not match this signature request (${field})`,
      { code: 'PROVIDER_ENVELOPE_MISMATCH', status: 409, details: { field, ...detail } },
    );
  };
  if (options.expectedProviderEnvelopeId && provider.providerEnvelopeId !== options.expectedProviderEnvelopeId) {
    mismatch('providerEnvelopeId', {});
  }
  // A provider that does not echo the document hash cannot be checked on it;
  // that weaker guarantee is documented rather than silently assumed away.
  if (provider.documentHash && provider.documentHash !== local.documentHash) mismatch('documentHash', {});
  if (provider.signers.length > 0) {
    const local_keys = [...local.signerKeys].sort();
    const remote = provider.signers.map((signer) => signer.signerKey).sort();
    if (local_keys.length !== remote.length || local_keys.some((key, index) => key !== remote[index])) {
      mismatch('signers', { expected: local_keys.length, received: remote.length });
    }
  }
  return provider;
}

/** @param {unknown} raw */
function normalizeProviderSigners(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > MAX_SIGNERS) {
    throw new AppError('Signature provider returned an invalid signer list', { code: 'PROVIDER_INVALID', status: 502, details: { field: 'signers' } });
  }
  return raw.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new AppError('Signature provider returned an invalid signer', { code: 'PROVIDER_INVALID', status: 502, details: { field: 'signers' } });
    }
    const signer = /** @type {Record<string, any>} */ (entry);
    const status = providerText(signer.status, 'signers[].status', { max: 40 });
    if (!SIGNER_STATES.includes(status)) {
      throw new AppError(`Signature provider returned an unsupported signer status "${status}"`, { code: 'PROVIDER_INVALID', status: 502, details: { field: 'signers[].status' } });
    }
    return {
      signerKey: providerText(signer.signerKey, 'signers[].signerKey', { max: 200 }),
      status,
      decidedAt: providerText(signer.decidedAt, 'signers[].decidedAt', { optional: true, max: 40 }),
    };
  });
}

/** @param {unknown} raw */
export function normalizeProviderArtifact(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AppError('Signature provider returned a non-object artifact', { code: 'PROVIDER_INVALID', status: 502 });
  }
  const value = /** @type {Record<string, any>} */ (raw);
  return {
    artifactId: providerText(value.artifactId, 'artifactId', { max: 200 }),
    artifactHash: providerText(value.artifactHash, 'artifactHash', { optional: true, max: 128 }),
    mimeType: providerText(value.mimeType, 'mimeType', { max: 100 }),
    sizeBytes: providerInteger(value.sizeBytes, 'sizeBytes', { optional: true, min: 0, max: 1_000_000_000_000 }),
    storageRef: providerText(value.storageRef, 'storageRef', { optional: true, max: 300 }),
    completedAt: providerText(value.completedAt, 'completedAt', { optional: true, max: 40 }),
  };
}

/** @param {unknown} raw */
export function normalizeProviderEvent(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AppError('Signature provider returned a non-object event', { code: 'PROVIDER_INVALID', status: 502 });
  }
  const value = /** @type {Record<string, any>} */ (raw);
  const status = providerText(value.status, 'status');
  if (!ENVELOPE_STATES.includes(status) || status === 'preparing' || status === 'failed') {
    throw new AppError(`Signature provider returned an unsupported event status "${status}"`, { code: 'PROVIDER_INVALID', status: 502, details: { field: 'status' } });
  }
  return {
    providerEventId: providerText(value.providerEventId, 'providerEventId', { max: 200 }),
    providerEnvelopeId: providerText(value.providerEnvelopeId, 'providerEnvelopeId', { max: 200 }),
    status,
    sequence: providerInteger(value.sequence, 'sequence', { optional: true, min: 0 }) ?? 0,
    occurredAt: providerText(value.occurredAt, 'occurredAt', { optional: true, max: 40 }),
    signers: normalizeProviderSigners(value.signers),
  };
}

/**
 * Constant-time HMAC-SHA256 verification helper shared by fixture providers.
 * The key is whatever the provider declared in `config`; in this milestone
 * that is a **test-only** value in checked-in source, never production
 * webhook security (real secret management is Production Spine work).
 *
 * @param {{rawBody: string, signature: unknown, timestamp: unknown, key: string, toleranceSeconds?: number, nowMs?: number}} params
 */
export function verifyHmacSignature(params) {
  const { key } = params;
  // Bytes, not a decoded string: a body containing invalid UTF-8 would not
  // survive a string round trip, and the MAC must cover exactly what the
  // provider signed.
  const rawBody = Buffer.isBuffer(params.rawBody) ? params.rawBody : Buffer.from(String(params.rawBody ?? ''), 'utf8');
  const tolerance = params.toleranceSeconds ?? 300;
  const nowMs = params.nowMs ?? Date.now();
  if (typeof params.signature !== 'string' || !/^[0-9a-f]{64}$/.test(params.signature)) {
    return { ok: false, reason: 'malformed signature header' };
  }
  if (typeof params.timestamp !== 'string' || !/^\d{1,15}$/.test(params.timestamp)) {
    return { ok: false, reason: 'malformed timestamp header' };
  }
  const skewMs = Math.abs(nowMs - Number(params.timestamp) * 1000);
  if (skewMs > tolerance * 1000) {
    return { ok: false, reason: 'timestamp outside the replay window' };
  }
  const expected = createHmac('sha256', key).update(Buffer.concat([Buffer.from(`${params.timestamp}.`, 'utf8'), rawBody])).digest();
  const provided = Buffer.from(params.signature, 'hex');
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { ok: false, reason: 'signature mismatch' };
  }
  return { ok: true, reason: null };
}

/** Compute the header pair a fixture/test client must send. */
export function hmacSignatureHeaders(rawBody, key, timestampSeconds) {
  const timestamp = String(timestampSeconds);
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
  return {
    'x-signature-timestamp': timestamp,
    'x-signature-256': createHmac('sha256', key).update(Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), body])).digest('hex'),
  };
}

/** Per-app signature provider registry; one malformed definition stops startup. */
export class SignatureRegistries {
  /** @param {{signatureProviders?: any[]}} [definitions] */
  constructor(definitions = {}) {
    /** @type {Map<string, any>} */
    this.signatureProviders = new Map();
    for (const definition of definitions.signatureProviders ?? []) {
      validateSignatureProvider(definition);
      const key = `${definition.name}@${definition.version}`;
      if (this.signatureProviders.has(key)) {
        throw new ValidationError(`Duplicate signature provider identity: ${key}`);
      }
      this.signatureProviders.set(key, {
        definition,
        fingerprint: computeDefinitionFingerprint({
          type: 'signature-provider',
          name: definition.name,
          version: definition.version,
          config: definition.config ?? null,
          createEnvelope: definition.createEnvelope,
          getEnvelope: definition.getEnvelope,
          verifyEvent: definition.verifyEvent,
          getSignedArtifact: definition.getSignedArtifact,
        }),
      });
    }
  }

  /** @param {string} name @param {number} version — returns {definition, fingerprint} */
  getSignatureProvider(name, version) {
    // Map-backed: "__proto__"/"constructor" can never resolve to an inherited
    // property, and a non-canonical name simply does not exist.
    const entry = this.signatureProviders.get(`${name}@${version}`);
    if (!entry) throw new NotFoundError('Signature provider', `${name}@${version}`);
    return entry;
  }

  /**
   * Resolve a provider by name only — used by the event route, where the
   * provider is named in the URL. Refuses ambiguity instead of guessing a
   * "latest" version.
   * @param {string} name
   */
  getSignatureProviderByName(name) {
    const matches = [...this.signatureProviders.values()].filter((entry) => entry.definition.name === name);
    if (matches.length === 0) throw new NotFoundError('Signature provider', String(name));
    if (matches.length > 1) {
      throw new AppError(`Signature provider "${name}" is registered in several versions — address it explicitly`, {
        code: 'PROVIDER_AMBIGUOUS', status: 409,
      });
    }
    return matches[0];
  }

  /**
   * Persist-or-verify every provider identity in `definition_versions`, in one
   * transaction (ADR-015). The kernel's definition-version store owns that
   * loop; this registry only names the identities it publishes.
   * @param {any} database
   */
  persistFingerprints(database) {
    const entries = [...this.signatureProviders.values()];
    if (entries.length === 0) return;
    createDefinitionVersionStore(database).persist(entries.map((entry) => ({
      type: 'signature-provider',
      name: entry.definition.name,
      version: entry.definition.version,
      fingerprint: entry.fingerprint,
    })));
  }

  /** Serializable, function-free metadata for /api/schema — never a secret. */
  metadata() {
    return {
      signatureContract: 1,
      envelopeStates: [...ENVELOPE_STATES],
      terminalStates: [...TERMINAL_ENVELOPE_STATES],
      allowedTransitions: Object.fromEntries(ENVELOPE_STATES.map((state) => [state, [...allowedTransitions(state)]])),
      replayScope: 'provider + providerEventId; the payload fingerprint must match or the reuse is refused 409 EVENT_ID_CONFLICT',
      artifactHash: 'provider-reported; accordo does not download or hash the artifact bytes and verifies no signature cryptographically',
      signerSemantics: 'all signers required; declared order is recorded, not sequentially gated; 1-5 signers; no conditional routing; signer identity assurance is not claimed',
      maxSigners: MAX_SIGNERS,
      humanApproval: 'request-signature requires actor.type === "user"; agent actors are refused 403 HUMAN_APPROVAL_REQUIRED',
      eventEndpoint: '/api/signature/providers/:provider/events (raw body, provider-verified, bounded)',
      eventVerification: 'provider-declared; the shipped fixture uses a test-only HMAC key and is NOT production webhook security',
      orderSnapshot: 'orders copy the approved quote version snapshot (lines, components, tier schedules, band breakdowns, grouped totals) and never read the live catalog',
      documentPackage: 'deterministic canonical JSON derived from the approved quote version, SHA-256 hashed; not a PDF',
      providers: [...this.signatureProviders.values()]
        .sort((a, b) => (a.definition.name === b.definition.name
          ? a.definition.version - b.definition.version
          : a.definition.name < b.definition.name ? -1 : 1))
        .map(({ definition, fingerprint }) => ({
          name: definition.name,
          version: definition.version,
          label: definition.label ?? definition.name,
          fingerprint,
        })),
    };
  }
}
