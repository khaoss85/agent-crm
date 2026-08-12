// @ts-check

import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import {
  MAX_PLAN_BYTES, bindSolutionPlan, canonicalJson, fingerprintPlan, inspectionFingerprint,
  parseSolutionPlan, planRequirements, validateSolutionPlan,
} from '../../core/src/solution-plan.js';
import {
  COMPOSITION_OBSERVATION_KINDS, EVIDENCE_LIMITATIONS, MAX_EVIDENCE_BYTES,
  RUNTIME_OBSERVATION_KINDS, SUFFICIENCY, effectiveRequirementCategory,
  implementationEvidenceVocabulary,
  parseImplementationEvidence, validateImplementationEvidence,
} from '../../core/src/implementation-evidence.js';
import { inspectApplicationCommand } from './app-inspect-command.js';
import { projectVerifyCommand, defaultGit, sampled, worktreeState } from './project-verify-command.js';
import { scenarioRunCommand } from './scenario-run-command.js';

/**
 * `crm solution verify <plan.json> --evidence <evidence.json> [--json]` — DX10.
 *
 * > **For every requirement in this checked-in SolutionPlan, what implementation
 * > evidence proves it is implemented, partial or blocked — and what is still
 * > unproven?**
 *
 * It closes the last hop of the rail story, and it is the one rung that keeps
 * every other rung honest:
 *
 * ```text
 * crm app inspect       what is composed?                         source facts
 * crm solution check    is this plan valid, and still true?       a document
 * crm project verify    can we PROVE the project is healthy?      project health
 * crm scenario run      which business jobs does it earn?         claimed rows
 * crm solution verify   does this evidence satisfy this plan?     this
 * ```
 *
 * **The distinction from `solution check` is the whole design and is never
 * blurred:** `check` asks whether the *plan* is valid and still true of this
 * application; `verify` asks whether the *implementation* satisfies it. The two
 * verbs sit under one namespace because an agent that has to choose between two
 * commands answering nearly the same question chooses wrong.
 *
 * **It is a reader, not a runtime.** It writes nothing, executes no plan,
 * modifies no source, generates no evidence, promotes no JTBD row and has no
 * `--fix` and no write mode. There is deliberately **one** command rather than
 * one per evidence kind.
 *
 * **The document declares where to look; this decides what is true.** Nothing
 * in `implementationEvidenceContract: 1` can assert an outcome — it has no
 * status field. Every fact in the report comes from an authority that ran in
 * *this* invocation: AX1 once, the plan binding derived from that one report,
 * `project verify` at most once and only when something references it, and each
 * **explicitly referenced** scenario exactly once. No prior report is read and
 * nothing is cached, so a previously verified report cannot be replayed against
 * a checkout that has moved.
 */

export const SOLUTION_VERIFICATION_CONTRACT = 1;

/**
 * Every status a requirement may carry. Closed, and none of them is "warning".
 *
 * Three different things must never share one word, because a reader acts on
 * each of them differently:
 *
 * - `blocked` — **the business requirement is blocked.** An author said so and
 *   gave a reason. It is a statement about the work, and a person decides it.
 * - `unverifiable` — **the verification authority did not run.** `project
 *   verify` produced no receipt, or a cited scenario produced no report. This
 *   says nothing about the work at all: it is a broken machine, and the fix is
 *   to run it again, not to plan anything. It outranks `blocked`, because an
 *   author's downgrade must never be able to stand in front of an
 *   infrastructure failure and answer for it.
 * - a **document** that could not be read or is invalid never reaches a
 *   requirement status at all: it is exit 2 with no report.
 */
export const REQUIREMENT_STATUSES = Object.freeze([
  'verified', 'partial', 'blocked', 'unverifiable', 'unevidenced', 'unverified', 'stale',
]);

/**
 * Marks a child of this command, so a nested `solution verify` recognises that
 * it is running inside one. A verification that verifies itself proves nothing,
 * and the fan-out through `project verify` and two scenarios is not linear.
 */
export const VERIFY_DEPTH_ENV = 'ACCORDO_SOLUTION_VERIFY_DEPTH';

/** How many scenarios one invocation will run. A document naming forty is a denial of service. */
export const MAX_SCENARIO_RUNS = 8;

/** How long a single string taken from a delegate may be in this report. */
export const MAX_REPORT_TEXT = 400;

/**
 * @param {{planPath: string, evidencePath: string, json?: boolean, rootDir?: string,
 *   out?: (text: string) => void, err?: (text: string) => void,
 *   inspect?: Function, verify?: Function, scenario?: Function,
 *   git?: (dir: string) => string|null, env?: Record<string, string|undefined>}} options
 * @returns {Promise<{exitCode: number, report: any}>}
 */
