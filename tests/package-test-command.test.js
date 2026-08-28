import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageTestCommand } from '../packages/cli/src/package-test-command.js';
import {
  AUTHORITIES, runCompositionChecks, runDeclarationChecks,
} from '../packages/cli/src/package-test-checks.js';
import { importSpecifiers, importsPrivateKernelPath, stripComments } from '../packages/cli/src/package-sources.js';
import {
  HANGS, HOSTILE_PACKAGES, SCRATCH_PROBES, SPAWNS_LONG_LIVED_CHILD, WELL_FORMED, consumer,
  fixtureProject, manifestFor, provider, writeFixturePackage,
} from './helpers/package-test-fixtures.js';

/**
 * `crm package test` — DX4.
 *
 * The command answers one question: does a package satisfy the framework's
 * generic package contract and integration invariants? These tests hold it to
 * three standards.
 *
 * **It must be honest.** A check that cannot run reports `skipped` or
 * `not_applicable` with a reason, never `passed`. Nothing here may be made
 * green by demoting a failure to a limitation.
 * **It must be deterministic.** The same package produces byte-identical JSON
 * across runs, processes, working directories and paths containing spaces.
 * **It must be safe.** The caller's project is never written to, the scratch
 * copy is always removed, and no absolute path reaches the report.
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const run = (packagePath, options = {}) =>
  packageTestCommand({ packagePath, rootDir: repoRoot, capture: true, ...options });

/** The three first-party packages, which conform. */
const OFFICIAL = [
  ['packages/contracts', 'contracts'],
  ['packages/delivery', 'delivery'],
  ['packages/service', 'service'],
];

