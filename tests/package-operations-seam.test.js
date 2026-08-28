import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PackageRegistry, definePackage } from '../packages/core/index.js';
import { resolvePackageComposition } from '../packages/core/src/package-composition.js';
import { createOperationRuntime, composePackageOperations } from '../packages/core/src/operation-runtime.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * The ADR-032 operations seam, attacked at its fail-closed edges.
 *
 * The seam's happy path is proven every time a composed application calls
 * `syncCatalog` or `ingestSignatureEvent`; what nothing else exercises is the
 * validation surface that KEEPS it a seam — the refusals that stop a malformed
 * declaration, a collision between two packages over one application method,
 * a factory that returns garbage, or an alias that would shadow the kernel's
 * own surface. Those refusals are composition-integrity boundaries: lose one
 * silently and two packages fight over a single `app.<method>` key the way two
 * packages would fight over one table.
 */

/** A minimal valid declared operation; override fields per case. */
const op = (over = {}) => ({
  operationContract: 1, name: 'probe-op', label: 'Probe', description: 'probe',
  input: [], create: () => () => {}, ...over,
});
/** A minimal valid package definition; override fields per case. */
const base = (over = {}) => ({
  packageContract: 1, name: 'probe-pack', version: 1, label: 'Probe pack',
  description: 'probe', resources: ['probe-record'], ...over,
});

test('a declared operation is validated fail-closed at registration', () => {
  const refuse = (operations, pattern) => assert.throws(
    () => new PackageRegistry({ packages: [definePackage(base({ operations }))] }),
    (error) => error.name === 'ValidationError' && pattern.test(error.message),
    `expected refusal matching ${pattern}`,
  );

  assert.doesNotThrow(() => new PackageRegistry({
    packages: [definePackage(base({ packageContract: 2, operations: [op({ operationContract: 2 })] }))],
  }));
  refuse([op({ operationContract: 3 })], /operationContract must be one of 1, 2/);
  refuse([op({ name: 'Not A Name!' })], /operation name must match/);
  refuse([op({ appMethod: 'not-camel' })], /appMethod must match/);
  refuse([op(), op()], /duplicate operation "probe-op"/);
  refuse([op({ appMethod: 'doIt' }), op({ name: 'other-op', appMethod: 'doIt' })],
    /duplicate operation appMethod "doIt"/);
  refuse([{ operationContract: 1, name: 'probe-op', label: 'P', description: 'd', input: [] }],
    /must declare create\(\)/);
  refuse([op({ input: [{ name: 'blob', type: 'buffer' }] })], /type must be one of/);
  refuse([op({ input: [{ name: 'Not Valid', type: 'string' }] })], /inputs need camelCase names/);

  // `operations` is registry-published from the composition — a metadata()
  // block may not counterfeit it.
  assert.throws(
    () => new PackageRegistry({ packages: [definePackage(base({ metadata: () => ({ operations: [] }) }))] }).metadata(),
    (error) => error.code === 'DOMAIN_METADATA_INVALID' && /may not redeclare "operations"/.test(error.message),
  );
});

test('two packages cannot claim one application method', () => {
  const a = definePackage(base({ name: 'pack-a', resources: ['record-a'], operations: [op({ name: 'a-op', appMethod: 'clash' })] }));
  const b = definePackage(base({ name: 'pack-b', resources: ['record-b'], operations: [op({ name: 'b-op', appMethod: 'clash' })] }));

  // The inspector's view collects the collision …
  const { problems } = resolvePackageComposition([a, b]);
  assert.deepEqual(problems.map((p) => p.code), ['OPERATION_ALIAS_COLLISION']);
  assert.match(problems[0].message, /"clash" is declared by packages "pack-a" and "pack-b"/);

  // … and the registry's boot refuses with the same first problem.
  assert.throws(() => new PackageRegistry({ packages: [a, b] }),
    (error) => /Operation alias collision/.test(error.message));
});

test('composition calls each create() exactly once and refuses a factory that returns no function', () => {
  let calls = 0;
  const good = definePackage(base({
    name: 'pack-good',
    operations: [
      op({ name: 'aliased-op', appMethod: 'aliasedOp', create: (runtime) => { calls += 1; return () => runtime; } }),
      // An operation without an appMethod is composed but adds no alias.
      op({ name: 'internal-op', create: () => () => {} }),
    ],
  }));
  const runtime = createOperationRuntime({ database: {}, modules: {}, events: {} });
  const { aliases } = composePackageOperations({ registry: new PackageRegistry({ packages: [good] }), runtime });
  assert.equal(calls, 1, 'create() runs once per operation, at composition');
  assert.deepEqual(aliases.map((a) => ({ appMethod: a.appMethod, package: a.package, name: a.name })),
    [{ appMethod: 'aliasedOp', package: 'pack-good', name: 'aliased-op' }]);
  assert.equal(aliases[0].fn(), runtime, 'the composed function is the factory product');

  const bad = definePackage(base({ name: 'pack-bad', operations: [op({ name: 'bad-op', appMethod: 'badOp', create: () => 42 })] }));
  assert.throws(
    () => composePackageOperations({ registry: new PackageRegistry({ packages: [bad] }), runtime }),
    (error) => /operation "bad-op": create\(\) must return the operation function/.test(error.message),
    'a startup defect, surfaced before anything is served',
  );
});