export async function solutionVerifyCommand({
  planPath, evidencePath, json = false, rootDir = process.cwd(),
  out = (text) => process.stdout.write(text),
  err = (text) => process.stderr.write(text),
  inspect = inspectApplicationCommand,
  verify = projectVerifyCommand,
  scenario = scenarioRunCommand,
  git = defaultGit,
  env = process.env,
}) {
  const root = resolve(rootDir);

  // ---- 0. the recursion guard ---------------------------------------------
  if (env?.[VERIFY_DEPTH_ENV] === '1') {
    err('VERIFICATION_RECURSION_REFUSED: this process is already inside a solution verify. '
      + 'Nothing was run, and no report was produced: a verification that verifies itself proves nothing.\n');
    return { exitCode: 2, report: null };
  }
  const childEnv = { ...env, [VERIFY_DEPTH_ENV]: '1' };

  // ---- 1. the two documents, before anything runs --------------------------
  // A document with any problem starts no authority. The refusal costs nothing
  // and happens first.
  const planSource = readDocument(planPath, root, MAX_PLAN_BYTES, err);
  if (planSource === null) return { exitCode: 2, report: null };
  const evidenceSource = readDocument(evidencePath, root, MAX_EVIDENCE_BYTES, err);
  if (evidenceSource === null) return { exitCode: 2, report: null };

  let planInput;
  let evidenceInput;
  try {
    planInput = parseSolutionPlan(planSource.text);
    evidenceInput = parseImplementationEvidence(evidenceSource.text);
  } catch (error) {
    err(`${error instanceof Error ? error.message : String(error)}\n`);
    return { exitCode: 2, report: null };
  }

  const planResult = validateSolutionPlan(planInput);
  const evidenceResult = validateImplementationEvidence(evidenceInput);

  // **An invalid document starts no authority.** It used to be only a document
  // that could not be normalized *at all* that stopped here; one that merely
  // carried an unknown key, an unknown vocabulary term or a reason-less
  // downgrade normalized to something and then ran the whole fan-out against
  // it — up to thirteen minutes of `project verify` spent on a document already
  // known to be invalid, and, worse, a report full of per-requirement statuses
  // that a reader would act on. "The requirement is blocked", "the authority
  // broke" and "the document is invalid" are three different answers, and the
  // third one is not a status a requirement may carry: it is exit 2 and no
  // requirement rows at all.
  if (!planResult.valid || !evidenceResult.valid) {
    const which = !planResult.valid && !evidenceResult.valid ? 'The plan and the evidence document are'
      : !planResult.valid ? 'The plan is' : 'The evidence document is';
    err(`${which} invalid, so nothing was verified and no authority was run.\n`);
    emit({ json, out, report: unreadableReport({ planPath: planSource.relative, evidencePath: evidenceSource.relative,
      problems: [...prefix(planResult.problems, 'PLAN_INVALID'), ...evidenceResult.problems] }) });
    return { exitCode: 2, report: null };
  }
  const plan = planResult.plan;
  const evidence = evidenceResult.evidence;

  /** @type {{code: string, path: string, message: string}[]} */
  const problems = [...evidenceResult.problems];
  for (const problem of planResult.problems) {
    problems.push({ code: 'PLAN_INVALID', path: problem.path, message: `${problem.code}: ${problem.message}` });
  }

  // ---- 2. the worktree, before any authority runs --------------------------
  // DX5's semantics, imported rather than copied. The question is never "is the
  // tree dirty" — after a coding-agent change it always is, and the evidence
  // document itself is routinely an uncommitted file under active work. The
  // question is what *this run* changed, which is a difference between samples.
  const worktreeBefore = worktreeState(root, git);

  const { requirements: planRequirementRows, problems: requirementProblems } = planRequirements(plan);
  for (const problem of requirementProblems) problems.push(problem);
  const byId = new Map(planRequirementRows.map((row) => [row.requirementId, row]));

  // The document must be about the plan it is being verified against. A
  // fingerprint match is not enough on its own: two plans can be identical and
  // an evidence document that names a third file is an author who lost track.
  if (evidence.plan !== '' && evidence.plan !== planSource.relative) {
    problems.push({
      code: 'EVIDENCE_PLAN_MISMATCH', path: 'evidence.plan',
      message: `this document is written about "${evidence.plan}", and it was run against "${planSource.relative}"`,
    });
  }

  const livePlanFingerprint = fingerprintPlan(plan);
  if (evidence.planFingerprint !== '' && evidence.planFingerprint !== livePlanFingerprint) {
    problems.push({
      code: 'EVIDENCE_PLAN_FINGERPRINT_STALE', path: 'evidence.planFingerprint',
      message: `the evidence was recorded against plan ${evidence.planFingerprint.slice(0, 16)}…; this plan is ${livePlanFingerprint.slice(0, 16)}…. The plan changed after the evidence was gathered, so the evidence is about a plan that no longer exists`,
    });
  }

  // ---- 3. AX1, once — and the plan binding derived from that one report ----
  // This *is* `solution check`: the same AX1 report, the same `bindSolutionPlan`.
  // Spawning the command instead would run AX1 twice for one answer.
  const inspected = await inspect({ rootDir: root, json: true, capture: true });
  if (!inspected || inspected.report === null) {
    err('The project could not be inspected, so no evidence could be checked against it.\n');
    return { exitCode: 2, report: null };
  }
  const inspection = inspected.report;
  let liveInspectionFingerprint = null;
  try {
    liveInspectionFingerprint = inspectionFingerprint(inspection);
  } catch {
    liveInspectionFingerprint = null;
  }
  const binding = bindSolutionPlan(plan, inspection);

  // ---- 4. which authorities this document actually references --------------
  const references = evidence.requirements.flatMap((row) => row.evidence);
  const scenarioIds = [...new Set(references
    .filter((ref) => ref.kind === 'scenario.observation' && ref.scenario !== '')
    .map((ref) => ref.scenario))].sort();
  const needsVerify = references.some((ref) => ref.kind === 'project.verification' || ref.kind === 'package.conformance');

  /** @type {any[]} */
  const authorities = [{
    kind: 'application-inspection', authority: 'app-inspect',
    fingerprint: liveInspectionFingerprint, ran: true,
  }];

  /** @type {Map<string, any>} */
  const scenarioReports = new Map();
  if (scenarioIds.length > MAX_SCENARIO_RUNS) {
    problems.push({
      code: 'EVIDENCE_AUTHORITY_UNAVAILABLE', path: 'evidence.requirements',
      message: `this document references ${scenarioIds.length} scenarios; at most ${MAX_SCENARIO_RUNS} are run in one invocation, and each composes a whole application of its own`,
    });
  } else {
    for (const id of scenarioIds) {
      const result = await scenario({ scenarioRef: id, rootDir: root, json: true, out: sink, err: sink, env: childEnv });
      const report = result?.report ?? null;
      scenarioReports.set(id, report);
      authorities.push({
        kind: 'scenario', authority: 'scenario-run', scenario: id,
        fingerprint: report?.fingerprint ?? null,
        status: report?.status ?? null,
        compositionFingerprint: report?.composition?.compositionFingerprint ?? null,
        ran: report !== null,
      });
      if (report === null) {
        problems.push({
          code: 'VERIFICATION_AUTHORITY_FAILED', path: `scenario.${id}`,
          message: `the scenario "${id}" produced no report, so every reference to it is unresolved. Nothing was assumed in its place`,
        });
      }
    }
  }

  let verifyReport = null;
  if (needsVerify) {
    const result = await verify({ rootDir: root, json: true, out: sink, env: childEnv });
    verifyReport = result?.report ?? null;
    authorities.push({
      kind: 'project-verification', authority: 'project-verify',
      fingerprint: verifyReport?.fingerprint ?? null,
      status: verifyReport?.status ?? null,
      ran: verifyReport !== null,
    });
    if (verifyReport === null) {
      problems.push({
        code: 'VERIFICATION_AUTHORITY_FAILED', path: 'project.verify',
        message: 'crm project verify produced no report, so every project-verification and package-conformance reference is unresolved',
      });
    }
  }

  // ---- 5. which composition this plan is bound to, and who answered --------
  const bound = resolveBinding({ plan, liveInspectionFingerprint, scenarioReports, binding });
  if (bound.via === null) {
    problems.push({
      code: 'PLAN_NOT_CURRENT', path: 'plan.application.inspectionFingerprint',
      message: `the plan was written against composition ${short(plan.application.inspectionFingerprint)}, and no authority in this run produced it: this project is ${short(liveInspectionFingerprint)}${scenarioIds.length > 0 ? `, and the referenced scenario(s) composed ${scenarioIds.map((id) => short(scenarioReports.get(id)?.composition?.compositionFingerprint ?? null)).join(', ')}` : ''}. Evidence about a plan whose premises have moved is evidence about a different plan`,
    });
  } else if (bound.via === 'project' && binding.problems.length > 0) {
    for (const problem of binding.problems) {
      problems.push({ code: 'PLAN_NOT_CURRENT', path: problem.path, message: `${problem.code}: ${problem.message}` });
    }
  }
  if (evidence.applicationInspectionFingerprint !== ''
    && evidence.applicationInspectionFingerprint !== plan.application.inspectionFingerprint) {
    problems.push({
      code: 'EVIDENCE_INSPECTION_STALE', path: 'evidence.applicationInspectionFingerprint',
      message: `the evidence was gathered against composition ${short(evidence.applicationInspectionFingerprint)}; the plan targets ${short(plan.application.inspectionFingerprint)}. Evidence about a different application is not evidence about this plan`,
    });
  }

  // Anything above means no requirement can be *proven* in this run.
  const staleCodes = ['PLAN_NOT_CURRENT', 'PLAN_INVALID', 'EVIDENCE_PLAN_FINGERPRINT_STALE',
    'EVIDENCE_INSPECTION_STALE', 'EVIDENCE_PLAN_MISMATCH'];
  const stale = problems.some((problem) => staleCodes.includes(problem.code));

  // ---- 6. every requirement the plan has, evidenced or not -----------------
  const declared = new Map(evidence.requirements.map((row) => [row.requirementId, row]));
  for (const row of evidence.requirements) {
    if (!byId.has(row.requirementId)) {
      problems.push({
        code: 'EVIDENCE_REQUIREMENT_UNKNOWN', path: `evidence.requirements.${row.requirementId}`,
        message: `"${row.requirementId}" is not a requirement this plan derives. Run \`solution check\` with --json and read \`requirements\``,
      });
    }
  }

  const graded = planRequirementRows.map((requirement) => grade({
    requirement,
    declaration: declared.get(requirement.requirementId) ?? null,
    stale,
    bound,
    inspection,
    verifyReport,
    scenarioReports,
    root,
    problems,
  }));

  // ---- 7. the worktree this command promised not to change -----------------
  const worktree = compareWorktree(worktreeBefore, worktreeState(root, git), problems);

  const counts = tally(graded.map((row) => row.status));
  const status = counts.verified === graded.length && graded.length > 0 && problems.length === 0
    ? 'verified' : 'incomplete';

  const report = {
    solutionVerificationContract: SOLUTION_VERIFICATION_CONTRACT,
    command: 'solution:verify',
    plan: {
      path: planSource.relative,
      goal: plan.goal.id,
      revision: plan.revision,
      fingerprint: livePlanFingerprint,
      inspectionFingerprint: plan.application.inspectionFingerprint,
    },
    evidence: {
      path: evidenceSource.relative,
      implementationEvidenceContract: evidence.implementationEvidenceContract,
      fingerprint: evidence.fingerprint,
    },
    status,
    counts,
    binding: {
      // Which authority produced the composition the plan pins, and how. A plan
      // written against a *project* composition cannot bind to a framework
      // repository that composes no domain package — the only authority that
      // produces that composition is the scenario which composes it.
      boundTo: bound.via,
      compositionFingerprint: bound.fingerprint,
      projectInspectionFingerprint: liveInspectionFingerprint,
      planIsCurrent: bound.via === 'project' && binding.problems.length === 0,
    },
    requirements: graded,
    unproven: graded.filter((row) => row.status !== 'verified')
      .map((row) => ({ requirementId: row.requirementId, status: row.status, reason: row.reason })),
    authorities,
    worktree,
    promotion: {
      performed: false,
      authority: 'human',
      rule: 'this command reports evidence. It writes no plan, no status, no JTBD row and no source, and it has no write mode',
      wrote: [],
    },
    problems: [...problems].sort((a, b) => (a.code === b.code
      ? (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
      : (a.code < b.code ? -1 : 1))),
    limitations: limitationsFor({ evidence, bound, graded }),
    fingerprint: '',
  };
  report.fingerprint = semanticFingerprint(report);

  emit({ json, out, report });
  return { exitCode: status === 'verified' ? 0 : 1, report };
}

/** stdout belongs to this command's report; a delegate's belongs nowhere. */
function sink() { /* deliberately silent */ }

/** @param {string|null} value */
function short(value) {
  return value === null || value === '' ? '(none)' : `${value.slice(0, 16)}…`;
}

function prefix(problems, code) {
  return problems.map((problem) => ({ code, path: problem.path, message: `${problem.code}: ${problem.message}` }));
}

/**
 * A document read from a bounded file that stays inside the project.
 *
 * "Inside the project" is decided on the **canonical** path, not the written
 * one: a lexical check cannot see a symlink, and `docs/x.json` can be a
 * well-formed relative path that reads somewhere else entirely (ADR-026).
 */
function readDocument(path, root, maxBytes, err) {
  if (typeof path !== 'string' || path.trim() === '') {
    err('Usage: crm solution verify <plan.json> --evidence <evidence.json>\n');
    return null;
  }
  const absolute = isAbsolute(path) ? path : resolve(root, path);
  let real;
  try {
    real = realpathSync(absolute);
  } catch {
    err(`No such file: ${path}\n`);
    return null;
  }
  const rootReal = (() => { try { return realpathSync(root); } catch { return root; } })();
  const inside = relative(rootReal, real);
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
    err(`Refused: ${path} resolves outside the project.\n`);
    return null;
  }
  const stat = statSync(real, { throwIfNoEntry: false });
  if (!stat || !stat.isFile()) {
    err(`Not a file: ${path}\n`);
    return null;
  }
  if (stat.size > maxBytes) {
    err(`${path} is ${stat.size} bytes; the bound is ${maxBytes}.\n`);
    return null;
  }
  return { text: readFileSync(real, 'utf8'), relative: inside.split(sep).join('/') };
}

