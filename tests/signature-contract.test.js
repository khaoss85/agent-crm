import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ENVELOPE_STATES,
  MAX_SIGNERS,
  SignatureRegistries,
  TERMINAL_ENVELOPE_STATES,
  canTransition,
  envelopeRank,
  hmacSignatureHeaders,
  normalizeProviderArtifact,
  normalizeProviderEnvelope,
  normalizeProviderEvent,
  validateSignatureProvider,
  verifyHmacSignature,
} from '../packages/core/src/signature-registry.js';
import { normalizeSigners } from '../packages/core/src/signature-operations.js';
import { validateActionInput } from '../packages/core/src/action-runtime.js';
import { validateActionDefinition } from '../packages/core/src/action-registry.js';
import { freezePhaseValue, withExternalTimeout } from '../packages/core/src/external-operation.js';

/**
 * Milestone 11 contract tests (ADR-017): the signature provider contract, the
 * monotonic envelope state machine, webhook verification, signer and phase
 * boundaries. No database, no HTTP, no provider — pure contract.
 */

const provider = () => ({
  name: 'fixture-signature',
  version: 1,
  label: 'Fixture',
  config: { testOnlyVerificationKey: 'k' },
  createEnvelope: async () => ({}),
  getEnvelope: async () => ({}),
  verifyEvent: async () => ({}),
  getSignedArtifact: async () => ({}),
});

const refuses = (fn, match) => assert.throws(fn, match);

test('signature provider identity is validated fail-closed', () => {
  assert.equal(validateSignatureProvider(provider()).name, 'fixture-signature');
  refuses(() => validateSignatureProvider({ ...provider(), name: 'Fixture Signature' }), /name must match/);
  refuses(() => validateSignatureProvider({ ...provider(), name: '__proto__' }), /name must match/);
  refuses(() => validateSignatureProvider({ ...provider(), version: 0 }), /version must be a positive integer/);
  refuses(() => validateSignatureProvider({ ...provider(), version: 1.5 }), /version must be a positive integer/);
  refuses(() => validateSignatureProvider({ ...provider(), label: '' }), /label must be/);
  refuses(() => validateSignatureProvider({ ...provider(), config: 'k' }), /config must be a plain object/);
  refuses(() => validateSignatureProvider({ ...provider(), config: { when: new Date() } }), /config must be plain JSON-safe data/);
  for (const handler of ['createEnvelope', 'getEnvelope', 'verifyEvent', 'getSignedArtifact']) {
    refuses(() => validateSignatureProvider({ ...provider(), [handler]: 'nope' }), new RegExp(`${handler} must be a function`));
  }
});