test('composition conformance preserves class package capability declarations in every probe', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'accordo-class-package-checks-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'index.js'), 'export {};\n');

  let contractReads = 0;
  class ClassCapability {
    get name() { return 'class-facts'; }

    get version() { return 1; }

    get capabilityContract() { contractReads += 1; return contractReads === 1 ? 2 : 1; }

    async create() { return { declaration: this }; }
  }
  class ClassPackage {
    #capability = new ClassCapability();

    constructor() {
      this.packageContract = 2;
      this.name = 'class-conformance';
      this.label = 'Class conformance';
      this.version = 1;
    }

    get resources() { return []; }

    get actions() { return []; }

    get capabilities() { return [this.#capability]; }
  }

  const definition = new ClassPackage();
  const declaration = runDeclarationChecks({ definition, dir });
  assert.deepEqual(declaration.published.provides, ['class-facts@1'],
    'the declaration check observes inherited and non-enumerable package/capability fields');

  contractReads = 0;
  const composition = runCompositionChecks({ definition, providers: [] });
  assert.equal(
    composition.checks.find((entry) => entry.id === 'compose.capability-collision-refused').status,
    'passed',
  );
  assert.equal(
    composition.checks.find((entry) => entry.id === 'compose.undeclared-reach-refused').status,
    'passed',
  );
  assert.equal(
    composition.checks.some((entry) => entry.reason === 'NO_CAPABILITIES_OFFERED'),
    false,
    'a class-backed capability never disappears into a not-applicable result',
  );
  assert.equal(contractReads, 1,
    'all conformance checks use the contract snapshot accepted by compose.clean');
});

test('composition conformance reads each accepted graph fact once', async (t) => {
  const cases = [
    {
      field: 'name',
      configure(definition, count) {
        Object.defineProperty(definition, 'name', {
          enumerable: true,
          get() { count(); return count.reads === 1 ? 'stateful-name' : 'drifted-name'; },
        });
      },
    },
    {
      field: 'version',
      configure(definition, count) {
        Object.defineProperty(definition, 'version', {
          enumerable: true,
          get() { count(); return count.reads === 1 ? 1 : 2; },
        });
      },
    },
    {
      field: 'packageContract',
      configure(definition, count) {
        Object.defineProperty(definition, 'packageContract', {
          enumerable: true,
          get() { count(); return count.reads === 1 ? 2 : 1; },
        });
      },
    },
    {
      field: 'requires',
      configure(definition, count) {
        definition.capabilities = [];
        Object.defineProperty(definition, 'requires', {
          enumerable: true,
          get() {
            count();
            return count.reads === 1
              ? [{ package: 'stateful-dependency', capability: 'stateful-facts', version: 1 }]
              : [];
          },
        });
      },
      providers: [{
        packageContract: 2,
        name: 'stateful-dependency',
        version: 1,
        capabilities: [{
          name: 'stateful-facts', version: 1, capabilityContract: 2, create() { return {}; },
        }],
      }],
    },
    {
      field: 'capabilityContract',
      configure(definition, count) {
        Object.defineProperty(definition.capabilities[0], 'capabilityContract', {
          enumerable: true,
          get() { count(); return count.reads === 1 ? 2 : 1; },
        });
      },
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.field, () => {
      const count = () => { count.reads += 1; };
      count.reads = 0;
      const definition = {
        packageContract: 2,
        name: 'stateful-package',
        version: 1,
        label: 'Stateful package',
        resources: [],
        actions: [],
        policies: [],
        operations: [],
        requires: [],
        capabilities: [{
          name: 'stateful-facts', version: 1, capabilityContract: 2, create() { return {}; },
        }],
      };
      scenario.configure(definition, count);

      const composition = runCompositionChecks({
        definition,
        providers: scenario.providers ?? [],
      });
      assert.equal(
        composition.checks.find((entry) => entry.id === 'compose.clean').status,
        'passed',
      );
      assert.deepEqual(
        composition.checks.filter((entry) => entry.status === 'failed'),
        [],
        JSON.stringify(composition.checks),
      );
      assert.equal(count.reads, 1,
        `${scenario.field} is read by the first composition and never by its probes`);
    });
  }
});

test('declaration conformance publishes one accepted graph snapshot without rereading getters', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'accordo-stateful-declaration-checks-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'index.js'), 'export {};\n');

  const reads = { name: 0, version: 0, packageContract: 0, requires: 0, capabilities: 0 };
  let metadataCalls = 0;
  class StatefulDefinition {
    #marker = 'original-receiver';

    label = 'Stateful declaration';

    resources = [];

    actions = [];

    operations = [];

    policies = [{
      kind: 'stateful-policy',
      definition: { name: 'stateful-rule', version: 1, decide() { return true; } },
    }];

    get name() {
      reads.name += 1;
      return reads.name === 1 ? 'stateful-declaration' : 'drifted-declaration';
    }

    get version() {
      reads.version += 1;
      return reads.version === 1 ? 7 : 8;
    }

    get packageContract() {
      reads.packageContract += 1;
      return reads.packageContract === 1 ? 2 : 1;
    }

    get requires() {
      reads.requires += 1;
      return reads.requires === 1
        ? []
        : [{ package: 'ghost-provider', capability: 'ghost-capability', version: 1 }];
    }

    get capabilities() {
      reads.capabilities += 1;
      return reads.capabilities === 1
        ? [{
          name: 'accepted-capability', version: 1, capabilityContract: 2, create() { return {}; },
        }]
        : [{ name: 'ghost-capability', version: 1, create() { return {}; } }];
    }

    metadata() {
      metadataCalls += 1;
      return { marker: this.#marker };
    }
  }

  const report = runDeclarationChecks({ definition: new StatefulDefinition(), dir });
  assert.deepEqual(report.problems, []);
  assert.deepEqual(report.published, {
    resources: [],
    actions: [],
    requires: [],
    provides: ['accepted-capability@1'],
  });
  assert.equal(report.checks.find((entry) => entry.id === 'declaration.contract').status, 'passed');
  assert.match(
    report.checks.find((entry) => entry.id === 'declaration.contract').evidence,
    /declares packageContract 2/,
  );
  assert.equal(report.checks.find((entry) => entry.id === 'declaration.policy-fingerprints').status, 'passed');
  assert.equal(report.metadata.packageContract, 2);
  assert.equal(report.metadata.version, 7);
  assert.deepEqual(report.metadata.requires, []);
  assert.deepEqual(report.metadata.provides, [{
    name: 'accepted-capability', version: 1, capabilityContract: 2,
  }]);
  assert.equal(report.metadata.marker, 'original-receiver');
  assert.equal(metadataCalls, 2, 'the determinism check calls metadata twice with the original receiver');
  assert.deepEqual(reads, {
    name: 1,
    version: 1,
    packageContract: 1,
    requires: 1,
    capabilities: 1,
  }, 'every declaration observer uses the first accepted graph facts');
});

test('package test refuses a malformed action through the package contract, without crashing', async (t) => {
  const root = fixtureProject(t);
  const packagePath = writeFixturePackage(root, 'fixture-bad-action', `// @ts-check
export const fixturePackage = {
  packageContract: 1,
  name: 'fixture-bad-action',
  label: 'Fixture bad action',
  version: 1,
  resources: [],
  actions: [null],
};
`);

  const { exitCode, report } = await packageTestCommand({
    packagePath,
    rootDir: root,
    capture: true,
  });
  assert.equal(exitCode, 1);
  assert.equal(report.checks.find((entry) => entry.id === 'declaration.valid').status, 'failed');
  const problem = report.problems.find((entry) => entry.code === 'PACKAGE_INVALID');
  assert.ok(problem, JSON.stringify(report.problems));
  assert.match(problem.message, /Action definition must be an object/);
  assert.equal(/TypeError|Cannot read properties/.test(JSON.stringify(report)), false,
    'the invalid declaration remains a bounded contract failure');
});

test('package test awaits a v2 capability before calling its resolved interface valid', async (t) => {
  const root = fixtureProject(t);
  writeFixturePackage(root, 'fixture-v2-null-provider', `// @ts-check
let contractReads = 0;
export const fixturePackage = {
  packageContract: 2,
  name: 'fixture-v2-null-provider',
  label: 'Fixture v2 null provider',
  version: 1,
  resources: [],
  capabilities: [{
    name: 'null-interface',
    version: 1,
    get capabilityContract() { contractReads += 1; return contractReads <= 4 ? 2 : 1; },
    create: async () => null,
  }],
};
`);
  const packagePath = writeFixturePackage(root, 'fixture-v2-consumer', `// @ts-check
export const fixturePackage = {
  packageContract: 2,
  name: 'fixture-v2-consumer',
  label: 'Fixture v2 consumer',
  version: 1,
  resources: [],
  requires: [{
    package: 'fixture-v2-null-provider',
    capability: 'null-interface',
    version: 1,
  }],
};
`);

  const { exitCode, report } = await packageTestCommand({
    packagePath,
    rootDir: root,
    capture: true,
  });
  assert.equal(report.checks.find((entry) => entry.id === 'lifecycle.attach').status, 'passed');
  const capability = report.checks.find((entry) => entry.id === 'lifecycle.capabilities-resolve');
  assert.equal(capability.status, 'failed', capability.evidence);
  assert.match(capability.evidence, /did not return an object/);
  assert.equal(exitCode, 1, 'a Promise object is not evidence that its resolved value is an interface');

  writeFixturePackage(root, 'fixture-v2-valid-provider', `// @ts-check
export const fixturePackage = {
  packageContract: 2,
  name: 'fixture-v2-valid-provider',
  label: 'Fixture v2 valid provider',
  version: 1,
  resources: [],
  capabilities: [{
    name: 'valid-interface',
    version: 1,
    capabilityContract: 2,
    create: async () => ({ load: async () => 'ok' }),
  }],
};
`);
  const validPath = writeFixturePackage(root, 'fixture-v2-valid-consumer', `// @ts-check
export const fixturePackage = {
  packageContract: 2,
  name: 'fixture-v2-valid-consumer',
  label: 'Fixture v2 valid consumer',
  version: 1,
  resources: [],
  requires: [{
    package: 'fixture-v2-valid-provider',
    capability: 'valid-interface',
    version: 1,
  }],
};
`);
  const valid = await packageTestCommand({ packagePath: validPath, rootDir: root, capture: true });
  assert.equal(valid.exitCode, 0);
  assert.equal(
    valid.report.checks.find((entry) => entry.id === 'lifecycle.capabilities-resolve').status,
    'passed',
  );

  writeFixturePackage(root, 'fixture-v1-thenable-provider', `// @ts-check
export const fixturePackage = {
  packageContract: 1,
  name: 'fixture-v1-thenable-provider',
  label: 'Fixture v1 thenable provider',
  version: 1,
  resources: [],
  capabilities: [{
    name: 'thenable-interface',
    version: 1,
    capabilityContract: 1,
    create: () => ({
      then() { throw new Error('a v1 interface was incorrectly awaited'); },
      load() { return 'ok'; },
    }),
  }],
};
`);
  const syncPath = writeFixturePackage(root, 'fixture-v1-thenable-consumer', `// @ts-check
export const fixturePackage = {
  packageContract: 1,
  name: 'fixture-v1-thenable-consumer',
  label: 'Fixture v1 thenable consumer',
  version: 1,
  resources: [],
  requires: [{
    package: 'fixture-v1-thenable-provider',
    capability: 'thenable-interface',
    version: 1,
  }],
};
`);
  const sync = await packageTestCommand({ packagePath: syncPath, rootDir: root, capture: true });
  assert.equal(sync.exitCode, 0, 'the v1 capability path remains exactly synchronous');
  assert.equal(
    sync.report.checks.find((entry) => entry.id === 'lifecycle.capabilities-resolve').status,
    'passed',
  );
});

test('every first-party package conforms, and the report says how', async (t) => {
  for (const [path, name] of OFFICIAL) {
    const { exitCode, report } = await run(path);
    assert.equal(report.package.name, name);
    assert.equal(exitCode, 0, `${name}: ${report.checks.filter((c) => c.status === 'failed').map((c) => `${c.id} — ${c.evidence}`).join(' | ')}`);
    assert.equal(report.ok, true);
    assert.equal(report.counts.failed, 0);
    assert.ok(report.counts.passed >= 20, `${name} runs a real battery, not a token one`);

    // The boot actually happened: attach, detach and AX1 agreement all ran.
    for (const id of ['lifecycle.attach', 'lifecycle.detach', 'inspection.valid', 'inspection.package-row']) {
      const row = report.checks.find((entry) => entry.id === id);
      assert.equal(row.status, 'passed', `${name}: ${id} is ${row.status} — ${row.evidence}`);
    }
    // Every skip and every not-applicable states why, and every row names the
    // rule it speaks for. A conformance kit that invents rules is a second,
    // undocumented package contract.
    for (const row of report.checks) {
      if (row.status === 'skipped' || row.status === 'not_applicable') {
        assert.ok(row.reason, `${name}: ${row.id} declined without a reason`);
      }
      assert.ok(AUTHORITIES.includes(row.authority),
        `${name}: ${row.id} claims authority "${row.authority}", which is not one this framework has`);
    }
  }
  assert.ok(t);
});

test('the customer fixture does NOT conform, for a reason the contract can state', async (t) => {
  // `partner-scorecard` acts on `delivery-partner-engagement`, a record the
  // `delivery` package owns, and declares no dependency on `delivery` at all.
  // Handing that package to anyone whose project lacks `delivery` produces an
  // application that will not start, and nothing in its declaration says so.
  //
  // This command CAN find the owner — it is in this repository — but rescuing
  // the package that way and then calling it conforming would be monorepo magic:
  // a third-party consumer would get a different answer. So the owner is
  // composed to keep the rest of the report informative, and the check fails.
  const { exitCode, report } = await run('examples/custom-packages/partner-scorecard');
  assert.equal(exitCode, 1);
  assert.equal(report.ok, false);

  const coupling = report.checks.find((entry) => entry.id === 'declaration.action-targets');
  assert.equal(coupling.status, 'failed');
  assert.equal(coupling.reason, 'UNDECLARED_PACKAGE_RECORD_DEPENDENCY');
  assert.equal(coupling.authority, 'composition');
  assert.match(coupling.evidence, /delivery-partner-engagement \(delivery\)/);
  assert.match(coupling.evidence, /delivery offers /, 'the author is told what they could declare instead');
  assert.deepEqual(report.scratch.undeclaredRecordOwners, ['delivery'],
    'and the report names the package this project happened to contain');

  // Everything else about it is still measured, so the failure is one line of a
  // real report rather than an early exit.
  for (const id of ['lifecycle.attach', 'lifecycle.detach', 'inspection.valid']) {
    assert.equal(report.checks.find((entry) => entry.id === id).status, 'passed', id);
  }
  assert.ok(t);
});

test('the three record-dependency cases are graded differently', async (t) => {
  const root = fixtureProject(t);
  writeFixturePackage(root, 'fx-owner', provider('fx-owner', { capability: 'owner-view' }),
    { modules: { 'fx-owner-record.module.json': manifestFor('fx-owner-record') } });

  // 1 · a host-application record no package owns — ordinary, needs no declaration.
  writeFixturePackage(root, 'fx-host', consumer('fx-host', { targets: ['host-thing'] }));
  writeFileSync(join(root, 'host-thing.module.json'), `${JSON.stringify(manifestFor('host-thing'), null, 2)}\n`);
  const host = await packageTestCommand({ packagePath: join(root, 'packages/fx-host'), rootDir: root, capture: true });
  const hostRow = host.report.checks.find((entry) => entry.id === 'declaration.action-targets');
  assert.equal(hostRow.status, 'passed', hostRow.evidence);
  assert.match(hostRow.evidence, /host-application record/);

  // 2 · a record owned by a package it DOES declare — passed, coupling named.
  writeFixturePackage(root, 'fx-declared', consumer('fx-declared', {
    requires: [{ package: 'fx-owner', capability: 'owner-view', version: 1 }],
    targets: ['fx-owner-record'],
  }));
  const declared = await packageTestCommand({ packagePath: join(root, 'packages/fx-declared'), rootDir: root, capture: true });
  const declaredRow = declared.report.checks.find((entry) => entry.id === 'declaration.action-targets');
  assert.equal(declaredRow.status, 'passed', declaredRow.evidence);
  assert.match(declaredRow.evidence, /declared dependency/);

  // 3 · the same record, undeclared — failed, and the owner is named.
  writeFixturePackage(root, 'fx-undeclared', consumer('fx-undeclared', { targets: ['fx-owner-record'] }));
  const undeclared = await packageTestCommand({ packagePath: join(root, 'packages/fx-undeclared'), rootDir: root, capture: true });
  assert.equal(undeclared.exitCode, 1);
  const undeclaredRow = undeclared.report.checks.find((entry) => entry.id === 'declaration.action-targets');
  assert.equal(undeclaredRow.status, 'failed');
  assert.equal(undeclaredRow.reason, 'UNDECLARED_PACKAGE_RECORD_DEPENDENCY');
  assert.match(undeclaredRow.evidence, /owner-view@1/, 'the capability it could have declared is named');

  // 4 · two foreign owners, one declared and one not — still a failure, and only
  // the undeclared one is blamed.
  writeFixturePackage(root, 'fx-second-owner', provider('fx-second-owner', { capability: 'second-view' }),
    { modules: { 'fx-second-owner-record.module.json': manifestFor('fx-second-owner-record') } });
  writeFixturePackage(root, 'fx-mixed', consumer('fx-mixed', {
    requires: [{ package: 'fx-owner', capability: 'owner-view', version: 1 }],
    targets: ['fx-owner-record', 'fx-second-owner-record'],
  }));
  const mixed = await packageTestCommand({ packagePath: join(root, 'packages/fx-mixed'), rootDir: root, capture: true });
  const mixedRow = mixed.report.checks.find((entry) => entry.id === 'declaration.action-targets');
  assert.equal(mixedRow.status, 'failed');
  assert.match(mixedRow.evidence, /fx-second-owner-record \(fx-second-owner\)/);
  assert.equal(/fx-owner-record \(fx-owner\)/.test(mixedRow.evidence), false,
    'the declared one is not blamed alongside it');
  assert.ok(t);
});

test('the dependency graph is closed deterministically, whatever shape it has', async (t) => {
  const root = fixtureProject(t);
  writeFixturePackage(root, 'fx-base', provider('fx-base', { capability: 'base', resources: [] }));
  // A diamond: two middles both depending on one base, and a top on both.
  for (const middle of ['fx-left', 'fx-right']) {
    writeFixturePackage(root, middle, `// @ts-check
import { definePackage } from '../../core/index.js';
export function createFixturePackage() {
  return definePackage({
    packageContract: 1, name: '${middle}', label: '${middle}', version: 1, resources: [],
    requires: [{ package: 'fx-base', capability: 'base', version: 1 }],
    capabilities: [{ name: '${middle}-view', version: 1, create: () => ({}) }],
  });
}
`);
  }
  writeFixturePackage(root, 'fx-top', consumer('fx-top', {
    requires: [
      { package: 'fx-left', capability: 'fx-left-view', version: 1 },
      { package: 'fx-right', capability: 'fx-right-view', version: 1 },
    ],
  }));
  const diamond = await packageTestCommand({ packagePath: join(root, 'packages/fx-top'), rootDir: root, capture: true });
  assert.equal(diamond.exitCode, 0, JSON.stringify(diamond.report?.checks?.filter((c) => c.status === 'failed')));
  assert.deepEqual(diamond.report.scratch.composed, ['fx-base', 'fx-left', 'fx-right', 'fx-top'],
    'the whole diamond is composed once each, in a stable order');
  const again = await packageTestCommand({ packagePath: join(root, 'packages/fx-top'), rootDir: root, capture: true });
  assert.equal(diamond.report.fingerprint, again.report.fingerprint, 'and the closure is deterministic');

  // A wrong version is not the same as a missing package, and both are refused.
  writeFixturePackage(root, 'fx-wrong-version', consumer('fx-wrong-version', {
    requires: [{ package: 'fx-base', capability: 'base', version: 9 }],
  }));
  const wrong = await packageTestCommand({ packagePath: join(root, 'packages/fx-wrong-version'), rootDir: root, capture: true });
  assert.equal(wrong.exitCode, 1);
  assert.equal(wrong.report.checks.find((entry) => entry.id === 'compose.clean').status, 'failed');
  assert.ok(wrong.report.problems.some((entry) => /base@9|does not offer/.test(entry.message)),
    `a wrong version is named: ${JSON.stringify(wrong.report.problems)}`);

  // A second provider of the same capability at the same version is refused.
  writeFixturePackage(root, 'fx-duplicate-provider', provider('fx-duplicate-provider', { capability: 'base', resources: [] }));
  const duplicate = await packageTestCommand({ packagePath: join(root, 'packages/fx-duplicate-provider'), rootDir: root, capture: true });
  assert.equal(duplicate.report.checks.find((entry) => entry.id === 'compose.capability-collision-refused').status, 'passed');
  assert.ok(t);
});

test('the report is byte-identical across runs, processes and working directories', async (t) => {
  const first = (await run('packages/service')).report;
  const second = (await run('packages/service')).report;
  assert.equal(JSON.stringify(first), JSON.stringify(second), 'two runs in one process agree');

  // A different working directory must not move a single byte: every path in
  // the report is relative to the project, never to where the caller stood.
  const previous = process.cwd();
  process.chdir(tmpdir());
  try {
    const elsewhere = (await run(join(repoRoot, 'packages/service'))).report;
    assert.equal(JSON.stringify(first), JSON.stringify(elsewhere),
      'a different working directory does not move one byte');
  } finally {
    process.chdir(previous);
  }

  // A separate process, which is the only way to prove no in-process state is
  // carrying the answer.
  const separate = await import('node:child_process').then(({ spawnSync }) => spawnSync(
    process.execPath,
    ['--no-warnings', join(repoRoot, 'packages/cli/bin/accordo.js'), 'package', 'test', 'packages/service', '--json'],
    { encoding: 'utf8', cwd: repoRoot },
  ));
  assert.equal(separate.status, 0, separate.stderr);
  assert.equal(JSON.parse(separate.stdout).fingerprint, first.fingerprint, 'a separate process agrees');
  assert.ok(t);
});

test('a project path containing spaces changes nothing', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'accordo dx4 '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const entry of ['packages', 'apps', 'package.json', 'examples']) {
    cpSync(join(repoRoot, entry), join(root, entry), { recursive: true });
  }
  const spaced = await packageTestCommand({
    packagePath: join(root, 'packages/service'), rootDir: root, capture: true,
  });
  const plain = await run('packages/service');
  assert.equal(spaced.exitCode, 0, JSON.stringify(spaced.report?.checks?.filter((c) => c.status === 'failed')));
  assert.equal(spaced.report.fingerprint, plain.report.fingerprint,
    'a path with spaces produces the same conformance facts');
  assert.ok(t);
});

