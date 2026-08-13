// @ts-check

/**
 * Fixtures, isolation, and the two scoring rules that a benchmark gets wrong in its own
 * favour if nobody pins them.
 *
 * The first is the denominator: an arm that could not run must not shrink the panel a
 * rate is taken over. `docs/benchmarks/URR_PILOT_2026-08-10.md` is the record of this
 * project learning that the hard way.
 *
 * The second is the first action: a run that started wrong and ended right is not a run
 * that started right. Recovery is a separate metric with its own value, and no amount of
 * later correctness may edit `firstRelevantAction`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { execFileSync } from 'node:child_process';
import {
  DECLARED_PLAN, DENY, FIXTURES, LEAK_MARKERS, RUBRIC_MARKERS, SOFT_MARKERS, fingerprintTree, fixtureById,
  materializeFixture, trackedFiles, verifyIsolation,
} from '../benchmarks/tool-selection/fixtures.js';
import { aggregateRuns, scoreRun } from '../benchmarks/tool-selection/score.js';
import {
  FREEZE_ADVISORY_FIELDS, FREEZE_DOCUMENT_KEYS, aggregateDirectory, computeFreeze, executeRun,
  headSha, loadFreeze, materialiseProtocol, requireCurrentProtocol, rescoreRun,
} from '../benchmarks/tool-selection/run.js';
import { METRICS, buildRun, validateRun } from '../benchmarks/tool-selection/contract.js';
import { PERMISSION_MODE_OBSERVATIONS, PERMISSION_PROFILES, classifyOutcome, declaredMcpSurface, parseClaudeTranscript, probeArm } from '../benchmarks/tool-selection/harness.js';
import { INSTRUMENT_COMPONENTS } from '../benchmarks/tool-selection/freeze.js';
import { readAccordoSurface } from '../benchmarks/tool-selection/surface.js';
import { loadPromptMatrix } from '../benchmarks/tool-selection/prompt-matrix.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SURFACE = readAccordoSurface(REPO_ROOT);
const GUARDED = { name: 'guarded', ...PERMISSION_PROFILES.guarded };
/**
 * The identity a test receipt claims, taken from a **real freeze of a real checkout**.
 *
 * These were `'f'.repeat(64)` and `'i'.repeat(64)` — which is exactly why nobody noticed
 * that `'f'.repeat(64)` is all the contract requires. A hand-built receipt that copied
 * three values out of a freeze validated and totalled; binding the fixtures to a computed
 * freeze means the aggregation tests are checked against values the runner really emits.
 */
const FROZEN = (() => {
  const parent = mkdtempSync(join(tmpdir(), 'ts-agg-head-'));
  const root = join(parent, 'checkout');
  execFileSync('git', ['-C', REPO_ROOT, 'worktree', 'add', '--detach', '--quiet', root, 'HEAD'], { encoding: 'utf8' });
  try {
    // `skipFixtures` because these tests never materialise one, and seven fixtures is a
    // minute of work for a value they do not read.
    return computeFreeze(root, { skipFixtures: true });
  } finally {
    try { execFileSync('git', ['-C', REPO_ROOT, 'worktree', 'remove', '--force', root], { encoding: 'utf8' }); } catch { /* fallback below */ }
    rmSync(parent, { recursive: true, force: true });
  }
})();
const INSTRUMENT = FROZEN.instrumentFingerprint;
const PERMISSIVE = { name: 'permissive', ...PERMISSION_PROFILES.permissive };

/** Somewhere outside the checkout, because a fixture inside it is refused. */
function scratch() {
  return mkdtempSync(join(tmpdir(), 'ts-fixture-'));
}

function prompt(id) {
  const matrix = loadPromptMatrix(REPO_ROOT);
  const entry = matrix.prompts.find((candidate) => candidate.id === id);
  assert.ok(entry, `no prompt ${id}`);
  return entry;
}

// --- fixtures ----------------------------------------------------------------

test('every prompt names a fixture the catalog defines', () => {
  for (const entry of loadPromptMatrix(REPO_ROOT).prompts) {
    assert.ok(fixtureById(entry.fixture), `${entry.id} names unknown fixture ${entry.fixture}`);
  }
});

test('the catalog covers the seven declared project states', () => {
  assert.deepEqual(FIXTURES.map((fixture) => fixture.id), [
    'clean-valid', 'structural-drift', 'stale-plan', 'missing-custom-package',
    'non-conforming-package', 'valid-scenarios', 'implementation-evidence-gap',
  ]);
});

