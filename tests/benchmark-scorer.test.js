// @ts-check

/**
 * The Edition L scorer, proven against material that already exists.
 *
 * A scorer nobody has watched fail is a scorer nobody should trust, so every gate is exercised
 * in both directions: a run that should earn it, and a mutation of that same run that should
 * lose it. The mutations are the point of the file.
 *
 * G2 and G4 need a real composed project, which takes about six seconds to build (the starter
 * installer, the same one `npm run tour` uses). Those tests build one; the rest work on cheap
 * fixtures.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { scoreRun, boundaryTokens, EDITION_L_GATES, EDITION_L_TOTAL } from '../benchmarks/harness/score.js';

/** @param {any} result @param {string} id */
const gate = (result, id) => result.gates.find((/** @type {any} */ entry) => entry.id === id);

/**
 * A run directory with a record and whatever project content the caller adds.
 * @param {object} options
 */
function makeRun({ interventions = [], promptId = 'P02', project = null } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'accordo-score-'));
  writeFileSync(join(directory, 'run.json'), `${JSON.stringify({
    runId: 'test-run',
    promptId,
    edition: 'L',
    frameworkSha: 'testsha',
    agentProduct: 'test-agent',
    modelVersion: 'test-model',
    interventions,
    approvals: [],
  }, null, 2)}\n`);
  if (project) mkdirSync(join(directory, 'project'), { recursive: true });
  return directory;
}

test('the weights are the protocol weights, unrenormalised, summing to 75', () => {
  assert.deepEqual(EDITION_L_GATES.map((g) => g.weight), [25, 15, 25, 10]);
  assert.equal(EDITION_L_TOTAL, 75);
  // A point total is not a percentage, which is the whole reason it is a point total: it cannot
  // be quoted as a success rate, and it needs no rounding convention.
  assert.notEqual(EDITION_L_TOTAL, 100);
});

test('G1 passes on a clean record and fails on any recorded intervention', () => {
  const clean = makeRun({ interventions: [] });
  try {
    const result = scoreRun(clean);
    assert.equal(gate(result, 'G1').outcome, 'pass');
    assert.equal(gate(result, 'G1').earned, 25);
    assert.match(gate(result, 'G1').why, /attested/, 'the output must say G1 was attested, not measured');
  } finally {
    rmSync(clean, { recursive: true, force: true });
  }

  const touched = makeRun({ interventions: [{ at: '2026-08-07T10:00:00.000Z', reason: 'fixed the migration by hand' }] });
  try {
    const result = scoreRun(touched);
    assert.equal(gate(result, 'G1').outcome, 'fail');
    assert.equal(gate(result, 'G1').earned, 0);
    assert.match(gate(result, 'G1').why, /fixed the migration by hand/);
    assert.equal(result.promptPassed, false);
  } finally {
    rmSync(touched, { recursive: true, force: true });
  }
});

