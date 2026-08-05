import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IntelligenceRegistries,
  computeDefinitionFingerprint,
  rankRoutingTargets,
  validateEnrichmentProvider,
  validateScoringModel,
  validateRoutingPolicy,
  validateRoutingTarget,
} from '../packages/core/src/intelligence-registry.js';
import { createDatabase } from '../packages/core/src/database.js';
import { runRecordAction } from '../packages/core/src/action-runtime.js';
import { validateActionDefinition } from '../packages/core/src/action-registry.js';
import { EventBus } from '../packages/core/src/event-bus.js';
import { AppError, NotFoundError } from '../packages/core/src/errors.js';

function provider(overrides = {}) {
  return {
    name: 'fixture',
    version: 1,
    label: 'Fixture',
    capabilities: ['company'],
    async enrichCompany() { return { fields: {} }; },
    ...overrides,
  };
}

function model(overrides = {}) {
  return {
    name: 'score',
    version: 1,
    label: 'Score',
    rules: [
      { key: 'rule-a', label: 'Rule A', weight: 10, evaluate: () => true },
      { key: 'rule-b', label: 'Rule B', weight: -5, evaluate: () => false },
    ],
    ...overrides,
  };
}

function policy(overrides = {}) {
  return { name: 'routing', version: 1, label: 'Routing', route: () => null, ...overrides };
}

function target(overrides = {}) {
  return { key: 'team-a', label: 'Team A', kind: 'team', active: true, countries: ['IT'], languages: ['it'], skills: [], capacity: 5, priority: 1, ...overrides };
}

test('well-formed intelligence definitions validate', () => {
  assert.doesNotThrow(() => validateEnrichmentProvider(provider()));
  assert.doesNotThrow(() => validateScoringModel(model()));
  assert.doesNotThrow(() => validateRoutingPolicy(policy()));
  assert.doesNotThrow(() => validateRoutingTarget(target()));
});

test('malformed intelligence definitions fail closed with precise reasons', () => {
  const cases = [
    [() => validateEnrichmentProvider(provider({ name: '__proto__' })), /name must match/],
    [() => validateEnrichmentProvider(provider({ name: 'Bad Name' })), /name must match/],
    [() => validateEnrichmentProvider(provider({ version: 0 })), /version must be a positive integer/],
    [() => validateEnrichmentProvider(provider({ version: 1.5 })), /version must be a positive integer/],
    [() => validateEnrichmentProvider(provider({ version: '1' })), /version must be a positive integer/],
    [() => validateEnrichmentProvider(provider({ capabilities: [] })), /capabilities/],
    [() => validateEnrichmentProvider(provider({ capabilities: ['company', 'company'] })), /capabilities/],
    [() => validateEnrichmentProvider(provider({ capabilities: ['person'] })), /capabilities/],
    [() => validateEnrichmentProvider(provider({ enrichCompany: undefined })), /requires an enrichCompany function/],
    [() => validateEnrichmentProvider(provider({ label: 'x'.repeat(81) })), /at most 80/],
    [() => validateScoringModel(model({ rules: [] })), /non-empty array/],
    [() => validateScoringModel(model({ rules: [{ key: '<script>', weight: 1, evaluate: () => true }] })), /rule key must match/],
    [() => validateScoringModel(model({ rules: [{ key: 'a', weight: 1, evaluate: () => true }, { key: 'a', weight: 2, evaluate: () => true }] })), /duplicate rule key/],
    [() => validateScoringModel(model({ rules: [{ key: 'a', weight: 0, evaluate: () => true }] })), /non-zero integer/],
    [() => validateScoringModel(model({ rules: [{ key: 'a', weight: 1.5, evaluate: () => true }] })), /non-zero integer/],
    [() => validateScoringModel(model({ rules: [{ key: 'a', weight: 1 }] })), /evaluate must be a function/],
    [() => validateScoringModel(model({ minScore: 10, maxScore: 10 })), /minScore must be below maxScore/],
    [() => validateScoringModel(model({ minScore: 1.5 })), /minScore must be an integer/],
    [() => validateRoutingPolicy(policy({ route: 'not-a-function' })), /route must be a function/],
    [() => validateRoutingPolicy(policy({ name: 'constructor'.toUpperCase() })), /name must match/],
    [() => validateRoutingTarget(target({ kind: 'robot' })), /kind must be one of/],
    [() => validateRoutingTarget(target({ active: 'yes' })), /active must be a boolean/],
    [() => validateRoutingTarget(target({ countries: ['Italia'] })), /countries must be an array of codes/],
    [() => validateRoutingTarget(target({ languages: ['IT'] })), /languages must be an array of codes/],
    [() => validateRoutingTarget(target({ capacity: -1 })), /capacity must be a non-negative integer or null/],
    [() => validateRoutingTarget(target({ scoreMin: 10, scoreMax: 5 })), /scoreMin must not exceed scoreMax/],
    [() => validateRoutingTarget(target({ key: '__proto__' })), /key must match/],
  ];
  for (const [fn, pattern] of cases) assert.throws(fn, pattern);
});

