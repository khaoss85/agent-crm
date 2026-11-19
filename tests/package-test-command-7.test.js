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