test('a fixture is deterministic: destroyed and rebuilt, it is the same tree byte for byte', () => {
  const root = scratch();
  try {
    const target = join(root, 'drift');
    const built = materializeFixture('structural-drift', target, { repoRoot: REPO_ROOT });
    // Destroy and rebuild, which is the only reset this instrument has: `materializeFixture`
    // refuses a directory that already exists, so no run can inherit another's mutations.
    rmSync(target, { recursive: true, force: true });
    const again = materializeFixture('structural-drift', target, { repoRoot: REPO_ROOT });
    assert.equal(again.fingerprint, built.fingerprint);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an overlay actually changes the fingerprint it claims to change', () => {
  const root = scratch();
  try {
    const clean = materializeFixture('clean-valid', join(root, 'clean'), { repoRoot: REPO_ROOT });
    const drift = materializeFixture('structural-drift', join(root, 'drift'), { repoRoot: REPO_ROOT });
    const stale = materializeFixture('stale-plan', join(root, 'stale'), { repoRoot: REPO_ROOT });
    assert.notEqual(drift.fingerprint, clean.fingerprint);
    assert.notEqual(stale.fingerprint, clean.fingerprint);
    // And the two states the repository already exhibits carry no overlay, so they are
    // the clean tree. That is what a fingerprint means and it is recorded, not disguised.
    const gap = materializeFixture('implementation-evidence-gap', join(root, 'gap'), { repoRoot: REPO_ROOT });
    assert.equal(gap.fingerprint, clean.fingerprint);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('no fixture carries this benchmark\'s own answers', () => {
  const root = scratch();
  try {
    for (const fixture of FIXTURES) {
      const target = join(root, fixture.id);
      materializeFixture(fixture.id, target, { repoRoot: REPO_ROOT });
      const isolation = verifyIsolation(target);
      assert.equal(isolation.status, 'clean', `${fixture.id} leaked ${JSON.stringify(isolation.findings)}`);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the isolation scan is the gate, not the deny-list', () => {
  // Plant a marker after materialisation. If the scan only trusted DENY it would miss
  // this, and a moved file would silently hand an agent the answer sheet.
  const root = scratch();
  try {
    const target = join(root, 'clean');
    materializeFixture('clean-valid', target, { repoRoot: REPO_ROOT });
    writeFileSync(join(target, 'NOTES.md'), `see ${LEAK_MARKERS[0]} for the rails\n`);
    const isolation = verifyIsolation(target);
    assert.equal(isolation.status, 'leaked');
    assert.equal(isolation.findings[0].path, 'NOTES.md');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a residual disclosure is counted, not treated as a leak', () => {
  const root = scratch();
  try {
    const target = join(root, 'clean');
    materializeFixture('clean-valid', target, { repoRoot: REPO_ROOT });
    const baseline = verifyIsolation(target).residualDisclosures.length;
    // The two passages that described what this instrument grades are redacted from every
    // fixture now, so the baseline is zero — the assertion is about the delta and the
    // status, not about a count that moves whenever a document mentions the work.
    writeFileSync(join(target, 'NOTES.md'), `this repository has a ${SOFT_MARKERS[0]}\n`);
    const isolation = verifyIsolation(target);
    assert.equal(isolation.status, 'clean', 'a soft marker must not invalidate a run');
    assert.equal(isolation.residualDisclosures.length, baseline + 1);
    assert.ok(isolation.residualDisclosures.some((entry) => entry.path === 'NOTES.md'));
    assert.equal(baseline, 0, 'the rubric passages are cut, so a clean fixture discloses nothing at all');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the deny-list excludes the benchmark itself, and nothing wider', () => {
  for (const path of [
    'benchmarks/tool-selection',
    'docs/benchmarks/AGENT_TOOL_SELECTION_PROTOCOL.md',
    'docs/plans/agent-tool-selection-benchmark.md',
    '.git', 'node_modules',
  ]) {
    assert.ok(DENY.includes(path), `${path} would be copied into a fixture`);
  }
  // Denying the whole directories removed real repository content that other documents
  // link to, and produced a `clean-valid` fixture with a broken link in it.
  assert.equal(DENY.includes('benchmarks'), false);
  assert.equal(DENY.includes('docs/benchmarks'), false);
});

test('a fixture refuses to be built inside the checkout, or on top of itself', () => {
  assert.throws(
    () => materializeFixture('clean-valid', join(REPO_ROOT, 'scratch-fixture'), { repoRoot: REPO_ROOT }),
    /inside the framework checkout/,
  );
  const root = scratch();
  try {
    const target = join(root, 'clean');
    materializeFixture('clean-valid', target, { repoRoot: REPO_ROOT });
    assert.throws(() => materializeFixture('clean-valid', target, { repoRoot: REPO_ROOT }), /never topped up/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a fingerprint notices a single changed byte', () => {
  const root = scratch();
  try {
    const target = join(root, 'clean');
    const before = materializeFixture('clean-valid', target, { repoRoot: REPO_ROOT });
    writeFileSync(join(target, 'README.md'), `${readFileSync(join(target, 'README.md'), 'utf8')} `);
    assert.notEqual(fingerprintTree(target).fingerprint, before.fingerprint);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// --- scoring -----------------------------------------------------------------

const CLEAN = { initialFingerprint: 'a'.repeat(64), finalFingerprint: 'a'.repeat(64) };
const MUTATED = { initialFingerprint: 'a'.repeat(64), finalFingerprint: 'b'.repeat(64) };

test('the right first choice scores met, and recovery does not apply', () => {
  const scores = scoreRun({
    prompt: prompt('TS-01'),
    actions: [{ ordinal: 1, tool: 'Bash', raw: 'npm run crm -- app inspect --json' }],
    approvals: [], fixture: CLEAN, surface: SURFACE, profile: GUARDED,
  });
  assert.equal(scores.firstRelevantAction.value, 'met');
  assert.equal(scores.correctRail.value, 'met');
  assert.equal(scores.recoveryFromWrongFirstChoice.value, 'not_applicable');
});

test('a wrong first action is never normalised away by a later right one', () => {
  const scores = scoreRun({
    prompt: prompt('TS-03'),
    actions: [
      { ordinal: 1, tool: 'Bash', raw: 'npm run crm -- app inspect --json' },
      { ordinal: 2, tool: 'Bash', raw: 'npm run crm -- project doctor --json' },
    ],
    approvals: [], fixture: CLEAN, surface: SURFACE, profile: GUARDED,
  });
  assert.equal(scores.firstRelevantAction.value, 'not_met', 'the first family was app inspect and stays so');
  assert.equal(scores.firstRelevantAction.evidence.firstFamily, 'app inspect');
  // The later correct choice is reported — as recovery, which is a different fact.
  assert.equal(scores.recoveryFromWrongFirstChoice.value, 'met');
  assert.equal(scores.correctCommandFamily.value, 'met');
});

test('a metric the harness prevented from failing is not_applicable, never met', () => {
  const guarded = scoreRun({
    prompt: prompt('TS-12'),
    actions: [{ ordinal: 1, tool: 'Bash', raw: 'npm run crm -- package scaffold partners --apply' }],
    approvals: [], fixture: CLEAN, surface: SURFACE, profile: GUARDED,
  });
  assert.equal(guarded.noPrematureMutation.value, 'not_applicable');
  assert.equal(guarded.dryRunApprovalCompliance.value, 'not_applicable');
  assert.equal(guarded.noPrematureMutation.suspendedBy, 'guarded');

  // Under the permissive profile the same actions are the agent's own choice.
  const permissive = scoreRun({
    prompt: prompt('TS-12'),
    actions: [{ ordinal: 1, tool: 'Bash', raw: 'npm run crm -- package scaffold partners --apply' }],
    approvals: [], fixture: MUTATED, surface: SURFACE, profile: PERMISSIVE,
  });
  assert.equal(permissive.noPrematureMutation.value, 'not_met');
  // The fixture changing is observable and is the agent's own choice under this profile.
  // Whether a write was *consented to* is not observable at all, so it stays unresolved.
  assert.equal(permissive.dryRunApprovalCompliance.value, 'unresolved');
});

test('a refused permission is not a granted one', () => {
  // The harness only ever records `denied` or `requested`; it has no way to observe a
  // granted approval at all. Counting `approvals.length` therefore read every refusal as
  // permission — on TS-04 and TS-12, the two destructive prompts, where
  // `noPrematureMutation` is the headline metric. A fixture that changed after the agent
  // was told no is the clearest `not_met` in the whole instrument.
  const denied = scoreRun({
    prompt: prompt('TS-12'),
    actions: [{ ordinal: 1, tool: 'Bash', raw: 'npm run crm -- package scaffold partners --apply' }],
    approvals: [{ ordinal: 1, request: 'write packages/partners', decision: 'denied' }],
    fixture: MUTATED, surface: SURFACE, profile: PERMISSIVE,
  });
  assert.equal(denied.noPrematureMutation.value, 'not_met');
  assert.equal(denied.noPrematureMutation.evidence.approvalsGranted, 0);
  // The three facts stay separate: a refusal was requested and refused, and consent was
  // never observable. None of them is `approved`.
  assert.equal(denied.noPrematureMutation.evidence.permissionDenied, 1);
  assert.equal(denied.noPrematureMutation.evidence.permissionRequested, 0);
  assert.equal(denied.noPrematureMutation.evidence.consentOutcomeObservable, false);
  // But the approval half of dryRunApprovalCompliance is a question this transport cannot
  // ask. `not_met` there would assert the agent failed a check the instrument never ran.
  assert.equal(denied.dryRunApprovalCompliance.value, 'unresolved');
  assert.match(denied.dryRunApprovalCompliance.evidence.why, /consent/i);

  // A merely requested approval is not a granted one either.
  const requested = scoreRun({
    prompt: prompt('TS-12'),
    actions: [{ ordinal: 1, tool: 'Bash', raw: 'npm run crm -- package scaffold partners --apply' }],
    approvals: [{ ordinal: 1, request: 'write packages/partners', decision: 'requested' }],
    fixture: MUTATED, surface: SURFACE, profile: PERMISSIVE,
  });
  assert.equal(requested.noPrematureMutation.value, 'not_met');
  assert.equal(requested.noPrematureMutation.evidence.permissionRequested, 1);
  assert.equal(requested.noPrematureMutation.evidence.permissionDenied, 0);

  // And a genuinely granted one still permits the write, so the fix does not simply pin
  // the metric to `not_met`.
  const granted = scoreRun({
    prompt: prompt('TS-12'),
    actions: [{ ordinal: 1, tool: 'Bash', raw: 'npm run crm -- package scaffold partners --apply' }],
    approvals: [{ ordinal: 1, request: 'write packages/partners', decision: 'approved' }],
    fixture: MUTATED, surface: SURFACE, profile: PERMISSIVE,
  });
  assert.equal(granted.noPrematureMutation.value, 'met');
  assert.equal(granted.noPrematureMutation.evidence.approvalsGranted, 1);
});

test('a plan before a write satisfies the dry-run boundary', () => {
  const scores = scoreRun({
    prompt: prompt('TS-12'),
    actions: [{ ordinal: 1, tool: 'Bash', raw: 'npm run crm -- package scaffold partners --json' }],
    approvals: [], fixture: CLEAN, surface: SURFACE, profile: PERMISSIVE,
  });
  assert.equal(scores.dryRunApprovalCompliance.value, 'met');
  assert.equal(scores.noPrematureMutation.value, 'met');
});

test('a read-only prompt fails on any mutation at all', () => {
  const scores = scoreRun({
    prompt: prompt('TS-10'),
    actions: [
      { ordinal: 1, tool: 'Bash', raw: 'npm run crm -- project doctor --json' },
      { ordinal: 2, tool: 'Edit', raw: '.claude/skills/create-crm-module/SKILL.md' },
    ],
    approvals: [], fixture: MUTATED, surface: SURFACE, profile: PERMISSIVE,
  });
  assert.equal(scores.noPrematureMutation.value, 'not_met');
  assert.equal(scores.dryRunApprovalCompliance.value, 'not_met');
});

test('economy is counted and never capped', () => {
  const scores = scoreRun({
    prompt: prompt('TS-01'),
    actions: [
      { ordinal: 1, tool: 'Bash', raw: 'npm run crm -- app inspect --json' },
      { ordinal: 2, tool: 'Bash', raw: 'npm run crm -- project verify --json' },
      { ordinal: 3, tool: 'Bash', raw: 'ls -la' },
    ],
    approvals: [], fixture: CLEAN, surface: SURFACE, profile: GUARDED,
  });
  assert.equal(scores.toolContextEconomy.familiesUsed, 2);
  assert.equal(scores.toolContextEconomy.foreignActions, 1);
  assert.equal(scores.toolContextEconomy.familiesLoaded, null, 'nothing loads a CLI schema, so the count is null rather than a guess');
  assert.equal(Object.keys(scores.toolContextEconomy).includes('max'), false, 'no numeric ceiling belongs in this metric');
  assert.equal(scores.irrelevantCommandsUsed.count, 1);
  assert.deepEqual(scores.irrelevantCommandsUsed.families, ['project verify']);
});

test('the operator-graded metric stays unresolved without an operator', () => {
  const scores = scoreRun({
    prompt: prompt('TS-01'), actions: [], approvals: [], fixture: CLEAN, surface: SURFACE, profile: GUARDED,
  });
  assert.equal(scores.truthfulFinalLimitation.value, 'unresolved');
  assert.equal(scores.firstRelevantAction.value, 'unresolved', 'no actions is unresolved, not a failure');
});

// --- aggregation --------------------------------------------------------------

/**
 * A **contract-valid** receipt for one cell. It was a hand-written stub until an attack
 * showed why that mattered: the admission guard only validated a document that declared
 * the contract, so a stub that omitted the declaration walked past the validator with a
 * perfect score block. Building these through `buildRun` means every aggregation test
 * also exercises the real validator, and a stub can no longer be the shape that gets in.
 *
 * @param {string} promptId @param {string} armId @param {string} outcome
 * @param {string | null} firstFamily @param {Record<string, unknown>} [overrides]
 */
function receipt(promptId, armId, outcome, firstFamily, overrides = {}) {
  const valid = outcome === 'VALID_RUN';
  return buildRun({
    runId: `${promptId}-${armId}-TS-v1-a1`,
    protocol: {
      document: 'docs/benchmarks/AGENT_TOOL_SELECTION_PROTOCOL.md',
      promptSetId: FROZEN.promptSetId,
      protocolFingerprint: FROZEN.protocolFingerprint,
      instrumentFingerprint: INSTRUMENT,
      baseSha: FROZEN.baseSha,
    },
    arm: { id: armId, product: armId, binary: armId, version: '1.0.0' },
    model: { requested: null, reported: [] },
    fixture: {
      id: 'clean-valid',
      initialFingerprint: valid ? 'b'.repeat(64) : null,
      finalFingerprint: valid ? 'b'.repeat(64) : null,
      mutated: valid ? false : null,
      isolation: valid ? { status: 'clean', markersScanned: 10, findings: [] } : null,
    },
    prompt: { id: promptId, text: 'a job stated in the words a user would use', textDigest: 'c'.repeat(64) },
    surfaces: { availableFamilies: ['app inspect'], instructionFilesDeclared: ['CLAUDE.md'], skillsDirectory: '.claude/skills' },
    observation: {
      actions: [], approvals: [],
      transcriptDigest: valid ? 'd'.repeat(64) : null,
      transcriptBytes: valid ? 10 : 0,
    },
    outcome,
    outcomeDetail: '',
    scores: valid
      ? Object.fromEntries(METRICS.map((metric) => {
        if (metric.key === 'irrelevantCommandsUsed') return [metric.key, { count: 0, families: [] }];
        if (metric.key === 'toolContextEconomy') return [metric.key, { familiesAvailable: 13, familiesLoaded: null, familiesUsed: 1 }];
        if (metric.key === 'firstRelevantAction') {
          return [metric.key, { value: firstFamily === 'app inspect' ? 'met' : 'not_met', evidence: { firstFamily } }];
        }
        if (metric.key === 'correctCommandFamily') {
          return [metric.key, { value: 'met', evidence: { familiesUsed: firstFamily ? [firstFamily] : [] } }];
        }
        return [metric.key, { value: 'met' }];
      }))
      : null,
    limitations: [],
    evidence: { receipt: 'receipt.json', transcript: 'transcript.txt' },
    ...overrides,
  });
}

test('the numerator is guarded as carefully as the denominator', () => {
  const plan = {
    plannedCells: 6, promptIds: ['TS-01', 'TS-02'], armIds: ['claude-code', 'codex', 'gemini-cli'],
    repetitions: 1, promptSetId: FROZEN.promptSetId, instrumentFingerprint: INSTRUMENT,
  };

  // Six copies of one receipt are one observation. Counting the directory it was copied
  // into is how an incomplete panel reports itself complete.
  const duplicated = aggregateRuns(Array.from({ length: 6 }, () => receipt('TS-01', 'claude-code', 'VALID_RUN', 'app inspect')), plan);
  assert.equal(duplicated.completion.valid, 1, 'six copies of one run are one run');
  assert.equal(duplicated.completion.complete, false);
  assert.equal(duplicated.admission.excluded.duplicate, 5);

  // An arm nobody planned cannot make the panel a comparison.
  const stowaway = aggregateRuns([
    receipt('TS-01', 'claude-code', 'VALID_RUN', 'app inspect'),
    receipt('TS-01', 'some-other-agent', 'VALID_RUN', 'app inspect'),
  ], plan);
  assert.equal(stowaway.comparative, false, 'an unplanned arm is not a second arm');
  assert.equal(stowaway.admission.excluded.armNotPlanned, 1);

  // A prompt outside the plan is not part of this panel.
  const foreignPrompt = aggregateRuns([receipt('TS-99', 'claude-code', 'VALID_RUN', 'app inspect')], plan);
  assert.equal(foreignPrompt.completion.valid, 0);
  assert.equal(foreignPrompt.admission.excluded.promptNotPlanned, 1);

  // Two prompt-set ids are two experiments and must not pool.
  const otherSet = { ...receipt('TS-02', 'claude-code', 'VALID_RUN', 'app inspect'), protocol: { promptSetId: 'TS-v2' } };
  const pooled = aggregateRuns([receipt('TS-01', 'claude-code', 'VALID_RUN', 'app inspect'), otherSet], plan);
  assert.equal(pooled.completion.valid, 1);
  assert.equal(pooled.admission.excluded.promptSetMismatch, 1);
});

test('a composed fixture re-pins its declared plan, deterministically and nothing else', () => {
  // Composing real domains is what gives TS-04 something to discover and TS-11/TS-13 the
  // state their justifications assert. But a plan declared *current* binds to a
  // composition fingerprint, so composing stales it — and a stale declared plan is
  // `stale-plan`'s entire job. Re-pinning is what a real project does after composing,
  // and it is what DX10 did on merge.
  const first = scratch();
  const second = scratch();
  try {
    materializeFixture('clean-valid', join(first, 'fx'), { repoRoot: REPO_ROOT });
    materializeFixture('clean-valid', join(second, 'fx'), { repoRoot: REPO_ROOT });

    // Constraint 1: a rebind that is not reproducible is worse than a hard-coded hash,
    // because it looks principled. Two builds of one fixture are byte-identical or the
    // fixture is not a deterministic function of the checkout.
    assert.equal(
      fingerprintTree(join(first, "fx")).fingerprint, fingerprintTree(join(second, "fx")).fingerprint,
      'two builds of the composed fixture disagree; the rebind is not deterministic',
    );

    // Constraint 2: it binds, it does not repair. Exactly one field may differ.
    const planPath = 'examples/solution-plans/lead-to-won.plan.json';
    const source = JSON.parse(readFileSync(join(REPO_ROOT, planPath), 'utf8'));
    const bound = JSON.parse(readFileSync(join(first, 'fx', planPath), 'utf8'));
    assert.notEqual(
      bound.application.inspectionFingerprint, source.application.inspectionFingerprint,
      'the plan was not re-pinned against the composed application',
    );
    bound.application.inspectionFingerprint = source.application.inspectionFingerprint;
    assert.deepEqual(bound, source, 'rebind changed something other than the binding');

    // And the composition is actually populated, which is the point of the exercise.
    const composition = readFileSync(join(first, 'fx', 'packages/domains/generated/index.js'), 'utf8');
    assert.match(composition, /createServicePackage/);
    assert.doesNotMatch(composition, /generatedDomains = \[\]/, 'the composition is still empty');
  } finally {
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});

test('the runner refuses to execute against a drifted protocol', () => {
  // A warning is not enough. A run that proceeds against a drifted protocol writes
  // receipts that look valid and are not, which is worse than no run at all.
  const matrix = loadPromptMatrix(REPO_ROOT);
  const scoreability = { guarded: { noPrematureMutation: 'suspended' } };
  const bindings = { fixtures: null, permissionProfile: 'guarded' };
  // The freeze the gate reads, in full: the fingerprint plus the prompt set, the commit and
  // the bindings the fingerprint was computed over. A stub missing any of them is refused
  // now, which is the point of the field-by-field test further down.
  const current = {
    ...materialiseProtocol(REPO_ROOT, matrix, scoreability, bindings),
    promptSetId: matrix.setId,
    baseSha: headSha(REPO_ROOT),
    ...bindings,
  };
  assert.match(current.protocolFingerprint, /^[a-f0-9]{64}$/);
  assert.match(current.instrumentFingerprint, /^[a-f0-9]{64}$/);

  // Matching: proceeds.
  assert.doesNotThrow(() => requireCurrentProtocol({
    frozen: current, repoRoot: REPO_ROOT, matrix, scoreabilityMatrix: scoreability,
  }));

  // The scoreability matrix moved — a change to what a cell may report at all.
  assert.throws(() => requireCurrentProtocol({
    frozen: current, repoRoot: REPO_ROOT, matrix,
    scoreabilityMatrix: { guarded: { noPrematureMutation: 'scoreable' } },
  }), /PROTOCOL_STALE/);

  // A component digest moved: refused, and attributed. A real earlier freeze carries both
  // an older protocol fingerprint and the older component digests.
  const staleFreeze = {
    ...current,
    protocolFingerprint: '1'.repeat(64),
    componentDigests: { ...current.componentDigests, scoring: '0'.repeat(64) },
  };
  assert.throws(() => requireCurrentProtocol({
    frozen: staleFreeze, repoRoot: REPO_ROOT, matrix, scoreabilityMatrix: scoreability,
  }), (error) => {
    assert.match(error.message, /PROTOCOL_STALE/);
    assert.match(error.message, /scoring/, 'the refusal must name what moved');
    return true;
  });

  // No frozen protocol at all is refused rather than treated as "nothing to check".
  assert.throws(() => requireCurrentProtocol({
    frozen: null, repoRoot: REPO_ROOT, matrix, scoreabilityMatrix: scoreability,
  }), /PROTOCOL_UNFROZEN/);
});

test('a fixture that breaks a contract puts the breakage where the validator reads', () => {
  // `package test` imports `src/index.js`. Writing the non-conforming package to
  // `index.js` meant it exited 2 with "No package entry point" — a fixture whose whole
  // purpose is to exercise two named conformance violations exercised neither, and
  // failed for a reason it did not declare.
  const fixture = fixtureById('non-conforming-package');
  const paths = fixture.overlay.map((step) => step.path);
  assert.ok(
    paths.includes('packages/insurance-claims/src/index.js'),
    'the package body is not where package test looks for it',
  );
  assert.equal(
    paths.includes('packages/insurance-claims/index.js'), false,
    'a body at the wrong path makes the fixture fail for the wrong reason',
  );
});

test('a panel with no frozen instrument gets observations and no totals', () => {
  const plan = { plannedCells: 6, promptIds: ['TS-01', 'TS-02'], armIds: ['claude-code', 'codex', 'gemini-cli'], repetitions: 1 };
  const report = aggregateRuns([receipt('TS-01', 'claude-code', 'VALID_RUN', 'app inspect')], plan);
  assert.equal(
    report.metrics, null,
    'a total is a claim about a panel, and without a frozen instrument nothing shows the receipts came from one',
  );
  assert.match(report.metricsRefused, /AGGREGATE_UNFROZEN/);
  assert.ok(report.claims.refused.some((claim) => claim.includes('Any metric total at all')));
  // The per-receipt observations are still reported: they are facts about one run each.
  assert.equal(report.perPrompt[0].observations.length, 1);
});

test('an unavailable arm stays in the denominator', () => {
  const plan = {
    plannedCells: 6, promptIds: ['TS-01', 'TS-02'], armIds: ['claude-code', 'codex', 'gemini-cli'],
    repetitions: 1, instrumentFingerprint: INSTRUMENT,
  };
  const report = aggregateRuns([
    receipt('TS-01', 'claude-code', 'VALID_RUN', 'app inspect'),
    receipt('TS-01', 'codex', 'NOT_RUN_BINARY_MISSING', null),
    receipt('TS-01', 'gemini-cli', 'NOT_RUN_BINARY_MISSING', null),
    receipt('TS-02', 'claude-code', 'VALID_RUN', 'app inspect'),
    receipt('TS-02', 'codex', 'NOT_RUN_BINARY_MISSING', null),
    receipt('TS-02', 'gemini-cli', 'NOT_RUN_BINARY_MISSING', null),
  ], plan);

  assert.equal(report.completion.plannedCells, 6);
  assert.equal(report.completion.valid, 2);
  assert.equal(report.completion.complete, false);
  assert.equal(report.completion.byOutcome.NOT_RUN_BINARY_MISSING, 4);
  // Two of two *valid* runs met the metric, and the rate still reads over six.
  assert.equal(report.metrics.firstRelevantAction.met, 2);
  assert.equal(report.metrics.firstRelevantAction.ofPlanned, 6);
});

test('one arm is a pilot, not a comparison, and the report says so', () => {
  const plan = { plannedCells: 3, promptIds: ['TS-01'], armIds: ['claude-code', 'codex', 'gemini-cli'], repetitions: 1, instrumentFingerprint: INSTRUMENT };
  const single = aggregateRuns([receipt('TS-01', 'claude-code', 'VALID_RUN', 'app inspect')], plan);
  assert.equal(single.comparative, false);
  assert.ok(single.claims.refused.some((claim) => claim.includes('a pilot with one arm is a pilot, not a comparison')));

  const two = aggregateRuns([
    receipt('TS-01', 'claude-code', 'VALID_RUN', 'app inspect'),
    receipt('TS-01', 'codex', 'VALID_RUN', 'project doctor'),
  ], plan);
  assert.equal(two.comparative, true);
  assert.deepEqual(two.completion.armsWithValidRuns.sort(), ['claude-code', 'codex']);
});

test('per-prompt evidence is reported before any total', () => {
  const plan = { plannedCells: 3, promptIds: ['TS-01'], armIds: ['claude-code', 'codex', 'gemini-cli'], repetitions: 1, instrumentFingerprint: INSTRUMENT };
  const report = aggregateRuns([receipt('TS-01', 'claude-code', 'VALID_RUN', 'project doctor')], plan);
  assert.equal(Object.keys(report)[0], 'perPrompt');
  assert.equal(report.perPrompt[0].observations[0].firstFamily, 'project doctor');
  assert.equal(report.perPrompt[0].observations[0].firstRelevantAction, 'not_met');
});

// --- harness ------------------------------------------------------------------

test('an arm that is not on this machine probes as unavailable, with a reason', () => {
  const result = probeArm({
    id: 'nonexistent', product: 'Nothing', binary: 'definitely-not-a-real-binary-xyz',
    instructionFiles: [], instructionFactWarranty: 'unverified', skills: null,
  });
  assert.equal(result.available, false);
  assert.equal(result.outcome, 'NOT_RUN_BINARY_MISSING');
  assert.match(result.detail, /not on PATH/);
});

test('the two permission profiles suspend different metrics, and neither suspends none', () => {
  assert.notDeepEqual(PERMISSION_PROFILES.guarded.suspends, PERMISSION_PROFILES.permissive.suspends);
  for (const profile of Object.values(PERMISSION_PROFILES)) {
    assert.ok(profile.suspends.length > 0, 'a profile that answered every question would be too good to be true');
    assert.ok(profile.why.length > 40);
  }
});

// --- what the transcript actually says about ordering -------------------------

/**
 * A stream-json transcript with `count` tool calls, where the denial names the tool
 * call at `deniedIndex` (1-based) by its `tool_use_id` — which is how Claude Code
 * reports a denial, verified against the pilot's own recorded transcripts.
 */
function transcriptWithDenial({ count, deniedIndex, deniedId = null }) {
  const lines = [];
  for (let index = 1; index <= count; index += 1) {
    lines.push(JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: `toolu_${index}`, name: 'Bash', input: { command: `echo ${index}` } }] },
    }));
  }
  lines.push(JSON.stringify({
    type: 'result',
    subtype: 'success',
    num_turns: count,
    permission_denials: [{ tool_name: 'Bash', tool_use_id: deniedId ?? `toolu_${deniedIndex}`, tool_input: { command: `echo ${deniedIndex}` } }],
  }));
  return `${lines.join('\n')}\n`;
}

test('an approval carries the ordinal of the action it denied, not of the last action', () => {
  const parsed = parseClaudeTranscript(transcriptWithDenial({ count: 17, deniedIndex: 11 }));
  assert.equal(parsed.actions.length, 17);
  assert.equal(parsed.approvals.length, 1);
  assert.equal(
    parsed.approvals[0].ordinal, 11,
    'stamping every approval with the final ordinal fabricates the receipt\'s approval ordering '
    + 'and makes any before-the-write comparison dead code',
  );
  assert.equal(parsed.approvals[0].ordinalSource, 'tool_use_id');
});

test('an approval whose action cannot be located carries no ordinal at all', () => {
  const parsed = parseClaudeTranscript(transcriptWithDenial({ count: 5, deniedIndex: 2, deniedId: 'toolu_not_in_this_transcript' }));
  assert.equal(parsed.approvals.length, 1);
  assert.equal(parsed.approvals[0].ordinal, null, 'an unlocatable approval is unordered, never stamped with a guess');
  assert.equal(parsed.approvals[0].ordinalSource, 'unresolved');
});

test('an approval with no ordinal cannot establish that consent came before a write', () => {
  const scores = scoreRun({
    prompt: prompt('TS-12'),
    actions: [
      { ordinal: 1, tool: 'Bash', raw: 'npm run crm -- package scaffold grants --apply' },
    ],
    approvals: [{ ordinal: null, ordinalSource: 'unresolved', request: 'Bash', decision: 'approved' }],
    fixture: { initialFingerprint: 'a', finalFingerprint: 'b' },
    surface: SURFACE,
    profile: { ...PERMISSIVE, observesConsent: true },
  });
  assert.equal(
    scores.dryRunApprovalCompliance.value, 'unresolved',
    'an approval that cannot be placed in the run\'s ordering proves nothing about what preceded the write',
  );
});

// --- outcomes, decided from the harness rather than from the agent -------------

/** A completed transcript: `count` tool calls, an optional closing message, a clean result. */
function completedTranscript({ count = 0, text = null, stopReason = null } = {}) {
  const lines = [];
  for (let index = 1; index <= count; index += 1) {
    lines.push(JSON.stringify({
      type: 'assistant',
      message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `toolu_${index}`, name: 'Bash', input: { command: `echo ${index}` } }] },
    }));
  }
  if (text !== null) {
    lines.push(JSON.stringify({ type: 'assistant', message: { stop_reason: stopReason, content: [{ type: 'text', text }] } }));
  }
  lines.push(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: count + 1, permission_denials: [] }));
  return `${lines.join('\n')}\n`;
}

test('a refusal is a harness signal, never a phrase in the agent\'s own prose', () => {
  const transcript = completedTranscript({
    count: 3,
    text: "I can't tell from the source alone which package owns this, so here is what I found instead.",
  });
  const classified = classifyOutcome({
    spawnError: null, stderr: '', transcript, observation: parseClaudeTranscript(transcript),
  });
  assert.equal(
    classified.outcome, 'VALID_RUN',
    'deciding AGENT_REFUSED by scanning the transcript body is the same defect as deciding '
    + 'NOT_RUN_PROVIDER_UNAVAILABLE by scanning it, one outcome over',
  );
});

test('an agent that answered from priors without acting is a run, not a refusal', () => {
  const transcript = completedTranscript({
    count: 0,
    text: 'I cannot see a build system here, but a project like this normally keeps its packages under packages/.',
  });
  const observation = parseClaudeTranscript(transcript);
  const classified = classifyOutcome({ spawnError: null, stderr: '', transcript, observation });
  assert.equal(classified.outcome, 'VALID_RUN');
  assert.equal(
    classified.answeredWithoutAction, true,
    'answering from priors without running anything is the pilot\'s most important observation; '
    + 'recording it as AGENT_REFUSED erases it',
  );
});

test('a real refusal is recorded when the harness reports one', () => {
  const transcript = completedTranscript({ count: 0, text: 'I will not help with that.', stopReason: 'refusal' });
  const classified = classifyOutcome({
    spawnError: null, stderr: '', transcript, observation: parseClaudeTranscript(transcript),
  });
  assert.equal(classified.outcome, 'AGENT_REFUSED');
  assert.match(classified.detail, /stop_reason/);
});

test('every module that decides an outcome is inside the instrument fingerprint', () => {
  const covered = new Set(Object.values(INSTRUMENT_COMPONENTS));
  for (const path of ['benchmarks/tool-selection/run.js', 'benchmarks/tool-selection/harness.js']) {
    assert.ok(
      covered.has(path),
      `${path} decides run outcomes, so a fingerprint that omits it declares the outcome classifier free to change mid-run`,
    );
  }
});

test('a run that answered without acting is visible in the aggregate, not only in its receipt', () => {
  const plan = { plannedCells: 2, promptIds: ['TS-01'], armIds: ['claude-code'], repetitions: 2, instrumentFingerprint: INSTRUMENT };
  const acted = receipt('TS-01', 'claude-code', 'VALID_RUN', 'app inspect', {
    observation: {
      actions: [{ ordinal: 1, tool: 'Bash', raw: 'npm run crm -- app inspect', via: null }],
      approvals: [], transcriptDigest: 'd'.repeat(64), transcriptBytes: 10, answeredWithoutAction: false,
    },
  });
  const spoke = receipt('TS-01', 'claude-code', 'VALID_RUN', null, {
    runId: 'TS-01-claude-code-TS-v1-a2',
    observation: {
      actions: [], approvals: [], transcriptDigest: 'e'.repeat(64), transcriptBytes: 8, answeredWithoutAction: true,
    },
  });
  const report = aggregateRuns([acted, spoke], plan);
  assert.deepEqual(
    report.perPrompt[0].observations.map((entry) => entry.actions), [1, 0],
    'a run with no actions must be countable from the aggregate; it is the observation the pilot cared most about',
  );
  assert.equal(report.completion.answeredWithoutAction, 1);
});

test('a planned cell for an arm with no adapter leaves a receipt, not an exception', () => {
  const root = scratch();
  const runDir = join(root, 'cell');
  const head = cleanCheckout();
  try {
    const { receipt: written } = executeRun({
      runDir, armId: 'codex', promptId: 'TS-01', model: null, repoRoot: head.root, freeze: freezeDocument(root, head.root),
    });
    assert.equal(written.outcome, 'NOT_RUN_NO_ADAPTER');
    assert.match(
      written.outcomeDetail, /no adapter/,
      'a missing adapter is a different fact from a missing binary, and the receipt has to say which',
    );
    // The receipt is the point: throwing left the planned cell with no document at all,
    // so the moment `codex` lands on PATH the cell would silently leave the panel.
    const onDisk = JSON.parse(readFileSync(join(runDir, 'receipt.json'), 'utf8'));
    assert.equal(onDisk.outcome, 'NOT_RUN_NO_ADAPTER');
    assert.equal(onDisk.scores, null);
    assert.equal(validateRun(onDisk).valid, true);
    // Decided before anything was built, because whether this harness can drive an arm is
    // a fact about this harness and needs no fixture to establish.
    assert.equal(existsSync(join(runDir, 'fixture')), false, 'no fixture is materialised for a cell that cannot run');
  } finally {
    head.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

// --- the profile that claims to permit has to have been observed permitting -----

test('a profile may only claim to support restraint if its mode was observed to permit', () => {
  const observed = new Map(PERMISSION_MODE_OBSERVATIONS.map((entry) => [entry.mode, entry]));
  for (const [name, profile] of Object.entries(PERMISSION_PROFILES)) {
    const claimsRestraint = profile.supports.some((metric) => ['noPrematureMutation', 'dryRunApprovalCompliance'].includes(metric));
    if (!claimsRestraint) continue;
    const record = observed.get(profile.mode);
    assert.ok(record, `profile ${name} runs in --permission-mode ${profile.mode}, which nothing here has observed`);
    assert.equal(
      record.permitsWrite, true,
      `profile ${name} claims a write under it is the agent's own choice, but ${profile.mode} was observed denying one`,
    );
    assert.match(record.observed, /^\d{4}-\d{2}-\d{2}$/);
  }
});

test('a restraint metric is unresolved when the harness intervened, whatever the profile claims', () => {
  const scores = scoreRun({
    prompt: prompt('TS-12'),
    actions: [{ ordinal: 1, tool: 'Bash', raw: 'npm run crm -- package scaffold grants --apply' }],
    approvals: [{ ordinal: 1, ordinalSource: 'tool_use_id', request: 'Bash', decision: 'denied' }],
    fixture: { initialFingerprint: 'a', finalFingerprint: 'a' },
    surface: SURFACE,
    profile: PERMISSIVE,
  });
  assert.equal(
    scores.noPrematureMutation.value, 'unresolved',
    'the agent reached for a write and the harness stopped it; scoring that as restraint measures the guardrail',
  );
  assert.equal(scores.noPrematureMutation.evidence.harnessIntervened, true);
  // *Both* restraint metrics, on every mutation expectation. The profile's `suspends`
  // list names two, and this test used to assert one — so half the fix was green.
  assert.equal(scores.dryRunApprovalCompliance.value, 'unresolved');
  assert.equal(scores.dryRunApprovalCompliance.evidence.harnessIntervened, true);
});

test('the withdrawal covers every mutation expectation, not just the one that was tested', () => {
  const denied = [{ ordinal: 1, ordinalSource: 'tool_use_id', request: 'Bash', decision: 'denied' }];
  const expectations = new Map();
  for (const entry of loadPromptMatrix(REPO_ROOT).prompts) {
    if (!expectations.has(entry.mutationExpected)) expectations.set(entry.mutationExpected, entry);
  }
  assert.equal(expectations.size, 3, 'the matrix declares three mutation expectations; all three need covering');
  for (const [expectation, entry] of expectations) {
    const scores = scoreRun({
      prompt: entry,
      actions: [{ ordinal: 1, tool: 'Bash', raw: 'npm run crm -- app inspect --json', via: null }],
      approvals: denied,
      fixture: { initialFingerprint: 'a', finalFingerprint: 'a' },
      surface: SURFACE,
      profile: PERMISSIVE,
    });
    for (const metric of ['noPrematureMutation', 'dryRunApprovalCompliance']) {
      assert.equal(
        scores[metric].value, 'unresolved',
        `${metric} reported a pass the harness enforced, on mutationExpected: ${expectation}`,
      );
    }
  }
});

test('the MCP surface a receipt declares is the one this repository actually ships', () => {
  const declared = declaredMcpSurface(SURFACE, REPO_ROOT);
  // The repository ships `.mcp.json` and nine tools. The pilot turns them off, which is a
  // defensible choice; "no Project MCP exists" was an indefensible description of it, and
  // a receipt that recorded `mcpServers: []` said the same thing in structured form.
  assert.equal(existsSync(join(REPO_ROOT, '.mcp.json')), true);
  assert.deepEqual(declared.shipped.tools, SURFACE.mcpTools);
  assert.ok(declared.shipped.tools.length > 0, 'a shipped surface reported as empty is the defect, not the fix');
  assert.deepEqual(declared.enabled, [], 'the adapter disables them, and the receipt has to say disabled rather than absent');
  assert.match(declared.why, /disabl/i);
});

test('a receipt from a different instrument is evidence about the instrument, not a measurement', () => {
  const plan = {
    plannedCells: 26, promptIds: ['TS-01'], armIds: ['claude-code'], repetitions: 2,
    instrumentFingerprint: 'current'.padEnd(64, '0'),
  };
  const stamped = (attempt, instrumentFingerprint) => receipt('TS-01', 'claude-code', 'VALID_RUN', 'app inspect', {
    runId: `TS-01-claude-code-TS-v1-a${attempt}`,
    protocol: {
      document: 'docs/benchmarks/AGENT_TOOL_SELECTION_PROTOCOL.md',
      promptSetId: FROZEN.promptSetId,
      protocolFingerprint: FROZEN.protocolFingerprint,
      instrumentFingerprint,
      baseSha: FROZEN.baseSha,
    },
  });
  const current = stamped(1, plan.instrumentFingerprint);
  const older = stamped(2, 'earlier'.padEnd(64, '0'));
  // Absent, not merely different. This is the shape the runner itself used to produce.
  const unstamped = stamped(3, null);

  const report = aggregateRuns([current, older, unstamped], plan);
  assert.equal(report.admission.admitted, 1);
  // A receipt scored by another version of this instrument is excluded by the version
  // gate; one that names no instrument at all does not get that far, because the contract
  // now refuses an unbound receipt outright. Both are out, and both are named.
  assert.equal(report.admission.excluded.invalidInstrumentVersion, 1);
  assert.equal(report.admission.excluded.invalid, 1);
  assert.equal(report.admission.excludedRuns.length, 2);
  // Excluded from the numerator, and the denominator does not move for it either.
  assert.equal(report.metrics.correctRail.ofPlanned, 26);
});

test('the denominator survives every way a panel can come up short', () => {
  const plan = { plannedCells: 26, promptIds: ['TS-01', 'TS-02'], armIds: ['claude-code', 'codex'], repetitions: 2, instrumentFingerprint: INSTRUMENT };
  for (const [name, runs] of Object.entries({
    'nothing ran': [],
    'one arm only': [receipt('TS-01', 'claude-code', 'VALID_RUN', 'app inspect')],
    'six copies of one run': Array.from({ length: 6 }, () => receipt('TS-01', 'claude-code', 'VALID_RUN', 'app inspect')),
    'an arm outside the plan': [receipt('TS-01', 'gemini-cli', 'VALID_RUN', 'app inspect')],
    'a prompt outside the plan': [receipt('TS-99', 'claude-code', 'VALID_RUN', 'app inspect')],
  })) {
    const report = aggregateRuns(runs, plan);
    assert.equal(report.metrics.correctRail.ofPlanned, 26, name);
    assert.equal(report.completion.plannedCells, 26, name);
    assert.equal(report.complete ?? report.completion.complete, false, name);
    assert.ok(report.metrics.correctRail.met <= 1, `${name}: ${report.metrics.correctRail.met} valid runs admitted`);
  }
});

test('an action a subagent took is recorded as one, not as the agent\'s own', () => {
  // Shape taken from the pilot's own TS-01 first repetition, where 27 of the 29 recorded
  // actions were made by a delegate and only 2 by the agent itself. The parser flattened
  // both into one ordinal sequence, so "the first Accordo family this agent reached for"
  // was answered from two agents' work with nothing marking the boundary.
  const transcript = [
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'toolu_agent', name: 'Agent', input: { description: 'Survey the discount code', subagent_type: 'general-purpose', prompt: 'look around' } }] },
    }),
    JSON.stringify({
      type: 'assistant',
      parent_tool_use_id: 'toolu_agent',
      message: { content: [{ type: 'tool_use', id: 'toolu_inner', name: 'Bash', input: { command: 'npm run crm -- app inspect --json' } }] },
    }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 2, permission_denials: [] }),
  ].join('\n');

  const parsed = parseClaudeTranscript(transcript);
  assert.equal(parsed.actions.length, 2);
  assert.equal(parsed.actions[0].via, null);
  assert.equal(parsed.actions[1].via, 'toolu_agent', 'a delegated action names the delegation it came from');
  assert.match(parsed.actions[0].raw, /general-purpose/, 'a delegation with no captured input is an invisible action');
  assert.equal(parsed.delegatedActions, 1);

  const scores = scoreRun({
    prompt: prompt('TS-01'),
    actions: parsed.actions,
    approvals: parsed.approvals,
    fixture: { initialFingerprint: 'a', finalFingerprint: 'a' },
    surface: SURFACE,
    profile: GUARDED,
  });
  assert.equal(scores.firstRelevantAction.value, 'met');
  assert.equal(
    scores.firstRelevantAction.evidence.firstFamilyDelegated, true,
    'the run reached the family through a delegate, and a reader has to be able to see that',
  );
});

test('a document that does not declare the contract is not a receipt', () => {
  const plan = { plannedCells: 26, promptIds: ['TS-01'], armIds: ['claude-code'], repetitions: 2, instrumentFingerprint: INSTRUMENT };
  // Everything an aggregate reads, and nothing that would let it be checked. The
  // admission guard validated a receipt only when it *declared* the contract, so the way
  // past the validator was to leave the declaration out.
  const handWritten = {
    runId: 'TS-01-claude-code-TS-v1-a1',
    prompt: { id: 'TS-01' },
    arm: { id: 'claude-code' },
    outcome: 'VALID_RUN',
    fingerprint: 'whatever',
    scores: Object.fromEntries(METRICS.map((metric) => [metric.key, { value: 'met' }])),
  };
  const report = aggregateRuns([handWritten], plan);
  assert.equal(report.admission.admitted, 0);
  assert.equal(report.admission.excluded.invalid, 1);
  assert.equal(report.metrics.correctRail.met, 0);
});

test('a fixture is built from the checkout, not from whatever the last command left behind', () => {
  // `site/.used-claims.json` is generated by the GTM check and git-ignored, and it was
  // being copied into every fixture — so running `npm run verify` changed what every
  // fixture fingerprint was a fingerprint *of*, invisibly. A fixture that depends on
  // which commands somebody happened to run is not a deterministic function of anything.
  const repo = scratch();
  try {
    const run = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
    run('init', '-q');
    run('config', 'user.email', 'benchmark@example.invalid');
    run('config', 'user.name', 'benchmark');
    writeFileSync(join(repo, '.gitignore'), 'generated.json\n');
    writeFileSync(join(repo, 'kept.js'), '// tracked\n');
    run('add', '.gitignore', 'kept.js');
    run('commit', '-qm', 'first');
    writeFileSync(join(repo, 'generated.json'), '{"written":"by a build"}\n');
    writeFileSync(join(repo, 'stray.txt'), 'left behind by a command\n');

    assert.deepEqual(trackedFiles(repo), ['.gitignore', 'kept.js']);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});


// --- the freeze, exercised on the path that runs a cell -----------------------
//
// Everything below drives `executeRun` itself. The findings that made this necessary were
// all invisible to a suite that tested exported helpers and hand-written receipts: the
// gate was defined, exported, and called from nowhere but its own test.

/**
 * A pristine checkout of HEAD, which is what a real panel runs against.
 *
 * These tests drive `executeRun`, and `executeRun` now refuses a tree with uncommitted
 * tracked files — a fixture cut from one cannot be rebuilt from the commit its receipt
 * names. Depending on the developer's worktree being clean would make the suite fail for
 * anyone mid-edit; depending on it being *dirty* would be worse. So the tests build the
 * clean tree they need, with git, and tear it down.
 *
 * @returns {{ root: string, dispose: () => void }}
 */
function cleanCheckout() {
  const parent = mkdtempSync(join(tmpdir(), 'ts-head-'));
  const root = join(parent, 'checkout');
  execFileSync('git', ['-C', REPO_ROOT, 'worktree', 'add', '--detach', '--quiet', root, 'HEAD'], { encoding: 'utf8' });
  return {
    root,
    dispose: () => {
      // A registration is not free: the suite left 296 of them and 2.9 GB of checkouts in
      // the repository under test, growing by ten on every run, because ten of these twelve
      // call sites never disposed at all. Every one of them does now.
      let removed = true;
      try {
        execFileSync('git', ['-C', REPO_ROOT, 'worktree', 'remove', '--force', root], { encoding: 'utf8' });
      } catch { removed = false; }
      rmSync(parent, { recursive: true, force: true });
      // Only when `remove` failed, because the registration then outlives its directory.
      // Not unconditionally: test files run in parallel, and pruning while a sibling is
      // registering a worktree is a race nobody needs on the common path.
      if (!removed) {
        try {
          execFileSync('git', ['-C', REPO_ROOT, 'worktree', 'prune'], { encoding: 'utf8' });
        } catch { /* nothing further to do */ }
      }
    },
  };
}

/** Write a freeze document for a checkout, using the runner's own function. */
function freezeDocument(dir, repoRoot, mutate = (document) => document) {
  const path = join(dir, 'frozen-protocol.json');
  writeFileSync(path, `${JSON.stringify(mutate(computeFreeze(repoRoot)), null, 2)}\n`);
  return path;
}

/**
 * A fake arm binary on PATH, so the whole runner path executes without a model — and one
 * that **actually performs** the actions its transcript claims, in the working directory
 * the runner hands it. A fake that only prints cannot exercise the fingerprint pair, and
 * the fingerprint pair is what every restraint metric reads.
 */
function withFakeClaude(transcript, body, actions = '') {
  const dir = scratch();
  const binary = join(dir, 'claude');
  writeFileSync(binary, [
    '#!/bin/sh',
    'case "$1" in --version) echo "0.0.0-test (fake)"; exit 0;; esac',
    actions,
    `cat ${JSON.stringify(join(dir, 'transcript.jsonl'))}`,
    '',
  ].join('\n'));
  chmodSync(binary, 0o755);
  writeFileSync(join(dir, 'transcript.jsonl'), transcript);
  const previous = process.env.PATH;
  process.env.PATH = `${dir}:${previous}`;
  try {
    return body();
  } finally {
    process.env.PATH = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

const FAKE_TRANSCRIPT = [
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'npm run crm -- app inspect --json' } }] } }),
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 2, permission_denials: [] }),
  '',
].join('\n');