test('registries: duplicate identities, one fallback, prototype-safe lookups', () => {
  assert.throws(
    () => new IntelligenceRegistries({ enrichmentProviders: [provider(), provider()] }),
    /Duplicate enrichment provider/,
  );
  assert.throws(
    () => new IntelligenceRegistries({ scoringModels: [model(), model()] }),
    /Duplicate scoring model identity/,
  );
  assert.doesNotThrow(() => new IntelligenceRegistries({ scoringModels: [model(), model({ version: 2 })] }));
  assert.throws(
    () => new IntelligenceRegistries({ routingTargets: [target({ key: 'f1', kind: 'fallback' }), target({ key: 'f2', kind: 'fallback' })] }),
    /At most one routing target/,
  );
  const registries = new IntelligenceRegistries({
    enrichmentProviders: [provider()],
    scoringModels: [model()],
    routingPolicies: [policy()],
    routingTargets: [target()],
  });
  for (const hostile of ['__proto__', 'constructor', 'prototype']) {
    assert.throws(() => registries.getProvider(hostile), (e) => e.code === 'NOT_FOUND');
    assert.throws(() => registries.getScoringModel(hostile, 1), (e) => e.code === 'NOT_FOUND');
    assert.throws(() => registries.getRoutingPolicy(hostile, 1), (e) => e.code === 'NOT_FOUND');
  }
  assert.throws(() => registries.getScoringModel('score', 99), (e) => e.code === 'NOT_FOUND');
});

test('canonicalization is strict: unsupported values fail loudly, never silently disappear', () => {
  const good = { a: [1, 'x', true, null], b: { c: () => 1 } };
  assert.equal(computeDefinitionFingerprint(good), computeDefinitionFingerprint({ b: { c: good.b.c }, a: [1, 'x', true, null] }));
  const cases = [
    [{ when: new Date(0) }, /non-plain object/],
    [{ set: new Set([1]) }, /non-plain object/],
    [{ map: new Map() }, /non-plain object/],
    [{ re: /x/ }, /non-plain object/],
    [{ big: 10n }, /type bigint/],
    [{ sym: Symbol('x') }, /type symbol/],
    [{ nan: Number.NaN }, /non-finite number/],
    [{ inf: Infinity }, /non-finite number/],
    [{ missing: undefined }, /type undefined/],
    [new (class Thing {})(), /non-plain object/],
  ];
  for (const [value, pattern] of cases) {
    assert.throws(() => computeDefinitionFingerprint(value), pattern, JSON.stringify(String(pattern)));
  }
  const cyclic = { name: 'x' };
  cyclic.self = cyclic;
  assert.throws(() => computeDefinitionFingerprint(cyclic), /cyclic structure/);
  // CRLF in function source normalizes to LF.
  // eslint-disable-next-line no-new-func
  const crlfFn = new Function('return 1;\r\nreturn 2;');
  const lfFn = new Function('return 1;\nreturn 2;');
  assert.equal(computeDefinitionFingerprint(crlfFn), computeDefinitionFingerprint(lfFn));
});

