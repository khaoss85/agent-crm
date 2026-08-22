// @ts-check
/**
 * # The JTBD Portfolio Alignment Gate
 *
 * `node scripts/jtbd-gate.js`            check
 * `node scripts/jtbd-gate.js --write`    regenerate the two overlays from their inputs
 * `node scripts/jtbd-gate.js --reverify` re-stamp evidence digests in assessments.json
 * `node scripts/jtbd-gate.js --json`     machine-readable summary on stdout
 *
 * ## What it is for
 *
 * `docs/jtbd/catalog/` is a **desired-state** corpus: 600 jobs somebody wants a CRM to do.
 * `docs/benchmarks/CRM_JTBD_MATRIX.md` is this repository's **coverage** record.
 * `docs/strategy/EXECUTION_ROADMAP.md` is the **plan**. Three different questions, and the
 * failure this gate exists to prevent is any two of them being read as one — above all a
 * desired job being counted as a supported one.
 *
 * So there are three layers, in three files, in three vocabularies, joined only by `jtbd_id`:
 *
 * | Layer | File | Vocabulary |
 * |---|---|---|
 * | desired | `docs/jtbd/catalog/jtbd.jsonl` (never written here) | the catalogue's own enum |
 * | coverage | `docs/jtbd/coverage/coverage.overlay.jsonl` | the four in `docs/QUALITY_GATES.md` §3 |
 * | ownership | `docs/jtbd/roadmap/roadmap.overlay.jsonl` | implemented…out of scope |
 *
 * ## What it will not do
 *
 * **It cannot promote a row.** `--write` copies a positive coverage status out of
 * `docs/jtbd/coverage/assessments.json` or it writes `not supported`. There is no rule in
 * here that reads the repository and concludes a job is supported, because that conclusion is
 * a person's (`docs/QUALITY_GATES.md` §3, ADR-039 `JTBD_ROWS_NOT_ENCODED`).
 *
 * **It publishes no priority.** The catalogue carries `roadmap.business_value_1_5` and
 * friends; no overlay written here reads them.
 *
 * **It never loads the catalogue whole.** 4.6 MB of JSONL is streamed line by line, here and
 * in `docs/jtbd/tools/query_catalog.py`.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The **only** coverage vocabulary a repository overlay may use. */
export const COVERAGE_STATUSES = Object.freeze([
  'not supported',
  'partially supported',
  'technically supported',
  'validated end to end',
]);

/** Anything but the default is a claim, and a claim needs evidence. */
export const POSITIVE_STATUSES = Object.freeze(COVERAGE_STATUSES.filter((s) => s !== 'not supported'));

/** How a job resolves to an owner. Exactly one per job, always set. */
export const OWNERSHIP_RESOLUTIONS = Object.freeze([
  'public_oss_pillar',
  'private_managed_cloud',
  'private_gtm_internal',
  'intentionally_deferred',
  'out_of_scope',
  'unassigned_gap',
]);

/** Where the owning workstream stands on this job. */
export const OWNER_STATUSES = Object.freeze([
  'implemented',
  'in progress',
  'planned',
  'deferred',
  'unassigned',
  'out of scope',
]);

/** How a matrix row relates to the canonical catalogue. Derived, never typed. */
export const CROSSWALK_DISPOSITIONS = Object.freeze([
  'identical',
  'split',
  'consolidated',
  'superseded',
  'no_canonical_match',
]);

/**
 * Evidence kinds that can carry a positive status on their own.
 *
 * The rule from `docs/jtbd/AGENTS.md`: source and prose may *locate* evidence, they do not
 * promote a status. So `CODE` and `DOC` are legal to record and cannot be the only thing a
 * claim rests on.
 */
export const EXECUTABLE_EVIDENCE_KINDS = Object.freeze(['TEST', 'SCENARIO', 'RECEIPT', 'RAIL']);

/** Every evidence kind the overlay accepts. */
export const EVIDENCE_KINDS = Object.freeze([...EXECUTABLE_EVIDENCE_KINDS, 'CODE', 'DOC']);

/** Every problem this gate can report. Closed, so a caller can switch on it. */
export const JTBD_GATE_PROBLEMS = Object.freeze([
  'JTBD_INPUT_UNAVAILABLE',
  'JTBD_CATALOG_SHAPE_UNEXPECTED',
  'JTBD_OVERLAY_STALE',
  'JTBD_OVERLAY_INCOMPLETE',
  'JTBD_COVERAGE_STATUS_UNKNOWN',
  'JTBD_COVERAGE_NOT_ASSESSED',
  'JTBD_EVIDENCE_MISSING',
  'JTBD_EVIDENCE_MOVED',
  'JTBD_EVIDENCE_NOT_EXECUTABLE',
  'JTBD_EVIDENCE_LIMITATION_ABSENT',
  'JTBD_SPINE_EVIDENCE_ABSENT',
  'JTBD_FACT_UNKNOWN',
  'JTBD_ROADMAP_ORPHAN',
  'JTBD_ROADMAP_OWNER_UNSUPPORTED',
  'JTBD_ROADMAP_RESOLUTION_UNKNOWN',
  'JTBD_CROSSWALK_ID_UNKNOWN',
  'JTBD_CROSSWALK_UNCITED',
  'JTBD_CROSSWALK_STATUS_DRIFT',
  'JTBD_ARTEFACT_UNCLASSIFIED',
  'JTBD_PRIVATE_FIELD_PUBLISHED',
]);

