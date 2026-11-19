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
