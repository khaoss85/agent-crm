import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  FIXTURE_COMPLETED_AT, approvedQuote, boot, characterizationProject, cli, loadFixture,
  loadRepoFixture, loadSignatureInternals, sigObservation as observation, signatureSchemaBlock,
  signatureSchemaLocation, signerList, stable, stableAll,
} from './signature-harness.mjs';

/**
 * The Signature & Order characterization cases.
 *
 * Everything journey-shaped is driven through the **public** surface — the SDK
 * over a real HTTP server, the real webhook route with real HMAC headers,
 * `/api/schema`, `crm app inspect` — because the question an extraction must
 * answer is "does a consumer see the same thing". The pure-function cases load
 * the internals through the harness seam, which is the one file that knows
 * where Signature lives today.
 */

const refusal = (promise) => promise.then(
  () => ({ refused: false, code: null, status: null }),
  (error) => ({ refused: true, code: error.code ?? null, status: error.status ?? null, message: String(error.message ?? '') }),
);

const syncRefusal = (fn) => {
  try {
    fn();
    return { refused: false, code: null, message: null };
  } catch (error) {
    return { refused: true, code: error.code ?? null, message: String(error.message ?? '') };
  }
};

// ---------------------------------------------------------------------------
// pure cases — the domain's deterministic algebra, no project, no clock
// ---------------------------------------------------------------------------

