import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  APPLICATION_FACTS, CATEGORY_FLOOR, COMPOSITION_OBSERVATION_KINDS, EVIDENCE_KINDS,
  EVIDENCE_LIMITATIONS, EVIDENCE_PROBLEM_CODES, IMPLEMENTATION_EVIDENCE_CONTRACT,
  MAX_EVIDENCE_BYTES, MAX_REFS_PER_REQUIREMENT, MAX_REQUIREMENTS, MAX_TEXT, REQUIREMENT_CATEGORIES,
  RUNTIME_OBSERVATION_KINDS, SUFFICIENCY, fingerprintEvidence, implementationEvidenceVocabulary,
  parseImplementationEvidence, validateImplementationEvidence,
} from '../packages/core/src/implementation-evidence.js';
import {
  EXECUTABLE_SHAPES, REQUIREMENT_DIGEST_LENGTH, REQUIREMENT_KINDS, planRequirements,
  validateSolutionPlan,
} from '../packages/core/src/solution-plan.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * DX10's checked-in half. The whole point of this contract is what it *cannot*
 * express, so most of this file is about refusals: a status an author could
 * assert, a command an author could hide, a downgrade with no reason, a
 * requirement id that resolves to nothing.
 */

/** A minimal document that validates. */
function document(overrides = {}) {
  return {
    implementationEvidenceContract: 1,
    plan: 'examples/solution-plans/lead-to-won.plan.json',
    planFingerprint: 'a'.repeat(64),
    applicationInspectionFingerprint: 'b'.repeat(64),
    requirements: [
      {
        requirementId: 'step:step.one',
        category: 'structural',
        evidence: [{ kind: 'application.fact', fact: 'module.present', name: 'opportunity' }],
      },
    ],
    limitations: [],
    ...overrides,
  };
}

const codesOf = (problems) => [...new Set(problems.map((problem) => problem.code))].sort();

test('a minimal document validates, and its fingerprint covers everything it says', () => {
  const { valid, evidence, problems } = validateImplementationEvidence(document());
  assert.equal(valid, true, JSON.stringify(problems));
  assert.equal(evidence.implementationEvidenceContract, IMPLEMENTATION_EVIDENCE_CONTRACT);
  assert.match(evidence.fingerprint, /^[0-9a-f]{64}$/);

  // Key order and whitespace change nothing; a changed statement changes it.
  const shuffled = document();
  const reordered = validateImplementationEvidence({
    limitations: shuffled.limitations,
    requirements: shuffled.requirements.map((row) => ({
      evidence: row.evidence, category: row.category, requirementId: row.requirementId,
    })),
    applicationInspectionFingerprint: shuffled.applicationInspectionFingerprint,
    planFingerprint: shuffled.planFingerprint,
    plan: shuffled.plan,
    implementationEvidenceContract: shuffled.implementationEvidenceContract,
  });
  assert.equal(reordered.evidence.fingerprint, evidence.fingerprint);

  const moved = validateImplementationEvidence(document({
    requirements: [{ requirementId: 'step:step.one', category: 'behavioural', evidence: [] }],
  }));
  assert.notEqual(moved.evidence.fingerprint, evidence.fingerprint);
  assert.equal(fingerprintEvidence(evidence), evidence.fingerprint);
});

test('there is no way to declare a status — the only shape an author can add is a downgrade', () => {
  // The single most important property of this contract. An agent writing this
  // document about its own work must not be able to write the conclusion.
  const serialized = JSON.stringify(implementationEvidenceVocabulary());
  assert.equal(serialized.includes('"status"'), false);
  for (const attempt of ['status', 'implemented', 'verified', 'result', 'outcome', 'passed']) {
    const { problems } = validateImplementationEvidence(document({
      requirements: [{ requirementId: 'step:step.one', category: 'structural', evidence: [], [attempt]: 'implemented' }],
    }));
    assert.ok(problems.some((problem) => problem.code === 'EVIDENCE_FIELD_UNKNOWN'),
      `"${attempt}" must be refused, not ignored`);
  }
  // What an author *may* say is that something is less proven than it looks.
  const downgraded = validateImplementationEvidence(document({
    requirements: [{
      requirementId: 'step:step.one', category: 'structural', evidence: [],
      partial: { reason: 'only half of this is observed' },
    }],
  }));
  assert.equal(downgraded.valid, true);
  assert.equal(downgraded.evidence.requirements[0].partial.reason, 'only half of this is observed');
});

