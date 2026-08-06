import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  ENVELOPE_STATES,
  MAX_SIGNERS,
  SignatureRegistries,
  TERMINAL_ENVELOPE_STATES,
  allowedTransitions,
  assertProviderEnvelopeMatches,
  canTransition,
  hmacSignatureHeaders,
  normalizeProviderArtifact,
  normalizeProviderEnvelope,
  normalizeProviderEvent,
  validateSignatureProvider,
  verifyHmacSignature,
} from '../packages/core/src/signature-registry.js';
import { byteOrder, canonicalDocument, canonicalJson, normalizeSigners } from '../packages/core/src/signature-operations.js';
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

test('envelope transitions follow an explicit table, never a rank comparison', () => {
  // The published table IS the contract.
  assert.deepEqual([...allowedTransitions('preparing')], ['failed', 'sent', 'delivered', 'completed', 'declined', 'voided']);
  assert.deepEqual([...allowedTransitions('failed')], ['sent', 'delivered', 'completed', 'declined', 'voided']);
  assert.deepEqual([...allowedTransitions('sent')], ['delivered', 'completed', 'declined', 'voided']);
  assert.deepEqual([...allowedTransitions('delivered')], ['completed', 'declined', 'voided']);
  for (const terminal of TERMINAL_ENVELOPE_STATES) assert.deepEqual([...allowedTransitions(terminal)], []);
  refuses(() => allowedTransitions('nonsense'), /Unknown envelope state/);

  // The exact matrix the review requires, asserted pair by pair.
  const expected = [
    ['sent', 'delivered', true], ['delivered', 'completed', true], ['sent', 'completed', true],
    ['sent', 'declined', true], ['sent', 'voided', true], ['delivered', 'declined', true],
    ['failed', 'sent', true], ['failed', 'completed', true], ['preparing', 'failed', true],
    ['preparing', 'completed', true],
    // Branching terminals are NOT ordered relative to each other: a rank
    // comparison would call these equal, and the table refuses them.
    ['completed', 'declined', false], ['declined', 'completed', false],
    ['completed', 'voided', false], ['voided', 'completed', false],
    ['declined', 'voided', false], ['voided', 'declined', false],
    ['completed', 'failed', false], ['declined', 'failed', false],
    // Never backwards, never a self-transition, never into a local-only state.
    ['delivered', 'sent', false], ['sent', 'preparing', false], ['sent', 'sent', false],
    ['delivered', 'delivered', false], ['completed', 'completed', false],
    ['sent', 'failed', false], ['delivered', 'failed', false], ['failed', 'preparing', false],
    ['sent', 'nonsense', false], ['nonsense', 'sent', false],
  ];
  for (const [from, to, allowed] of expected) {
    assert.equal(canTransition(from, to), allowed, `${from} → ${to} should be ${allowed}`);
  }
});

test('a provider envelope must prove it is ours, not merely answer the key', () => {
  const local = { documentHash: 'a'.repeat(64), signerKeys: ['s1', 's2'] };
  const ours = { providerEnvelopeId: 'env_1', documentHash: 'a'.repeat(64), signers: [{ signerKey: 's2' }, { signerKey: 's1' }] };
  assert.equal(assertProviderEnvelopeMatches(local, ours).providerEnvelopeId, 'env_1');

  // A different signed document behind the same idempotency key.
  refuses(
    () => assertProviderEnvelopeMatches(local, { ...ours, documentHash: 'b'.repeat(64) }),
    /does not match this signature request \(documentHash\)/,
  );
  // A different signer set, in either direction.
  refuses(() => assertProviderEnvelopeMatches(local, { ...ours, signers: [{ signerKey: 's1' }] }), /\(signers\)/);
  refuses(() => assertProviderEnvelopeMatches(local, { ...ours, signers: [{ signerKey: 's1' }, { signerKey: 's3' }] }), /\(signers\)/);
  // A foreign provider envelope id when one was already known.
  refuses(
    () => assertProviderEnvelopeMatches(local, ours, { expectedProviderEnvelopeId: 'env_other' }),
    /\(providerEnvelopeId\)/,
  );
  // A provider that echoes neither cannot be checked on them — the weaker
  // guarantee is accepted deliberately and documented, not silently assumed.
  assert.equal(assertProviderEnvelopeMatches(local, { providerEnvelopeId: 'env_1', documentHash: null, signers: [] }).providerEnvelopeId, 'env_1');
});

