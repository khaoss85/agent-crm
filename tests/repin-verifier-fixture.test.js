// @ts-check

/**
 * `scripts/repin-verifier-fixture.js`: the three fingerprints pinned in the
 * checked-in verifier fixture are refreshed by a repeatable command, not by a
 * hand-edit — and `--check` fails naming that command when they drifted.
 *
 * The live proof runs the real scenario authority, so these tests are honest:
 * stale copies are repinned to exactly the pins the repository carries, and
 * `--check` tells a drifted tree how to fix itself. Copies live in a temp
 * dir; the repository is never written.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  VERIFIER_FIXTURE_EVIDENCE,
  VERIFIER_FIXTURE_PLAN,
  repinVerifierFixture,
} from '../scripts/repin-verifier-fixture.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/** Stale copies of the two checked-in documents: every pin moved by one nibble. */
function staleCopies(directory) {
  const planFile = join(directory, 'plan.json');
  const evidenceFile = join(directory, 'evidence.json');
  const plan = JSON.parse(readFileSync(join(repoRoot, VERIFIER_FIXTURE_PLAN), 'utf8'));
  const evidence = JSON.parse(readFileSync(join(repoRoot, VERIFIER_FIXTURE_EVIDENCE), 'utf8'));
  const stale = (digest) => (digest.endsWith('0') ? `${digest.slice(0, -1)}1` : `${digest.slice(0, -1)}0`);
  plan.application.inspectionFingerprint = stale(plan.application.inspectionFingerprint);
  evidence.applicationInspectionFingerprint = stale(evidence.applicationInspectionFingerprint);
  evidence.planFingerprint = stale(evidence.planFingerprint);
  writeFileSync(planFile, `${JSON.stringify(plan, null, 2)}\n`);
  writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`);
  return { planFile, evidenceFile };
}

function pinsOf(planFile, evidenceFile) {
  const plan = JSON.parse(readFileSync(planFile, 'utf8'));
  const evidence = JSON.parse(readFileSync(evidenceFile, 'utf8'));
  return {
    plan: plan.application.inspectionFingerprint,
    evidenceApplication: evidence.applicationInspectionFingerprint,
    evidencePlan: evidence.planFingerprint,
  };
}

function checkedInPins() {
  return pinsOf(join(repoRoot, VERIFIER_FIXTURE_PLAN), join(repoRoot, VERIFIER_FIXTURE_EVIDENCE));
}

test('a drifted fixture fails --check naming the repin command, and the command restores the checked-in pins', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'repin-fixture-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { planFile, evidenceFile } = staleCopies(directory);
  const args = { rootDir: repoRoot, planPath: planFile, evidencePath: evidenceFile };

  let stderr = '';
  const checkResult = await repinVerifierFixture({ ...args, check: true, out: () => {}, err: (text) => { stderr += text; } });
  assert.equal(checkResult.exitCode, 1, 'a drifted fixture fails --check');
  assert.deepEqual(checkResult.drifted.length, 3, 'all three pins are reported');
  assert.match(stderr, /npm run repin:verifier-fixture/, '--check names the fix');

  let stdout = '';
  const repinResult = await repinVerifierFixture({ ...args, out: (text) => { stdout += text; } });
  assert.equal(repinResult.exitCode, 0);
  assert.deepEqual(repinResult.wrote, [planFile, evidenceFile]);
  assert.match(stdout, /repinned to/);
  assert.deepEqual(pinsOf(planFile, evidenceFile), checkedInPins(),
    'the command reproduces the checked-in pins from drift, not a new hand-edit');

  const clean = await repinVerifierFixture({ ...args, check: true, out: () => {}, err: () => {} });
  assert.equal(clean.exitCode, 0, '--check passes once repinned');
  assert.deepEqual(clean.drifted, []);
});

test('no composition, no repin: the command refuses rather than writing pins it did not observe', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'repin-fixture-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { planFile, evidenceFile } = staleCopies(directory);
  const before = pinsOf(planFile, evidenceFile);

  const result = await repinVerifierFixture({
    rootDir: repoRoot, planPath: planFile, evidencePath: evidenceFile,
    scenario: async () => ({ exitCode: 1, report: null }),
    out: () => {}, err: () => {},
  });
  assert.equal(result.exitCode, 2);
  assert.deepEqual(pinsOf(planFile, evidenceFile), before, 'a refused repin writes nothing');
});
