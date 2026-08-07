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
  'PLAN_VOCABULARY_UNKNOWN',
  'PLAN_EXECUTABLE_CONTENT',
  'PLAN_CITATION_UNRESOLVED',
  'PLAN_DUPLICATE_ID',
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
 */
const EXECUTABLE_SHAPES = [
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

/** A plain object — never an array, never a class instance, never a prototype trap. */
function object(value, path, problems, { required = true } = {}) {
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
  const raw = object(input, 'plan', problems);
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
  const limitations = normalizeLimitations(raw.limitations, problems);

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
  const goal = object(value, 'plan.goal', problems);
  if (goal === null) return { id: '', statement: '', outcome: '' };
  return {
    id: identifier(goal.id, 'plan.goal.id', problems) ?? '',
    statement: text(goal.statement, 'plan.goal.statement', problems) ?? '',
    outcome: text(goal.outcome, 'plan.goal.outcome', problems) ?? '',
  };
}

function normalizeMetric(value, problems) {
  const metric = object(value, 'plan.metric', problems);
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
  const app = object(value, 'plan.application', problems);
  const empty = { applicationInspectionContract: null, compositionFingerprint: '', packages: [], capabilities: [], modules: [] };
  if (app === null) return empty;
  if (app.applicationInspectionContract !== 1) {
    report(problems, 'PLAN_FIELD_INVALID', 'plan.application.applicationInspectionContract',
      'must be 1 — a plan binds to an AX1 report, and no other inspection contract exists');
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

  return {
    applicationInspectionContract: 1,
    compositionFingerprint: text(app.compositionFingerprint, 'plan.application.compositionFingerprint', problems, { max: MAX_IDENTIFIER }) ?? '',
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
  const evidence = object(value, 'plan.evidence', problems);
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
      const row = object(entry, path, problems);
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
  // decide whether a plan is valid.
  for (const category of EVIDENCE_CATEGORIES) {
    for (const [index, row] of normalized[category].entries()) {
      for (const cited of row.citations) {
        if (!ids.has(cited)) {
          report(problems, 'PLAN_CITATION_UNRESOLVED', `plan.evidence.${category}[${index}].citations`,
            `"${cited}" is not the id of any evidence entry in this plan`);
        }
      }
    }
  }
  return normalized;
}

function normalizeCitations(value, path, problems) {
  const rows = list(value, `${path}.citations`, problems, { required: false, max: MAX_CITATIONS });
  return rows.map((entry, index) => identifier(entry, `${path}.citations[${index}]`, problems))
    .filter((id) => id !== null)
    .sort();
}

function normalizeDecisions(value, problems) {
  const rows = list(value, 'plan.decisions', problems);
  /** @type {Set<string>} */
  const ids = new Set();
  return rows.map((entry, index) => {
    const path = `plan.decisions[${index}]`;
    const row = object(entry, path, problems);
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
    return {
      id: id ?? '',
      type: known ? type : '',
      rung: known ? DECISION_TYPES[type].rung : 0,
      target: text(row.target, `${path}.target`, problems, { max: MAX_IDENTIFIER }) ?? '',
      rationale: text(row.rationale, `${path}.rationale`, problems) ?? '',
      rungsTried: list(row.rungsTried, `${path}.rungsTried`, problems, { required: false, max: 5 })
        .map((rung, position) => (Number.isSafeInteger(rung) && rung >= 1 && rung <= 5
          ? Number(rung)
          : refuseRung(`${path}.rungsTried[${position}]`, problems)))
        .filter((rung) => rung > 0)
        .sort((a, b) => a - b),
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
    const row = object(entry, path, problems);
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
    const row = object(entry, path, problems);
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
  const acceptance = object(value, 'plan.acceptance', problems);
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
  };
}

/**
 * The author's limitations, plus the four every plan carries. A plan that
 * claims otherwise does not get to.
 */
function normalizeLimitations(value, problems) {
  const authored = list(value, 'plan.limitations', problems, { required: false })
    .map((entry, index) => {
      const path = `plan.limitations[${index}]`;
      const row = object(entry, path, problems);
      if (row === null) return null;
      return {
        code: text(row.code, `${path}.code`, problems, { max: 60 }) ?? '',
        message: text(row.message, `${path}.message`, problems) ?? '',
      };
    })
    .filter(Boolean);
  const codes = new Set(authored.map((row) => row.code));
  const inherent = PLAN_LIMITATIONS.filter((row) => !codes.has(row.code));
  return [...authored, ...inherent].sort((a, b) => (a.code < b.code ? -1 : 1));
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
  if (!report || typeof report !== 'object' || report.applicationInspectionContract !== 1) {
    report_(problems, 'PLAN_UNREADABLE', 'report', 'is not an application-inspection report');
    return { current: false, problems };
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

  return { current: problems.length === 0, problems: sortProblems(problems) };
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
    notModeled: [
      'a planner or LLM', 'an agent runtime or orchestrator', 'executing a plan',
      'modifying source', 'installing a package or provider', 'deploying',
      'reading a database', 'runtime health', 'authorization or RBAC',
    ],
  };
}