test('a downgrade with no reason is refused rather than accepted quietly', () => {
  for (const [key, code] of [['blocked', 'EVIDENCE_BLOCKED_REASON_MISSING'], ['partial', 'EVIDENCE_PARTIAL_REASON_MISSING']]) {
    const { problems } = validateImplementationEvidence(document({
      requirements: [{ requirementId: 'step:step.one', category: 'structural', evidence: [], [key]: {} }],
    }));
    assert.ok(codesOf(problems).includes(code), `${key} with no reason must be ${code}`);
  }
  const both = validateImplementationEvidence(document({
    requirements: [{
      requirementId: 'step:step.one', category: 'structural', evidence: [],
      blocked: { reason: 'a' }, partial: { reason: 'b' },
    }],
  }));
  assert.ok(codesOf(both.problems).includes('EVIDENCE_DOWNGRADE_CONFLICT'));
});

test('unknown keys are refused at every level, never dropped', () => {
  const cases = [
    [document({ command: 'npm test' }), 'evidence.command'],
    [document({ requirements: [{ requirementId: 'step:a', category: 'structural', evidence: [], script: 'x' }] }), 'requirements[0].script'],
    [document({
      requirements: [{
        requirementId: 'step:a', category: 'structural',
        evidence: [{ kind: 'source.artifact', path: 'a.js', sha256: 'c'.repeat(64), run: 'node a.js' }],
      }],
    }), 'evidence[0].run'],
    [document({ limitations: [{ code: 'A_CODE', message: 'x', severity: 'high' }] }), 'limitations[0].severity'],
  ];
  for (const [input, where] of cases) {
    const { problems } = validateImplementationEvidence(input);
    assert.ok(problems.some((problem) => problem.code === 'EVIDENCE_FIELD_UNKNOWN'),
      `${where} must be EVIDENCE_FIELD_UNKNOWN`);
  }
});

test('executable content is refused in every pointer, by the same shapes the plan and the scenario use', () => {
  const payloads = [
    'run npm test -- --watch',
    'the value is $(whoami)',
    'first && rm -rf /tmp/x',
    'see https://example.com/evidence',
    '<script>alert(1)</script>',
  ];
  for (const payload of payloads) {
    // `expects` is a pointer: it is the verbatim string an authority published,
    // compared for equality. An executable shape there is never legitimate.
    const { problems } = validateImplementationEvidence(document({
      requirements: [{
        requirementId: 'step:step.one', category: 'behavioural',
        evidence: [{ kind: 'scenario.observation', scenario: 'demo', observation: 'run.01', expects: payload }],
      }],
    }));
    assert.ok(codesOf(problems).includes('EVIDENCE_EXECUTABLE_CONTENT'), `refused: ${payload}`);
  }
});

test('the executable-text scan is defence in depth, and says so rather than claiming to be a parser', () => {
  // Both directions, measured. The scan is a regex over English: it misses
  // plenty and refuses plenty of ordinary prose. What makes this document safe
  // to read is its *shape* — no command, script, effect or env field exists in
  // it, and nothing in this repository executes a string that came out of one.
  const missed = [
    'perl -e "system(1)"', 'ruby -e puts', 'make install', 'docker run -it alpine',
    'powershell -Command Get-Process', 'cmd.exe /c dir', 'kubectl delete pod',
    'source ~/.bashrc', '. ./setup.sh', '\u202Eexec /bin/sh\u202C',
  ];
  const caught = missed.filter((payload) => EXECUTABLE_SHAPES.some((shape) => shape.re.test(payload)));
  assert.deepEqual(caught, [], 'the scan misses these, which is why it is not the boundary');
  assert.ok(EVIDENCE_LIMITATIONS.some((row) => row.code === 'EXECUTABLE_TEXT_SCAN_IS_NOT_A_PARSER'),
    'the limit is published rather than implied');

  // And the shape is: none of these fields exists at any level of the contract.
  for (const field of ['command', 'script', 'effect', 'env', 'run', 'exec', 'shell']) {
    const { problems } = validateImplementationEvidence(document({ [field]: 'anything at all' }));
    assert.ok(codesOf(problems).includes('EVIDENCE_FIELD_UNKNOWN'), `${field} is not part of this contract`);
  }
});

