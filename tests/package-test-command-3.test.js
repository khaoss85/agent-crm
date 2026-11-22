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
