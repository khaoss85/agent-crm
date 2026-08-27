// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDatabase } from '../packages/core/src/database.js';
import { PackageRegistry, createDefinitionVersionStore } from '../packages/core/index.js';
import { CommercialRegistries } from '../packages/commercial/src/registry.js';
import { SignatureRegistries } from '../packages/signature/src/registry.js';
import { IntelligenceRegistries } from '../packages/intelligence/src/registry.js';

/**
 * **Production Spine v2 M2B — the definition-version store.**
 *
 * Four registries used to carry four copies of one raw SQLite persist-or-verify
 * loop against `definition_versions`. They now call one internal core store
 * behind Storage Contract v1. These tests prove the move changed nothing a
 * caller can observe: the same rows, the same idempotent restart, the same
 * byte-identical immutability refusal, the same all-or-nothing batch and the
 * same concurrent-boot convergence — for every registry family.
 */

/**
 * The one guard for this milestone. It covers the four files M2B declared and
 * nothing else: `packages/workflows/src/engine.js`, the action runtime and
 * Work's transaction-context seam still reach the driver, deliberately, and
 * this assertion makes no claim about them.
 */
test('the declared M2B slice has no raw-driver reachability', () => {
  const paths = [
    'packages/commercial/src/registry.js',
    'packages/signature/src/registry.js',
    'packages/intelligence/src/registry.js',
    'packages/core/src/package-registry.js',
  ];
  for (const path of paths) {
    const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /database\.raw|\.raw\.prepare\s*\(|\.raw\.exec\s*\(|DatabaseSync/,
      `${path} must persist definition versions through the structured storage seam`);
  }
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A file-backed database, because a restart is a second connection to a file. */
function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'accordo-m2b-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return join(root, 'definitions.sqlite');
}

function memory(t) {
  const database = createDatabase({ path: ':memory:' });
  t.after(() => database.close());
  return database;
}

const rows = (database) => database.raw
  .prepare('SELECT type, name, version, fingerprint, id, registered_at FROM definition_versions ORDER BY type, name, version')
  .all()
  // node:sqlite hands back null-prototype rows; compare plain data.
  .map((row) => ({ ...row }));

const identities = (database) => rows(database).map((row) => `${row.type}:${row.name}@${row.version}`);

const entry = (over = {}) => ({ type: 'fixture-kind', name: 'alpha', version: 1, fingerprint: 'a'.repeat(64), ...over });

const catalogProvider = (over = {}) => ({
  name: 'fixture-catalog',
  version: 1,
  label: 'Fixture',
  config: { source: 'fixture' },
  async fetchCatalog() { return { priceBooks: [], products: [], offers: [] }; },
  ...over,
});

const discountPolicy = (over = {}) => ({
  name: 'discounts',
  version: 1,
  label: 'Discounts',
  config: { autoApproveMaxBps: 1000 },
  evaluate: (ctx) => (ctx.maxLineDiscountBps <= ctx.config.autoApproveMaxBps
    ? { decision: 'auto_approve' }
    : { decision: 'approval_required', requiredApprovalKey: 'sales-manager' }),
  ...over,
});

const signatureProvider = (over = {}) => ({
  name: 'fixture-signature',
  version: 1,
  label: 'Fixture',
  config: { testOnlyVerificationKey: 'k' },
  createEnvelope: async () => ({}),
  getEnvelope: async () => ({}),
  verifyEvent: async () => ({}),
  getSignedArtifact: async () => ({}),
  ...over,
});

const enrichmentProvider = (over = {}) => ({
  name: 'fixture', version: 1, label: 'Fixture', capabilities: ['company'],
  async enrichCompany() { return { fields: {} }; },
  ...over,
});

const scoringModel = (over = {}) => ({
  name: 'score', version: 1, label: 'Score',
  rules: [{ key: 'rule-a', label: 'Rule A', weight: 10, evaluate: () => true }],
  ...over,
});

const routingPolicy = (over = {}) => ({ name: 'routing', version: 1, label: 'Routing', route: () => null, ...over });

const domainPolicy = (over = {}) => ({
  name: 'p', version: 1, config: {},
  classifyComponent: () => ({ commercialActivation: 'non_subscription', obligations: [] }),
  ...over,
});

const domain = (over = {}) => ({
  name: 'd', packageContract: 1, version: 1, label: 'D', actions: [], policies: [], metadata: () => ({}), ...over,
});

/**
 * The four families, each described the same way: how to build a registry, the
 * identities a first registration must write, and how to make one registered
 * version drift while keeping its identity.
 */
const FAMILIES = [
  {
    label: 'commercial',
    build: () => new CommercialRegistries({ catalogProviders: [catalogProvider()], discountPolicies: [discountPolicy()] }),
    expect: ['catalog-provider:fixture-catalog@1', 'discount-policy:discounts@1'],
    drifted: () => new CommercialRegistries({ discountPolicies: [discountPolicy({ config: { autoApproveMaxBps: 9999 } })] }),
    driftType: 'discount-policy',
    driftIdentity: 'discounts@1',
    fingerprintOf: (registries) => registries.getDiscountPolicy('discounts', 1).fingerprint,
    // A second, brand-new identity registered in the SAME batch as the drift.
    withNewSibling: (drifted) => new CommercialRegistries({
      discountPolicies: [discountPolicy({ name: 'rollback-sibling', version: 7 }), ...[...drifted.discountPolicies.values()].map((e) => e.definition)],
    }),
    sibling: 'discount-policy:rollback-sibling@7',
  },
  {
    label: 'signature',
    build: () => new SignatureRegistries({ signatureProviders: [signatureProvider(), signatureProvider({ version: 2 })] }),
    expect: ['signature-provider:fixture-signature@1', 'signature-provider:fixture-signature@2'],
    drifted: () => new SignatureRegistries({
      signatureProviders: [signatureProvider({ config: { testOnlyVerificationKey: 'moved' } })],
    }),
    driftType: 'signature-provider',
    driftIdentity: 'fixture-signature@1',
    fingerprintOf: (registries) => registries.getSignatureProvider('fixture-signature', 1).fingerprint,
    withNewSibling: (drifted) => new SignatureRegistries({
      signatureProviders: [
        signatureProvider({ name: 'rollback-sibling', version: 7 }),
        ...[...drifted.signatureProviders.values()].map((e) => e.definition),
      ],
    }),
    sibling: 'signature-provider:rollback-sibling@7',
  },
  {
    label: 'intelligence',
    build: () => new IntelligenceRegistries({
      enrichmentProviders: [enrichmentProvider()],
      scoringModels: [scoringModel()],
      routingPolicies: [routingPolicy()],
    }),
    expect: ['enrichment-provider:fixture@1', 'routing-policy:routing@1', 'scoring-model:score@1'],
    drifted: () => new IntelligenceRegistries({
      scoringModels: [scoringModel({ rules: [{ key: 'rule-a', label: 'Rule A', weight: 99, evaluate: () => true }] })],
    }),
    driftType: 'scoring-model',
    driftIdentity: 'score@1',
    fingerprintOf: (registries) => registries.getScoringModel('score', 1).fingerprint,
    withNewSibling: (drifted) => new IntelligenceRegistries({
      scoringModels: [
        scoringModel({ name: 'rollback-sibling', version: 7 }),
        ...[...drifted.scoringModels.values()].map((e) => e.definition),
      ],
    }),
    sibling: 'scoring-model:rollback-sibling@7',
  },
  {
    label: 'package registry',
    build: () => new PackageRegistry({
      packages: [domain({ policies: [{ kind: 'k', definition: domainPolicy() }, { kind: 'k', definition: domainPolicy({ version: 2 }) }] })],
    }),
    expect: ['domain-policy:d:k:p@1', 'domain-policy:d:k:p@2'],
    drifted: () => new PackageRegistry({
      packages: [domain({ policies: [{ kind: 'k', definition: domainPolicy({ config: { moved: true } }) }] })],
    }),
    driftType: 'domain-policy:d:k',
    driftIdentity: 'p@1',
    fingerprintOf: (registry) => registry.getPolicy('d', 'k', 'p', 1).fingerprint,
    withNewSibling: () => new PackageRegistry({
      packages: [domain({
        policies: [
          { kind: 'k', definition: domainPolicy({ name: 'rollback-sibling', version: 7 }) },
          { kind: 'k', definition: domainPolicy({ config: { moved: true } }) },
        ],
      })],
    }),
    sibling: 'domain-policy:d:k:rollback-sibling@7',
  },
];

/** The one refusal, spelled out here so a change to it has to change this file. */
const driftMessage = (type, identity, persisted, current) =>
  `${type} "${identity}" source changed after registration (persisted fingerprint ${persisted.slice(0, 12)}…, current ${current.slice(0, 12)}…). `
  + 'Registered definition versions are immutable: publish a new version instead of editing this one.';

// ---------------------------------------------------------------------------
// The store itself
// ---------------------------------------------------------------------------

test('the store persists exactly the four identity fields, with store-owned metadata', (t) => {
  const database = memory(t);
  const ids = ['id-1', 'id-2', 'id-3'];
  let issued = 0;
  const store = createDefinitionVersionStore(database, {
    clock: () => '2026-08-27T09:00:00.000Z',
    newId: () => ids[issued++],
  });

  // Mixed types and several entries in ONE transaction.
  store.persist([
    entry({ type: 'kind-a', name: 'alpha', version: 1, fingerprint: 'a'.repeat(64) }),
    entry({ type: 'kind-b', name: 'beta', version: 2, fingerprint: 'b'.repeat(64) }),
    entry({ type: 'kind-a', name: 'alpha', version: 2, fingerprint: 'c'.repeat(64) }),
  ]);

  assert.deepEqual(rows(database), [
    { type: 'kind-a', name: 'alpha', version: 1, fingerprint: 'a'.repeat(64), id: 'id-1', registered_at: '2026-08-27T09:00:00.000Z' },
    { type: 'kind-a', name: 'alpha', version: 2, fingerprint: 'c'.repeat(64), id: 'id-3', registered_at: '2026-08-27T09:00:00.000Z' },
    { type: 'kind-b', name: 'beta', version: 2, fingerprint: 'b'.repeat(64), id: 'id-2', registered_at: '2026-08-27T09:00:00.000Z' },
  ]);

  // Re-persisting the identical batch verifies and writes nothing new.
  store.persist([
    entry({ type: 'kind-a', name: 'alpha', version: 1, fingerprint: 'a'.repeat(64) }),
    entry({ type: 'kind-b', name: 'beta', version: 2, fingerprint: 'b'.repeat(64) }),
    entry({ type: 'kind-a', name: 'alpha', version: 2, fingerprint: 'c'.repeat(64) }),
  ]);
  assert.equal(rows(database).length, 3, 'a repeat registration verifies rather than duplicating');
  assert.equal(issued, 3, 'and issues no further ids');
});

test('the store defaults to the framework clock and a uuid, and refuses a bad clock', (t) => {
  const database = memory(t);
  createDefinitionVersionStore(database).persist([entry()]);
  const [row] = rows(database);
  assert.match(row.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.match(row.registered_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

  assert.throws(() => createDefinitionVersionStore(database, { clock: 'noon' }), /clock must be a function/);
  assert.throws(
    () => createDefinitionVersionStore(database, { clock: () => 'yesterday' }).persist([entry({ name: 'other' })]),
    /clock must return a canonical UTC ISO instant/,
  );
  assert.throws(() => createDefinitionVersionStore(database, { newId: 'nope' }), /newId must be a function/);
  assert.throws(() => createDefinitionVersionStore({}), /requires a database with Storage Contract v1/);
});

test('the store validates the whole batch before it opens a transaction', (t) => {
  const database = memory(t);
  const opened = [];
  const sync = database.storage.sync;
  const handle = {
    storage: {
      sync: {
        ...sync,
        transaction(fn) { opened.push('transaction'); return sync.transaction(fn); },
      },
    },
  };
  const store = createDefinitionVersionStore(handle);

  const refusals = [
    [[entry(), null], /entry must be a plain object/],
    [[entry(), 'alpha@1'], /entry must be a plain object/],
    [[entry(), []], /entry must be a plain object/],
    // A caller may hand over the identity and nothing else: never the
    // definition, never its config, never a handler.
    [[entry({ config: { secret: 1 } })], /unsupported field "config"/],
    [[entry({ evaluate: () => true })], /unsupported field "evaluate"/],
    [[entry({ id: 'caller-chosen' })], /unsupported field "id"/],
    [[entry({ registeredAt: '2026-01-01T00:00:00.000Z' })], /unsupported field "registeredAt"/],
    [[entry({ type: '' })], /type must be a non-empty string/],
    [[entry({ type: '   ' })], /type must be a non-empty string/],
    [[entry({ type: 42 })], /type must be a non-empty string/],
    [[entry({ name: '' })], /name must be a non-empty string/],
    [[entry({ name: undefined })], /name must be a non-empty string/],
    [[entry({ fingerprint: '' })], /fingerprint must be a non-empty string/],
    [[entry({ fingerprint: null })], /fingerprint must be a non-empty string/],
    [[entry({ version: 1.5 })], /version must be a non-negative integer/],
    [[entry({ version: -1 })], /version must be a non-negative integer/],
    [[entry({ version: '1' })], /version must be a non-negative integer/],
    [[entry({ version: Number.NaN })], /version must be a non-negative integer/],
  ];
  for (const [batch, pattern] of refusals) {
    assert.throws(() => store.persist(batch), pattern);
  }
  for (const [batch] of refusals) {
    assert.throws(() => store.persist(batch), (error) => error.code === 'VALIDATION_ERROR' && error.status === 400);
  }
  assert.deepEqual(opened, [], 'a malformed batch never reaches BEGIN IMMEDIATE');
  assert.equal(rows(database).length, 0, 'and persists nothing, including the well-formed entries beside it');
});

test('the store keeps the outer transaction wrapper, so nesting is still refused', (t) => {
  const database = memory(t);
  const store = createDefinitionVersionStore(database);
  assert.throws(
    () => database.transaction(() => store.persist([entry()])),
    (error) => error.code === 'NESTED_TRANSACTION' && error.status === 500,
    'the store opens the same outer transaction the application handle does',
  );
  assert.equal(rows(database).length, 0);
  // …and the connection is usable afterwards: the refusal did not strand a
  // half-open transaction.
  store.persist([entry()]);
  assert.equal(rows(database).length, 1);
});

test('an identity repeated inside one batch verifies against what the batch just wrote', (t) => {
  const database = memory(t);
  const store = createDefinitionVersionStore(database);
  store.persist([entry(), entry()]);
  assert.equal(rows(database).length, 1, 'the second occurrence reads the first one back');
  assert.throws(
    () => store.persist([entry({ name: 'gamma' }), entry({ name: 'gamma', fingerprint: 'f'.repeat(64) })]),
    /source changed after registration/,
    'and a repeat that disagrees with itself is drift, not a driver constraint error',
  );
  assert.deepEqual(identities(database), ['fixture-kind:alpha@1'], 'the refused batch left nothing behind');
});

// ---------------------------------------------------------------------------
// Per-family behaviour preservation
// ---------------------------------------------------------------------------

for (const family of FAMILIES) {
  test(`${family.label}: a first registration writes every identity, and a real restart verifies them`, (t) => {
    const path = workspace(t);
    const first = createDatabase({ path });
    family.build().persistFingerprints(first);
    assert.deepEqual(identities(first), family.expect);
    const written = rows(first);
    first.close();

    // A restart is a NEW connection to the same file, running the same
    // registration again — the boot path, not a re-import.
    const restarted = createDatabase({ path });
    t.after(() => restarted.close());
    assert.doesNotThrow(() => family.build().persistFingerprints(restarted));
    assert.deepEqual(rows(restarted), written, 'a restart verifies: same rows, same ids, same registered_at');
  });

  test(`${family.label}: a registered version whose source moved refuses with the unchanged message`, (t) => {
    const database = memory(t);
    const registries = family.build();
    registries.persistFingerprints(database);
    const persisted = family.fingerprintOf(registries);

    const drifted = family.drifted();
    const current = family.fingerprintOf(drifted);
    assert.notEqual(persisted, current, 'the fixture really did change the definition');

    assert.throws(
      () => drifted.persistFingerprints(database),
      (error) => {
        assert.equal(error.message, driftMessage(family.driftType, family.driftIdentity, persisted, current));
        assert.equal(error.code, 'VALIDATION_ERROR');
        assert.equal(error.status, 400);
        // Nothing the SQLite driver said ever reaches a caller.
        assert.doesNotMatch(error.message, /SQLITE|UNIQUE constraint|prepare|INSERT INTO|SELECT /i);
        return true;
      },
    );
    assert.deepEqual(identities(database), family.expect, 'a refused registration changes nothing');
  });

  test(`${family.label}: a batch that refuses halfway persists nothing at all`, (t) => {
    const database = memory(t);
    family.build().persistFingerprints(database);
    const before = rows(database);

    // One brand-new identity beside one drifted identity, in the same batch.
    // Count the inserts that reached the adapter, so "nothing persisted" is a
    // proven rollback rather than a batch that never got that far.
    const sync = database.storage.sync;
    const inserted = [];
    const handle = {
      storage: {
        sync: {
          ...sync,
          execute(statement) { inserted.push(statement.kind); return sync.execute(statement); },
        },
      },
    };
    const batch = family.withNewSibling(family.drifted());
    assert.throws(() => batch.persistFingerprints(handle), /source changed after registration/);
    assert.deepEqual(inserted, ['insert'], 'the new identity was written inside the transaction');
    assert.deepEqual(rows(database), before, 'and the whole batch rolled back');
    assert.equal(
      identities(database).includes(family.sibling), false,
      'including the entry that had already been written',
    );
  });

  test(`${family.label}: two connections registering the same definitions converge on one row set`, (t) => {
    const path = workspace(t);
    const a = createDatabase({ path, busyTimeoutMs: 500 });
    const b = createDatabase({ path, busyTimeoutMs: 500 });
    t.after(() => { a.close(); b.close(); });
    family.build().persistFingerprints(a);
    assert.doesNotThrow(() => family.build().persistFingerprints(b),
      'the second boot re-reads the committed rows and verifies');
    assert.deepEqual(identities(a), family.expect);
    assert.deepEqual(identities(b), family.expect);
  });

  test(`${family.label}: persisting fingerprints does not touch metadata or report output`, (t) => {
    const database = memory(t);
    const registries = family.build();
    const before = JSON.parse(JSON.stringify(registries.metadata()));
    registries.persistFingerprints(database);
    const after = JSON.parse(JSON.stringify(registries.metadata()));
    assert.deepEqual(after, before, 'registration is a write, not a mutation of the published metadata');
    assert.deepEqual(JSON.parse(JSON.stringify(after)), after, 'metadata stays JSON round-trippable and function-free');
  });
}

test('an empty registration is still a no-op for every family that had one', (t) => {
  const database = memory(t);
  assert.doesNotThrow(() => new SignatureRegistries({}).persistFingerprints(database));
  assert.doesNotThrow(() => new PackageRegistry({ packages: [] }).persistFingerprints(database));
  assert.doesNotThrow(() => new CommercialRegistries({}).persistFingerprints(database));
  assert.doesNotThrow(() => new IntelligenceRegistries({}).persistFingerprints(database));
  assert.equal(rows(database).length, 0);
});
