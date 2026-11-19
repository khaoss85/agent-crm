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
