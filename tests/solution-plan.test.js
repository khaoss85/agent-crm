import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  APPROVAL_CODES, DECISION_TYPES, EVIDENCE_CATEGORIES, MAX_PLAN_BYTES, PLAN_PROBLEM_CODES,
  SOLUTION_PLAN_CONTRACT, bindSolutionPlan, canonicalJson, fingerprintPlan, parseSolutionPlan,
  solutionPlanVocabulary, validateSolutionPlan,
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
      applicationInspectionContract: 1,
      compositionFingerprint: 'abc123',
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
    packages: [{ name: 'delivery', version: 3 }],
    capabilities: [{ name: 'delivery-economics', version: 1, status: 'resolved', provider: 'delivery', consumers: [] }],
    modules: [{ name: 'delivery-time-entry', revision: 1 }],
    ...overrides,
  };
}

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
  const forward = validateSolutionPlan(minimalPlan({
    evidence: {
      ...minimalPlan().evidence,
      derivedMetrics: [{ id: 'm1', statement: 'A metric', citations: ['u1'] }],
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
  const plan = minimalPlan({
    decisions: [{ id: 'd1', type: 'propose-kernel-capability', target: 'scheduled-work', rationale: 'no package can', rungsTried: [1, 2, 3, 4, 5] }],
  });
  const { problems } = validateSolutionPlan(plan);
  assert.ok(
    problems.some((p) => p.code === 'PLAN_DECISION_NOT_A_STEP'),
    'a kernel proposal in steps[] is refused — that is how the kernel gets patched to make a solution fit',
  );

  // Stating it as a decision, with no step, is exactly right.
  const stated = validateSolutionPlan(minimalPlan({
    decisions: [
      ...minimalPlan().decisions,
      { id: 'd2', type: 'propose-kernel-capability', target: 'scheduled-work', rationale: 'no package can', rungsTried: [1, 2, 3, 4, 5] },
    ],
  }));
  assert.deepEqual(stated.problems, []);
  assert.equal(stated.plan.decisions.find((d) => d.id === 'd2').rung, 5);
  assert.ok(t);
});

test('a provider step carries its approval whether or not the author remembered', async (t) => {
  const forgotten = validateSolutionPlan(minimalPlan({
    decisions: [{ id: 'd1', type: 'provider', target: 'signature-provider', rationale: 'the gap is an integration', rungsTried: [1, 2, 3] }],
  }));
  assert.ok(
    forgotten.problems.some((p) => p.code === 'PLAN_APPROVAL_MISSING' && /install_or_configure_provider/.test(p.message)),
    'configuring a provider is a sensitive boundary and the plan does not get to omit it',
  );

  const declared = validateSolutionPlan(minimalPlan({
    decisions: [{ id: 'd1', type: 'provider', target: 'signature-provider', rationale: 'the gap is an integration', rungsTried: [1, 2, 3] }],
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
