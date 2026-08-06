// @ts-check

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { hmacSignatureHeaders, verifyHmacSignature } from '../../../packages/core/src/signature-registry.js';

/**
 * Deterministic offline signature provider for the B2B starter (ADR-017).
 *
 * It behaves like an external signature service without being one: envelopes
 * live in an in-process Map keyed by the deterministic idempotency key, states
 * are driven explicitly by test/starter helpers, and event payloads are signed
 * with an HMAC so the real verification path is exercised.
 *
 * **No DocuSign, Adobe Sign or Dropbox Sign integration exists here, and none
 * is claimed.** No network call, no email, no credential.
 *
 * SECURITY, stated plainly: `testOnlyVerificationKey` is a fixture key checked
 * into source so the contract can be proven offline. It is NOT production
 * webhook security — real secret management (rotation, per-tenant keys, a
 * secret store) is Production Spine work. Never point this provider at a real
 * signature service.
 */

const TEST_ONLY_VERIFICATION_KEY = 'fixture-signature-test-only-key-not-a-secret';

/** @type {Map<string, any>} */
const envelopes = new Map();
/** @type {Map<string, string>} */
const byProviderId = new Map();
let eventCounter = 0;

/**
 * A real signature provider outlives the CRM process. When
 * `AGENT_CRM_FIXTURE_SIGNATURE_STORE` names a file, the fixture keeps its
 * envelopes there instead of only in memory, so a test can crash the CRM
 * mid-operation and still find the envelope the "provider" accepted. Test and
 * starter affordance only — it is never a datastore for anything real.
 */
const storePath = () => process.env.AGENT_CRM_FIXTURE_SIGNATURE_STORE ?? null;

function loadStore() {
  const path = storePath();
  if (!path || !existsSync(path)) return;
  try {
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    envelopes.clear();
    byProviderId.clear();
    for (const envelope of saved.envelopes ?? []) {
      envelopes.set(envelope.idempotencyKey, envelope);
      byProviderId.set(envelope.providerEnvelopeId, envelope.idempotencyKey);
    }
  } catch {
    // A corrupt fixture store is simply an empty provider.
  }
}

function saveStore() {
  const path = storePath();
  if (!path) return;
  writeFileSync(path, JSON.stringify({ envelopes: [...envelopes.values()] }));
}

/** Deterministic provider ids: same idempotency key → same envelope id. */
function providerEnvelopeId(idempotencyKey) {
  return `env_${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 24)}`;
}

/** Reset fixture state (tests only). */
export function resetSignatureFixture() {
  envelopes.clear();
  byProviderId.clear();
  eventCounter = 0;
  saveStore();
}

/** @param {string} key */
function requireEnvelope(key) {
  loadStore();
  const envelope = envelopes.get(key);
  if (!envelope) throw new Error(`fixture signature envelope not found: ${key}`);
  return envelope;
}

/** Advance the fixture envelope, exactly like a signer acting in a real UI. */
function advance(idempotencyKey, status, { signers } = {}) {
  const envelope = requireEnvelope(idempotencyKey);
  envelope.status = status;
  envelope.sequence += 1;
  if (status === 'completed' || status === 'declined') {
    envelope.completedAt = '2026-08-05T12:00:00.000Z';
    envelope.signers = envelope.signers.map((signer) => ({
      ...signer,
      status: signers?.[signer.signerKey] ?? (status === 'completed' ? 'signed' : 'declined'),
      decidedAt: '2026-08-05T12:00:00.000Z',
    }));
  }
  saveStore();
  return envelope;
}

export const signatureFixture = {
  key: TEST_ONLY_VERIFICATION_KEY,
  reset: resetSignatureFixture,
  /** Drive the fixture provider's own state (a signer acting). */
  markSent: (idempotencyKey) => advance(idempotencyKey, 'sent'),
  markDelivered: (idempotencyKey) => advance(idempotencyKey, 'delivered'),
  markCompleted: (idempotencyKey) => advance(idempotencyKey, 'completed'),
  markDeclined: (idempotencyKey) => advance(idempotencyKey, 'declined'),
  markVoided: (idempotencyKey) => advance(idempotencyKey, 'voided'),
  envelope: (idempotencyKey) => requireEnvelope(idempotencyKey),
  /**
   * Build one signed webhook request body + headers. `providerEventId` is
   * explicit so replay, out-of-order and forged-id cases are all testable.
   */
  event(idempotencyKey, status, options = {}) {
    const envelope = requireEnvelope(idempotencyKey);
    eventCounter += 1;
    const payload = {
      providerEventId: options.providerEventId ?? `evt_${eventCounter}`,
      providerEnvelopeId: options.providerEnvelopeId ?? envelope.providerEnvelopeId,
      status,
      sequence: options.sequence ?? envelope.sequence,
      occurredAt: options.occurredAt ?? '2026-08-05T12:00:00.000Z',
      signers: options.signers ?? envelope.signers.map((signer) => ({
        signerKey: signer.signerKey,
        status: status === 'completed' ? 'signed' : status === 'declined' ? 'declined' : signer.status,
        decidedAt: status === 'completed' || status === 'declined' ? '2026-08-05T12:00:00.000Z' : null,
      })),
    };
    const rawBody = options.rawBody ?? JSON.stringify(payload);
    const timestamp = options.timestampSeconds ?? Math.floor(Date.now() / 1000);
    const headers = options.headers ?? hmacSignatureHeaders(rawBody, TEST_ONLY_VERIFICATION_KEY, timestamp);
    return { rawBody, headers, payload };
  },
};