/**
 * Which authority in this run produced the composition the plan pins.
 *
 * AX2's `inspectionFingerprint` names the **application** a plan was written
 * against. In a project that is the project. In a *framework* repository — one
 * whose root composes no domain package at all — the application a plan
 * describes is the one a starter composes, and the only authority that produces
 * that digest is DX6, which publishes it as `composition.compositionFingerprint`.
 *
 * So the binding is resolved against the authorities that actually ran, and the
 * report names which one answered. It is derived, never declared: an evidence
 * document cannot nominate a composition, only reference a scenario that
 * composes one.
 */
function resolveBinding({ plan, liveInspectionFingerprint, scenarioReports }) {
  const pinned = plan.application.inspectionFingerprint;
  if (pinned === '') return { via: null, fingerprint: null };
  if (pinned === liveInspectionFingerprint) return { via: 'project', fingerprint: pinned };
  const matches = [...scenarioReports.entries()]
    .filter(([, report]) => report?.composition?.compositionFingerprint === pinned)
    .map(([id]) => id)
    .sort();
  if (matches.length === 1) return { via: `scenario:${matches[0]}`, fingerprint: pinned };
  return { via: null, fingerprint: null };
}

/**
 * One requirement, graded from the evidence that resolved — never from
 * anything the document asserted.
 */
