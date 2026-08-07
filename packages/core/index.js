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

// ---- declared-definition fingerprints (ADR-015) ----
// A package that publishes versioned policies uses the same mechanism every
// first-party definition uses: declared JSON-safe config, canonical source.
export { computeDefinitionFingerprint, validateDeclaredConfig } from './src/intelligence-registry.js';

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
} from './src/validation.js';

// AX2 — machine-readable Solution Plans. A document contract and its validator:
// nothing here executes a plan, writes source or installs anything.
export {
  SOLUTION_PLAN_CONTRACT,
  DECISION_TYPES,
  EVIDENCE_CATEGORIES,
  APPROVAL_CODES,
  PLAN_PROBLEM_CODES,
  PLAN_LIMITATIONS,
  NON_EXECUTABLE_DECISION_TYPES,
  MAX_PLAN_BYTES,
  canonicalJson,
  fingerprintPlan,
  validateSolutionPlan,
  bindSolutionPlan,
  parseSolutionPlan,
  solutionPlanVocabulary,
} from './src/solution-plan.js';
