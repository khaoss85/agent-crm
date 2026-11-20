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