export async function runPureCases(record) {
  const { operations, registry, externalOperation } = await loadSignatureInternals();
  const {
    ENVELOPE_STATES, TERMINAL_ENVELOPE_STATES, SIGNER_STATES, MAX_SIGNERS,
    allowedTransitions, canTransition, normalizeProviderEnvelope, normalizeProviderEvent,
    normalizeProviderArtifact, assertProviderEnvelopeMatches, validateSignatureProvider,
    verifyHmacSignature, hmacSignatureHeaders, SignatureRegistries,
  } = registry;
  const { canonicalJson, canonicalDocument, byteOrder, normalizeSigners, DOCUMENT_FORMAT } = operations;
  const { withExternalTimeout, freezePhaseValue, DEFAULT_EXTERNAL_TIMEOUT_MS } = externalOperation;

  // ---- envelope state machine: the table IS the contract --------------------
  record(observation({
    id: 'envelope-lifecycle.states',
    category: 'envelope-lifecycle',
    classification: 'contractual',
    surface: 'sdk',
    observed: { states: [...ENVELOPE_STATES], terminal: [...TERMINAL_ENVELOPE_STATES], signerStates: [...SIGNER_STATES], maxSigners: MAX_SIGNERS },
  }));
  record(observation({
    id: 'envelope-lifecycle.allowed-transitions',
    category: 'envelope-lifecycle',
    classification: 'contractual',
    surface: 'sdk',
    observed: Object.fromEntries(ENVELOPE_STATES.map((state) => [state, [...allowedTransitions(state)]])),
  }));
  // The full 7x7 matrix plus unknown states: every cell is a frozen decision.
  const matrix = {};
  for (const from of [...ENVELOPE_STATES, 'unknown']) {
    matrix[from] = {};
    for (const to of [...ENVELOPE_STATES, 'unknown']) matrix[from][to] = canTransition(from, to);
  }
  record(observation({
    id: 'envelope-lifecycle.transition-matrix',
    category: 'envelope-lifecycle',
    classification: 'contractual',
    surface: 'sdk',
    observed: matrix,
  }));
  record(observation({
    id: 'envelope-lifecycle.unknown-state-refused',
    category: 'envelope-lifecycle',
    classification: 'contractual',
    surface: 'sdk',
    observed: syncRefusal(() => allowedTransitions('signed')),
  }));

  // ---- canonical JSON and the document hash --------------------------------
  const CANONICAL_SHAPES = [
    ['null', null],
    ['empty-object', {}],
    ['empty-array', []],
    ['flat-key-order', { b: 1, a: 2 }],
    ['flat-key-order-swapped', { a: 2, b: 1 }],
    ['nested', { z: { b: [1, 2, { c: 'd' }] }, a: null }],
    ['array-order', [1, 2, 3]],
    ['unicode', { 'ключ': 'значение', emoji: 'x' }],
    ['undefined-member', { a: undefined, b: 1 }],
    ['number-vs-string', { a: 1, b: '1' }],
  ];
  for (const [label, value] of CANONICAL_SHAPES) {
    record(observation({
      id: `document.canonical-json.${label}`,
      category: 'document',
      classification: 'contractual',
      surface: 'sdk',
      observed: canonicalJson(value),
    }));
  }
  record(observation({
    id: 'document.canonical-json.refusals',
    category: 'document',
    classification: 'contractual',
    surface: 'sdk',
    observed: {
      nonFinite: syncRefusal(() => canonicalJson({ a: Number.POSITIVE_INFINITY })),
      nan: syncRefusal(() => canonicalJson(Number.NaN)),
      functionValue: syncRefusal(() => canonicalJson({ a: () => 1 })),
      classInstance: syncRefusal(() => canonicalJson(new Date(0))),
      // A __proto__-shaped key survives as data on a plain object built safely.
      protoKey: canonicalJson(JSON.parse('{"__proto__": 1, "a": 2}')),
    },
  }));
  record(observation({
    id: 'document.canonical-hash-properties',
    category: 'document',
    classification: 'contractual',
    surface: 'sdk',
    observed: {
      // The exact SHA-256 of a fixed canonical document: byte-level determinism.
      fixedDocumentHash: canonicalDocument({ b: [1, 2], a: 'x', nested: { k: 'v' } }).documentHash,
      keyOrderIrrelevant: canonicalDocument({ a: 1, b: 2 }).documentHash === canonicalDocument({ b: 2, a: 1 }).documentHash,
      arrayOrderSignificant: canonicalDocument({ a: [1, 2] }).documentHash !== canonicalDocument({ a: [2, 1] }).documentHash,
      numberVsStringDiffer: canonicalDocument({ a: 1 }).documentHash !== canonicalDocument({ a: '1' }).documentHash,
      crlfVsLfDiffer: canonicalDocument({ a: 'x\r\n' }).documentHash !== canonicalDocument({ a: 'x\n' }).documentHash,
      unicodeNormalizationNotApplied: canonicalDocument({ a: 'é' }).documentHash !== canonicalDocument({ a: 'é' }).documentHash,
      hashCoversExactBytes: (() => {
        const { documentBytes, documentHash } = canonicalDocument({ q: 'r' });
        return createHash('sha256').update(documentBytes, 'utf8').digest('hex') === documentHash;
      })(),
      oversizedRefused: syncRefusal(() => canonicalDocument({ a: 'x'.repeat(200_001) })),
      format: DOCUMENT_FORMAT,
    },
  }));
  record(observation({
    id: 'document.byte-order-locale-independent',
    category: 'document',
    classification: 'contractual',
    surface: 'sdk',
    observed: {
      zBeforeLowerA: byteOrder('Z', 'a'),
      accentAfterZ: byteOrder('ä', 'z'),
      equal: byteOrder('same', 'same'),
      plain: byteOrder('a', 'b'),
    },
  }));

  // ---- signer normalization -------------------------------------------------
  record(observation({
    id: 'signers.normalized-shape',
    category: 'signers',
    classification: 'contractual',
    surface: 'sdk',
    observed: normalizeSigners([
      { name: '  Ada Lovelace ', email: 'ADA@Example.COM', role: 'customer', order: 2 },
      { name: 'Grace Hopper', email: 'grace@example.com' },
    ]),
  }));
  const signerRefusals = {};
  for (const [label, value] of [
    ['empty', []],
    ['not-an-array', { name: 'x' }],
    ['too-many', Array.from({ length: 6 }, (_, index) => ({ name: `S${index}`, email: `s${index}@example.com` }))],
    ['duplicate-email-case-insensitive', [{ name: 'A', email: 'a@example.com' }, { name: 'B', email: 'A@EXAMPLE.COM' }]],
    ['invalid-email', [{ name: 'A', email: 'not-an-email' }]],
    ['double-dot-email', [{ name: 'A', email: 'a@ex..ample.com' }]],
    ['name-missing', [{ email: 'a@example.com' }]],
    ['name-oversized', [{ name: 'x'.repeat(201), email: 'a@example.com' }]],
    ['role-oversized', [{ name: 'A', email: 'a@example.com', role: 'r'.repeat(81) }]],
    ['order-zero', [{ name: 'A', email: 'a@example.com', order: 0 }]],
    ['order-fraction', [{ name: 'A', email: 'a@example.com', order: 1.5 }]],
    ['order-beyond-max', [{ name: 'A', email: 'a@example.com', order: 6 }]],
    ['entry-not-object', ['maria']],
  ]) {
    signerRefusals[label] = syncRefusal(() => normalizeSigners(value));
  }
  record(observation({
    id: 'signers.refusals',
    category: 'signers',
    classification: 'contractual',
    surface: 'sdk',
    observed: signerRefusals,
  }));
  record(observation({
    id: 'signers.sort-by-order-then-key',
    category: 'signers',
    classification: 'contractual',
    surface: 'sdk',
    observed: normalizeSigners([
      { name: 'C', email: 'c@example.com', order: 2 },
      { name: 'A', email: 'a@example.com', order: 1 },
      { name: 'B', email: 'b@example.com', order: 1 },
    ]).map((signer) => `${signer.signerKey}:${signer.email}:${signer.order}`),
  }));

  // ---- provider result normalization (third-party data, bounded or refused) --
  record(observation({
    id: 'provider-contract.envelope-normalized',
    category: 'provider-contract',
    classification: 'contractual',
    surface: 'sdk',
    observed: normalizeProviderEnvelope({
      providerEnvelopeId: ' env_x ', status: 'sent', sequence: 3,
      signers: [{ signerKey: 's1', status: 'pending', decidedAt: null }],
      completedAt: null, documentHash: 'a'.repeat(64), unknownField: 'dropped',
    }),
  }));
  const providerRefusals = {};
  for (const [label, fn] of [
    ['non-object', () => normalizeProviderEnvelope(null)],
    ['array', () => normalizeProviderEnvelope([])],
    ['missing-status', () => normalizeProviderEnvelope({ providerEnvelopeId: 'env_x' })],
    ['status-preparing-refused', () => normalizeProviderEnvelope({ providerEnvelopeId: 'env_x', status: 'preparing' })],
    ['status-failed-refused', () => normalizeProviderEnvelope({ providerEnvelopeId: 'env_x', status: 'failed' })],
    ['status-unknown', () => normalizeProviderEnvelope({ providerEnvelopeId: 'env_x', status: 'shipped' })],
    ['envelope-id-oversized', () => normalizeProviderEnvelope({ providerEnvelopeId: 'e'.repeat(201), status: 'sent' })],
    ['sequence-negative', () => normalizeProviderEnvelope({ providerEnvelopeId: 'env_x', status: 'sent', sequence: -1 })],
    ['signers-too-many', () => normalizeProviderEnvelope({ providerEnvelopeId: 'env_x', status: 'sent', signers: Array.from({ length: 6 }, (_, index) => ({ signerKey: `s${index}`, status: 'pending' })) })],
    ['signer-status-unknown', () => normalizeProviderEnvelope({ providerEnvelopeId: 'env_x', status: 'sent', signers: [{ signerKey: 's1', status: 'maybe' }] })],
    ['event-missing-event-id', () => normalizeProviderEvent({ providerEnvelopeId: 'env_x', status: 'sent' })],
    ['event-status-preparing', () => normalizeProviderEvent({ providerEventId: 'evt_1', providerEnvelopeId: 'env_x', status: 'preparing' })],
    ['artifact-missing-id', () => normalizeProviderArtifact({ mimeType: 'application/json' })],
    ['artifact-missing-mime', () => normalizeProviderArtifact({ artifactId: 'art_1' })],
    ['artifact-size-not-integer', () => normalizeProviderArtifact({ artifactId: 'art_1', mimeType: 'x/y', sizeBytes: 1.5 })],
  ]) {
    providerRefusals[label] = syncRefusal(fn);
  }
  record(observation({
    id: 'provider-contract.normalization-refusals',
    category: 'provider-contract',
    classification: 'contractual',
    surface: 'sdk',
    observed: providerRefusals,
  }));

  // ---- idempotency key is a lookup, not an identity -------------------------
  const local = { documentHash: 'a'.repeat(64), signerKeys: ['s1', 's2'] };
  const remoteOk = { providerEnvelopeId: 'env_1', documentHash: 'a'.repeat(64), signers: [{ signerKey: 's2' }, { signerKey: 's1' }] };
  record(observation({
    id: 'provider-contract.envelope-identity-checks',
    category: 'provider-contract',
    classification: 'contractual',
    surface: 'sdk',
    observed: {
      matching: syncRefusal(() => assertProviderEnvelopeMatches(local, remoteOk)),
      hashMismatch: syncRefusal(() => assertProviderEnvelopeMatches(local, { ...remoteOk, documentHash: 'b'.repeat(64) })),
      signerSetMismatch: syncRefusal(() => assertProviderEnvelopeMatches(local, { ...remoteOk, signers: [{ signerKey: 's9' }, { signerKey: 's1' }] })),
      signerCountMismatch: syncRefusal(() => assertProviderEnvelopeMatches(local, { ...remoteOk, signers: [{ signerKey: 's1' }] })),
      envelopeIdMismatch: syncRefusal(() => assertProviderEnvelopeMatches(local, remoteOk, { expectedProviderEnvelopeId: 'env_other' })),
      // A provider that echoes neither field cannot be checked on it — the
      // weaker guarantee is accepted and stated, never assumed away.
      noEchoAccepted: syncRefusal(() => assertProviderEnvelopeMatches(local, { providerEnvelopeId: 'env_1', documentHash: null, signers: [] })),
    },
  }));

  // ---- webhook verification (deterministic via injected nowMs) --------------
  const KEY = 'characterization-test-key';
  const body = '{"probe":true}';
  const nowMs = 1_754_000_000_000; // fixed
  const ts = String(Math.floor(nowMs / 1000));
  const goodHeaders = hmacSignatureHeaders(body, KEY, ts);
  record(observation({
    id: 'webhook.hmac-headers-deterministic',
    category: 'webhook',
    classification: 'contractual',
    surface: 'http',
    observed: goodHeaders,
  }));
  const verify = (params) => verifyHmacSignature({ rawBody: body, key: KEY, nowMs, ...params });
  record(observation({
    id: 'webhook.hmac-verification-outcomes',
    category: 'webhook',
    classification: 'contractual',
    surface: 'http',
    observed: {
      valid: verify({ signature: goodHeaders['x-signature-256'], timestamp: ts }),
      malformedSignature: verify({ signature: 'not-hex', timestamp: ts }),
      truncatedSignature: verify({ signature: goodHeaders['x-signature-256'].slice(0, 63), timestamp: ts }),
      malformedTimestamp: verify({ signature: goodHeaders['x-signature-256'], timestamp: 'yesterday' }),
      missingHeaders: verify({ signature: undefined, timestamp: undefined }),
      wrongBody: verifyHmacSignature({ rawBody: '{"probe":false}', key: KEY, nowMs, signature: goodHeaders['x-signature-256'], timestamp: ts }),
      wrongKey: verifyHmacSignature({ rawBody: body, key: 'other-key', nowMs, signature: goodHeaders['x-signature-256'], timestamp: ts }),
      // The +/-300 s replay window is inclusive at both boundaries.
      exactly300Early: (() => {
        const early = String(Math.floor(nowMs / 1000) - 300);
        return verifyHmacSignature({ rawBody: body, key: KEY, nowMs, timestamp: early, signature: hmacSignatureHeaders(body, KEY, early)['x-signature-256'] });
      })(),
      at301Early: (() => {
        const early = String(Math.floor(nowMs / 1000) - 301);
        return verifyHmacSignature({ rawBody: body, key: KEY, nowMs, timestamp: early, signature: hmacSignatureHeaders(body, KEY, early)['x-signature-256'] });
      })(),
      exactly300Late: (() => {
        const late = String(Math.floor(nowMs / 1000) + 300);
        return verifyHmacSignature({ rawBody: body, key: KEY, nowMs, timestamp: late, signature: hmacSignatureHeaders(body, KEY, late)['x-signature-256'] });
      })(),
      at301Late: (() => {
        const late = String(Math.floor(nowMs / 1000) + 301);
        return verifyHmacSignature({ rawBody: body, key: KEY, nowMs, timestamp: late, signature: hmacSignatureHeaders(body, KEY, late)['x-signature-256'] });
      })(),
      // Bytes end to end: invalid UTF-8 must verify as the exact bytes.
      invalidUtf8Bytes: (() => {
        const bytes = Buffer.from([0x7b, 0xff, 0xfe, 0x7d]);
        const headers = hmacSignatureHeaders(bytes, KEY, ts);
        return verifyHmacSignature({ rawBody: bytes, key: KEY, nowMs, timestamp: ts, signature: headers['x-signature-256'] });
      })(),
    },
  }));

  // ---- provider registry ----------------------------------------------------
  const { fixtureSignatureProvider } = await loadRepoFixture();
  const registryRefusals = {};
  for (const [label, definition] of [
    ['missing-handler', { name: 'p1', version: 1, createEnvelope() {}, getEnvelope() {}, verifyEvent() {} }],
    ['bad-name', { ...fixtureSignatureProvider, name: 'Bad Name' }],
    ['proto-name', { ...fixtureSignatureProvider, name: '__proto__' }],
    ['zero-version', { ...fixtureSignatureProvider, version: 0 }],
    ['fraction-version', { ...fixtureSignatureProvider, version: 1.5 }],
    ['oversized-label', { ...fixtureSignatureProvider, label: 'x'.repeat(81) }],
  ]) {
    registryRefusals[label] = syncRefusal(() => validateSignatureProvider(definition));
  }
  registryRefusals['duplicate-identity'] = syncRefusal(
    () => new SignatureRegistries({ signatureProviders: [fixtureSignatureProvider, { ...fixtureSignatureProvider }] }),
  );
  record(observation({
    id: 'provider-contract.registration-refusals',
    category: 'provider-contract',
    classification: 'contractual',
    surface: 'sdk',
    observed: registryRefusals,
  }));
  const registries = new SignatureRegistries({ signatureProviders: [fixtureSignatureProvider, { ...fixtureSignatureProvider, version: 2 }] });
  record(observation({
    id: 'provider-contract.lookup-semantics',
    category: 'provider-contract',
    classification: 'contractual',
    surface: 'sdk',
    observed: {
      byIdentity: Boolean(registries.getSignatureProvider('fixture-signature', 1)),
      unknownIdentity: syncRefusal(() => registries.getSignatureProvider('fixture-signature', 3)),
      protoLookup: syncRefusal(() => registries.getSignatureProvider('__proto__', 1)),
      byNameAmbiguous: syncRefusal(() => registries.getSignatureProviderByName('fixture-signature')),
      byNameUnknown: syncRefusal(() => registries.getSignatureProviderByName('nope')),
      versionsSameFingerprintDifferentIdentity:
        registries.getSignatureProvider('fixture-signature', 1).fingerprint
        !== registries.getSignatureProvider('fixture-signature', 2).fingerprint,
    },
  }));

  // ---- the neutral external-operation runner's helper surface ---------------
  record(observation({
    id: 'external-operation.default-timeout',
    category: 'external-operation',
    classification: 'compatibility_required',
    surface: 'sdk',
    observed: DEFAULT_EXTERNAL_TIMEOUT_MS,
    note: 'The bound every provider call inherits when the project declares none.',
  }));
  const resolved = await withExternalTimeout(Promise.resolve('value'), 1_000, 'probe').then(
    (value) => ({ outcome: 'resolved', value }), (error) => ({ outcome: 'threw', message: error.message }));
  const rejected = await withExternalTimeout(Promise.reject(Object.assign(new Error('inner failure'), { code: 'X' })), 1_000, 'probe').then(
    () => ({ outcome: 'resolved' }), (error) => ({ outcome: 'threw', message: error.message, code: error.code }));
  const timedOut = await withExternalTimeout(new Promise(() => {}), 20, 'probe').then(
    () => ({ outcome: 'resolved' }), (error) => ({ outcome: 'threw', message: error.message, code: error.code, status: error.status }));
  // A late settlement is abandoned without an unhandled rejection.
  let unhandled = false;
  const onUnhandled = () => { unhandled = true; };
  process.on('unhandledRejection', onUnhandled);
  let lateReject;
  const late = withExternalTimeout(new Promise((_resolve, reject) => { lateReject = reject; }), 10, 'late-probe')
    .then(() => 'resolved', (error) => error.code);
  const lateCode = await late;
  lateReject(new Error('settled after the timeout'));
  await new Promise((resolve) => setTimeout(resolve, 30));
  process.off('unhandledRejection', onUnhandled);
  record(observation({
    id: 'external-operation.timeout-outcomes',
    category: 'external-operation',
    classification: 'compatibility_required',
    surface: 'sdk',
    observed: { resolved, rejected, timedOut, lateSettlement: { codeSeen: lateCode, unhandledRejection: unhandled } },
    note: 'The exact error a caller sees, and the late-settlement discipline: abandoned, never unhandled.',
  }));
  record(observation({
    id: 'external-operation.phase-value-freezing',
    category: 'external-operation',
    classification: 'compatibility_required',
    surface: 'sdk',
    observed: {
      plain: freezePhaseValue({ a: 1, nested: [true, 'x'] }),
      frozen: Object.isFrozen(freezePhaseValue({ a: 1 })),
      functionRefused: syncRefusal(() => freezePhaseValue({ handler: () => 1 })),
      cycleRefused: syncRefusal(() => { const value = {}; value.self = value; return freezePhaseValue(value); }),
      nonPlainRefused: syncRefusal(() => freezePhaseValue(new Map())),
      dangerousKeysDropped: Object.keys(freezePhaseValue(JSON.parse('{"__proto__": 1, "constructor": 2, "safe": 3}'))),
    },
    note: 'What may cross a phase boundary into the external phase: plain frozen JSON-safe data only.',
  }));
}

