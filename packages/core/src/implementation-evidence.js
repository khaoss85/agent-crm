// @ts-check

import { createHash } from 'node:crypto';
import { ValidationError } from './errors.js';
import { EXECUTABLE_SHAPES, canonicalJson } from './solution-plan.js';

/**
 * Implementation Evidence (DX10) — the checked-in half.
 *
 * AX2 answers *what are you going to do, and on what evidence*. DX5 answers *is
 * this project healthy*. DX6 answers *which business jobs does this checkout
 * earn*. None of them answers the question a coding agent is actually asked at
 * the end of a piece of work:
 *
 * > **for every requirement in this plan, what proves it is implemented?**
 *
 * This module defines the document that answers it, and defines it so the
 * document cannot answer it *by itself*. There is **no status field anywhere in
 * this contract.** A requirement carries a category and a list of places to
 * look; the verifier obtains the current facts from authorities that ran in the
 * same invocation and decides the status. An agent writing this document about
 * its own work can point at the wrong evidence — it cannot declare the outcome.
 *
 * `blocked` and `partial` exist and are **downgrades only**: each carries a
 * mandatory reason, and neither can raise a status. That asymmetry is the whole
 * design. An author may always say "this is less proven than it looks"; no
 * author may say "this is more proven than the evidence shows".
 *
 * Like a Solution Plan and a scenario, it is **function-free by contract**:
 * there is no command, script, env or effect field anywhere in the shape,
 * unknown keys are refused rather than ignored, every string and list is
 * bounded, and every string is additionally matched against the *same exported*
 * `EXECUTABLE_SHAPES` the other two contracts use — one refusal, one place to
 * fix it.
 */

export const IMPLEMENTATION_EVIDENCE_CONTRACT = 1;

/** Bounds. An oversized document fails as an explained refusal, never as a hang. */
export const MAX_EVIDENCE_BYTES = 512 * 1024;
export const MAX_TEXT = 2_000;
export const MAX_IDENTIFIER = 200;
export const MAX_PATH = 240;
export const MAX_REQUIREMENTS = 200;
export const MAX_REFS_PER_REQUIREMENT = 25;
export const MAX_LIMITATIONS = 50;

/**
 * The closed evidence vocabulary. Six kinds, each naming exactly one authority.
 *
 * There is deliberately **no `test` kind.** A test *name* is the arbitrary
 * string this contract exists to refuse: no authority in this repository
 * publishes which tests ran, so citing one would be a claim dressed as a
 * citation. `project.verification` on `suite.verify` says the true, weaker
 * thing — the project's declared suite ran and passed in this invocation.
 */
export const EVIDENCE_KINDS = Object.freeze([
  'application.fact',
  'manual',
  'package.conformance',
  'project.verification',
  'scenario.observation',
  'source.artifact',
]);

/**
 * The application facts AX1 can answer, using **the same names DX6 already
 * uses** for its composition observations. A second vocabulary for one set of
 * facts is a second thing to keep in step.
 */
export const APPLICATION_FACTS = Object.freeze([
  'action.present',
  'capability.available',
  'module.present',
  'package.composed',
  'policy.present',
  'resource.present',
]);

/**
 * Requirement categories. The category decides which authority is *sufficient*
 * (`SUFFICIENCY`), and the sufficiency rule is enforced by the verifier, never
 * by the document.
 */
export const REQUIREMENT_CATEGORIES = Object.freeze([
  'behavioural',
  'manual',
  'package-architecture',
  'project-health',
  'structural',
]);

/**
 * The DX5 check statuses an author may expect. Taken from DX5's own closed
 * vocabulary rather than restated loosely.
 */
export const VERIFICATION_STATUSES = Object.freeze([
  'passed', 'failed', 'warning', 'skipped', 'not_applicable',
]);