function grade({ requirement, declaration, stale, bound, inspection, verifyReport, scenarioReports, root, problems }) {
  const base = {
    requirementId: requirement.requirementId,
    kind: requirement.kind,
    statement: bound_(requirement.statement),
    category: declaration?.category ?? null,
    enforcedCategory: null,
    status: 'unevidenced',
    reason: '',
    // An author's downgrade, kept as context whatever the status turns out to
    // be. When an authority failed, the status is about the machine and this is
    // the only place the author's claim survives — unread as a verdict.
    declaredDowngrade: null,
    evidence: [],
  };

  if (declaration === null) {
    problems.push({
      code: 'EVIDENCE_REQUIREMENT_MISSING', path: `plan.${requirement.requirementId}`,
      message: `this plan requires "${requirement.requirementId}" and the evidence document says nothing about it. A requirement nobody wrote evidence for is not a requirement nobody has`,
    });
    return { ...base, status: stale ? 'stale' : 'unevidenced', reason: 'the evidence document does not mention this requirement' };
  }

  // What the requirement is graded as. The plan decides the floor; the evidence
  // author may only raise it, or downgrade the result by declaring `manual`.
  // Grading the weaker claim while merely *reporting* the violation would let
  // the label decide the outcome, which is the one thing a category must never
  // do — so the enforced category is what the sufficiency rule is applied
  // against, and both categories are published side by side.
  const category = effectiveRequirementCategory({
    declared: declaration.category === '' ? null : declaration.category,
    kind: requirement.kind,
    decisionType: requirement.decisionType,
  });
  const effective = category.enforced;
  if (category.floored) {
    problems.push({
      code: 'EVIDENCE_CATEGORY_BELOW_FLOOR', path: `evidence.requirements.${requirement.requirementId}.category`,
      message: category.reason,
    });
  }

  const resolved = declaration.evidence.map((ref) => resolveReference({
    ref, bound, inspection, verifyReport, scenarioReports, root, requirementId: requirement.requirementId, problems,
  }));
  const declaredDowngrade = declaration.blocked !== null
    ? { kind: 'blocked', reason: bound_(declaration.blocked.reason) }
    : declaration.partial !== null
      ? { kind: 'partial', reason: bound_(declaration.partial.reason) }
      : null;
  const row = { ...base, enforcedCategory: effective, declaredDowngrade, evidence: resolved };

  if (stale) {
    return { ...row, status: 'stale', reason: 'the plan, its composition or its fingerprint moved after this evidence was gathered' };
  }

  // An authority that did not run outranks everything an author wrote. Grading
  // this `blocked` would answer "why is this not proven?" with the author's
  // business reason when the true answer is that the machine did not run — and
  // that is the one substitution this report must never make. The author's
  // downgrade is kept beside it as context, not as the verdict.
  const unavailable = resolved.filter((entry) => entry.problem === 'EVIDENCE_AUTHORITY_UNAVAILABLE');
  if (unavailable.length > 0) {
    return {
      ...row,
      status: 'unverifiable',
      reason: `an authority this requirement depends on did not run in this invocation: ${unavailable.map((entry) => entry.kind).sort().join(', ')}. Nothing here is a statement about the work${declaredDowngrade ? `, including the "${declaredDowngrade.kind}" the document declares` : ''}`,
    };
  }

  if (declaration.blocked !== null) {
    return { ...row, status: 'blocked', reason: bound_(declaration.blocked.reason) };
  }
  if (effective === 'manual') {
    const hasManual = resolved.some((entry) => entry.kind === 'manual');
    return hasManual
      ? { ...row, status: 'unverified', reason: 'manual evidence only; nothing here proves it, and it is recorded so the gap is stated rather than omitted' }
      : { ...row, status: 'unevidenced', reason: 'declared manual and carries no manual evidence' };
  }
  if (resolved.length === 0) {
    return { ...row, status: 'unevidenced', reason: 'no evidence is recorded for this requirement' };
  }

  // A manual reference is **recorded, never resolved** — calling a human's word
  // resolved is the promotion this rung refuses. So it is not counted as a
  // reference that failed either: an author who adds a manual note beside real
  // machine evidence has added context, not a fault, and the sufficiency rule
  // below is what decides whether the machine evidence was enough.
  const unresolved = resolved.filter((entry) => !entry.resolved && entry.kind !== 'manual');
  if (unresolved.length > 0) {
    return {
      ...row,
      status: 'unevidenced',
      reason: `${unresolved.length} of ${resolved.length} reference(s) did not resolve: ${unresolved.map((entry) => entry.problem).sort().join(', ')}`,
    };
  }

  const sufficiency = sufficient({ category: effective, resolved, scenarioReports });
  if (!sufficiency.ok) {
    problems.push({
      code: sufficiency.code, path: `evidence.requirements.${requirement.requirementId}.evidence`,
      message: sufficiency.message,
    });
    return { ...row, status: 'unevidenced', reason: sufficiency.message };
  }

  if (declaration.partial !== null) {
    return { ...row, status: 'partial', reason: bound_(declaration.partial.reason) };
  }
  return { ...row, status: 'verified', reason: '' };
}

