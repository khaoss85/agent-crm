// @ts-check

import { createHash } from 'node:crypto';
import { ValidationError } from './errors.js';

/**
 * Machine-readable Solution Plans (AX2).
 *
 * AX1 answers *what has this project actually composed*. This answers the next
 * question — **what are you going to do about it, and on what evidence** — in a
 * shape a second reader can check rather than interpret.
 *
 * It is **not a planner and not a runtime.** Nothing here writes source,
 * installs a package, configures a provider, starts a server or executes a
 * step. It defines a bounded document, validates one against a closed
 * vocabulary, and binds it to a real AX1 report so a plan whose premises have
 * moved says so instead of reading as current.
 *
 * A plan also cannot carry executable content. A step names a decision type and
 * the seam it uses; it never carries a command a reader is invited to run. That
 * is enforced here, not documented as a convention — a format that can describe
 * execution is one edit away from a runtime that performs it.
 */

export const SOLUTION_PLAN_CONTRACT = 1;

/** Bounds. An oversized plan fails as an explained refusal, never as a hang. */
export const MAX_PLAN_BYTES = 1024 * 1024;
export const MAX_TEXT = 2_000;
export const MAX_IDENTIFIER = 120;
export const MAX_LIST = 200;
export const MAX_CITATIONS = 50;

/**
 * The repository's own decision hierarchy, as values. A plan cannot blur
 * "we configured something" into "we wrote a package", because the rungs are
 * distinct strings and the validator knows which rung each one is.
 */
export const DECISION_TYPES = Object.freeze({
  configure: { rung: 1, label: 'Configure an installed package' },
  extend: { rung: 2, label: 'Extend through a declared seam' },
  evolve: { rung: 2, label: 'Evolve a record to a new manifest revision' },
  provider: { rung: 3, label: 'Add or configure a provider' },
  'create-package': { rung: 4, label: 'Create a custom package' },
  'propose-kernel-capability': { rung: 5, label: 'Propose a kernel capability as an ADR discussion' },
});

/**
 * Rung 5 is a proposal you write, never a step you take inside a solution. It
 * exists as a decision type so a plan can state it, and is refused in `steps`.
 */
export const NON_EXECUTABLE_DECISION_TYPES = Object.freeze(['propose-kernel-capability']);

/** The evidence model, in the order it is published. The set is closed. */
export const EVIDENCE_CATEGORIES = Object.freeze([
  'observedFacts',
  'derivedMetrics',
  'assumptions',
  'inferences',
  'recommendations',
  'unavailableEvidence',
]);

/**
 * Which categories an entry may cite, by category. This is the evidence model's
 * actual content, and the first draft did not have it: citations resolved
 * against *any* id, so an observed fact could cite a recommendation, a
 * recommendation could rest entirely on unavailable evidence, and two entries
 * could cite each other. Each of those is a way to launder a conclusion into
 * looking like a premise.
 *
 * The table is a DAG over categories, so the citation graph is **acyclic by
 * construction** rather than by a traversal that has to be maintained:
 *
 * ```text
 *   observedFacts        cite nothing — a fact carries a `source`
 *   assumptions          cite nothing — taken as true *without* evidence, by definition
 *   unavailableEvidence  cites nothing — it carries a `reason`, and is never proof
 *   derivedMetrics       ← observedFacts, assumptions
 *   inferences           ← observedFacts, derivedMetrics, assumptions
 *   recommendations      ← observedFacts, derivedMetrics, assumptions, inferences
 * ```
 */
const CITATION_SOURCES = Object.freeze({
  observedFacts: Object.freeze([]),
  assumptions: Object.freeze([]),
  unavailableEvidence: Object.freeze([]),
  derivedMetrics: Object.freeze(['observedFacts', 'assumptions']),
  inferences: Object.freeze(['observedFacts', 'derivedMetrics', 'assumptions']),
  recommendations: Object.freeze(['observedFacts', 'derivedMetrics', 'assumptions', 'inferences']),
});

/** Categories whose entries must cite the evidence they came from. */
const CITING_CATEGORIES = Object.freeze(['derivedMetrics', 'inferences', 'recommendations']);

/**
 * The sensitive boundaries `solve-business-goal` §9 lists in prose, as codes,
 * so a plan cannot invent a softer word for "spend money".
 */
export const APPROVAL_CODES = Object.freeze([
  'activate_journey',
  'auto_apply_experiment_winner',
  'change_live_audience',
  'change_secrets',
  'create_or_increase_spend',
  'external_communication',
  'install_or_configure_provider',
  'irreversible_or_destructive',
  'launch_ads',
  'publish_production',
  'sensitive_data',
]);

/** Approvals a decision type always requires, whatever the author remembered. */
const REQUIRED_APPROVALS = Object.freeze({
  provider: ['install_or_configure_provider'],
});

/** Every problem this module can report. Closed, so a reader can switch on it. */
export const PLAN_PROBLEM_CODES = Object.freeze([
  'PLAN_UNREADABLE',
  'PLAN_TOO_LARGE',
  'PLAN_CONTRACT_UNSUPPORTED',
  'PLAN_FIELD_INVALID',
  'PLAN_FIELD_UNKNOWN',
  'PLAN_VOCABULARY_UNKNOWN',
  'PLAN_CITATION_DIRECTION',
  'PLAN_RUNGS_NOT_INSPECTED',
  'PLAN_EXECUTABLE_CONTENT',
  'PLAN_CITATION_UNRESOLVED',
  'PLAN_DUPLICATE_ID',
  'PLAN_REQUIREMENT_DUPLICATE',
  'PLAN_APPROVAL_MISSING',
  'PLAN_DECISION_NOT_A_STEP',
  'PLAN_DECISION_UNKNOWN',
  'PLAN_STALE',
  'CAPABILITY_NOT_AVAILABLE',
]);

/** Limitations every plan carries, whatever its author wrote. */
export const PLAN_LIMITATIONS = Object.freeze([
  { code: 'PLAN_NOT_EXECUTED', message: 'This is a document, not a runtime. Nothing here runs, installs, deploys or modifies source.' },
  { code: 'APPROVAL_NOT_RBAC', message: 'An approval code marks a human-actor boundary. There is no auth, tenancy or RBAC in this framework, so no role is enforced anywhere.' },
  { code: 'EVIDENCE_NOT_VERIFIED', message: 'An observed fact is checked for shape and citation, never for truth. No query is run and no database is read.' },
  { code: 'BINDING_IS_SOURCE_ONLY', message: 'The bound application report is AX1: source-only. It says nothing about a database, a provider\'s health or what is deployed.' },
]);

/**
 * Control characters and the two Unicode line separators that break a line in
 * a JSON document without looking like they did.
 */
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029]/;

/**
 * Shapes that turn a described step into a runnable one. A plan that carries a
 * command has stopped being a plan, whatever the field is called.
 *
 * Exported because a second checked-in document contract — the DX6 scenario —
 * refuses exactly the same thing for exactly the same reason. A second copy of a
 * refusal is a second place for it to be fixed only once, which is the argument
 * `packages/cli/src/safe-text.js` already makes about scrubbing.
 */
