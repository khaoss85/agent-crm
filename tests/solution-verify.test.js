import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MAX_SCENARIO_RUNS, REQUIREMENT_STATUSES, SOLUTION_VERIFICATION_CONTRACT, VERIFY_DEPTH_ENV,
  semanticFingerprint, solutionVerifyCommand,
} from '../packages/cli/src/solution-verify-command.js';
import {
  fingerprintPlan, inspectionFingerprint, planRequirements, validateSolutionPlan,
} from '../packages/core/src/solution-plan.js';
import { effectiveRequirementCategory } from '../packages/core/src/implementation-evidence.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * DX10's verifier. The expensive delegates — AX1, `project verify`, the
 * scenarios — are injected: this file is about what the verifier *decides* and
 * what it *refuses*, and re-running an eleven-minute suite inside a unit test
 * would prove nothing except patience. The delegates' report shapes are copied
 * from their real contracts, and the two checked-in evidence documents are
 * additionally validated against their real plans in
 * `tests/implementation-evidence.test.js`.
 */

// This suite exercises the command directly, so it must not inherit the marker
// from an outer `solution verify` that spawned the suite it is running in.
delete process.env[VERIFY_DEPTH_ENV];

/**
 * An AX1 report. The verifier **derives** the composition digest from the
 * report rather than trusting a field, so a stub cannot hand it a digest — it
 * has to hand it a composition, and the digest follows. That is the property
 * under test as much as it is a detail of the fixtures.
 */
function ax1Report({ modules = ['widget'], actions = [], capabilities = [], packages = [], policies = [], resources = [] } = {}) {
  return {
    applicationInspectionContract: 1,
    valid: true,
    application: { packageContract: 1, composition: [] },
    packages: packages.map((name) => ({ name, version: 1, packageContract: 1, resources: [], actions: [], policies: [], requires: [], provides: [] })),
    capabilities,
    resources: resources.map((resource) => ({ resource, package: 'p' })),
    actions,
    policies,
    providers: [],
    modules: modules.map((name) => ({ name, owner: 'project', kind: 'record', revision: null, manifestVersion: null, stateFile: null, migrations: [] })),
    problems: [],
    limitations: [],
  };
}

/** The composition every fixture plan is pinned to. */
const BASE_REPORT = ax1Report({
  modules: ['widget'],
  capabilities: [{ name: 'widget-things', version: 1, provider: 'p', status: 'resolved', consumers: [] }],
  actions: [{ module: 'widget', name: 'do', owner: 'p', actionContract: 1, stateField: null, externalOperation: false, confirm: false, fromStates: null, input: [] }],
});
const COMPOSITION_FP = inspectionFingerprint(BASE_REPORT);
const OTHER_FP = inspectionFingerprint(ax1Report({ modules: ['something-else'] }));

/** A plan with one step per decision type we care about, plus acceptance checks. */
function planDocument(overrides = {}) {
  return {
    solutionPlanContract: 1,
    revision: 1,
    goal: { id: 'demo', statement: 'a demonstrated goal', outcome: 'the outcome' },
    metric: { name: 'share', definition: 'a share of something', baseline: null, target: '80%' },
    application: {
      inspectionContract: 1,
      inspectionFingerprint: COMPOSITION_FP,
      packages: [],
      capabilities: [],
      modules: [],
    },
    evidence: {
      observedFacts: [{ id: 'fact.one', statement: 'something was observed', source: 'the report', citations: [] }],
      derivedMetrics: [], assumptions: [], inferences: [],
      recommendations: [{ id: 'rec.one', statement: 'do the thing', citations: ['fact.one'] }],
      unavailableEvidence: [],
    },
    decisions: [
      { id: 'd.configure', type: 'configure', target: 'app.thing', rationale: 'it exists already' },
      { id: 'd.evolve', type: 'evolve', target: 'widget', rationale: 'the record needs a field' },
    ],
    steps: [
      { id: 'step.behave', decisionId: 'd.configure', description: 'the application does the thing', requiresCapabilities: [], approvals: [], verifies: [] },
      { id: 'step.shape', decisionId: 'd.evolve', description: 'the record gains a field', requiresCapabilities: [], approvals: [], verifies: [] },
    ],
    approvals: [],
    acceptance: {
      checks: [
        'the suite passes',
        'the journey completes',
        'a person reads the screen',
        'the package conforms',
      ],
      jtbdRows: [],
      artifacts: [],
    },
    limitations: [],
    ...overrides,
  };
}

/** The derived requirement ids of a plan document, keyed by their statement. */
function requirementIds(raw) {
  const { plan } = validateSolutionPlan(raw);
  const rows = planRequirements(plan).requirements;
  return Object.fromEntries(rows.map((row) => [row.statement, row.requirementId]));
}