/** Every problem this module and its verifier can report. Closed, so a reader can switch on it. */
export const EVIDENCE_PROBLEM_CODES = Object.freeze([
  // reading and shape
  'EVIDENCE_UNREADABLE',
  'EVIDENCE_TOO_LARGE',
  'EVIDENCE_CONTRACT_UNSUPPORTED',
  'EVIDENCE_FIELD_INVALID',
  'EVIDENCE_FIELD_UNKNOWN',
  'EVIDENCE_VOCABULARY_UNKNOWN',
  'EVIDENCE_EXECUTABLE_CONTENT',
  'EVIDENCE_PATH_REFUSED',
  'EVIDENCE_DUPLICATE_REQUIREMENT',
  'EVIDENCE_DUPLICATE_REFERENCE',
  'EVIDENCE_BLOCKED_REASON_MISSING',
  'EVIDENCE_PARTIAL_REASON_MISSING',
  'EVIDENCE_DOWNGRADE_CONFLICT',
  // binding the document to the plan and the application
  'EVIDENCE_REQUIREMENT_UNKNOWN',
  'EVIDENCE_REQUIREMENT_MISSING',
  'EVIDENCE_PLAN_FINGERPRINT_STALE',
  'EVIDENCE_PLAN_MISMATCH',
  'EVIDENCE_INSPECTION_STALE',
  'PLAN_NOT_CURRENT',
  'PLAN_INVALID',
  'PLAN_REQUIREMENT_DUPLICATE',
  // resolving a reference against an authority
  'EVIDENCE_AUTHORITY_UNAVAILABLE',
  'EVIDENCE_REFERENCE_UNRESOLVED',
  'EVIDENCE_FACT_ABSENT',
  'EVIDENCE_SOURCE_ABSENT',
  'EVIDENCE_SOURCE_HASH_MISMATCH',
  'EVIDENCE_CHECK_UNEXPECTED_STATUS',
  'EVIDENCE_OBSERVATION_FAILED',
  'EVIDENCE_OBSERVATION_MOVED',
  // sufficiency
  'EVIDENCE_INSUFFICIENT_FOR_CATEGORY',
  'EVIDENCE_CATEGORY_BELOW_FLOOR',
  'EVIDENCE_STRUCTURAL_ONLY',
  // execution
  'VERIFICATION_RECURSION_REFUSED',
  'VERIFICATION_AUTHORITY_FAILED',
  'VERIFICATION_DIRTIED_WORKTREE',
  'VERIFICATION_REPAIRED_WORKTREE',
]);

/**
 * Limitations every report carries, whatever an author wrote. Each is a hard
 * bound on what a green line in this report may be read to mean.
 */
export const EVIDENCE_LIMITATIONS = Object.freeze([
  {
    code: 'EVIDENCE_IS_NOT_A_PLAN_RUNTIME',
    message: 'nothing here writes, executes or completes a Solution Plan. This command reads a plan, reads an evidence document, runs authorities that already decide, and reports. It modifies no source',
  },
  {
    code: 'MANUAL_EVIDENCE_IS_NOT_PROOF',
    message: 'a requirement whose evidence is manual is reported as unverified, never as verified. It is accepted into the document so the gap is stated rather than omitted, and it forces a non-zero exit on its own',
  },
  {
    code: 'SOURCE_IS_STRUCTURAL_ONLY',
    message: 'a source artifact evidences that a named file has exactly these bytes. It is never proof that anything behaves correctly, and on its own it satisfies no requirement in any category',
  },
  {
    code: 'REQUIREMENT_CATEGORY_IS_DECLARED',
    message: 'the category of an acceptance-check requirement is declared by the evidence author, because the plan says nothing about the nature of a criterion. The authority each category requires is not declared and cannot be widened by an author; a step\'s category is additionally floored by its decision type',
  },
  {
    code: 'COVERAGE_IS_THE_PLAN_ONLY',
    message: 'this reports the requirements of one plan. It says nothing about requirements no plan wrote down, and a plan that omits a requirement cannot be caught here',
  },
  {
    code: 'BROWSER_EVIDENCE_NOT_AUTOMATED',
    message: 'no browser is driven and no rendered page is checked. Nothing here is evidence about the Admin as a user sees it',
  },
  {
    code: 'PRODUCTION_EVIDENCE_ABSENT',
    message: 'nothing here contacts a provider, reads a database, deploys, or observes a live or external system. There is no auth, tenancy or RBAC in this framework, and no deployment or operational readiness is assessed',
  },
  {
    code: 'VERIFICATION_SOURCE_TRUSTED',
    message: 'the scenarios and declared suites this command delegates to are checked-in repository source running with the operator\'s authority. Child processes are bounded in time, output and process group — that is isolation, not a sandbox',
  },
]);