test('an author\'s prose may name a command, a URL or a backtick and stay usable', () => {
  // The refusal used to apply to every string, which made the most natural
  // explanations in this repository unwritable and pushed an author towards a
  // vaguer reason. A vaguer reason for a blocked requirement is the worse
  // outcome: a shell-shaped reason is inert, and an empty one hides a gap.
  const prose = [
    '`npm run verify` does not cover this, so nothing here proves it',
    'a person opens https://example.test/board and reads the column',
    'the price must render as `${amount}` text, never as markup',
    '`rm -rf` is never run by this framework, which is why there is nothing to observe',
    'the check is passed && the doctor is green, and neither says anything about this',
  ];
  for (const reason of prose) {
    const blocked = validateImplementationEvidence(document({
      requirements: [{ requirementId: 'step:a', category: 'behavioural', evidence: [], blocked: { reason } }],
    }));
    assert.equal(blocked.valid, true, `a blocked reason may say: ${reason} -- ${JSON.stringify(blocked.problems)}`);

    const manual = validateImplementationEvidence(document({
      requirements: [{ requirementId: 'step:a', category: 'manual', evidence: [{ kind: 'manual', describes: reason }] }],
    }));
    assert.equal(manual.valid, true, `a manual description may say: ${reason}`);
  }
  // Control characters and the bounds still apply to prose.
  assert.equal(validateImplementationEvidence(document({
    requirements: [{ requirementId: 'step:a', category: 'behavioural', evidence: [], blocked: { reason: 'a\u0000b' } }],
  })).valid, false, 'a control character is still refused');
  assert.equal(validateImplementationEvidence(document({
    requirements: [{ requirementId: 'step:a', category: 'behavioural', evidence: [], blocked: { reason: 'x'.repeat(MAX_TEXT + 1) } }],
  })).valid, false, 'the bound is still a refusal');
});

test('a path is repository-relative and stays inside the project', () => {
  const refused = ['/etc/passwd', '../secrets.js', 'a\\b.js', 'file:///etc/passwd', 'https://example.com/x.js'];
  for (const path of refused) {
    const { problems } = validateImplementationEvidence(document({
      requirements: [{
        requirementId: 'step:a', category: 'structural',
        evidence: [{ kind: 'source.artifact', path, sha256: 'c'.repeat(64) }],
      }],
    }));
    assert.ok(codesOf(problems).some((code) => code === 'EVIDENCE_PATH_REFUSED' || code === 'EVIDENCE_EXECUTABLE_CONTENT'),
      `refused: ${path}`);
  }
});

test('a fingerprint field takes a digest, never a label', () => {
  for (const value of ['not-a-real-fingerprint', 'A'.repeat(64), 'abc']) {
    const { problems } = validateImplementationEvidence(document({ planFingerprint: value }));
    assert.ok(codesOf(problems).includes('EVIDENCE_FIELD_INVALID'), `refused: ${value}`);
  }
});

test('a requirement id must be a shape the plan can derive', () => {
  // 'check:0123456789ab' is the *old* 12-hex width: 48 bits is brute-forceable
  // to a chosen collision, so it is refused now rather than accepted (ADR-031).
  for (const id of ['step.one', 'check:zzz', 'artifact:packages/x.js', 'JTBD-04', 'check:abc',
    'check:0123456789ab']) {
    const { problems } = validateImplementationEvidence(document({
      requirements: [{ requirementId: id, category: 'structural', evidence: [] }],
    }));
    assert.ok(codesOf(problems).includes('EVIDENCE_FIELD_INVALID'), `refused: ${id}`);
  }
  const ok = validateImplementationEvidence(document({
    requirements: [{ requirementId: 'check:0123456789ab0123456789ab0123456789', category: 'structural', evidence: [] }],
  }));
  assert.equal(ok.valid, false, 'a 34-hex id is not the derived width either');
  const right = validateImplementationEvidence(document({
    requirements: [{ requirementId: `check:${'0'.repeat(REQUIREMENT_DIGEST_LENGTH)}`, category: 'structural', evidence: [] }],
  }));
  assert.equal(right.valid, true, JSON.stringify(right.problems));
  assert.equal(REQUIREMENT_DIGEST_LENGTH, 32, 'the derived width is 128 bits');
});