export const EXECUTABLE_SHAPES = [
  { name: 'shell command', re: /(^|\s)(?:sudo|rm|curl|wget|chmod|chown|eval|exec|npm|npx|node|git|ssh|scp|bash|sh|zsh|python3?)\s+[-\w./]/ },
  { name: 'command substitution', re: /\$\(|`[^`]*`|\$\{[^}]*\}/ },
  { name: 'shell chaining', re: /(?:&&|\|\||;\s*\w+\s+-|\|\s*(?:sh|bash|zsh|node|python3?)\b)/ },
  { name: 'a remote address', re: /\b(?:https?|ftp|file|data):\/\//i },
  { name: 'a script tag', re: /<\s*script\b/i },
];

/** Keys that pollute a prototype if a plan is ever spread into an object. */
const FORBIDDEN_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype']);

/** @typedef {{code: string, message: string, path: string}} PlanProblem */

/** @param {PlanProblem[]} problems @param {string} code @param {string} path @param {string} message */
function report(problems, code, path, message) {
  problems.push({ code, path, message });
}

/**
 * A bounded string with no control characters and no executable shape.
 * @returns {string|null} the text, or null when it was refused
 */
function text(value, path, problems, { max = MAX_TEXT, required = true, allowEmpty = false } = {}) {
  if (value === undefined || value === null) {
    if (required) report(problems, 'PLAN_FIELD_INVALID', path, 'is required');
    return null;
  }
  if (typeof value !== 'string') {
    report(problems, 'PLAN_FIELD_INVALID', path, 'must be a string');
    return null;
  }
  if (!allowEmpty && value.trim() === '') {
    report(problems, 'PLAN_FIELD_INVALID', path, 'must not be empty');
    return null;
  }
  if (value.length > max) {
    report(problems, 'PLAN_FIELD_INVALID', path, `must be at most ${max} characters`);
    return null;
  }
  if (CONTROL_CHARACTERS.test(value)) {
    report(problems, 'PLAN_FIELD_INVALID', path, 'must not contain control characters');
    return null;
  }
  for (const shape of EXECUTABLE_SHAPES) {
    if (shape.re.test(value)) {
      report(problems, 'PLAN_EXECUTABLE_CONTENT', path,
        `must not contain ${shape.name}. A plan describes a decision and the seam it uses; it never carries something to run`);
      return null;
    }
  }
  return value;
}

/** An identifier a citation can resolve against. */
function identifier(value, path, problems) {
  const id = text(value, path, problems, { max: MAX_IDENTIFIER });
  if (id === null) return null;
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) {
    report(problems, 'PLAN_FIELD_INVALID', path, 'must be an identifier: letters, digits, dot, dash or underscore');
    return null;
  }
  return id;
}

/** A list, bounded, and refused rather than truncated. */
function list(value, path, problems, { max = MAX_LIST, required = true } = {}) {
  if (value === undefined || value === null) {
    if (required) report(problems, 'PLAN_FIELD_INVALID', path, 'is required');
    return [];
  }
  if (!Array.isArray(value)) {
    report(problems, 'PLAN_FIELD_INVALID', path, 'must be an array');
    return [];
  }
  if (value.length > max) {
    report(problems, 'PLAN_FIELD_INVALID', path, `must contain at most ${max} entries`);
    return [];
  }
  return value;
}

/**
 * A plain object — never an array, never a class instance, never a prototype
 * trap — with a **closed** key set.
 *
 * Unknown keys are refused rather than ignored. On a machine contract, silently
 * dropping a key an author wrote is the worst of both worlds: the plan claims
 * something, the reader never sees it, and the fingerprint (computed over the
 * *normalized* document) does not cover it, so the claim can change without the
 * plan's identity moving. Fail closed, and the author learns immediately that
 * this reader does not understand their field.
 */
function object(value, path, problems, { required = true, allowed = null } = {}) {
  if (value === undefined || value === null) {
    if (required) report(problems, 'PLAN_FIELD_INVALID', path, 'is required');
    return null;
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    report(problems, 'PLAN_FIELD_INVALID', path, 'must be an object');
    return null;
  }
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.includes(key)) {
      report(problems, 'PLAN_FIELD_INVALID', `${path}.${key}`, 'is a reserved key and must not appear in a plan');
      return null;
    }
  }
  if (allowed !== null) {
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) {
        report(problems, 'PLAN_FIELD_UNKNOWN', `${path}.${key}`,
          `is not part of solutionPlanContract ${SOLUTION_PLAN_CONTRACT}. Known keys here: ${[...allowed].sort().join(', ')}`);
      }
    }
  }
  return value;
}

/**
 * Canonical JSON: keys sorted at every depth, so a fingerprint depends on what
 * the plan says and not on how its author's editor ordered the keys.
 * @param {unknown} value
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

/** The plan's own identity: everything it says, minus its derived fields. */
export function fingerprintPlan(plan) {
  const { fingerprint: _f, problems: _p, ...rest } = plan;
  return createHash('sha256').update(canonicalJson(rest)).digest('hex');
}

/** The AX1 contract this binding understands. Pins `applicationInspectionContract`. */
export const INSPECTION_CONTRACT = 1;

/**
 * Derive a deterministic fingerprint of an application's **composition** from a
 * canonical AX1 report.
 *
 * This exists because the first draft recorded a `compositionFingerprint` the
 * plan's *author* typed. A free-text label that looks like a hash is worse than
 * no hash: it reads as cryptographic evidence of the composition a plan was
 * written against, while proving nothing at all.
 *
 * What it is: a **drift detector**. `check` recomputes this from the live
 * report and compares, so a plan cannot silently survive a composition that has
 * moved. What it is **not**: proof of authorship, authorization or correctness.
 * An author can copy a valid fingerprint from a report they did run — that is
 * expected, because obtaining one honestly means running the tooling, which is
 * the whole point. It cannot be forged into matching a composition nobody
 * inspected.
 *
 * It covers the facts a plan is built on and excludes everything a reader looks
 * at rather than depends on: no label, description, hint, route, package prose,
 * absolute path, timestamp, evidence path, database state or runtime status.
 *
 * @param {any} report an AX1 application-inspection report
 */
export function inspectionFingerprint(report) {
  if (!report || typeof report !== 'object' || report.applicationInspectionContract !== INSPECTION_CONTRACT) {
    throw new ValidationError(`An inspection fingerprint needs an applicationInspectionContract ${INSPECTION_CONTRACT} report`);
  }
  const pick = (rows, keys) => (Array.isArray(rows) ? rows : [])
    .map((row) => Object.fromEntries(keys.map((key) => [key, row?.[key] ?? null])));
  const facts = {
    inspectionContract: INSPECTION_CONTRACT,
    packageContract: report.application?.packageContract ?? null,
    // The composition file list is the set of things this application declares
    // it is made of; its order is decided by the kernel, not by a reader.
    composition: [...(report.application?.composition ?? [])].sort(),
    packages: pick(report.packages, ['name', 'version', 'packageContract']).map((row, index) => ({
      ...row,
      resources: [...(report.packages[index].resources ?? [])].sort(),
      actions: [...(report.packages[index].actions ?? [])].sort(),
      policies: [...(report.packages[index].policies ?? [])].sort(),
      requires: pick(report.packages[index].requires, ['name', 'version']),
      provides: pick(report.packages[index].provides, ['name', 'version']),
    })),
    capabilities: pick(report.capabilities, ['name', 'version', 'provider', 'status']).map((row, index) => ({
      ...row, consumers: [...(report.capabilities[index].consumers ?? [])].sort(),
    })),
    resources: pick(report.resources, ['resource', 'package']),
    // Declared action metadata only — never the label, the hint or the route,
    // which are presentation and derivation respectively.
    actions: pick(report.actions, ['module', 'name', 'owner', 'actionContract', 'stateField', 'externalOperation', 'confirm'])
      .map((row, index) => ({
        ...row,
        fromStates: report.actions[index].fromStates === null ? null : [...report.actions[index].fromStates],
        input: pick(report.actions[index].input, ['name', 'type', 'required']),
      })),
    // A policy's config *values* are inside its declared-definition fingerprint
    // (ADR-015), so changing a rate changes this without the values appearing.
    policies: pick(report.policies, ['owner', 'kind', 'name', 'version', 'fingerprint'])
      .map((row, index) => ({ ...row, configKeys: [...(report.policies[index].configKeys ?? [])].sort() })),
    // Identity and declared shape. Never a config *value*: a value can be a
    // credential, and no fingerprint is worth leaking one.
    providers: pick(report.providers, ['registry', 'kind', 'name', 'version', 'fixture'])
      .map((row, index) => ({
        ...row,
        capabilities: [...(report.providers[index].capabilities ?? [])].sort(),
        configKeys: [...(report.providers[index].configKeys ?? [])].sort(),
      })),
    // Migration identities and checksums are the record's schema identity, so a
    // record that gained a field changes this even within one revision.
    modules: pick(report.modules, ['name', 'owner', 'kind', 'revision', 'manifestVersion', 'stateFile'])
      .map((row, index) => ({ ...row, migrations: pick(report.modules[index].migrations, ['name', 'checksum']) })),
    // Problems and limitations bound what may be planned, so they are part of
    // the composition a plan was written against.
    problems: pick(report.problems, ['code', 'package', 'capability']),
    limitations: (report.limitations ?? []).map((row) => row.code).sort(),
    valid: report.valid === true,
  };
  return createHash('sha256').update(canonicalJson(facts)).digest('hex');
}

/**
 * Validate a Solution Plan against the contract. **Reads no project**, so a
 * plan can be checked in CI, in review, or against a repository that is not the
 * one it targets.
 *
 * Returns the normalized document *and* every problem — an inspector that stops
 * at the first fault sends its reader back to the guessing it exists to end.
 *
 * @param {unknown} input
 * @returns {{valid: boolean, plan: any, problems: PlanProblem[]}}
 */
export function validateSolutionPlan(input) {
  /** @type {PlanProblem[]} */
  const problems = [];
  const raw = object(input, 'plan', problems, {
    allowed: ['solutionPlanContract', 'revision', 'fingerprint', 'goal', 'metric', 'application',
      'evidence', 'decisions', 'steps', 'approvals', 'acceptance', 'limitations'],
  });
  if (raw === null) return { valid: false, plan: null, problems };

  if (raw.solutionPlanContract !== SOLUTION_PLAN_CONTRACT) {
    report(problems, 'PLAN_CONTRACT_UNSUPPORTED', 'plan.solutionPlanContract',
      `must be ${SOLUTION_PLAN_CONTRACT}; this reader understands no other version`);
    return { valid: false, plan: null, problems };
  }

  const revision = Number.isSafeInteger(raw.revision) && raw.revision >= 1 ? Number(raw.revision) : null;
  if (revision === null) report(problems, 'PLAN_FIELD_INVALID', 'plan.revision', 'must be a whole number of at least 1');

  const goal = normalizeGoal(raw.goal, problems);
  const metric = normalizeMetric(raw.metric, problems);
  const application = normalizeApplication(raw.application, problems);
  const evidence = normalizeEvidence(raw.evidence, problems);
  const decisions = normalizeDecisions(raw.decisions, problems);
  const steps = normalizeSteps(raw.steps, decisions, evidence, problems);
  const approvals = normalizeApprovals(raw.approvals, steps, problems);
  const acceptance = normalizeAcceptance(raw.acceptance, problems);
  const limitations = normalizeLimitations(raw.limitations, problems, {
    hasProviderDecision: decisions.some((decision) => decision.type === 'provider'),
  });

  const plan = {
    solutionPlanContract: SOLUTION_PLAN_CONTRACT,
    revision: revision ?? 1,
    fingerprint: '',
    goal,
    metric,
    application,
    evidence,
    decisions,
    steps,
    approvals,
    acceptance,
    limitations,
  };
  plan.fingerprint = fingerprintPlan(plan);
  return { valid: problems.length === 0, plan, problems: sortProblems(problems) };
}

/** Problems in a stable order, so two runs produce identical bytes. */
function sortProblems(problems) {
  return [...problems].sort((a, b) => (
    a.path === b.path ? (a.code < b.code ? -1 : 1) : (a.path < b.path ? -1 : 1)
  ));
}

function normalizeGoal(value, problems) {
  const goal = object(value, 'plan.goal', problems, { allowed: ['id', 'statement', 'outcome'] });
  if (goal === null) return { id: '', statement: '', outcome: '' };
  return {
    id: identifier(goal.id, 'plan.goal.id', problems) ?? '',
    statement: text(goal.statement, 'plan.goal.statement', problems) ?? '',
    outcome: text(goal.outcome, 'plan.goal.outcome', problems) ?? '',
  };
}

function normalizeMetric(value, problems) {
  const metric = object(value, 'plan.metric', problems, { allowed: ['name', 'definition', 'baseline', 'target'] });
  if (metric === null) return { name: '', definition: '', baseline: null, target: null };
  // A goal with no metric cannot be verified, so the metric is required — but a
  // baseline that is genuinely unknown is stated as null, never invented.
  return {
    name: text(metric.name, 'plan.metric.name', problems, { max: MAX_IDENTIFIER }) ?? '',
    definition: text(metric.definition, 'plan.metric.definition', problems) ?? '',
    baseline: metric.baseline === undefined || metric.baseline === null
      ? null : text(metric.baseline, 'plan.metric.baseline', problems),
    target: metric.target === undefined || metric.target === null
      ? null : text(metric.target, 'plan.metric.target', problems),
  };
}

/** The AX1 report this plan was written against, recorded so it can go stale. */
function normalizeApplication(value, problems) {
  const app = object(value, 'plan.application', problems, {
    allowed: ['inspectionContract', 'inspectionFingerprint', 'packages', 'capabilities', 'modules'],
  });
  const empty = { inspectionContract: null, inspectionFingerprint: '', packages: [], capabilities: [], modules: [] };
  if (app === null) return empty;
  if (app.inspectionContract !== INSPECTION_CONTRACT) {
    report(problems, 'PLAN_FIELD_INVALID', 'plan.application.inspectionContract',
      `must be ${INSPECTION_CONTRACT} — a plan binds to an AX1 report, and no other inspection contract exists`);
  }
  const packages = list(app.packages, 'plan.application.packages', problems).map((entry, index) => {
    const path = `plan.application.packages[${index}]`;
    const row = object(entry, path, problems);
    if (row === null) return null;
    return {
      name: identifier(row.name, `${path}.name`, problems) ?? '',
      version: Number.isSafeInteger(row.version) ? Number(row.version) : refuseVersion(path, problems),
    };
  }).filter(Boolean);

  const capabilities = list(app.capabilities, 'plan.application.capabilities', problems).map((entry, index) => {
    const path = `plan.application.capabilities[${index}]`;
    const row = object(entry, path, problems);
    if (row === null) return null;
    const status = text(row.status, `${path}.status`, problems, { max: 40 });
    if (status !== null && !['resolved', 'missing', 'provider-mismatch'].includes(status)) {
      report(problems, 'PLAN_VOCABULARY_UNKNOWN', `${path}.status`,
        'must be resolved, missing or provider-mismatch — the statuses AX1 reports');
    }
    return {
      name: identifier(row.name, `${path}.name`, problems) ?? '',
      version: Number.isSafeInteger(row.version) ? Number(row.version) : refuseVersion(path, problems),
      status: status ?? '',
    };
  }).filter(Boolean);

  const modules = list(app.modules, 'plan.application.modules', problems, { required: false }).map((entry, index) => {
    const path = `plan.application.modules[${index}]`;
    const row = object(entry, path, problems);
    if (row === null) return null;
    return {
      name: identifier(row.name, `${path}.name`, problems) ?? '',
      revision: Number.isSafeInteger(row.revision) ? Number(row.revision) : refuseVersion(path, problems),
    };
  }).filter(Boolean);

  // A 64-hex digest, or nothing. The earlier field took free text, so a plan
  // could carry "example-only-not-a-real-composition" in a slot that reads as
  // cryptographic evidence. Refusing the shape at validate time means a label
  // can no longer masquerade as a fingerprint — before any project is read.
  const raw = text(app.inspectionFingerprint, 'plan.application.inspectionFingerprint', problems, { max: MAX_IDENTIFIER });
  let fingerprint = '';
  if (raw !== null) {
    if (/^[0-9a-f]{64}$/.test(raw)) fingerprint = raw;
    else {
      report(problems, 'PLAN_FIELD_INVALID', 'plan.application.inspectionFingerprint',
        'must be the 64-character hex digest `crm solution check --json` reports for this project. It is a drift detector, not proof of authorship — but it is not a label, either');
    }
  }

  return {
    inspectionContract: INSPECTION_CONTRACT,
    inspectionFingerprint: fingerprint,
    packages: sortBy(packages, 'name'),
    capabilities: sortBy(capabilities, 'name'),
    modules: sortBy(modules, 'name'),
  };
}

function refuseVersion(path, problems) {
  report(problems, 'PLAN_FIELD_INVALID', `${path}.version`, 'must be a whole number');
  return 0;
}

function sortBy(rows, key) {
  return [...rows].sort((a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0));
}

/**
 * The six evidence categories, and no others. The set is closed in both
 * directions: a missing category is a problem and so is an invented one.
 */
function normalizeEvidence(value, problems) {
  const evidence = object(value, 'plan.evidence', problems, { allowed: [...EVIDENCE_CATEGORIES] });
  /** @type {Record<string, any[]>} */
  const normalized = Object.fromEntries(EVIDENCE_CATEGORIES.map((category) => [category, []]));
  if (evidence === null) return normalized;

  for (const key of Object.keys(evidence)) {
    if (!EVIDENCE_CATEGORIES.includes(key)) {
      report(problems, 'PLAN_VOCABULARY_UNKNOWN', `plan.evidence.${key}`,
        `is not one of the six evidence categories: ${EVIDENCE_CATEGORIES.join(', ')}`);
    }
  }

  /** @type {Set<string>} */
  const ids = new Set();
  for (const category of EVIDENCE_CATEGORIES) {
    const rows = list(evidence[category], `plan.evidence.${category}`, problems);
    for (const [index, entry] of rows.entries()) {
      const path = `plan.evidence.${category}[${index}]`;
      const row = object(entry, path, problems, {
        allowed: ['id', 'statement', 'citations',
          ...(category === 'observedFacts' ? ['source'] : []),
          ...(category === 'unavailableEvidence' ? ['reason'] : [])],
      });
      if (row === null) continue;
      const id = identifier(row.id, `${path}.id`, problems);
      if (id !== null) {
        if (ids.has(id)) report(problems, 'PLAN_DUPLICATE_ID', `${path}.id`, `"${id}" is used more than once`);
        ids.add(id);
      }
      const normalizedRow = {
        id: id ?? '',
        statement: text(row.statement, `${path}.statement`, problems) ?? '',
        citations: normalizeCitations(row.citations, path, problems),
      };
      // An observed fact says where it came from; an unavailable one says why
      // it could not be checked. A gap that is stated is part of the
      // deliverable — a gap that is omitted is a claim.
      if (category === 'observedFacts') {
        normalizedRow.source = text(row.source, `${path}.source`, problems) ?? '';
      }
      if (category === 'unavailableEvidence') {
        normalizedRow.reason = text(row.reason, `${path}.reason`, problems) ?? '';
      }
      if (CITING_CATEGORIES.includes(category) && normalizedRow.citations.length === 0) {
        report(problems, 'PLAN_CITATION_UNRESOLVED', `${path}.citations`,
          `a ${category.replace(/s$/, '')} must cite the evidence it follows from`);
      }
      normalized[category].push(normalizedRow);
    }
  }

  // Citations resolve *after* every id is known, so order in the file does not
  // decide whether a plan is valid — and each one is checked for direction, not
  // only for existence.
  const categoryOf = new Map();
  for (const category of EVIDENCE_CATEGORIES) {
    for (const row of normalized[category]) categoryOf.set(row.id, category);
  }
  for (const category of EVIDENCE_CATEGORIES) {
    const allowed = CITATION_SOURCES[category];
    for (const [index, row] of normalized[category].entries()) {
      const path = `plan.evidence.${category}[${index}].citations`;
      for (const cited of row.citations) {
        if (!ids.has(cited)) {
          report(problems, 'PLAN_CITATION_UNRESOLVED', path,
            `"${cited}" is not the id of any evidence entry in this plan`);
          continue;
        }
        const from = categoryOf.get(cited);
        if (!allowed.includes(from)) {
          report(problems, 'PLAN_CITATION_DIRECTION', path,
            allowed.length === 0
              ? `a ${singular(category)} cites nothing — it stands on its own ${category === 'observedFacts' ? 'source' : 'statement'}, so "${cited}" must not appear here`
              : `a ${singular(category)} may cite ${allowed.join(', ')}, and "${cited}" is a ${singular(from)}. Citing it would turn a conclusion into a premise`);
        }
      }
    }
  }
  return normalized;
}

/** "derivedMetrics" → "derived metric", for an error a human reads once. */
function singular(category) {
  return category
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/s$/, '');
}

function normalizeCitations(value, path, problems) {
  const rows = list(value, `${path}.citations`, problems, { required: false, max: MAX_CITATIONS });
  const ids = rows.map((entry, index) => identifier(entry, `${path}.citations[${index}]`, problems))
    .filter((id) => id !== null);
  // A citation list is a *set*: it is sorted, so order carries no meaning and
  // must not move the fingerprint. A repeat is therefore either a mistake or an
  // attempt to make one source look like several, and both are refused rather
  // than quietly deduplicated.
  const seen = new Set();
  for (const id of ids) {
    if (seen.has(id)) {
      report(problems, 'PLAN_DUPLICATE_ID', `${path}.citations`,
        `"${id}" is cited more than once; a citation list is a set, and repeating an id does not make it more evidence`);
    }
    seen.add(id);
  }
  return [...seen].sort();
}

function normalizeDecisions(value, problems) {
  const rows = list(value, 'plan.decisions', problems);
  /** @type {Set<string>} */
  const ids = new Set();
  return rows.map((entry, index) => {
    const path = `plan.decisions[${index}]`;
    const row = object(entry, path, problems, {
      allowed: ['id', 'type', 'target', 'rationale', 'rungsTried', 'rejectedRungs', 'gap'],
    });
    if (row === null) return null;
    const id = identifier(row.id, `${path}.id`, problems);
    if (id !== null) {
      if (ids.has(id)) report(problems, 'PLAN_DUPLICATE_ID', `${path}.id`, `"${id}" is used more than once`);
      ids.add(id);
    }
    const type = text(row.type, `${path}.type`, problems, { max: 40 });
    if (type !== null && !Object.prototype.hasOwnProperty.call(DECISION_TYPES, type)) {
      report(problems, 'PLAN_DECISION_UNKNOWN', `${path}.type`,
        `must be one of ${Object.keys(DECISION_TYPES).sort().join(', ')}`);
    }
    const known = type !== null && Object.prototype.hasOwnProperty.call(DECISION_TYPES, type);
    const rung = known ? DECISION_TYPES[type].rung : 0;
    const rungsTried = list(row.rungsTried, `${path}.rungsTried`, problems, { required: false, max: 5 })
      .map((entryRung, position) => (Number.isSafeInteger(entryRung) && entryRung >= 1 && entryRung <= 5
        ? Number(entryRung)
        : refuseRung(`${path}.rungsTried[${position}]`, problems)))
      .filter((entryRung) => entryRung > 0)
      .sort((a, b) => a - b);

    const rejectedRungs = list(row.rejectedRungs, `${path}.rejectedRungs`, problems, { required: false, max: 5 })
      .map((entryValue, position) => {
        const rejectedPath = `${path}.rejectedRungs[${position}]`;
        const rejected = object(entryValue, rejectedPath, problems, { allowed: ['rung', 'reason'] });
        if (rejected === null) return null;
        const rejectedRung = Number.isSafeInteger(rejected.rung) && rejected.rung >= 1 && rejected.rung <= 5
          ? Number(rejected.rung)
          : refuseRung(`${rejectedPath}.rung`, problems);
        return {
          rung: rejectedRung,
          reason: text(rejected.reason, `${rejectedPath}.reason`, problems) ?? '',
        };
      })
      .filter((rejected) => rejected !== null && rejected.rung > 0)
      .sort((a, b) => a.rung - b.rung);

    // Rung 3 and above mean "nothing installed can do this". The hierarchy only
    // works if that claim is *evidenced*: the first draft accepted a
    // `create-package` decision from an author who never looked at rung 1, which
    // is precisely how a domain gets duplicated. Every lower rung must be named
    // as tried, and each must carry the reason it was rejected.
    if (known && rung >= 3) {
      const lower = Array.from({ length: rung - 1 }, (_, position) => position + 1);
      const missingTried = lower.filter((entryRung) => !rungsTried.includes(entryRung));
      const missingReason = lower.filter((entryRung) => !rejectedRungs.some((rejected) => rejected.rung === entryRung));
      if (missingTried.length > 0) {
        report(problems, 'PLAN_RUNGS_NOT_INSPECTED', `${path}.rungsTried`,
          `a "${type}" decision is rung ${rung}, so rungs ${lower.join(', ')} must each be recorded as inspected; ${missingTried.join(', ')} ${missingTried.length === 1 ? 'is' : 'are'} missing`);
      }
      if (missingReason.length > 0) {
        report(problems, 'PLAN_RUNGS_NOT_INSPECTED', `${path}.rejectedRungs`,
          `each lower rung needs the reason it was rejected; ${missingReason.join(', ')} ${missingReason.length === 1 ? 'has' : 'have'} none`);
      }
      if (text(row.gap, `${path}.gap`, problems) === null) {
        report(problems, 'PLAN_RUNGS_NOT_INSPECTED', `${path}.gap`,
          `a "${type}" decision must name the capability gap no installed package fills`);
      }
    }

    return {
      id: id ?? '',
      type: known ? type : '',
      rung,
      target: text(row.target, `${path}.target`, problems, { max: MAX_IDENTIFIER }) ?? '',
      rationale: text(row.rationale, `${path}.rationale`, problems) ?? '',
      gap: row.gap === undefined || row.gap === null ? null : text(row.gap, `${path}.gap`, problems),
      rungsTried,
      rejectedRungs,
    };
  }).filter(Boolean);
}

function refuseRung(path, problems) {
  report(problems, 'PLAN_FIELD_INVALID', path, 'must be a decision-hierarchy rung between 1 and 5');
  return 0;
}

function normalizeSteps(value, decisions, evidence, problems) {
  const rows = list(value, 'plan.steps', problems);
  const decisionIds = new Set(decisions.map((decision) => decision.id));
  const byId = new Map(decisions.map((decision) => [decision.id, decision]));
  /** @type {Set<string>} */
  const ids = new Set();
  return rows.map((entry, index) => {
    const path = `plan.steps[${index}]`;
    const row = object(entry, path, problems, {
      allowed: ['id', 'decisionId', 'description', 'requiresCapabilities', 'approvals', 'verifies'],
    });
    if (row === null) return null;
    const id = identifier(row.id, `${path}.id`, problems);
    if (id !== null) {
      if (ids.has(id)) report(problems, 'PLAN_DUPLICATE_ID', `${path}.id`, `"${id}" is used more than once`);
      ids.add(id);
    }
    const decisionId = identifier(row.decisionId, `${path}.decisionId`, problems);
    if (decisionId !== null && !decisionIds.has(decisionId)) {
      report(problems, 'PLAN_CITATION_UNRESOLVED', `${path}.decisionId`,
        `"${decisionId}" is not the id of any decision in this plan`);
    }
    const decision = decisionId === null ? null : byId.get(decisionId) ?? null;
    if (decision && NON_EXECUTABLE_DECISION_TYPES.includes(decision.type)) {
      report(problems, 'PLAN_DECISION_NOT_A_STEP', `${path}.decisionId`,
        `"${decision.type}" is a proposal you write, never a step you take inside a solution (rung ${decision.rung})`);
    }
    const capabilities = list(row.requiresCapabilities, `${path}.requiresCapabilities`, problems, { required: false })
      .map((name, position) => identifier(name, `${path}.requiresCapabilities[${position}]`, problems))
      .filter((name) => name !== null)
      .sort();
    return {
      id: id ?? '',
      decisionId: decisionId ?? '',
      position: index,
      description: text(row.description, `${path}.description`, problems) ?? '',
      requiresCapabilities: capabilities,
      approvals: list(row.approvals, `${path}.approvals`, problems, { required: false })
        .map((code, position) => normalizeApprovalCode(code, `${path}.approvals[${position}]`, problems))
        .filter((code) => code !== null)
        .sort(),
      verifies: list(row.verifies, `${path}.verifies`, problems, { required: false })
        .map((ref, position) => identifier(ref, `${path}.verifies[${position}]`, problems))
        .filter((ref) => ref !== null)
        .sort(),
      decisionType: decision ? decision.type : '',
    };
  }).filter(Boolean);
}

function normalizeApprovalCode(value, path, problems) {
  const code = text(value, path, problems, { max: 60 });
  if (code === null) return null;
  if (!APPROVAL_CODES.includes(code)) {
    report(problems, 'PLAN_VOCABULARY_UNKNOWN', path,
      `must be one of the declared sensitive boundaries: ${APPROVAL_CODES.join(', ')}`);
    return null;
  }
  return code;
}

/**
 * The plan's approval register, plus the approvals a decision type requires
 * whether or not its author remembered them.
 */
function normalizeApprovals(value, steps, problems) {
  const rows = list(value, 'plan.approvals', problems, { required: false });
  const declared = rows.map((entry, index) => {
    const path = `plan.approvals[${index}]`;
    const row = object(entry, path, problems, { allowed: ['code', 'stepId', 'reason'] });
    if (row === null) return null;
    return {
      code: normalizeApprovalCode(row.code, `${path}.code`, problems) ?? '',
      stepId: identifier(row.stepId, `${path}.stepId`, problems) ?? '',
      reason: text(row.reason, `${path}.reason`, problems) ?? '',
    };
  }).filter(Boolean);

  const stepIds = new Set(steps.map((step) => step.id));
  for (const [index, approval] of declared.entries()) {
    if (approval.stepId !== '' && !stepIds.has(approval.stepId)) {
      report(problems, 'PLAN_CITATION_UNRESOLVED', `plan.approvals[${index}].stepId`,
        `"${approval.stepId}" is not the id of any step in this plan`);
    }
  }

  for (const step of steps) {
    const required = REQUIRED_APPROVALS[step.decisionType] ?? [];
    for (const code of required) {
      const onStep = step.approvals.includes(code);
      const registered = declared.some((approval) => approval.code === code && approval.stepId === step.id);
      if (!onStep || !registered) {
        report(problems, 'PLAN_APPROVAL_MISSING', `plan.steps[${step.position}].approvals`,
          `a "${step.decisionType}" step requires the "${code}" approval on the step and in plan.approvals`);
      }
    }
  }
  return [...declared].sort((a, b) => (
    a.stepId === b.stepId ? (a.code < b.code ? -1 : 1) : (a.stepId < b.stepId ? -1 : 1)
  ));
}

function normalizeAcceptance(value, problems) {
  const acceptance = object(value, 'plan.acceptance', problems, { allowed: ['checks', 'jtbdRows', 'artifacts'] });
  if (acceptance === null) return { checks: [], jtbdRows: [] };
  return {
    checks: list(acceptance.checks, 'plan.acceptance.checks', problems)
      .map((entry, index) => text(entry, `plan.acceptance.checks[${index}]`, problems))
      .filter((entry) => entry !== null),
    // A JTBD row moves only with linked evidence. The plan names the rows it
    // claims; it never asserts they have moved.
    jtbdRows: list(acceptance.jtbdRows, 'plan.acceptance.jtbdRows', problems, { required: false })
      .map((entry, index) => identifier(entry, `plan.acceptance.jtbdRows[${index}]`, problems))
      .filter((entry) => entry !== null)
      .sort(),
    artifacts: normalizeArtifacts(acceptance.artifacts, problems),
  };
}

/** The kinds of thing a plan may say it intends to produce. Closed. */
export const ARTIFACT_KINDS = Object.freeze([
  'admin-view', 'document', 'migration', 'module', 'package', 'policy', 'provider-config', 'test',
]);

/**
 * What a step is expected to produce — a *name and a place*, never content.
 *
 * A path is repo-relative and normalized. An absolute path leaks a machine
 * layout into a document meant to be reviewed and diffed anywhere, and `..`
 * escapes the repository the plan describes; both are refused. There is
 * deliberately no field for file *content*: an artifact carrying source or SQL
 * is the executable-content boundary in a different costume.
 */
function normalizeArtifacts(value, problems) {
  const rows = list(value, 'plan.acceptance.artifacts', problems, { required: false });
  /** @type {Set<string>} */
  const seen = new Set();
  return rows.map((entry, index) => {
    const path = `plan.acceptance.artifacts[${index}]`;
    const row = object(entry, path, problems, { allowed: ['kind', 'path', 'description'] });
    if (row === null) return null;
    const kind = text(row.kind, `${path}.kind`, problems, { max: 40 });
    if (kind !== null && !ARTIFACT_KINDS.includes(kind)) {
      report(problems, 'PLAN_VOCABULARY_UNKNOWN', `${path}.kind`,
        `must be one of ${ARTIFACT_KINDS.join(', ')}`);
    }
    let repoPath = text(row.path, `${path}.path`, problems, { max: MAX_IDENTIFIER * 2 });
    if (repoPath !== null) {
      if (repoPath.startsWith('/') || /^[a-z]:[\\/]/i.test(repoPath)) {
        report(problems, 'PLAN_FIELD_INVALID', `${path}.path`,
          'must be repository-relative; an absolute path describes one machine, not the repository this plan is about');
        repoPath = null;
      } else if (repoPath.split('/').includes('..')) {
        report(problems, 'PLAN_FIELD_INVALID', `${path}.path`,
          'must stay inside the repository: ".." escapes the project the plan describes');
        repoPath = null;
      } else if (seen.has(repoPath)) {
        report(problems, 'PLAN_DUPLICATE_ID', `${path}.path`,
          `"${repoPath}" is claimed by more than one artifact; two steps cannot both own one file without saying which wins`);
      }
      if (repoPath !== null) seen.add(repoPath);
    }
    return {
      kind: kind !== null && ARTIFACT_KINDS.includes(kind) ? kind : '',
      path: repoPath ?? '',
      description: text(row.description, `${path}.description`, problems) ?? '',
    };
  }).filter(Boolean).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * The author's limitations, plus the four every plan carries. A plan that
 * claims otherwise does not get to.
 */
const PROVIDER_LIMITATION = Object.freeze({
  code: 'PROVIDER_STATUS_UNKNOWN',
  message: 'A provider decision can be evidenced only as a *definition composed in source*. Whether it is configured, holds credentials, is reachable, is authenticated or is authorized is unknown here, and AX1 cannot answer it either.',
});

function normalizeLimitations(value, problems, { hasProviderDecision = false } = {}) {
  const authored = list(value, 'plan.limitations', problems, { required: false })
    .map((entry, index) => {
      const path = `plan.limitations[${index}]`;
      const row = object(entry, path, problems, { allowed: ['code', 'message'] });
      if (row === null) return null;
      return {
        code: text(row.code, `${path}.code`, problems, { max: 60 }) ?? '',
        message: text(row.message, `${path}.message`, problems) ?? '',
      };
    })
    .filter(Boolean);
  const codes = new Set(authored.map((row) => row.code));
  // A plan that touches a provider carries the provider limitation whether or
  // not its author wrote it. The five states a provider can be in are the most
  // reliable place for a plan to overclaim, and AX1 can evidence exactly one.
  const required = hasProviderDecision ? [...PLAN_LIMITATIONS, PROVIDER_LIMITATION] : PLAN_LIMITATIONS;
  const inherent = required.filter((row) => !codes.has(row.code));
  return [...authored, ...inherent].sort((a, b) => (a.code < b.code ? -1 : 1));
}

/**
 * The kinds of plan entry that are a **requirement** — something that must be
 * true before the plan is implemented. Closed, and deliberately short.
 *
 * A *step* is the work; an *acceptance check* is the criterion. Two things that
 * look like candidates are excluded on purpose:
 *
 * - **an artifact is not a requirement.** `acceptance.artifacts[]` names a place
 *   a step intends to produce a file. Treating that path as a requirement is
 *   "the file exists, therefore it is done" wearing a contract, which is the
 *   inference this whole family of commands refuses.
 * - **a JTBD row is not a requirement.** It is DX6's unit, its status is a
 *   person's decision under `docs/QUALITY_GATES.md` §3, and nothing here
 *   promotes one.
 */
export const REQUIREMENT_KINDS = Object.freeze(['step', 'acceptance-check']);

/**
 * How many hex characters of the statement digest name an acceptance check.
 *
 * **32 hex = 128 bits.** The first cut of this contract used 12 hex = 48 bits,
 * argued from birthday chance among the ~200 rows one plan may carry. That is
 * the wrong threat model. The wording of an acceptance check is authored by a
 * coding agent, and an agent that can propose wording can *search* wording, so
 * the bound that matters is a **deliberate** collision, not an accidental one:
 *
 * - **birthday, self-chosen pair** — ~2^24 (~1.7e7) hashes, well under a second
 *   on one core. This one is already refused downstream: two requirements with
 *   one id is `PLAN_REQUIREMENT_DUPLICATE`.
 * - **chosen target — land a new criterion on an id somebody else's evidence
 *   already names** — ~2^48 (~2.8e14) hashes at 48 bits. That is hours on one
 *   commodity GPU and days on a CPU; it is not a theoretical bound, it is an
 *   afternoon. It is also the dangerous one, because it makes an unevidenced
 *   criterion resolve against evidence written for a different criterion.
 *
 * At 128 bits the chosen-target search is ~2^128, which is the bound SHA-256's
 * own second-preimage resistance rests on, and the birthday search is ~2^64 —
 * both out of reach of an author who can only pick words.
 *
 * The cost of the wider id is a longer string in a checked-in document, and
 * nothing outside this repository consumes these identifiers yet, so this is
 * the cheapest moment the change will ever have.
 *
 * Both properties that made the derivation worth having are unchanged:
 * rewording a criterion still changes its id, and two identical criteria still
 * collide and are still refused.
 */
export const REQUIREMENT_DIGEST_LENGTH = 32;

/**
 * Every requirement in a plan, with a **derived** stable identifier.
 *
 * `steps[].id` already exists and is already unique, so a step requirement
 * reuses it rather than minting a second name for the same thing:
 * `step:<stepId>`. An acceptance check is a bare string with no identifier at
 * all, so its id is content-addressed: `check:<first 32 hex of sha256>` over the
 * statement.
 *
 * **Why derived rather than a new field.** Widening `acceptance.checks[]` to
 * accept `{id, statement}` would be a change to `solutionPlanContract: 1`: new
 * validation, a new normalized shape, and a fingerprint that means one thing for
 * new plans and another for old ones. Deriving adds *nothing* to the contract —
 * not a field, not a rule, not a byte of any plan's fingerprint — and every plan
 * already checked in becomes addressable with no migration and no rewrite. That
 * is the smallest additive change that exists.
 *
 * The cost is deliberate and is the behaviour we want: **rewording an acceptance
 * criterion changes its requirement id**, so evidence recorded against the old
 * wording reads as unevidenced rather than silently carrying over to a criterion
 * nobody re-examined.
 *
 * Two identical statements in one plan would collide, so the collision is
 * refused rather than resolved: one requirement must not stand for two.
 *
 * Reads a plan **already normalized by `validateSolutionPlan`**.
 *
 * @param {any} plan
 * @returns {{requirements: {requirementId: string, kind: string, statement: string,
 *   stepId: string|null, decisionId: string|null, decisionType: string|null,
 *   position: number}[], problems: PlanProblem[]}}
 */
export function planRequirements(plan) {
  /** @type {PlanProblem[]} */
  const problems = [];
  /** @type {any[]} */
  const requirements = [];
  /** @type {Map<string, string>} */
  const seen = new Map();

  const add = (row, path) => {
    const previous = seen.get(row.requirementId);
    if (previous !== undefined) {
      report(problems, 'PLAN_REQUIREMENT_DUPLICATE', path,
        `"${row.requirementId}" is already the requirement id of ${previous}. Two requirements that cannot be told apart cannot carry separate evidence`);
      return;
    }
    seen.set(row.requirementId, path);
    requirements.push({ ...row, position: requirements.length });
  };

  for (const step of plan?.steps ?? []) {
    add({
      requirementId: `step:${step.id}`,
      kind: 'step',
      statement: step.description ?? '',
      stepId: step.id,
      decisionId: step.decisionId === '' ? null : step.decisionId ?? null,
      decisionType: step.decisionType === '' ? null : step.decisionType ?? null,
    }, `plan.steps[${step.position}]`);
  }

  const checks = plan?.acceptance?.checks ?? [];
  for (const [index, statement] of checks.entries()) {
    const digest = createHash('sha256').update(String(statement)).digest('hex').slice(0, REQUIREMENT_DIGEST_LENGTH);
    add({
      requirementId: `check:${digest}`,
      kind: 'acceptance-check',
      statement: String(statement),
      stepId: null,
      decisionId: null,
      decisionType: null,
    }, `plan.acceptance.checks[${index}]`);
  }

  return { requirements, problems };
}

/**
 * Bind a validated plan to a real AX1 report.
 *
 * A composition that has moved since the plan was written produces `PLAN_STALE`
 * naming the specific difference. A plan whose premises have changed is not a
 * plan, and reading one as if it were is how an agent confidently builds on a
 * capability the application no longer has.
 *
 * @param {any} plan a plan already through `validateSolutionPlan`
 * @param {any} report an AX1 application-inspection report
 */
export function bindSolutionPlan(plan, report) {
  /** @type {PlanProblem[]} */
  const problems = [];
  if (!report || typeof report !== 'object' || report.applicationInspectionContract !== INSPECTION_CONTRACT) {
    report_(problems, 'PLAN_UNREADABLE', 'report',
      `is not an applicationInspectionContract ${INSPECTION_CONTRACT} report; this reader understands no other version`);
    return { current: false, problems, inspectionFingerprint: null };
  }

  // The whole-composition check, before the specific ones. This catches drift
  // the plan's own evidence lists cannot see — a policy version, an action that
  // disappeared, a migration checksum — and it is derived here rather than
  // trusted from the plan, which is the entire point of replacing the
  // author-supplied label it used to carry.
  const actualFingerprint = inspectionFingerprint(report);
  if (plan.application.inspectionFingerprint !== ''
    && plan.application.inspectionFingerprint !== actualFingerprint) {
    report_(problems, 'PLAN_STALE', 'plan.application.inspectionFingerprint',
      `the plan was written against composition ${plan.application.inspectionFingerprint.slice(0, 16)}…; this project is ${actualFingerprint.slice(0, 16)}…. Something in the composition moved — the differences below name what this plan actually depends on, and anything not listed there changed outside its evidence`);
  }

  const actualPackages = new Map((report.packages ?? []).map((row) => [row.name, row.version]));
  for (const declared of plan.application.packages) {
    if (!actualPackages.has(declared.name)) {
      report_(problems, 'PLAN_STALE', `plan.application.packages.${declared.name}`,
        `the plan was written against package "${declared.name}", which this application no longer composes`);
    } else if (actualPackages.get(declared.name) !== declared.version) {
      report_(problems, 'PLAN_STALE', `plan.application.packages.${declared.name}`,
        `the plan was written against version ${declared.version}; this application composes version ${actualPackages.get(declared.name)}`);
    }
  }

  const actualCapabilities = new Map((report.capabilities ?? []).map((row) => [row.name, row]));
  for (const declared of plan.application.capabilities) {
    const actual = actualCapabilities.get(declared.name);
    if (!actual) {
      report_(problems, 'PLAN_STALE', `plan.application.capabilities.${declared.name}`,
        `the plan was written against capability "${declared.name}", which this application no longer has`);
      continue;
    }
    if (actual.version !== declared.version || actual.status !== declared.status) {
      report_(problems, 'PLAN_STALE', `plan.application.capabilities.${declared.name}`,
        `the plan recorded ${declared.name}@${declared.version} as "${declared.status}"; it is now ${actual.name}@${actual.version} and "${actual.status}"`);
    }
  }

  const actualModules = new Map((report.modules ?? []).map((row) => [row.name, row.revision]));
  for (const declared of plan.application.modules) {
    if (!actualModules.has(declared.name)) {
      report_(problems, 'PLAN_STALE', `plan.application.modules.${declared.name}`,
        `the plan was written against record "${declared.name}", which this application no longer has`);
      continue;
    }
    const actual = actualModules.get(declared.name);
    // A core record carries no manifest revision at all — it is not an ADR-019
    // managed module. Pinning one to a revision is a category error, and saying
    // "is at revision null" would send the reader looking for a bump that can
    // never happen.
    if (actual === null || actual === undefined) {
      report_(problems, 'PLAN_STALE', `plan.application.modules.${declared.name}`,
        `"${declared.name}" declares no manifest revision in this application — it is a core record, not an ADR-019 managed module, so a plan must not pin its revision`);
    } else if (actual !== declared.revision) {
      report_(problems, 'PLAN_STALE', `plan.application.modules.${declared.name}`,
        `the plan was written against revision ${declared.revision}; this application is at revision ${actual} (ADR-019)`);
    }
  }

  // A step citing a capability the application does not have is a refusal, not
  // a TODO: this is the single most common way a plan reads as buildable when
  // it is not.
  for (const step of plan.steps) {
    for (const name of step.requiresCapabilities) {
      const actual = actualCapabilities.get(name);
      if (!actual || actual.status !== 'resolved') {
        report_(problems, 'CAPABILITY_NOT_AVAILABLE', `plan.steps[${step.position}].requiresCapabilities`,
          `"${name}" is ${actual ? `present but "${actual.status}"` : 'not composed by this application'}`);
      }
    }
  }

  return {
    current: problems.length === 0,
    problems: sortProblems(problems),
    // Published so an author can record it. Obtaining one honestly means
    // running the tooling against a real project, which is what makes it
    // evidence of drift rather than of nothing.
    inspectionFingerprint: actualFingerprint,
  };
}

/** Named apart so `report` the parameter never shadows `report` the helper. */
function report_(problems, code, path, message) {
  report(problems, code, path, message);
}

/**
 * Read a plan from JSON text. Bounded before parsing, because a size refusal is
 * an answer and a hang is not.
 * @param {string} source
 */
export function parseSolutionPlan(source) {
  if (typeof source !== 'string') {
    throw new ValidationError('A solution plan is read from JSON text');
  }
  const bytes = Buffer.byteLength(source, 'utf8');
  if (bytes > MAX_PLAN_BYTES) {
    throw new ValidationError(`A solution plan must be at most ${MAX_PLAN_BYTES} bytes; this one is ${bytes}`);
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new ValidationError(`A solution plan must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The vocabulary itself, published so a reader never has to infer it. */
export function solutionPlanVocabulary() {
  return {
    solutionPlanContract: SOLUTION_PLAN_CONTRACT,
    decisionTypes: Object.entries(DECISION_TYPES)
      .map(([type, meta]) => ({ type, rung: meta.rung, label: meta.label, canBeAStep: !NON_EXECUTABLE_DECISION_TYPES.includes(type) }))
      .sort((a, b) => (a.type < b.type ? -1 : 1)),
    evidenceCategories: [...EVIDENCE_CATEGORIES],
    citingCategories: [...CITING_CATEGORIES],
    citationSources: Object.fromEntries(
      Object.entries(CITATION_SOURCES).map(([category, sources]) => [category, [...sources]]),
    ),
    artifactKinds: [...ARTIFACT_KINDS],
    // Requirement identity is **derived**, never declared, so it adds nothing to
    // this contract and moves no plan's fingerprint. Published because a reader
    // that has to guess an identifier will guess a different one.
    requirements: {
      kinds: [...REQUIREMENT_KINDS],
      rule: 'a requirement is a step or an acceptance check. A step reuses the id its author already wrote (`step:<stepId>`); an acceptance check has no id in this contract, so it is content-addressed (`check:<first 32 hex of sha256 of the statement>`)',
      notRequirements: [
        'an acceptance artifact — a declared file path is a place, not proof that the work behind it happened',
        'a JTBD row — its status is a person\'s decision under docs/QUALITY_GATES.md §3',
      ],
      digestLength: REQUIREMENT_DIGEST_LENGTH,
    },
    inspectionContract: INSPECTION_CONTRACT,
    approvalCodes: [...APPROVAL_CODES],
    requiredApprovals: { ...REQUIRED_APPROVALS },
    problemCodes: [...PLAN_PROBLEM_CODES],
    limitations: PLAN_LIMITATIONS.map((row) => ({ ...row })),
    bounds: {
      maxPlanBytes: MAX_PLAN_BYTES,
      maxText: MAX_TEXT,
      maxIdentifier: MAX_IDENTIFIER,
      maxList: MAX_LIST,
      maxCitations: MAX_CITATIONS,
    },
    executableContent: {
      rule: 'a plan is non-executable **by contract**: there is no command, script or effect field anywhere in the shape, and no code path from a step to an invocation',
      textFiltering: 'the pattern match over free text is defense in depth, not a security sandbox. It is deliberately conservative and will refuse some legitimate prose; it will also miss a sufficiently encoded payload. Neither outcome changes the contract, because nothing reads these fields as instructions',
      shapes: EXECUTABLE_SHAPES.map((shape) => shape.name),
    },
    notModeled: [
      'a planner or LLM', 'an agent runtime or orchestrator', 'executing a plan',
      'modifying source', 'installing a package or provider', 'deploying',
      'reading a database', 'runtime health', 'authorization or RBAC',
    ],
  };
}