/** Control characters and the two Unicode line separators. */
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029]/;

/** Keys that pollute a prototype if a document is ever spread into an object. */
const FORBIDDEN_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype']);

/** @typedef {{code: string, message: string, path: string}} EvidenceProblem */

/** @param {EvidenceProblem[]} problems @param {string} code @param {string} path @param {string} message */
function report(problems, code, path, message) {
  problems.push({ code, path, message });
}

/** A bounded string with no control characters and no executable shape. */
function text(value, path, problems, { max = MAX_TEXT, required = true } = {}) {
  if (value === undefined || value === null) {
    if (required) report(problems, 'EVIDENCE_FIELD_INVALID', path, 'is required');
    return null;
  }
  if (typeof value !== 'string') {
    report(problems, 'EVIDENCE_FIELD_INVALID', path, 'must be a string');
    return null;
  }
  if (value.trim() === '') {
    report(problems, 'EVIDENCE_FIELD_INVALID', path, 'must not be empty');
    return null;
  }
  if (value.length > max) {
    report(problems, 'EVIDENCE_FIELD_INVALID', path, `must be at most ${max} characters`);
    return null;
  }
  if (CONTROL_CHARACTERS.test(value)) {
    report(problems, 'EVIDENCE_FIELD_INVALID', path, 'must not contain control characters');
    return null;
  }
  for (const shape of EXECUTABLE_SHAPES) {
    if (shape.re.test(value)) {
      report(problems, 'EVIDENCE_EXECUTABLE_CONTENT', path,
        `must not contain ${shape.name}. An evidence document names where to look; it never carries something to run`);
      return null;
    }
  }
  return value;
}

/** A plain object with a closed key set, refused rather than trimmed. */
function object(value, path, problems, { required = true, allowed = null } = {}) {
  if (value === undefined || value === null) {
    if (required) report(problems, 'EVIDENCE_FIELD_INVALID', path, 'is required');
    return null;
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    report(problems, 'EVIDENCE_FIELD_INVALID', path, 'must be an object');
    return null;
  }
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.includes(key)) {
      report(problems, 'EVIDENCE_FIELD_INVALID', `${path}.${key}`, 'is a reserved key and must not appear in an evidence document');
      return null;
    }
  }
  if (allowed !== null) {
    for (const key of Object.keys(value)) {
      if (!allowed.includes(key)) {
        report(problems, 'EVIDENCE_FIELD_UNKNOWN', `${path}.${key}`,
          `is not part of implementationEvidenceContract ${IMPLEMENTATION_EVIDENCE_CONTRACT}. Known keys here: ${[...allowed].sort().join(', ')}`);
      }
    }
  }
  return value;
}

/** A bounded list, refused rather than truncated. */
function list(value, path, problems, { max, required = true } = { max: MAX_REQUIREMENTS }) {
  if (value === undefined || value === null) {
    if (required) report(problems, 'EVIDENCE_FIELD_INVALID', path, 'is required');
    return [];
  }
  if (!Array.isArray(value)) {
    report(problems, 'EVIDENCE_FIELD_INVALID', path, 'must be an array');
    return [];
  }
  if (value.length > max) {
    report(problems, 'EVIDENCE_FIELD_INVALID', path, `must contain at most ${max} entries`);
    return [];
  }
  return value;
}

/**
 * A repository-relative path that stays inside the project.
 *
 * The same three refusals the Solution Plan applies to an artifact path and DX6
 * applies to a cited plan: absolute, `..`, backslash or a URL scheme. Whether it
 * *resolves* inside the project is decided later, on the canonical path, because
 * a lexical check cannot see a symlink (ADR-026).
 */