export const fixtureSignatureProvider = {
  name: 'fixture-signature',
  version: 1,
  label: 'Fixture signature provider (deterministic)',
  // Declared config is part of the definition fingerprint. The key lives here
  // — and is labelled test-only — precisely so that changing it without
  // publishing a new provider version stops the application at boot.
  config: { source: 'fixture', testOnlyVerificationKey: TEST_ONLY_VERIFICATION_KEY, replayToleranceSeconds: 300 },

  /** Idempotent by construction: the same key always yields the same envelope. */
  async createEnvelope(input) {
    const idempotencyKey = String(input?.idempotencyKey ?? '');
    if (idempotencyKey === '') throw new Error('idempotencyKey is required');
    if (String(input?.documentHash ?? '') === '') throw new Error('documentHash is required');
    if (String(input?.documentBytes ?? '') === '') throw new Error('documentBytes is required');
    // Deterministic failure paths, selected by a magic signer domain so a test
    // never needs a network, a clock or a second provider definition.
    const domains = (input.signers ?? []).map((signer) => String(signer.email ?? '').split('@')[1] ?? '');
    if (domains.includes('outage.example')) throw new Error('simulated signature provider outage');
    if (domains.includes('timeout.example')) return new Promise(() => {}); // never settles → timeout path
    loadStore();
    const existing = envelopes.get(idempotencyKey);
    if (existing) return snapshot(existing);
    const envelope = {
      idempotencyKey,
      providerEnvelopeId: providerEnvelopeId(idempotencyKey),
      status: 'sent',
      sequence: 1,
      documentHash: input.documentHash,
      completedAt: null,
      signers: (input.signers ?? []).map((signer) => ({ signerKey: signer.signerKey, status: 'pending', decidedAt: null })),
    };
    envelopes.set(idempotencyKey, envelope);
    byProviderId.set(envelope.providerEnvelopeId, idempotencyKey);
    saveStore();
    return snapshot(envelope);
  },

  /** Lookup by provider id or — for recovery — by idempotency key. */
  async getEnvelope(input) {
    loadStore();
    const key = input?.providerEnvelopeId ? byProviderId.get(String(input.providerEnvelopeId)) : null;
    const envelope = envelopes.get(key ?? String(input?.idempotencyKey ?? ''));
    return envelope ? snapshot(envelope) : null;
  },

  /**
   * Verify a webhook: constant-time HMAC over `timestamp.rawBody` plus a
   * bounded replay window. Failures never echo the payload or the signature.
   */
  async verifyEvent({ rawBody, headers, config }) {
    const verdict = verifyHmacSignature({
      rawBody,
      signature: headers?.['x-signature-256'],
      timestamp: headers?.['x-signature-timestamp'],
      key: String(config?.testOnlyVerificationKey ?? ''),
      toleranceSeconds: Number(config?.replayToleranceSeconds ?? 300),
    });
    if (!verdict.ok) return { ok: false };
    // Only AFTER the bytes are verified are they decoded and parsed.
    let payload;
    try {
      payload = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody));
    } catch {
      return { ok: false };
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false };
    return { ok: true, event: payload };
  },

  async getSignedArtifact({ providerEnvelopeId }) {
    loadStore();
    const key = byProviderId.get(String(providerEnvelopeId));
    const envelope = key ? envelopes.get(key) : null;
    if (!envelope) throw new Error('unknown envelope');
    const artifactHash = createHash('sha256').update(`${envelope.providerEnvelopeId}:${envelope.documentHash}`).digest('hex');
    return {
      artifactId: `art_${envelope.providerEnvelopeId.slice(4, 20)}`,
      artifactHash,
      // A deterministic JSON package, NOT a PDF — it is never called one.
      mimeType: 'application/vnd.agent-crm.quote-package+json',
      sizeBytes: 2048,
      storageRef: `fixture://artifacts/${envelope.providerEnvelopeId}`,
      completedAt: envelope.completedAt,
    };
  },
};

function snapshot(envelope) {
  return {
    providerEnvelopeId: envelope.providerEnvelopeId,
    status: envelope.status,
    sequence: envelope.sequence,
    completedAt: envelope.completedAt,
    // Echoed so the caller can prove this envelope is the one it asked for,
    // rather than merely one that answered the same idempotency key.
    documentHash: envelope.documentHash,
    signers: envelope.signers.map((signer) => ({ ...signer })),
  };
}
