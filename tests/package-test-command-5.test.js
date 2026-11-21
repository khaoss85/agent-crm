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