function repoPath(value, path, problems) {
  const raw = text(value, path, problems, { max: MAX_PATH });
  if (raw === null) return null;
  if (raw.startsWith('/') || /^[a-z]:[\\/]/i.test(raw)) {
    report(problems, 'EVIDENCE_PATH_REFUSED', path,
      'must be repository-relative; an absolute path describes one machine, not the repository this evidence is about');
    return null;
  }
  if (raw.includes('\\')) {
    report(problems, 'EVIDENCE_PATH_REFUSED', path, 'must use forward slashes');
    return null;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    report(problems, 'EVIDENCE_PATH_REFUSED', path, 'must be a repository path, never a URL');
    return null;
  }
  if (raw.split('/').includes('..')) {
    report(problems, 'EVIDENCE_PATH_REFUSED', path, 'must stay inside the repository: ".." escapes the project this evidence is about');
    return null;
  }
  return raw;
}

/** A 64-character lower-case hex digest, or nothing. */
function digest(value, path, problems) {
  const raw = text(value, path, problems, { max: 64 });
  if (raw === null) return null;
  if (!/^[0-9a-f]{64}$/.test(raw)) {
    report(problems, 'EVIDENCE_FIELD_INVALID', path,
      'must be a 64-character lower-case hex digest. It is an identity, not a label');
    return null;
  }
  return raw;
}

/**
 * Validate an evidence document against the contract. Reads **no** project, so
 * it runs in CI, in review, or against a repository that is not the one it
 * describes. Returns the normalized document *and* every problem.
 *
 * @param {unknown} input
 * @returns {{valid: boolean, evidence: any, problems: EvidenceProblem[]}}
 */
export function validateImplementationEvidence(input) {
  /** @type {EvidenceProblem[]} */
  const problems = [];
  const raw = object(input, 'evidence', problems, {
    allowed: ['implementationEvidenceContract', 'plan', 'planFingerprint',
      'applicationInspectionFingerprint', 'requirements', 'limitations'],
  });
  if (raw === null) return { valid: false, evidence: null, problems };

  if (raw.implementationEvidenceContract !== IMPLEMENTATION_EVIDENCE_CONTRACT) {
    report(problems, 'EVIDENCE_CONTRACT_UNSUPPORTED', 'evidence.implementationEvidenceContract',
      `must be ${IMPLEMENTATION_EVIDENCE_CONTRACT}; this reader understands no other version`);
    return { valid: false, evidence: null, problems };
  }

  const evidence = {
    implementationEvidenceContract: IMPLEMENTATION_EVIDENCE_CONTRACT,
    fingerprint: '',
    plan: repoPath(raw.plan, 'evidence.plan', problems) ?? '',
    planFingerprint: digest(raw.planFingerprint, 'evidence.planFingerprint', problems) ?? '',
    applicationInspectionFingerprint:
      digest(raw.applicationInspectionFingerprint, 'evidence.applicationInspectionFingerprint', problems) ?? '',
    requirements: normalizeRequirements(raw.requirements, problems),
    limitations: normalizeLimitations(raw.limitations, problems),
  };
  evidence.fingerprint = fingerprintEvidence(evidence);
  return { valid: problems.length === 0, evidence, problems: sortProblems(problems) };
}

/** Problems in a stable order, so two runs produce identical bytes. */
function sortProblems(problems) {
  return [...problems].sort((a, b) => (
    a.path === b.path ? (a.code < b.code ? -1 : a.code > b.code ? 1 : 0) : (a.path < b.path ? -1 : 1)
  ));
}