/**
 * Catalogue fields that carry commercial judgement and must never reach a public overlay.
 *
 * `docs/editions/REPOSITORY_BOUNDARY.md` §3: a document goes private because it is
 * commercial, never because it is unflattering. These five are the commercial half of each
 * catalogue record, and the checker refuses to find any of them in an overlay row.
 */
export const PRIVATE_CATALOG_FIELDS = Object.freeze([
  'business_value_1_5',
  'strategic_fit_1_5',
  'differentiation_1_5',
  'audit_priority_score_0_100',
  'competitive_benchmark',
]);

const PATHS = Object.freeze({
  catalog: 'docs/jtbd/catalog/jtbd.jsonl',
  capabilities: 'docs/jtbd/catalog/capabilities.json',
  capabilityPillars: 'docs/jtbd/roadmap/capability_pillars.json',
  pillars: 'docs/jtbd/roadmap/pillars.json',
  crosswalk: 'docs/jtbd/coverage/matrix_crosswalk.json',
  assessments: 'docs/jtbd/coverage/assessments.json',
  coverageOverlay: 'docs/jtbd/coverage/coverage.overlay.jsonl',
  roadmapOverlay: 'docs/jtbd/roadmap/roadmap.overlay.jsonl',
  assignments: 'docs/jtbd/roadmap/assignments.jsonl',
  overrideReviews: 'docs/jtbd/roadmap/override-reviews.json',
  classification: 'docs/jtbd/PUBLIC_PRIVATE.json',
  truth: 'docs/repository-truth.json',
  matrix: 'docs/benchmarks/CRM_JTBD_MATRIX.md',
});

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

const TECHNICAL_OWNERSHIP_RATIONALES = Object.freeze({
  architecture_boundary: 'Ownership follows the reviewed public architecture boundary.',
  delivery_responsibility: 'Ownership follows the reviewed public delivery responsibility.',
  orchestration_owner: 'Ownership follows the reviewed public orchestration responsibility.',
  public_dependency: 'Ownership follows the reviewed public dependency boundary.',
});

const isReviewedTechnicalOverride = (assignment, rationale, reviewsById, evidenceKeys) => {
  const review = reviewsById.get(assignment?.overrideReviewId);
  const reviewedAt = typeof review?.reviewedAt === 'string' ? review.reviewedAt : '';
  const timestamp = Date.parse(reviewedAt);
  return review && typeof review === 'object' && !Array.isArray(review)
    && review.jtbdId === assignment.jtbdId && review.pillar === assignment.pillar
    && review.technicalRationale === rationale
    && TECHNICAL_OWNERSHIP_RATIONALES[review.ownershipBasis] === rationale
    && typeof review.reviewedBy === 'string' && review.reviewedBy.trim().length >= 3
    && typeof review.evidencePath === 'string'
    && evidenceKeys.has(`${review.reviewId}\0${review.evidencePath}`)
    && Number.isFinite(timestamp) && new Date(timestamp).toISOString() === reviewedAt;
};

/**
 * Stream the catalogue, yielding only the four fields the overlays need.
 *
 * Never `readFileSync` here. The file is 4.6 MB and the point of the whole exercise is that
 * nothing has to hold 600 records to answer a question about them.
 */
export async function readCatalogSpine(rootDir = ROOT) {
  const file = join(rootDir, PATHS.catalog);
  if (!existsSync(file)) return { problems: [{ code: 'JTBD_INPUT_UNAVAILABLE', message: `${PATHS.catalog} does not exist` }], records: [] };
  /** @type {Array<{id: string, role: string, roleGroup: string, lifecycle: string, jobName: string, core: string[]}>} */
  const records = [];
  const problems = [];
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  let line = 0;
  for await (const raw of rl) {
    line += 1;
    if (!raw.trim()) continue;
    let record;
    try {
      record = JSON.parse(raw);
    } catch (error) {
      problems.push({ code: 'JTBD_CATALOG_SHAPE_UNEXPECTED', message: `line ${line}: ${error.message}` });
      continue;
    }
    const core = record?.capabilities?.core;
    if (typeof record?.jtbd_id !== 'string' || !Array.isArray(core)) {
      problems.push({ code: 'JTBD_CATALOG_SHAPE_UNEXPECTED', message: `line ${line}: no jtbd_id or no capabilities.core` });
      continue;
    }
    records.push({
      id: record.jtbd_id,
      role: String(record.role ?? ''),
      roleGroup: String(record.role_group ?? ''),
      lifecycle: String(record.platform_lifecycle ?? ''),
      jobName: String(record.job_name ?? ''),
      core: core.map(String),
    });
  }
  const ids = new Set(records.map((r) => r.id));
  if (ids.size !== records.length) {
    problems.push({ code: 'JTBD_CATALOG_SHAPE_UNEXPECTED', message: `duplicate jtbd_id: ${records.length} records, ${ids.size} distinct ids` });
  }
  return { records, problems };
}

const readJson = (rootDir, rel, problems) => {
  const file = join(rootDir, rel);
  if (!existsSync(file)) {
    problems.push({ code: 'JTBD_INPUT_UNAVAILABLE', message: `${rel} does not exist` });
    return null;
  }
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    problems.push({ code: 'JTBD_INPUT_UNAVAILABLE', message: `${rel} is not readable JSON: ${error.message}` });
    return null;
  }
};