// ---------------------------------------------------------------------------
// journey cases — one project, the whole proven flow through the public surface
// ---------------------------------------------------------------------------

export async function runJourneyCases(t, record) {
  const root = characterizationProject(t);
  const instance = await boot(root, join(root, 'data', 'sig-la0.sqlite'));
  t.after(() => instance.close().catch(() => {}));
  const { app, client, agentClient, baseUrl } = instance;
  const { signatureFixture } = await loadFixture(root);
  signatureFixture.reset();
  const modules = (name) => app.modules.get(name).service;
  const post = (body, headers, provider = 'fixture-signature') => fetch(`${baseUrl}/api/signature/providers/${provider}/events`, {
    method: 'POST', headers: { 'content-type': 'application/json', connection: 'close', ...headers }, body,
  });

  // ---- schema and metadata --------------------------------------------------
  const schema = await client.schema();
  const block = signatureSchemaBlock(schema);
  record(observation({
    id: 'architecture.schema-signature-block-present',
    category: 'architecture',
    classification: 'pre_extraction_evidence',
    surface: 'schema',
    observed: { present: Boolean(block), foundAt: signatureSchemaLocation(schema) },
    note: 'Published today as an ambient `signature` block on /api/schema. After extraction it should be the package\'s own schema contribution — a deliberate migration, not a behaviour change to hide.',
  }));
  const { providers, ...blockContract } = block ?? {};
  record(observation({
    id: 'schema-metadata.signature-block',
    category: 'schema-metadata',
    classification: 'contractual',
    surface: 'schema',
    observed: blockContract,
  }));
  for (const provider of providers ?? []) {
    record(observation({
      id: `schema-metadata.provider-fingerprint.${provider.name}@${provider.version}`,
      category: 'schema-metadata',
      classification: 'contractual',
      surface: 'schema',
      observed: provider,
    }));
  }
  const quoteMeta = (schema.generatedModules ?? []).find((entry) => entry.name === 'quote');
  const requestAction = (quoteMeta?.actions ?? []).find((entry) => entry.name === 'request-signature');
  record(observation({
    id: 'schema-metadata.request-signature-action-contract',
    category: 'schema-metadata',
    classification: 'contractual',
    surface: 'action-metadata',
    observed: {
      actionContract: requestAction?.actionContract ?? null,
      externalOperation: requestAction?.externalOperation ?? null,
      path: requestAction?.path ?? null,
      stateField: requestAction?.stateField ?? null,
      fromStates: [...(requestAction?.fromStates ?? [])].sort(),
      confirm: Boolean(requestAction?.confirm),
      input: (requestAction?.input ?? []).map((entry) => ({ name: entry.name, type: entry.type, required: Boolean(entry.required) })),
    },
  }));
  for (const moduleName of ['signature-envelope', 'signature-signer', 'signature-event', 'signed-artifact', 'order', 'order-line', 'order-component', 'order-tier', 'order-total']) {
    const meta = (schema.generatedModules ?? []).find((entry) => entry.name === moduleName);
    record(observation({
      id: `schema-metadata.read-only-capabilities.${moduleName}`,
      category: 'schema-metadata',
      classification: 'contractual',
      surface: 'schema',
      observed: {
        capabilities: [...(meta?.capabilities ?? [])].sort(),
        managedFields: (meta?.fields ?? []).filter((field) => field.writable === 'managed').length,
        publiclyWritableFields: (meta?.fields ?? []).filter((field) => field.writable === true || field.writable === 'public').length,
      },
    }));
  }
  // Public-boundary bypass: no client can forge signature evidence over HTTP.
  const forgery = {};
  for (const [label, method, path, body] of [
    ['create-envelope', 'POST', '/api/modules/signature-envelope/records', '{}'],
    ['create-order', 'POST', '/api/modules/order/records', '{}'],
    ['patch-order', 'PATCH', '/api/modules/order/records/anything', '{}'],
    ['patch-event', 'PATCH', '/api/modules/signature-event/records/anything', '{}'],
  ]) {
    const response = await fetch(`${baseUrl}${path}`, {
      method, headers: { 'content-type': 'application/json', 'x-actor-type': 'user', 'x-actor-id': 'sig-la0', connection: 'close' }, body,
    });
    forgery[label] = { status: response.status, code: (await response.json().catch(() => ({})))?.error?.code ?? null };
  }
  record(observation({
    id: 'schema-metadata.public-write-refused',
    category: 'schema-metadata',
    classification: 'contractual',
    surface: 'http',
    observed: forgery,
  }));

  // ---- the happy journey, staged, with exact evidence counts ---------------
  const auditCounts = () => ({
    quote: app.audit.list({ entityType: 'quote', limit: 500 }).length,
    envelope: app.audit.list({ entityType: 'signature-envelope', limit: 500 }).length,
    signer: app.audit.list({ entityType: 'signature-signer', limit: 500 }).length,
    event: app.audit.list({ entityType: 'signature-event', limit: 500 }).length,
    artifact: app.audit.list({ entityType: 'signed-artifact', limit: 500 }).length,
    order: app.audit.list({ entityType: 'order', limit: 500 }).length,
    orderLine: app.audit.list({ entityType: 'order-line', limit: 500 }).length,
    orderComponent: app.audit.list({ entityType: 'order-component', limit: 500 }).length,
    orderTier: app.audit.list({ entityType: 'order-tier', limit: 500 }).length,
    orderTotal: app.audit.list({ entityType: 'order-total', limit: 500 }).length,
  });
  const delta = (before, after) => Object.fromEntries(Object.keys(before).map((key) => [key, after[key] - before[key]]));
  /** @type {Record<string, number>} */
  const dispatched = {};
  app.events.subscribe('*', ({ event }) => { dispatched[event] = (dispatched[event] ?? 0) + 1; });

  const deal = await approvedQuote(app, { name: 'Journey Deal' });
  const beforeRequest = auditCounts();
  const dispatchedBeforeRequest = { ...dispatched };
  const requested = await client.module('quote').action(deal.quote.id, 'request-signature', {
    quoteVersionId: deal.versionId, provider: 'fixture-signature', providerVersion: 1, signers: signerList('journey@example.com'),
  });
  record(observation({
    id: 'completion-order.request-result',
    category: 'completion-order',
    classification: 'contractual',
    surface: 'sdk',
    observed: stable(requested.result),
  }));
  record(observation({
    id: 'audit-events-trace.request-audit-delta',
    category: 'audit-events-trace',
    classification: 'contractual',
    surface: 'audit',
    observed: delta(beforeRequest, auditCounts()),
  }));
  record(observation({
    id: 'audit-events-trace.request-dispatched-events',
    category: 'audit-events-trace',
    classification: 'contractual',
    surface: 'events',
    observed: Object.fromEntries(Object.entries(dispatched)
      .map(([event, count]) => [event, count - (dispatchedBeforeRequest[event] ?? 0)])
      .filter(([, count]) => count !== 0)),
  }));

  const envelope = modules('signature-envelope').listWhere({ quoteVersionId: deal.versionId })[0];
  const envelopeDump = { ...envelope };
  const documentJson = envelopeDump.documentJson;
  delete envelopeDump.documentJson;
  record(observation({
    id: 'completion-order.envelope-after-request',
    category: 'completion-order',
    classification: 'contractual',
    surface: 'storage',
    observed: {
      ...stable(envelopeDump),
      documentJsonHashesToDocumentHash: createHash('sha256').update(documentJson, 'utf8').digest('hex') === envelope.documentHash,
      partiesJson: stable(JSON.parse(envelope.partiesJson)),
    },
  }));
  record(observation({
    id: 'document.package-structure',
    category: 'document',
    classification: 'contractual',
    surface: 'storage',
    observed: stable(JSON.parse(documentJson)),
  }));
  record(observation({
    id: 'completion-order.signer-rows-after-request',
    category: 'completion-order',
    classification: 'contractual',
    surface: 'storage',
    observed: stableAll(modules('signature-signer').listWhere({ envelopeId: envelope.id })
      .sort((a, b) => (a.signerKey < b.signerKey ? -1 : 1))),
  }));
  record(observation({
    id: 'completion-order.quote-after-request',
    category: 'completion-order',
    classification: 'contractual',
    surface: 'storage',
    observed: (() => {
      const quote = modules('quote').get(deal.quote.id);
      return stable({
        status: quote.status, signatureStatus: quote.signatureStatus,
        signatureEnvelopeIdMatches: quote.signatureEnvelopeId === envelope.id, orderId: quote.orderId ?? null,
      });
    })(),
  }));

  // Refusals around the request.
  record(observation({
    id: 'envelope-lifecycle.repeat-request-refused',
    category: 'envelope-lifecycle',
    classification: 'contractual',
    surface: 'sdk',
    observed: await refusal(client.module('quote').action(deal.quote.id, 'request-signature', {
      quoteVersionId: deal.versionId, provider: 'fixture-signature', providerVersion: 1, signers: signerList('journey@example.com'),
    })),
  }));
  record(observation({
    id: 'envelope-lifecycle.agent-actor-refused',
    category: 'envelope-lifecycle',
    classification: 'contractual',
    surface: 'http',
    observed: await refusal(agentClient.module('quote').action(deal.quote.id, 'request-signature', {
      quoteVersionId: deal.versionId, provider: 'fixture-signature', providerVersion: 1, signers: signerList('agent@example.com'),
    })),
  }));
  const otherDeal = await approvedQuote(app, { name: 'Other Journey Deal' });
  record(observation({
    id: 'envelope-lifecycle.version-of-another-quote-refused',
    category: 'envelope-lifecycle',
    classification: 'contractual',
    surface: 'sdk',
    observed: await refusal(client.module('quote').action(deal.quote.id, 'request-signature', {
      quoteVersionId: otherDeal.versionId, provider: 'fixture-signature', providerVersion: 1, signers: signerList('mismatch@example.com'),
    })),
  }));
  record(observation({
    id: 'provider-contract.unknown-provider-version-refused',
    category: 'provider-contract',
    classification: 'contractual',
    surface: 'sdk',
    observed: await refusal(client.module('quote').action(otherDeal.quote.id, 'request-signature', {
      quoteVersionId: otherDeal.versionId, provider: 'fixture-signature', providerVersion: 9, signers: signerList('nover@example.com'),
    })),
  }));

  // ---- webhook lifecycle: delivered, replay, conflict, out-of-order, terminal
  const send = async (event) => {
    const response = await post(event.rawBody, event.headers);
    const bodyJson = await response.json().catch(() => null);
    return { status: response.status, body: bodyJson };
  };
  signatureFixture.markDelivered(envelope.idempotencyKey);
  const deliveredEvent = signatureFixture.event(envelope.idempotencyKey, 'delivered', { providerEventId: 'evt_j_delivered' });
  const deliveredResponse = await send(deliveredEvent);
  record(observation({
    id: 'webhook.delivered-applied',
    category: 'webhook',
    classification: 'contractual',
    surface: 'http',
    observed: { status: deliveredResponse.status, ...stable(deliveredResponse.body) },
  }));
  record(observation({
    id: 'webhook.replay-same-bytes-is-stable-duplicate',
    category: 'webhook',
    classification: 'contractual',
    surface: 'http',
    observed: await send(deliveredEvent).then((response) => ({ status: response.status, duplicate: response.body?.duplicate ?? null, effect: response.body?.effect ?? null })),
  }));
  const conflicting = signatureFixture.event(envelope.idempotencyKey, 'delivered', { providerEventId: 'evt_j_delivered', sequence: 99 });
  record(observation({
    id: 'webhook.same-id-different-bytes-conflict',
    category: 'webhook',
    classification: 'contractual',
    surface: 'http',
    observed: await send(conflicting).then((response) => ({ status: response.status, code: response.body?.error?.code ?? null })),
  }));
  // Out of order: a `sent` event arriving after `delivered` is stored + ignored.
  const lateSent = signatureFixture.event(envelope.idempotencyKey, 'sent', { providerEventId: 'evt_j_late_sent', sequence: 1 });
  const lateSentResponse = await send(lateSent);
  record(observation({
    id: 'webhook.out-of-order-ignored',
    category: 'webhook',
    classification: 'contractual',
    surface: 'http',
    observed: {
      status: lateSentResponse.status,
      applied: lateSentResponse.body?.applied ?? null,
      reason: lateSentResponse.body?.reason ?? null,
      inboxRow: (() => {
        const row = modules('signature-event').listWhere({ providerEventId: 'evt_j_late_sent' })[0];
        return { effect: row.effect, effectReason: row.effectReason, processed: row.processed };
      })(),
      envelopeStatus: modules('signature-envelope').get(envelope.id).status,
    },
  }));

  // ---- completion: one atomic transaction, one immutable order --------------
  const beforeCompletion = auditCounts();
  const dispatchedBeforeCompletion = { ...dispatched };
  signatureFixture.markCompleted(envelope.idempotencyKey);
  const completedEvent = signatureFixture.event(envelope.idempotencyKey, 'completed', { providerEventId: 'evt_j_completed' });
  const completedResponse = await send(completedEvent);
  record(observation({
    id: 'completion-order.completed-response',
    category: 'completion-order',
    classification: 'contractual',
    surface: 'http',
    observed: { status: completedResponse.status, ...stable(completedResponse.body) },
  }));
  record(observation({
    id: 'audit-events-trace.completion-audit-delta',
    category: 'audit-events-trace',
    classification: 'contractual',
    surface: 'audit',
    observed: delta(beforeCompletion, auditCounts()),
  }));
  record(observation({
    id: 'audit-events-trace.completion-dispatched-events',
    category: 'audit-events-trace',
    classification: 'contractual',
    surface: 'events',
    observed: Object.fromEntries(Object.entries(dispatched)
      .map(([event, count]) => [event, count - (dispatchedBeforeCompletion[event] ?? 0)])
      .filter(([, count]) => count !== 0)),
  }));

  const completed = modules('signature-envelope').get(envelope.id);
  const order = modules('order').listWhere({ quoteVersionId: deal.versionId })[0];
  const artifact = modules('signed-artifact').listWhere({ envelopeId: envelope.id })[0];
  {
    const dump = { ...completed };
    delete dump.documentJson;
    record(observation({
      id: 'completion-order.envelope-completed',
      category: 'completion-order',
      classification: 'contractual',
      surface: 'storage',
      observed: {
        ...stable(dump),
        linksAgree: completed.orderId === order.id && completed.signedArtifactId === artifact.id,
      },
    }));
  }
  {
    const dump = { ...artifact };
    const artifactDocumentJson = dump.documentJson;
    delete dump.documentJson;
    record(observation({
      id: 'completion-order.signed-artifact-evidence',
      category: 'completion-order',
      classification: 'contractual',
      surface: 'storage',
      observed: {
        ...stable(dump),
        signerEvidence: stable(JSON.parse(artifact.signerEvidenceJson)),
        documentJsonMatchesEnvelope: artifactDocumentJson === documentJson,
        completionEventLinked: artifact.completionEventId === modules('signature-event').listWhere({ providerEventId: 'evt_j_completed' })[0]?.id,
      },
    }));
  }
  {
    const mapping = new Map();
    const lines = modules('order-line').listWhere({ orderId: order.id }).sort((a, b) => a.position - b.position);
    const components = modules('order-component').listWhere({ orderId: order.id })
      .sort((a, b) => (a.componentKey < b.componentKey ? -1 : 1));
    const tiers = modules('order-tier').listWhere({ orderId: order.id }).sort((a, b) => a.position - b.position);
    const totals = modules('order-total').listWhere({ orderId: order.id })
      .sort((a, b) => (`${a.kind}|${a.interval}` < `${b.kind}|${b.interval}` ? -1 : 1));
    record(observation({
      id: 'completion-order.order-record',
      category: 'completion-order',
      classification: 'contractual',
      surface: 'storage',
      observed: {
        ...stable({ ...order, totalsJson: JSON.parse(order.totalsJson ?? 'null') }, mapping),
        exactlyOne: modules('order').countWhere({ quoteVersionId: deal.versionId }) === 1,
      },
    }));
    record(observation({
      id: 'completion-order.order-lines',
      category: 'completion-order',
      classification: 'contractual',
      surface: 'storage',
      observed: lines.map((line) => stable(line, mapping)),
    }));
    record(observation({
      id: 'completion-order.order-components',
      category: 'completion-order',
      classification: 'contractual',
      surface: 'storage',
      observed: components.map((component) => stable({
        ...component,
        tiersJson: JSON.parse(component.tiersJson ?? 'null'),
        tierBreakdownJson: JSON.parse(component.tierBreakdownJson ?? 'null'),
      }, mapping)),
    }));
    record(observation({
      id: 'completion-order.order-tiers',
      category: 'completion-order',
      classification: 'contractual',
      surface: 'storage',
      observed: tiers.map((tier) => stable(tier, mapping)),
    }));
    record(observation({
      id: 'completion-order.order-grouped-totals',
      category: 'completion-order',
      classification: 'contractual',
      surface: 'storage',
      observed: totals.map((total) => stable(total, mapping)),
    }));
  }
  record(observation({
    id: 'completion-order.quote-after-completion',
    category: 'completion-order',
    classification: 'contractual',
    surface: 'storage',
    observed: (() => {
      const quote = modules('quote').get(deal.quote.id);
      return { status: quote.status, signatureStatus: quote.signatureStatus, orderIdMatches: quote.orderId === order.id };
    })(),
  }));

  // ---- events after a terminal state are stored and ignored -----------------
  const afterTerminal = signatureFixture.event(envelope.idempotencyKey, 'declined', { providerEventId: 'evt_j_after_terminal', sequence: 50 });
  const afterTerminalResponse = await send(afterTerminal);
  record(observation({
    id: 'webhook.after-terminal-ignored',
    category: 'webhook',
    classification: 'contractual',
    surface: 'http',
    observed: {
      status: afterTerminalResponse.status,
      applied: afterTerminalResponse.body?.applied ?? null,
      reason: afterTerminalResponse.body?.reason ?? null,
      inboxRow: (() => {
        const row = modules('signature-event').listWhere({ providerEventId: 'evt_j_after_terminal' })[0];
        return { effect: row.effect, effectReason: row.effectReason, processed: row.processed };
      })(),
      envelopeStillCompleted: modules('signature-envelope').get(envelope.id).status,
      stillOneOrder: modules('order').countWhere({ quoteVersionId: deal.versionId }),
    },
  }));

  // The idempotency key against a TERMINAL envelope: still one envelope per
  // quote version, ever — the refusal names the terminal state instead of
  // pretending the request could be retried.
  record(observation({
    id: 'envelope-lifecycle.repeat-request-after-terminal-refused',
    category: 'envelope-lifecycle',
    classification: 'contractual',
    surface: 'sdk',
    observed: await refusal(client.module('quote').action(deal.quote.id, 'request-signature', {
      quoteVersionId: deal.versionId, provider: 'fixture-signature', providerVersion: 1, signers: signerList('journey@example.com'),
    })).then((result) => ({
      ...result,
      envelopesForVersion: modules('signature-envelope').countWhere({ quoteVersionId: deal.versionId }),
    })),
  }));

  // Replay of the completion creates no new audit rows, no new order.
  const beforeReplay = auditCounts();
  const replayResponse = await send(completedEvent);
  record(observation({
    id: 'audit-events-trace.replay-creates-nothing',
    category: 'audit-events-trace',
    classification: 'contractual',
    surface: 'audit',
    observed: {
      response: { status: replayResponse.status, duplicate: replayResponse.body?.duplicate ?? null },
      auditDelta: delta(beforeReplay, auditCounts()),
      orders: modules('order').countWhere({ quoteVersionId: deal.versionId }),
      inboxRows: modules('signature-event').countWhere({ providerEventId: 'evt_j_completed' }),
    },
  }));

  // ---- traces ---------------------------------------------------------------
  const runs = app.workflows.listRuns({ limit: 200 });
  record(observation({
    id: 'audit-events-trace.trace-vocabulary',
    category: 'audit-events-trace',
    classification: 'contractual',
    surface: 'trace',
    observed: [...new Set(runs.map((run) => run.workflowName))].sort(),
  }));
  const requestRun = runs.find((run) => run.workflowName === 'quote.request-signature' && run.status === 'completed');
  record(observation({
    id: 'audit-events-trace.request-signature-spans',
    category: 'audit-events-trace',
    classification: 'contractual',
    surface: 'trace',
    observed: app.workflows.getRun(requestRun.id).spans.map((span) => ({ name: span.name, status: span.status })),
  }));
  const eventRuns = runs.filter((run) => run.workflowName === 'signature.event');
  const completionRun = eventRuns
    .map((run) => app.workflows.getRun(run.id))
    .find((run) => run.spans.some((span) => span.name === 'signature.completed'));
  record(observation({
    id: 'audit-events-trace.completion-event-spans',
    category: 'audit-events-trace',
    classification: 'contractual',
    surface: 'trace',
    observed: completionRun.spans.map((span) => ({ name: span.name, status: span.status })),
  }));
  record(observation({
    id: 'audit-events-trace.event-run-counts-by-status',
    category: 'audit-events-trace',
    classification: 'contractual',
    surface: 'trace',
    observed: eventRuns.reduce((totals, run) => ({ ...totals, [run.status]: (totals[run.status] ?? 0) + 1 }), {}),
  }));

  // ---- webhook hostile input ------------------------------------------------
  const validBody = signatureFixture.event(envelope.idempotencyKey, 'delivered', { providerEventId: 'evt_j_hostile_probe' });
  const hostile = {};
  hostile['bad-signature'] = await send({ rawBody: validBody.rawBody, headers: { ...validBody.headers, 'x-signature-256': 'f'.repeat(64) } })
    .then((response) => ({ status: response.status, code: response.body?.error?.code ?? null, echoesPayload: JSON.stringify(response.body).includes('evt_j_hostile_probe') }));
  hostile['missing-headers'] = await send({ rawBody: validBody.rawBody, headers: {} })
    .then((response) => ({ status: response.status, code: response.body?.error?.code ?? null }));
  hostile['stale-timestamp'] = await (async () => {
    const staleTs = Math.floor(Date.now() / 1000) - 3_600;
    const stale = signatureFixture.event(envelope.idempotencyKey, 'delivered', { providerEventId: 'evt_j_stale', timestampSeconds: staleTs });
    const response = await send(stale);
    return { status: response.status, code: response.body?.error?.code ?? null };
  })();
  hostile['tampered-body'] = await send({ rawBody: `${validBody.rawBody} `, headers: validBody.headers })
    .then((response) => ({ status: response.status, code: response.body?.error?.code ?? null }));
  hostile['unknown-provider'] = await post(validBody.rawBody, validBody.headers, 'no-such-provider')
    .then(async (response) => ({ status: response.status, code: (await response.json().catch(() => ({})))?.error?.code ?? null }));
  hostile['proto-provider'] = await post(validBody.rawBody, validBody.headers, '__proto__')
    .then(async (response) => ({ status: response.status, code: (await response.json().catch(() => ({})))?.error?.code ?? null }));
  hostile['oversized-body'] = await (async () => {
    const big = JSON.stringify({ pad: 'x'.repeat(70_000) });
    const response = await post(big, validBody.headers);
    return { status: response.status, code: (await response.json().catch(() => ({})))?.error?.code ?? null };
  })();
  hostile['verified-proto-payload'] = await (async () => {
    // Signed correctly, hostile inside: dangerous keys must not pollute.
    const raw = JSON.stringify({
      providerEventId: 'evt_j_proto', providerEnvelopeId: 'env_nonexistent0000000000000',
      status: 'sent', sequence: 1, __proto__: { polluted: true }, constructor: { evil: 1 },
    });
    const event = signatureFixture.event(envelope.idempotencyKey, 'sent', { rawBody: raw });
    const response = await send({ rawBody: raw, headers: event.headers });
    return {
      status: response.status,
      quarantined: response.body?.quarantined ?? null,
      globalNotPolluted: Object.prototype.polluted === undefined && {}.polluted === undefined,
    };
  })();
  record(observation({
    id: 'hostile-input.webhook-route',
    category: 'hostile-input',
    classification: 'contractual',
    surface: 'http',
    observed: hostile,
  }));

  // ---- hostile signer input through the action ------------------------------
  const hostileDeal = await approvedQuote(app, { name: 'Hostile Signer Deal' });
  const hostileSigners = [
    { name: '<script>alert(1)</script>', email: 'h1@example.com', role: "quo'te\"s`", order: 1 },
    { name: '${process.env.HOME} ; DROP TABLE quote; --', email: 'h2@example.com', role: 'a b', order: 2 },
  ];
  await client.module('quote').action(hostileDeal.quote.id, 'request-signature', {
    quoteVersionId: hostileDeal.versionId, provider: 'fixture-signature', providerVersion: 1, signers: hostileSigners,
  });
  const hostileEnvelope = modules('signature-envelope').listWhere({ quoteVersionId: hostileDeal.versionId })[0];
  const storedHostile = modules('signature-signer').listWhere({ envelopeId: hostileEnvelope.id })
    .sort((a, b) => a.signingOrder - b.signingOrder);
  record(observation({
    id: 'hostile-input.signer-values-stored-inert',
    category: 'hostile-input',
    classification: 'contractual',
    surface: 'storage',
    observed: storedHostile.map((row, index) => ({
      byteIdentical: row.name === hostileSigners[index].name && row.role === hostileSigners[index].role,
      name: row.name, role: row.role,
    })),
    note: 'Storing hostile text verbatim is correct — escaping is a rendering concern, and the SQL-shaped value surviving proves parameterized queries.',
  }));
  const newlineDeal = await approvedQuote(app, { name: 'Newline Probe Deal' });
  const nullByteDeal = await approvedQuote(app, { name: 'Null Byte Probe Deal' });
  const controlProbe = async (deal, signer) => {
    const result = await refusal(client.module('quote').action(deal.quote.id, 'request-signature', {
      quoteVersionId: deal.versionId, provider: 'fixture-signature', providerVersion: 1, signers: [signer],
    }));
    if (result.refused) return result;
    const created = modules('signature-envelope').listWhere({ quoteVersionId: deal.versionId })[0];
    const rows = modules('signature-signer').listWhere({ envelopeId: created.id });
    return { refused: false, storedByteIdentical: rows[0].name === signer.name && rows[0].role === (signer.role ?? 'signer') };
  };
  record(observation({
    id: 'hostile-input.signer-newline-and-null-byte',
    category: 'hostile-input',
    classification: 'defect_candidate',
    surface: 'sdk',
    observed: {
      newlineName: await controlProbe(newlineDeal, { name: 'a\nb', email: 'nl@example.com' }),
      nullByteRole: await controlProbe(nullByteDeal, { name: 'A', email: 'nb@example.com', role: 'r\u0000oot' }),
    },
    note: 'Signer name/role accept control characters: a newline is stored verbatim, and a NUL byte is accepted but NOT stored byte-identically — a silent storage mutation, on data that becomes part of the signed document package. The same class was already fixed on record-signal (1e40d1e) and partner-scorecard refuses control characters. Recommend the same write-time refusal for signer text fields in a separate pre-extraction fix; deliberately not frozen as contract.',
  }));

  // ---- AX1: what `crm app inspect` reports about Signature ------------------
  const inspect = cli(root, ['app', 'inspect', '--json']);
  const report = JSON.parse(inspect.stdout || '{}');
  const reportText = JSON.stringify(report);
  const signatureProviders = report?.application?.signature?.providers
    ?? report?.signature?.providers ?? null;
  record(observation({
    id: 'architecture.app-inspect-signature-facts',
    category: 'architecture',
    classification: 'pre_extraction_evidence',
    surface: 'app-inspect',
    observed: {
      exitCode: inspect.status,
      valid: report?.valid ?? null,
      mentionsFixtureProvider: reportText.includes('fixture-signature'),
      mentionsRequestSignature: reportText.includes('request-signature'),
      providerSlotShape: signatureProviders === null ? 'not-a-top-level-slot' : 'top-level-slot',
    },
    note: 'AX1 evidence: how the composition reports Signature today. The extraction changes where these facts appear (a package instead of fixed slots), so the location is evidence, not contract.',
  }));
  record(observation({
    id: 'architecture.app-inspect-cites-signature-action',
    category: 'architecture',
    classification: 'contractual',
    surface: 'app-inspect',
    observed: {
      exitCode: inspect.status,
      requestSignatureCitable: reportText.includes('request-signature'),
      envelopeRecordCitable: reportText.includes('signature-envelope'),
      orderRecordCitable: reportText.includes('"order"') || reportText.includes("'order'"),
    },
    note: 'AX2 depends on these facts being reported: a Solution Plan can only bind to what inspect publishes.',
  }));

  return { root, instance };
}