/**
 * The sufficiency matrix, applied. The **kind** of a scenario observation is
 * read from DX6's report, never from the document, which is what stops an
 * author relabelling "the action is declared" as "the application does this".
 */
function sufficient({ category, resolved, scenarioReports }) {
  const rule = SUFFICIENCY[category];
  if (!rule) {
    return { ok: false, code: 'EVIDENCE_VOCABULARY_UNKNOWN', message: `"${category}" is not a requirement category` };
  }
  const kinds = new Set();
  for (const entry of resolved) {
    if (entry.kind !== 'scenario.observation') {
      kinds.add(entry.kind);
      continue;
    }
    const observed = observationOf(entry, scenarioReports);
    if (observed === null) continue;
    if (RUNTIME_OBSERVATION_KINDS.includes(observed.kind)) kinds.add('scenario.observation:runtime');
    if (COMPOSITION_OBSERVATION_KINDS.includes(observed.kind)) kinds.add('scenario.observation:composition');
  }
  if (rule.satisfiedBy.some((accepted) => kinds.has(accepted))) return { ok: true };

  // A requirement carrying nothing but source artifacts is the single most
  // common way "the file exists" gets read as "the work is done", so it has its
  // own code rather than sharing the generic one.
  const onlySource = kinds.size > 0 && [...kinds].every((kind) => kind === 'source.artifact');
  return {
    ok: false,
    code: onlySource ? 'EVIDENCE_STRUCTURAL_ONLY' : 'EVIDENCE_INSUFFICIENT_FOR_CATEGORY',
    message: onlySource
      ? `a "${category}" requirement evidenced only by source artifacts is "the file exists, therefore it is done". ${rule.insufficient}`
      : `a "${category}" requirement is satisfied by ${rule.satisfiedBy.join(' or ') || 'nothing in this contract'}; this one carries ${[...kinds].sort().join(', ') || 'nothing'}. ${rule.insufficient}`,
  };
}