test('a missing record leaves G1 unjudged rather than passing it', () => {
  const directory = mkdtempSync(join(tmpdir(), 'accordo-score-'));
  try {
    const result = scoreRun(directory);
    assert.equal(gate(result, 'G1').outcome, 'needs-operator');
    assert.equal(gate(result, 'G1').earned, 0);
    assert.equal(result.scoreable, false, 'a run with an unjudged gate is not scoreable');
    assert.equal(result.promptPassed, false, 'needs-operator is never a pass');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('every report carries the Edition D blocker and the G1 attestation', () => {
  const directory = makeRun({});
  try {
    const result = scoreRun(directory);
    assert.equal(result.editionD.outcome, 'BLOCKED_NO_PRODUCTION_SPINE');
    assert.deepEqual(result.editionD.gates, ['G5', 'G6']);
    assert.match(result.attestation, /operator-attested/);
    assert.equal(result.edition, 'L');
    assert.equal(result.gateSet, 'G1-G4');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('boundary tokens are derived in integer cents, with the value below the edge', () => {
  // This framework stores money in cents, so a test proving the €25,000 boundary says 2500000.
  assert.deepEqual(boundaryTokens('deals above €25,000 must be approved'), ['2500000', '2499900']);
  assert.deepEqual(boundaryTokens('over €10k'), ['1000000', '999900']);
  assert.deepEqual(boundaryTokens('no numeric boundary here'), []);
});

test('G3 fails a project whose tests never assert the stated boundary', () => {
  const directory = makeRun({ promptId: 'P02', project: true });
  try {
    // A test file that exists, is plausible, and never goes near €25,000.
    writeFileSync(
      join(directory, 'project', 'deal.test.js'),
      "import test from 'node:test';\ntest('a deal can be created', () => {});\n",
    );
    const result = scoreRun(directory);
    assert.equal(gate(result, 'G3').outcome, 'fail');
    assert.match(gate(result, 'G3').why, /2500000/, 'the failure must name the boundary that was missing');
    assert.match(gate(result, 'G3').why, /never test/, 'and must say why a green suite is not enough');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('G3 passes when the boundary and the value below it are both asserted', () => {
  const directory = makeRun({ promptId: 'P02', project: true });
  try {
    writeFileSync(
      join(directory, 'project', 'approval.test.js'),
      "import test from 'node:test';\n"
      + "test('2499900 goes straight through', () => {});\n"
      + "test('2500000 waits for a human', () => {});\n",
    );
    const result = scoreRun(directory);
    assert.equal(gate(result, 'G3').outcome, 'pass');
    assert.equal(gate(result, 'G3').earned, 25);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('G3 asks for an operator when the prompt states no boundary to check', () => {
  // P01 is the plain pipeline brief: real work, no numeric edge to assert.
  const directory = makeRun({ promptId: 'P01', project: true });
  try {
    writeFileSync(join(directory, 'project', 'a.test.js'), "import test from 'node:test';\ntest('x', () => {});\n");
    const result = scoreRun(directory);
    assert.equal(gate(result, 'G3').outcome, 'needs-operator');
    assert.equal(gate(result, 'G3').earned, 0, 'an unjudged gate earns nothing');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('G2 and G4 fail an empty project rather than asking for an operator', () => {
  const directory = makeRun({ promptId: 'P02', project: true });
  try {
    const result = scoreRun(directory);
    assert.equal(gate(result, 'G2').outcome, 'fail', 'nothing composed is a failure, not a question');
    assert.equal(gate(result, 'G4').outcome, 'fail', 'no package.json is a failure, not a question');
    assert.equal(result.points, 25, 'only G1 earns on an otherwise empty run');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('G2 reads a real composed application and refuses to judge the brief', { timeout: 300_000 }, (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'accordo-score-real-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const projectDir = join(directory, 'project');
  const install = spawnSync(
    process.execPath,
    ['--no-warnings', join(process.cwd(), 'examples/starters/b2b-lead-qualification/install.mjs')],
    { encoding: 'utf8', env: { ...process.env, ACCORDO_KEEP_ROOT: projectDir }, cwd: process.cwd(), timeout: 280_000 },
  );
  assert.equal(install.status, 0, `the starter installer must succeed to build a scoreable run: ${install.stderr}`);

  writeFileSync(join(directory, 'run.json'), `${JSON.stringify({
    runId: 'real-run', promptId: 'P02', edition: 'L', frameworkSha: 'testsha',
    agentProduct: 'test-agent', modelVersion: 'test-model', interventions: [], approvals: [],
  }, null, 2)}\n`);

  const result = scoreRun(directory);
  assert.equal(gate(result, 'G2').outcome, 'needs-operator', 'a composed app is not proof it matches the brief');
  assert.match(gate(result, 'G2').why, /Composed \d+ modules/);
  assert.match(gate(result, 'G2').why, /judgement this scorer does not make/);
  assert.equal(result.scoreable, false, 'a run with an unjudged gate is not scoreable');
});