test('a requirement appears once, and an identical reference is not two facts', () => {
  const twice = validateImplementationEvidence(document({
    requirements: [
      { requirementId: 'step:a', category: 'structural', evidence: [] },
      { requirementId: 'step:a', category: 'behavioural', evidence: [] },
    ],
  }));
  assert.ok(codesOf(twice.problems).includes('EVIDENCE_DUPLICATE_REQUIREMENT'));

  const repeated = validateImplementationEvidence(document({
    requirements: [{
      requirementId: 'step:a', category: 'structural',
      evidence: [
        { kind: 'application.fact', fact: 'module.present', name: 'lead' },
        { kind: 'application.fact', fact: 'module.present', name: 'lead' },
      ],
    }],
  }));
  assert.ok(codesOf(repeated.problems).includes('EVIDENCE_DUPLICATE_REFERENCE'));
});

test('every vocabulary is closed in both directions', () => {
  const unknown = validateImplementationEvidence(document({
    requirements: [{
      requirementId: 'step:a', category: 'philosophical',
      evidence: [{ kind: 'vibes', note: 'it feels done' }],
    }],
  }));
  assert.ok(codesOf(unknown.problems).includes('EVIDENCE_VOCABULARY_UNKNOWN'));

  const badFact = validateImplementationEvidence(document({
    requirements: [{
      requirementId: 'step:a', category: 'structural',
      evidence: [{ kind: 'application.fact', fact: 'database.reachable', name: 'x' }],
    }],
  }));
  assert.ok(codesOf(badFact.problems).includes('EVIDENCE_VOCABULARY_UNKNOWN'));

  const badExpect = validateImplementationEvidence(document({
    requirements: [{
      requirementId: 'step:a', category: 'project-health',
      evidence: [{ kind: 'project.verification', check: 'suite.verify', expect: 'green' }],
    }],
  }));
  assert.ok(codesOf(badExpect.problems).includes('EVIDENCE_VOCABULARY_UNKNOWN'));

  const vocabulary = implementationEvidenceVocabulary();
  assert.deepEqual(vocabulary.evidenceKinds, [...EVIDENCE_KINDS]);
  assert.deepEqual(vocabulary.applicationFacts, [...APPLICATION_FACTS]);
  assert.deepEqual(vocabulary.requirementCategories, [...REQUIREMENT_CATEGORIES]);
  assert.deepEqual(vocabulary.problemCodes, [...EVIDENCE_PROBLEM_CODES]);
  assert.equal(JSON.stringify(vocabulary).includes('function'), false, 'function-free, like every published contract here');
});

test('there is no test-name evidence kind, and no way to cite one', () => {
  // A test *name* is exactly the arbitrary string this contract refuses: no
  // authority in this repository publishes which tests ran, so citing one would
  // be a claim dressed as a citation.
  assert.equal(EVIDENCE_KINDS.includes('test'), false);
  assert.equal(EVIDENCE_KINDS.includes('test.name'), false);
  const { problems } = validateImplementationEvidence(document({
    requirements: [{
      requirementId: 'step:a', category: 'behavioural',
      evidence: [{ kind: 'test', name: 'tests/service-operations-evidence.test.js' }],
    }],
  }));
  assert.ok(codesOf(problems).includes('EVIDENCE_VOCABULARY_UNKNOWN'));
});

test('there is no evidence-to-evidence citation, so there is no graph to keep acyclic', () => {
  // AX2 needed a citation DAG because its entries derive from each other. An
  // evidence reference names an authority and a fact and nothing else, so a
  // conclusion is not expressible as a premise at all.
  assert.ok(implementationEvidenceVocabulary().notModeled
    .some((row) => row.includes('evidence-to-evidence citation')));
  const { problems } = validateImplementationEvidence(document({
    requirements: [{
      requirementId: 'step:a', category: 'structural',
      evidence: [{ kind: 'application.fact', fact: 'module.present', name: 'lead', cites: ['step:b'] }],
    }],
  }));
  assert.ok(codesOf(problems).includes('EVIDENCE_FIELD_UNKNOWN'));
});