/** The DX6 observation a reference points at, or null. */
function observationOf(entry, scenarioReports) {
  const report = scenarioReports.get(entry.scenario) ?? null;
  if (report === null) return null;
  return (report.observations ?? []).find((row) => row.code === entry.observation) ?? null;
}

/**
 * One evidence reference against the authority that owns it. Every branch fails
 * closed: an authority that did not run, a fact that is absent, a check that is
 * not in the receipt and an observation whose meaning moved are each a refusal,
 * never a pass by having nothing to check.
 */
function resolveReference({ ref, bound, inspection, verifyReport, scenarioReports, root, requirementId, problems }) {
  const base = { ...ref, resolved: false, problem: null, actual: null };
  const fail = (code, actual, message) => {
    problems.push({ code, path: `evidence.requirements.${requirementId}.evidence`, message });
    return { ...base, resolved: false, problem: code, actual: bound_(actual) };
  };
  const pass = (actual) => ({ ...base, resolved: true, problem: null, actual: bound_(actual) });

  switch (ref.kind) {
    case 'manual':
      // Recorded, never resolved. `resolved` is reserved for a machine fact, and
      // calling a human's word resolved is the promotion this rung refuses.
      return { ...base, resolved: false, problem: null, actual: 'recorded, not verified' };

    case 'source.artifact': {
      const absolute = resolve(root, ref.path);
      const rootReal = (() => { try { return realpathSync(root); } catch { return root; } })();
      let real;
      try {
        real = realpathSync(absolute);
      } catch {
        return fail('EVIDENCE_SOURCE_ABSENT', 'absent', `${ref.path} is not in this project, so its hash evidences nothing`);
      }
      const inside = relative(rootReal, real);
      if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
        return fail('EVIDENCE_PATH_REFUSED', 'outside the project', `${ref.path} resolves outside the project`);
      }
      const stat = statSync(real, { throwIfNoEntry: false });
      if (!stat || !stat.isFile()) {
        return fail('EVIDENCE_SOURCE_ABSENT', 'not a file', `${ref.path} is not a file`);
      }
      const actual = createHash('sha256').update(readFileSync(real)).digest('hex');
      return actual === ref.sha256
        ? pass(actual)
        : fail('EVIDENCE_SOURCE_HASH_MISMATCH', actual,
          `${ref.path} is ${actual.slice(0, 16)}…; the evidence records ${ref.sha256.slice(0, 16)}…. The file changed after the evidence was gathered`);
    }

    case 'application.fact': {
      if (bound.via !== 'project') {
        return fail('EVIDENCE_AUTHORITY_UNAVAILABLE', 'no AX1 report for this composition',
          `this plan is bound to composition ${short(bound.fingerprint)} through ${bound.via ?? 'no authority'}, and the only full AX1 report in this run describes a different application. A fact about that composition must be cited where it was observed — as a scenario observation`);
      }
      const found = applicationFact(inspection, ref);
      return found.present
        ? pass(found.actual)
        : fail('EVIDENCE_FACT_ABSENT', found.actual,
          `${ref.fact} "${ref.name}"${ref.version === null ? '' : `@${ref.version}`} is ${found.actual} in this application`);
    }

    case 'project.verification': {
      if (verifyReport === null) {
        return fail('EVIDENCE_AUTHORITY_UNAVAILABLE', 'no receipt', 'crm project verify produced no receipt in this run');
      }
      const found = (verifyReport.checks ?? []).find((row) => row.code === ref.check) ?? null;
      if (found === null) {
        return fail('EVIDENCE_REFERENCE_UNRESOLVED', 'absent',
          `"${ref.check}" is not a check crm project verify published in this run. An unknown check code is a citation to nothing`);
      }
      return found.status === ref.expect
        ? pass(found.status)
        : fail('EVIDENCE_CHECK_UNEXPECTED_STATUS', found.status,
          `"${ref.check}" is "${found.status}" and the evidence expects "${ref.expect}"`);
    }

    case 'package.conformance': {
      if (verifyReport === null) {
        return fail('EVIDENCE_AUTHORITY_UNAVAILABLE', 'no receipt', 'crm project verify produced no receipt in this run');
      }
      const code = `packages.conformance.${ref.package}`;
      const found = (verifyReport.checks ?? []).find((row) => row.code === code) ?? null;
      if (found === null) {
        return fail('EVIDENCE_REFERENCE_UNRESOLVED', 'not graded',
          `"${ref.package}" was not graded for conformance in this run — this project composes no package with that local source, so there is no pass to cite`);
      }
      return found.status === 'passed'
        ? pass(found.status)
        : fail('EVIDENCE_CHECK_UNEXPECTED_STATUS', found.status, `"${code}" is "${found.status}", not "passed"`);
    }

    case 'scenario.observation': {
      const report = scenarioReports.get(ref.scenario) ?? null;
      if (report === null) {
        return fail('EVIDENCE_AUTHORITY_UNAVAILABLE', 'no report',
          `the scenario "${ref.scenario}" produced no report in this run`);
      }
      const observed = (report.observations ?? []).find((row) => row.code === ref.observation) ?? null;
      if (observed === null) {
        return fail('EVIDENCE_REFERENCE_UNRESOLVED', 'absent',
          `"${ref.observation}" is not an observation "${ref.scenario}" published in this run`);
      }
      // An observation code is a *position* in a document, and a document can be
      // edited. Pinning the exact `expected` string is what stops a code coming
      // to mean something else while the evidence still reads as current.
      if (observed.expected !== ref.expects) {
        return fail('EVIDENCE_OBSERVATION_MOVED', observed.expected,
          `"${ref.observation}" now expects ${JSON.stringify(observed.expected)}; the evidence was recorded against ${JSON.stringify(ref.expects)}. The code still exists and no longer means the same thing`);
      }
      return observed.status === 'passed'
        ? pass(observed.actual ?? observed.status)
        : fail('EVIDENCE_OBSERVATION_FAILED', observed.status,
          `"${ref.observation}" is "${observed.status}" in this run: ${observed.reason ?? 'no reason published'}`);
    }

    default:
      return fail('EVIDENCE_VOCABULARY_UNKNOWN', null, `"${ref.kind}" is not an evidence kind`);
  }
}