/**
 * Build both overlays from their inputs.
 *
 * Pure over what it is handed, so a test can move one input and watch exactly one field move.
 */
export function buildOverlays({ records, assessments, crosswalk, capabilityPillars, pillars, assignments = [], overrideReviews = { reviews: [] }, reviewEvidenceKeys = new Set() }) {
  const problems = [];
  const byId = new Map(assessments.map((entry) => [entry.jtbdId, entry]));
  const assignmentById = new Map(assignments.map((entry) => [entry.jtbdId, entry]));
  const reviewsById = new Map();
  const allowedReviewFields = new Set([
    'reviewId', 'jtbdId', 'pillar', 'ownershipBasis', 'technicalRationale',
    'reviewedBy', 'reviewedAt', 'evidencePath',
  ]);
  for (const review of overrideReviews.reviews ?? []) {
    const unknown = Object.keys(review).filter((field) => !allowedReviewFields.has(field));
    if (unknown.length) {
      problems.push({
        code: 'JTBD_PRIVATE_FIELD_PUBLISHED',
        message: `${review.reviewId ?? 'override review'}: public ownership review has unsupported field(s): ${unknown.join(', ')}`,
      });
    }
    if (reviewsById.has(review.reviewId)) {
      problems.push({ code: 'JTBD_ROADMAP_OWNER_UNSUPPORTED', message: `${review.reviewId}: duplicate ownership review id` });
    }
    reviewsById.set(review.reviewId, review);
  }
  const precedence = pillars.precedence;
  const registry = pillars.pillars;

  // Which crosswalk rows name each canonical job, so ownership follows the crosswalk and
  // never the coverage overlay. A milestone is a plan; a status is a claim; they are
  // deliberately read from different places.
  /** @type {Map<string, any[]>} */
  const citedBy = new Map();
  for (const row of crosswalk.rows) {
    for (const id of row.canonicalJtbdIds) {
      if (!citedBy.has(id)) citedBy.set(id, []);
      citedBy.get(id).push(row);
    }
  }

  const coverage = [];
  const roadmap = [];
  for (const record of records) {
    // ── coverage ──────────────────────────────────────────────────────────
    const assessed = byId.get(record.id);
    coverage.push({
      jtbdId: record.id,
      coverageStatus: assessed ? assessed.coverageStatus : 'not supported',
      // `assessed:false` is the honest half of the default. "not supported" is the
      // publication default (QUALITY_GATES §1.6); it is not a finding, and a reader who
      // counted 600 "not supported" rows as 600 assessments would be reading a claim
      // nobody made.
      assessed: Boolean(assessed),
      evidence: assessed ? assessed.evidence : [],
      limitations: assessed ? assessed.limitations : [],
      verifiedAtSha: assessed ? assessed.verifiedAtSha : null,
      factIds: assessed ? assessed.factIds : [],
    });

    // ── ownership ─────────────────────────────────────────────────────────
    // **Ownership is decided among owners.** An earlier form let the unowned bucket win a
    // plurality, so a job whose renewal half Accordo owns came out "unassigned" because its
    // health-score and success-plan halves are unowned. That reads as "nobody owns this",
    // which is false and hides the pillar that does. The unowned fraction is recorded
    // instead, as `unownedCoreCapabilities`, and a job is `unassigned_gap` only when **no**
    // core capability has an Accordo owner at all.
    const counts = new Map();
    let unowned = 0;
    let outOfScope = 0;
    for (const capability of record.core) {
      const pillar = Object.prototype.hasOwnProperty.call(capabilityPillars, capability)
        ? capabilityPillars[capability]
        : undefined;
      if (pillar === undefined) {
        problems.push({ code: 'JTBD_INPUT_UNAVAILABLE', message: `${record.id} names capability ${capability}, which capability_pillars.json does not map` });
        continue;
      }
      if (pillar === null) unowned += 1;
      else if (pillar === '__out_of_scope__') outOfScope += 1;
      else counts.set(pillar, (counts.get(pillar) ?? 0) + 1);
    }
    const rank = (key) => {
      const index = precedence.indexOf(key);
      return index === -1 ? precedence.length : index;
    };
    const winner = [...counts.entries()]
      .sort((a, b) => (b[1] - a[1]) || (rank(a[0]) - rank(b[0])))[0]?.[0] ?? null;
    const candidatePillars = [...counts.keys()].sort((a, b) => rank(a) - rank(b));

    const entry = winner ? registry[winner] : null;
    const resolution = entry
      ? (entry.edition === 'private-managed-cloud' ? 'private_managed_cloud' : 'public_oss_pillar')
      : outOfScope > 0 ? 'out_of_scope' : 'unassigned_gap';

    const rows = citedBy.get(record.id) ?? [];
    const withMilestone = rows.filter((row) => row.milestone);
    const milestone = withMilestone[0]?.milestone ?? null;
    let ownerStatus;
    if (resolution === 'out_of_scope') ownerStatus = 'out of scope';
    else if (resolution === 'unassigned_gap') ownerStatus = 'unassigned';
    else if (!milestone) ownerStatus = 'unassigned';
    else ownerStatus = withMilestone.some((row) => row.matrixStatus !== 'not supported') ? 'in progress' : 'planned';

    const explicit = assignmentById.get(record.id);
    const explicitPillar = explicit ? registry[explicit.pillar] : null;
    const overrideRationale = typeof explicit?.overrideRationale === 'string'
      ? explicit.overrideRationale.trim()
      : '';
    const reviewedOverride = explicit
      ? isReviewedTechnicalOverride(explicit, overrideRationale, reviewsById, reviewEvidenceKeys)
      : false;
    const candidateOwner = explicit ? candidatePillars.includes(explicit.pillar) : true;
    const settled = ['implemented', 'in progress', 'planned'].includes(explicit?.disposition);
    if (explicit && overrideRationale && !reviewedOverride) {
      problems.push({
        code: 'JTBD_ROADMAP_OWNER_UNSUPPORTED',
        message: `${record.id}: overrideRationale is not bound to a registered technical ownership basis and existing public review evidence`,
      });
    }
    if (explicit && !candidateOwner && !reviewedOverride && settled) {
      problems.push({
        code: 'JTBD_ROADMAP_OWNER_UNSUPPORTED',
        message: `${record.id}: pillar "${explicit.pillar}" is outside the capability-derived candidate set `
          + `[${candidatePillars.join(', ')}] and cannot be ${explicit.disposition} without a meaningful technical rationale and structured public review evidence; defer it for human ownership review`,
      });
    }
    if (explicit && !candidateOwner && !reviewedOverride && explicit.disposition === 'deferred'
      && !/\b(owner|ownership|candidate pillar)\b/i.test(String(explicit.deferredReason ?? ''))) {
      problems.push({
        code: 'JTBD_ROADMAP_OWNER_UNSUPPORTED',
        message: `${record.id}: unsupported pillar "${explicit.pillar}" is deferred, but deferredReason does not make the ownership ambiguity explicit`,
      });
    }
    roadmap.push({
      jtbdId: record.id,
      ownershipResolution: explicit
        ? (explicit.edition === 'private-managed-cloud' ? 'private_managed_cloud' : 'public_oss_pillar')
        : resolution,
      pillar: explicit?.pillar ?? (entry ? winner : null),
      // An explicit assignment owns the complete pillar projection. In particular, `null`
      // is a meaningful package value for framework pillars; it must not fall through to
      // the capability-inferred pillar's package.
      package: explicit ? explicitPillar?.package ?? null : (entry ? entry.package : null),
      edition: explicit?.edition ?? (entry ? entry.edition : null),
      roadmapTrack: explicit?.roadmapTrack ?? (entry ? entry.roadmapTrack : null),
      milestone: explicit?.milestoneOrEpic ?? milestone,
      roadmapSlice: explicit?.roadmapSlice ?? null,
      dependencies: explicit?.dependencies ?? (entry ? entry.dependencies : []),
      ownerStatus: explicit?.disposition ?? ownerStatus,
      deferredReason: explicit?.deferredReason ?? null,
      publicLimitation: explicit?.publicLimitation ?? null,
      ...(reviewedOverride ? { overrideRationale } : {}),
      ...(reviewedOverride ? { overrideReviewId: explicit.overrideReviewId } : {}),
      candidatePillars,
      unownedCoreCapabilities: unowned,
      coreCapabilities: record.core.length,
      matrixRows: rows.map((row) => row.matrixId),
    });
  }
  return { coverage, roadmap, problems };
}