test('bounds are refusals, never truncations', () => {
  const many = validateImplementationEvidence(document({
    requirements: Array.from({ length: MAX_REQUIREMENTS + 1 }, (_, index) => ({
      requirementId: `check:${String(index).padStart(12, '0')}`, category: 'structural', evidence: [],
    })),
  }));
  assert.ok(codesOf(many.problems).includes('EVIDENCE_FIELD_INVALID'));
  assert.equal(many.evidence.requirements.length, 0, 'refused, not cut to the bound');

  const manyRefs = validateImplementationEvidence(document({
    requirements: [{
      requirementId: 'step:a', category: 'structural',
      evidence: Array.from({ length: MAX_REFS_PER_REQUIREMENT + 1 }, (_, index) => ({
        kind: 'application.fact', fact: 'module.present', name: `m${index}`,
      })),
    }],
  }));
  assert.ok(codesOf(manyRefs.problems).includes('EVIDENCE_FIELD_INVALID'));

  assert.throws(() => parseImplementationEvidence('x'.repeat(MAX_EVIDENCE_BYTES + 1)), /at most/);
  assert.throws(() => parseImplementationEvidence('{not json'), /valid JSON/);
});

test('a prototype-polluting key is refused before its value is read', () => {
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const raw = JSON.parse(`{"implementationEvidenceContract":1,"plan":"a.json","planFingerprint":"${'a'.repeat(64)}","applicationInspectionFingerprint":"${'b'.repeat(64)}","requirements":[],"limitations":[],"${key}":{}}`);
    const { valid } = validateImplementationEvidence(raw);
    assert.equal(valid, false, `${key} must be refused`);
  }
});

test('an unsupported contract version is refused rather than guessed at', () => {
  const { valid, evidence, problems } = validateImplementationEvidence(document({ implementationEvidenceContract: 2 }));
  assert.equal(valid, false);
  assert.equal(evidence, null);
  assert.deepEqual(codesOf(problems), ['EVIDENCE_CONTRACT_UNSUPPORTED']);
});

test('the sufficiency matrix never lets a source artifact stand alone', () => {
  for (const [category, rule] of Object.entries(SUFFICIENCY)) {
    assert.equal(rule.satisfiedBy.includes('source.artifact'), false,
      `${category}: a file having these bytes is never, on its own, proof of anything`);
  }
  // Behavioural is the sharp one: only a *runtime* observation satisfies it.
  assert.deepEqual(SUFFICIENCY.behavioural.satisfiedBy, ['scenario.observation:runtime']);
  assert.equal(SUFFICIENCY.behavioural.satisfiedBy.includes('scenario.observation:composition'), false,
    '"the action is declared" is not "the application does this"');
  // Structural does *not* require a scenario.
  assert.ok(SUFFICIENCY.structural.satisfiedBy.includes('application.fact'));
  // Manual is satisfied by nothing at all.
  assert.deepEqual(SUFFICIENCY.manual.satisfiedBy, []);
  // The two observation-kind sets are disjoint, so one observation is one thing.
  for (const kind of RUNTIME_OBSERVATION_KINDS) {
    assert.equal(COMPOSITION_OBSERVATION_KINDS.includes(kind), false, `${kind} is in both sets`);
  }
});

test('a step decision type floors its category; an acceptance check has no floor', () => {
  // A step that configures, extends, adds a provider or creates a package
  // changes what the application does. A step that evolves a record is
  // structural, and requiring a run to prove a schema would be the mirror error.
  assert.equal(CATEGORY_FLOOR.configure, 'behavioural');
  assert.equal(CATEGORY_FLOOR.extend, 'behavioural');
  assert.equal(CATEGORY_FLOOR.provider, 'behavioural');
  assert.equal(CATEGORY_FLOOR['create-package'], 'behavioural');
  assert.equal(CATEGORY_FLOOR.evolve, 'structural');
  assert.equal(Object.prototype.hasOwnProperty.call(CATEGORY_FLOOR, 'acceptance-check'), false);
});

test('every limitation is published with a code a caller can switch on', () => {
  const codes = EVIDENCE_LIMITATIONS.map((row) => row.code);
  assert.equal(new Set(codes).size, codes.length, 'one code, one message');
  for (const required of ['MANUAL_EVIDENCE_IS_NOT_PROOF', 'SOURCE_IS_STRUCTURAL_ONLY',
    'BROWSER_EVIDENCE_NOT_AUTOMATED', 'PRODUCTION_EVIDENCE_ABSENT', 'VERIFICATION_SOURCE_TRUSTED',
    'EVIDENCE_IS_NOT_A_PLAN_RUNTIME', 'REQUIREMENT_CATEGORY_CANNOT_WEAKEN_PROOF',
    'ACCEPTANCE_CHECKS_ARE_UNTYPED', 'COVERAGE_IS_THE_PLAN_ONLY']) {
    assert.ok(codes.includes(required), `${required} is published on every report`);
  }
  // The old wording *described* the category exploit as a bound rather than
  // closing it. It must not come back: a limitation paragraph is not a fix.
  assert.equal(codes.includes('REQUIREMENT_CATEGORY_IS_DECLARED'), false,
    'the declared-category limitation is replaced by an enforced floor, not restated');
});