test('the registry is Map-backed, unique per identity and fingerprinted', () => {
  const registry = new SignatureRegistries({ signatureProviders: [provider()] });
  const entry = registry.getSignatureProvider('fixture-signature', 1);
  assert.match(entry.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(registry.getSignatureProviderByName('fixture-signature').definition.name, 'fixture-signature');
  refuses(() => registry.getSignatureProvider('fixture-signature', 2), /Signature provider/);
  refuses(() => registry.getSignatureProvider('__proto__', 1), /Signature provider/);
  refuses(() => registry.getSignatureProviderByName('constructor'), /Signature provider/);
  refuses(() => new SignatureRegistries({ signatureProviders: [provider(), provider()] }), /Duplicate signature provider/);

  // Declared config is inside the fingerprint: a changed threshold or key is a
  // different definition, which is what stops a silent edit at boot.
  const changed = new SignatureRegistries({ signatureProviders: [{ ...provider(), config: { testOnlyVerificationKey: 'other' } }] });
  assert.notEqual(changed.getSignatureProvider('fixture-signature', 1).fingerprint, entry.fingerprint);

  const metadata = registry.metadata();
  assert.equal(metadata.signatureContract, 1);
  assert.deepEqual(metadata.providers, [{ name: 'fixture-signature', version: 1, label: 'Fixture', fingerprint: entry.fingerprint }]);
  // Never a secret, never a function.
  assert.ok(!JSON.stringify(metadata).includes('testOnlyVerificationKey'));
  assert.equal(JSON.stringify(metadata).includes('function'), false);
});

test('envelope transitions are monotonic and terminal states never regress', () => {
  assert.ok(canTransition('preparing', 'sent'));
  assert.ok(canTransition('preparing', 'failed'));
  assert.ok(canTransition('failed', 'sent'), 'a failed local finalization is recoverable by reconciliation');
  assert.ok(canTransition('failed', 'completed'));
  assert.ok(canTransition('sent', 'delivered'));
  assert.ok(canTransition('sent', 'completed'), 'a completion may arrive before delivery');
  assert.ok(canTransition('delivered', 'declined'));

  // Never backwards.
  assert.equal(canTransition('delivered', 'sent'), false);
  assert.equal(canTransition('sent', 'preparing'), false);
  assert.equal(canTransition('sent', 'sent'), false, 'a duplicate never re-applies');
  // Terminal is terminal, in every direction.
  for (const terminal of TERMINAL_ENVELOPE_STATES) {
    for (const next of ENVELOPE_STATES) {
      assert.equal(canTransition(terminal, next), false, `${terminal} → ${next}`);
    }
  }
  assert.equal(canTransition('completed', 'declined'), false);
  assert.equal(canTransition('declined', 'completed'), false);
  assert.equal(canTransition('completed', 'failed'), false, 'no action may un-complete an envelope');
  assert.equal(canTransition('sent', 'nonsense'), false);
  refuses(() => envelopeRank('nonsense'), /Unknown envelope state/);
});

test('webhook verification is constant-time, replay-bounded and fail-closed', () => {
  const key = 'test-only-key';
  const body = JSON.stringify({ providerEventId: 'evt_1' });
  const nowSeconds = 1_800_000_000;
  const nowMs = nowSeconds * 1000;
  const headers = hmacSignatureHeaders(body, key, nowSeconds);

  assert.deepEqual(
    verifyHmacSignature({ rawBody: body, signature: headers['x-signature-256'], timestamp: headers['x-signature-timestamp'], key, nowMs }),
    { ok: true, reason: null },
  );
  // A single changed byte in the body invalidates the signature.
  assert.equal(verifyHmacSignature({ rawBody: `${body} `, signature: headers['x-signature-256'], timestamp: headers['x-signature-timestamp'], key, nowMs }).ok, false);
  // Wrong key, malformed header, wrong length, non-hex.
  assert.equal(verifyHmacSignature({ rawBody: body, signature: headers['x-signature-256'], timestamp: headers['x-signature-timestamp'], key: 'other', nowMs }).ok, false);
  assert.equal(verifyHmacSignature({ rawBody: body, signature: 'abc', timestamp: headers['x-signature-timestamp'], key, nowMs }).ok, false);
  assert.equal(verifyHmacSignature({ rawBody: body, signature: 'z'.repeat(64), timestamp: headers['x-signature-timestamp'], key, nowMs }).ok, false);
  assert.equal(verifyHmacSignature({ rawBody: body, signature: null, timestamp: headers['x-signature-timestamp'], key, nowMs }).ok, false);
  // Replay window: an old (or future) timestamp is refused even with a valid MAC.
  const stale = hmacSignatureHeaders(body, key, nowSeconds - 3_600);
  assert.equal(verifyHmacSignature({ rawBody: body, signature: stale['x-signature-256'], timestamp: stale['x-signature-timestamp'], key, nowMs }).reason, 'timestamp outside the replay window');
  const future = hmacSignatureHeaders(body, key, nowSeconds + 3_600);
  assert.equal(verifyHmacSignature({ rawBody: body, signature: future['x-signature-256'], timestamp: future['x-signature-timestamp'], key, nowMs }).ok, false);
  // The timestamp is bound INTO the MAC: swapping it invalidates the signature.
  assert.equal(verifyHmacSignature({ rawBody: body, signature: headers['x-signature-256'], timestamp: String(nowSeconds - 1), key, nowMs }).ok, false);
});

test('provider results are normalized into the bounded contract or refused', () => {
  const good = normalizeProviderEnvelope({ providerEnvelopeId: 'env_1', status: 'sent', sequence: 2, signers: [{ signerKey: 's1', status: 'pending' }] });
  assert.equal(good.status, 'sent');
  assert.equal(good.signers[0].signerKey, 's1');

  // Local-only states can never be asserted by a provider.
  refuses(() => normalizeProviderEnvelope({ providerEnvelopeId: 'env_1', status: 'preparing' }), /unsupported envelope status/);
  refuses(() => normalizeProviderEnvelope({ providerEnvelopeId: 'env_1', status: 'failed' }), /unsupported envelope status/);
  refuses(() => normalizeProviderEnvelope({ providerEnvelopeId: 'env_1', status: 'hacked' }), /unsupported envelope status/);
  refuses(() => normalizeProviderEnvelope({ status: 'sent' }), /providerEnvelopeId/);
  refuses(() => normalizeProviderEnvelope('sent'), /non-object/);
  refuses(() => normalizeProviderEnvelope({ providerEnvelopeId: 'x'.repeat(400), status: 'sent' }), /providerEnvelopeId/);
  refuses(() => normalizeProviderEnvelope({ providerEnvelopeId: 'env_1', status: 'sent', sequence: 1.5 }), /sequence/);
  refuses(
    () => normalizeProviderEnvelope({ providerEnvelopeId: 'env_1', status: 'sent', signers: Array.from({ length: 9 }, () => ({ signerKey: 's', status: 'pending' })) }),
    /invalid signer list/,
  );
  refuses(() => normalizeProviderEnvelope({ providerEnvelopeId: 'env_1', status: 'sent', signers: [{ signerKey: 's1', status: 'forged' }] }), /unsupported signer status/);

  const event = normalizeProviderEvent({ providerEventId: 'evt_1', providerEnvelopeId: 'env_1', status: 'completed' });
  assert.equal(event.sequence, 0);
  refuses(() => normalizeProviderEvent({ providerEnvelopeId: 'env_1', status: 'completed' }), /providerEventId/);

  const artifact = normalizeProviderArtifact({ artifactId: 'art_1', mimeType: 'application/json', sizeBytes: 10 });
  assert.equal(artifact.artifactHash, null);
  refuses(() => normalizeProviderArtifact({ mimeType: 'application/json' }), /artifactId/);
  refuses(() => normalizeProviderArtifact({ artifactId: 'art_1', mimeType: 'application/json', sizeBytes: -1 }), /sizeBytes/);
});

test('signer lists are bounded, canonical and de-duplicated', () => {
  const signers = normalizeSigners([
    { name: 'Second', email: 'B@Example.com', order: 2 },
    { name: 'First', email: 'a@example.com', order: 1, role: 'customer' },
  ]);
  assert.deepEqual(signers.map((signer) => signer.email), ['a@example.com', 'b@example.com'], 'sorted by declared order, lower-cased');
  assert.equal(signers[0].role, 'customer');
  assert.equal(signers[1].role, 'signer', 'role defaults, never guesses identity');

  refuses(() => normalizeSigners([]), /non-empty array/);
  refuses(() => normalizeSigners('mario@example.com'), /non-empty array/);
  refuses(() => normalizeSigners(Array.from({ length: MAX_SIGNERS + 1 }, (_, index) => ({ name: 'S', email: `s${index}@example.com` }))), /at most 5 signers/);
  refuses(() => normalizeSigners([{ name: 'A', email: 'a@example.com' }, { name: 'B', email: 'A@example.com' }]), /distinct email/);
  refuses(() => normalizeSigners([{ name: 'A', email: 'not-an-email' }]), /valid address/);
  refuses(() => normalizeSigners([{ email: 'a@example.com' }]), /name is required/);
  refuses(() => normalizeSigners([{ name: 'A', email: 'a@example.com', order: 0 }]), /order must be an integer/);
  refuses(() => normalizeSigners([{ name: 'x'.repeat(300), email: 'a@example.com' }]), /at most 200 characters/);
});

test('structured action input is bounded, JSON-safe and prototype-safe', () => {
  const schema = [{ name: 'signers', type: 'json', required: true }];
  const parsed = validateActionInput(schema, { signers: [{ name: 'A', email: 'a@example.com' }] });
  assert.deepEqual(parsed.signers, [{ name: 'A', email: 'a@example.com' }]);

  // Dangerous keys arriving over the wire are dropped, never re-assigned, and
  // an object whose prototype was already replaced is refused outright.
  const hostile = JSON.parse('{"signers":[{"name":"A","__proto__":{"admin":true},"constructor":"x","prototype":"y"}]}');
  const cleaned = validateActionInput(schema, hostile);
  assert.deepEqual(Object.keys(cleaned.signers[0]), ['name']);
  assert.equal({}.admin, undefined);
  assert.throws(() => validateActionInput(schema, { signers: [Object.create({ inherited: true })] }), /non-plain object/);

  assert.throws(() => validateActionInput(schema, { signers: 'a@example.com' }), /must be a JSON object or array/);
  assert.throws(() => validateActionInput(schema, {}), /signers is required/);
  assert.throws(() => validateActionInput(schema, { signers: [{ name: 'x'.repeat(20_000), email: 'a@b.co' }] }), /too large/);
  assert.throws(() => validateActionInput(schema, { signers: [{ send: () => 1 }] }), /JSON-safe/);
  const cyclic = { name: 'A' };
  cyclic.self = cyclic;
  assert.throws(() => validateActionInput(schema, { signers: [cyclic] }), /cyclic/);
});

test('external-operation actions declare phases, never execute or transactions', () => {
  const deps = { moduleExists: () => true };
  const base = {
    module: 'quote', name: 'request-signature', actionContract: 1, externalOperation: 1,
    intent: () => ({}), external: () => ({}), finalize: () => ({}),
  };
  assert.equal(validateActionDefinition(base, deps).name, 'request-signature');
  refuses(() => validateActionDefinition({ ...base, execute: () => ({}) }, deps), /not execute/);
  refuses(() => validateActionDefinition({ ...base, intent: undefined }, deps), /intent must be a function/);
  refuses(() => validateActionDefinition({ ...base, external: 'go' }, deps), /external must be a function/);
  refuses(() => validateActionDefinition({ ...base, prepare: () => ({}) }, deps), /cannot also declare a prepare phase/);
  refuses(() => validateActionDefinition({ ...base, externalOperation: 2 }, deps), /externalOperation must be 1/);
  // The ordinary shape is untouched.
  assert.equal(validateActionDefinition({ module: 'quote', name: 'submit', actionContract: 1, execute: () => ({}) }, deps).name, 'submit');
});

test('values crossing a phase boundary are frozen JSON-safe data', () => {
  const frozen = freezePhaseValue({ envelopeId: 'e1', signers: [{ email: 'a@example.com' }] });
  assert.equal(Object.isFrozen(frozen), true);
  assert.equal(Object.isFrozen(frozen.signers[0]), true);
  assert.throws(() => freezePhaseValue({ managed: () => 1 }), /JSON-safe/);
  assert.throws(() => freezePhaseValue({ n: Number.POSITIVE_INFINITY }), /non-finite/);
  assert.throws(() => freezePhaseValue({ when: new Date() }), /non-plain object/);
});

test('a provider call that never settles fails as a bounded timeout', async () => {
  await assert.rejects(
    () => withExternalTimeout(new Promise(() => {}), 20, 'fixture provider'),
    (error) => error.code === 'PROVIDER_TIMEOUT' && error.status === 504,
  );
  assert.equal(await withExternalTimeout(Promise.resolve('ok'), 1_000, 'fixture provider'), 'ok');
  await assert.rejects(
    () => withExternalTimeout(Promise.reject(new Error('provider outage')), 1_000, 'fixture provider'),
    /provider outage/,
  );
});