/** An AX1 fact, taken verbatim from the report. Nothing an authority resolved is recomputed. */
function applicationFact(inspection, ref) {
  const name = ref.name;
  switch (ref.fact) {
    case 'package.composed': {
      const row = (inspection.packages ?? []).find((entry) => entry?.name === name);
      return { present: row !== undefined, actual: row ? `composed@${row.version}` : 'not composed' };
    }
    case 'capability.available': {
      const row = (inspection.capabilities ?? []).find((entry) => entry?.name === name);
      if (!row) return { present: false, actual: 'not declared' };
      const versionOk = ref.version === null || row.version === ref.version;
      return {
        present: row.status === 'resolved' && versionOk,
        actual: `${row.status}@${row.version}`,
      };
    }
    case 'module.present': {
      const row = (inspection.modules ?? []).find((entry) => entry?.name === name);
      return { present: row !== undefined, actual: row ? 'present' : 'absent' };
    }
    case 'action.present': {
      const row = (inspection.actions ?? []).find((entry) => `${entry?.module}.${entry?.name}` === name);
      return { present: row !== undefined, actual: row ? 'present' : 'absent' };
    }
    case 'policy.present': {
      const row = (inspection.policies ?? []).find((entry) => entry?.name === name
        && (ref.version === null || entry?.version === ref.version));
      return { present: row !== undefined, actual: row ? `present@${row.version}` : 'absent' };
    }
    case 'resource.present': {
      const row = (inspection.resources ?? []).find((entry) => entry?.resource === name);
      return { present: row !== undefined, actual: row ? 'present' : 'absent' };
    }
    default:
      return { present: false, actual: 'unknown fact' };
  }
}

/**
 * DX5's dirty-state semantics, applied to this command's own run.
 *
 * The evidence document is routinely an uncommitted file under active work. It
 * is dirty **before** the run, so it lands in `dirtyBeforeVerification` — which
 * is context — and never in `changedByVerification`, which is a failure. That
 * distinction is the whole reason both samples exist, and nothing is ever
 * reset, stashed or cleaned.
 */
function compareWorktree(before, after, problems) {
  if (before === null || after === null) {
    return { sampled: false, dirtyBeforeVerification: [], changedByVerification: [], revertedByVerification: [],
      note: 'not a git checkout, so "changed while verifying" has no meaning here' };
  }
  const start = new Map(before.map(sampled).map((entry) => [entry.path, entry.status]));
  const end = new Map(after.map(sampled).map((entry) => [entry.path, entry.status]));
  const caused = [...end.keys()].filter((path) => !start.has(path) || start.get(path) !== end.get(path)).sort();
  const reverted = [...start.keys()].filter((path) => !end.has(path)).sort();
  if (caused.length > 0) {
    problems.push({
      code: 'VERIFICATION_DIRTIED_WORKTREE', path: 'worktree',
      message: `${caused.length} path(s) that were clean before this run differ from HEAD after it, so something this verification ran writes into the project. Paths already modified beforehand — the evidence document under active work is the ordinary case — are excluded. Nothing was reset, stashed or hidden`,
    });
  }
  if (reverted.length > 0) {
    problems.push({
      code: 'VERIFICATION_REPAIRED_WORKTREE', path: 'worktree',
      message: `${reverted.length} path(s) were modified before this run and match HEAD after it, so something this verification ran discarded uncommitted work. This command never resets, stashes or cleans; a delegate did`,
    });
  }
  return {
    sampled: true,
    dirtyBeforeVerification: [...start.keys()].sort(),
    changedByVerification: caused,
    revertedByVerification: reverted,
    note: 'sampled before and after the run; a file already modified beforehand is context, not a mutation caused by verifying',
  };
}

/** @param {string[]} statuses */
function tally(statuses) {
  const counts = Object.fromEntries(REQUIREMENT_STATUSES.map((status) => [status, 0]));
  counts.total = statuses.length;
  for (const status of statuses) counts[status] += 1;
  return counts;
}

/** Bounded text, so one enormous delegate string cannot bury the answer. */
function bound_(value) {
  if (typeof value !== 'string') return value === null || value === undefined ? null : String(value).slice(0, MAX_REPORT_TEXT);
  return value.length > MAX_REPORT_TEXT ? `${value.slice(0, MAX_REPORT_TEXT - 1)}…` : value;
}