// ---------------------------------------------------------------------------
// derived requirement identity, in core
// ---------------------------------------------------------------------------

/** @param {string} name */
function plan(name) {
  const raw = JSON.parse(readFileSync(join(repoRoot, 'examples/solution-plans', `${name}.plan.json`), 'utf8'));
  const result = validateSolutionPlan(raw);
  assert.equal(result.valid, true, `${name} must be a valid plan: ${JSON.stringify(result.problems)}`);
  return result.plan;
}

test('a requirement is a step or an acceptance check, and nothing else in the plan is one', () => {
  const leadToWon = plan('lead-to-won');
  const { requirements, problems } = planRequirements(leadToWon);
  assert.deepEqual(problems, []);
  assert.deepEqual(requirements.map((row) => row.requirementId), [
    'step:step.publish-dwell-view',
    'step:step.add-stall-reason',
    'check:af9d6ee5ccc4314af1f61399e21ccbc0',
    'check:94439cfe3fe33f4135c30846fe2a3509',
    'check:c56c0abf1035400e1568df1509006b1f',
    'check:f3c222d2bfe28d7e8f7a3f7cc99198ac',
  ]);
  assert.equal(requirements.length, leadToWon.steps.length + leadToWon.acceptance.checks.length);
  // An artifact is a *place*, not a requirement — treating a declared path as
  // one is "the file exists, therefore it is done" wearing a contract.
  assert.ok(leadToWon.acceptance.artifacts.length > 0);
  for (const artifact of leadToWon.acceptance.artifacts) {
    assert.equal(requirements.some((row) => row.statement.includes(artifact.path)), false);
  }
  // A JTBD row is DX6's unit and a person's decision.
  for (const row of leadToWon.acceptance.jtbdRows) {
    assert.equal(requirements.some((requirement) => requirement.requirementId.includes(row)), false);
  }
  assert.deepEqual([...new Set(requirements.map((row) => row.kind))].sort(), [...REQUIREMENT_KINDS].sort());
});

test('a step reuses the id its author wrote; an acceptance check is content-addressed', () => {
  const original = plan('lead-to-won');
  const before = planRequirements(original).requirements;

  // Reordering the acceptance checks must not move any id: an id is a position
  // in the file only if somebody made it one.
  const reordered = validateSolutionPlan({
    ...JSON.parse(readFileSync(join(repoRoot, 'examples/solution-plans/lead-to-won.plan.json'), 'utf8')),
    acceptance: {
      ...original.acceptance,
      checks: [...original.acceptance.checks].reverse(),
    },
  }).plan;
  const after = planRequirements(reordered).requirements;
  assert.deepEqual(
    after.filter((row) => row.kind === 'acceptance-check').map((row) => row.requirementId).sort(),
    before.filter((row) => row.kind === 'acceptance-check').map((row) => row.requirementId).sort(),
  );

  // Rewording one *does* move it, which is the behaviour we want: evidence for
  // the old wording must not silently carry to a criterion nobody re-examined.
  const reworded = validateSolutionPlan({
    ...JSON.parse(readFileSync(join(repoRoot, 'examples/solution-plans/lead-to-won.plan.json'), 'utf8')),
    acceptance: {
      ...original.acceptance,
      checks: [...original.acceptance.checks.slice(0, -1), 'something else entirely'],
    },
  }).plan;
  const changed = planRequirements(reworded).requirements.map((row) => row.requirementId);
  assert.equal(changed.includes('check:f3c222d2bfe28d7e8f7a3f7cc99198ac'), false);

  for (const row of before.filter((entry) => entry.kind === 'acceptance-check')) {
    assert.match(row.requirementId, new RegExp(`^check:[0-9a-f]{${REQUIREMENT_DIGEST_LENGTH}}$`));
  }
});

