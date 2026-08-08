import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageTestCommand } from '../packages/cli/src/package-test-command.js';
import {
  HANGS, HOSTILE_PACKAGES, WELL_FORMED, fixtureProject, writeFixturePackage,
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

/** Every package this repository ships, plus the customer-authored fixture. */
const OFFICIAL = [
  ['packages/contracts', 'contracts'],
  ['packages/delivery', 'delivery'],
  ['packages/service', 'service'],
  ['examples/custom-packages/partner-scorecard', 'partner-scorecard'],
];

test('every package this repository ships conforms, and the report says how', async (t) => {
  for (const [path, name] of OFFICIAL) {
    const { exitCode, report } = await run(path);
    assert.equal(report.package.name, name);
    assert.equal(exitCode, 0, `${name}: ${report.checks.filter((c) => c.status === 'failed').map((c) => `${c.id} — ${c.evidence}`).join(' | ')}`);
    assert.equal(report.ok, true);
    assert.equal(report.counts.failed, 0);
    assert.ok(report.counts.passed >= 25, `${name} runs a real battery, not a token one`);

    // The boot actually happened: attach, detach and AX1 agreement all ran.
    for (const id of ['lifecycle.attach', 'lifecycle.detach', 'inspection.valid', 'inspection.package-row']) {
      const row = report.checks.find((entry) => entry.id === id);
      assert.equal(row.status, 'passed', `${name}: ${id} is ${row.status} — ${row.evidence}`);
    }
    // Every skip and every not-applicable states why.
    for (const row of report.checks) {
      if (row.status === 'skipped' || row.status === 'not_applicable') {
        assert.ok(row.reason, `${name}: ${row.id} declined without a reason`);
      }
    }
  }
  assert.ok(t);
});

test('the four packages disagree about how much they can prove, and say so', async (t) => {
  // Conformance is not one number. A package with no capability edge cannot
  // have one checked, and the report must show that rather than inflating.
  const scorecard = (await run('examples/custom-packages/partner-scorecard')).report;
  const service = (await run('packages/service')).report;

  const reasonFor = (report, id) => report.checks.find((entry) => entry.id === id);
  assert.equal(reasonFor(scorecard, 'compose.unmet-dependency-refused').status, 'not_applicable');
  assert.equal(reasonFor(scorecard, 'compose.unmet-dependency-refused').reason, 'NO_DEPENDENCIES_DECLARED');
  assert.equal(reasonFor(service, 'compose.unmet-dependency-refused').status, 'passed');

  // The scorecard's action targets a record it does not own. The contract has
  // no way to declare that, so it is reported as a seam gap rather than as a
  // pass or a failure.
  const coupling = reasonFor(scorecard, 'declaration.action-targets');
  assert.equal(coupling.status, 'not_applicable');
  assert.equal(coupling.reason, 'UNDECLARED_RECORD_COUPLING');
  assert.match(coupling.evidence, /delivery-partner-engagement/);
  assert.deepEqual(scorecard.scratch.impliedPrerequisites,
    [{ package: 'delivery', records: ['delivery-partner-engagement'] }],
    'and the package it silently needs is named');
  assert.equal(reasonFor(service, 'declaration.action-targets').status, 'passed');
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
    ['--no-warnings', join(repoRoot, 'packages/cli/bin/agent-crm.js'), 'package', 'test', 'packages/service', '--json'],
    { encoding: 'utf8', cwd: repoRoot },
  ));
  assert.equal(separate.status, 0, separate.stderr);
  assert.equal(JSON.parse(separate.stdout).fingerprint, first.fingerprint, 'a separate process agrees');
  assert.ok(t);
});

test('a project path containing spaces changes nothing', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'agent-crm dx4 '));
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
  const scratchBefore = readdirSync(tmpdir()).filter((entry) => entry.startsWith('agent-crm-package-test-'));

  await run('packages/service');
  const failing = fixtureProject(t);
  writeFixturePackage(failing, 'fixture-bad', HOSTILE_PACKAGES.find(([name]) => name === 'fixture-bad-contract')[1]);
  await packageTestCommand({ packagePath: join(failing, 'packages/fixture-bad'), rootDir: failing, capture: true });

  assert.deepEqual([...readdirSync(join(repoRoot, 'packages', 'modules'))].sort(), [...before].sort(),
    'no generated module appeared in the real project');
  const scratchAfter = readdirSync(tmpdir()).filter((entry) => entry.startsWith('agent-crm-package-test-'));
  assert.deepEqual(scratchAfter, scratchBefore, 'every scratch project was removed, on success and on failure');
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
  const outside = mkdtempSync(join(tmpdir(), 'agent-crm-outside-'));
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
  assert.equal(/sandbox(?!ed|\.|,| )/i.test(JSON.stringify(report.limitations).replace(/not a .{0,40}sandbox/gi, '')), false,
    'nothing claims to be a sandbox');
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