test('the bounded operation context is frozen, and its key set is CLOSED', () => {
  const config = { probeTimeoutMs: 5 };
  const runtime = createOperationRuntime({ database: { d: 1 }, modules: { m: 1 }, events: { e: 1 }, config });

  // Exactly the applicationOperations contract — the keys real consumers use
  // and nothing else (the ADR-032 implementation addendum in DECISIONS.md
  // records the audit). Still closed on purpose: an operation receives only
  // documented capabilities, any additional field is non-contractual, and no
  // action registry, workflow engine, provider registry, package registry,
  // capability resolver — or unused extension point such as a trace writer —
  // reaches an operation through it.
  //
  // `core` joined the set under ADR-037, and it is the shape of that addition
  // that keeps the contract honest: it is not a new power, it is the ADR-013
  // adapter a record action already receives as `ctx.core`, given to
  // application operations because a real consumer needed an exact indexed
  // read of a core record and the alternatives were a 500-capped scan or raw
  // SQL from a package. A key is added when a consumer proves it necessary,
  // never in advance.
  assert.deepEqual(Object.keys(runtime).sort(), ['config', 'core', 'database', 'events', 'modules', 'runExternal']);
  assert.equal(typeof runtime.runExternal, 'function');
  assert.equal('trace' in runtime, false, 'the deferred trace extension point is not shipped in v1');
  // Absent adapters are an empty frozen object, never undefined: an operation
  // that probes for `core` gets a shape, not a crash.
  assert.equal(Object.isFrozen(createOperationRuntime({ database: {}, modules: {}, events: {} }).core), true);
  assert.equal(Object.isFrozen(runtime), true);
  assert.equal(Object.isFrozen(runtime.config), true);

  // The config slice is a copy — mutating the source after composition leaks
  // nothing into the already-handed context.
  config.injected = true;
  assert.equal('injected' in runtime.config, false);

  assert.throws(() => createOperationRuntime({ database: {}, modules: {} }),
    (error) => /operation runtime needs database, modules and events/.test(error.message));
});

test('a declared alias attaches generically, and a shadowing alias stops startup', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'accordo-seam-attach-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const entry of ['packages', 'package.json']) {
    cpSync(join(repoRoot, entry), join(root, entry), { recursive: true });
  }
  writeFileSync(join(root, 'packages/actions/generated/index.js'), 'export const generatedActions = [];\n');

  const compose = (appMethod) => writeFileSync(join(root, 'packages/domains/generated/index.js'), [
    "import { definePackage } from '../../core/index.js';",
    'export const generatedDomains = [definePackage({',
    "  packageContract: 1, name: 'probe-pack', version: 1, label: 'Probe pack', description: 'probe',",
    "  resources: ['probe-record'],",
    `  operations: [{ operationContract: 1, name: 'probe-op', appMethod: ${JSON.stringify(appMethod)},`,
    "    label: 'Probe', description: 'probe', input: [],",
    '    create: (runtime) => (params) => ({ echoed: params.value, boundedConfig: Object.isFrozen(runtime.config) }) }],',
    '})];',
    '',
  ].join('\n'));

  const boot = (body) => {
    const script = join(root, 'seam-boot.mjs');
    writeFileSync(script, [
      "import { createAccordoApp } from './packages/app/src/index.js';",
      `const app = createAccordoApp({ dbPath: ${JSON.stringify(join(root, 'seam.sqlite'))} });`,
      'const out = {};',
      'try {', body, '} finally { app.close(); }',
      'console.log("__RESULT__" + JSON.stringify(out));',
      '',
    ].join('\n'));
    return spawnSync(process.execPath, ['--no-warnings', script], { encoding: 'utf8', cwd: root });
  };

  // Attached generically: the method exists, runs against the bounded
  // context, and the registry publishes the declaration function-free.
  compose('probeEcho');
  const attached = boot(`
    out.result = await app.probeEcho({ value: 7 });
    out.published = app.domains.get('probe-pack').operations;
    out.metadata = app.domains.metadata()['probe-pack'].operations;
  `);
  const line = (attached.stdout || '').split('\n').find((l) => l.startsWith('__RESULT__'));
  assert.ok(line, `boot failed:\n${attached.stderr}`);
  const seen = JSON.parse(line.slice('__RESULT__'.length));
  assert.deepEqual(seen.result, { echoed: 7, boundedConfig: true });
  assert.deepEqual(seen.published, [{ name: 'probe-op', operationContract: 1, appMethod: 'probeEcho' }]);
  assert.deepEqual(seen.metadata, [{ name: 'probe-op', operationContract: 1, label: 'Probe', appMethod: 'probeEcho' }]);

  // An alias may add application surface, never replace it: a collision with
  // an existing key — the kernel's own surface first of all — stops startup.
  compose('runAction');
  const shadowed = boot('out.reached = true;');
  assert.notEqual(shadowed.status, 0, 'a shadowing composition must not boot');
  assert.match(shadowed.stderr, /appMethod "runAction" would shadow an existing application key/);

  // `in` walks the prototype chain on purpose: `toString` is just as taken.
  compose('toString');
  const proto = boot('out.reached = true;');
  assert.notEqual(proto.status, 0);
  assert.match(proto.stderr, /appMethod "toString" would shadow an existing application key/);
});