const serialize = (rows) => `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;

const readOverlay = (rootDir, rel, problems) => {
  const file = join(rootDir, rel);
  if (!existsSync(file)) {
    problems.push({ code: 'JTBD_INPUT_UNAVAILABLE', message: `${rel} does not exist — run node scripts/jtbd-gate.js --write` });
    return null;
  }
  return readFileSync(file, 'utf8');
};

const readJsonl = (rootDir, rel, problems) => {
  const text = readOverlay(rootDir, rel, problems);
  if (text === null) return [];
  try { return text.split('\n').filter(Boolean).map((line) => JSON.parse(line)); }
  catch (error) {
    problems.push({ code: 'JTBD_INPUT_UNAVAILABLE', message: `${rel} is not readable JSONL: ${error.message}` });
    return [];
  }
};



/**
 * Every check, over an already-loaded world.
 *
 * @returns {{problems: Array<{code: string, message: string}>, summary: any}}
 */
export function checkWorld(world) {
  const problems = [...world.problems];
  const { records, assessments, crosswalk, truth, classification, matrixText, digests } = world;
  const catalogIds = new Set(records.map((r) => r.id));
  const built = buildOverlays(world);
  problems.push(...built.problems);

  // ── 1. the overlays are current ───────────────────────────────────────────
  for (const [rel, rows, actual] of [
    [PATHS.coverageOverlay, built.coverage, world.coverageText],
    [PATHS.roadmapOverlay, built.roadmap, world.roadmapText],
  ]) {
    if (actual === null) continue;
    if (serialize(rows) !== actual) {
      problems.push({ code: 'JTBD_OVERLAY_STALE', message: `${rel} differs from a fresh generation from its inputs. Run node scripts/jtbd-gate.js --write and commit the result` });
    }
  }

  // ── 1b. no commercial field reached a published overlay ───────────────────
  //
  // Read from the **committed bytes**, not from the regeneration. The generator cannot emit a
  // commercial field, so checking its output would be checking that a function does what its
  // own code says. What can carry one is a file somebody edited by hand, and that is what is
  // opened here.
  for (const [rel, text] of [[PATHS.coverageOverlay, world.coverageText], [PATHS.roadmapOverlay, world.roadmapText]]) {
    for (const line of String(text ?? '').split('\n')) {
      if (!line.trim()) continue;
      let published;
      try {
        published = JSON.parse(line);
      } catch {
        continue; // a malformed overlay is already JTBD_OVERLAY_STALE above
      }
      for (const field of PRIVATE_CATALOG_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(published, field)) {
          problems.push({
            code: 'JTBD_PRIVATE_FIELD_PUBLISHED',
            message: `${rel}: ${published.jtbdId} carries "${field}", which is commercial judgement `
              + '(docs/editions/REPOSITORY_BOUNDARY.md §3) and stays out of a public overlay',
          });
        }
      }
    }
  }

  // ── 2. coverage vocabulary, evidence and its freshness ────────────────────
  const factIds = new Set((truth?.facts ?? []).map((fact) => fact.id));
  const covered = new Set();
  for (const row of built.coverage) {
    covered.add(row.jtbdId);
    if (!COVERAGE_STATUSES.includes(row.coverageStatus)) {
      problems.push({ code: 'JTBD_COVERAGE_STATUS_UNKNOWN', message: `${row.jtbdId}: "${row.coverageStatus}" is not one of the four statuses in docs/QUALITY_GATES.md §3` });
    }
    if (row.coverageStatus === 'not supported') continue;

    // Every positive status is a claim. Each of the next four rules refuses a way a claim
    // has been made in this repository before without anything failing.
    if (!row.evidence.length) {
      problems.push({ code: 'JTBD_EVIDENCE_MISSING', message: `${row.jtbdId} is "${row.coverageStatus}" and cites no evidence` });
      continue;
    }
    if (!row.limitations.length) {
      problems.push({ code: 'JTBD_EVIDENCE_LIMITATION_ABSENT', message: `${row.jtbdId} is "${row.coverageStatus}" and names no residual limitation. A positive status without a named gap is the inflation this gate exists to refuse` });
    }
    if (!row.evidence.some((item) => EXECUTABLE_EVIDENCE_KINDS.includes(item.kind))) {
      problems.push({ code: 'JTBD_EVIDENCE_NOT_EXECUTABLE', message: `${row.jtbdId} rests only on ${row.evidence.map((i) => i.kind).join('/')}. A file, a module name or a document locates evidence; it does not promote a status` });
    }
    if (!row.verifiedAtSha) {
      problems.push({ code: 'JTBD_EVIDENCE_MISSING', message: `${row.jtbdId} is "${row.coverageStatus}" and records no verifiedAtSha` });
    }
    // **The production-ready-adjacent rule.** Every canonical record's non-functional
    // requirements name tenant isolation, least privilege and an immutable audit trail, and
    // this framework authenticates nobody. So the strongest status may not be claimed without
    // saying, by fact id, where the row stands against the Production Spine. It fires on no
    // row today because no row reaches `validated end to end` — which is the point of writing
    // it now rather than the first time one does.
    if (row.coverageStatus === 'validated end to end' && !row.factIds.some((id) => id.startsWith('spine.'))) {
      problems.push({
        code: 'JTBD_SPINE_EVIDENCE_ABSENT',
        message: `${row.jtbdId} claims "validated end to end" and cites no spine.* Repository Truth fact. `
          + 'Every canonical job requires tenant isolation, least privilege and an audit trail, and this '
          + 'framework ships no identity verifier — a row at the top status states where it stands on that',
      });
    }
    for (const factId of row.factIds) {
      if (!factIds.has(factId)) {
        problems.push({ code: 'JTBD_FACT_UNKNOWN', message: `${row.jtbdId} cites Repository Truth fact "${factId}", which docs/repository-truth.json does not publish` });
      }
    }
    for (const item of row.evidence) {
      if (!EVIDENCE_KINDS.includes(item.kind)) {
        problems.push({ code: 'JTBD_EVIDENCE_NOT_EXECUTABLE', message: `${row.jtbdId}: evidence kind "${item.kind}" is outside the closed set` });
        continue;
      }
      const digest = digests.get(item.path);
      if (digest === undefined) {
        problems.push({ code: 'JTBD_EVIDENCE_MISSING', message: `${row.jtbdId} cites ${item.path}, which does not exist in this checkout` });
        continue;
      }
      // **This is the stale-`verifiedAtSha` rule, and it is exact rather than approximate.**
      // A commit id alone cannot say whether the evidence still supports the claim: the sha
      // is a label, and a shallow clone cannot even resolve it. What the assessment records
      // instead is the content digest of every file it read *at* `verifiedAtSha`. When the
      // evidence moves, the recorded assessment is describing a tree that no longer exists,
      // and the row must be re-verified by a person rather than carried forward.
      if (digest !== item.sha256) {
        problems.push({
          code: 'JTBD_EVIDENCE_MOVED',
          message: `${row.jtbdId}: ${item.path} has changed since the assessment was verified at ${row.verifiedAtSha}. `
            + `Recorded ${item.sha256.slice(0, 12)}, found ${digest.slice(0, 12)}. Re-verify the row and run `
            + 'node scripts/jtbd-gate.js --reverify',
        });
      }
    }
  }
  for (const id of catalogIds) {
    if (!covered.has(id)) problems.push({ code: 'JTBD_OVERLAY_INCOMPLETE', message: `${id} has no coverage overlay row` });
  }
  for (const entry of assessments) {
    if (!catalogIds.has(entry.jtbdId)) {
      problems.push({ code: 'JTBD_COVERAGE_NOT_ASSESSED', message: `assessments.json names ${entry.jtbdId}, which is not a catalogue id` });
    }
    if (!POSITIVE_STATUSES.includes(entry.coverageStatus)) {
      problems.push({ code: 'JTBD_COVERAGE_STATUS_UNKNOWN', message: `${entry.jtbdId}: assessments.json may only hold a positive status, not "${entry.coverageStatus}"` });
    }
  }

  // ── 3. ownership resolves, exactly once, and nothing is orphaned ──────────
  const assignmentIds = new Set();
  for (const assignment of world.assignments ?? []) {
    if (assignmentIds.has(assignment.jtbdId) || !catalogIds.has(assignment.jtbdId)) {
      problems.push({ code: 'JTBD_ROADMAP_RESOLUTION_UNKNOWN', message: `${assignment.jtbdId}: duplicate or unknown roadmap assignment` });
    }
    assignmentIds.add(assignment.jtbdId);
    const registeredPillar = world.pillars?.pillars?.[assignment.pillar];
    if (!registeredPillar) {
      problems.push({ code: 'JTBD_ROADMAP_RESOLUTION_UNKNOWN', message: `${assignment.jtbdId}: assignment names unknown pillar "${assignment.pillar}"` });
    } else {
      if (assignment.edition !== registeredPillar.edition) {
        problems.push({ code: 'JTBD_ROADMAP_RESOLUTION_UNKNOWN', message: `${assignment.jtbdId}: assignment edition "${assignment.edition}" disagrees with pillar "${assignment.pillar}" (${registeredPillar.edition})` });
      }
      if (assignment.roadmapTrack !== registeredPillar.roadmapTrack) {
        problems.push({ code: 'JTBD_ROADMAP_RESOLUTION_UNKNOWN', message: `${assignment.jtbdId}: assignment roadmapTrack disagrees with pillar "${assignment.pillar}"` });
      }
    }
    const required = ['disposition', 'pillar', 'edition', 'roadmapTrack', 'milestoneOrEpic', 'dependencies'];
    for (const field of required) if (assignment[field] === undefined || assignment[field] === null || assignment[field] === '') {
      problems.push({ code: 'JTBD_ROADMAP_ORPHAN', message: `${assignment.jtbdId}: assignment lacks ${field}` });
    }
    if (!Array.isArray(assignment.dependencies)) {
      problems.push({ code: 'JTBD_ROADMAP_RESOLUTION_UNKNOWN', message: `${assignment.jtbdId}: dependencies must be an array of registered pillar ids` });
    } else {
      const seenDependencies = new Set();
      for (const dependency of assignment.dependencies) {
        if (typeof dependency !== 'string' || !world.pillars?.pillars?.[dependency]) {
          problems.push({ code: 'JTBD_ROADMAP_RESOLUTION_UNKNOWN', message: `${assignment.jtbdId}: dependency "${dependency}" is not a registered pillar id` });
        } else if (seenDependencies.has(dependency)) {
          problems.push({ code: 'JTBD_ROADMAP_RESOLUTION_UNKNOWN', message: `${assignment.jtbdId}: dependency "${dependency}" is duplicated` });
        }
        seenDependencies.add(dependency);
      }
    }
    if (['deferred', 'out of scope'].includes(assignment.disposition) && !assignment.deferredReason) {
      problems.push({ code: 'JTBD_ROADMAP_ORPHAN', message: `${assignment.jtbdId}: ${assignment.disposition} requires a reason` });
    }
    for (const privateField of [...PRIVATE_CATALOG_FIELDS, 'priority', 'businessValue', 'competitiveRationale', 'commercialSequence']) {
      if (Object.prototype.hasOwnProperty.call(assignment, privateField)) {
        problems.push({ code: 'JTBD_PRIVATE_FIELD_PUBLISHED', message: `${assignment.jtbdId}: public roadmap assignment carries ${privateField}` });
      }
    }
  }
  for (const id of catalogIds) if (!assignmentIds.has(id)) {
    problems.push({ code: 'JTBD_ROADMAP_ORPHAN', message: `${id}: no explicit roadmap disposition` });
  }

  const coverageById = new Map(built.coverage.map((row) => [row.jtbdId, row]));
  let unassigned = 0;
  for (const row of built.roadmap) {
    if (!OWNERSHIP_RESOLUTIONS.includes(row.ownershipResolution) || !OWNER_STATUSES.includes(row.ownerStatus)) {
      problems.push({ code: 'JTBD_ROADMAP_RESOLUTION_UNKNOWN', message: `${row.jtbdId}: ${row.ownershipResolution} / ${row.ownerStatus} is outside the closed vocabularies` });
    }
    // The number that matters for D6, and the one the summary fact publishes: how many
    // desired jobs **no milestone claims**. `unassigned_gap` below counts the narrower case
    // where no pillar owns any part of the job at all.
    if (row.ownerStatus === 'unassigned') unassigned += 1;
    const status = coverageById.get(row.jtbdId)?.coverageStatus;
    // D6: a job that is not supported or only partly supported must have somewhere to go —
    // a milestone, or an explicit statement that nobody is going there.
    const parked = ['deferred', 'unassigned', 'out of scope'].includes(row.ownerStatus);
    if ((status === 'not supported' || status === 'partially supported') && !row.milestone && !parked) {
      problems.push({ code: 'JTBD_ROADMAP_ORPHAN', message: `${row.jtbdId} is "${status}" with no milestone and no explicit deferred/unassigned/out-of-scope status` });
    }
  }

  // ── 4. the crosswalk cites real ids and does not drift from the matrix ────
  let unmapped = 0;
  const matrixIds = new Set([
    ...[...String(matrixText ?? '').matchAll(/^\|\s*(JTBD-[^|\s]+)\s*\|/gm)].map((match) => match[1]),
    ...[...String(matrixText ?? '').matchAll(/^#{2,}\s+(JTBD-[^\s—]+)/gm)].map((match) => match[1]),
  ]);
  for (const match of String(matrixText ?? '').matchAll(/(?:JTBD-)?([A-Z]+)-(\d+)…(?:JTBD-)?\1-(\d+)/g)) {
    const [, prefix, start, end] = match;
    for (let number = Number(start); number <= Number(end); number += 1) {
      matrixIds.add(`JTBD-${prefix}-${String(number).padStart(start.length, '0')}`);
    }
  }
  const matrixRows = new Map();
  for (const match of String(matrixText ?? '').matchAll(/^\|\s*(JTBD-[^|\s]+)\s*\|[^|]*\|\s*\*\*(.+?)\*\*\s*\|/gm)) {
    matrixRows.set(match[1], match[2]);
  }
  const crosswalkIds = new Set();
  for (const row of crosswalk.rows) {
    if (crosswalkIds.has(row.matrixId)) {
      problems.push({ code: 'JTBD_CROSSWALK_ID_UNKNOWN', message: `${row.matrixId} has more than one crosswalk disposition` });
    }
    crosswalkIds.add(row.matrixId);
    if (!matrixIds.has(row.matrixId)) {
      problems.push({ code: 'JTBD_CROSSWALK_ID_UNKNOWN', message: `${row.matrixId} exists in the crosswalk but not in ${PATHS.matrix}` });
    }
    if (!CROSSWALK_DISPOSITIONS.includes(row.disposition)) {
      problems.push({ code: 'JTBD_CROSSWALK_ID_UNKNOWN', message: `${row.matrixId}: disposition "${row.disposition}" is outside the closed set` });
    }
    for (const id of row.canonicalJtbdIds) {
      if (!catalogIds.has(id)) problems.push({ code: 'JTBD_CROSSWALK_ID_UNKNOWN', message: `${row.matrixId} cites ${id}, which is not a catalogue id` });
    }
    if (row.matrixStatus !== 'not supported') {
      if (!row.canonicalJtbdIds.length) {
        unmapped += 1;
        // The v1 rule, and the one place it bends: a non-default row must cite canonical
        // ids **or** say in writing why none exists. Bending it to "must cite" outright
        // would force a mapping to be invented, which is the failure mode this whole gate
        // is against. A silent omission still fails.
        if (!row.unmappedReason) {
          problems.push({ code: 'JTBD_CROSSWALK_UNCITED', message: `${row.matrixId} is "${row.matrixStatus}" and cites no canonical JTBD id and gives no unmappedReason` });
        }
      }
    }
    // The matrix table rows publish their own status. When the two disagree, the crosswalk
    // has gone stale behind a document that moved — the exact drift ADR-039 was written for,
    // one layer out.
    const declared = matrixRows.get(row.matrixId);
    if (declared && declared !== row.matrixStatus) {
      problems.push({ code: 'JTBD_CROSSWALK_STATUS_DRIFT', message: `${row.matrixId}: the matrix says "${declared}", the crosswalk says "${row.matrixStatus}"` });
    }
  }

  for (const matrixId of matrixIds) {
    if (!crosswalkIds.has(matrixId)) {
      problems.push({ code: 'JTBD_CROSSWALK_UNCITED', message: `${matrixId} exists in the matrix but has no crosswalk disposition` });
    }
  }

  // ── 5. every artefact is classified public or private ────────────────────
  const classified = new Set(Object.keys(classification?.artefacts ?? {}));
  for (const rel of Object.values(PATHS)) {
    if (!rel.startsWith('docs/jtbd/')) continue;
    if (!classified.has(rel)) {
      problems.push({ code: 'JTBD_ARTEFACT_UNCLASSIFIED', message: `${rel} carries no public/private classification in ${PATHS.classification}` });
    }
  }

  const positive = built.coverage.filter((row) => row.coverageStatus !== 'not supported');
  const summary = {
    recordCount: records.length,
    uniqueIds: catalogIds.size,
    overlayComplete: covered.size === catalogIds.size && built.coverage.length === records.length,
    positiveCoverageRows: positive.length,
    positiveCoverageWithoutEvidence: positive.filter((row) => !row.evidence.length).length,
    roadmapUnassigned: unassigned,
    ownershipUnassignedGap: built.roadmap.filter((row) => row.ownershipResolution === 'unassigned_gap').length,
    majorityUnownedCapabilities: built.roadmap.filter((row) => row.unownedCoreCapabilities * 2 > row.coreCapabilities).length,
    pillarsWithNoDesiredJob: Object.keys(world.pillars.pillars).filter((pillar) => !built.roadmap.some((row) => row.pillar === pillar)),
    crosswalkRows: crosswalk.rows.length,
    crosswalkUnmapped: unmapped,
    coverageDistribution: Object.fromEntries(COVERAGE_STATUSES.map((status) => [status, built.coverage.filter((r) => r.coverageStatus === status).length])),
    ownershipDistribution: Object.fromEntries(OWNERSHIP_RESOLUTIONS.map((r) => [r, built.roadmap.filter((row) => row.ownershipResolution === r).length])),
  };
  return { problems, summary, built };
}

/** Load everything the checker needs. Digests are taken once, for every cited path. */
export async function loadWorld(rootDir = ROOT) {
  const problems = [];
  const { records, problems: catalogProblems } = await readCatalogSpine(rootDir);
  problems.push(...catalogProblems);
  const assessmentsDoc = readJson(rootDir, PATHS.assessments, problems);
  const crosswalk = readJson(rootDir, PATHS.crosswalk, problems);
  const capabilityPillarsDoc = readJson(rootDir, PATHS.capabilityPillars, problems);
  const pillars = readJson(rootDir, PATHS.pillars, problems);
  const truth = readJson(rootDir, PATHS.truth, problems);
  const classification = readJson(rootDir, PATHS.classification, problems);
  const assignments = readJsonl(rootDir, PATHS.assignments, problems);
  const overrideReviews = readJson(rootDir, PATHS.overrideReviews, problems) ?? { reviews: [] };
  const reviewEvidenceKeys = new Set((overrideReviews.reviews ?? [])
    .filter((review) => typeof review.evidencePath === 'string'
      && typeof review.reviewId === 'string'
      && existsSync(join(rootDir, review.evidencePath))
      && readFileSync(join(rootDir, review.evidencePath), 'utf8').includes(review.reviewId))
    .map((review) => `${review.reviewId}\0${review.evidencePath}`));
  const assessments = assessmentsDoc?.assessments ?? [];
  const digests = new Map();
  for (const entry of assessments) {
    for (const item of entry.evidence ?? []) {
      if (digests.has(item.path)) continue;
      const file = join(rootDir, item.path);
      if (existsSync(file)) digests.set(item.path, sha256(readFileSync(file, 'utf8')));
    }
  }
  return {
    rootDir,
    records,
    assessments,
    crosswalk: crosswalk ?? { rows: [] },
    capabilityPillars: capabilityPillarsDoc?.capabilityPillars ?? {},
    pillars: pillars ?? { precedence: [], pillars: {} },
    truth,
    classification,
    assignments,
    overrideReviews,
    reviewEvidenceKeys,
    matrixText: existsSync(join(rootDir, PATHS.matrix)) ? readFileSync(join(rootDir, PATHS.matrix), 'utf8') : '',
    coverageText: readOverlay(rootDir, PATHS.coverageOverlay, problems),
    roadmapText: readOverlay(rootDir, PATHS.roadmapOverlay, problems),
    digests,
    problems,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const world = await loadWorld(ROOT);

  if (argv.includes('--reverify')) {
    // A deliberate human action: re-stamp what each assessment reads, at HEAD. Kept apart
    // from `--write` so that regenerating an overlay can never bless evidence that moved.
    const doc = JSON.parse(readFileSync(join(ROOT, PATHS.assessments), 'utf8'));
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
    for (const entry of doc.assessments) {
      for (const item of entry.evidence) {
        const dirty = execFileSync('git', ['status', '--porcelain', '--', item.path], { cwd: ROOT, encoding: 'utf8' }).trim();
        if (dirty) throw new Error(`${item.path} has uncommitted changes; commit it before --reverify`);
        const committed = execFileSync('git', ['show', `HEAD:${item.path}`], { cwd: ROOT, encoding: 'utf8' });
        item.sha256 = sha256(committed);
      }
      entry.verifiedAtSha = head;
    }
    writeFileSync(join(ROOT, PATHS.assessments), `${JSON.stringify(doc, null, 1)}\n`);
    console.log(`re-stamped evidence digests for ${doc.assessments.length} assessments`);
    return;
  }

  if (argv.includes('--write')) {
    const built = buildOverlays(world);
    if (built.problems.length || world.problems.length) {
      for (const problem of [...world.problems, ...built.problems]) console.error(`${problem.code}: ${problem.message}`);
      process.exitCode = 1;
      return;
    }
    writeFileSync(join(ROOT, PATHS.coverageOverlay), serialize(built.coverage));
    writeFileSync(join(ROOT, PATHS.roadmapOverlay), serialize(built.roadmap));
    console.log(`wrote ${built.coverage.length} coverage rows and ${built.roadmap.length} roadmap rows`);
    return;
  }

  const { problems, summary } = checkWorld(world);
  if (argv.includes('--json')) console.log(JSON.stringify({ ok: problems.length === 0, summary, problems }, null, 2));
  else {
    for (const problem of problems) console.error(`${problem.code}: ${problem.message}`);
    console.log(problems.length ? `\nJTBD gate FAILED with ${problems.length} problem(s).` : 'JTBD gate OK.');
    console.log(`  catalogue ${summary.recordCount} records · coverage overlay complete: ${summary.overlayComplete}`);
    console.log(`  positive coverage rows: ${summary.positiveCoverageRows} (without evidence: ${summary.positiveCoverageWithoutEvidence})`);
    console.log(`  roadmap unassigned: ${summary.roadmapUnassigned} · crosswalk rows ${summary.crosswalkRows}, unmapped ${summary.crosswalkUnmapped}`);
  }
  if (problems.length) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
