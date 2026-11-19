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

test('package test returns the invalid-name report before reading description', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'accordo-invalid-description-precedence-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let reads = 0;
  const definition = {
    packageContract: 1,
    name: 'INVALID NAME',
    label: 'Invalid',
    resources: [],
    actions: [],
    requires: [],
    capabilities: [],
    policies: [],
    operations: [],
    get description() { reads += 1; throw new Error('LATER_DESCRIPTION'); },
  };

  const report = runDeclarationChecks({ definition, dir });
  assert.equal(reads, 0);
  assert.deepEqual(report.problems.map((problem) => problem.code), ['PACKAGE_INVALID']);
  assert.match(report.problems[0].message, /name must match/);
});

test('package test returns the invalid-name report before reading policies', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'accordo-invalid-policies-precedence-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let reads = 0;
  const definition = {
    packageContract: 1,
    name: 'INVALID NAME',
    label: 'Invalid',
    resources: [],
    actions: [],
    requires: [],
    capabilities: [],
    operations: [],
    description: 'invalid',
    get policies() { reads += 1; throw new Error('LATER_POLICIES'); },
  };

  const report = runDeclarationChecks({ definition, dir });
  assert.equal(reads, 0);
  assert.deepEqual(report.problems.map((problem) => problem.code), ['PACKAGE_INVALID']);
  assert.match(report.problems[0].message, /name must match/);
});

test('package test returns the invalid-name report before reading operations', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'accordo-invalid-operations-precedence-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let reads = 0;
  const definition = {
    packageContract: 1,
    name: 'INVALID NAME',
    label: 'Invalid',
    resources: [],
    actions: [],
    requires: [],
    capabilities: [],
    policies: [],
    description: 'invalid',
    get operations() { reads += 1; throw new Error('LATER_OPERATIONS'); },
  };

  const report = runDeclarationChecks({ definition, dir });
  assert.equal(reads, 0);
  assert.deepEqual(report.problems.map((problem) => problem.code), ['PACKAGE_INVALID']);
  assert.match(report.problems[0].message, /name must match/);
});
