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

test('every referenced artefact exists', () => {
  for (const rel of Object.keys(world.classification.artefacts)) {
    assert.ok(existsSync(join(ROOT, rel)), `${rel} is classified but absent`);
  }
});