test('the fingerprint is a DECLARED-definition fingerprint: closures escape it, declared config does not', () => {
  // The documented limitation: a rule closing over a mutable outer variable is
  // NOT captured — toString serializes the identifier, not the value.
  const makeClosureModel = (threshold) => ({
    name: 'closure',
    version: 1,
    rules: [{ key: 'r', label: 'R', weight: 1, evaluate: (ctx) => ctx.lead.score >= threshold }],
  });
  const at100 = new IntelligenceRegistries({ scoringModels: [makeClosureModel(100)] }).getScoringModel('closure', 1).fingerprint;
  const at200 = new IntelligenceRegistries({ scoringModels: [makeClosureModel(200)] }).getScoringModel('closure', 1).fingerprint;
  assert.equal(at100, at200, 'closure values are invisible — this is WHY thresholds must live in declared config');

  // The sanctioned contract: the same threshold declared as config IS captured.
  const makeConfigModel = (threshold) => ({
    name: 'declared',
    version: 1,
    config: { threshold },
    rules: [{ key: 'r', label: 'R', weight: 1, evaluate: (ctx) => ctx.lead.score >= ctx.config.threshold }],
  });
  const c100 = new IntelligenceRegistries({ scoringModels: [makeConfigModel(100)] }).getScoringModel('declared', 1).fingerprint;
  const c200 = new IntelligenceRegistries({ scoringModels: [makeConfigModel(200)] }).getScoringModel('declared', 1).fingerprint;
  assert.notEqual(c100, c200, 'declared config changes the fingerprint');

  // Config must be plain JSON-safe data.
  assert.throws(
    () => new IntelligenceRegistries({ scoringModels: [{ ...makeConfigModel(1), config: { when: new Date(0) } }] }),
    /config must be plain JSON-safe data/,
  );
  assert.throws(
    () => new IntelligenceRegistries({ routingPolicies: [{ name: 'p', version: 1, route: () => null, config: [1] }] }),
    /config must be a plain object/,
  );
});

test('fingerprints are deterministic from source and change with behavior', () => {
  const a = new IntelligenceRegistries({ scoringModels: [model()] }).getScoringModel('score', 1).fingerprint;
  // Same definition with different property order → same fingerprint.
  const reordered = { rules: model().rules, label: 'Score', version: 1, name: 'score' };
  const b = new IntelligenceRegistries({ scoringModels: [reordered] }).getScoringModel('score', 1).fingerprint;
  assert.equal(a, b, 'property order does not change identity');
  // Changed weight → different fingerprint.
  const heavier = model({ rules: [{ key: 'rule-a', label: 'Rule A', weight: 20, evaluate: () => true }] });
  const c = new IntelligenceRegistries({ scoringModels: [heavier] }).getScoringModel('score', 1).fingerprint;
  assert.notEqual(a, c, 'weight change changes the fingerprint');
  // Changed evaluate body → different fingerprint.
  const rewired = model({ rules: [{ key: 'rule-a', label: 'Rule A', weight: 10, evaluate: (ctx) => ctx.lead != null }, model().rules[1]] });
  const d = new IntelligenceRegistries({ scoringModels: [rewired] }).getScoringModel('score', 1).fingerprint;
  assert.notEqual(a, d, 'rule body change changes the fingerprint');
  assert.equal(computeDefinitionFingerprint(['x', 'y']), computeDefinitionFingerprint(['x', 'y']));
});

test('persisted definition versions: registration is idempotent, drift fails loudly', (t) => {
  const database = createDatabase({ path: ':memory:' });
  t.after(() => database.close());
  const registries = new IntelligenceRegistries({ scoringModels: [model()], routingPolicies: [policy()] });
  registries.persistFingerprints(database);
  // Same source re-registering is a no-op.
  assert.doesNotThrow(() => registries.persistFingerprints(database));
  const rows = database.raw.prepare('SELECT type, name, version FROM definition_versions ORDER BY type').all();
  assert.deepEqual(
    rows.map((row) => `${row.type}:${row.name}@${row.version}`),
    ['routing-policy:routing@1', 'scoring-model:score@1'],
  );
  // The SAME version with changed source must fail loudly.
  const drifted = new IntelligenceRegistries({
    scoringModels: [model({ rules: [{ key: 'rule-a', label: 'Rule A', weight: 99, evaluate: () => true }] })],
  });
  assert.throws(() => drifted.persistFingerprints(database), /source changed after registration|immutable/);
  // A NEW version derived from an earlier definition (rollback) registers fine.
  const rollback = new IntelligenceRegistries({ scoringModels: [model(), model({ version: 3 })] });
  assert.doesNotThrow(() => rollback.persistFingerprints(database));
  // Enrichment providers get the same persisted protection.
  const withProvider = new IntelligenceRegistries({ enrichmentProviders: [provider()] });
  withProvider.persistFingerprints(database);
  const providerRow = database.raw
    .prepare("SELECT fingerprint FROM definition_versions WHERE type = 'enrichment-provider' AND name = 'fixture' AND version = 1")
    .get();
  assert.ok(providerRow, 'provider fingerprint persisted');
  const driftedProvider = new IntelligenceRegistries({
    enrichmentProviders: [provider({ async enrichCompany() { return { fields: { country: 'IT' } }; } })],
  });
  assert.throws(() => driftedProvider.persistFingerprints(database), /source changed after registration/);
});