test('the document package canonicalizes to stable bytes, locale-independently', () => {
  // Key order never changes the bytes; array order always does.
  assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(canonicalJson({ a: 2, b: 1 }), canonicalJson({ b: 1, a: 2 }));
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
  assert.equal(canonicalJson({ n: null, s: 'x', t: true, i: 10 }), '{"i":10,"n":null,"s":"x","t":true}');
  // Ordering is by code unit, never by locale collation.
  assert.equal(byteOrder('Z', 'a'), -1);
  assert.equal(canonicalJson({ Z: 1, a: 2 }), '{"Z":1,"a":2}');
  // Hostile and Unicode content survives as text, escaped by JSON.stringify.
  const hostile = { k: '<script>${x}`\u2028\u0000</script>' };
  assert.equal(JSON.parse(canonicalJson(hostile)).k, hostile.k);
  // CRLF vs LF is a real byte difference and must change the hash.
  assert.notEqual(canonicalDocument({ a: 'x\r\n' }).documentHash, canonicalDocument({ a: 'x\n' }).documentHash);
  // Precomposed vs decomposed Unicode are different bytes: the hash covers the
  // bytes sent, so no normalization is silently applied.
  assert.notEqual(canonicalDocument({ a: '\u00e9' }).documentHash, canonicalDocument({ a: 'e\u0301' }).documentHash);
  // Omitted and explicitly-null fields are the same document.
  assert.equal(canonicalJson({ a: 1, b: undefined }), '{"a":1,"b":null}');
  // Numbers are never coerced to strings.
  assert.notEqual(canonicalDocument({ a: 1 }).documentHash, canonicalDocument({ a: '1' }).documentHash);
  // The hash is exactly SHA-256 of the emitted bytes.
  const { documentBytes, documentHash } = canonicalDocument({ z: 1, a: [{ b: 2, a: 1 }] });
  assert.equal(documentBytes, '{"a":[{"a":1,"b":2}],"z":1}');
  assert.equal(documentHash, createHash('sha256').update(documentBytes, 'utf8').digest('hex'));
  // Non-JSON-safe input is refused, never silently coerced.
  refuses(() => canonicalJson({ when: new Date() }), /non-plain object/);
  refuses(() => canonicalJson({ n: Number.NaN }), /non-finite/);
  refuses(() => canonicalDocument({ big: 'x'.repeat(250_000) }), /exceeds the storable bound/);
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

  // Verification is over BYTES: a Buffer and its string form agree, and a body
  // containing invalid UTF-8 verifies as itself rather than as its lossy
  // replacement-character decoding.
  const bytes = Buffer.from(body, 'utf8');
  assert.equal(verifyHmacSignature({ rawBody: bytes, signature: headers['x-signature-256'], timestamp: headers['x-signature-timestamp'], key, nowMs }).ok, true);
  const invalidUtf8 = Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0xfe, 0x22, 0x7d]);
  const invalidHeaders = hmacSignatureHeaders(invalidUtf8, key, nowSeconds);
  assert.equal(verifyHmacSignature({ rawBody: invalidUtf8, signature: invalidHeaders['x-signature-256'], timestamp: invalidHeaders['x-signature-timestamp'], key, nowMs }).ok, true);
  assert.equal(
    verifyHmacSignature({ rawBody: invalidUtf8.toString('utf8'), signature: invalidHeaders['x-signature-256'], timestamp: invalidHeaders['x-signature-timestamp'], key, nowMs }).ok,
    false,
    'a lossy decode must NOT verify — which is why the raw bytes travel end to end',
  );
  // Exactly at the replay boundary the event is still accepted; one second
  // past it, it is not.
  const edge = hmacSignatureHeaders(body, key, nowSeconds - 300);
  assert.equal(verifyHmacSignature({ rawBody: body, signature: edge['x-signature-256'], timestamp: edge['x-signature-timestamp'], key, nowMs, toleranceSeconds: 300 }).ok, true);
  const pastEdge = hmacSignatureHeaders(body, key, nowSeconds - 301);
  assert.equal(verifyHmacSignature({ rawBody: body, signature: pastEdge['x-signature-256'], timestamp: pastEdge['x-signature-timestamp'], key, nowMs, toleranceSeconds: 300 }).ok, false);
  // A duplicated header arrives joined by Node as "a, b" and cannot match.
  assert.equal(verifyHmacSignature({ rawBody: body, signature: `${headers['x-signature-256']}, ${headers['x-signature-256']}`, timestamp: headers['x-signature-timestamp'], key, nowMs }).ok, false);
  // A 15-digit timestamp cannot overflow into an accepted window.
  assert.equal(verifyHmacSignature({ rawBody: body, signature: headers['x-signature-256'], timestamp: '999999999999999', key, nowMs }).ok, false);
});

test('provider results are normalized into the bounded contract or refused', () => {
  const good = normalizeProviderEnvelope({ providerEnvelopeId: 'env_1', status: 'sent', sequence: 2, documentHash: 'a'.repeat(64), signers: [{ signerKey: 's1', status: 'pending' }] });
  assert.equal(good.status, 'sent');
  assert.equal(good.signers[0].signerKey, 's1');
  assert.equal(good.documentHash, 'a'.repeat(64));
  assert.equal(normalizeProviderEnvelope({ providerEnvelopeId: 'env_1', status: 'sent' }).documentHash, null);

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
  refuses(() => normalizeProviderArtifact({ artifactId: 'art_1', mimeType: 'application/json', sizeBytes: Number.MAX_SAFE_INTEGER }), /sizeBytes/);
  refuses(() => normalizeProviderArtifact({ artifactId: 'art_1', mimeType: 'application/json', storageRef: 'x'.repeat(400) }), /storageRef/);
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
