// @ts-check

import { ValidationError, NotFoundError, AppError } from './errors.js';
import { validateDeclaredConfig } from './definition-fingerprint.js';
import { createDefinitionVersionStore } from './definition-version-store.js';
import { resolvePackageComposition } from './package-composition.js';

/**
 * The public **domain-package contract** (ADR-018, addendum 3).
 *
 * The kernel is a platform runtime. Every domain — first-party or written by a
 * customer for their own repository — attaches through this one contract, and
 * the kernel learns nothing about the domain from it: no record name, no
 * business concept and no domain vocabulary appears here or anywhere else in
 * `packages/core`.
 *
 * A package exports one static definition:
 *
 *   definePackage({
 *     packageContract: 1,          the contract this package is written against
 *     name: 'a-domain',            canonical, unique, Map-keyed
 *     version: 1,                  the package's own version
 *     label: 'A domain',
 *     description: '…',
 *     requires: [{ package: 'other-domain', capability: 'some-capability', version: 1 }],
 *     capabilities: [{ name: 'some-capability', version: 1, create({modules}) {…} }],
 *     resources: ['a-record', 'another-record'],   record modules it owns
 *     actions: [ …action definitions… ],
 *     policies: [ {kind, definition:{name, version, config, …handlers}} ],
 *     metadata(): {…}              function-free, additive schema block
 *   })
 *
 * **Dependency direction is one-way.** A package depends on the kernel's public
 * exports (`packages/core/index.js`) and, when it must reach another package,
 * on a *declared capability* — never on that package's private source. The
 * kernel never imports a package: composition is the checked-in static import
 * list in `packages/domains/generated/index.js`.
 *
 * Everything is validated fail-closed at startup: an unsupported contract
 * version, a duplicate identity, a resource two packages both claim, a missing
 * or mis-versioned dependency, or a dependency cycle stops the application
 * instead of serving a half-registered domain.
 */

const NAME_RE = /^[a-z][a-z0-9-]*$/;
/** App-method aliases and input names are camelCase identifiers (ADR-032). */
const APP_METHOD_RE = /^[a-z][a-zA-Z0-9]*$/;
/** The action runtime's declared input vocabulary, reused verbatim (ADR-032). */
const OPERATION_INPUT_TYPES = new Set(['string', 'timestamp', 'enum', 'integer', 'json']);
const MAX_NAME = 64;
const MAX_LABEL = 80;
const MAX_DESCRIPTION = 400;
const MAX_VERSION = 1_000_000;
export const SUPPORTED_PACKAGE_CONTRACT = 1;
export const SUPPORTED_OPERATION_CONTRACT = 1;

/**
 * Declare a domain package. This is a validating identity function: it returns
 * the definition it was given, having refused anything the runtime could not
 * register — so a malformed package fails where it is written, not at boot.
 *
 * @param {any} definition
 */
export function definePackage(definition) {
  return validatePackageDefinition(definition);
}

/** @param {string} label @param {any} definition */
function assertPolicyIdentity(label, definition) {
  if (!definition || typeof definition !== 'object') {
    throw new ValidationError(`${label} definition must be an object`);
  }
  if (typeof definition.name !== 'string' || !NAME_RE.test(definition.name)) {
    throw new ValidationError(`${label} "${String(definition.name)}": name must match ${NAME_RE}`);
  }
  if (!Number.isSafeInteger(definition.version) || definition.version < 1 || definition.version > MAX_VERSION) {
    throw new ValidationError(`${label} "${definition.name}": version must be a positive integer (1–${MAX_VERSION})`);
  }
  if (definition.label !== undefined && (typeof definition.label !== 'string' || definition.label.length === 0 || definition.label.length > MAX_LABEL)) {
    throw new ValidationError(`${label} "${definition.name}": label must be a non-empty string of at most ${MAX_LABEL} characters`);
  }
  validateDeclaredConfig(`${label} "${definition.name}@${definition.version}"`, definition.config);
}