test('deriving requirement ids moves no plan fingerprint and needs no migration', () => {
  // The whole argument for deriving rather than declaring: every plan already
  // checked in is addressable, and none of their identities moved.
  const directory = join(repoRoot, 'examples/solution-plans');
  const files = readdirSync(directory).filter((name) => name.endsWith('.plan.json'));
  assert.ok(files.length >= 3);
  for (const file of files) {
    const raw = JSON.parse(readFileSync(join(directory, file), 'utf8'));
    const result = validateSolutionPlan(raw);
    assert.equal(result.valid, true, `${file}: ${JSON.stringify(result.problems)}`);
    if (typeof raw.fingerprint === 'string' && raw.fingerprint !== '') {
      assert.equal(result.plan.fingerprint, raw.fingerprint,
        `${file}: the checked-in fingerprint must still be the computed one`);
    }
    const { requirements, problems } = planRequirements(result.plan);
    assert.deepEqual(problems, [], file);
    assert.ok(requirements.length > 0, `${file} has requirements without any change to the plan`);
    // Nothing about a requirement appears inside the normalized plan.
    assert.equal(JSON.stringify(result.plan).includes('requirementId'), false, file);
  }
});

test('two identical acceptance checks collide, and the collision is refused', () => {
  const original = plan('lead-to-won');
  const duplicated = validateSolutionPlan({
    ...JSON.parse(readFileSync(join(repoRoot, 'examples/solution-plans/lead-to-won.plan.json'), 'utf8')),
    acceptance: {
      ...original.acceptance,
      checks: [original.acceptance.checks[0], original.acceptance.checks[0]],
    },
  }).plan;
  const { requirements, problems } = planRequirements(duplicated);
  assert.deepEqual(problems.map((problem) => problem.code), ['PLAN_REQUIREMENT_DUPLICATE']);
  assert.equal(requirements.filter((row) => row.kind === 'acceptance-check').length, 1,
    'one requirement must not stand for two');
});

test('both checked-in evidence documents are valid and address requirements their plans derive', () => {
  const pairs = [
    ['lead-to-won', 'lead-to-won'],
    ['activate-support-and-manage-cases', 'activate-support-and-manage-cases'],
  ];
  for (const [planName, evidenceName] of pairs) {
    const target = plan(planName);
    const derived = new Set(planRequirements(target).requirements.map((row) => row.requirementId));
    const raw = JSON.parse(readFileSync(
      join(repoRoot, 'examples/implementation-evidence', `${evidenceName}.evidence.json`), 'utf8',
    ));
    const { valid, evidence, problems } = validateImplementationEvidence(raw);
    assert.equal(valid, true, `${evidenceName}: ${JSON.stringify(problems)}`);
    assert.equal(evidence.planFingerprint, target.fingerprint, `${evidenceName} is pinned to its plan`);
    assert.equal(evidence.applicationInspectionFingerprint, target.application.inspectionFingerprint);
    for (const row of evidence.requirements) {
      assert.ok(derived.has(row.requirementId), `${evidenceName}: ${row.requirementId} is not a requirement of ${planName}`);
    }
    // Every requirement the plan has is addressed. A plan requirement nobody
    // wrote evidence for is still a requirement.
    assert.equal(evidence.requirements.length, derived.size, `${evidenceName} covers every requirement`);
  }
});

// ---------------------------------------------------------------------------
// Strict plain data. These documents are "function-free by contract", and that
// was a property of the reader rather than of the contract: read from a live
// object, a getter on a field the validator touched was author code the
// validator ran, and a Proxy could answer one value to validation and another
// to the fingerprint. `toPlainData` is the shared gate, stated once next to
// EXECUTABLE_SHAPES and canonicalJson.
// ---------------------------------------------------------------------------

class NotADocument { constructor() { this.requirementId = 'step:a'; } }

test('a getter is refused rather than invoked', () => {
  let ran = false;
  const hostile = document({
    requirements: [{
      requirementId: 'step:a', category: 'structural', evidence: [],
      get blocked() { ran = true; return { reason: 'a downgrade nobody wrote' }; },
    }],
  });
  const result = validateImplementationEvidence(hostile);
  assert.equal(ran, false, 'the validator must not execute anything an author wrote');
  assert.equal(result.valid, false);
  assert.ok(codesOf(result.problems).includes('EVIDENCE_FIELD_INVALID'));
  assert.match(result.problems[0].message, /accessor/);
});

