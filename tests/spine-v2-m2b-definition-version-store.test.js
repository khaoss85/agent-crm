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
 * **What this guard is, stated exactly.**
 *
 * It is a *token scan* for the known spellings of direct driver access in four
 * named files. It catches regression by editing — someone reaching for
 * `database.raw` again — and that is worth having, because that is how the
 * driver actually comes back.
 *
 * **It does not prove unreachability, and must not be read as proving it.** No
 * regex can: `const d = database; const r = d['r' + 'aw'];` defeats any pattern
 * written here, and chasing that is a losing game rather than a stricter guard.
 * A test named for a guarantee it cannot deliver is the same reassurance the
 * falsification kit refuses when a mutation stops aiming at anything — so this
 * one is named for what it does.
 *
 * The spellings it does cover are pinned below, each watched failing. The list
 * grew twice under review: optional chaining (`tasks?.database?.raw`, which is
 * how `packages/work/src/follow-up.js` still reaches the driver and why the
 * inherited M2A pattern does not see it), then bracket access and destructuring.
 */
const RAW_DRIVER_SPELLINGS = Object.freeze([
  // `database.raw`, `database?.raw`, `this.database.raw`
  /database\s*\??\.\s*raw\b/,
  // `.raw.prepare(`, `?.raw?.exec(`
  /\??\.\s*raw\s*\??\.\s*(?:prepare|exec)\s*\(/,
  // `database['raw']`, `database?.["raw"]`
  /database\s*\??\.?\s*\[\s*['"]raw['"]\s*\]/,
  // `const { raw } = database`, `const { raw, storage } = this.database`
  /\{[^{}]*\braw\b[^{}]*\}\s*=\s*[^;\n]*\bdatabase\b/i,
  // the driver constructor itself
  /\bDatabaseSync\b/,
]);

/** @param {string} source */
const rawDriverSpelling = (source) => RAW_DRIVER_SPELLINGS.find((pattern) => pattern.test(source)) ?? null;

/**
 * The four files M2B declared, and nothing else:
 * `packages/workflows/src/engine.js`, the action runtime and Work's
 * transaction-context seam still reach the driver, deliberately, and this
 * assertion makes no claim about them.
 */
const M2B_SLICE = Object.freeze([
  'packages/commercial/src/registry.js',
  'packages/signature/src/registry.js',
  'packages/intelligence/src/registry.js',
  'packages/core/src/package-registry.js',
]);

test('the four migrated files carry no known spelling of direct driver access', () => {
  for (const path of M2B_SLICE) {
    const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
    const found = rawDriverSpelling(source);
    assert.equal(found, null,
      `${path} must persist definition versions through the structured storage seam, but matched ${found}`);
  }
});

/**
 * **A guard nobody has watched fail is not a guard.** Every spelling the scan
 * claims to cover is pinned here, and each was additionally verified by
 * construction — written into a migrated file, the guard watched failing, the
 * file restored.
 */
test('the scan catches the spellings it claims to cover', () => {
  const escapes = [
    'const select = database.raw.prepare(sql);',
    'const select = database?.raw.prepare(sql);',
    'const select = database?.raw?.prepare(sql);',
    'const raw = tasks?.database?.raw;',
    'const raw = deps.database ?. raw;',
    "const select = database['raw'].prepare(sql);",
    'const select = database["raw"].prepare(sql);',
    "const select = database?.['raw'].prepare(sql);",
    'const { raw } = database;',
    'const { raw, storage } = this.database;',
    'insert.run(...); database.raw.exec("COMMIT");',
    'const db = new DatabaseSync(":memory:");',
  ];
  for (const escape of escapes) {
    assert.notEqual(rawDriverSpelling(escape), null, `the scan must catch: ${escape}`);
  }
  // …and it does not fire on the seam the four files legitimately use, nor on
  // unrelated identifiers that merely contain the word.
  for (const allowed of [
    'database.storage.sync.execute(statement);',
    'const rawBody = Buffer.from(params.rawBody);',
    'const rawBody = Buffer.isBuffer(params.rawBody) ? params.rawBody : Buffer.from(params.rawBody);',
    'createDefinitionVersionStore(database).persist(entries);',
    "const kinds = ['raw', 'cooked'];",
  ]) {
    assert.equal(rawDriverSpelling(allowed), null, `the scan must allow: ${allowed}`);
  }
});

/**
 * **The limitation, asserted rather than described.** These are real escapes the
 * scan does not catch, and pinning them here is the honest half of the claim: a
 * reader who assumes this guard proves unreachability can run this test and see
 * that it does not. If a future change makes the scan stronger, this test fails
 * and gets updated — which is the point.
 */
test('the scan is a token scan, and cannot prove unreachability', () => {
  for (const undetected of [
    "const d = database; const r = d['r' + 'aw'];",
    'const key = "raw"; const r = handle[key];',
    'const r = Reflect.get(database, "ra" + "w");',
  ]) {
    assert.equal(rawDriverSpelling(undetected), null,
      `this guard is a token scan and does not claim to catch: ${undetected}`);
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
  let issued = 0;
  const store = createDefinitionVersionStore(database, {
    clock: () => '2026-08-27T09:00:00.000Z',
    newId: () => `id-${++issued}`,
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
  assert.deepEqual(rows(database).map((row) => row.id), ['id-1', 'id-3', 'id-2'],
    'a repeat registration verifies rather than duplicating, and no row takes a new id');
  // Ids are minted per *entry*, before the transaction opens, not per insert —
  // that is what lets a malformed or self-colliding generator be refused without
  // a `BEGIN IMMEDIATE` to roll back. The ids minted for entries that turn out
  // to verify are simply discarded, which is why the counter has moved to six
  // while the table still holds the first three.
  assert.equal(issued, 6, 'the second batch minted ids it then discarded');
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

/**
 * `Object.keys` sees only enumerable string keys, so a "closed shape" checked
 * with it is not closed: a field hidden behind `Object.defineProperty`, or held
 * under a symbol, walks straight through and reaches the transaction. The store
 * advertises both a closed shape and fail-closed validation, so it has to
 * refuse the spellings that are easy to reach for as well as the obvious one.
 */
test('the closed entry shape refuses non-enumerable, symbol and non-plain entries', (t) => {
  const database = memory(t);
  const opened = [];
  const sync = database.storage.sync;
  const handle = {
    storage: {
      sync: { ...sync, transaction(fn) { opened.push('transaction'); return sync.transaction(fn); } },
    },
  };
  const store = createDefinitionVersionStore(handle);

  const hidden = entry();
  Object.defineProperty(hidden, 'config', { value: { secret: 'do not persist me' }, enumerable: false });
  assert.equal(Object.keys(hidden).includes('config'), false, 'the fixture really is invisible to Object.keys');
  assert.throws(() => store.persist([hidden]), /unsupported field "config"/,
    'a non-enumerable extra field is still an extra field');

  const symboled = entry();
  symboled[Symbol.for('accordo.test.config')] = { secret: 'do not persist me either' };
  assert.throws(() => store.persist([symboled]), /unsupported field/,
    'a symbol-keyed extra field is still an extra field');

  // "Plain object" has to mean it: a class instance and a null-prototype bag
  // both carry the four fields and neither is what the contract says.
  class NotPlain {
    constructor() {
      Object.assign(this, entry());
    }
  }
  assert.throws(() => store.persist([new NotPlain()]), /must be a plain object/);
  const bare = Object.create(null);
  Object.assign(bare, entry());
  assert.throws(() => store.persist([bare]), /must be a plain object/);

  assert.deepEqual(opened, [], 'none of these reached BEGIN IMMEDIATE');
  assert.equal(rows(database).length, 0, 'and none of them persisted anything');
});

/**
 * **Closing a shape has two halves, and `Reflect.ownKeys` covers only one.**
 * "No key you did not name" is not enough: every key you *did* name has to be
 * present on the object itself. A polluted `Object.prototype` supplies a
 * missing field through the chain — `Reflect.ownKeys` sees no unsupported key
 * because the field is not an own key at all, and the prototype check passes
 * because the entry's prototype genuinely is `Object.prototype`. The malformed
 * entry then reaches the transaction and persists an inherited value.
 *
 * Not hypothetical here: `tests/commercial-contract.test.js` already refuses
 * `__proto__`, `constructor` and `prototype` as lookup names, so hostile
 * prototype keys are an established concern in this repository.
 *
 * Every pollution is restored in a `finally`. A test that pollutes
 * `Object.prototype` and does not clean up fails unrelated suites in the same
 * process, and nobody traces that back to here.
 */
test('a polluted Object.prototype cannot supply a field the entry does not own', (t) => {
  const database = memory(t);
  const opened = [];
  const sync = database.storage.sync;
  const handle = {
    storage: {
      sync: { ...sync, transaction(fn) { opened.push('transaction'); return sync.transaction(fn); } },
    },
  };
  const store = createDefinitionVersionStore(handle);

  // Each pollution is a *valid-looking* value, so nothing downstream would
  // refuse it on its merits: only ownership can.
  for (const [field, value] of [
    ['type', 'inherited-kind'],
    ['name', 'inherited-name'],
    ['version', 7],
    ['fingerprint', 'e'.repeat(64)],
  ]) {
    const incomplete = entry();
    delete incomplete[field];
    assert.equal(Object.hasOwn(incomplete, field), false, `${field} really is missing from the entry`);
    Object.defineProperty(Object.prototype, field, {
      value, configurable: true, writable: true, enumerable: false,
    });
    try {
      assert.equal(incomplete[field], value, `${field} really is readable through the prototype`);
      assert.throws(
        () => store.persist([incomplete]),
        (error) => error.code === 'VALIDATION_ERROR' && /requires own field/.test(error.message),
        `an entry that inherits ${field} rather than owning it must be refused`,
      );
    } finally {
      delete (/** @type {any} */ (Object.prototype))[field];
    }
    assert.equal(Object.hasOwn(Object.prototype, field), false, `Object.prototype.${field} was restored`);
  }

  assert.deepEqual(opened, [], 'no polluted entry reached BEGIN IMMEDIATE');
  assert.equal(rows(database).length, 0, 'and none of them persisted an inherited value');
});

/**
 * **An injected generator is input, and input is validated.** `resolveClock`
 * does not merely check that the clock is a function — it validates what the
 * clock *returns*, on every call. `newId` had only the weaker half of that
 * treatment, so a generator returning `null`, a number, or the same id twice
 * sent that value into `storage.execute` and left SQLite's `PRIMARY KEY` to
 * decide. That contradicts two things this milestone claims for itself: fail
 * closed on malformed input, and no raw driver message ever becoming public.
 */
test('an injected id generator is validated on what it returns, not only that it is a function', (t) => {
  const database = memory(t);
  const opened = [];
  const sync = database.storage.sync;
  const handle = {
    storage: {
      sync: { ...sync, transaction(fn) { opened.push('transaction'); return sync.transaction(fn); } },
    },
  };
  const refuses = (newId, batch, pattern, label) => {
    assert.throws(
      () => createDefinitionVersionStore(handle, { newId }).persist(batch),
      (error) => {
        assert.equal(error.code, 'VALIDATION_ERROR', `${label} must refuse with the framework's own error`);
        assert.match(error.message, pattern, label);
        // The M2B requirement, pinned rather than assumed: whatever went wrong,
        // the driver never speaks to the caller.
        assert.doesNotMatch(
          error.message, /SQLITE|PRIMARY KEY|UNIQUE|constraint failed|prepare|datatype mismatch/i,
          `${label} must not leak a raw driver message`,
        );
        return true;
      },
    );
  };

  refuses(() => null, [entry()], /newId must return a non-empty string/, 'a generator returning null');
  refuses(() => 42, [entry()], /newId must return a non-empty string/, 'a generator returning a number');
  refuses(() => '', [entry()], /newId must return a non-empty string/, 'a generator returning an empty string');
  refuses(() => '   ', [entry()], /newId must return a non-empty string/, 'a generator returning whitespace');
  refuses(() => undefined, [entry()], /newId must return a non-empty string/, 'a generator returning undefined');

  // A constant generator collides with itself. Without this check the second
  // insert would hit the PRIMARY KEY and the caller would read SQLite's words.
  refuses(
    () => 'the-same-id-every-time',
    [entry({ name: 'alpha' }), entry({ name: 'beta' })],
    /issued the same id twice/,
    'a generator that repeats an id inside one batch',
  );

  assert.deepEqual(opened, [], 'every one of these was refused before BEGIN IMMEDIATE');
  assert.equal(rows(database).length, 0, 'and none of them persisted anything');
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


// ---------------------------------------------------------------------------
// Injected-input surface sweep
//
// Six review findings in a row were the same shape: the store trusts something
// it should validate. Rather than answer one more at a time, this block walks
// the whole surface and asks of each value the store accepts or produces: what
// does a hostile or broken caller do with it, and does the store answer in its
// own words or the driver's?
// ---------------------------------------------------------------------------

/** Refuse with the framework's own error, and never in the driver's words. */
function refusesCleanly(fn, pattern, label) {
  assert.throws(fn, (error) => {
    assert.equal(error.code, 'VALIDATION_ERROR', label + ' must carry the framework error code');
    assert.match(error.message, pattern, label);
    assert.doesNotMatch(
      error.message, /SQLITE|PRIMARY KEY|UNIQUE|constraint failed|prepare|datatype mismatch|not iterable/i,
      label + ' must not leak a driver or engine message',
    );
    return true;
  });
}

test("sweep: an id that already exists is refused in the store's own words, not the driver's", (t) => {
  const database = memory(t);
  // The same id handed out on two separate calls: the batch-level check cannot
  // see it, because `seen` starts empty on every call.
  const store = createDefinitionVersionStore(database, { newId: () => 'a-fixed-id' });
  store.persist([entry({ name: 'first' })]);
  assert.equal(rows(database).length, 1);

  refusesCleanly(
    () => store.persist([entry({ name: 'second' })]),
    /an id that is already registered/,
    'a generator repeating an id across calls',
  );
  assert.equal(rows(database).length, 1, 'and the colliding row was not written');
});

test('sweep: entries must be iterable, and a runaway batch is refused rather than attempted', (t) => {
  const database = memory(t);
  const store = createDefinitionVersionStore(database);
  for (const notIterable of [null, undefined, 42, {}, true]) {
    refusesCleanly(() => store.persist(notIterable), /must be iterable/, 'persist(' + String(notIterable) + ')');
  }
  // An accidental runaway generator becomes a framework refusal rather than an
  // out-of-memory crash.
  const runaway = (function* () { for (let i = 0; ; i += 1) yield entry({ name: 'n-' + i }); })();
  refusesCleanly(() => store.persist(runaway), /Too many definition versions/, 'a runaway generator');
  assert.equal(rows(database).length, 0);
});

test('sweep: identity strings are bounded and free of control characters', (t) => {
  const database = memory(t);
  const store = createDefinitionVersionStore(database);
  const huge = 'x'.repeat(5000);
  const NUL = String.fromCharCode(0);
  for (const field of ['type', 'name', 'fingerprint']) {
    refusesCleanly(() => store.persist([entry({ [field]: huge })]), /is too long/, 'an over-long ' + field);
    refusesCleanly(
      () => store.persist([entry({ [field]: 'bad\nvalue' })]),
      /control character/,
      field + ' carrying a newline',
    );
    refusesCleanly(
      () => store.persist([entry({ [field]: 'bad' + NUL + 'value' })]),
      /control character/,
      field + ' carrying a NUL',
    );
  }
  assert.equal(rows(database).length, 0);
});

test('sweep: version must round-trip, not merely be a non-negative integer', (t) => {
  const database = memory(t);
  const store = createDefinitionVersionStore(database);
  // Past MAX_SAFE_INTEGER a version cannot survive a round trip through JS, so
  // two different versions can read back as the same one.
  refusesCleanly(
    () => store.persist([entry({ version: Number.MAX_SAFE_INTEGER + 2 })]),
    /must be a non-negative integer/,
    'a version past the safe-integer range',
  );
  assert.equal(rows(database).length, 0);
});

test('sweep: a clock that misbehaves is refused before the transaction opens', (t) => {
  const database = memory(t);
  const opened = [];
  const sync = database.storage.sync;
  const handle = {
    storage: { sync: { ...sync, transaction(fn) { opened.push('t'); return sync.transaction(fn); } } },
  };
  // `resolveClock` already validates what the clock returns on every call; what
  // this pins is that the refusal lands before BEGIN IMMEDIATE, like the rest.
  assert.throws(
    () => createDefinitionVersionStore(handle, { clock: () => '2026-13-45T99:99:99Z' }).persist([entry()]),
    /canonical UTC ISO instant/,
  );
  assert.deepEqual(opened, [], 'a bad clock never reached BEGIN IMMEDIATE');
  assert.equal(rows(database).length, 0);
});

test('sweep: a repeated identity across two batches never reaches the UNIQUE constraint', (t) => {
  const database = memory(t);
  const store = createDefinitionVersionStore(database);
  store.persist([entry()]);
  // Same identity, same fingerprint, fresh call: this must verify, never insert
  // a second row and never surface the table UNIQUE(type, name, version).
  assert.doesNotThrow(() => store.persist([entry()]));
  assert.equal(rows(database).length, 1);
});
