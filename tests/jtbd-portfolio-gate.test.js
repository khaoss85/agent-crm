// @ts-check
/**
 * The JTBD Portfolio Alignment Gate, and every negative rule against the mutation that must
 * fail it.
 *
 * A gate nobody can watch fail is a gate nobody knows is on. Each `refuses …` case here takes
 * the real, passing world and moves exactly one thing.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  COVERAGE_STATUSES,
  CROSSWALK_DISPOSITIONS,
  EXECUTABLE_EVIDENCE_KINDS,
  JTBD_GATE_PROBLEMS,
  OWNERSHIP_RESOLUTIONS,
  OWNER_STATUSES,
  POSITIVE_STATUSES,
  PRIVATE_CATALOG_FIELDS,
  buildOverlays,
  checkWorld,
  loadWorld,
  readCatalogSpine,
} from '../scripts/jtbd-gate.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const clone = (value) => JSON.parse(JSON.stringify(value));
const codes = (problems) => new Set(problems.map((problem) => problem.code));

/** The real world, loaded once: every negative case is a copy of it with one thing moved. */
const world = await loadWorld(ROOT);

test('the checked-in portfolio passes its own gate', () => {
  const { problems, summary } = checkWorld(world);
  assert.deepEqual(problems, [], problems.map((p) => `${p.code}: ${p.message}`).join('\n'));
  assert.equal(summary.recordCount, 600);
  assert.equal(summary.uniqueIds, 600);
  assert.equal(summary.overlayComplete, true);
  assert.equal(summary.positiveCoverageWithoutEvidence, 0);
});