function normalizeRequirements(value, problems) {
  const rows = list(value, 'evidence.requirements', problems, { max: MAX_REQUIREMENTS });
  /** @type {Set<string>} */
  const seen = new Set();
  return rows.map((entry, index) => {
    const path = `evidence.requirements[${index}]`;
    const row = object(entry, path, problems, {
      allowed: ['requirementId', 'category', 'evidence', 'blocked', 'partial'],
    });
    if (row === null) return null;

    const requirementId = text(row.requirementId, `${path}.requirementId`, problems, { max: MAX_IDENTIFIER });
    if (requirementId !== null) {
      if (!/^(?:step:[a-z0-9][a-z0-9._-]*|check:[0-9a-f]{12})$/i.test(requirementId)) {
        report(problems, 'EVIDENCE_FIELD_INVALID', `${path}.requirementId`,
          'must be a requirement id this plan derives: "step:<stepId>" or "check:<12 hex>". Run `solution check <plan.json> --json` and read `requirements`');
      } else if (seen.has(requirementId)) {
        report(problems, 'EVIDENCE_DUPLICATE_REQUIREMENT', `${path}.requirementId`,
          `"${requirementId}" appears more than once; one requirement carries one evidence list, not two that a reader must merge`);
      }
      seen.add(requirementId);
    }

    const category = text(row.category, `${path}.category`, problems, { max: 40 });
    if (category !== null && !REQUIREMENT_CATEGORIES.includes(category)) {
      report(problems, 'EVIDENCE_VOCABULARY_UNKNOWN', `${path}.category`,
        `must be one of ${REQUIREMENT_CATEGORIES.join(', ')}`);
    }

    const blocked = downgrade(row.blocked, `${path}.blocked`, problems, 'EVIDENCE_BLOCKED_REASON_MISSING');
    const partial = downgrade(row.partial, `${path}.partial`, problems, 'EVIDENCE_PARTIAL_REASON_MISSING');
    if (blocked !== null && partial !== null) {
      report(problems, 'EVIDENCE_DOWNGRADE_CONFLICT', path,
        'a requirement is blocked or partial, never both. Two downgrades with two reasons is a reader deciding which one the author meant');
    }

    return {
      requirementId: requirementId ?? '',
      category: category !== null && REQUIREMENT_CATEGORIES.includes(category) ? category : '',
      evidence: normalizeReferences(row.evidence, path, problems),
      blocked,
      partial,
    };
  }).filter(Boolean).sort((a, b) => (a.requirementId < b.requirementId ? -1 : a.requirementId > b.requirementId ? 1 : 0));
}

/**
 * A downgrade: `{"reason": "…"}` or absent. `{}` is refused rather than treated
 * as an unexplained downgrade — "blocked" with no reason is the shape of a
 * requirement somebody gave up on quietly.
 */
function downgrade(value, path, problems, missingCode) {
  if (value === undefined || value === null) return null;
  const row = object(value, path, problems, { allowed: ['reason'] });
  if (row === null) return null;
  const reason = text(row.reason, `${path}.reason`, problems, { required: false });
  if (reason === null) {
    report(problems, missingCode, `${path}.reason`,
      'is required. A downgrade with no reason is a requirement abandoned quietly, which is the outcome this contract exists to make visible');
    return { reason: '' };
  }
  return { reason };
}

function normalizeReferences(value, requirementPath, problems) {
  const rows = list(value, `${requirementPath}.evidence`, problems, { max: MAX_REFS_PER_REQUIREMENT, required: false });
  /** @type {Set<string>} */
  const seen = new Set();
  const refs = rows.map((entry, index) => {
    const path = `${requirementPath}.evidence[${index}]`;
    const kind = text(entry?.kind, `${path}.kind`, problems, { max: 40 });
    if (kind === null) return null;
    if (!EVIDENCE_KINDS.includes(kind)) {
      report(problems, 'EVIDENCE_VOCABULARY_UNKNOWN', `${path}.kind`,
        `must be one of ${EVIDENCE_KINDS.join(', ')}`);
      return null;
    }
    const shaped = REFERENCE_SHAPES[kind](entry, path, problems);
    if (shaped === null) return null;
    return { kind, ...shaped };
  }).filter(Boolean);

  for (const ref of refs) {
    // A reference's identity is the whole reference: two identical pointers are
    // one fact written twice, and repeating one does not make it more evidence.
    const key = canonicalJson(ref);
    if (seen.has(key)) {
      report(problems, 'EVIDENCE_DUPLICATE_REFERENCE', `${requirementPath}.evidence`,
        `"${ref.kind}" is cited twice with identical arguments; one authority answering one question once is one fact`);
    }
    seen.add(key);
  }
  return [...refs].sort((a, b) => (canonicalJson(a) < canonicalJson(b) ? -1 : 1));
}