/** @param {string} label @param {unknown} value @param {string} field */
function assertVersion(label, value, field) {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > MAX_VERSION) {
    throw new ValidationError(`${label}: ${field} must be a positive integer (1–${MAX_VERSION})`);
  }
}

/**
 * Validate one package definition in isolation. Cross-package checks
 * (duplicate identity, resource collisions, dependency resolution, cycles)
 * belong to the registry, because they are only answerable once the whole
 * composition is known.
 *
 * @param {any} pkg
 */
export function validatePackageDefinition(pkg) {
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) {
    throw new ValidationError('Domain package definition must be an object');
  }
  const label = typeof pkg.name === 'string' ? `package "${pkg.name.slice(0, MAX_NAME)}"` : 'domain package';
  if (typeof pkg.name !== 'string' || !NAME_RE.test(pkg.name)) {
    throw new ValidationError(`${label}: name must match ${NAME_RE}`);
  }
  // The name is a Map key, a `/api/schema` key and part of a persisted
  // `definition_versions` type. Unbounded identities travel further than the
  // author expects, so they are bounded like every other stored identity.
  if (pkg.name.length > MAX_NAME) {
    throw new ValidationError(`${label}: name must be at most ${MAX_NAME} characters`);
  }
  if (pkg.packageContract !== SUPPORTED_PACKAGE_CONTRACT) {
    throw new ValidationError(
      `${label}: packageContract must be ${SUPPORTED_PACKAGE_CONTRACT} (received ${JSON.stringify(pkg.packageContract)})`,
    );
  }
  assertVersion(label, pkg.version, 'version');
  if (pkg.label !== undefined && (typeof pkg.label !== 'string' || pkg.label.length === 0 || pkg.label.length > MAX_LABEL)) {
    throw new ValidationError(`${label}: label must be a non-empty string of at most ${MAX_LABEL} characters`);
  }
  if (pkg.description !== undefined && (typeof pkg.description !== 'string' || pkg.description.length > MAX_DESCRIPTION)) {
    throw new ValidationError(`${label}: description must be a string of at most ${MAX_DESCRIPTION} characters`);
  }
  for (const field of ['actions', 'policies', 'resources', 'requires', 'capabilities', 'operations']) {
    if (pkg[field] !== undefined && !Array.isArray(pkg[field])) {
      throw new ValidationError(`${label}: ${field} must be an array`);
    }
  }
  if (pkg.metadata !== undefined && typeof pkg.metadata !== 'function') {
    throw new ValidationError(`${label}: metadata must be a function when present`);
  }

  // Resources: the record modules this package owns. Declaring them is what
  // makes a collision between two packages detectable before boot.
  const resources = new Set();
  for (const resource of pkg.resources ?? []) {
    if (typeof resource !== 'string' || !NAME_RE.test(resource)) {
      throw new ValidationError(`${label}: resource names must match ${NAME_RE}`);
    }
    if (resources.has(resource)) {
      throw new ValidationError(`${label}: duplicate resource "${resource}"`);
    }
    resources.add(resource);
  }

  // Declared dependencies on other packages' capabilities.
  const required = new Set();
  for (const entry of pkg.requires ?? []) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ValidationError(`${label}: each requires entry must be an object`);
    }
    if (typeof entry.package !== 'string' || !NAME_RE.test(entry.package)) {
      throw new ValidationError(`${label}: requires[].package must match ${NAME_RE}`);
    }
    if (typeof entry.capability !== 'string' || !NAME_RE.test(entry.capability)) {
      throw new ValidationError(`${label}: requires[].capability must match ${NAME_RE}`);
    }
    assertVersion(label, entry.version, 'requires[].version');
    if (entry.package === pkg.name) {
      throw new ValidationError(`${label}: a package cannot require a capability from itself`);
    }
    const key = `${entry.package}/${entry.capability}@${entry.version}`;
    if (required.has(key)) throw new ValidationError(`${label}: duplicate requirement ${key}`);
    required.add(key);
  }

  // Capabilities this package offers to others: the ONLY way another package
  // may reach it. `create` receives the caller's runtime handles, so a
  // capability participates in the caller's transaction without ever exposing
  // a private service or table.
  const offered = new Set();
  for (const entry of pkg.capabilities ?? []) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ValidationError(`${label}: each capability entry must be an object`);
    }
    if (typeof entry.name !== 'string' || !NAME_RE.test(entry.name)) {
      throw new ValidationError(`${label}: capability name must match ${NAME_RE}`);
    }
    assertVersion(label, entry.version, 'capability version');
    if (typeof entry.create !== 'function') {
      throw new ValidationError(`${label}: capability "${entry.name}" must declare create()`);
    }
    if (entry.description !== undefined && (typeof entry.description !== 'string' || entry.description.length > MAX_DESCRIPTION)) {
      throw new ValidationError(`${label}: capability "${entry.name}" description must be a bounded string`);
    }
    const key = `${entry.name}@${entry.version}`;
    if (offered.has(key)) throw new ValidationError(`${label}: duplicate capability ${key}`);
    offered.add(key);
  }

  for (const entry of pkg.policies ?? []) {
    if (!entry || typeof entry !== 'object') {
      throw new ValidationError(`${label}: each policy entry must be an object`);
    }
    if (typeof entry.kind !== 'string' || !NAME_RE.test(entry.kind)) {
      throw new ValidationError(`${label}: policy kind must match ${NAME_RE}`);
    }
    assertPolicyIdentity(`${label} policy kind "${entry.kind}"`, entry.definition);
  }

  // Declared application-scoped operations (ADR-032): bounded identities the
  // composition attaches generically. Absent means absent — no contract bump.
  const declaredOperations = new Set();
  const declaredAliases = new Set();
  for (const entry of pkg.operations ?? []) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ValidationError(`${label}: each operations entry must be an object`);
    }
    if (entry.operationContract !== SUPPORTED_OPERATION_CONTRACT) {
      throw new ValidationError(
        `${label}: operations[].operationContract must be ${SUPPORTED_OPERATION_CONTRACT} (received ${JSON.stringify(entry.operationContract)})`,
      );
    }
    if (typeof entry.name !== 'string' || !NAME_RE.test(entry.name) || entry.name.length > MAX_NAME) {
      throw new ValidationError(`${label}: operation name must match ${NAME_RE} and be at most ${MAX_NAME} characters`);
    }
    if (declaredOperations.has(entry.name)) {
      throw new ValidationError(`${label}: duplicate operation "${entry.name}"`);
    }
    declaredOperations.add(entry.name);
    if (entry.label !== undefined && (typeof entry.label !== 'string' || entry.label.length === 0 || entry.label.length > MAX_LABEL)) {
      throw new ValidationError(`${label}: operation "${entry.name}" label must be a non-empty string of at most ${MAX_LABEL} characters`);
    }
    if (entry.description !== undefined && (typeof entry.description !== 'string' || entry.description.length > MAX_DESCRIPTION)) {
      throw new ValidationError(`${label}: operation "${entry.name}" description must be a bounded string`);
    }
    if (entry.appMethod !== undefined) {
      if (typeof entry.appMethod !== 'string' || !APP_METHOD_RE.test(entry.appMethod) || entry.appMethod.length > MAX_NAME) {
        throw new ValidationError(`${label}: operation "${entry.name}" appMethod must match ${APP_METHOD_RE} and be at most ${MAX_NAME} characters`);
      }
      if (declaredAliases.has(entry.appMethod)) {
        throw new ValidationError(`${label}: duplicate operation appMethod "${entry.appMethod}"`);
      }
      declaredAliases.add(entry.appMethod);
    }
    if (entry.input !== undefined) {
      if (!Array.isArray(entry.input)) {
        throw new ValidationError(`${label}: operation "${entry.name}" input must be an array`);
      }
      const seen = new Set();
      for (const field of entry.input) {
        if (!field || typeof field !== 'object' || typeof field.name !== 'string' || !APP_METHOD_RE.test(field.name)) {
          throw new ValidationError(`${label}: operation "${entry.name}" inputs need camelCase names`);
        }
        if (seen.has(field.name)) {
          throw new ValidationError(`${label}: operation "${entry.name}" duplicate input "${field.name}"`);
        }
        seen.add(field.name);
        if (!OPERATION_INPUT_TYPES.has(field.type)) {
          throw new ValidationError(
            `${label}: operation "${entry.name}" input "${field.name}" type must be one of: ${[...OPERATION_INPUT_TYPES].join(', ')}`,
          );
        }
        if (field.type === 'enum' && (!Array.isArray(field.values) || field.values.length === 0 || field.values.some((value) => typeof value !== 'string'))) {
          throw new ValidationError(`${label}: operation "${entry.name}" enum input "${field.name}" needs string values`);
        }
        if (field.hint !== undefined && (typeof field.hint !== 'string' || field.hint.length > 200)) {
          throw new ValidationError(`${label}: operation "${entry.name}" input "${field.name}" hint must be a string of at most 200 characters`);
        }
      }
    }
    if (typeof entry.create !== 'function') {
      throw new ValidationError(`${label}: operation "${entry.name}" must declare create()`);
    }
  }
  return pkg;
}