test('a value that is not plain data is refused, one refusal per shape', () => {
  const shapes = {
    date: new Date(), map: new Map(), set: new Set(), regexp: /x/,
    classInstance: new NotADocument(), fn: () => 'x', symbol: Symbol('s'),
    bigint: 10n, infinity: Infinity, nan: NaN,
  };
  for (const [name, value] of Object.entries(shapes)) {
    const result = validateImplementationEvidence(document({ plan: value }));
    assert.equal(result.valid, false, `${name} is not a document`);
    assert.equal(result.evidence, null, `${name} produces no normalized document at all`);
  }
});

test('an object whose fields come from its prototype is not what it says it is', () => {
  const inherited = Object.create({ category: 'structural' });
  inherited.requirementId = 'step:a';
  inherited.evidence = [];
  const result = validateImplementationEvidence(document({ requirements: [inherited] }));
  assert.equal(result.valid, false, 'a field read off the prototype chain is not in the document');
});

test('a symbol key is refused rather than silently dropped', () => {
  const row = { requirementId: 'step:a', category: 'structural', evidence: [] };
  row[Symbol('hidden')] = 'something no reader will see';
  assert.equal(validateImplementationEvidence(document({ requirements: [row] })).valid, false);
});

test('a cycle is a refusal with a path, never a stack overflow', () => {
  const row = { requirementId: 'step:a', category: 'structural', evidence: [] };
  row.itself = row;
  const result = validateImplementationEvidence(document({ requirements: [row] }));
  assert.equal(result.valid, false);
  assert.match(result.problems[0].message, /cycle/);
});

test('every value is read exactly once, so a Proxy cannot answer two questions differently', () => {
  // The attack this closes: a Proxy that returns a weak category to the
  // validator and a different one to whatever reads the document next. It is
  // read once into a plain copy, so there is only ever one answer to disagree
  // with.
  // A `get` trap is never reached at all: the copy is taken from own property
  // descriptors, so the only thing a Proxy can present is the data its target
  // actually holds.
  let gets = 0;
  const lyingGet = new Proxy({ requirementId: 'step:a', category: 'behavioural', evidence: [] }, {
    get(target, key) {
      if (key === 'category') { gets += 1; return 'structural'; }
      return Reflect.get(target, key);
    },
  });
  const first = validateImplementationEvidence(document({ requirements: [lyingGet] }));
  assert.equal(first.valid, true, JSON.stringify(first.problems));
  assert.equal(first.evidence.requirements[0].category, 'behavioural', 'the target\'s own data, not the trap\'s answer');
  assert.equal(gets, 0, 'a get trap is never invoked');

  // A `getOwnPropertyDescriptor` trap that answers differently each time is
  // consulted exactly once, so the validated document and the fingerprinted
  // document are the same document.
  let descriptors = 0;
  const drifting = new Proxy({ requirementId: 'step:a', category: 'behavioural', evidence: [] }, {
    getOwnPropertyDescriptor(target, key) {
      if (key === 'category') {
        descriptors += 1;
        return { value: descriptors === 1 ? 'behavioural' : 'structural', enumerable: true, configurable: true, writable: true };
      }
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  const second = validateImplementationEvidence(document({ requirements: [drifting] }));
  assert.equal(second.valid, true, JSON.stringify(second.problems));
  assert.equal(descriptors, 1, 'category is read exactly once');
  assert.equal(second.evidence.requirements[0].category, 'behavioural', 'the first and only answer is the document');
  // And the fingerprint describes that same copy, not a second reading of it.
  assert.equal(second.evidence.fingerprint, fingerprintEvidence(second.evidence));
});

test('prototype pollution through a document is refused and pollutes nothing', () => {
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const raw = JSON.parse(`{"${key}": {"polluted": true}}`);
    const result = validateImplementationEvidence(document(raw));
    assert.equal(result.valid, false, `${key} is refused`);
  }
  const nested = JSON.parse('{"requirementId":"step:a","category":"structural","evidence":[],"__proto__":{"polluted":true}}');
  assert.equal(validateImplementationEvidence(document({ requirements: [nested] })).valid, false);
  assert.equal(({}).polluted, undefined, 'nothing was polluted');
  assert.equal(Object.prototype.polluted, undefined);
});