/**
 * The report's limitations: the inherent ones, plus the author's, plus the ones
 * this particular run earned. A document may **add** to what a run does not
 * prove; it may never subtract, which is why the inherent list lives here and
 * not in the contract the author writes (ADR-029).
 */
function limitationsFor({ evidence, bound, graded }) {
  const rows = [...EVIDENCE_LIMITATIONS];
  if (bound.via !== null && bound.via !== 'project') {
    rows.push({
      code: 'PLAN_BOUND_THROUGH_A_SCENARIO',
      message: `this plan targets a composition this project's own root does not have, and the digest was matched against the application "${bound.via.slice('scenario:'.length)}" composed. That digest covers packages, capabilities, records, actions, policies and problems, so it is a whole-composition match — but no AX1 report of that application is available here, so an application fact about it must be cited where it was observed`,
    });
  }
  if (graded.some((row) => row.status === 'unverified')) {
    rows.push({
      code: 'MANUAL_EVIDENCE_REMAINS_REQUIRED',
      message: 'at least one requirement of this plan can only be checked by a person. This run cannot exit 0 while that is true, whatever else passes',
    });
  }
  const codes = new Set(rows.map((row) => row.code));
  for (const row of evidence.limitations) if (!codes.has(row.code)) rows.push(row);
  return rows.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
}

/**
 * The semantic fingerprint: what the run *decided*. No duration, timestamp,
 * temporary path, machine layout or random value enters the report at all — not
 * merely the fingerprint — so two runs of an unchanged checkout produce
 * byte-identical documents from different working directories.
 */
export function semanticFingerprint(report) {
  const semantic = {
    solutionVerificationContract: report.solutionVerificationContract,
    plan: report.plan,
    evidence: report.evidence,
    status: report.status,
    binding: report.binding,
    counts: report.counts,
    requirements: report.requirements.map((row) => ({
      requirementId: row.requirementId, kind: row.kind, category: row.category,
      enforcedCategory: row.enforcedCategory, declaredDowngrade: row.declaredDowngrade,
      status: row.status,
      evidence: row.evidence.map((entry) => ({ kind: entry.kind, resolved: entry.resolved, problem: entry.problem })),
    })),
    problems: report.problems.map((entry) => entry.code).sort(),
  };
  return createHash('sha256').update(canonicalJson(semantic)).digest('hex');
}

function unreadableReport({ planPath, evidencePath, problems }) {
  return {
    solutionVerificationContract: SOLUTION_VERIFICATION_CONTRACT,
    command: 'solution:verify',
    plan: { path: planPath, goal: null, revision: null, fingerprint: null, inspectionFingerprint: null },
    evidence: { path: evidencePath, implementationEvidenceContract: null, fingerprint: null },
    status: 'unreadable',
    counts: tally([]),
    binding: { boundTo: null, compositionFingerprint: null, projectInspectionFingerprint: null, planIsCurrent: false },
    requirements: [],
    unproven: [],
    authorities: [],
    worktree: { sampled: false, dirtyBeforeVerification: [], changedByVerification: [], revertedByVerification: [], note: 'nothing ran' },
    promotion: { performed: false, authority: 'human', rule: 'nothing was verified', wrote: [] },
    problems: [...problems].sort((a, b) => (a.code < b.code ? -1 : 1)),
    limitations: [...EVIDENCE_LIMITATIONS],
    fingerprint: '',
  };
}

function emit({ json, out, report }) {
  if (json) {
    out(`${JSON.stringify({ ...report, vocabulary: implementationEvidenceVocabulary() }, null, 2)}\n`);
    return;
  }
  out(`${render(report)}\n`);
}

const MARK = Object.freeze({
  verified: 'ok', partial: 'PART', blocked: 'BLOCK', unverifiable: 'BROKEN',
  unevidenced: 'NONE', unverified: 'MANUAL', stale: 'STALE',
});

function render(report) {
  const lines = [];
  lines.push(`Accordo solution verify (contract ${report.solutionVerificationContract})`);
  lines.push(`plan:     ${report.plan.path}`);
  lines.push(`evidence: ${report.evidence.path}`);
  lines.push(`bound to: ${report.binding.boundTo ?? 'nothing in this run'}`);
  lines.push(`status:   ${report.status}`);
  lines.push('');
  for (const row of report.requirements) {
    // Both categories, because the difference between them is the whole point:
    // the second is the one the sufficiency rule was applied against.
    const label = row.enforcedCategory && row.enforcedCategory !== row.category
      ? `  [${row.category || 'none'} → graded ${row.enforcedCategory}]`
      : row.category ? `  [${row.category}]` : '';
    lines.push(`  ${MARK[row.status].padEnd(6)} ${row.requirementId}${label}`);
    if (row.reason) lines.push(`         ${row.reason}`);
  }
  lines.push('');
  if (report.problems.length > 0) {
    lines.push('problems:');
    for (const problem of report.problems) lines.push(`  ${problem.code}  ${problem.path}: ${problem.message}`);
    lines.push('');
  }
  lines.push('authorities used:');
  for (const authority of report.authorities) {
    lines.push(`  ${authority.kind}${authority.scenario ? ` ${authority.scenario}` : ''} — ${authority.fingerprint ? `${authority.fingerprint.slice(0, 16)}…` : 'no fingerprint'}`);
  }
  lines.push('');
  lines.push('not proven here:');
  for (const limitation of report.limitations) lines.push(`  ${limitation.code}`);
  return lines.join('\n');
}