test('v1.1 enforces the L3 approval boundary and preserves unique resolvable ids', () => {
  const lines = readFileSync(join(ROOT, 'docs/jtbd/catalog/jtbd.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(new Set(lines.map((row) => row.jtbd_id)).size, lines.length);
  assert.equal(lines.filter((row) => row.agentic_design.target_autonomy === 'L3' && row.agentic_design.human_approval_required !== true).length, 0);
  const supersessions = JSON.parse(readFileSync(join(ROOT, 'docs/jtbd/catalog/supersessions.json'), 'utf8'));
  const active = new Set(lines.map((row) => row.jtbd_id));
  for (const item of supersessions.supersededIds) assert.ok(active.has(item.supersededBy));
});

test('approval ambiguity remains explicit and every contradiction stays reviewed', () => {
  const review = JSON.parse(readFileSync(join(ROOT, 'docs/jtbd/quality/approval-boundary-review-v1.1.json'), 'utf8'));
  assert.equal(review.reviews.length, 280);
  assert.equal(Object.values(review.summary).reduce((sum, count) => sum + count, 0), review.reviews.length);
  const validClasses = new Set([
    'A_KEEP_L3_REQUIRE_APPROVAL', 'B_MOVE_TO_L2_NO_APPROVAL', 'HUMAN_CONFIRMATION_REQUIRED',
  ]);
  assert.ok(review.reviews.every((row) => validClasses.has(row.semanticClass)));
  const ambiguous = review.reviews.filter((row) => row.semanticClass === 'HUMAN_CONFIRMATION_REQUIRED');
  assert.ok(ambiguous.length > 0, 'the human-confirmation queue cannot silently disappear');
  for (const row of ambiguous) {
    assert.equal(row.needsHumanConfirmation, true);
    assert.deepEqual(row.proposed, { targetAutonomy: 'L3', humanApprovalRequired: true });
  }
  assert.equal(ambiguous.find((row) => row.jtbdId === 'ACC-JTBD-AE-012')?.needsHumanConfirmation, true);
  for (const row of review.reviews.filter((item) => item.evidence.pattern === 'DECIDE')) {
    if (row.evidence.authoritativeEffectCandidates.length > 0) {
      assert.notEqual(row.semanticClass, 'B_MOVE_TO_L2_NO_APPROVAL', `${row.jtbdId} writes a decision/task`);
      assert.deepEqual(row.proposed, { targetAutonomy: 'L3', humanApprovalRequired: true });
    }
  }
  const records = readFileSync(join(ROOT, 'docs/jtbd/catalog/jtbd.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  for (const row of review.reviews) {
    const record = records.find((item) => item.jtbd_id === row.jtbdId);
    assert.ok(record.use_case.summary.includes(`limite ${row.proposed.targetAutonomy}`), row.jtbdId);
  }
});

test('roadmap audit separates structure, semantic support, overrides, and human review', () => {
  const audit = JSON.parse(readFileSync(join(ROOT, 'docs/jtbd/roadmap/assignment-audit-v1.1.json'), 'utf8'));
  assert.equal(audit.summary.structurallyValid, 600);
  const cro = audit.audits.find((row) => row.jtbdId === 'ACC-JTBD-CRO-002');
  assert.equal(cro.semanticStatus, 'semantically_supported');
  assert.equal(cro.semanticEvidence.assignedPillar, 'core-crm-revenue');
  assert.ok(cro.semanticEvidence.candidatePillars.includes('core-crm-revenue'));
  const unrelated = clone(cro);
  unrelated.semanticEvidence.assignedPillar = 'billing';
  unrelated.semanticEvidence.overrideRationale = null;
  const status = unrelated.semanticEvidence.candidatePillars.includes(unrelated.semanticEvidence.assignedPillar)
    ? 'semantically_supported'
    : unrelated.semanticEvidence.overrideRationale ? 'explicit_override_with_rationale' : 'needs_human_review';
  assert.equal(status, 'needs_human_review');
  for (const row of audit.audits.filter((item) => item.semanticStatus === 'needs_human_review')) {
    const assignment = world.assignments.find((item) => item.jtbdId === row.jtbdId);
    assert.equal(assignment.disposition, 'deferred', row.jtbdId);
    assert.ok(assignment.deferredReason, row.jtbdId);
  }
});

test('taxonomy errors name concrete competing evidence and a human action', () => {
  const reverse = JSON.parse(readFileSync(join(ROOT, 'docs/jtbd/quality/REVERSE_CAPABILITY_AUDIT.json'), 'utf8'));
  for (const [id, row] of Object.entries(reverse.orphanCapabilities)) {
    if (row.classification !== 'taxonomy error') continue;
    assert.ok(row.taxonomyEvidence?.competingCapabilityOrCategory, id);
    assert.ok(row.taxonomyEvidence?.duplicatedOrMisplacedBoundary, id);
    assert.match(row.taxonomyEvidence?.recommendedHumanAction, /^(relocate|consolidate|rename|split|retain with rationale)$/, id);
    assert.ok(row.reason.includes(row.taxonomyEvidence.competingCapabilityOrCategory), id);
    assert.ok(!/^.+overlaps a taxonomy boundary/.test(row.reason), id);
  }
});

test('README canonical byte count equals the file and manifest', () => {
  const catalog = readFileSync(join(ROOT, 'docs/jtbd/catalog/jtbd.jsonl'));
  const manifest = JSON.parse(readFileSync(join(ROOT, 'docs/jtbd/manifest.json'), 'utf8'));
  const bytes = manifest.files.find((row) => row.path === 'catalog/jtbd.jsonl').bytes;
  assert.equal(catalog.byteLength, bytes);
  assert.ok(readFileSync(join(ROOT, 'docs/jtbd/README.md'), 'utf8').includes(`${bytes.toLocaleString('en-US')} bytes`));
});

test('every desired job has a complete public roadmap disposition and no private priority', () => {
  const assignments = readFileSync(join(ROOT, 'docs/jtbd/roadmap/assignments.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(assignments.length, 600);
  assert.equal(new Set(assignments.map((row) => row.jtbdId)).size, 600);
  for (const row of assignments) {
    for (const field of ['disposition', 'pillar', 'edition', 'roadmapTrack', 'milestoneOrEpic', 'dependencies']) assert.notEqual(row[field], undefined);
    for (const field of [...PRIVATE_CATALOG_FIELDS, 'priority', 'businessValue', 'competitiveRationale', 'commercialSequence']) assert.ok(!(field in row));
  }
});

test('explicit assignment keeps a registered null package instead of an inferred package', () => {
  const record = world.records.find((row) => row.core.some((capability) => world.capabilityPillars[capability] && world.pillars.pillars[world.capabilityPillars[capability]]?.package));
  assert.ok(record);
  const assignment = { ...world.assignments.find((row) => row.jtbdId === record.id), pillar: 'billing' };
  const roadmap = buildOverlays({ ...world, assignments: world.assignments.map((row) => row.jtbdId === record.id ? assignment : row) }).roadmap;
  assert.equal(roadmap.find((row) => row.jtbdId === record.id).package, null);
});

test('refuses unknown pillars and assignment metadata that contradicts the registry', () => {
  for (const mutation of [
    { pillar: 'does-not-exist' },
    { edition: 'private-managed-cloud' },
    { roadmapTrack: 'Invented track' },
  ]) {
    const assignments = clone(world.assignments);
    assignments[0] = { ...assignments[0], ...mutation };
    const { problems } = checkWorld({ ...world, assignments });
    assert.ok(codes(problems).has('JTBD_ROADMAP_RESOLUTION_UNKNOWN'));
  }
});

test('semantic roadmap ownership permits a candidate, reviewed override, or human deferral only', () => {
  const source = world.assignments.find((row) => row.jtbdId === 'ACC-JTBD-CRO-002');
  assert.ok(source);
  const replace = (mutation) => world.assignments.map((row) => row.jtbdId === source.jtbdId
    ? { ...row, ...mutation }
    : row);
  const candidate = { ...source, disposition: 'planned' };
  assert.ok(!codes(checkWorld({ ...world, assignments: replace(candidate) }).problems)
    .has('JTBD_ROADMAP_OWNER_UNSUPPORTED'));

  const billing = world.pillars.pillars.billing;
  const unsupported = {
    pillar: 'billing',
    edition: billing.edition,
    roadmapTrack: billing.roadmapTrack,
    disposition: 'planned',
    overrideRationale: undefined,
  };
  for (const disposition of ['planned', 'in progress', 'implemented']) {
    const problems = checkWorld({
      ...world,
      assignments: replace({ ...unsupported, disposition }),
    }).problems;
    assert.ok(codes(problems).has('JTBD_ROADMAP_OWNER_UNSUPPORTED'), disposition);
  }

  const reviewedOverride = replace({
    ...unsupported,
    overrideRationale: 'Billing owns delivery because its public API is the orchestration boundary.',
    overrideReview: {
      reviewedBy: 'product-architecture-council',
      reviewedAt: '2026-08-22T10:00:00.000Z',
      evidence: 'PR-111 ownership review',
    },
  });
  assert.ok(!codes(checkWorld({ ...world, assignments: reviewedOverride }).problems)
    .has('JTBD_ROADMAP_OWNER_UNSUPPORTED'));

  const humanDeferred = replace({
    ...unsupported,
    disposition: 'deferred',
    deferredReason: 'Candidate-pillar ownership is ambiguous and requires human product review.',
  });
  assert.ok(!codes(checkWorld({ ...world, assignments: humanDeferred }).problems)
    .has('JTBD_ROADMAP_OWNER_UNSUPPORTED'));
});

test('semantic ownership overrides cannot publish commercial rationale', () => {
  const source = world.assignments.find((row) => row.jtbdId === 'ACC-JTBD-CRO-002');
  const billing = world.pillars.pillars.billing;
  for (const overrideRationale of [
    'Commercial sequencing makes this the highest business value.',
    'Highest ROI and market demand make Billing the owner.',
  ]) {
    const assignments = world.assignments.map((row) => row.jtbdId === source.jtbdId ? {
      ...row,
      pillar: 'billing',
      edition: billing.edition,
      roadmapTrack: billing.roadmapTrack,
      disposition: 'planned',
      overrideRationale,
    } : row);
    assert.ok(codes(checkWorld({ ...world, assignments }).problems).has('JTBD_PRIVATE_FIELD_PUBLISHED'));
  }
});

test('semantic ownership overrides require meaningful rationale and structured review evidence', () => {
  const source = world.assignments.find((row) => row.jtbdId === 'ACC-JTBD-CRO-002');
  const billing = world.pillars.pillars.billing;
  for (const mutation of [
    { overrideRationale: 'x' },
    { overrideRationale: 'Billing owns delivery because its public API is the orchestration boundary.' },
    {
      overrideRationale: 'Billing owns delivery because its public API is the orchestration boundary.',
      overrideReview: { reviewedBy: 'ab', reviewedAt: 'yesterday', evidence: 'short' },
    },
  ]) {
    const assignments = world.assignments.map((row) => row.jtbdId === source.jtbdId ? {
      ...row,
      pillar: 'billing',
      edition: billing.edition,
      roadmapTrack: billing.roadmapTrack,
      disposition: 'planned',
      ...mutation,
    } : row);
    assert.ok(codes(checkWorld({ ...world, assignments }).problems)
      .has('JTBD_ROADMAP_OWNER_UNSUPPORTED'));
  }
});

test('roadmap dependencies are arrays of unique registered pillar ids', () => {
  const validId = Object.keys(world.pillars.pillars)[0];
  for (const dependencies of [
    'billing',
    ['does-not-exist'],
    [validId, 'does-not-exist'],
    [validId, validId],
  ]) {
    const assignments = clone(world.assignments);
    assignments[0].dependencies = dependencies;
    assert.ok(codes(checkWorld({ ...world, assignments }).problems).has('JTBD_ROADMAP_RESOLUTION_UNKNOWN'));
  }
  for (const dependencies of [[], [validId]]) {
    const assignments = clone(world.assignments);
    assignments[0].dependencies = dependencies;
    assert.ok(!codes(checkWorld({ ...world, assignments }).problems).has('JTBD_ROADMAP_RESOLUTION_UNKNOWN'));
  }
});

test('refuses the catalogue commercial field names in public assignments', () => {
  for (const privateField of PRIVATE_CATALOG_FIELDS) {
    const assignments = clone(world.assignments);
    assignments[0][privateField] = privateField === 'competitive_benchmark' ? [] : 5;
    const { problems } = checkWorld({ ...world, assignments });
    assert.ok(codes(problems).has('JTBD_PRIVATE_FIELD_PUBLISHED'), privateField);
  }
});

test('the catalogue is streamed, and only four fields survive the read', async () => {
  const { records, problems } = await readCatalogSpine(ROOT);
  assert.deepEqual(problems, []);
  assert.equal(records.length, 600);
  // If this ever grows a `roadmap` or `competitive_benchmark` key, the commercial half of the
  // corpus has started travelling with the ids, which is the thing PUBLIC_PRIVATE.md forbids.
  assert.deepEqual(
    Object.keys(records[0]).sort(),
    ['core', 'id', 'jobName', 'lifecycle', 'role', 'roleGroup'],
  );
});

test('every vocabulary is closed, and the four coverage statuses are exactly the published four', () => {
  assert.deepEqual(COVERAGE_STATUSES, [
    'not supported', 'partially supported', 'technically supported', 'validated end to end',
  ]);
  assert.equal(POSITIVE_STATUSES.length, 3);
  assert.ok(!POSITIVE_STATUSES.includes('not supported'));
  assert.equal(new Set(OWNERSHIP_RESOLUTIONS).size, 6);
  assert.equal(new Set(OWNER_STATUSES).size, 6);
  assert.equal(new Set(CROSSWALK_DISPOSITIONS).size, 5);
  assert.equal(new Set(JTBD_GATE_PROBLEMS).size, JTBD_GATE_PROBLEMS.length);
});

test('the four statuses are the ones docs/QUALITY_GATES.md §3 publishes', () => {
  const gates = readFileSync(join(ROOT, 'docs/QUALITY_GATES.md'), 'utf8');
  for (const status of COVERAGE_STATUSES) {
    assert.ok(gates.includes(`**${status}**`), `${status} is not published by docs/QUALITY_GATES.md`);
  }
});

test('no positive status can be born outside assessments.json', () => {
  const built = buildOverlays({ ...world, assessments: [] });
  assert.equal(built.coverage.length, 600);
  assert.equal(built.coverage.filter((row) => row.coverageStatus !== 'not supported').length, 0);
  assert.equal(built.coverage.filter((row) => row.assessed).length, 0);
});

test('the default is published as a default, not as a finding', () => {
  const built = buildOverlays(world);
  const defaults = built.coverage.filter((row) => row.coverageStatus === 'not supported');
  assert.ok(defaults.length > 500);
  assert.ok(defaults.every((row) => row.assessed === false && row.evidence.length === 0));
  assert.ok(built.coverage.filter((row) => row.assessed).every((row) => row.evidence.length > 0));
});

test('refuses a stale verifiedAtSha: evidence that moved fails the overlay check', () => {
  // **The rule the gate exists for.** Nothing about the assessment changes; the file it read
  // does. A commit id alone could not notice this — it is a label, and it resolves to nothing
  // in a shallow clone. The recorded content digest does.
  const moved = new Map(world.digests);
  const [path] = [...moved.keys()];
  moved.set(path, 'f'.repeat(64));
  const { problems } = checkWorld({ ...world, digests: moved });
  assert.ok(codes(problems).has('JTBD_EVIDENCE_MOVED'), 'a moved evidence file must fail the gate');
  assert.ok(problems.some((problem) => problem.message.includes(path)));
  assert.ok(problems.some((problem) => problem.message.includes('--reverify')));
});

test('refuses evidence that no longer exists', () => {
  const gone = new Map(world.digests);
  gone.delete([...gone.keys()][0]);
  const { problems } = checkWorld({ ...world, digests: gone });
  assert.ok(codes(problems).has('JTBD_EVIDENCE_MISSING'));
});

test('refuses a positive status resting only on source or documentation', () => {
  const assessments = clone(world.assessments);
  assessments[0].evidence = assessments[0].evidence.map((item) => ({ ...item, kind: 'CODE' }));
  const digests = new Map(world.digests);
  const { problems } = checkWorld({ ...world, assessments, digests });
  assert.ok(codes(problems).has('JTBD_EVIDENCE_NOT_EXECUTABLE'));
  assert.ok(EXECUTABLE_EVIDENCE_KINDS.every((kind) => kind !== 'CODE' && kind !== 'DOC'));
});

test('refuses a positive status with no evidence at all', () => {
  const assessments = clone(world.assessments);
  assessments[0].evidence = [];
  const { problems } = checkWorld({ ...world, assessments });
  assert.ok(codes(problems).has('JTBD_EVIDENCE_MISSING'));
});

test('refuses a positive status that names no residual limitation', () => {
  const assessments = clone(world.assessments);
  assessments[0].limitations = [];
  const { problems } = checkWorld({ ...world, assessments });
  assert.ok(codes(problems).has('JTBD_EVIDENCE_LIMITATION_ABSENT'));
});

test('refuses the top status without Production Spine evidence', () => {
  const assessments = clone(world.assessments);
  assessments[0].coverageStatus = 'validated end to end';
  assessments[0].factIds = assessments[0].factIds.filter((id) => !id.startsWith('spine.'));
  const { problems } = checkWorld({ ...world, assessments });
  assert.ok(codes(problems).has('JTBD_SPINE_EVIDENCE_ABSENT'));
  // And it is a rule about the top status only — the checked-in rows are all partial.
  assert.ok(!codes(checkWorld(world).problems).has('JTBD_SPINE_EVIDENCE_ABSENT'));
});

test('refuses a Repository Truth fact id the contract does not publish', () => {
  const assessments = clone(world.assessments);
  assessments[0].factIds = ['spine.authorization.definitely_not_a_fact'];
  const { problems } = checkWorld({ ...world, assessments });
  assert.ok(codes(problems).has('JTBD_FACT_UNKNOWN'));
});

test('refuses an assessment for a job the catalogue does not hold', () => {
  const assessments = clone(world.assessments);
  assessments[0].jtbdId = 'ACC-JTBD-NOT-A-JOB-001';
  const { problems } = checkWorld({ ...world, assessments });
  assert.ok(codes(problems).has('JTBD_COVERAGE_NOT_ASSESSED'));
});

test('refuses "not supported" written into assessments.json', () => {
  const assessments = clone(world.assessments);
  assessments[0].coverageStatus = 'not supported';
  const { problems } = checkWorld({ ...world, assessments });
  assert.ok(codes(problems).has('JTBD_COVERAGE_STATUS_UNKNOWN'));
});

test('refuses a stale overlay', () => {
  const { problems } = checkWorld({ ...world, coverageText: '{"jtbdId":"ACC-JTBD-CRO-001"}\n' });
  assert.ok(codes(problems).has('JTBD_OVERLAY_STALE'));
});

test('refuses a crosswalk row citing an id the catalogue does not hold', () => {
  const crosswalk = clone(world.crosswalk);
  crosswalk.rows[0].canonicalJtbdIds = ['ACC-JTBD-INVENTED-999'];
  const { problems } = checkWorld({ ...world, crosswalk });
  assert.ok(codes(problems).has('JTBD_CROSSWALK_ID_UNKNOWN'));
});

test('refuses a non-default coverage row that cites nothing and says nothing', () => {
  const crosswalk = clone(world.crosswalk);
  const row = crosswalk.rows.find((entry) => entry.matrixStatus !== 'not supported');
  row.canonicalJtbdIds = [];
  delete row.unmappedReason;
  const { problems } = checkWorld({ ...world, crosswalk });
  assert.ok(codes(problems).has('JTBD_CROSSWALK_UNCITED'));
});

test('a declared unmappedReason is the only way a non-default row may cite nothing', () => {
  const crosswalk = clone(world.crosswalk);
  const row = crosswalk.rows.find((entry) => entry.matrixStatus !== 'not supported');
  row.canonicalJtbdIds = [];
  row.unmappedReason = 'nothing in the catalogue expresses this job';
  const { problems } = checkWorld({ ...world, crosswalk });
  assert.ok(!codes(problems).has('JTBD_CROSSWALK_UNCITED'));
});

test('refuses a crosswalk that has drifted from the matrix it copies', () => {
  const crosswalk = clone(world.crosswalk);
  const row = crosswalk.rows.find((entry) => entry.matrixId === 'JTBD-LI-02');
  row.matrixStatus = 'not supported';
  const { problems } = checkWorld({ ...world, crosswalk });
  assert.ok(codes(problems).has('JTBD_CROSSWALK_STATUS_DRIFT'));
});

test('requires every matrix row to have exactly one crosswalk disposition', () => {
  const crosswalk = clone(world.crosswalk);
  crosswalk.rows = crosswalk.rows.filter((entry) => entry.matrixId !== 'JTBD-DS-02');
  assert.ok(codes(checkWorld({ ...world, crosswalk }).problems).has('JTBD_CROSSWALK_UNCITED'));

  const duplicated = clone(world.crosswalk);
  duplicated.rows.push(clone(duplicated.rows[0]));
  assert.ok(codes(checkWorld({ ...world, crosswalk: duplicated }).problems).has('JTBD_CROSSWALK_ID_UNKNOWN'));
});

test('refuses a crosswalk row absent from the matrix', () => {
  const matrixText = world.matrixText.replace(/^\|\s*JTBD-DS-02\s*\|.*$/m, '');
  assert.ok(codes(checkWorld({ ...world, matrixText }).problems).has('JTBD_CROSSWALK_ID_UNKNOWN'));
});

test('preserves missing-overlay input failures', () => {
  const problems = checkWorld({
    ...world,
    coverageText: null,
    problems: [...world.problems, { code: 'JTBD_INPUT_UNAVAILABLE', message: 'coverage overlay absent' }],
  }).problems;
  assert.ok(codes(problems).has('JTBD_INPUT_UNAVAILABLE'));
});

test('refuses an unclassified artefact', () => {
  const classification = clone(world.classification);
  delete classification.artefacts['docs/jtbd/coverage/coverage.overlay.jsonl'];
  const { problems } = checkWorld({ ...world, classification });
  assert.ok(codes(problems).has('JTBD_ARTEFACT_UNCLASSIFIED'));
});

test('refuses a commercial catalogue field reaching a public overlay', () => {
  const built = buildOverlays(world);
  for (const row of [...built.coverage, ...built.roadmap]) {
    for (const field of PRIVATE_CATALOG_FIELDS) {
      assert.ok(!Object.prototype.hasOwnProperty.call(row, field), `${row.jtbdId} carries ${field}`);
    }
  }
  // And the rule is enforced rather than merely satisfied. It reads the committed bytes, so
  // a hand-edited overlay is what it catches — the generator could never emit one of these.
  const coverage = built.coverage.map((row, index) => (index ? row : { ...row, business_value_1_5: 5 }));
  const { problems } = checkWorld({
    ...world,
    coverageText: `${coverage.map((row) => JSON.stringify(row)).join('\n')}\n`,
  });
  assert.ok(codes(problems).has('JTBD_PRIVATE_FIELD_PUBLISHED'));
  assert.ok(problems.some((problem) => problem.message.includes('business_value_1_5')));
});

test('every job resolves to exactly one owner, and the resolution is in the closed set', () => {
  const built = buildOverlays(world);
  assert.equal(built.roadmap.length, 600);
  for (const row of built.roadmap) {
    assert.ok(OWNERSHIP_RESOLUTIONS.includes(row.ownershipResolution));
    assert.ok(OWNER_STATUSES.includes(row.ownerStatus));
    const owned = row.ownershipResolution === 'public_oss_pillar' || row.ownershipResolution === 'private_managed_cloud';
    assert.equal(Boolean(row.pillar), owned, `${row.jtbdId}: pillar and resolution disagree`);
  }
});

test('ownership follows the crosswalk and never the coverage overlay', () => {
  // Move every coverage row to the strongest positive status; not one milestone may move.
  const before = buildOverlays(world).roadmap;
  const promoted = world.records.map((record) => ({
    jtbdId: record.id,
    coverageStatus: 'validated end to end',
    evidence: [],
    limitations: [],
    verifiedAtSha: 'deadbee',
    factIds: [],
  }));
  const after = buildOverlays({ ...world, assessments: promoted }).roadmap;
  assert.deepEqual(after, before);
});

test('no job that is unsupported or partly supported is left without somewhere to go', () => {
  const built = buildOverlays(world);
  const owner = new Map(built.roadmap.map((row) => [row.jtbdId, row]));
  for (const row of built.coverage) {
    if (row.coverageStatus !== 'not supported' && row.coverageStatus !== 'partially supported') continue;
    const plan = owner.get(row.jtbdId);
    assert.ok(
      plan.milestone || ['deferred', 'unassigned', 'out of scope'].includes(plan.ownerStatus),
      `${row.jtbdId} is an orphan`,
    );
  }
});

test('the summary facts in docs/repository-truth.json are the generated ones', () => {
  const truth = JSON.parse(readFileSync(join(ROOT, 'docs/repository-truth.json'), 'utf8'));
  const facts = new Map(truth.facts.map((fact) => [fact.id, fact]));
  const { summary } = checkWorld(world);
  assert.equal(facts.get('jtbd.catalog.record_count').value, summary.recordCount);
  assert.equal(facts.get('jtbd.catalog.unique_ids').value, summary.uniqueIds);
  assert.equal(facts.get('jtbd.coverage.overlay_complete').value, String(summary.overlayComplete));
  assert.equal(facts.get('jtbd.roadmap.unassigned_count').value, summary.roadmapUnassigned);
  assert.equal(facts.get('jtbd.crosswalk.unmapped_count').value, summary.crosswalkUnmapped);
  assert.equal(
    facts.get('jtbd.positive_coverage_without_evidence_count').value,
    summary.positiveCoverageWithoutEvidence,
  );
  // Six summary facts, and not six hundred: ADR-039 JTBD_ROWS_NOT_ENCODED still holds.
  assert.equal(truth.facts.filter((fact) => fact.id.startsWith('jtbd.')).length, 6);
  for (const fact of truth.facts.filter((entry) => entry.id.startsWith('jtbd.'))) {
    assert.deepEqual(fact.limitations, ['JTBD_ROWS_NOT_ENCODED']);
  }
});

test('every JTBD artefact has an explicit public/private disposition', () => {
  const tracked = execFileSync('git', ['ls-files', 'docs/jtbd'], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n');
  for (const rel of tracked) assert.ok(world.classification.artefacts[rel], `${rel} is unclassified`);
});

test('every referenced artefact exists', () => {
  for (const rel of Object.keys(world.classification.artefacts)) {
    assert.ok(existsSync(join(ROOT, rel)), `${rel} is classified but absent`);
  }
});