test('concurrent registration across two connections serializes: one insert, the other verifies', (t) => {
  const dbPath = `/tmp/claude-0/-home-user-agent-crm/dcabf585-5724-5af3-9508-8c01ce9770f6/scratchpad/reg-race-${process.pid}.sqlite`;
  const a = createDatabase({ path: dbPath, busyTimeoutMs: 500 });
  const b = createDatabase({ path: dbPath, busyTimeoutMs: 500 });
  t.after(() => { a.close(); b.close(); });
  const first = new IntelligenceRegistries({ scoringModels: [model()] });
  const second = new IntelligenceRegistries({ scoringModels: [model()] });
  // Registration is one BEGIN IMMEDIATE transaction per boot: the two
  // connections serialize on the write lock instead of racing to a raw UNIQUE
  // violation — the later one re-reads the committed row and verifies.
  first.persistFingerprints(a);
  assert.doesNotThrow(() => second.persistFingerprints(b));
  const rows = a.raw.prepare("SELECT COUNT(*) AS n FROM definition_versions WHERE type = 'scoring-model'").get();
  assert.equal(Number(rows.n), 1, 'exactly one persisted row for the identity');
});

test('rankRoutingTargets is deterministic: priority desc, load asc, key asc', () => {
  const ranked = rankRoutingTargets([
    { key: 'c', priority: 1, currentLoad: 0 },
    { key: 'b', priority: 2, currentLoad: 3 },
    { key: 'a', priority: 2, currentLoad: 3 },
    { key: 'd', priority: 2, currentLoad: 1 },
  ]);
  assert.deepEqual(ranked.map((t) => t.key), ['d', 'a', 'b', 'c']);
});