/**
 * The keys the registry computes from the composition. A package's own
 * `metadata()` may add to the schema block; it may never restate one of these,
 * because a reader uses them to know what the application actually registered.
 */
const RESERVED_METADATA_KEYS = Object.freeze([
  'packageContract', 'version', 'label', 'description',
  'resources', 'requires', 'provides', 'actions', 'policies', 'operations',
]);

/**
 * `metadata()` is served to every client at `/api/schema` and printed by
 * `package inspect`. "Function-free, plain data" is the contract; a function
 * would vanish silently through JSON and survive in-process, so it is refused
 * where it is written instead.
 *
 * @param {string} name @param {unknown} value @param {string} path
 */
function assertPlainMetadata(name, value, path) {
  // `null` and `undefined` are what JSON already does with an absent value.
  if (value === null || value === undefined) return;
  const type = typeof value;
  if (type === 'function') {
    throw new AppError(`Domain package "${name}" metadata() must be function-free (${path} is a function)`, {
      code: 'DOMAIN_METADATA_INVALID', status: 500,
    });
  }
  if (type === 'string' || type === 'boolean') return;
  if (type === 'number') {
    if (!Number.isFinite(value)) {
      throw new AppError(`Domain package "${name}" metadata() must be JSON-safe (${path} is ${String(value)})`, {
        code: 'DOMAIN_METADATA_INVALID', status: 500,
      });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertPlainMetadata(name, item, `${path}[${index}]`));
    return;
  }
  if (type === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new AppError(`Domain package "${name}" metadata() must be plain data (${path} is a class instance)`, {
        code: 'DOMAIN_METADATA_INVALID', status: 500,
      });
    }
    for (const [key, item] of Object.entries(value)) assertPlainMetadata(name, item, `${path}.${key}`);
    return;
  }
  throw new AppError(`Domain package "${name}" metadata() must be JSON-safe (${path} is ${type})`, {
    code: 'DOMAIN_METADATA_INVALID', status: 500,
  });
}