/** A project holding a plan and an evidence document. */
function project(t, { plan = planDocument(), evidence } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dx10-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'plans'), { recursive: true });
  writeFileSync(join(root, 'plans/demo.plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
  writeFileSync(join(root, 'plans/demo.evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  return root;
}

/** AX1 as a delegate. */
function inspectStub(report = BASE_REPORT) {
  return async () => ({ exitCode: 0, report });
}

/** A `project verify` receipt. */
function verifyStub(checks = [{ code: 'suite.verify', status: 'passed' }], { calls = [] } = {}) {
  return async (options) => {
    calls.push(options);
    return {
      exitCode: 0,
      report: {
        projectVerificationContract: 1, status: 'passed', fingerprint: 'v'.repeat(64),
        checks: checks.map((row) => ({ category: 'suite', authority: 'project-script', required: true, ...row })),
        problems: [], limitations: [],
      },
    };
  };
}

/** A DX6 report with the observation codes and kinds a scenario really publishes. */
function scenarioStub(observations, { compositionFingerprint = COMPOSITION_FP, calls = [], missing = [] } = {}) {
  return async (options) => {
    calls.push(options.scenarioRef);
    if (missing.includes(options.scenarioRef)) return { exitCode: 2, report: null };
    return {
      exitCode: 0,
      report: {
        scenarioRunContract: 2,
        scenario: { id: options.scenarioRef },
        status: 'passed',
        fingerprint: 's'.repeat(64),
        composition: { inspected: true, valid: true, compositionFingerprint, packages: [], problems: [] },
        observations,
        problems: [], limitations: [],
      },
    };
  };
}

const observation = (code, kind, expected, status = 'passed', actual = 'ok') => ({
  code, kind, step: code.split('.')[0], status, expected, actual, reason: null,
});

const OBSERVATIONS = [
  observation('run.01', 'journey.completed', 'the journey completes and reports success'),
  observation('run.02', 'journey.fact', 'journey.fact fact=thingHappened is=true'),
  observation('shape.01', 'action.present', 'action.present action=widget.do'),
];

/** No git: the worktree question has no meaning, and every test says so. */
const noGit = () => null;

/** Run the command against a project, collecting stdout. */
async function run(root, { json = true, ...options } = {}) {
  let stdout = '';
  let stderr = '';
  const result = await solutionVerifyCommand({
    planPath: 'plans/demo.plan.json',
    evidencePath: 'plans/demo.evidence.json',
    rootDir: root,
    json,
    out: (text) => { stdout += text; },
    err: (text) => { stderr += text; },
    inspect: inspectStub(),
    verify: verifyStub(),
    scenario: scenarioStub(OBSERVATIONS),
    git: noGit,
    env: {},
    ...options,
  });
  return { ...result, stdout, stderr };
}

/** An evidence document for the demo plan. */
function evidenceDocument(plan, overrides = {}) {
  const ids = requirementIds(plan);
  const { plan: normalized } = validateSolutionPlan(plan);
  return {
    implementationEvidenceContract: 1,
    plan: 'plans/demo.plan.json',
    planFingerprint: fingerprintPlan(normalized),
    applicationInspectionFingerprint: normalized.application.inspectionFingerprint,
    requirements: [
      {
        requirementId: ids['the application does the thing'],
        category: 'behavioural',
        evidence: [{ kind: 'scenario.observation', scenario: 'demo', observation: 'run.02', expects: 'journey.fact fact=thingHappened is=true' }],
      },
      {
        requirementId: ids['the record gains a field'],
        category: 'structural',
        evidence: [{ kind: 'application.fact', fact: 'module.present', name: 'widget' }],
      },
      {
        requirementId: ids['the suite passes'],
        category: 'project-health',
        evidence: [{ kind: 'project.verification', check: 'suite.verify', expect: 'passed' }],
      },
      {
        requirementId: ids['the journey completes'],
        category: 'behavioural',
        evidence: [{ kind: 'scenario.observation', scenario: 'demo', observation: 'run.01', expects: 'the journey completes and reports success' }],
      },
      {
        requirementId: ids['a person reads the screen'],
        category: 'manual',
        evidence: [{ kind: 'manual', describes: 'a person opens the screen and reads it' }],
      },
      {
        requirementId: ids['the package conforms'],
        category: 'package-architecture',
        evidence: [{ kind: 'package.conformance', package: 'packages/widget' }],
      },
    ],
    limitations: [],
    ...overrides,
  };
}

/** The whole demo set-up, with the conformance check present by default. */
function demo(t, { plan = planDocument(), evidence, ...rest } = {}) {
  return project(t, { plan, evidence: evidence ?? evidenceDocument(plan), ...rest });
}

const CONFORMING_CHECKS = [
  { code: 'suite.verify', status: 'passed' },
  { code: 'packages.conformance.packages/widget', status: 'passed' },
];

const statusOf = (report, id) => report.requirements.find((row) => row.requirementId === id)?.status ?? null;
const codes = (report) => [...new Set(report.problems.map((problem) => problem.code))].sort();

// ---------------------------------------------------------------------------

test('a fully evidenced plan with one manual requirement is incomplete, and exit 0 is forbidden', async (t) => {
  const plan = planDocument();
  const root = demo(t, { plan });
  const ids = requirementIds(plan);
  const { exitCode, report } = await run(root, { verify: verifyStub(CONFORMING_CHECKS) });

  assert.equal(report.solutionVerificationContract, SOLUTION_VERIFICATION_CONTRACT);
  // Steps are typed by the plan, so both are graded as the plan says.
  assert.equal(statusOf(report, ids['the application does the thing']), 'verified');
  assert.equal(statusOf(report, ids['the record gains a field']), 'verified');
  // An acceptance check is untyped, so it is graded behavioural whatever its
  // author declared. This fixture declares two of them as the weaker categories
  // and both are refused — that is the exploit, closed (ADR-031).
  assert.equal(statusOf(report, ids['the suite passes']), 'unevidenced');
  assert.equal(statusOf(report, ids['the package conforms']), 'unevidenced');
  assert.ok(codes(report).includes('EVIDENCE_CATEGORY_BELOW_FLOOR'));
  // Declared behavioural, evidenced by a runtime observation: verified.
  assert.equal(statusOf(report, ids['the journey completes']), 'verified');
  // The manual one is the whole point: the command still refuses to exit 0.
  assert.equal(statusOf(report, ids['a person reads the screen']), 'unverified');
  assert.equal(report.status, 'incomplete');
  assert.equal(exitCode, 1, 'exit 0 is forbidden while manual evidence remains required');
  assert.ok(report.limitations.some((row) => row.code === 'MANUAL_EVIDENCE_REMAINS_REQUIRED'));
  assert.ok(report.limitations.some((row) => row.code === 'MANUAL_EVIDENCE_IS_NOT_PROOF'));
});

test('exit 0 happens only when every requirement is machine-verified', async (t) => {
  const plan = planDocument({
    acceptance: { checks: ['the journey completes'], jtbdRows: [], artifacts: [] },
    steps: [{ id: 'step.behave', decisionId: 'd.configure', description: 'the application does the thing', requiresCapabilities: [], approvals: [], verifies: [] }],
    decisions: [{ id: 'd.configure', type: 'configure', target: 'app.thing', rationale: 'it exists already' }],
  });
  const ids = requirementIds(plan);
  const evidence = {
    implementationEvidenceContract: 1,
    plan: 'plans/demo.plan.json',
    planFingerprint: fingerprintPlan(validateSolutionPlan(plan).plan),
    applicationInspectionFingerprint: COMPOSITION_FP,
    requirements: [
      {
        requirementId: ids['the application does the thing'], category: 'behavioural',
        evidence: [{ kind: 'scenario.observation', scenario: 'demo', observation: 'run.02', expects: 'journey.fact fact=thingHappened is=true' }],
      },
      {
        // An acceptance check is untyped, so exit 0 is only reachable through a
        // runtime observation from a run that happened. Citing `suite.verify`
        // here is exactly the shape the floor refuses.
        requirementId: ids['the journey completes'], category: 'behavioural',
        evidence: [{ kind: 'scenario.observation', scenario: 'demo', observation: 'run.01', expects: 'the journey completes and reports success' }],
      },
    ],
    limitations: [],
  };
  const root = demo(t, { plan, evidence });
  const { exitCode, report } = await run(root);
  assert.equal(report.status, 'verified', JSON.stringify(report.problems));
  assert.equal(exitCode, 0);
  assert.deepEqual(report.unproven, []);
});

test('a behavioural requirement is never satisfied by a file existing', async (t) => {
  const plan = planDocument();
  const ids = requirementIds(plan);
  const evidence = evidenceDocument(plan);
  evidence.requirements[0].evidence = [{
    kind: 'source.artifact', path: 'plans/demo.plan.json',
    sha256: 'e'.repeat(64),
  }];
  const root = demo(t, { plan, evidence });
  // Give the hash the real value, so the *only* reason it fails is sufficiency.
  const actual = createHash('sha256').update(readFileSync(join(root, 'plans/demo.plan.json'))).digest('hex');
  evidence.requirements[0].evidence[0].sha256 = actual;
  writeFileSync(join(root, 'plans/demo.evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);

  const { exitCode, report } = await run(root, { verify: verifyStub(CONFORMING_CHECKS) });
  assert.equal(statusOf(report, ids['the application does the thing']), 'unevidenced');
  assert.ok(codes(report).includes('EVIDENCE_STRUCTURAL_ONLY'));
  assert.equal(exitCode, 1);
  const row = report.requirements.find((entry) => entry.requirementId === ids['the application does the thing']);
  assert.equal(row.evidence[0].resolved, true, 'the hash matched — the refusal is about sufficiency, not staleness');
});

test('a behavioural requirement is not satisfied by a composition observation either', async (t) => {
  const plan = planDocument();
  const ids = requirementIds(plan);
  const evidence = evidenceDocument(plan);
  // `action.present`, answered inside the scenario. It is a real, passing
  // observation — and "the action is declared" is not "the application does it".
  evidence.requirements[0].evidence = [{
    kind: 'scenario.observation', scenario: 'demo', observation: 'shape.01',
    expects: 'action.present action=widget.do',
  }];
  const root = demo(t, { plan, evidence });
  const { report } = await run(root, { verify: verifyStub(CONFORMING_CHECKS) });
  assert.equal(statusOf(report, ids['the application does the thing']), 'unevidenced');
  assert.ok(codes(report).includes('EVIDENCE_INSUFFICIENT_FOR_CATEGORY'));
});

test('a purely structural requirement needs no scenario', async (t) => {
  const plan = planDocument();
  const ids = requirementIds(plan);
  const { report } = await run(demo(t, { plan }), { verify: verifyStub(CONFORMING_CHECKS) });
  const row = report.requirements.find((entry) => entry.requirementId === ids['the record gains a field']);
  assert.equal(row.status, 'verified');
  assert.deepEqual(row.evidence.map((entry) => entry.kind), ['application.fact']);
});

test('a step whose decision changes behaviour cannot be evidenced as structural', async (t) => {
  const plan = planDocument();
  const ids = requirementIds(plan);
  const evidence = evidenceDocument(plan);
  evidence.requirements[0].category = 'structural';
  evidence.requirements[0].evidence = [{ kind: 'application.fact', fact: 'module.present', name: 'widget' }];
  const { report } = await run(demo(t, { plan, evidence }), { verify: verifyStub(CONFORMING_CHECKS) });
  assert.ok(codes(report).includes('EVIDENCE_CATEGORY_BELOW_FLOOR'));
  // The floor is not merely reported — it is what the sufficiency rule is
  // applied against. Grading the weaker claim would let the label decide the
  // outcome, which is the one thing a declared category must never do.
  assert.equal(statusOf(report, ids['the application does the thing']), 'unevidenced');
  assert.ok(codes(report).includes('EVIDENCE_INSUFFICIENT_FOR_CATEGORY'));
  assert.equal(report.status, 'incomplete');
});

test('a declared downgrade lowers a status and can never raise one', async (t) => {
  const plan = planDocument();
  const ids = requirementIds(plan);
  const evidence = evidenceDocument(plan);
  evidence.requirements[1].partial = { reason: 'only half of the field is there' };
  evidence.requirements[2].blocked = { reason: 'the suite cannot run on this machine' };
  const { report, exitCode } = await run(demo(t, { plan, evidence }), { verify: verifyStub(CONFORMING_CHECKS) });
  assert.equal(statusOf(report, ids['the record gains a field']), 'partial');
  assert.equal(statusOf(report, ids['the suite passes']), 'blocked');
  assert.equal(exitCode, 1, 'a partial plan is not "verified with warnings"');
  const partial = report.requirements.find((row) => row.requirementId === ids['the record gains a field']);
  assert.equal(partial.reason, 'only half of the field is there');
});

test('a manual note beside real evidence is context; manual evidence alone is never enough', async (t) => {
  const plan = planDocument();
  const ids = requirementIds(plan);

  // A manual note added *beside* a passing runtime observation is context, not a
  // fault: a human's word is recorded and never resolved, and it must not sink
  // a requirement the machine evidence already satisfies.
  const beside = evidenceDocument(plan);
  beside.requirements[0].evidence.push({ kind: 'manual', describes: 'a reviewer also read the audit trail by hand' });
  const withNote = await run(demo(t, { plan, evidence: beside }), { verify: verifyStub(CONFORMING_CHECKS) });
  assert.equal(statusOf(withNote.report, ids['the application does the thing']), 'verified');

  // Manual evidence *alone*, under a category that is not `manual`, satisfies
  // nothing — and the reason says so rather than reading as a broken reference.
  const alone = evidenceDocument(plan);
  alone.requirements[0].evidence = [{ kind: 'manual', describes: 'a reviewer said it works' }];
  const onlyNote = await run(demo(t, { plan, evidence: alone }), { verify: verifyStub(CONFORMING_CHECKS) });
  assert.equal(statusOf(onlyNote.report, ids['the application does the thing']), 'unevidenced');
  assert.ok(codes(onlyNote.report).includes('EVIDENCE_INSUFFICIENT_FOR_CATEGORY'));
  const row = onlyNote.report.requirements.find((entry) => entry.requirementId === ids['the application does the thing']);
  assert.equal(row.reason.includes('null'), false, 'a manual note is not a reference that failed to resolve');
});

test('a requirement the evidence never mentions is reported, not skipped', async (t) => {
  const plan = planDocument();
  const ids = requirementIds(plan);
  const evidence = evidenceDocument(plan);
  evidence.requirements = evidence.requirements.filter((row) => row.requirementId !== ids['the suite passes']);
  const { report, exitCode } = await run(demo(t, { plan, evidence }), { verify: verifyStub(CONFORMING_CHECKS) });
  assert.equal(statusOf(report, ids['the suite passes']), 'unevidenced');
  assert.ok(codes(report).includes('EVIDENCE_REQUIREMENT_MISSING'));
  assert.equal(exitCode, 1);
  assert.equal(report.requirements.length, 6, 'the report enumerates every requirement the plan has');
});

test('evidence about a requirement the plan does not have is refused', async (t) => {
  const plan = planDocument();
  const evidence = evidenceDocument(plan);
  // A well-formed id of the derived width that this plan simply does not have.
  evidence.requirements.push({ requirementId: `check:${'0'.repeat(32)}`, category: 'structural', evidence: [] });
  const { report, exitCode } = await run(demo(t, { plan, evidence }), { verify: verifyStub(CONFORMING_CHECKS) });
  assert.ok(codes(report).includes('EVIDENCE_REQUIREMENT_UNKNOWN'));
  assert.equal(exitCode, 1);
});

// ---------------------------------------------------------------------------
// the mutation matrix, on a controlled plan
// ---------------------------------------------------------------------------

test('an unknown check code is a citation to nothing, not a pass', async (t) => {
  const plan = planDocument();
  const ids = requirementIds(plan);
  const evidence = evidenceDocument(plan);
  evidence.requirements[2].evidence = [{ kind: 'project.verification', check: 'suite.invented', expect: 'passed' }];
  const { report } = await run(demo(t, { plan, evidence }), { verify: verifyStub(CONFORMING_CHECKS) });
  assert.equal(statusOf(report, ids['the suite passes']), 'unevidenced');
  assert.ok(codes(report).includes('EVIDENCE_REFERENCE_UNRESOLVED'));
});

test('a project-verify check that failed fails the requirement that cited it', async (t) => {
  const plan = planDocument();
  const ids = requirementIds(plan);
  const { report } = await run(demo(t, { plan }), {
    verify: verifyStub([{ code: 'suite.verify', status: 'failed' }, { code: 'packages.conformance.packages/widget', status: 'passed' }]),
  });
  assert.equal(statusOf(report, ids['the suite passes']), 'unevidenced');
  assert.equal(statusOf(report, ids['the record gains a field']), 'verified', 'only the citing requirement fails');
  assert.ok(codes(report).includes('EVIDENCE_CHECK_UNEXPECTED_STATUS'));
});

test('a package that was not graded for conformance has no pass to cite', async (t) => {
  const plan = planDocument();
  const ids = requirementIds(plan);
  const { report } = await run(demo(t, { plan }), { verify: verifyStub([{ code: 'suite.verify', status: 'passed' }]) });
  assert.equal(statusOf(report, ids['the package conforms']), 'unevidenced');
  assert.ok(codes(report).includes('EVIDENCE_REFERENCE_UNRESOLVED'));
});

test('a failing scenario observation fails exactly the requirement that cited it', async (t) => {
  const plan = planDocument();
  const ids = requirementIds(plan);
  const failing = [
    OBSERVATIONS[0],
    { ...OBSERVATIONS[1], status: 'failed', actual: 'thingHappened = false', reason: 'the journey said false' },
    OBSERVATIONS[2],
  ];
  const { report } = await run(demo(t, { plan }), {
    verify: verifyStub(CONFORMING_CHECKS), scenario: scenarioStub(failing),
  });
  assert.equal(statusOf(report, ids['the application does the thing']), 'unevidenced');
  assert.equal(statusOf(report, ids['the journey completes']), 'verified', 'the other observation is untouched');
  assert.ok(codes(report).includes('EVIDENCE_OBSERVATION_FAILED'));
});

test('an observation code that still exists but no longer means the same thing is refused', async (t) => {
  const plan = planDocument();
  const ids = requirementIds(plan);
  const moved = [
    OBSERVATIONS[0],
    observation('run.02', 'journey.fact', 'journey.fact fact=thingHappened is=false'),
    OBSERVATIONS[2],
  ];
  const { report } = await run(demo(t, { plan }), {
    verify: verifyStub(CONFORMING_CHECKS), scenario: scenarioStub(moved),
  });
  assert.equal(statusOf(report, ids['the application does the thing']), 'unevidenced');
  assert.ok(codes(report).includes('EVIDENCE_OBSERVATION_MOVED'),
    'an observation code is a position in a document, and a document can be edited');
});

test('an unknown observation code is refused', async (t) => {
  const plan = planDocument();
  const evidence = evidenceDocument(plan);
  evidence.requirements[0].evidence = [{ kind: 'scenario.observation', scenario: 'demo', observation: 'run.99', expects: 'anything' }];
  const { report } = await run(demo(t, { plan, evidence }), { verify: verifyStub(CONFORMING_CHECKS) });
  assert.ok(codes(report).includes('EVIDENCE_REFERENCE_UNRESOLVED'));
});

test('a source file that moved, and one that is gone, each fail their own requirement', async (t) => {
  const plan = planDocument();
  const ids = requirementIds(plan);
  const evidence = evidenceDocument(plan);
  evidence.requirements[1].evidence.push({ kind: 'source.artifact', path: 'plans/absent.js', sha256: 'f'.repeat(64) });
  let root = demo(t, { plan, evidence });
  let { report } = await run(root, { verify: verifyStub(CONFORMING_CHECKS) });
  assert.equal(statusOf(report, ids['the record gains a field']), 'unevidenced');
  assert.ok(codes(report).includes('EVIDENCE_SOURCE_ABSENT'));

  const changed = evidenceDocument(plan);
  changed.requirements[1].evidence.push({ kind: 'source.artifact', path: 'plans/demo.plan.json', sha256: '0'.repeat(64) });
  root = demo(t, { plan, evidence: changed });
  ({ report } = await run(root, { verify: verifyStub(CONFORMING_CHECKS) }));
  assert.equal(statusOf(report, ids['the record gains a field']), 'unevidenced');
  assert.ok(codes(report).includes('EVIDENCE_SOURCE_HASH_MISMATCH'));
});

test('a capability and an action are cited by identity, and a fact that is not there is absent', async (t) => {
  const plan = planDocument();
  const ids = requirementIds(plan);
  const evidence = evidenceDocument(plan);
  evidence.requirements[1].evidence = [
    { kind: 'application.fact', fact: 'capability.available', name: 'widget-things', version: 1 },
    { kind: 'application.fact', fact: 'action.present', name: 'widget.do' },
  ];
  const present = await run(demo(t, { plan, evidence }), { verify: verifyStub(CONFORMING_CHECKS) });
  assert.equal(statusOf(present.report, ids['the record gains a field']), 'verified');

  // Cite an identity this composition never had — an author error rather than
  // drift. The composition digest still matches, so the plan is current and the
  // refusal lands on exactly the requirement that cited it.
  const wrong = evidenceDocument(plan);
  wrong.requirements[1].evidence = [
    { kind: 'application.fact', fact: 'capability.available', name: 'widget-things', version: 2 },
    { kind: 'application.fact', fact: 'action.present', name: 'widget.perform' },
  ];
  const absent = await run(demo(t, { plan, evidence: wrong }), { verify: verifyStub(CONFORMING_CHECKS) });
  assert.equal(absent.report.binding.boundTo, 'project', 'the composition still matches');
  assert.ok(codes(absent.report).includes('EVIDENCE_FACT_ABSENT'));
  assert.equal(statusOf(absent.report, ids['the record gains a field']), 'unevidenced');
  assert.equal(statusOf(absent.report, ids['the journey completes']), 'verified', 'only the citing requirement fails');
});

test('a capability that actually disappeared moves the composition digest, and the plan goes stale', async (t) => {
  // The other half of the same mutation, and the distinction matters: an author
  // citing something that was never there is one fault; the application losing
  // a capability is drift over the whole composition, which AX2 already detects
  // as one digest rather than as a list this command would have to re-derive.
  const plan = planDocument();
  const withoutCapability = ax1Report({
    modules: ['widget'],
    capabilities: [{ name: 'widget-things', version: 1, provider: 'p', status: 'missing', consumers: [] }],
    actions: [{ module: 'widget', name: 'do', owner: 'p', actionContract: 1, stateField: null, externalOperation: false, confirm: false, fromStates: null, input: [] }],
  });
  const { report, exitCode } = await run(demo(t, { plan }), {
    verify: verifyStub(CONFORMING_CHECKS),
    inspect: inspectStub(withoutCapability),
    // The scenario composed its own application, and it is not this one either,
    // so no authority in the run produced the digest the plan pins.
    scenario: scenarioStub(OBSERVATIONS, { compositionFingerprint: inspectionFingerprint(withoutCapability) }),
  });
  assert.equal(report.binding.boundTo, null);
  assert.ok(codes(report).includes('PLAN_NOT_CURRENT'));
  assert.deepEqual([...new Set(report.requirements.map((row) => row.status))], ['stale']);
  assert.equal(exitCode, 1);
});

test('a moved plan fingerprint stales every requirement rather than failing one', async (t) => {
  const plan = planDocument();
  const evidence = evidenceDocument(plan);
  evidence.planFingerprint = 'c'.repeat(64);
  const { report, exitCode } = await run(demo(t, { plan, evidence }), { verify: verifyStub(CONFORMING_CHECKS) });
  assert.ok(codes(report).includes('EVIDENCE_PLAN_FINGERPRINT_STALE'));
  assert.deepEqual([...new Set(report.requirements.map((row) => row.status))], ['stale']);
  assert.equal(exitCode, 1);
});

test('a composition nothing in this run produced is PLAN_NOT_CURRENT, and nothing is proven', async (t) => {
  const plan = planDocument();
  const evidence = evidenceDocument(plan);
  const { report, exitCode } = await run(demo(t, { plan, evidence }), {
    verify: verifyStub(CONFORMING_CHECKS),
    inspect: inspectStub(ax1Report({ modules: ['something-else'] })),
    scenario: scenarioStub(OBSERVATIONS, { compositionFingerprint: OTHER_FP }),
  });
  assert.ok(codes(report).includes('PLAN_NOT_CURRENT'));
  assert.deepEqual([...new Set(report.requirements.map((row) => row.status))], ['stale']);
  assert.equal(report.binding.boundTo, null);
  assert.equal(exitCode, 1);
});

test('evidence gathered against a different application is refused', async (t) => {
  const plan = planDocument();
  const evidence = evidenceDocument(plan);
  evidence.applicationInspectionFingerprint = OTHER_FP;
  const { report } = await run(demo(t, { plan, evidence }), { verify: verifyStub(CONFORMING_CHECKS) });
  assert.ok(codes(report).includes('EVIDENCE_INSPECTION_STALE'));
  assert.deepEqual([...new Set(report.requirements.map((row) => row.status))], ['stale']);
});

test('an evidence document written about another plan is refused', async (t) => {
  const plan = planDocument();
  const evidence = evidenceDocument(plan);
  evidence.plan = 'plans/other.plan.json';
  const { report } = await run(demo(t, { plan, evidence }), { verify: verifyStub(CONFORMING_CHECKS) });
  assert.ok(codes(report).includes('EVIDENCE_PLAN_MISMATCH'));
});

// ---------------------------------------------------------------------------
// binding, execution, integrity
// ---------------------------------------------------------------------------

test('a plan whose composition only a scenario produced binds through that scenario, and no application fact may be cited', async (t) => {
  const plan = planDocument();
  const ids = requirementIds(plan);
  const { report } = await run(demo(t, { plan }), {
    verify: verifyStub(CONFORMING_CHECKS),
    // The project's own root is a *different* application, exactly as a
    // framework repository is to the project a starter composes.
    inspect: inspectStub(ax1Report({ modules: ['something-else'] })),
    scenario: scenarioStub(OBSERVATIONS, { compositionFingerprint: COMPOSITION_FP }),
  });
  assert.equal(report.binding.boundTo, 'scenario:demo');
  assert.equal(report.binding.planIsCurrent, false);
  assert.ok(report.limitations.some((row) => row.code === 'PLAN_BOUND_THROUGH_A_SCENARIO'));
  // Behavioural requirements still verify — they were observed where the
  // application actually was.
  assert.equal(statusOf(report, ids['the application does the thing']), 'verified');
  // The application fact cannot be answered: the only full AX1 report describes
  // a different composition. That is an authority this run does not have, not
  // an author who wrote no evidence, and the two must not share a word.
  assert.equal(statusOf(report, ids['the record gains a field']), 'unverifiable');
  assert.ok(codes(report).includes('EVIDENCE_AUTHORITY_UNAVAILABLE'));
});

test('only explicitly referenced scenarios run, each exactly once, and project verify only when something cites it', async (t) => {
  const plan = planDocument();
  const scenarioCalls = [];
  const verifyCalls = [];
  await run(demo(t, { plan }), {
    verify: verifyStub(CONFORMING_CHECKS, { calls: verifyCalls }),
    scenario: scenarioStub(OBSERVATIONS, { calls: scenarioCalls }),
  });
  assert.deepEqual(scenarioCalls, ['demo'], 'two references to one scenario is one run');
  assert.equal(verifyCalls.length, 1);

  // Take away everything that references DX5 and it is not run at all.
  const evidence = evidenceDocument(plan);
  evidence.requirements = evidence.requirements.filter((row) => !['project-health', 'package-architecture'].includes(row.category));
  const quiet = [];
  await run(demo(t, { plan, evidence }), { verify: verifyStub(CONFORMING_CHECKS, { calls: quiet }) });
  assert.deepEqual(quiet, [], 'nothing referenced it, so the expensive authority was not run');
});

test('a scenario that produced no report resolves nothing, and nothing is assumed in its place', async (t) => {
  const plan = planDocument();
  const ids = requirementIds(plan);
  const { report } = await run(demo(t, { plan }), {
    verify: verifyStub(CONFORMING_CHECKS),
    scenario: scenarioStub(OBSERVATIONS, { missing: ['demo'] }),
  });
  assert.ok(codes(report).includes('VERIFICATION_AUTHORITY_FAILED'));
  // The scenario did not run, so this says nothing about the work.
  assert.equal(statusOf(report, ids['the application does the thing']), 'unverifiable');
});

test('a document referencing more scenarios than the bound allows is refused, not run', async (t) => {
  const plan = planDocument();
  const evidence = evidenceDocument(plan);
  evidence.requirements[0].evidence = Array.from({ length: MAX_SCENARIO_RUNS + 1 }, (_, index) => ({
    kind: 'scenario.observation', scenario: `scenario-${index}`, observation: 'run.02',
    expects: 'journey.fact fact=thingHappened is=true',
  }));
  const calls = [];
  const { report } = await run(demo(t, { plan, evidence }), {
    verify: verifyStub(CONFORMING_CHECKS), scenario: scenarioStub(OBSERVATIONS, { calls }),
  });
  assert.deepEqual(calls, [], 'the refusal happens before anything composes an application');
  assert.ok(codes(report).includes('EVIDENCE_AUTHORITY_UNAVAILABLE'));
});

test('a recursive solution verify is refused, and nothing is run', async (t) => {
  const calls = [];
  const result = await solutionVerifyCommand({
    planPath: 'plans/demo.plan.json',
    evidencePath: 'plans/demo.evidence.json',
    rootDir: demo(t, {}),
    json: true,
    out: () => {}, err: () => {},
    inspect: inspectStub(), verify: verifyStub(CONFORMING_CHECKS, { calls }),
    scenario: scenarioStub(OBSERVATIONS), git: noGit,
    env: { [VERIFY_DEPTH_ENV]: '1' },
  });
  assert.equal(result.exitCode, 2);
  assert.equal(result.report, null);
  assert.deepEqual(calls, []);
});

test('the marker is set on every child, so a delegate can recognise it is inside a verification', async (t) => {
  const seen = [];
  await run(demo(t, {}), {
    verify: async (options) => { seen.push(options.env?.[VERIFY_DEPTH_ENV]); return verifyStub(CONFORMING_CHECKS)(options); },
    scenario: async (options) => { seen.push(options.env?.[VERIFY_DEPTH_ENV]); return scenarioStub(OBSERVATIONS)(options); },
  });
  assert.deepEqual([...new Set(seen)], ['1']);
});

test('two runs of an unchanged project produce byte-identical reports', async (t) => {
  const plan = planDocument();
  const root = demo(t, { plan });
  const first = await run(root, { verify: verifyStub(CONFORMING_CHECKS) });
  const second = await run(root, { verify: verifyStub(CONFORMING_CHECKS) });
  assert.equal(first.stdout, second.stdout);
  assert.equal(first.report.fingerprint, second.report.fingerprint);
  assert.equal(semanticFingerprint(first.report), first.report.fingerprint);
  // No duration, timestamp, temporary path or machine layout enters the report
  // at all — not merely the fingerprint.
  assert.equal(first.stdout.includes(root), false, 'no absolute path reaches the report');
  assert.equal(/"durationMs"|"timestamp"|"startedAt"/.test(first.stdout), false);
});

test('the report is compact enough for a coding agent to carry', async (t) => {
  const { stdout, report } = await run(demo(t, {}), { verify: verifyStub(CONFORMING_CHECKS) });
  assert.ok(stdout.length < 64 * 1024, `the report is ${stdout.length} bytes`);
  // The negative is a first-class field rather than something to reconstruct.
  assert.deepEqual(
    report.unproven.map((row) => row.requirementId).sort(),
    report.requirements.filter((row) => row.status !== 'verified').map((row) => row.requirementId).sort(),
  );
  for (const row of report.requirements) assert.ok(REQUIREMENT_STATUSES.includes(row.status));
});

test('the report names every authority it used, with the fingerprint of that run', async (t) => {
  const { report } = await run(demo(t, {}), { verify: verifyStub(CONFORMING_CHECKS) });
  const kinds = report.authorities.map((row) => row.kind).sort();
  assert.deepEqual(kinds, ['application-inspection', 'project-verification', 'scenario']);
  for (const authority of report.authorities) {
    assert.ok(typeof authority.fingerprint === 'string' && authority.fingerprint.length > 0,
      `${authority.kind} publishes the fingerprint of the run that answered`);
  }
  assert.equal(report.promotion.performed, false);
  assert.deepEqual(report.promotion.wrote, []);
});

test('an unreadable document is exit 2, never a report full of zeroes', async (t) => {
  const root = demo(t, {});
  writeFileSync(join(root, 'plans/demo.evidence.json'), '{not json');
  const broken = await run(root);
  assert.equal(broken.exitCode, 2);
  assert.equal(broken.report, null);

  const missing = await solutionVerifyCommand({
    planPath: 'plans/nope.plan.json', evidencePath: 'plans/demo.evidence.json',
    rootDir: root, json: true, out: () => {}, err: () => {}, git: noGit, env: {},
  });
  assert.equal(missing.exitCode, 2);
});

test('a document outside the project is refused before it is read', async (t) => {
  const root = demo(t, {});
  const outside = mkdtempSync(join(tmpdir(), 'dx10-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, 'evil.json'), '{}');
  const result = await solutionVerifyCommand({
    planPath: 'plans/demo.plan.json', evidencePath: join(outside, 'evil.json'),
    rootDir: root, json: true, out: () => {}, err: () => {}, git: noGit, env: {},
  });
  assert.equal(result.exitCode, 2);
});

test('an invalid plan is PLAN_INVALID, and nothing is run and nothing is graded', async (t) => {
  // A plan that failed validation is `solution check`'s answer, not this one's.
  // Grading requirements derived from a document that did not validate would
  // publish rows a reader would act on, so it refuses before any authority runs.
  const plan = planDocument({ steps: [{ id: 'step.x', decisionId: 'd.missing', description: 'x', requiresCapabilities: [], approvals: [], verifies: [] }] });
  const root = demo(t, { plan, evidence: evidenceDocument(planDocument()) });
  const calls = [];
  const { report, exitCode, stdout } = await run(root, { verify: verifyStub(CONFORMING_CHECKS, { calls }) });
  assert.equal(exitCode, 2);
  assert.equal(report, null, 'no requirement carries a status when the plan is invalid');
  assert.deepEqual(calls, [], 'no authority is run against an invalid plan');
  const emitted = JSON.parse(stdout);
  assert.ok(emitted.problems.some((problem) => problem.code === 'PLAN_INVALID'));
  assert.deepEqual(emitted.requirements, []);
});

test('an invalid evidence document runs no authority either', async (t) => {
  const plan = planDocument();
  const evidence = evidenceDocument(plan);
  evidence.requirements[0].somethingNobodyDeclared = true;
  const calls = [];
  const scenarioCalls = [];
  const { exitCode, report, stdout } = await run(demo(t, { plan, evidence }), {
    verify: verifyStub(CONFORMING_CHECKS, { calls }),
    scenario: scenarioStub(OBSERVATIONS, { calls: scenarioCalls }),
  });
  assert.equal(exitCode, 2);
  assert.equal(report, null);
  assert.deepEqual(calls, [], 'project verify is not spent on a document already known to be invalid');
  assert.deepEqual(scenarioCalls, []);
  assert.ok(JSON.parse(stdout).problems.some((problem) => problem.code === 'EVIDENCE_FIELD_UNKNOWN'));
});

// ---------------------------------------------------------------------------
// dirty state
// ---------------------------------------------------------------------------

test('the evidence document under active work is context, never a mutation caused by verifying', async (t) => {
  const plan = planDocument();
  // The ordinary case: the evidence document is uncommitted while it is written.
  const before = ['??\tplans/demo.evidence.json', ' M\tpackages/core/src/x.js'];
  const git = () => before.join('\n');
  const { report, exitCode } = await run(demo(t, { plan }), { verify: verifyStub(CONFORMING_CHECKS), git });
  assert.deepEqual(report.worktree.changedByVerification, []);
  assert.deepEqual(report.worktree.dirtyBeforeVerification, ['packages/core/src/x.js', 'plans/demo.evidence.json']);
  assert.equal(codes(report).includes('VERIFICATION_DIRTIED_WORKTREE'), false);
  assert.equal(exitCode, 1, 'incomplete for the manual requirement, not for the dirty tree');
});

test('a file that becomes dirty during verification is a failure, and nothing is ever reset', async (t) => {
  const plan = planDocument();
  let call = 0;
  const git = () => (call++ === 0 ? ' M\tdocs/a.md' : ' M\tdocs/a.md\n??\tdata/scratch.sqlite');
  const { report } = await run(demo(t, { plan }), { verify: verifyStub(CONFORMING_CHECKS), git });
  assert.deepEqual(report.worktree.changedByVerification, ['data/scratch.sqlite']);
  assert.ok(codes(report).includes('VERIFICATION_DIRTIED_WORKTREE'));
  assert.deepEqual(report.worktree.dirtyBeforeVerification, ['docs/a.md']);
});

test('uncommitted work a delegate discarded is a failure this command can see', async (t) => {
  const plan = planDocument();
  let call = 0;
  const git = () => (call++ === 0 ? ' M\tdocs/a.md' : '');
  const { report } = await run(demo(t, { plan }), { verify: verifyStub(CONFORMING_CHECKS), git });
  assert.deepEqual(report.worktree.revertedByVerification, ['docs/a.md']);
  assert.ok(codes(report).includes('VERIFICATION_REPAIRED_WORKTREE'));
});

test('a project that is not a git checkout says so rather than guessing', async (t) => {
  const { report } = await run(demo(t, {}), { verify: verifyStub(CONFORMING_CHECKS) });
  assert.equal(report.worktree.sampled, false);
  assert.match(report.worktree.note, /not a git checkout/);
});

// ---------------------------------------------------------------------------
// the real documents this contract was shaped against
// ---------------------------------------------------------------------------

test('the two checked-in evidence documents reference only observations their scenarios publish', () => {
  // Cheap, and it catches the failure the mutation matrix exercises expensively:
  // an evidence document citing an observation code the scenario document does
  // not contain would be a citation to nothing.
  const scenarios = new Map();
  for (const id of ['lead-to-won', 'service-sla-escalation']) {
    const raw = JSON.parse(readFileSync(join(repoRoot, 'examples/scenarios', `${id}.scenario.json`), 'utf8'));
    const codesInScenario = new Set(raw.steps.flatMap((step) => step.observe.map(
      (_, index) => `${step.id}.${String(index + 1).padStart(2, '0')}`,
    )));
    scenarios.set(id, codesInScenario);
  }
  for (const name of ['lead-to-won', 'activate-support-and-manage-cases']) {
    const document = JSON.parse(readFileSync(
      join(repoRoot, 'examples/implementation-evidence', `${name}.evidence.json`), 'utf8',
    ));
    for (const requirement of document.requirements) {
      for (const ref of requirement.evidence ?? []) {
        if (ref.kind !== 'scenario.observation') continue;
        assert.ok(scenarios.has(ref.scenario), `${name}: unknown scenario ${ref.scenario}`);
        assert.ok(scenarios.get(ref.scenario).has(ref.observation),
          `${name}: ${ref.scenario} publishes no observation ${ref.observation}`);
      }
    }
  }
});

test('every source artifact the checked-in documents cite is present with exactly that hash', () => {
  for (const name of ['lead-to-won', 'activate-support-and-manage-cases']) {
    const document = JSON.parse(readFileSync(
      join(repoRoot, 'examples/implementation-evidence', `${name}.evidence.json`), 'utf8',
    ));
    for (const requirement of document.requirements) {
      for (const ref of requirement.evidence ?? []) {
        if (ref.kind !== 'source.artifact') continue;
        const actual = createHash('sha256').update(readFileSync(join(repoRoot, ref.path))).digest('hex');
        assert.equal(actual, ref.sha256, `${name}: ${ref.path} has moved since the evidence was gathered`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// The category exploit (ADR-031). An evidence author declares a category, and
// that category used to select which authority had to answer. The exploit was:
//
//   a behavioural acceptance statement → label it "structural"
//   → cite source.artifact / action.present / package.composed
//   → the verifier reports VERIFIED, having run nothing
//
// These are mutation tests, not description: each takes the *same* behavioural
// acceptance statement and tries every weaker category and every static
// authority against it. None may reach `verified`, and none may reach exit 0.
// ---------------------------------------------------------------------------

/** A one-check plan whose criterion is unambiguously about what the app does. */
function behaviouralCheckPlan() {
  return planDocument({
    steps: [],
    decisions: [{ id: 'd.configure', type: 'configure', target: 'app.thing', rationale: 'it exists already' }],
    acceptance: { checks: ['the application does the thing when a person asks it to'], jtbdRows: [], artifacts: [] },
  });
}

function exploitEvidence(plan, category, refs) {
  const ids = requirementIds(plan);
  const { plan: normalized } = validateSolutionPlan(plan);
  return {
    implementationEvidenceContract: 1,
    plan: 'plans/demo.plan.json',
    planFingerprint: fingerprintPlan(normalized),
    applicationInspectionFingerprint: normalized.application.inspectionFingerprint,
    requirements: [{
      requirementId: ids['the application does the thing when a person asks it to'],
      category,
      evidence: refs,
    }],
    limitations: [],
  };
}

test('a behavioural criterion relabelled as a weaker category cannot reach verified or exit 0', async (t) => {
  const plan = behaviouralCheckPlan();
  const ids = requirementIds(plan);
  const id = ids['the application does the thing when a person asks it to'];

  /** Every static authority an author could reach for, and every weaker label. */
  const staticRefs = {
    'action.present': [{ kind: 'application.fact', fact: 'action.present', name: 'widget.do' }],
    'package.composed': [{ kind: 'application.fact', fact: 'package.composed', name: 'packages/widget' }],
    'module.present': [{ kind: 'application.fact', fact: 'module.present', name: 'widget' }],
    'package.conformance': [{ kind: 'package.conformance', package: 'packages/widget' }],
    'project.verification': [{ kind: 'project.verification', check: 'suite.verify', expect: 'passed' }],
    'composition observation': [{ kind: 'scenario.observation', scenario: 'demo', observation: 'shape.01', expects: 'action.present action=widget.do' }],
  };

  for (const category of ['structural', 'package-architecture', 'project-health']) {
    for (const [label, refs] of Object.entries(staticRefs)) {
      const evidence = exploitEvidence(plan, category, refs);
      const root = demo(t, { plan, evidence });
      const { exitCode, report } = await run(root, { verify: verifyStub(CONFORMING_CHECKS) });
      const status = statusOf(report, id);
      assert.notEqual(status, 'verified', `${category} + ${label} must not verify a behavioural criterion`);
      assert.notEqual(exitCode, 0, `${category} + ${label} must not exit 0`);
      assert.equal(report.status, 'incomplete');
      assert.ok(codes(report).includes('EVIDENCE_CATEGORY_BELOW_FLOOR'),
        `${category} + ${label} names the floor it violated`);
      // The declared category is still published verbatim beside the enforced
      // one: the fix hides nothing the author wrote.
      const row = report.requirements.find((entry) => entry.requirementId === id);
      assert.equal(row.category, category);
      assert.equal(row.enforcedCategory, 'behavioural');
    }
  }
});

test('the same criterion verifies only through an authority that ran', async (t) => {
  const plan = behaviouralCheckPlan();
  const ids = requirementIds(plan);
  const id = ids['the application does the thing when a person asks it to'];
  const evidence = exploitEvidence(plan, 'behavioural', [
    { kind: 'scenario.observation', scenario: 'demo', observation: 'run.02', expects: 'journey.fact fact=thingHappened is=true' },
  ]);
  const { exitCode, report } = await run(demo(t, { plan, evidence }), { verify: verifyStub(CONFORMING_CHECKS) });
  assert.equal(statusOf(report, id), 'verified');
  assert.equal(report.requirements.find((row) => row.requirementId === id).enforcedCategory, 'behavioural');
  assert.deepEqual(codes(report).filter((code) => code === 'EVIDENCE_CATEGORY_BELOW_FLOOR'), []);
  assert.equal(exitCode, 0);
});

test('declaring manual only ever lowers the result, and never raises it', async (t) => {
  const plan = behaviouralCheckPlan();
  const ids = requirementIds(plan);
  const id = ids['the application does the thing when a person asks it to'];
  // Real, resolving, runtime machine evidence — and a manual label on top.
  const evidence = exploitEvidence(plan, 'manual', [
    { kind: 'manual', describes: 'a person watched it happen' },
    { kind: 'scenario.observation', scenario: 'demo', observation: 'run.02', expects: 'journey.fact fact=thingHappened is=true' },
  ]);
  const { exitCode, report } = await run(demo(t, { plan, evidence }), { verify: verifyStub(CONFORMING_CHECKS) });
  assert.equal(statusOf(report, id), 'unverified', 'manual is a downgrade, so it wins over the machine evidence');
  assert.equal(exitCode, 1);
});

test('a step keeps the floor its own decision type puts under it', async (t) => {
  // `evolve` floors at structural, so a structural label is honoured — the plan
  // said so, not the author. `configure` floors at behavioural, so it is not.
  const plan = planDocument();
  const ids = requirementIds(plan);
  const evidence = evidenceDocument(plan);
  evidence.requirements[0].category = 'structural';
  evidence.requirements[0].evidence = [{ kind: 'application.fact', fact: 'action.present', name: 'widget.do' }];
  const { report } = await run(demo(t, { plan, evidence }), { verify: verifyStub(CONFORMING_CHECKS) });
  assert.equal(statusOf(report, ids['the application does the thing']), 'unevidenced', 'configure floors at behavioural');
  assert.equal(statusOf(report, ids['the record gains a field']), 'verified', 'evolve floors at structural');
});

test('a step the plan gives no decision type falls to the untyped floor, not to its label', async (t) => {
  // The plan is authoritative only where it actually says something. A step
  // with no resolvable decision type says nothing about its own nature, so it
  // is treated exactly like an acceptance check rather than trusted.
  const plan = planDocument({
    decisions: [{ id: 'd.configure', type: 'configure', target: 'app.thing', rationale: 'it exists already' }],
    steps: [{ id: 'step.behave', decisionId: 'd.configure', description: 'the application does the thing', requiresCapabilities: [], approvals: [], verifies: [] }],
    acceptance: { checks: ['the journey completes'], jtbdRows: [], artifacts: [] },
  });
  const { requirements } = planRequirements(validateSolutionPlan(plan).plan);
  const step = requirements.find((row) => row.kind === 'step');
  assert.equal(effectiveRequirementCategory({ declared: 'structural', kind: 'step', decisionType: step.decisionType }).enforced,
    'behavioural');
  assert.equal(effectiveRequirementCategory({ declared: 'structural', kind: 'step', decisionType: null }).enforced,
    'behavioural', 'no decision type is not a licence to grade structural');
  assert.equal(effectiveRequirementCategory({ declared: 'structural', kind: 'step', decisionType: 'not-a-real-type' }).enforced,
    'behavioural', 'an unrecognised decision type is untyped, not permissive');
  assert.equal(effectiveRequirementCategory({ declared: null, kind: 'acceptance-check', decisionType: null }).enforced,
    'behavioural', 'no declared category at all is still the floor');
});

// ---------------------------------------------------------------------------
// B11 — the report distinguishes a blocked requirement, a broken authority and
// an unreadable document. Collapsing the second into the first answers "why is
// this not proven?" with a business reason when the true answer is that the
// machine did not run.
// ---------------------------------------------------------------------------

test('an authority that did not run is never reported as an author-declared block', async (t) => {
  const plan = planDocument();
  const ids = requirementIds(plan);
  const evidence = evidenceDocument(plan);
  const row = evidence.requirements.find((entry) => entry.requirementId === ids['the journey completes']);
  row.blocked = { reason: 'the business decided not to ship this' };

  const { exitCode, report } = await run(demo(t, { plan, evidence }), {
    verify: verifyStub(CONFORMING_CHECKS),
    scenario: scenarioStub(OBSERVATIONS, { missing: ['demo'] }),
  });
  const graded = report.requirements.find((entry) => entry.requirementId === ids['the journey completes']);
  assert.equal(graded.status, 'unverifiable', 'a broken authority is not a blocked requirement');
  assert.match(graded.reason, /did not run/);
  // The author's claim survives as context, and is not the verdict.
  assert.deepEqual(graded.declaredDowngrade, { kind: 'blocked', reason: 'the business decided not to ship this' });
  assert.ok(codes(report).includes('VERIFICATION_AUTHORITY_FAILED'));
  assert.equal(report.counts.blocked, 0, 'nothing is counted as a business block');
  assert.ok(report.counts.unverifiable >= 1);
  assert.equal(exitCode, 1);
});

test('a business block is still a business block when every authority ran', async (t) => {
  const plan = planDocument();
  const ids = requirementIds(plan);
  const evidence = evidenceDocument(plan);
  const row = evidence.requirements.find((entry) => entry.requirementId === ids['the journey completes']);
  row.blocked = { reason: 'the customer withdrew the requirement' };
  const { report } = await run(demo(t, { plan, evidence }), { verify: verifyStub(CONFORMING_CHECKS) });
  const graded = report.requirements.find((entry) => entry.requirementId === ids['the journey completes']);
  assert.equal(graded.status, 'blocked');
  assert.equal(graded.reason, 'the customer withdrew the requirement');
  assert.equal(report.counts.unverifiable, 0);
});

test('an unreadable or invalid document never reaches a requirement status at all', async (t) => {
  // The third thing: not a blocked requirement, not a broken authority, but a
  // document that cannot be read. Exit 2, and no report to misread.
  const plan = planDocument();
  const root = demo(t, { plan, evidence: { implementationEvidenceContract: 1, nonsense: true } });
  const { exitCode, report } = await run(root, { verify: verifyStub(CONFORMING_CHECKS) });
  assert.equal(exitCode, 2);
  assert.equal(report, null, 'an invalid document produces no requirement rows to read a status off');
});

test('every declared status is one of the closed set, and unverifiable is in it', () => {
  assert.ok(REQUIREMENT_STATUSES.includes('unverifiable'));
  assert.equal(new Set(REQUIREMENT_STATUSES).size, REQUIREMENT_STATUSES.length);
  assert.equal(REQUIREMENT_STATUSES.includes('warning'), false);
});

// ---------------------------------------------------------------------------
// B12 — composition isolation. One invocation may run several authorities, and
// they do not all describe the same application. A fact observed in one is not
// evidence about another, however well the run went.
// ---------------------------------------------------------------------------

/** A scenario delegate where each id composes whatever application it is given. */
function multiCompositionScenario(byId) {
  return async (options) => ({
    exitCode: 0,
    report: {
      scenarioRunContract: 2, scenario: { id: options.scenarioRef }, status: 'passed',
      fingerprint: 's'.repeat(64),
      composition: {
        inspected: true, valid: true,
        compositionFingerprint: byId[options.scenarioRef] ?? COMPOSITION_FP,
        packages: [], problems: [],
      },
      observations: OBSERVATIONS, problems: [], limitations: [],
    },
  });
}

test('an observation from a scenario that composed another application proves nothing', async (t) => {
  const plan = planDocument();
  const ids = requirementIds(plan);
  const evidence = evidenceDocument(plan);
  // Every observation passes, the code exists, the `expects` string matches —
  // and it was observed in a different application.
  evidence.requirements[0].evidence = [
    { kind: 'scenario.observation', scenario: 'other', observation: 'run.02', expects: 'journey.fact fact=thingHappened is=true' },
  ];
  const { exitCode, report } = await run(demo(t, { plan, evidence }), {
    verify: verifyStub(CONFORMING_CHECKS),
    scenario: multiCompositionScenario({ other: 'f'.repeat(64) }),
  });
  assert.equal(report.binding.boundTo, 'project');
  assert.equal(statusOf(report, ids['the application does the thing']), 'unevidenced');
  assert.ok(codes(report).includes('EVIDENCE_COMPOSITION_MISMATCH'));
  assert.notEqual(exitCode, 0);
});

test('one requirement may not mix an application fact from A with an observation from B', async (t) => {
  const plan = planDocument();
  const ids = requirementIds(plan);
  const evidence = evidenceDocument(plan);
  evidence.requirements[1].evidence = [
    { kind: 'application.fact', fact: 'module.present', name: 'widget' },
    { kind: 'scenario.observation', scenario: 'other', observation: 'shape.01', expects: 'action.present action=widget.do' },
  ];
  const { report } = await run(demo(t, { plan, evidence }), {
    verify: verifyStub(CONFORMING_CHECKS),
    scenario: multiCompositionScenario({ other: 'f'.repeat(64) }),
  });
  assert.equal(statusOf(report, ids['the record gains a field']), 'unevidenced',
    'a resolving AX1 fact does not carry a reference from another application over the line');
  assert.ok(codes(report).includes('EVIDENCE_COMPOSITION_MISMATCH'));
});

test('the same observation code in two compositions is two different facts', async (t) => {
  // `run.02` exists in both, publishes the same `expected` string and passes in
  // both. Only the one whose composition matches the binding is evidence.
  const plan = planDocument();
  const ids = requirementIds(plan);
  const evidence = evidenceDocument(plan);
  evidence.requirements[0].evidence = [
    { kind: 'scenario.observation', scenario: 'demo', observation: 'run.02', expects: 'journey.fact fact=thingHappened is=true' },
  ];
  const matching = await run(demo(t, { plan, evidence }), {
    verify: verifyStub(CONFORMING_CHECKS),
    scenario: multiCompositionScenario({ demo: COMPOSITION_FP, other: 'f'.repeat(64) }),
  });
  assert.equal(statusOf(matching.report, ids['the application does the thing']), 'verified');

  const mixed = evidenceDocument(plan);
  mixed.requirements[0].evidence = [
    { kind: 'scenario.observation', scenario: 'other', observation: 'run.02', expects: 'journey.fact fact=thingHappened is=true' },
  ];
  const crossed = await run(demo(t, { plan, evidence: mixed }), {
    verify: verifyStub(CONFORMING_CHECKS),
    scenario: multiCompositionScenario({ demo: COMPOSITION_FP, other: 'f'.repeat(64) }),
  });
  assert.equal(statusOf(crossed.report, ids['the application does the thing']), 'unevidenced');
});
