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
import { appendEntry, readRecord, summarise } from '../benchmarks/harness/record.js';

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

test('G3 refuses a project that only names the boundary without asserting it', () => {
  // This case used to PASS and earn the protocol's largest weight. Two test names containing the
  // right digits satisfied a substring search, so an untouched scaffold plus this file scored 60
  // of 75 with no CRM built. It is pinned here as a failure because that is the defect.
  const directory = makeRun({ promptId: 'P02', project: true });
  try {
    writeFileSync(
      join(directory, 'project', 'approval.test.js'),
      "import test from 'node:test';\n"
      + "test('2499900 goes straight through', () => {});\n"
      + "test('2500000 waits for a human', () => {});\n",
    );
    const result = scoreRun(directory);
    // No non-test source states the boundary, so the scorer has nothing to perturb and says so
    // rather than guessing in either direction.
    assert.equal(gate(result, 'G3').outcome, 'needs-operator');
    assert.equal(gate(result, 'G3').earned, 0);
    assert.match(gate(result, 'G3').why, /cannot find the rule to perturb/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('G3 fails a suite that stays green when the rule it claims to test is moved', { timeout: 300_000 }, () => {
  const directory = makeRun({ promptId: 'P02', project: true });
  const projectDir = join(directory, 'project');
  try {
    // A rule in source, and a test that names the boundary while asserting nothing about it.
    writeFileSync(join(projectDir, 'policy.js'), 'export const APPROVAL_THRESHOLD_CENTS = 2500000;\nexport const JUST_UNDER = 2499900;\n');
    writeFileSync(
      join(projectDir, 'approval.test.js'),
      "import test from 'node:test';\n"
      + "test('threshold is 2500000 and 2499900 is below it', () => {});\n",
    );
    writeFileSync(join(projectDir, 'package.json'), `${JSON.stringify({
      name: 'g3-mention-only', private: true, type: 'module',
      scripts: { test: 'node --test' },
    }, null, 2)}\n`);

    const result = scoreRun(directory);
    assert.equal(gate(result, 'G3').outcome, 'fail');
    assert.equal(gate(result, 'G3').earned, 0);
    assert.match(gate(result, 'G3').why, /left the suite green/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('G3 passes a suite that goes red when the boundary moves', { timeout: 300_000 }, () => {
  const directory = makeRun({ promptId: 'P02', project: true });
  const projectDir = join(directory, 'project');
  try {
    writeFileSync(join(projectDir, 'policy.js'), 'export const APPROVAL_THRESHOLD_CENTS = 2500000;\n');
    writeFileSync(
      join(projectDir, 'approval.test.js'),
      "import test from 'node:test';\n"
      + "import assert from 'node:assert/strict';\n"
      + "import { APPROVAL_THRESHOLD_CENTS } from './policy.js';\n"
      + "test('2500000 needs approval and 2499900 does not', () => {\n"
      + "  assert.equal(APPROVAL_THRESHOLD_CENTS, 2500000);\n"
      + "  assert.ok(2499900 < APPROVAL_THRESHOLD_CENTS);\n"
      + '});\n',
    );
    writeFileSync(join(projectDir, 'package.json'), `${JSON.stringify({
      name: 'g3-asserted', private: true, type: 'module',
      scripts: { test: 'node --test' },
    }, null, 2)}\n`);

    const result = scoreRun(directory);
    assert.equal(gate(result, 'G3').outcome, 'pass');
    assert.equal(gate(result, 'G3').earned, 25);
    assert.match(gate(result, 'G3').why, /asserted, not merely mentioned/);
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

test('G2 stays unjudged until an operator records a verdict, and the verdict is what decides it', () => {
  // The half that was missing. G2 refuses to judge whether a composed model answers the brief —
  // correctly — but until now there was nowhere for the human's answer to go, so every run was
  // permanently unscoreable and the instrument could not emit the verdict it exists to emit.
  const composed = { modules: 3, resources: 2, actions: 4, composed: 9 };
  const directory = makeRun({ promptId: 'P02', project: true });
  try {
    writeFileSync(join(directory, 'project', 'package.json'), '{"name":"x","private":true}\n');

    const unjudged = readRecord(directory);
    assert.deepEqual(unjudged.verdicts, [], 'a record written before verdicts existed still reads');

    const { entry } = appendEntry(
      directory, 'verdict', 'Lead, Deal and the approval object are all present and named as the brief names them.',
      () => '2026-08-20T00:00:00.000Z', 'pass', () => composed,
    );
    assert.equal(entry.gate, 'G2');
    assert.deepEqual(entry.observed, composed, 'the verdict records what was judged, not just that it was');

    const record = readRecord(directory);
    assert.equal(record.verdicts.length, 1);
    assert.match(summarise(record), /G2 pass \(operator\)/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a verdict cannot overrule a mechanical failure, and cannot be recorded against nothing', () => {
  const directory = makeRun({ promptId: 'P02', project: true });
  try {
    // No CLI, so G2 fails mechanically. The operator adjudicates only what the scorer left open.
    assert.throws(
      () => appendEntry(directory, 'verdict', 'looks right to me', () => 'now', 'pass', () => null),
      /composes nothing this scorer can read/,
    );
    assert.throws(
      () => appendEntry(directory, 'verdict', 'looks right to me', () => 'now', 'pass',
        () => ({ modules: 0, resources: 0, actions: 0, composed: 0 })),
      /composes nothing this scorer can read/,
    );
    // And an outcome is not optional: "verdict" without pass|fail is a note, not a judgement.
    assert.throws(
      () => appendEntry(directory, 'verdict', 'unsure', () => 'now', undefined, () => ({ modules: 1, resources: 1, actions: 1, composed: 3 })),
      /a verdict needs an outcome/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a verdict recorded against a different composition goes stale rather than travelling', () => {
  const directory = makeRun({ promptId: 'P02', project: true });
  try {
    writeFileSync(join(directory, 'run.json'), `${JSON.stringify({
      runId: 'stale-run', promptId: 'P02', edition: 'L', frameworkSha: 'x',
      agentProduct: 'a', modelVersion: 'm', interventions: [], approvals: [],
      verdicts: [{
        at: '2026-08-20T00:00:00.000Z', gate: 'G2', outcome: 'pass',
        reason: 'judged when the project had a Deal object',
        observed: { modules: 99, resources: 99, actions: 99, composed: 297 },
      }],
    }, null, 2)}\n`);

    const result = scoreRun(directory);
    // The project here composes nothing readable, so the mechanical failure still wins — which is
    // itself the first rule. The stale path is asserted directly below.
    assert.equal(gate(result, 'G2').outcome, 'fail');
    assert.equal(gate(result, 'G2').earned, 0);
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