// ---------------------------------------------------------------------------
// failure, decline, reconciliation and races — the paths that must stay honest
// ---------------------------------------------------------------------------

export async function runFailureAndReconcileCases(t, record) {
  const root = characterizationProject(t, { name: 'accordo-sig-la0-fail-' });
  const dbPath = join(root, 'data', 'sig-la0-fail.sqlite');
  const instance = await boot(root, dbPath, { signatureTimeoutMs: 300 });
  t.after(() => instance.close().catch(() => {}));
  const { app, client } = instance;
  const { signatureFixture, fixtureSignatureProvider } = await loadFixture(root);
  signatureFixture.reset();
  const actor = { type: 'user', id: 'sig-la0' };
  const modules = (name) => app.modules.get(name).service;
  const request = (deal, email) => client.module('quote').action(deal.quote.id, 'request-signature', {
    quoteVersionId: deal.versionId, provider: 'fixture-signature', providerVersion: 1, signers: signerList(email),
  });

  // ---- provider outage → compensate → failed (recoverable) ------------------
  const outageDeal = await approvedQuote(app, { name: 'Outage Deal' });
  const outage = await refusal(request(outageDeal, 'who@outage.example'));
  const outageEnvelope = modules('signature-envelope').listWhere({ quoteVersionId: outageDeal.versionId })[0];
  record(observation({
    id: 'external-operation.provider-outage-compensated',
    category: 'external-operation',
    classification: 'contractual',
    surface: 'sdk',
    observed: {
      callerSees: outage,
      envelope: {
        status: outageEnvelope.status, failurePhase: outageEnvelope.failurePhase,
        failureCode: outageEnvelope.failureCode, providerEnvelopeId: outageEnvelope.providerEnvelopeId,
      },
    },
  }));
  const outageRun = app.workflows.listRuns({ status: 'failed', limit: 50 })
    .find((run) => run.workflowName === 'quote.request-signature');
  record(observation({
    id: 'external-operation.failed-run-spans',
    category: 'external-operation',
    classification: 'contractual',
    surface: 'trace',
    observed: app.workflows.getRun(outageRun.id).spans.map((span) => ({ name: span.name, status: span.status })),
  }));
  // Reconciliation is honest when the provider holds nothing.
  const absent = await app.reconcileSignature({ envelopeId: outageEnvelope.id, actor });
  const absentEnvelope = modules('signature-envelope').get(outageEnvelope.id);
  record(observation({
    id: 'reconciliation.absent-at-provider',
    category: 'reconciliation',
    classification: 'contractual',
    surface: 'sdk',
    observed: {
      result: { ok: absent.ok, applied: absent.applied, reason: absent.reason, status: absent.status },
      envelope: { status: absentEnvelope.status, failurePhase: absentEnvelope.failurePhase, failureCode: absentEnvelope.failureCode },
    },
  }));

  // ---- provider timeout → PROVIDER_TIMEOUT, failed, recoverable -------------
  const timeoutDeal = await approvedQuote(app, { name: 'Timeout Deal' });
  const timedOut = await refusal(request(timeoutDeal, 'who@timeout.example'));
  const timeoutEnvelope = modules('signature-envelope').listWhere({ quoteVersionId: timeoutDeal.versionId })[0];
  record(observation({
    id: 'external-operation.provider-timeout',
    category: 'external-operation',
    classification: 'contractual',
    surface: 'sdk',
    observed: {
      callerSees: { refused: timedOut.refused, code: timedOut.code, status: timedOut.status },
      envelope: { status: timeoutEnvelope.status, failurePhase: timeoutEnvelope.failurePhase, failureCode: timeoutEnvelope.failureCode },
    },
  }));

  // ---- a failed envelope cannot be re-sent ----------------------------------
  record(observation({
    id: 'envelope-lifecycle.failed-envelope-cannot-resend',
    category: 'envelope-lifecycle',
    classification: 'contractual',
    surface: 'sdk',
    observed: await refusal(request(outageDeal, 'retry@example.com')),
    note: 'The retained M11 limitation: reconciliation is the only recovery path; no resend framework exists.',
  }));

  // ---- decline and void paths -----------------------------------------------
  const declineDeal = await approvedQuote(app, { name: 'Decline Deal' });
  await request(declineDeal, 'decline@example.com');
  const declineEnvelope = modules('signature-envelope').listWhere({ quoteVersionId: declineDeal.versionId })[0];
  signatureFixture.markDeclined(declineEnvelope.idempotencyKey);
  const declineEvent = signatureFixture.event(declineEnvelope.idempotencyKey, 'declined', { providerEventId: 'evt_f_declined' });
  const declined = await app.ingestSignatureEvent({ provider: 'fixture-signature', rawBody: declineEvent.rawBody, headers: declineEvent.headers });
  const declinedEnvelope = modules('signature-envelope').get(declineEnvelope.id);
  record(observation({
    id: 'envelope-lifecycle.declined-terminal-no-order',
    category: 'envelope-lifecycle',
    classification: 'contractual',
    surface: 'storage',
    observed: {
      applied: declined.applied, status: declinedEnvelope.status,
      declinedAtPresent: Boolean(declinedEnvelope.declinedAt),
      signerStatuses: modules('signature-signer').listWhere({ envelopeId: declineEnvelope.id }).map((row) => row.status),
      orders: modules('order').countWhere({ quoteVersionId: declineDeal.versionId }),
      artifacts: modules('signed-artifact').listWhere({ envelopeId: declineEnvelope.id }).length,
      quoteSignatureStatus: modules('quote').get(declineDeal.quote.id).signatureStatus,
    },
    note: 'quote.signatureStatus stays at the finalize-time value after a decline; downstream consumers (Admin, Contract Activation) read the envelope, not this field.',
  }));
  record(observation({
    id: 'envelope-lifecycle.completed-after-declined-impossible',
    category: 'envelope-lifecycle',
    classification: 'contractual',
    surface: 'sdk',
    observed: await (async () => {
      signatureFixture.markCompleted(declineEnvelope.idempotencyKey);
      const lateComplete = signatureFixture.event(declineEnvelope.idempotencyKey, 'completed', { providerEventId: 'evt_f_late_complete' });
      const result = await app.ingestSignatureEvent({ provider: 'fixture-signature', rawBody: lateComplete.rawBody, headers: lateComplete.headers });
      return {
        applied: result.applied ?? null, reason: result.reason ?? null,
        envelopeStatus: modules('signature-envelope').get(declineEnvelope.id).status,
        orders: modules('order').countWhere({ quoteVersionId: declineDeal.versionId }),
      };
    })(),
  }));
  const voidDeal = await approvedQuote(app, { name: 'Void Deal' });
  await request(voidDeal, 'void@example.com');
  const voidEnvelope = modules('signature-envelope').listWhere({ quoteVersionId: voidDeal.versionId })[0];
  signatureFixture.markVoided(voidEnvelope.idempotencyKey);
  const voidEvent = signatureFixture.event(voidEnvelope.idempotencyKey, 'voided', { providerEventId: 'evt_f_voided' });
  await app.ingestSignatureEvent({ provider: 'fixture-signature', rawBody: voidEvent.rawBody, headers: voidEvent.headers });
  record(observation({
    id: 'envelope-lifecycle.voided-terminal',
    category: 'envelope-lifecycle',
    classification: 'contractual',
    surface: 'storage',
    observed: {
      status: modules('signature-envelope').get(voidEnvelope.id).status,
      voidedAtPresent: Boolean(modules('signature-envelope').get(voidEnvelope.id).voidedAt),
      orders: modules('order').countWhere({ quoteVersionId: voidDeal.versionId }),
    },
  }));

  // ---- reconcile: terminal short-circuit, foreign envelope refused ----------
  record(observation({
    id: 'reconciliation.terminal-short-circuit',
    category: 'reconciliation',
    classification: 'contractual',
    surface: 'sdk',
    observed: await app.reconcileSignature({ envelopeId: voidEnvelope.id, actor })
      .then((result) => ({ ok: result.ok, applied: result.applied, reason: result.reason, status: result.status })),
  }));
  const foreignDeal = await approvedQuote(app, { name: 'Foreign Deal' });
  await request(foreignDeal, 'foreign@example.com');
  const foreignEnvelope = modules('signature-envelope').listWhere({ quoteVersionId: foreignDeal.versionId })[0];
  const realGet = fixtureSignatureProvider.getEnvelope;
  fixtureSignatureProvider.getEnvelope = async (input) => {
    const found = await realGet.call(fixtureSignatureProvider, input);
    return found ? { ...found, documentHash: 'f'.repeat(64) } : found;
  };
  const mismatch = await refusal(app.reconcileSignature({ envelopeId: foreignEnvelope.id, actor }));
  fixtureSignatureProvider.getEnvelope = realGet;
  record(observation({
    id: 'reconciliation.foreign-envelope-refused',
    category: 'reconciliation',
    classification: 'contractual',
    surface: 'sdk',
    observed: {
      refusal: { refused: mismatch.refused, code: mismatch.code, status: mismatch.status },
      envelopeUntouched: modules('signature-envelope').get(foreignEnvelope.id).status,
      orders: modules('order').countWhere({ quoteVersionId: foreignDeal.versionId }),
    },
  }));

  // ---- instant completion at createEnvelope ---------------------------------
  const realCreate = fixtureSignatureProvider.createEnvelope;
  fixtureSignatureProvider.createEnvelope = async (input) => {
    const created = await realCreate.call(fixtureSignatureProvider, input);
    return {
      ...created,
      status: 'completed',
      completedAt: FIXTURE_COMPLETED_AT,
      signers: created.signers.map((signer) => ({ ...signer, status: 'signed', decidedAt: FIXTURE_COMPLETED_AT })),
    };
  };
  const instantDeal = await approvedQuote(app, { name: 'Instant Deal' });
  const instant = await request(instantDeal, 'instant@example.com');
  fixtureSignatureProvider.createEnvelope = realCreate;
  const instantEnvelope = modules('signature-envelope').listWhere({ quoteVersionId: instantDeal.versionId })[0];
  record(observation({
    id: 'completion-order.instant-terminal-answer-completes',
    category: 'completion-order',
    classification: 'contractual',
    surface: 'sdk',
    observed: {
      resultStatus: instant.result?.envelope?.status ?? null,
      orderIdReturned: Boolean(instant.result?.orderId),
      envelopeStatus: instantEnvelope.status,
      orders: modules('order').countWhere({ quoteVersionId: instantDeal.versionId }),
      artifacts: modules('signed-artifact').listWhere({ envelopeId: instantEnvelope.id }).length,
    },
  }));

  // ---- redelivery resumes a failed completion -------------------------------
  const faultDeal = await approvedQuote(app, { name: 'Fault Deal' });
  await request(faultDeal, 'fault@example.com');
  const faultEnvelope = modules('signature-envelope').listWhere({ quoteVersionId: faultDeal.versionId })[0];
  signatureFixture.markCompleted(faultEnvelope.idempotencyKey);
  const orderService = modules('order');
  const realCreateManaged = orderService.createManaged.bind(orderService);
  let injected = false;
  orderService.createManaged = async (...args) => {
    if (!injected) { injected = true; throw new Error('injected order failure'); }
    return realCreateManaged(...args);
  };
  const faultEvent = signatureFixture.event(faultEnvelope.idempotencyKey, 'completed', { providerEventId: 'evt_f_fault' });
  const firstDelivery = await refusal(app.ingestSignatureEvent({ provider: 'fixture-signature', rawBody: faultEvent.rawBody, headers: faultEvent.headers }));
  const afterFault = {
    envelopeStatus: modules('signature-envelope').get(faultEnvelope.id).status,
    orders: modules('order').countWhere({ quoteVersionId: faultDeal.versionId }),
    artifacts: modules('signed-artifact').listWhere({ envelopeId: faultEnvelope.id }).length,
    inbox: (() => {
      const row = modules('signature-event').listWhere({ providerEventId: 'evt_f_fault' })[0];
      return { recorded: Boolean(row), processed: row?.processed ?? null, effect: row?.effect ?? null };
    })(),
  };
  orderService.createManaged = realCreateManaged;
  const redelivery = await app.ingestSignatureEvent({ provider: 'fixture-signature', rawBody: faultEvent.rawBody, headers: faultEvent.headers });
  record(observation({
    id: 'webhook.failed-processing-redelivery-resumes',
    category: 'webhook',
    classification: 'contractual',
    surface: 'sdk',
    observed: {
      firstDelivery: { refused: firstDelivery.refused, message: firstDelivery.message },
      afterFault,
      redelivery: { applied: redelivery.applied ?? null, duplicate: redelivery.duplicate ?? null, resumed: redelivery.resumed ?? null },
      finalOrders: modules('order').countWhere({ quoteVersionId: faultDeal.versionId }),
      orderComplete: (() => {
        const order = modules('order').listWhere({ quoteVersionId: faultDeal.versionId })[0];
        return order ? {
          lines: modules('order-line').countWhere({ orderId: order.id }),
          totals: modules('order-total').countWhere({ orderId: order.id }),
        } : null;
      })(),
      inboxProcessed: modules('signature-event').listWhere({ providerEventId: 'evt_f_fault' })[0].processed,
    },
  }));

  // ---- quarantine and adoption ----------------------------------------------
  const earlyDeal = await approvedQuote(app, { name: 'Early Deal' });
  await request(earlyDeal, 'early@example.com');
  const earlyEnvelope = modules('signature-envelope').listWhere({ quoteVersionId: earlyDeal.versionId })[0];
  app.database.raw.prepare('UPDATE signature_envelopes SET provider_envelope_id = NULL WHERE id = ?').run(earlyEnvelope.id);
  signatureFixture.markCompleted(earlyEnvelope.idempotencyKey);
  const earlyEvent = signatureFixture.event(earlyEnvelope.idempotencyKey, 'completed', { providerEventId: 'evt_f_early' });
  const quarantined = await app.ingestSignatureEvent({ provider: 'fixture-signature', rawBody: earlyEvent.rawBody, headers: earlyEvent.headers });
  const quarantineRow = modules('signature-event').listWhere({ providerEventId: 'evt_f_early' })[0];
  const ordersBeforeReconcile = modules('order').countWhere({ quoteVersionId: earlyDeal.versionId });
  const adopted = await app.reconcileSignature({ envelopeId: earlyEnvelope.id, actor });
  const adoptedRow = modules('signature-event').listWhere({ providerEventId: 'evt_f_early' })[0];
  record(observation({
    id: 'webhook.unknown-envelope-quarantined-then-adopted',
    category: 'webhook',
    classification: 'contractual',
    surface: 'sdk',
    observed: {
      ingest: { quarantined: quarantined.quarantined ?? null },
      inboxBefore: { effect: quarantineRow.effect, effectReason: quarantineRow.effectReason, envelopeLinked: quarantineRow.envelopeId !== null, processed: quarantineRow.processed },
      ordersBeforeReconcile,
      reconcile: { applied: adopted.applied ?? null, status: adopted.status ?? null },
      inboxAfter: { envelopeLinked: adoptedRow.envelopeId === earlyEnvelope.id, effectReason: adoptedRow.effectReason },
      ordersAfterReconcile: modules('order').countWhere({ quoteVersionId: earlyDeal.versionId }),
    },
  }));

  // ---- two-connection race: duplicate webhooks on one database --------------
  const raceDeal = await approvedQuote(app, { name: 'Race Deal' });
  await request(raceDeal, 'race@example.com');
  const raceEnvelope = modules('signature-envelope').listWhere({ quoteVersionId: raceDeal.versionId })[0];
  signatureFixture.markCompleted(raceEnvelope.idempotencyKey);
  const raceEvent = signatureFixture.event(raceEnvelope.idempotencyKey, 'completed', { providerEventId: 'evt_f_race' });
  const { createAccordoApp } = await import(pathToFileURL(join(root, 'packages/app/src/index.js')).href);
  const second = createAccordoApp({ dbPath });
  t.after(() => second.close());
  const [first, secondResult] = await Promise.allSettled([
    app.ingestSignatureEvent({ provider: 'fixture-signature', rawBody: raceEvent.rawBody, headers: raceEvent.headers }),
    second.ingestSignatureEvent({ provider: 'fixture-signature', rawBody: raceEvent.rawBody, headers: raceEvent.headers }),
  ]);
  const raceOutcome = [first, secondResult].map((settled) => (settled.status === 'fulfilled'
    ? { fulfilled: true, applied: settled.value.applied ?? null, duplicate: settled.value.duplicate ?? null, resumed: settled.value.resumed ?? null }
    : { fulfilled: false, code: settled.reason?.code ?? null }));
  record(observation({
    id: 'races-restart.two-connection-duplicate-webhook',
    category: 'races-restart',
    classification: 'contractual',
    surface: 'storage',
    observed: {
      orders: modules('order').countWhere({ quoteVersionId: raceDeal.versionId }),
      envelopeStatus: modules('signature-envelope').get(raceEnvelope.id).status,
      inboxRows: modules('signature-event').countWhere({ providerEventId: 'evt_f_race' }),
      atLeastOneFulfilled: raceOutcome.some((entry) => entry.fulfilled),
      noRawSqliteError: raceOutcome.every((entry) => entry.fulfilled || typeof entry.code === 'string'),
    },
  }));
  record(observation({
    id: 'races-restart.two-connection-interleaving-detail',
    category: 'races-restart',
    classification: 'incidental',
    surface: 'storage',
    observed: raceOutcome,
    note: 'Which connection wins and whether the loser sees duplicate/resumed/refused depends on scheduling; the deterministic contract (one order, one completed envelope, one inbox row, no raw SQLite error) is asserted above.',
  }));

  // ---- webhook racing a reconcile -------------------------------------------
  const race2Deal = await approvedQuote(app, { name: 'Race Reconcile Deal' });
  await request(race2Deal, 'race2@example.com');
  const race2Envelope = modules('signature-envelope').listWhere({ quoteVersionId: race2Deal.versionId })[0];
  signatureFixture.markCompleted(race2Envelope.idempotencyKey);
  const race2Event = signatureFixture.event(race2Envelope.idempotencyKey, 'completed', { providerEventId: 'evt_f_race2' });
  const race2 = await Promise.allSettled([
    app.ingestSignatureEvent({ provider: 'fixture-signature', rawBody: race2Event.rawBody, headers: race2Event.headers }),
    app.reconcileSignature({ envelopeId: race2Envelope.id, actor }),
  ]);
  record(observation({
    id: 'races-restart.webhook-races-reconcile',
    category: 'races-restart',
    classification: 'contractual',
    surface: 'storage',
    observed: {
      orders: modules('order').countWhere({ quoteVersionId: race2Deal.versionId }),
      artifacts: modules('signed-artifact').listWhere({ envelopeId: race2Envelope.id }).length,
      envelopeStatus: modules('signature-envelope').get(race2Envelope.id).status,
      bothSettledWithoutRawError: race2.every((settled) => settled.status === 'fulfilled' || typeof settled.reason?.code === 'string'),
    },
  }));
}