/**
 * The shape of each evidence kind. Every one is a **pointer plus an
 * expectation** — a place an authority already publishes an answer, and the
 * answer this document expects to find there. None of them carries a result.
 */
const REFERENCE_SHAPES = Object.freeze({
  'application.fact': (entry, path, problems) => {
    const row = object(entry, path, problems, { allowed: ['kind', 'fact', 'name', 'version'] });
    if (row === null) return null;
    const fact = text(row.fact, `${path}.fact`, problems, { max: 40 });
    if (fact !== null && !APPLICATION_FACTS.includes(fact)) {
      report(problems, 'EVIDENCE_VOCABULARY_UNKNOWN', `${path}.fact`,
        `must be one of ${APPLICATION_FACTS.join(', ')} — the facts AX1 answers, named as DX6 names them`);
    }
    const version = row.version === undefined || row.version === null ? null
      : Number.isSafeInteger(row.version) && row.version >= 1 ? Number(row.version)
        : refuse(`${path}.version`, problems, 'must be a whole number of at least 1');
    return {
      fact: fact !== null && APPLICATION_FACTS.includes(fact) ? fact : '',
      name: text(row.name, `${path}.name`, problems, { max: MAX_IDENTIFIER }) ?? '',
      version,
    };
  },
  manual: (entry, path, problems) => {
    const row = object(entry, path, problems, { allowed: ['kind', 'describes'] });
    if (row === null) return null;
    return { describes: text(row.describes, `${path}.describes`, problems) ?? '' };
  },
  'package.conformance': (entry, path, problems) => {
    const row = object(entry, path, problems, { allowed: ['kind', 'package'] });
    if (row === null) return null;
    return { package: repoPath(row.package, `${path}.package`, problems) ?? '' };
  },
  'project.verification': (entry, path, problems) => {
    const row = object(entry, path, problems, { allowed: ['kind', 'check', 'expect'] });
    if (row === null) return null;
    const expect = text(row.expect, `${path}.expect`, problems, { max: 40 });
    if (expect !== null && !VERIFICATION_STATUSES.includes(expect)) {
      report(problems, 'EVIDENCE_VOCABULARY_UNKNOWN', `${path}.expect`,
        `must be one of ${VERIFICATION_STATUSES.join(', ')} — the statuses crm project verify publishes`);
    }
    return {
      check: text(row.check, `${path}.check`, problems, { max: MAX_IDENTIFIER }) ?? '',
      expect: expect !== null && VERIFICATION_STATUSES.includes(expect) ? expect : '',
    };
  },
  'scenario.observation': (entry, path, problems) => {
    const row = object(entry, path, problems, { allowed: ['kind', 'scenario', 'observation', 'expects'] });
    if (row === null) return null;
    const scenario = text(row.scenario, `${path}.scenario`, problems, { max: MAX_IDENTIFIER });
    if (scenario !== null && !/^[a-z0-9][a-z0-9-]*$/.test(scenario)) {
      report(problems, 'EVIDENCE_FIELD_INVALID', `${path}.scenario`,
        'must be a scenario id — lower-case letters, digits and dashes. A path here would be a document naming a file to open');
    }
    const observation = text(row.observation, `${path}.observation`, problems, { max: MAX_IDENTIFIER });
    if (observation !== null && !/^[a-z0-9][a-z0-9-]*\.[0-9]{2}$/.test(observation)) {
      report(problems, 'EVIDENCE_FIELD_INVALID', `${path}.observation`,
        'must be a DX6 observation code: "<stepId>.<NN>"');
    }
    return {
      scenario: scenario !== null && /^[a-z0-9][a-z0-9-]*$/.test(scenario) ? scenario : '',
      observation: observation ?? '',
      // The exact `expected` string DX6 published for that observation. Pinning
      // it is what stops a code from silently coming to mean something else:
      // `sla-boundary.02` is a position in a document, and a document can be
      // edited.
      expects: text(row.expects, `${path}.expects`, problems) ?? '',
    };
  },
  'source.artifact': (entry, path, problems) => {
    const row = object(entry, path, problems, { allowed: ['kind', 'path', 'sha256'] });
    if (row === null) return null;
    return {
      path: repoPath(row.path, `${path}.path`, problems) ?? '',
      sha256: digest(row.sha256, `${path}.sha256`, problems) ?? '',
    };
  },
});

