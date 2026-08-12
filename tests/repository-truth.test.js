// @ts-check

/**
 * The two repository-truth guards, exercised against fixtures.
 *
 * Both exist because of the same failure, observed twice in this repository:
 * a fact was written down in two places, one of them moved, and every gate
 * stayed green. `site/claims.json` ran 26 tests behind main for a whole wave —
 * a branch's own re-measurement was destroyed by a merge that resolved the
 * conflict in favour of the older side — and `docs/PROJECT_STATUS.md`, the file
 * AGENTS.md orders every agent to trust, carried a SHA and a test count of its
 * own that a test had pinned in place.
 *
 * A guard nobody has watched fail is a guard nobody should trust
 * (`tests/surface-budget.test.js` makes the same argument about ceilings), so
 * each rule here is driven with input that must fail it and input that must not.
 *
 * What these guards deliberately do NOT do is in `docs/QUALITY_GATES.md` §6 and
 * repeated at the foot of this file.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { test } from 'node:test';

import {
  inspectStatusMeasurement,
  findLooseTestCounts,
  scansForLooseCounts,
  DATED_HISTORY,
} from '../scripts/measurement.js';

const read = (/** @type {string} */ path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const LEDGER = { sha: 'abc1234', tests: 900, failures: 0 };

// ---------------------------------------------------------------- guard 1: the measured commit

test('a status file that names the ledger commit passes', () => {
  const status = '# Project status\n\n| Fact | Value |\n|---|---|\n| Measured at | `abc1234` — from site/claims.json |\n';
  assert.deepEqual(inspectStatusMeasurement(status, LEDGER), []);
});

test('a status file that names a different commit fails, and says which two disagree', () => {
  const status = '| Measured at | `deadbee` |\n';
  const failures = inspectStatusMeasurement(status, LEDGER);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /deadbee/);
  assert.match(failures[0], /abc1234/);
});

test('a status file with no measured row fails rather than passing by omission', () => {
  const failures = inspectStatusMeasurement('# Project status\n\nEverything is fine.\n', LEDGER);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /no `\| Measured at \| `<sha>` \|` row/);
});

test('two measured rows are refused: two measurements in one file is the drift itself', () => {
  const status = '| Measured at | `abc1234` |\n| Measured at | `abc1234` |\n';
  const failures = inspectStatusMeasurement(status, LEDGER);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /2 "Measured at" rows/);
});

test('an unusable ledger fails the binding rather than being skipped', () => {
  const status = '| Measured at | `abc1234` |\n';
  assert.equal(inspectStatusMeasurement(status, undefined).length, 1);
  assert.equal(inspectStatusMeasurement(status, { sha: 'not-a-sha' }).length, 1);
});

test('the real files satisfy the binding', () => {
  const ledger = JSON.parse(read('site/claims.json'));
  assert.deepEqual(inspectStatusMeasurement(read('docs/PROJECT_STATUS.md'), ledger.measuredAgainst), []);
});

// ---------------------------------------------------------------- guard 2: no typed counts under docs/

test('a typed count in a scanned document is found', () => {
  assert.deepEqual(
    findLooseTestCounts('the suite runs 936 tests on every push'),
    [{ line: 1, phrase: '936 tests' }],
  );
});

test('a hyphenated identifier is not a count — "the ADR-018 test for what core owns"', () => {
  assert.deepEqual(findLooseTestCounts('vocabulary and is the ADR-018 test for what core owns'), []);
});

test('a price is not a count — "a €500 test on conversion"', () => {
  assert.deepEqual(findLooseTestCounts('Revisit at that point with a €500 test on conversion'), []);
  assert.deepEqual(findLooseTestCounts('a $500 test'), []);
});

test('the measured token is still the sanctioned way to state one', () => {
  assert.deepEqual(findLooseTestCounts('{{measured.tests}} tests passing'), []);
});

test('grouped thousands are still caught', () => {
  assert.deepEqual(findLooseTestCounts('1,024 tests'), [{ line: 1, phrase: '1,024 tests' }]);
});

test('dated history is exempt by an explicit list, and everything else under docs/ is scanned', () => {
  assert.equal(scansForLooseCounts('docs/PROJECT_STATUS.md'), true);
  assert.equal(scansForLooseCounts('docs/benchmarks/CRM_JTBD_MATRIX.md'), true);
  assert.equal(scansForLooseCounts('docs/strategy/RECOMMENDATION_MAP.md'), true);
  assert.equal(scansForLooseCounts('docs/plans/dx6-scenario-runner.md'), false);
  assert.equal(scansForLooseCounts('docs/RENAME_SURFACE.md'), false);
  assert.equal(scansForLooseCounts('docs/strategy/AGENT_RECOMMENDATION.md'), false);
  // A directory entry matches by prefix; a file entry matches exactly, so a
  // neighbouring name cannot inherit the exemption.
  assert.equal(scansForLooseCounts('docs/RENAME_SURFACE_NOTES.md'), true);
});

test('the exemption list stays short enough to read, and every entry is a real path', () => {
  assert.ok(DATED_HISTORY.length <= 6, 'an exemption list nobody reads is an exemption list that hides drift');
  for (const entry of DATED_HISTORY) {
    const path = new URL(`../${entry}`, import.meta.url);
    assert.ok(existsSync(path), `${entry} is exempted but does not exist`);
    assert.equal(
      statSync(path).isDirectory(),
      entry.endsWith('/'),
      `${entry} is listed as ${entry.endsWith('/') ? 'a directory' : 'a file'} and is not one`,
    );
  }
});

// ---------------------------------------------------------------- what neither guard checks
//
// Stated as a test so it is a decision rather than an omission:
//
//  * Neither reads prose. The binding compares two literal strings; the scan matches a
//    numeric pattern. Nothing here infers whether a sentence is true, and a status file
//    can be wholly wrong in every other row and still pass.
//  * Neither is a public agent command. There is no `accordo status`, no new namespace and
//    no addition to the surface budget — both run inside `npm run gtm:check`.
//  * Neither checks any repository but this one. A generated project carries no
//    PROJECT_STATUS.md and no ledger.
//  * The staleness of the *count* is still advisory, not fatal: `inspectProvenance` notes
//    that the corpus moved and does not fail. Making it fatal would block every PR that
//    adds a test until it re-measured, which is a worse failure than a note.