/**
 * Per-app registry of optional domain packages. One malformed definition, one
 * collision or one unsatisfiable dependency stops startup — a half-registered
 * domain is never served.
 */
export class PackageRegistry {
  /** @type {Map<string, any>} */
  #packages;
  /** @type {Map<string, {domain: string, kind: string, definition: any, fingerprint: string}>} */
  #policies;
  /** @type {Map<string, {package: string, entry: any}>} */
  #capabilities;
  /** @type {Map<string, string>} */
  #resources;

  /** @param {{domains?: any[], packages?: any[]}} [definitions] */

  constructor(definitions = {}) {
    const list = definitions.packages ?? definitions.domains ?? [];
    // One set of composition rules, two presentations. `resolvePackageComposition`
    // collects every problem; the registry needs the first one and needs to
    // stop, because a half-registered composition must never boot. The
    // inspector prints them all. Neither can drift from the other, because
    // there is nothing to drift.
    const resolved = resolvePackageComposition(list);
    if (resolved.problems.length > 0) {
      const first = resolved.problems[0];
      throw first.error ?? new ValidationError(first.message);
    }
    this.#packages = resolved.packages;
    this.#resources = resolved.resources;
    this.#capabilities = resolved.capabilities;
    this.#policies = resolved.policies;
  }

