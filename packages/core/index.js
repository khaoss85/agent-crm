// @ts-check

/**
 * The **public kernel surface** for domain packages (ADR-018 addendum 3).
 *
 * A domain package — first-party or written by a customer in their own
 * repository — imports from this file and from nothing else under
 * `packages/core`. Everything in `packages/core/src/*` is private: it changes
 * without notice, and a package that reaches into it is coupled to the
 * kernel's internals rather than to its contract.
 *
 * The surface is deliberately small. If a package needs something that is not
 * here, that is a missing runtime capability and belongs in an ADR discussion —
 * not in a deep import.
 *
 *   import { definePackage, AppError, ValidationError } from '../../core/index.js';
 */

// ---- the package contract ----
export {
  definePackage,
  validatePackageDefinition,
  PackageRegistry,
  SUPPORTED_PACKAGE_CONTRACT,
  // Historical aliases from the M12 seam, kept so existing composition works.
  DomainRegistries,
  validateDomainDefinition,
} from './src/package-registry.js';

// ---- errors a package raises through the runtime ----
// Status and code travel to HTTP, SDK, MCP and Admin unchanged, so a package
// never formats its own transport response.
export { AppError, ValidationError, NotFoundError, ConflictError, ForbiddenError } from './src/errors.js';

// ---- bounded outbound calls ----
// A package that calls a provider bounds it with the framework's timeout
// rather than racing its own, so the refusal a caller sees is the same one the
// kernel produces. Public because `packages/core/src/*` is private and a
// package cannot reach into it.
export { withTimeout } from './src/timeout.js';

// ---- the framework clock ----
// One ISO-8601 clock, so a package never stamps a record from its own.
export { nowIso } from './src/time.js';

// ---- the canonical actor authority ----
// The SAME normalization the audit log applies, so a package's stored actor and
// the audit record of the same write are the same identity. A package that
// rolls its own drifts from the evidence beside it, and a package that bounds
// an id the kernel does not bound can merge two people into one row. Generic:
// nothing here knows about any package.
export { normalizeActor, SYSTEM_ACTOR } from './src/actor.js';

// ---- declared-definition fingerprints (ADR-015) ----
// A package that publishes versioned policies uses the same mechanism every
// first-party definition uses: declared JSON-safe config, canonical source.
export { computeDefinitionFingerprint, validateDeclaredConfig } from './src/definition-fingerprint.js';

// ---- money (ADR-014/016) ----
// Integer minor units, never floats, with the framework's shared bounds. A
// package that stores or renders an amount uses these rather than inventing
// arithmetic or its own limits.
export {
  requireAmount,
  requireQuantity,
  requireBps,
  CHARGE_TYPES,
  PRICING_MODELS,
  RECURRING_INTERVALS,
  MAX_INTERVAL_COUNT,
  MAX_QUANTITY,
} from './src/commercial-money.js';

// ---- shared value validation ----
// The same bounded validators the kernel's own services use, so a package's
// refusals look and read like every other refusal in the framework.
export {
  requiredString,
  optionalString,
  requiredInteger,
  optionalInteger,
  nonNegativeInteger,
  requiredBoolean,
  optionalBoolean,
  enumValue,
  optionalEnum,
  requiredIsoDate,
  optionalIsoDate,
  // The one round-trip calendar-date authority. A calendar date is not an
  // instant, and `Date.parse` alone accepts days that never existed, so every
  // package that stores `YYYY-MM-DD` asks the same question of the same code.
  isCalendarDate,
  requireCalendarDate,
  calendarDaysBetween,
} from './src/validation.js';

// AX2 — machine-readable Solution Plans. A document contract and its validator:
// nothing here executes a plan, writes source or installs anything.
export {
  SOLUTION_PLAN_CONTRACT,
  INSPECTION_CONTRACT,
  ARTIFACT_KINDS,
  DECISION_TYPES,
  EVIDENCE_CATEGORIES,
  APPROVAL_CODES,
  PLAN_PROBLEM_CODES,
  PLAN_LIMITATIONS,
  NON_EXECUTABLE_DECISION_TYPES,
  EXECUTABLE_SHAPES,
  MAX_PLAN_BYTES,
  canonicalJson,
  fingerprintPlan,
  inspectionFingerprint,
  validateSolutionPlan,
  bindSolutionPlan,
  parseSolutionPlan,
  planRequirements,
  solutionPlanVocabulary,
  REQUIREMENT_KINDS,
  REQUIREMENT_DIGEST_LENGTH,
} from './src/solution-plan.js';

// ---- implementation evidence (DX10) ----
// The checked-in half of `crm solution verify`: a bounded, function-free
// document that says *where to look* for the proof of each plan requirement,
// and cannot say what the proof concluded.
export {
  IMPLEMENTATION_EVIDENCE_CONTRACT,
  EVIDENCE_KINDS,
  EVIDENCE_PROBLEM_CODES,
  EVIDENCE_LIMITATIONS,
  REQUIREMENT_CATEGORIES,
  APPLICATION_FACTS,
  SUFFICIENCY,
  CATEGORY_FLOOR,
  UNTYPED_CATEGORY_FLOOR,
  CATEGORY_STRENGTH,
  effectiveRequirementCategory,
  COMPOSITION_OBSERVATION_KINDS,
  RUNTIME_OBSERVATION_KINDS,
  MAX_EVIDENCE_BYTES,
  fingerprintEvidence,
  parseImplementationEvidence,
  validateImplementationEvidence,
  implementationEvidenceVocabulary,
} from './src/implementation-evidence.js';
