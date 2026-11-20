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