  /** Every action contributed by every registered package, in registration order. */
  actions() {
    return [...this.#packages.values()].flatMap((pkg) => pkg.actions ?? []);
  }

  /**
   * Every declared application-scoped operation with its owning package, in
   * registration order (ADR-032). The composition consumes this to build and
   * attach operations generically; the entries are the validated declarations.
   */
  operations() {
    return [...this.#packages.values()].flatMap((pkg) => (pkg.operations ?? [])
      .map((entry) => ({ package: pkg.name, entry })));
  }

  /** How many packages are registered. The composition, not the definitions. */
  get size() {
    return this.#packages.size;
  }

  /** Registered package names, in registration order. */
  names() {
    return Object.freeze([...this.#packages.keys()]);
  }

  /** Every declared resource and the package that owns it, sorted and frozen. */
  resources() {
    return Object.freeze([...this.#resources.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([resource, owner]) => Object.freeze({ resource, package: owner })));
  }

  /**
   * A package's public identity: what it is, what it owns and what it declares.
   *
   * Deliberately **not** the definition. Handing back the definition would hand
   * back `capabilities[].create` and the policy handlers with it, so the
   * declared-requirement check would be one property access deep — enforcement
   * on the polite path only. A frozen summary carries no function and no
   * mutable index, so the declaration stays the truth rather than a comment.
   *
   * @param {string} name
   */
  get(name) {
    const pkg = this.#packages.get(name);
    if (!pkg) throw new NotFoundError('Domain package', String(name));
    return Object.freeze({
      name: pkg.name,
      version: pkg.version,
      label: pkg.label ?? pkg.name,
      ...(pkg.description ? { description: pkg.description } : {}),
      resources: Object.freeze([...(pkg.resources ?? [])].sort()),
      requires: Object.freeze((pkg.requires ?? [])
        .map((entry) => Object.freeze({ package: entry.package, capability: entry.capability, version: entry.version }))),
      provides: Object.freeze((pkg.capabilities ?? [])
        .map((entry) => Object.freeze({ name: entry.name, version: entry.version }))),
      actions: Object.freeze((pkg.actions ?? []).map((action) => `${action.module}.${action.name}`).sort()),
      operations: Object.freeze((pkg.operations ?? [])
        .map((entry) => Object.freeze({ name: entry.name, ...(entry.appMethod ? { appMethod: entry.appMethod } : {}) }))),
    });
  }

  /** @param {string} name */
  has(name) {
    return this.#packages.has(name);
  }

  /**
   * Resolve a versioned domain policy. Map-backed, so `__proto__` and friends
   * simply do not exist, and a version is always explicit — never an implicit
   * "latest".
   * @param {string} domain @param {string} kind @param {string} name @param {number} version
   */
  getPolicy(domain, kind, name, version) {
    const entry = this.#policies.get(`${domain}/${kind}/${name}@${version}`);
    if (!entry) throw new NotFoundError('Domain policy', `${domain}/${kind}/${name}@${version}`);
    return entry;
  }

  /**
   * Open a capability another package declared. The consumer must have
   * declared the requirement — an undeclared reach across the boundary is
   * refused even when the capability exists, so the dependency graph in the
   * package definition is the truth rather than a comment.
   *
   * `context` carries the caller's runtime handles (its `modules` view), so the
   * capability reads and writes inside the caller's transaction while the
   * provider keeps its services and tables private. The registry adds one key
   * of its own, `consumer`: the resolved consumer identity, so a provider that
   * records provenance binds the name the registry proved rather than one the
   * caller retypes in a payload.
   *
   * @param {{consumer: string, capability: string, version: number, context?: any}} request
   */
  capability({ consumer, capability, version, context = {} }) {
    const requester = this.#packages.get(consumer);
    if (!requester) throw new NotFoundError('Domain package', String(consumer));
    const declaration = (requester.requires ?? []).find(
      (entry) => entry.capability === capability && entry.version === version,
    );
    if (!declaration) {
      throw new AppError(
        `Package "${consumer}" did not declare a requirement on ${capability}@${version}`,
        { code: 'CAPABILITY_NOT_DECLARED', status: 500 },
      );
    }
    const offered = this.#capabilities.get(`${capability}@${version}`);
    if (!offered) throw new NotFoundError('Package capability', `${capability}@${version}`);
    // Startup already proved the declared provider offers this capability;
    // re-checking here means the identity in the declaration is the one that
    // answers, not merely whichever package happens to hold the name.
    if (offered.package !== declaration.package) {
      throw new AppError(
        `Package "${consumer}" declared ${capability}@${version} from "${declaration.package}", `
          + `but it is offered by "${offered.package}"`,
        { code: 'CAPABILITY_PROVIDER_MISMATCH', status: 500 },
      );
    }
    // The registry knows who is asking — it just proved it against the
    // consumer's own `requires`. Handing that identity to the provider means a
    // provider that records provenance can bind it to the package the registry
    // resolved, instead of trusting a name the caller repeats in its payload.
    // `consumer` always wins: a context that carries its own is overwritten, so
    // this cannot be spoofed by the caller either. Generic — the registry knows
    // nothing about what any provider does with it.
    const value = offered.entry.create({ ...context, consumer });
    if (!value || typeof value !== 'object') {
      throw new AppError(`Capability ${capability}@${version} did not return an interface`, {
        code: 'CAPABILITY_INVALID', status: 500,
      });
    }
    return value;
  }

  /**
   * Persist-or-verify every policy identity in `definition_versions`, in one
   * transaction (ADR-015 semantics): editing a registered version's source or
   * config stops the next boot, and rollback means publishing a new version.
   * The definition-version store owns that loop; the registry only names the
   * identities the composition publishes.
   * @param {any} database
   */
  persistFingerprints(database) {
    const entries = [...this.#policies.values()];
    if (entries.length === 0) return;
    createDefinitionVersionStore(database).persist(entries.map((entry) => ({
      type: `domain-policy:${entry.domain}:${entry.kind}`,
      name: entry.definition.name,
      version: entry.definition.version,
      fingerprint: entry.fingerprint,
    })));
  }

  /**
   * Serializable, function-free metadata for `/api/schema`. A package's own
   * `metadata()` is called once and must return plain data; anything else is a
   * startup-time defect surfaced as a stable error rather than a broken
   * schema response.
   */
  metadata() {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [name, pkg] of [...this.#packages.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const declared = typeof pkg.metadata === 'function' ? pkg.metadata() : {};
      if (declared === null || typeof declared !== 'object' || Array.isArray(declared)) {
        throw new AppError(`Domain package "${name}" metadata() must return a plain object`, {
          code: 'DOMAIN_METADATA_INVALID', status: 500,
        });
      }
      assertPlainMetadata(name, declared, 'metadata()');
      // The composition owns the graph. A package that restates one of these
      // keys would publish a dependency list, a version or a policy fingerprint
      // that does not describe the running application — and `package inspect`
      // would disagree with `/api/schema` without either surface saying so.
      for (const key of RESERVED_METADATA_KEYS) {
        if (Object.prototype.hasOwnProperty.call(declared, key)) {
          throw new AppError(
            `Domain package "${name}" metadata() may not redeclare "${key}": the registry publishes it from the composition`,
            { code: 'DOMAIN_METADATA_INVALID', status: 500 },
          );
        }
      }
      out[name] = {
        ...declared,
        packageContract: SUPPORTED_PACKAGE_CONTRACT,
        version: pkg.version,
        label: pkg.label ?? name,
        ...(pkg.description ? { description: pkg.description } : {}),
        resources: [...(pkg.resources ?? [])].sort(),
        requires: (pkg.requires ?? [])
          .map((entry) => ({ package: entry.package, capability: entry.capability, version: entry.version }))
          .sort((a, b) => (`${a.package}/${a.capability}` < `${b.package}/${b.capability}` ? -1 : 1)),
        provides: (pkg.capabilities ?? [])
          .map((entry) => ({
            name: entry.name,
            version: entry.version,
            ...(entry.description ? { description: entry.description } : {}),
          }))
          .sort((a, b) => (a.name === b.name ? a.version - b.version : a.name < b.name ? -1 : 1)),
        actions: (pkg.actions ?? []).map((action) => `${action.module}.${action.name}`).sort(),
        // Declared application-scoped operations (ADR-032): names and aliases
        // only — function-free, additive, gone when the package detaches.
        operations: (pkg.operations ?? [])
          .map((entry) => ({
            name: entry.name,
            ...(entry.label ? { label: entry.label } : {}),
            ...(entry.appMethod ? { appMethod: entry.appMethod } : {}),
          }))
          .sort((a, b) => (a.name < b.name ? -1 : 1)),
        policies: [...this.#policies.values()]
          .filter((entry) => entry.domain === name)
          .map((entry) => ({
            kind: entry.kind,
            name: entry.definition.name,
            version: entry.definition.version,
            label: entry.definition.label ?? entry.definition.name,
            fingerprint: entry.fingerprint,
          }))
          .sort((a, b) => (a.kind === b.kind ? a.version - b.version : a.kind < b.kind ? -1 : 1)),
      };
    }
    return out;
  }

  /**
   * The registration report the CLI prints: identity, dependencies, what each
   * package owns, and nothing executable. Deterministic, so two runs of
   * `package inspect` on the same tree produce the same bytes.
   */
  report() {
    return {
      packageContract: SUPPORTED_PACKAGE_CONTRACT,
      packages: [...this.#packages.values()]
        .map((pkg) => ({
          name: pkg.name,
          version: pkg.version,
          label: pkg.label ?? pkg.name,
          resources: [...(pkg.resources ?? [])].sort(),
          actions: (pkg.actions ?? []).map((action) => `${action.module}.${action.name}`).sort(),
          policies: [...this.#policies.values()]
            .filter((entry) => entry.domain === pkg.name)
            .map((entry) => `${entry.kind}/${entry.definition.name}@${entry.definition.version}`)
            .sort(),
          requires: (pkg.requires ?? []).map((entry) => `${entry.package}/${entry.capability}@${entry.version}`).sort(),
          provides: (pkg.capabilities ?? []).map((entry) => `${entry.name}@${entry.version}`).sort(),
        }))
        .sort((a, b) => (a.name < b.name ? -1 : 1)),
    };
  }
}

/** Historical name kept for the composition seam; the contract is the package one. */
export { PackageRegistry as DomainRegistries };
export { validatePackageDefinition as validateDomainDefinition };