function refuse(path, problems, message) {
  report(problems, 'EVIDENCE_FIELD_INVALID', path, message);
  return null;
}

/**
 * The author's limitations. Unlike a Solution Plan, none is *inherent* here:
 * the inherent ones belong to the **report**, because a document that could
 * write its own bounds could write a shorter list (ADR-029).
 */
function normalizeLimitations(value, problems) {
  return list(value, 'evidence.limitations', problems, { max: MAX_LIMITATIONS, required: false })
    .map((entry, index) => {
      const path = `evidence.limitations[${index}]`;
      const row = object(entry, path, problems, { allowed: ['code', 'message'] });
      if (row === null) return null;
      const code = text(row.code, `${path}.code`, problems, { max: 60 });
      if (code !== null && !/^[A-Z][A-Z0-9_]*$/.test(code)) {
        report(problems, 'EVIDENCE_FIELD_INVALID', `${path}.code`,
          'must be an upper-case code, so a limitation can be switched on rather than read');
      }
      return { code: code ?? '', message: text(row.message, `${path}.message`, problems) ?? '' };
    })
    .filter(Boolean)
    .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
}

/** The document's own identity: everything it says, minus its derived field. */
export function fingerprintEvidence(evidence) {
  const { fingerprint: _f, ...rest } = evidence;
  return createHash('sha256').update(canonicalJson(rest)).digest('hex');
}

/**
 * Read an evidence document from JSON text. Bounded before parsing, because a
 * size refusal is an answer and a hang is not.
 * @param {string} source
 */