test('no absolute path, stack or scratch location reaches the report', async (t) => {
  const root = fixtureProject(t);
  writeFixturePackage(root, 'fixture-throws', `// @ts-check
throw new Error('failed while reading /home/somebody/private/thing.js');
`);
  const thrown = await packageTestCommand({ packagePath: join(root, 'packages/fixture-throws'), rootDir: root, capture: true });
  assert.equal(thrown.exitCode, 2, 'a package that cannot be read at all is exit 2');

  for (const [path] of OFFICIAL.slice(0, 1)) {
    const { report } = await run(path);
    const text = JSON.stringify(report);
    assert.equal(/"\/[A-Za-z]/.test(text), false, 'no value starts with an absolute path');
    assert.equal(text.includes(tmpdir()), false, 'the scratch directory never appears');
    assert.equal(text.includes(repoRoot.replace(/\/$/, '')), false, 'the caller\'s own root never appears');
    assert.equal(/ at [A-Za-z]+ \(/.test(text), false, 'no stack frame');
  }
  assert.ok(t);
});

test('the caller\'s project is never written to, and the scratch is always removed', async (t) => {
  const before = new Set(readdirSync(join(repoRoot, 'packages', 'modules')));
  const failing = fixtureProject(t);
  writeFixturePackage(failing, 'fixture-bad', HOSTILE_PACKAGES.find(([name]) => name === 'fixture-bad-contract')[1]);

  // Give these two real CLI invocations their own temp root. Comparing the
  // process-wide temp directory is racy under Node's parallel test runner: a
  // scratch created or removed by another test looks like a leak here. A
  // private TMPDIR proves exactly what this test owns, on both exit paths.
  const privateTmp = mkdtempSync(join(tmpdir(), 'accordo-package-cleanup-test-'));
  t.after(() => rmSync(privateTmp, { recursive: true, force: true }));
  const env = { ...process.env, TMPDIR: privateTmp, TMP: privateTmp, TEMP: privateTmp };
  const cli = join(repoRoot, 'packages/cli/bin/accordo.js');
  const success = spawnSync(process.execPath, [cli, 'package', 'test', 'packages/service', '--json', '--root', repoRoot], {
    cwd: repoRoot, env, encoding: 'utf8',
  });
  assert.equal(success.status, 0, success.stderr);
  const failure = spawnSync(process.execPath, [cli, 'package', 'test', join(failing, 'packages/fixture-bad'), '--json', '--root', failing], {
    cwd: failing, env, encoding: 'utf8',
  });
  assert.equal(failure.status, 1, failure.stderr);

  assert.deepEqual([...readdirSync(join(repoRoot, 'packages', 'modules'))].sort(), [...before].sort(),
    'no generated module appeared in the real project');
  assert.deepEqual(readdirSync(privateTmp), [], 'every owned scratch project was removed, on success and on failure');
  assert.ok(t);
});

test('a well-formed fixture package conforms; each hostile one is refused with a stable outcome', async (t) => {
  const root = fixtureProject(t);
  writeFixturePackage(root, 'fixture-ok', WELL_FORMED);
  const control = await packageTestCommand({ packagePath: join(root, 'packages/fixture-ok'), rootDir: root, capture: true });
  assert.equal(control.exitCode, 0, JSON.stringify(control.report?.checks?.filter((c) => c.status === 'failed')));

  /** id → the check that must have caught it, or null when the package cannot be read at all. */
  const EXPECTED = {
    'fixture-no-definition': null,
    'fixture-throws-on-import': null,
    'fixture-bad-contract': 'declaration.contract',
    'fixture-bad-name': 'declaration.valid',
    'fixture-private-import': 'boundary.private-import',
    'fixture-eval': 'boundary.static-source',
    'fixture-missing-dependency': null,
    'fixture-unstable-metadata': 'declaration.metadata',
    'fixture-noisy': 'noise',
    'fixture-exits': 'survives',
  };

  for (const [name, source] of HOSTILE_PACKAGES) {
    writeFixturePackage(root, name, source);
    const outcome = await packageTestCommand({
      packagePath: join(root, 'packages', name), rootDir: root, capture: true, timeoutMs: 20_000,
    });
    const expected = EXPECTED[name];
    if (expected === null) {
      assert.ok(outcome.exitCode === 1 || outcome.exitCode === 2,
        `${name}: expected a refusal, got exit ${outcome.exitCode}`);
      continue;
    }
    if (expected === 'survives') {
      // A package that calls `process.exit` while being imported must take its
      // own child down and nothing else. This is the case that proved the point:
      // an early draft read the definition in the parent, and this fixture
      // killed the test runner that was checking it.
      assert.equal(outcome.exitCode, 2, `${name}: a package that exits mid-import is unreadable, not conforming`);
      assert.equal(outcome.report, null);
      continue;
    }
    assert.ok(outcome.report, `${name}: a readable package still produces a report`);
    if (expected === 'noise') {
      // A package that floods a stream must not corrupt the document or hang
      // the parent; whether it conforms is a separate question and either
      // answer is legitimate.
      assert.equal(typeof outcome.report.ok, 'boolean');
      assert.equal(outcome.report.packageConformanceContract, 1);
      continue;
    }
    assert.equal(outcome.exitCode, 1, `${name}: expected conformance failures`);
    const row = outcome.report.checks.find((entry) => entry.id === expected);
    assert.equal(row?.status, 'failed', `${name}: ${expected} should have caught it (${row?.evidence})`);
  }
  assert.ok(t);
});

test('a package whose module body never returns is stopped, not waited for', async (t) => {
  const root = fixtureProject(t);
  writeFixturePackage(root, 'fixture-hangs', HANGS);
  const started = Date.now();
  const outcome = await packageTestCommand({
    packagePath: join(root, 'packages/fixture-hangs'), rootDir: root, capture: true, timeoutMs: 4_000,
  });
  const elapsed = Date.now() - started;
  // The parent returns; it does not hang. Two boots at four seconds each plus
  // the AX1 inspection is the bound, and the run is comfortably inside it.
  assert.ok(elapsed < 90_000, `the command returned in ${elapsed}ms rather than hanging`);
  assert.ok(outcome.exitCode === 1 || outcome.exitCode === 2, `exit ${outcome.exitCode}`);
  if (outcome.report) {
    const attach = outcome.report.checks.find((entry) => entry.id === 'lifecycle.attach');
    assert.equal(attach.status, 'failed', 'a project that will not start is a failed attach, not a pass');
  }
  assert.ok(t);
});

test('a package outside the project is refused rather than copied in', async (t) => {
  const outside = mkdtempSync(join(tmpdir(), 'accordo-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFixturePackage(outside, 'fixture-elsewhere', WELL_FORMED);
  const outcome = await run(join(outside, 'packages/fixture-elsewhere'));
  assert.equal(outcome.exitCode, 2, 'a package outside the project cannot be composed by relative import');
  assert.ok(t);
});

test('the machine-readable contract is stable, and its vocabulary is closed', async (t) => {
  const { report } = await run('packages/service');
  assert.deepEqual(Object.keys(report).sort(), [
    'categories', 'checks', 'command', 'counts', 'fingerprint', 'inspectionFingerprint',
    'limitations', 'ok', 'package', 'packageConformanceContract', 'path', 'problems', 'scratch',
  ]);
  assert.deepEqual(report.categories,
    ['declaration', 'boundary', 'composition', 'modules', 'lifecycle', 'inspection'],
    'there is no category of checks that merely re-tests the framework itself');
  assert.equal(report.packageConformanceContract, 1);
  assert.equal(report.command, 'package:test');
  assert.match(report.fingerprint, /^[0-9a-f]{64}$/);
  assert.match(report.inspectionFingerprint, /^[0-9a-f]{64}$/, 'AX1\'s digest of the composed project travels as evidence');

  const statuses = new Set(report.checks.map((entry) => entry.status));
  for (const status of statuses) assert.ok(['passed', 'failed', 'skipped', 'not_applicable'].includes(status), status);
  for (const entry of report.checks) {
    assert.ok(report.categories.includes(entry.category), `${entry.id} is in a declared category`);
    assert.equal(typeof entry.evidence, 'string');
    assert.ok(entry.evidence.length > 0, `${entry.id} states what was observed`);
  }
  // Checks are sorted, so a diff between two reports is a diff of substance.
  assert.deepEqual(report.checks.map((entry) => entry.id), [...report.checks.map((entry) => entry.id)].sort());

  // Every limitation is a code with prose, and the domain boundary is stated.
  assert.ok(report.limitations.some((entry) => entry.code === 'DOMAIN_CORRECTNESS_NOT_PROVEN'));
  assert.ok(report.limitations.some((entry) => entry.code === 'PACKAGE_SOURCE_TRUSTED'));
  // The trust boundary is stated in the exact three clauses the review requires.
  const trust = report.limitations.find((entry) => entry.code === 'PACKAGE_SOURCE_TRUSTED').message;
  assert.match(trust, /does not intentionally mutate the caller project/);
  assert.match(trust, /trusted and executes with the operator’s authority/);
  assert.match(trust, /not a filesystem, network or OS sandbox/);
  const scratchLimit = report.limitations.find((entry) => entry.code === 'SCRATCH_PROJECT_ONLY').message;
  assert.match(scratchLimit, /cannot prevent package code from writing wherever the operator can write/,
    'the report never promises a hostile package cannot reach the caller project');
  assert.ok(t);
});

test('the fingerprint moves when the package moves, and not when the caller does', async (t) => {
  const root = fixtureProject(t);
  writeFixturePackage(root, 'fixture-ok', WELL_FORMED);
  const before = (await packageTestCommand({ packagePath: join(root, 'packages/fixture-ok'), rootDir: root, capture: true })).report;

  writeFileSync(join(root, 'packages/fixture-ok/src/index.js'), WELL_FORMED.replace("version: 1,", 'version: 2,'));
  const after = (await packageTestCommand({ packagePath: join(root, 'packages/fixture-ok'), rootDir: root, capture: true })).report;
  assert.notEqual(before.fingerprint, after.fingerprint, 'a changed package version moves the digest');
  assert.equal(after.package.version, 2);
  assert.ok(t);
});

test('a declared dependency this project cannot satisfy skips the boot honestly', async (t) => {
  const root = fixtureProject(t);
  writeFixturePackage(root, 'fixture-missing-dependency',
    HOSTILE_PACKAGES.find(([name]) => name === 'fixture-missing-dependency')[1]);
  const { exitCode, report } = await packageTestCommand({
    packagePath: join(root, 'packages/fixture-missing-dependency'), rootDir: root, capture: true,
  });
  assert.equal(exitCode, 1);
  assert.ok(report.problems.some((entry) => entry.code === 'DEPENDENCY_PROVIDER_ABSENT'));
  for (const id of ['lifecycle.attach', 'lifecycle.detach', 'inspection.valid']) {
    const row = report.checks.find((entry) => entry.id === id);
    assert.equal(row.status, 'skipped', `${id} must be skipped, never passed`);
    assert.equal(row.reason, 'DEPENDENCY_PROVIDER_ABSENT');
  }
  assert.equal(report.scratch.manifestsApplied, 0, 'nothing was applied for a package that cannot compose');
  // …and the declared dependency was still proved to stop registration.
  assert.equal(report.checks.find((entry) => entry.id === 'compose.unmet-dependency-refused').status, 'passed');
  assert.ok(t);
});

test('the isolation claim is exactly what the harness can keep, and no more', async (t) => {
  // What isolation actually buys is that the invoking process survives. It does
  // NOT stop package code writing where the operator can write, and the report
  // must not imply otherwise.
  const root = fixtureProject(t);
  for (const [name, source] of SCRATCH_PROBES) writeFixturePackage(root, name, source);

  // 1 · a package reading the environment is not prevented, and is not a failure.
  const env = await packageTestCommand({
    packagePath: join(root, 'packages/fixture-reads-env'), rootDir: root, capture: true,
  });
  assert.equal(env.exitCode, 0, 'reading the environment is not a conformance rule this framework has');

  // 2 · a package writing beside its own source writes into the SCRATCH copy,
  // which is what the harness controls. The caller's own package directory is
  // untouched — not because the package was stopped, but because it was never
  // the file it opened.
  const beside = await packageTestCommand({
    packagePath: join(root, 'packages/fixture-writes-beside-source'), rootDir: root, capture: true,
  });
  assert.ok(beside.report, 'a writing package still produces a report');
  assert.equal(existsSync(join(root, 'packages/fixture-writes-beside-source/src/wrote-beside-source.txt')), false,
    'the caller\'s copy of the package gained no file, because the package was imported from the scratch copy');

  // 3 · an ordinary short-lived child a package spawns changes nothing.
  const spawned = await packageTestCommand({
    packagePath: join(root, 'packages/fixture-spawns-child'), rootDir: root, capture: true, timeoutMs: 20_000,
  });
  assert.ok(spawned.report, 'a package that spawns an ordinary child still produces a report');
  assert.equal(spawned.exitCode, 0);
  const isolation = spawned.report.limitations.find((entry) => entry.code === 'PROCESS_ISOLATION_BOUNDED');
  assert.match(isolation.message, /deliberately detaches a process into a new group outlives the run/);

  // 4 · a child that OUTLIVES the import is the timeout path, and it is stable:
  // the reporting process cannot exit while it holds a live child handle, so
  // the run is stopped and the whole process group goes with it.
  writeFixturePackage(root, 'fixture-long-child', SPAWNS_LONG_LIVED_CHILD);
  const started = Date.now();
  const long = await packageTestCommand({
    packagePath: join(root, 'packages/fixture-long-child'), rootDir: root, capture: true, timeoutMs: 3_000,
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 60_000, `the run was stopped rather than waited out (${elapsed}ms)`);
  assert.ok(long.exitCode === 1 || long.exitCode === 2, `a stable outcome, got ${long.exitCode}`);
  assert.ok(t);
});

test('a forged, doubled or truncated child report never becomes a conformance answer', async (t) => {
  const { runReportingChild } = await import('../packages/cli/src/child-report.js');
  const loaderFor = (t2, body) => {
    const dir = mkdtempSync(join(tmpdir(), 'accordo-loader-'));
    t2.after(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, 'loader.mjs');
    writeFileSync(file, body);
    return file;
  };

  // Two JSON documents on fd 3: the concatenation is not valid JSON, so it is
  // refused rather than half-parsed into a verdict.
  const doubled = await runReportingChild({
    loader: loaderFor(t, `import { writeSync } from 'node:fs';
writeSync(3, JSON.stringify({ read: true, package: { name: 'forged' } }) + '\\n');
writeSync(3, JSON.stringify({ read: true, package: { name: 'second' } }) + '\\n');
`),
  });
  assert.equal(doubled.report, null);
  assert.match(doubled.diagnostic, /not valid JSON/);

  // A truncated document is refused, not repaired.
  const truncated = await runReportingChild({
    loader: loaderFor(t, `import { writeSync } from 'node:fs';
writeSync(3, '{"read": true, "package": {"name": "trunc');
`),
  });
  assert.equal(truncated.report, null);
  assert.match(truncated.diagnostic, /not valid JSON/);

  // Nothing at all on fd 3 is a stated outcome, not an empty pass.
  const silent = await runReportingChild({ loader: loaderFor(t, 'process.exitCode = 0;\n') });
  assert.equal(silent.report, null);
  assert.ok(silent.diagnostic.trim().length > 0);

  // stdout is not the report channel: a package printing a whole JSON document
  // to stdout cannot become the answer.
  const impostor = await runReportingChild({
    loader: loaderFor(t, `console.log(JSON.stringify({ read: true, package: { name: 'impostor' } }));\n`),
  });
  assert.equal(impostor.report, null, 'stdout is package noise, never the contract');
  assert.match(impostor.noise, /impostor/, 'and it is returned as noise instead');
  assert.ok(t);
});

/**
 * REGRESSION (Wave 2A) — the reporting child settles on **exit**, and the drain
 * window is what makes that safe.
 *
 * `close` arrives only when every copy of the pipe is gone, so a grandchild the
 * package spawned holds it for as long as it lives and the run waits out its
 * whole timeout on a process that finished in milliseconds. Settling on `exit`
 * fixes that and creates the opposite risk: a report written immediately before
 * the process exits must still be collected. Both halves are pinned here.
 */
test('a reporting child settles on exit, and what it wrote just before exiting still arrives', async (t) => {
  const { runReportingChild } = await import('../packages/cli/src/child-report.js');
  const loaderFor = (body) => {
    const dir = mkdtempSync(join(tmpdir(), 'accordo-drain-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, 'loader.mjs');
    writeFileSync(file, body);
    return file;
  };

  // 1 · report written and the process exits in the same tick: the drain window
  //     is the only thing that collects it.
  const raced = await runReportingChild({
    loader: loaderFor(`import { writeSync } from 'node:fs';
writeSync(3, JSON.stringify({ read: true, package: { name: 'raced' } }));
process.exit(0);
`),
    timeoutMs: 10_000,
  });
  assert.equal(raced.report?.package?.name, 'raced', 'a report written immediately before exit is not lost');

  // 2 · a grandchild inherits fd 3 and never lets go. The reporting process has
  //     exited and its report is complete, so the run must not wait for the
  //     pipe to close.
  const started = Date.now();
  const leakyLoader = loaderFor(`import { writeSync } from 'node:fs';
import { spawn } from 'node:child_process';
spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: ['ignore', 1, 2, 3] }).unref();
writeSync(3, JSON.stringify({ read: true, package: { name: 'leaked' } }));
process.exit(0);
`);
  const leaked = await runReportingChild({ loader: leakyLoader, timeoutMs: 20_000 });
  const elapsed = Date.now() - started;
  assert.equal(leaked.report?.package?.name, 'leaked', 'the report survives the leak');
  assert.ok(elapsed < 15_000, `settled on exit rather than on the pipe closing (${elapsed}ms)`);
  // And the pipes are released, not merely stopped being read. An open stream
  // is a ref'd handle: without this the promise resolved in 300ms and the
  // process that called it could never exit, so `crm package test` printed its
  // report and hung — and DX5's package stage, which spawns that command, saw a
  // conforming package as a fifteen-minute timeout.
  const child = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', `
    import { runReportingChild } from ${JSON.stringify(join(repoRoot, 'packages/cli/src/child-report.js'))};
    const r = await runReportingChild({ loader: ${JSON.stringify(leakyLoader)}, timeoutMs: 20000 });
    process.stdout.write(JSON.stringify(r.report));
  `], { encoding: 'utf8', timeout: 25_000 });
  assert.equal(child.signal, null, 'the calling process exits on its own; it is not killed by the timeout');
  assert.equal(child.status, 0);
  assert.match(child.stdout, /leaked/);

  // 3 · a process that exits before writing anything is a stated outcome, never
  //     an empty pass.
  const early = await runReportingChild({
    loader: loaderFor('process.exit(0);\n'),
    timeoutMs: 10_000,
    hints: { empty: 'No report was produced.' },
  });
  assert.equal(early.report, null);
  assert.match(early.diagnostic, /No report was produced/);
});

test('a package applies its manifests reference-targets first, whatever the alphabet says', async () => {
  // `quote-term.module.json` sorts BEFORE `quote.module.json`, and its
  // `quoteId` reference targets the `quotes` table — applied alphabetically
  // the factory refuses it ("apply the target module first"). The order must
  // honour the rail's own doctrine: a manifest is never applied before the
  // records its foreign keys point at.
  const { packageManifests } = await import('../packages/cli/src/package-test-project.js');
  const order = packageManifests(join(repoRoot, 'packages/commercial')).map((path) => path.split('/').pop());
  const quote = order.indexOf('quote.module.json');
  const quoteTerm = order.indexOf('quote-term.module.json');
  assert.ok(quote !== -1 && quoteTerm !== -1, `both manifests are listed: ${order.join(', ')}`);
  assert.ok(quote < quoteTerm, `quote must apply before quote-term (got: ${order.join(', ')})`);
  // And the order stays a permutation of the alphabetical set — nothing is
  // dropped or invented by the dependency pass.
  assert.deepEqual([...order].sort(), readdirSync(join(repoRoot, 'packages/commercial/modules')).filter((name) => name.endsWith('.module.json')).sort());
});

/**
 * The boundary rules read **code**, not prose.
 *
 * Both rules are regular expressions over source text, and the customer-data
 * package caught them being wrong in both directions at once. A doc comment
 * that writes a path in backticks after the word "from" — *"the signer policy
 * from `packages/signature/src/operations.js`"* — was matched as an import, and
 * a conforming package failed conformance for the sentence that explained why
 * it was conforming. That is a false accusation from an authority: worse than a
 * missed one, and unfixable except by deleting the explanation.
 *
 * Stripping comments naively invents the opposite bug, so these hold both ends:
 * a `//` inside a string or a regular expression must not blind the scanner to
 * the imports that follow it.
 */
test('a path written in a comment is not an import, and a path in code still is', () => {
  const commented = [
    '// see packages/signature/src/operations.js for the signer policy',
    '/**',
    ' * Reuses the control-character policy from `packages/signature/src/operations.js`,',
    ' * and the date rules from "packages/contracts/src/dates.js".',
    ' */',
    "import { thing } from '../../core/index.js';",
    'export const value = thing;',
  ].join('\n');
  assert.deepEqual(importSpecifiers(commented), ['../../core/index.js'],
    'prose is prose, however it is punctuated');
  assert.equal(importsPrivateKernelPath('// do not import from `packages/core/src/database.js`'), false);

  const real = "import { x } from '../../signature/src/operations.js';";
  assert.deepEqual(importSpecifiers(real), ['../../signature/src/operations.js']);
  assert.equal(importsPrivateKernelPath("import { d } from '../../core/src/database.js';"), true);
  assert.equal(importsPrivateKernelPath("const d = await import('../../core/src/database.js');"), true);
});

test('stripping comments never swallows a string or a regular expression', () => {
  const tricky = [
    "const url = 'https://example.test/a//b';",
    'const pattern = /https?:\\/\\/[^ ]+/g;',
    'const template = `a // not a comment ${url}`;',
    "import { after } from '../../delivery/src/thing.js';",
  ].join('\n');
  assert.deepEqual(importSpecifiers(tricky), ['../../delivery/src/thing.js'],
    'an import after a URL, a regex or a template must still be seen');

  const stripped = stripComments(tricky);
  assert.ok(stripped.includes('https://example.test/a//b'), 'a URL in a string survives');
  assert.ok(stripped.includes('a // not a comment'), 'a template literal survives');
  assert.equal(stripComments('a; /* b */ c;').split('\n').length, 1, 'line structure is preserved');
  assert.equal(stripComments('a\n// x\nb').split('\n').length, 3);
});

/**
 * Review finding, added rather than found broken: this scanner is a hand-rolled
 * lexer sitting *inside* a conformance authority, so the question is not
 * whether it parses JavaScript but what it does when it is wrong. Only the two
 * comment branches replace anything — every string, template and regular
 * expression is copied through verbatim — so a mis-lex can raise a false
 * accusation but can never hide a real violation. These are the inputs designed
 * to blind it, and the rule they pin is that direction.
 */
test('a mis-lex can only over-report: no construct hides a real kernel import', () => {
  const violation = "import { x } from '../../core/src/kernel.js';";
  const decoys = [
    ["a URL string", "const u = 'https://x.test//y';"],
    ['a regex holding escaped slashes', 'const re = /a\\/\\/b/g;'],
    ['a regex character class holding quotes', "const re = /['\"\\/]/;"],
    ['a chain of divisions', 'const n = a / b / c;'],
    ['an apostrophe inside a line comment', "// don't do this"],
    ['a template with a nested expression and a slash pair', "const s = `a ${b ? 'c' : 'd'} //e`;"],
    ['a nested template literal', 'const s = `a ${`b`} c`;'],
    ['a string holding a block-comment opener', "const s = '/*';"],
    ['a trailing comment on a code line', 'const a = 1; // note'],
    ['a regex that never closes on its line', 'const re = /abc'],
  ];
  for (const [what, decoy] of decoys) {
    assert.equal(importsPrivateKernelPath(`${decoy}\n${violation}`), true,
      `${what} must not blind the scanner to the import on the next line`);
    assert.deepEqual(importSpecifiers(`${decoy}\n${violation}`), ['../../core/src/kernel.js'],
      `${what} must not swallow the specifier either`);
  }

  // And the other direction still holds: prose is prose, in either comment form.
  assert.equal(importsPrivateKernelPath(`/* import { x } from '../../core/src/kernel.js'; */`), false);
  assert.equal(importsPrivateKernelPath(`// import { x } from '../../core/src/kernel.js';`), false);
});