// ---------------------------------------------------------------------------
// crash between phases, restart, immutability and scale
// ---------------------------------------------------------------------------

export async function runCrashRestartScaleCases(t, record) {
  const root = characterizationProject(t, { name: 'accordo-sig-la0-crash-' });
  const dbPath = join(root, 'data', 'sig-la0-crash.sqlite');
  process.env.ACCORDO_FIXTURE_SIGNATURE_STORE = join(root, 'fixture-provider.json');
  t.after(() => { delete process.env.ACCORDO_FIXTURE_SIGNATURE_STORE; });
  const { signatureFixture } = await loadFixture(root);
  signatureFixture.reset();
  let instance = await boot(root, dbPath);
  t.after(() => instance.close().catch(() => {}));
  const actor = { type: 'user', id: 'sig-la0' };

  // ---- kill the process between the provider call and finalization ---------
  const crashedDeal = await approvedQuote(instance.app, { name: 'Crash Deal' });
  await instance.close();
  writeFileSync(join(root, 'crash.mjs'), [
    "import { pathToFileURL } from 'node:url';",
    "import { join } from 'node:path';",
    `const root = ${JSON.stringify(root)};`,
    "const { createAccordoApp } = await import(pathToFileURL(join(root, 'packages/app/src/index.js')).href);",
    `const app = createAccordoApp({ dbPath: ${JSON.stringify(dbPath)} });`,
    "const envelopes = app.modules.get('signature-envelope').service;",
    'const realApply = envelopes.applyManaged.bind(envelopes);',
    'let calls = 0;',
    'envelopes.applyManaged = async (...args) => {',
    '  if (calls++ === 0) process.exit(9);',
    '  return realApply(...args);',
    '};',
    `await app.runAction({ module: 'quote', action: 'request-signature', recordId: ${JSON.stringify(crashedDeal.quote.id)},`,
    `  input: { quoteVersionId: ${JSON.stringify(crashedDeal.versionId)}, provider: 'fixture-signature', providerVersion: 1, signers: [{ name: 'Maria Bianchi', email: 'crash@example.com', role: 'customer', order: 1 }] },`,
    "  actor: { type: 'user', id: 'crash' } });",
    'process.exit(0);',
    '',
  ].join('\n'));
  const crash = spawnSync(process.execPath, ['--no-warnings', join(root, 'crash.mjs')], {
    encoding: 'utf8', cwd: root,
    env: { ...process.env, ACCORDO_FIXTURE_SIGNATURE_STORE: join(root, 'fixture-provider.json') },
  });

  instance = await boot(root, dbPath);
  const modules = (name) => instance.app.modules.get(name).service;
  const stranded = modules('signature-envelope').listWhere({ quoteVersionId: crashedDeal.versionId })[0];
  const rerequest = await refusal(instance.client.module('quote').action(crashedDeal.quote.id, 'request-signature', {
    quoteVersionId: crashedDeal.versionId, provider: 'fixture-signature', providerVersion: 1, signers: signerList('crash@example.com'),
  }));
  const recovered = await instance.app.reconcileSignature({ envelopeId: stranded.id, actor });
  const recoveredEnvelope = modules('signature-envelope').get(stranded.id);
  record(observation({
    id: 'races-restart.kill-between-phases-recovery',
    category: 'races-restart',
    classification: 'contractual',
    surface: 'storage',
    observed: {
      childExitCode: crash.status,
      afterRestart: {
        intentSurvived: Boolean(stranded),
        status: stranded.status,
        providerEnvelopeId: stranded.providerEnvelopeId,
      },
      rerequestRefused: { refused: rerequest.refused, code: rerequest.code, status: rerequest.status },
      reconcile: { applied: recovered.applied, status: recovered.status },
      recoveredEnvelope: {
        status: recoveredEnvelope.status,
        providerEnvelopeIdRecovered: /^env_[0-9a-f]{24}$/.test(String(recoveredEnvelope.providerEnvelopeId)),
      },
      envelopesForVersion: modules('signature-envelope').countWhere({ quoteVersionId: crashedDeal.versionId }),
    },
  }));

  // ---- a full journey, then restart: same answers from the same database ----
  const restartDeal = await approvedQuote(instance.app, { name: 'Restart Deal' });
  await instance.client.module('quote').action(restartDeal.quote.id, 'request-signature', {
    quoteVersionId: restartDeal.versionId, provider: 'fixture-signature', providerVersion: 1, signers: signerList('restart@example.com'),
  });
  const restartEnvelope = modules('signature-envelope').listWhere({ quoteVersionId: restartDeal.versionId })[0];
  signatureFixture.markCompleted(restartEnvelope.idempotencyKey);
  const restartEvent = signatureFixture.event(restartEnvelope.idempotencyKey, 'completed', { providerEventId: 'evt_c_restart' });
  await instance.app.ingestSignatureEvent({ provider: 'fixture-signature', rawBody: restartEvent.rawBody, headers: restartEvent.headers });
  const beforeRestart = {
    envelope: modules('signature-envelope').get(restartEnvelope.id),
    order: modules('order').listWhere({ quoteVersionId: restartDeal.versionId })[0],
    schema: await instance.client.schema(),
  };
  await instance.close();
  instance = await boot(root, dbPath);
  const after = (name) => instance.app.modules.get(name).service;
  const afterEnvelope = after('signature-envelope').get(restartEnvelope.id);
  const afterOrder = after('order').listWhere({ quoteVersionId: restartDeal.versionId })[0];
  const afterSchema = await instance.client.schema();
  record(observation({
    id: 'races-restart.restart-preserves-evidence',
    category: 'races-restart',
    classification: 'contractual',
    surface: 'storage',
    observed: {
      envelopeIdentical: JSON.stringify(afterEnvelope) === JSON.stringify(beforeRestart.envelope),
      orderIdentical: JSON.stringify(afterOrder) === JSON.stringify(beforeRestart.order),
      schemaSignatureBlockIdentical: JSON.stringify(signatureSchemaBlock(afterSchema)) === JSON.stringify(signatureSchemaBlock(beforeRestart.schema)),
      reconcileIsSafeNoOp: await instance.app.reconcileSignature({ envelopeId: restartEnvelope.id, actor })
        .then((result) => ({ applied: result.applied, reason: result.reason })),
    },
  }));

  // ---- immutability: later catalog and CRM movement never rewrites evidence -
  instance.app.database.raw.prepare('UPDATE price_components SET unit_amount_cents = 1').run();
  instance.app.database.raw.prepare('UPDATE offers SET active = 0').run();
  instance.app.database.raw.prepare('UPDATE companies SET name = ?').run('Renamed Everything SpA');
  const untouchedOrder = after('order').listWhere({ quoteVersionId: restartDeal.versionId })[0];
  const untouchedComponents = after('order-component').listWhere({ orderId: untouchedOrder.id });
  record(observation({
    id: 'completion-order.immutable-against-source-movement',
    category: 'completion-order',
    classification: 'contractual',
    surface: 'storage',
    observed: {
      orderIdentical: JSON.stringify(untouchedOrder) === JSON.stringify(afterOrder),
      customerNameAsSigned: untouchedOrder.customerName,
      signedTierPricesSurvive: untouchedComponents.some((component) => String(component.tiersJson ?? '').includes('"unitAmountCents":5000')),
      envelopeDocumentHashUnchanged: after('signature-envelope').get(restartEnvelope.id).documentHash === beforeRestart.envelope.documentHash,
    },
  }));

  // ---- scale: exact reads far past the display bound ------------------------
  const inbox = after('signature-event');
  const before = inbox.countWhere({ provider: 'fixture-signature' });
  for (let index = 0; index < 520; index += 1) {
    await inbox.createManaged({
      sourceKey: `sev:bulk:${index}`, provider: 'fixture-signature', providerVersion: 1,
      providerFingerprint: 'f'.repeat(64), providerEventId: `bulk_${index}`, providerEnvelopeId: 'env_bulk',
      payloadFingerprint: 'a'.repeat(64), envelopeId: null, status: 'sent', sequence: index,
      occurredAt: FIXTURE_COMPLETED_AT, receivedAt: FIXTURE_COMPLETED_AT,
      processed: true, effect: 'quarantined', effectReason: 'bulk',
    }, { actor });
  }
  record(observation({
    id: 'scale.exact-reads-beyond-page-bound',
    category: 'scale',
    classification: 'contractual',
    surface: 'storage',
    observed: {
      written: 520,
      countExact: inbox.countWhere({ provider: 'fixture-signature' }) - before,
      exactRowFoundBeyondBound: inbox.listWhere({ providerEventId: 'bulk_517' }).length,
      exactRowSequence: inbox.listWhere({ providerEventId: 'bulk_517' })[0].sequence,
      pagedListBounded: inbox.list({ limit: 500 }).length,
      envelopeExactLookupStillExact: after('signature-envelope').listWhere({ quoteVersionId: restartDeal.versionId }).length,
    },
  }));
}