test('registry metadata is serializable, sorted and function-free', () => {
  const registries = new IntelligenceRegistries({
    enrichmentProviders: [provider()],
    scoringModels: [model({ version: 2 }), model()],
    routingPolicies: [policy()],
    routingTargets: [target({ key: 'z-team' }), target({ key: 'a-team' })],
  });
  const meta = registries.metadata();
  assert.deepEqual(meta.scoringModels.map((m) => m.version), [1, 2], 'versions sorted');
  assert.deepEqual(meta.routingTargets.map((t) => t.key), ['a-team', 'z-team'], 'targets sorted');
  assert.equal(meta.scoringModels[0].rules.length, 2, 'rule metadata included');
  const json = JSON.parse(JSON.stringify(meta));
  assert.deepEqual(json, meta, 'round-trips through JSON');
  const walk = (value) => {
    if (typeof value === 'function') assert.fail('metadata contains a function');
    if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(meta);
  assert.ok(meta.scoringModels[0].fingerprint.match(/^[0-9a-f]{64}$/), 'fingerprint exposed as hex');
});

test('action prepare phase: runs before the transaction, feeds execute, fails honestly', async (t) => {
  const database = createDatabase({ path: ':memory:' });
  t.after(() => database.close());
  const events = new EventBus();
  const order = [];
  const record = { id: 'r1', status: 'new' };
  const service = {
    get: (id) => {
      if (id !== 'r1') throw new NotFoundError('Thing', id);
      order.push('service.get');
      return { ...record };
    },
    applyManaged: async () => ({ ...record }),
  };
  const modules = { get: () => ({ service }) };
  const base = {
    module: 'thing',
    name: 'act',
    actionContract: 1,
    execute: ({ prepared }) => { order.push('execute'); return { prepared }; },
  };

  // prepare validates as an optional function on the action contract.
  assert.doesNotThrow(() => validateActionDefinition({ ...base, prepare: async () => 1 }, { moduleExists: () => true }));
  assert.throws(
    () => validateActionDefinition({ ...base, prepare: 'not-a-function' }, { moduleExists: () => true }),
    /prepare must be a function/,
  );

  const run = (definition, recordId = 'r1') =>
    runRecordAction({
      database,
      events,
      services: {},
      registry: { get: () => definition },
      modules,
      module: 'thing',
      action: 'act',
      recordId,
      input: {},
      actor: { type: 'user', id: 't' },
    });

  // The prepared value reaches execute, and prepare runs before the transaction.
  order.length = 0;
  const okDefinition = {
    ...base,
    prepare: async ({ record: preview, step }) => {
      order.push('prepare');
      assert.equal(preview.id, 'r1');
      step('prepare.side-effect', { called: true });
      return { fromPrepare: 42 };
    },
  };
  const result = await run(okDefinition);
  assert.deepEqual(result.result, { prepared: { fromPrepare: 42 } });
  assert.deepEqual(order.slice(0, 2), ['service.get', 'prepare'], 'prepare precedes the transactional re-read');
  assert.equal(order.filter((step) => step === 'execute').length, 1);

  // A prepare failure fails the action; execute never runs; the trace is honest.
  order.length = 0;
  await assert.rejects(
    () => run({ ...base, prepare: async () => { throw new AppError('provider down', { code: 'PROVIDER_FAILED', status: 502 }); } }),
    (error) => error.code === 'PROVIDER_FAILED',
  );
  assert.ok(!order.includes('execute'), 'execute never ran after a prepare failure');
  const failed = database.raw.prepare("SELECT status FROM workflow_runs WHERE workflow_name = 'thing.act' AND status = 'failed'").all();
  assert.ok(failed.length >= 1, 'a failed trace run was written');

  // A missing record 404s before prepare runs (no provider call for ghosts).
  let prepared = false;
  await assert.rejects(
    () => run({ ...base, prepare: async () => { prepared = true; } }, 'ghost'),
    (error) => error.status === 404,
  );
  assert.equal(prepared, false, 'prepare was not invoked for a missing record');

  // Capability attack: the prepare ctx must be genuinely read-oriented. Every
  // write path is absent from the modules view, and there is no `managed`.
  await run({
    ...base,
    prepare: async (ctx) => {
      assert.equal(ctx.managed, undefined, 'no managed in prepare');
      assert.equal(ctx.database, undefined, 'no database handle in prepare');
      assert.equal(ctx.services, undefined, 'no core services in prepare');
      const view = ctx.modules.get('thing');
      assert.equal(typeof view.service.get, 'function', 'read method available');
      for (const method of ['create', 'update', 'createManaged', 'applyManaged']) {
        assert.equal(view.service[method], undefined, `${method} unreachable through prepare`);
      }
      assert.ok(Object.isFrozen(view.service), 'the view cannot be extended');
      return { ok: true };
    },
  });

  // The prepared value is normalized to plain data and deep-frozen; functions,
  // non-plain objects and cycles are rejected; dangerous keys are dropped.
  const frozenResult = await run({
    ...base,
    prepare: async () => JSON.parse('{"nested": {"__proto__": {"polluted": 1}, "keep": [1, 2]}}'),
    execute: ({ prepared: value }) => {
      assert.ok(Object.isFrozen(value) && Object.isFrozen(value.nested) && Object.isFrozen(value.nested.keep), 'deep-frozen');
      assert.equal(Object.hasOwn(value.nested, '__proto__'), false, 'dangerous key dropped');
      assert.equal(/** @type {any} */ ({}).polluted, undefined, 'no prototype pollution');
      return { saw: value.nested.keep.length };
    },
  });
  assert.equal(frozenResult.result.saw, 2);
  for (const [bad, pattern] of [
    [() => ({ fn: () => 1 }), /plain JSON-safe data/],
    [() => ({ when: new Date(0) }), /plain JSON-safe data/],
    [() => { const c = {}; c.self = c; return c; }, /cyclic structure/],
    [() => ({ nan: Number.NaN }), /non-finite number/],
  ]) {
    await assert.rejects(
      () => run({ ...base, prepare: async () => bad() }),
      (error) => pattern.test(error.message),
      String(pattern),
    );
  }
});