export function parseImplementationEvidence(source) {
  if (typeof source !== 'string') {
    throw new ValidationError('An implementation-evidence document is read from JSON text');
  }
  const bytes = Buffer.byteLength(source, 'utf8');
  if (bytes > MAX_EVIDENCE_BYTES) {
    throw new ValidationError(`An implementation-evidence document must be at most ${MAX_EVIDENCE_BYTES} bytes; this one is ${bytes}`);
  }
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new ValidationError(`An implementation-evidence document must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * DX6 observation kinds, split by what they can evidence. This is the sharp
 * edge of the sufficiency matrix and the reason it cannot be gamed: the kind is
 * read from **DX6's report**, never from the evidence document, so an author
 * cannot relabel "the action is declared" as "the application does this".
 */
export const COMPOSITION_OBSERVATION_KINDS = Object.freeze([
  'action.present', 'capability.available', 'module.present',
  'package.composed', 'policy.present', 'resource.present',
]);
export const RUNTIME_OBSERVATION_KINDS = Object.freeze([
  'journey.completed', 'journey.count', 'journey.fact',
]);

/**
 * The sufficiency matrix. Per category: which authority *satisfies* it, and
 * what is explicitly insufficient however much of it there is.
 *
 * `source.artifact` appears in no `satisfiedBy` list at all. It corroborates
 * that the file which was verified is the file the document names, and its hash
 * is what makes evidence go stale when the file moves — it is never, on its own,
 * proof of anything.
 */
export const SUFFICIENCY = Object.freeze({
  structural: Object.freeze({
    satisfiedBy: ['application.fact', 'package.conformance', 'scenario.observation:composition'],
    insufficient: 'a source artifact says a file has these bytes; a structural requirement is about what the composition contains, which AX1 decides',
    rationale: 'a record, action, policy, resource, package or capability either is in the composition or is not, and AX1 reads that from source. No scenario is required for a purely structural requirement',
  }),
  behavioural: Object.freeze({
    satisfiedBy: ['scenario.observation:runtime'],
    insufficient: 'a file existing, a package being composed and an action being declared are all true of an application that does the wrong thing. Only a run can evidence what the application does',
    rationale: 'the journey\'s own receipt is the only authority for a runtime fact; AX1 by construction cannot see one',
  }),
  'project-health': Object.freeze({
    satisfiedBy: ['project.verification'],
    insufficient: 'nothing else runs the project\'s declared suites, so nothing else can say they passed',
    rationale: 'DX5 is the health authority and publishes a stable check code per authority it delegated to',
  }),
  'package-architecture': Object.freeze({
    satisfiedBy: ['package.conformance', 'application.fact'],
    insufficient: 'a package\'s source being present says nothing about whether it conforms or whether its declared capability resolved',
    rationale: 'DX4/DX5 conformance grades the seam; AX1 publishes the resolved capability graph',
  }),
  manual: Object.freeze({
    satisfiedBy: [],
    insufficient: 'there is no automation for this requirement, so no evidence in this contract can prove it',
    rationale: 'accepted so the gap is stated rather than omitted; it resolves to unverified and forces a non-zero exit',
  }),
});

/**
 * The **floor** a step's decision type puts under its category. A step that
 * configures, extends, adds a provider or creates a package changes what the
 * application *does*, so calling it structural is refused. A step that evolves
 * a record to a new manifest revision is structural, and requiring a scenario
 * for it would be requiring a run to prove a schema.
 *
 * Acceptance checks carry no floor: the plan says nothing about the nature of a
 * criterion, so the category is declared, recorded verbatim in the report, and
 * bounded by `REQUIREMENT_CATEGORY_IS_DECLARED`.
 */
export const CATEGORY_FLOOR = Object.freeze({
  configure: 'behavioural',
  extend: 'behavioural',
  provider: 'behavioural',
  'create-package': 'behavioural',
  evolve: 'structural',
});

/** The vocabulary itself, published so a reader never has to infer it. */
export function implementationEvidenceVocabulary() {
  return {
    implementationEvidenceContract: IMPLEMENTATION_EVIDENCE_CONTRACT,
    evidenceKinds: [...EVIDENCE_KINDS],
    applicationFacts: [...APPLICATION_FACTS],
    requirementCategories: [...REQUIREMENT_CATEGORIES],
    verificationStatuses: [...VERIFICATION_STATUSES],
    sufficiency: Object.fromEntries(Object.entries(SUFFICIENCY).map(([category, rule]) => [category, {
      satisfiedBy: [...rule.satisfiedBy], insufficient: rule.insufficient, rationale: rule.rationale,
    }])),
    categoryFloor: { ...CATEGORY_FLOOR },
    observationKinds: {
      composition: [...COMPOSITION_OBSERVATION_KINDS],
      runtime: [...RUNTIME_OBSERVATION_KINDS],
    },
    problemCodes: [...EVIDENCE_PROBLEM_CODES],
    limitations: EVIDENCE_LIMITATIONS.map((row) => ({ ...row })),
    bounds: {
      maxEvidenceBytes: MAX_EVIDENCE_BYTES,
      maxText: MAX_TEXT,
      maxIdentifier: MAX_IDENTIFIER,
      maxPath: MAX_PATH,
      maxRequirements: MAX_REQUIREMENTS,
      maxReferencesPerRequirement: MAX_REFS_PER_REQUIREMENT,
      maxLimitations: MAX_LIMITATIONS,
    },
    notModeled: [
      'a declared status — status is derived from evidence, never asserted',
      'a test name — no authority publishes which tests ran',
      'an evidence-to-evidence citation — an entry names an authority, so there is no graph to keep acyclic',
      'a command, script, path to execute, environment variable or effect',
      'writing, executing or completing a plan',
      'promoting a JTBD row',
      'a browser, a provider, a database, a deployment or any live system',
    ],
  };
}