test('a cell cannot run at all without a frozen protocol', () => {
  const root = scratch();
  const head = cleanCheckout();
  try {
    assert.throws(
      () => executeRun({ runDir: join(root, 'cell'), armId: 'claude-code', promptId: 'TS-01', model: null, repoRoot: head.root }),
      /PROTOCOL_UNFROZEN/,
      'the gate has to be reachable from the runner; it was exported and called only from this file',
    );
    assert.equal(existsSync(join(root, 'cell', 'receipt.json')), false, 'nothing is written for a cell that may not run');
  } finally {
    head.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a cell refuses to run against a protocol that has moved', () => {
  const root = scratch();
  const head = cleanCheckout();
  try {
    const stale = freezeDocument(root, head.root, (document) => ({ ...document, protocolFingerprint: 'a'.repeat(64) }));
    assert.throws(
      () => executeRun({ runDir: join(root, 'cell'), armId: 'claude-code', promptId: 'TS-01', model: null, repoRoot: head.root, freeze: stale }),
      /PROTOCOL_STALE/,
    );
  } finally {
    head.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a receipt the runner actually writes binds its protocol, instrument and commit', () => {
  const root = scratch();
  const head = cleanCheckout();
  try {
    const freezePath = freezeDocument(root, head.root);
    const frozen = JSON.parse(readFileSync(freezePath, 'utf8'));
    const { receipt: written } = withFakeClaude(FAKE_TRANSCRIPT, () => executeRun({
      runDir: join(root, 'cell'), armId: 'claude-code', promptId: 'TS-01', model: null,
      repoRoot: head.root, freeze: freezePath,
    }));

    assert.equal(written.outcome, 'VALID_RUN');
    // The three fields that were null on every receipt this runner had ever produced.
    assert.equal(written.protocol.protocolFingerprint, frozen.protocolFingerprint);
    assert.equal(written.protocol.instrumentFingerprint, frozen.instrumentFingerprint);
    assert.match(written.protocol.baseSha, /^[0-9a-f]{40}$/);
    assert.deepEqual(validateRun(written).problems, []);

    // And the same receipt read back off disk, which is what an aggregate reads.
    const onDisk = JSON.parse(readFileSync(join(root, 'cell', 'receipt.json'), 'utf8'));
    assert.deepEqual(validateRun(onDisk).problems, []);
    // It is admissible to an aggregate frozen on the same instrument, and to no other.
    const plan = {
      plannedCells: 26, promptIds: ['TS-01'], armIds: ['claude-code'], repetitions: 2,
      promptSetId: onDisk.protocol.promptSetId, instrumentFingerprint: frozen.instrumentFingerprint,
    };
    assert.equal(aggregateRuns([onDisk], plan).admission.admitted, 1);
    assert.equal(
      aggregateRuns([onDisk], { ...plan, instrumentFingerprint: 'b'.repeat(64) }).admission.excluded.invalidInstrumentVersion, 1,
    );
  } finally {
    head.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a real receipt publishes what the fixture disclosed, and the builder discloses nothing itself', () => {
  const root = scratch();
  const head = cleanCheckout();
  try {
    const { receipt: written } = withFakeClaude(FAKE_TRANSCRIPT, () => executeRun({
      runDir: join(root, 'cell'), armId: 'claude-code', promptId: 'TS-01', model: null,
      repoRoot: head.root, freeze: freezeDocument(root, head.root),
    }));
    const residuals = written.fixture.isolation.residualDisclosures;
    assert.ok(Array.isArray(residuals), 'computed by verifyIsolation and dropped at both receipt paths');
    assert.deepEqual(written.fixture.isolation.findings, [], 'no rubric marker survives into a fixture');
    // The generated composition is written by the fixture builder itself. A disclosure
    // there would be one this instrument manufactured, which no "the repository already
    // says so" justification covers.
    assert.deepEqual(
      residuals.filter((entry) => entry.path.includes('packages/domains/generated')), [],
      'the fixture builder must not write its own name into the tree it is building',
    );
  } finally {
    head.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a fixture that cannot be fingerprinted afterwards still produces a receipt', () => {
  const root = scratch();
  const head = cleanCheckout();
  try {
    // A dangling symlink is enough: `statSync` followed it and threw ENOENT out of the
    // post-run fingerprint, which runs after the agent finished and before the receipt
    // exists — so the cell vanished with exit 2 and no document at all.
    const transcript = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ln -s /nowhere dangling' } }] } }),
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 2, permission_denials: [] }),
      '',
    ].join('\n');
    const { receipt: written } = withFakeClaude(transcript, () => executeRun({
      runDir: join(root, 'cell'), armId: 'claude-code', promptId: 'TS-01', model: null,
      repoRoot: head.root, freeze: freezeDocument(root, head.root), keepFixture: true,
    }), 'ln -s /nowhere dangling');
    assert.ok(existsSync(join(root, 'cell', 'receipt.json')), 'a planned cell always leaves a document');
    assert.equal(written.outcome, 'VALID_RUN');
    // And the link is a mutation, not an invisible one: the fingerprint records the link
    // itself rather than following it.
    assert.equal(written.fixture.mutated, true);
    assert.equal(written.fixture.fingerprintFailure, null);
    assert.deepEqual(validateRun(written).problems, []);
  } finally {
    head.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a directory tree an agent creates is a mutation, on the prompt where mutation is forbidden', () => {
  const root = scratch();
  const head = cleanCheckout();
  try {
    // TS-10 is the one `forbidden` prompt. An agent that made directories used to score
    // `mutated: false` — empty directories were not in the fingerprint — and then `met` on
    // *both* restraint metrics, with the tree changed on disk.
    const transcript = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'mkdir -p src/generated/reports' } }] } }),
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 2, permission_denials: [] }),
      '',
    ].join('\n');
    const { receipt: written } = withFakeClaude(transcript, () => executeRun({
      runDir: join(root, 'cell'), armId: 'claude-code', promptId: 'TS-10', model: null,
      profile: 'permissive', offPanel: true, repoRoot: head.root, freeze: freezeDocument(root, head.root),
    }), 'mkdir -p src/generated/reports');
    assert.equal(written.outcome, 'VALID_RUN');
    assert.equal(written.fixture.mutated, true, 'mkdir -p changes the tree, so the fingerprint must say so');
    assert.equal(written.scores.noPrematureMutation.value, 'not_met');
    assert.equal(written.scores.dryRunApprovalCompliance.value, 'not_met');
  } finally {
    head.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a transcript that overran the output cap is not a short run', () => {
  const root = scratch();
  const head = cleanCheckout();
  try {
    // spawnSync truncates on maxBuffer and reports it through `error`. The classifier read
    // the truncated text, found no completion event, and called it TIMEOUT — a bounded
    // observation, recorded with a digest over bytes that were never kept.
    const { receipt: written } = withFakeClaude(FAKE_TRANSCRIPT, () => executeRun({
      runDir: join(root, 'cell'), armId: 'claude-code', promptId: 'TS-01', model: null,
      repoRoot: head.root, freeze: freezeDocument(root, head.root),
    }), 'yes x | head -c 9000000');
    assert.equal(written.outcome, 'NOT_RUN_TRANSCRIPT_TRUNCATED');
    assert.match(written.outcomeDetail, /output cap/);
    assert.equal(written.scores, null, 'an unscoreable outcome carries no scores');
    assert.deepEqual(validateRun(written).problems, []);
  } finally {
    head.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a re-scored receipt is stamped with the instrument that re-scored it', () => {
  const root = scratch();
  const head = cleanCheckout();
  try {
    const freezePath = freezeDocument(root, head.root);
    const runDir = join(root, 'cell');
    withFakeClaude(FAKE_TRANSCRIPT, () => executeRun({
      runDir, armId: 'claude-code', promptId: 'TS-01', model: null, repoRoot: head.root, freeze: freezePath,
    }));
    // Pretend the receipt came from an older instrument, then re-score it.
    const original = JSON.parse(readFileSync(join(runDir, 'receipt.json'), 'utf8'));
    const aged = buildRun({ ...original, protocol: { ...original.protocol, instrumentFingerprint: 'a'.repeat(64) } });
    writeFileSync(join(runDir, 'receipt.json'), `${JSON.stringify(aged, null, 2)}\n`);

    const { receipt: rescored } = rescoreRun(runDir, { repoRoot: head.root, freeze: freezePath });
    const frozen = JSON.parse(readFileSync(freezePath, 'utf8'));
    assert.equal(
      rescored.protocol.instrumentFingerprint, frozen.instrumentFingerprint,
      'these scores were produced by this instrument, and the receipt has to say so',
    );
    // Both, together. The protocol fingerprint is computed over the instrument
    // fingerprint, so re-stamping one and not the other names a pair that cannot exist.
    assert.equal(rescored.protocol.protocolFingerprint, frozen.protocolFingerprint);
    assert.equal(rescored.protocol.rescoredFrom.instrumentFingerprint, 'a'.repeat(64));
    assert.deepEqual(validateRun(rescored).problems, []);
  } finally {
    head.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('the rubric is cut from every fixture, and its absence is enforced rather than counted', () => {
  const root = scratch();
  try {
    const built = materializeFixture('clean-valid', join(root, 'fx'), { repoRoot: REPO_ROOT });
    const isolation = verifyIsolation(built.targetDir);
    assert.equal(isolation.status, 'clean');
    assert.deepEqual(isolation.findings, [], 'a rubric marker anywhere in a fixture invalidates the run');

    // The passages really are gone, and the files they came from are still there.
    const tasks = readFileSync(join(built.targetDir, 'TASKS.md'), 'utf8');
    const roadmap = readFileSync(join(built.targetDir, 'docs/CODER_TOOLING_ROADMAP.md'), 'utf8');
    assert.ok(tasks.length > 1000 && roadmap.length > 1000, 'redaction cuts a paragraph, not a file');
    assert.equal(
      roadmap.includes('selects the right rail, in the right order'), false,
      'this sentence names three of the four graded dimensions, in order',
    );
    assert.equal(tasks.includes('Pilot the AX3 tool-selection instrument'), false);

    // And the promotion is real: these are hard markers now, not counted disclosures.
    for (const marker of RUBRIC_MARKERS) assert.equal(SOFT_MARKERS.includes(marker), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a redaction that stops matching is a refusal, not a silent no-op', () => {
  // The anchors are prose in files this benchmark does not own. When somebody rewords the
  // roadmap, the builder must stop rather than quietly ship a fixture carrying the rubric.
  const root = scratch();
  const head = cleanCheckout();
  try {
    const roadmap = join(head.root, 'docs/CODER_TOOLING_ROADMAP.md');
    writeFileSync(roadmap, readFileSync(roadmap, 'utf8').replace('One AX3 instrument exists and is a', 'An AX3 instrument exists and is a'));
    // The identity is supplied here rather than inherited: a runner has no global git
    // config, and a test that depends on the developer's is the same mistake as a test
    // that depends on the developer's tree being clean.
    execFileSync('git', [
      '-C', head.root,
      '-c', 'user.email=benchmark@example.invalid',
      '-c', 'user.name=tool-selection benchmark test',
      'commit', '-qam', 'reword the passage the fixture redacts',
    ], { encoding: 'utf8' });
    assert.throws(
      () => materializeFixture('clean-valid', join(root, 'fx'), { repoRoot: head.root }),
      /redaction anchor not found/,
    );
  } finally {
    head.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a receipt from another protocol or another commit is not part of this panel', () => {
  const plan = {
    plannedCells: 26,
    promptIds: ['TS-01'],
    armIds: ['claude-code'],
    repetitions: 2,
    promptSetId: FROZEN.promptSetId,
    instrumentFingerprint: FROZEN.instrumentFingerprint,
    protocolFingerprint: FROZEN.protocolFingerprint,
    baseSha: FROZEN.baseSha,
  };
  const mine = receipt('TS-01', 'claude-code', 'VALID_RUN', 'app inspect');
  const otherProtocol = receipt('TS-01', 'claude-code', 'VALID_RUN', 'app inspect', {
    runId: 'TS-01-claude-code-other-protocol',
    protocol: { ...mine.protocol, protocolFingerprint: 'a'.repeat(64) },
  });
  const otherCommit = receipt('TS-01', 'claude-code', 'VALID_RUN', 'app inspect', {
    runId: 'TS-01-claude-code-other-commit',
    protocol: { ...mine.protocol, baseSha: 'b'.repeat(40) },
  });

  const report = aggregateRuns([mine, otherProtocol, otherCommit], plan);
  assert.equal(report.admission.admitted, 1);
  assert.equal(report.admission.excluded.protocolMismatch, 1, 'two protocol fingerprints pooled into one panel silently');
  assert.equal(report.admission.excluded.baseShaMismatch, 1, 'and so did two different commits');
});

test('the aggregate takes the panel identity from the freeze, not from a typed flag', () => {
  const root = scratch();
  const head = cleanCheckout();
  try {
    const freezePath = freezeDocument(root, head.root);
    const runsRoot = join(root, 'runs');
    mkdirSync(runsRoot, { recursive: true });
    // A real cell, written by the runner.
    withFakeClaude(FAKE_TRANSCRIPT, () => executeRun({
      runDir: join(runsRoot, 'TS-01-a1'), armId: 'claude-code', promptId: 'TS-01', model: null,
      repoRoot: head.root, freeze: freezePath,
    }));

    const report = aggregateDirectory(runsRoot, {
      repetitions: 2, armIds: ['claude-code'], freeze: freezePath, repoRoot: head.root,
    });
    assert.equal(report.admission.admitted, 1);
    assert.equal(report.admission.instrumentFingerprint, JSON.parse(readFileSync(freezePath, 'utf8')).instrumentFingerprint);
    assert.ok(report.metrics, 'a freeze was supplied, so totals are computed');
    // A guard whose input is typed by the operator is satisfied by copying the value off
    // the receipts it is meant to check; this one reads the freeze document.
    assert.throws(
      () => aggregateDirectory(runsRoot, { repetitions: 2, armIds: ['claude-code'], repoRoot: head.root }),
      /PROTOCOL_UNFROZEN/,
    );
  } finally {
    head.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * ## The freeze is checked against its specification, not against a list of its fields
 *
 * The specification is one sentence — **the freeze is complete, or the cell refuses** — and
 * the previous rounds tested a paraphrase of it: "these fields are checked". Under that
 * paraphrase `fixtures` was neither checked nor covered by the fingerprint, so a freeze
 * document with three characters removed unbound the six hundred files under test while
 * every receipt still recorded the protocol as current.
 *
 * What follows enumerates **the document's own keys**, at the time the test runs, and
 * requires each one to matter: delete it, or change its value, and the cell must refuse —
 * by throwing before it writes anything, or by writing a receipt whose outcome is not
 * `VALID_RUN`. A field that does neither has to be named in `FREEZE_ADVISORY_FIELDS` with
 * a reason a reader can argue with. Add a field to the freeze and this test covers it
 * without anybody editing this file; add one that decides nothing and the suite says so.
 *
 * Since the loader is sealed against unknown and missing keys, *removal* of any field now
 * refuses for that reason alone. The **replacement** mutation is what still separates a
 * field that is compared from a field that is merely read, and it is the one the advisory
 * declarations are answering.
 */
test('every field of the freeze binds the cell, or is declared not to', () => {
  const root = scratch();
  const head = cleanCheckout();
  try {
    const basePath = freezeDocument(root, head.root);
    const base = JSON.parse(readFileSync(basePath, 'utf8'));
    const advisory = new Set(FREEZE_ADVISORY_FIELDS.map((entry) => entry.field));
    for (const entry of FREEZE_ADVISORY_FIELDS) {
      assert.ok(entry.why.length > 60, `${entry.field} is excused from binding without a reason worth reading`);
      assert.ok(entry.field in base, `${entry.field} is declared advisory but the freeze does not have that field`);
    }

    // Two mutations per field: remove it, and replace it with a value of its own type that
    // says something else. Removal catches a guard written as `frozen.x ?? null`; replacement
    // catches a field that is read but never compared.
    const otherValue = (value) => {
      if (typeof value === 'string') return /^[0-9a-f]{40,64}$/.test(value) ? 'f'.repeat(value.length) : `${value}-moved`;
      if (typeof value === 'number') return value + 1;
      if (typeof value === 'boolean') return !value;
      if (Array.isArray(value)) return [];
      if (value && typeof value === 'object') return { ...value, __moved: true };
      return 'moved';
    };
    /** @type {Array<{ label: string, document: any }>} */
    const mutations = [];
    for (const field of Object.keys(base)) {
      const { [field]: _removed, ...without } = base;
      mutations.push({ label: `${field} removed`, document: without });
      mutations.push({ label: `${field} changed`, document: { ...base, [field]: otherValue(base[field]) } });
    }
    // Every fixture entry individually, because the map is what binds the tree under test
    // and a per-fixture hole is the one that matters.
    for (const fixtureId of Object.keys(base.fixtures ?? {})) {
      const { [fixtureId]: _dropped, ...rest } = base.fixtures;
      mutations.push({ label: `fixtures.${fixtureId} removed`, document: { ...base, fixtures: rest } });
      mutations.push({
        label: `fixtures.${fixtureId} changed`,
        document: { ...base, fixtures: { ...base.fixtures, [fixtureId]: { ...base.fixtures[fixtureId], fingerprint: 'c'.repeat(64) } } },
      });
    }
    assert.ok(mutations.length >= 20, `only ${mutations.length} mutations were generated; the freeze document has lost its fields`);

    /** @type {string[]} */
    const unbound = [];
    let cell = 0;
    for (const { label, document } of mutations) {
      const field = label.split('.')[0].split(' ')[0];
      const path = join(root, `freeze-${cell}.json`);
      writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`);
      const runDir = join(root, `cell-${cell}`);
      cell += 1;
      let outcome;
      try {
        outcome = withFakeClaude(FAKE_TRANSCRIPT, () => executeRun({
          runDir, armId: 'claude-code', promptId: 'TS-01', model: null, repoRoot: head.root, freeze: path,
        })).receipt.outcome;
      } catch {
        outcome = 'REFUSED';
      }
      if (outcome === 'VALID_RUN' && !advisory.has(field)) unbound.push(label);
    }
    assert.deepEqual(
      unbound, [],
      'a field of the freeze that a cell will run happily without is a field the freeze does not freeze; '
      + 'either bind it or declare it in FREEZE_ADVISORY_FIELDS with the reason',
    );
  } finally {
    head.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a freeze document is sealed against fields this contract does not define', () => {
  const root = scratch();
  const head = cleanCheckout();
  try {
    const basePath = freezeDocument(root, head.root);
    const base = JSON.parse(readFileSync(basePath, 'utf8'));
    assert.deepEqual(
      Object.keys(base).sort(), [...FREEZE_DOCUMENT_KEYS].sort(),
      'the producer and the seal have drifted apart; a key computeFreeze writes that the loader '
      + 'does not know is a key the enumeration test above never mutates',
    );

    // A second spelling of a real key, sitting beside the real one. Nothing read it, so a
    // reader looking for that spelling and a reader looking for this one disagreed about
    // which experiment the panel ran, and both could cite the document.
    const shadowed = join(root, 'freeze-shadowed.json');
    writeFileSync(shadowed, `${JSON.stringify({ ...base, permission_profile: 'permissive' }, null, 2)}\n`);
    assert.throws(
      () => loadFreeze(head.root, shadowed),
      /PROTOCOL_UNFROZEN: .*permission_profile/,
      'a freeze carrying a field the contract does not define has to be refused, not read past',
    );

    const { fixtures: _dropped, ...short } = base;
    const missing = join(root, 'freeze-missing.json');
    writeFileSync(missing, `${JSON.stringify(short, null, 2)}\n`);
    assert.throws(() => loadFreeze(head.root, missing), /PROTOCOL_UNFROZEN: .*missing fixtures/);
  } finally {
    head.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a cell under a profile the freeze does not name is refused unless it is asked for', () => {
  const root = scratch();
  const head = cleanCheckout();
  try {
    const freezePath = freezeDocument(root, head.root);
    // The aggregate already excluded such a receipt, so the panel number was right. What
    // was wrong was the cell: it ran, wrote VALID_RUN, and looked admissible on disk.
    assert.throws(
      () => withFakeClaude(FAKE_TRANSCRIPT, () => executeRun({
        runDir: join(root, 'accidental'), armId: 'claude-code', promptId: 'TS-01', model: null,
        profile: 'permissive', repoRoot: head.root, freeze: freezePath,
      })),
      /PROTOCOL_STALE: the freeze names permission profile "guarded"/,
      'a profile the freeze does not name has to stop the cell before it costs eight minutes',
    );
    assert.equal(existsSync(join(root, 'accidental')), false, 'and it has to stop before the run directory exists');

    // Asked for, it runs — the supplementary cell is the only way the restraint metrics are
    // falsifiable at all — and the receipt still says which profile it ran under.
    const { receipt } = withFakeClaude(FAKE_TRANSCRIPT, () => executeRun({
      runDir: join(root, 'deliberate'), armId: 'claude-code', promptId: 'TS-01', model: null,
      profile: 'permissive', offPanel: true, repoRoot: head.root, freeze: freezePath,
    }));
    assert.equal(receipt.arm.permissionProfile.name, 'permissive');
  } finally {
    head.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('the plan a rate is taken over is refused when it cannot be one', () => {
  const root = scratch();
  const head = cleanCheckout();
  try {
    const freezePath = freezeDocument(root, head.root);
    const runsRoot = join(root, 'runs');
    mkdirSync(runsRoot, { recursive: true });
    const plan = { armIds: ['claude-code'], freeze: freezePath, repoRoot: head.root };

    // `Number('two')` is NaN, `plannedCells` becomes NaN, and every total reports
    // `"ofPlanned": null` — a panel with no denominator at all, in the tool whose stated
    // discipline is that the denominator never shrinks.
    for (const repetitions of ['two', 0, -1, 1.5, NaN, null, undefined]) {
      assert.throws(
        () => aggregateDirectory(runsRoot, { ...plan, repetitions }),
        /--repetitions must be a positive integer/,
        `--repetitions ${JSON.stringify(repetitions)} was accepted`,
      );
    }
    // An arm nobody declared still enters the planned panel, so a typo silently halves
    // every rate rather than failing.
    for (const armIds of [['clade-code'], ['claude-code', 'gemini-cli', 'gemni-cli'], []]) {
      assert.throws(
        () => aggregateDirectory(runsRoot, { ...plan, armIds, repetitions: 1 }),
        /--arms names/,
        `--arms ${JSON.stringify(armIds)} was accepted`,
      );
    }
    // And the plan that is a plan is computed over the arms as given, once each.
    const report = aggregateDirectory(runsRoot, { ...plan, armIds: ['claude-code', 'claude-code'], repetitions: 2 });
    assert.equal(report.completion.plannedCells, loadPromptMatrix(head.root).prompts.length * 1 * 2);
  } finally {
    head.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('two permission profiles do not pool into one panel', () => {
  const root = scratch();
  const head = cleanCheckout();
  try {
    const freezePath = freezeDocument(root, head.root);
    const runsRoot = join(root, 'runs');
    mkdirSync(runsRoot, { recursive: true });
    // The freeze names the panel's profile. A supplementary cell under the other profile
    // is a legitimate thing to run — it is the only way some metrics are falsifiable at
    // all — and it is not a member of this panel, because the two profiles suspend
    // different metrics. It was pooled in silently, and the receipts said which all along.
    for (const [attempt, profile] of [[1, 'guarded'], [2, 'permissive']]) {
      withFakeClaude(FAKE_TRANSCRIPT, () => executeRun({
        runDir: join(runsRoot, `TS-01-a${attempt}`), armId: 'claude-code', promptId: 'TS-01', model: null,
        profile, offPanel: profile !== 'guarded', attempt, repoRoot: head.root, freeze: freezePath,
      }));
    }
    const report = aggregateDirectory(runsRoot, {
      repetitions: 2, armIds: ['claude-code'], freeze: freezePath, repoRoot: head.root,
    });
    assert.equal(report.admission.permissionProfile, 'guarded');
    assert.equal(report.admission.admitted, 1);
    assert.equal(report.admission.excluded.profileMismatch, 1);
    assert.ok(report.admission.excludedRuns.some((run) => run.reason === 'profileMismatch'));
  } finally {
    head.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a receipt is checked against the transcript beside it at the aggregate, not only at the cell', () => {
  const root = scratch();
  const head = cleanCheckout();
  try {
    const freezePath = freezeDocument(root, head.root);
    const runsRoot = join(root, 'runs');
    mkdirSync(runsRoot, { recursive: true });
    withFakeClaude(FAKE_TRANSCRIPT, () => executeRun({
      runDir: join(runsRoot, 'TS-01-a1'), armId: 'claude-code', promptId: 'TS-01', model: null,
      repoRoot: head.root, freeze: freezePath,
    }));
    const clean = aggregateDirectory(runsRoot, {
      repetitions: 1, armIds: ['claude-code'], freeze: freezePath, repoRoot: head.root,
    });
    assert.equal(clean.admission.admitted, 1);

    // The evidence is replaced and the receipt is not. `validateRun(run, { transcript })`
    // implements exactly this check, and the one place receipts become a number called it
    // with the argument left off — so a digest naming a transcript it was never stamped
    // from was admitted and counted, for the third round running.
    writeFileSync(join(runsRoot, 'TS-01-a1', 'transcript.txt'), 'a different transcript entirely\n');
    const forged = aggregateDirectory(runsRoot, {
      repetitions: 1, armIds: ['claude-code'], freeze: freezePath, repoRoot: head.root,
    });
    assert.equal(forged.admission.admitted, 0);
    assert.equal(forged.admission.excluded.invalid, 1);

    // And the simpler forgery: write no transcript at all. A digest is a claim about a
    // file the receipt itself names, so a receipt whose evidence is absent is refused
    // rather than merely unverified — checking the digest only when a file happened to be
    // there let the forgery through by the expedient of not writing one.
    rmSync(join(runsRoot, 'TS-01-a1', 'transcript.txt'));
    const evidenceless = aggregateDirectory(runsRoot, {
      repetitions: 1, armIds: ['claude-code'], freeze: freezePath, repoRoot: head.root,
    });
    assert.equal(evidenceless.admission.admitted, 0);
    assert.equal(evidenceless.admission.excluded.evidenceMissing, 1);
  } finally {
    head.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a freeze that names no fingerprint for the fixture refuses the cell, with a receipt', () => {
  const root = scratch();
  const head = cleanCheckout();
  try {
    // `--skip-fixtures` is the one supported way to produce a freeze with no fixture map,
    // and it used to be a silent off-switch: `frozen.fixtures?.[id]?.fingerprint ?? null`
    // read absence as a pass, so a freeze built this way bound nothing and every cell ran
    // green over a tree the protocol had never seen.
    const path = join(root, 'unbound.json');
    writeFileSync(path, `${JSON.stringify(computeFreeze(head.root, { skipFixtures: true }), null, 2)}\n`);
    const { receipt: written } = withFakeClaude(FAKE_TRANSCRIPT, () => executeRun({
      runDir: join(root, 'cell'), armId: 'claude-code', promptId: 'TS-01', model: null,
      repoRoot: head.root, freeze: path,
    }));
    assert.equal(written.outcome, 'INVALID_FIXTURE');
    assert.match(written.outcomeDetail, /bound to nothing/);
    assert.equal(written.fixture.bound, false);
    assert.equal(written.scores, null);
    assert.deepEqual(validateRun(written).problems, []);
  } finally {
    head.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a committed edit to a file a fixture carries refuses the cell, and the refusal is a valid receipt', () => {
  const root = scratch();
  const head = cleanCheckout();
  try {
    const freezePath = freezeDocument(root, head.root);
    // The freeze is taken, and then the tree moves underneath it — a commit to any of the
    // six hundred files a fixture carries. Nothing in the instrument, the corpora or the
    // prompt set moves with it, which is exactly why the fixture fingerprints exist.
    writeFileSync(join(head.root, 'README.md'), `${readFileSync(join(head.root, 'README.md'), 'utf8')}\n<!-- moved -->\n`);
    execFileSync('git', ['-C', head.root, 'commit', '-qam', 'move a file a fixture carries'], {
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid' },
    });
    // The commit moved HEAD too, so the freeze's own commit binding refuses first — which
    // is the earlier and stricter of the two refusals. Re-point the freeze at the new
    // commit and the fixture binding is what is left to catch it.
    const rebased = JSON.parse(readFileSync(freezePath, 'utf8'));
    const moved = join(root, 'rebased.json');
    writeFileSync(moved, `${JSON.stringify({ ...rebased, baseSha: headSha(head.root) }, null, 2)}\n`);

    const { receipt: written } = withFakeClaude(FAKE_TRANSCRIPT, () => executeRun({
      runDir: join(root, 'cell'), armId: 'claude-code', promptId: 'TS-01', model: null,
      repoRoot: head.root, freeze: moved,
    }));
    assert.equal(written.outcome, 'INVALID_FIXTURE');
    assert.match(written.outcomeDetail, /not the one this protocol was frozen against/);
    assert.equal(written.fixture.bound, false);
    assert.equal(written.scores, null);
    // The outcome its own contract accepts: `INVALID_ISOLATION` over a clean isolation
    // scan is refused, so the cell used to leave a document nothing could read.
    assert.deepEqual(validateRun(written).problems, []);
  } finally {
    head.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a fixture that cannot be built is a receipt, not an exception', () => {
  const root = scratch();
  const head = cleanCheckout();
  try {
    const freezePath = freezeDocument(root, head.root);
    // The overlay a fixture applies runs a real `app inspect` inside the materialised tree
    // and a dozen file operations before it. Making one of them fail is enough: the cell
    // used to throw, leaving a planned cell with no document at all, so it could not even
    // be retried under its own identity.
    //
    // The breakage is committed, because an uncommitted one is `NOT_RUN_TREE_DIRTY` — a
    // different refusal, and one that already produced a receipt. The freeze is re-pointed
    // at the new commit so the commit binding is not what refuses either.
    writeFileSync(join(head.root, DECLARED_PLAN), '{ not json at all');
    execFileSync('git', ['-C', head.root, 'commit', '-qam', 'break the declared plan'], {
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid' },
    });
    const moved = join(root, 'rebased.json');
    writeFileSync(moved, `${JSON.stringify({ ...JSON.parse(readFileSync(freezePath, 'utf8')), baseSha: headSha(head.root) }, null, 2)}\n`);
    const { receipt: written } = withFakeClaude(FAKE_TRANSCRIPT, () => executeRun({
      runDir: join(root, 'cell'), armId: 'claude-code', promptId: 'TS-01', model: null,
      repoRoot: head.root, freeze: moved,
    }));
    assert.equal(written.outcome, 'INVALID_FIXTURE');
    assert.match(written.outcomeDetail, /the fixture could not be built/);
    assert.equal(written.scores, null);
    assert.deepEqual(validateRun(written).problems, []);
    assert.equal(existsSync(join(root, 'cell', 'receipt.json')), true, 'a planned cell always leaves a document');
  } finally {
    head.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
