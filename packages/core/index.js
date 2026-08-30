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

// ---- dual bundled graphs (Spine v2 M3P) ----
// One kernel helper stamps package/action/operation/capability contracts
// together. Bundled packages export both graphs; v1 callers keep the current
// synchronous object. Promise-returning wrappers never enter the v1 registry.
export {
  selectPackageGraph,
  selectedPackageContract,
  describePackageGraphContracts,
  describeBundledPackageGraphs,
  refuseAsyncPackagesOnSynchronousFactory,
} from './src/package-graph.js';

// ---- errors a package raises through the runtime ----
// Status and code travel to HTTP, SDK, MCP and Admin unchanged, so a package
// never formats its own transport response. `normalizeError` is the same
// normalization the kernel applies before an error crosses a surface, public
// so a package-owned operation records the identical failure shape.
export { AppError, ValidationError, NotFoundError, ConflictError, ForbiddenError, normalizeError } from './src/errors.js';

// ---- bounded outbound calls ----
// A package that calls a provider bounds it with the framework's timeout
// rather than racing its own, so the refusal a caller sees is the same one the
// kernel produces. Public because `packages/core/src/*` is private and a
// package cannot reach into it.
export { withTimeout } from './src/timeout.js';

// ---- the framework clock ----
// One ISO-8601 clock, so a package never stamps a record from its own.
export { nowIso } from './src/time.js';

// ---- run traces ----
// A package-owned, provider-backed operation that runs outside the action
// runtime (Commercial's catalog sync; Signature's ingest/reconcile) persists
// the same trace shape every run surface reads. Public for the same reason
// `withTimeout` is: `packages/core/src/*` is private, and a package that
// re-implements the trace row drifts from the evidence beside it.
export { writeTrace } from './src/action-runtime.js';

// ---- the canonical actor authority ----
// The SAME normalization the audit log applies, so a package's stored actor and
// the audit record of the same write are the same identity. A package that
// rolls its own drifts from the evidence beside it, and a package that bounds
// an id the kernel does not bound can merge two people into one row. Generic:
// nothing here knows about any package.
export {
  normalizeActor,
  requireActor,
  trustedSystemActor,
  stripServerControlledKeys,
  SERVER_CONTROLLED_KEYS,
  SYSTEM_ACTOR,
  ANONYMOUS_ACTOR,
} from './src/actor.js';

// ---- identity normalization (ADR-013's own rules, published) ----
// These two already lived in core, because the core adapters match records
// with them: `contacts.email` is stored lowercased and globally unique, and
// company matching collapses case and whitespace. They are pure runtime
// primitives with no domain vocabulary in them — the ADR-018 test for what
// core may own — and they are published here so a package that has to STORE a
// normalized form uses the identical rule the adapters MATCH with. The
// alternative was a second implementation inside a package, which is exactly
// the drift this repository refuses everywhere else.
export { normalizeEmail, normalizeCompanyName } from './src/core-adapters.js';

// ---- declared-definition fingerprints (ADR-015) ----
// A package that publishes versioned policies uses the same mechanism every
// first-party definition uses: declared JSON-safe config, canonical source.
export { computeDefinitionFingerprint, validateDeclaredConfig } from './src/definition-fingerprint.js';

// ---- persisting those fingerprints (ADR-015's own rule, published) ----
// The other half of the mechanism above. Computing a fingerprint is only half
// of "a registered definition version is immutable": something has to record
// each `{type, name, version, fingerprint}` at startup and refuse the boot when
// a registered version's source has moved underneath it. That loop is a runtime
// capability, not a domain concept — the store knows only the four identity
// fields and the one core table they live in, and `type` is an opaque string
// its caller chooses. It is published for the same reason
// `computeDefinitionFingerprint` is: a package that re-implements it
// re-implements the rule that decides whether the application starts, and the
// one sentence a person reads at boot becomes several that disagree.
export { createDefinitionVersionStore } from './src/definition-version-store.js';

// ---- caller-owned transaction proof (Spine v2 M2D) ----
// A package whose writes are only correct as a SET must be able to prove it is
// inside the caller's transaction before it writes the first row. Reading the
// SQLite driver's `isTransaction` flag off `database.raw` did that, at the
// price of a business package holding the raw driver — every table in the
// application, `exec` and `prepare` — for one boolean.
//
// `proveCallerTransaction` is that boolean without the driver: it compares the
// storage handles of the services that must commit together, then asks that one
// handle for the opaque witness the database wrapper mints per outer
// transaction. It is published because FOUR capabilities proved they need it —
// `work/follow-up@1`, `contracts/delivery-obligations@1`,
// `contracts/service-obligations@1` and
// `contracts/contracts-successor-activation@1` — three of which were measured
// committing a partial write outside a transaction
// (`docs/plans/spine-v2-m2d-transaction-context.md` §2).
//
// `mintTransactionWitness` is deliberately NOT here. A package that could mint
// could manufacture the very proof it is subject to.
export { TRANSACTION_PROOF, proveCallerTransaction } from './src/transaction-witness.js';

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
} from './src/money.js';

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
  toPlainData,
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
// The checked-in half of `accordo solution verify`: a bounded, function-free
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

// ---- Production Spine v1 (ADR-038): identity, mode, authorization, tenancy ----
// The framework does not authenticate anybody — a deployment adapter does, and
// hands back a bounded, verified identity context. What the framework owns is
// everything after that: the contract, the tenant, the membership, the
// decision, the evidence, and a boundary that fails closed.
export {
  IDENTITY_CONTRACT,
  IDENTITY_KINDS,
  IDENTITY_METHODS,
  MAX_IDENTITY_FIELD,
  ANONYMOUS_IDENTITY,
  defineIdentity,
  identityString,
  identityEvidence,
  actorFromIdentity,
  claimsFingerprint,
} from './src/identity.js';

export { RUNTIME_MODES, MODE_ENV, resolveRuntimeMode } from './src/runtime-mode.js';

export {
  PERMISSIONS,
  ROLES,
  ROLE_BUNDLES,
  SYSTEM_PERMISSIONS,
  ROLE_BEARING_KINDS,
  authorizationFingerprint,
  assertPermissionKey,
  decideAuthorization,
  requireAuthorization,
} from './src/authorization.js';

export { createSpineStore, LOCAL_ORGANIZATION_SLUG } from './src/spine-store.js';

export {
  TENANT_STORAGE_CONTRACT,
  TENANT_STRATEGY,
  TENANT_LIMITATIONS,
  assertTenantId,
  createTenantStorage,
  bindTenantStorage,
} from './src/tenant-storage.js';

export {
  TENANT_BINDING_CONTRACT,
  TENANT_BINDING_CONTRACT_V2,
  describePortableTenantBinding,
  resolveTenantBinding,
  assertBindAddress,
  assertBoundOrganization,
} from './src/tenant-binding.js';
