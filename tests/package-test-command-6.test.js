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
