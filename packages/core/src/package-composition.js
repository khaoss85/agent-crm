// @ts-check

import { AppError, ValidationError } from './errors.js';
import { computeDefinitionFingerprint } from './definition-fingerprint.js';
import { validatePackageDefinitionForComposition } from './package-registry.js';
import { observedPackageValidationName } from './package-validation-receipt.js';
import { SUPPORTED_PACKAGE_CONTRACTS } from './package-contract-versions.js';

/**
 * **Composition resolution** — the rules that decide whether a set of package
 * definitions forms a valid application, collected rather than thrown.
 *
 * `PackageRegistry` needs the first problem and needs to stop: a half-registered
 * composition must never boot. An inspector needs *every* problem, because "what
 * is wrong with my application" is the whole question it exists to answer, and a
 * report that stops at the first fault sends its reader back to guessing.
 *
 * Those are two presentations of one set of rules, so they live here once. The
 * registry calls this and throws `problems[0]`; the inspector calls this and
 * prints all of them. They cannot drift apart, because there is nothing to
 * drift.
 *
 * The order problems are collected in is the order the registry used to
 * discover them — per package, then dependencies, then cycles — so the error a
 * boot produces is unchanged, message for message.
 *
 * This function reads no file, opens no database and calls no capability. It is
 * pure over the definitions it is given.
 */

/**
 * @typedef {{
 *   code: string, message: string, package?: string,
 *   capability?: string, resource?: string, path?: string[],
 *   error?: Error,
 * }} CompositionProblem
 */

/** A first-observed name safe to put in a problem without rereading source. */
function safeName(name) {
  return typeof name === 'string' ? name.slice(0, 64) : '(unnamed)';
}

function isKnownContract(value) {
  return SUPPORTED_PACKAGE_CONTRACTS.includes(value);
}

const MAX_CONTRACT_DIAGNOSTIC_IDENTITY = 160;

/**
 * A declared identity is data in diagnostics, never an unbounded response.
 * Action and capability names remain length-compatible with v1 and rely on
 * this boundary. Operation names already have a 64-character declaration
 * limit; rendering them here too keeps the response bounded in depth.
 */
function contractDiagnosticIdentity(value) {
  const text = String(value);
  return text.length <= MAX_CONTRACT_DIAGNOSTIC_IDENTITY
    ? text
    : `${text.slice(0, MAX_CONTRACT_DIAGNOSTIC_IDENTITY)}…`;
}

function asyncContractError(message, details) {
  return new AppError(message, {
    code: 'PACKAGE_ASYNC_CONTRACT_REQUIRED',
    status: 400,
    details,
  });
}

/**
 * Resolve a composition and report everything wrong with it.
 *
 * @param {any[]} [list] package definitions, in composition order
 * @returns {{
 *   problems: CompositionProblem[],
 *   packages: Map<string, any>,
 *   packageFacts: Map<string, {definition: any, name: string, version: number, packageContract: number, requires: readonly {package: string, capability: string, version: number}[], capabilities: readonly any[]}>,
 *   resources: Map<string, string>,
 *   capabilities: Map<string, {package: string, entry: any, name: string, version: number, capabilityContract: number, description?: string}>,
 *   policies: Map<string, {domain: string, kind: string, definition: any, fingerprint: string}>,
 * }}
 */
export function resolvePackageComposition(list = []) {
  /** @type {CompositionProblem[]} */
  const problems = [];
  /** @type {Map<string, any>} */
  const packages = new Map();
  /** @type {Map<string, {definition: any, name: string, version: number, packageContract: number, requires: readonly {package: string, capability: string, version: number}[], capabilities: readonly any[]}>} */
  const packageFacts = new Map();
  /** @type {Map<string, string>} */
  const resources = new Map();
  /** @type {Map<string, {package: string, entry: any, name: string, version: number, capabilityContract: number, description?: string}>} */
  const capabilities = new Map();
  /** @type {Map<string, {domain: string, kind: string, definition: any, fingerprint: string}>} */
  const policies = new Map();
  /** @type {Map<string, string>} appMethod alias → owning package (ADR-032) */
  const operationAliases = new Map();

  const fail = (problem) => {
    problems.push({ ...problem, error: problem.error ?? new ValidationError(problem.message) });
  };

  for (const declared of list ?? []) {
    let validated;
    try {
      validated = validatePackageDefinitionForComposition(declared);
    } catch (error) {
      // A definition that does not satisfy the contract is not registered at
      // all: every later rule would be asking questions of a shape that has
      // already failed to be a package.
      fail({
        code: 'PACKAGE_INVALID',
        package: safeName(observedPackageValidationName(error)),
        message: error instanceof Error ? error.message : String(error),
        error: error instanceof Error ? error : undefined,
      });
      continue;
    }
    // Keep the exact validated definition. Package and capability declarations
    // are executable objects: spreading them loses prototypes, accessors,
    // non-enumerable fields and reference identity. The resolved graph carries
    // the one normalized contract fact separately instead.
    const pkg = declared;
    const facts = validated;
    const packageName = facts.name;
    if (packages.has(packageName)) {
      fail({ code: 'PACKAGE_DUPLICATE', package: packageName, message: `Duplicate domain package name: ${packageName}` });
      continue;
    }
    packages.set(packageName, pkg);
    packageFacts.set(packageName, facts);

    // A resource belongs to exactly one package: two packages claiming the
    // same record module would fight over its table and its meaning.
    for (const resource of pkg.resources ?? []) {
      const owner = resources.get(resource);
      if (owner !== undefined) {
        fail({
          code: 'RESOURCE_COLLISION', package: packageName, resource,
          message: `Resource collision: "${resource}" is claimed by packages "${owner}" and "${packageName}"`,
        });
        continue;
      }
      resources.set(resource, packageName);
    }

    for (const fact of facts.capabilities) {
      const key = `${fact.name}@${fact.version}`;
      const existing = capabilities.get(key);
      if (existing !== undefined) {
        const displayedKey = contractDiagnosticIdentity(key);
        fail({
          code: 'CAPABILITY_COLLISION', package: packageName, capability: displayedKey,
          message: `Capability collision: "${displayedKey}" is offered by packages "${existing.package}" and "${packageName}"`,
        });
        continue;
      }
      capabilities.set(key, Object.freeze({
        package: packageName,
        ...fact,
      }));
    }

    // Declared operation aliases share ONE application surface (ADR-032): two
    // packages claiming the same app method would fight over a single key the
    // way two packages claiming a resource would fight over a table.
    for (const entry of pkg.operations ?? []) {
      if (entry.appMethod === undefined) continue;
      const existing = operationAliases.get(entry.appMethod);
      if (existing !== undefined) {
        fail({
          code: 'OPERATION_ALIAS_COLLISION', package: packageName,
          message: `Operation alias collision: app method "${entry.appMethod}" is declared by packages "${existing}" and "${packageName}"`,
        });
        continue;
      }
      operationAliases.set(entry.appMethod, packageName);
    }

    for (const { kind, definition } of pkg.policies ?? []) {
      const key = `${packageName}/${kind}/${definition.name}@${definition.version}`;
      if (policies.has(key)) {
        fail({ code: 'POLICY_DUPLICATE', package: packageName, message: `Duplicate policy identity: ${key}` });
        continue;
      }
      policies.set(key, {
        domain: packageName,
        kind,
        definition,
        // The declared-definition fingerprint (ADR-015): canonical source plus
        // declared JSON-safe config. Closure-held values stay invisible to it,
        // which is why thresholds belong in `config`.
        fingerprint: computeDefinitionFingerprint({
          type: `domain-policy:${kind}`,
          domain: packageName,
          name: definition.name,
          version: definition.version,
          config: definition.config ?? null,
          handlers: Object.keys(definition)
            .filter((property) => typeof definition[property] === 'function')
            .sort()
            .map((property) => ({ property, source: definition[property] })),
        }),
      });
    }
  }

  // Contract 1 is the synchronous graph and contract 2 is the awaitable graph.
  // Accepting both *declarations* does not make them interoperable: a Promise
  // crossing into a v1 consumer looks like an ordinary domain value until the
  // first runtime call. Refuse every mixed edge at composition instead.
  for (const facts of packageFacts.values()) {
    const pkg = facts.definition;
    const members = [
      ...(pkg.actions ?? []).map((entry) => ({
        kind: 'action',
        name: contractDiagnosticIdentity(`${entry.module}.${entry.name}`),
        contract: entry.actionContract,
      })),
      ...(pkg.operations ?? []).map((entry) => ({
        kind: 'operation',
        name: contractDiagnosticIdentity(entry.name),
        contract: entry.operationContract,
      })),
      ...facts.capabilities.map((entry) => ({
        kind: 'capability',
        name: contractDiagnosticIdentity(`${entry.name}@${entry.version}`),
        contract: entry.capabilityContract,
      })),
    ];
    for (const member of members) {
      // The member's own validator owns missing and unknown versions. This
      // check owns only a graph made of individually understood contracts.
      if (!isKnownContract(member.contract) || member.contract === facts.packageContract) continue;
      const message = `Package "${facts.name}" declares packageContract ${facts.packageContract}, but its `
        + `${member.kind} "${member.name}" declares contract ${member.contract}; sync-v1 and async-v2 contracts cannot share one package graph`;
      fail({
        code: 'PACKAGE_ASYNC_CONTRACT_REQUIRED',
        package: facts.name,
        message,
        error: asyncContractError(message, {
          package: facts.name,
          packageContract: facts.packageContract,
          memberKind: member.kind,
          member: member.name,
          memberContract: member.contract,
        }),
      });
    }
  }

  // Every declared requirement must be offered by a registered package at the
  // declared version. A package that silently loses a dependency would fail
  // later, inside a transaction.
  for (const facts of packageFacts.values()) {
    for (const entry of facts.requires) {
      const requiredCapability = contractDiagnosticIdentity(`${entry.capability}@${entry.version}`);
      const provider = packageFacts.get(entry.package);
      if (!provider) {
        fail({
          code: 'DEPENDENCY_MISSING_PACKAGE', package: facts.name, capability: requiredCapability,
          message: `Package "${facts.name}" requires package "${entry.package}", which is not registered`,
        });
        continue;
      }
      const offered = capabilities.get(`${entry.capability}@${entry.version}`);
      if (!offered || offered.package !== entry.package) {
        const available = [...capabilities.entries()]
          .filter(([, value]) => value.package === entry.package)
          .map(([key]) => contractDiagnosticIdentity(key));
        const displayedAvailable = contractDiagnosticIdentity(available.join(', ') || 'none');
        fail({
          code: 'DEPENDENCY_UNSATISFIED', package: facts.name, capability: requiredCapability,
          message: `Package "${facts.name}" requires "${entry.package}" capability ${requiredCapability}, `
            + `which it does not offer (offers: ${displayedAvailable})`,
        });
        continue;
      }
      if (facts.packageContract !== offered.capabilityContract) {
        const capability = contractDiagnosticIdentity(`${entry.capability}@${entry.version}`);
        const message = `Package "${facts.name}" uses packageContract ${facts.packageContract}, but requires `
          + `"${entry.package}" capability ${capability} with capabilityContract `
          + `${offered.capabilityContract}; sync-v1 and async-v2 contracts cannot share one dependency edge`;
        fail({
          code: 'PACKAGE_ASYNC_CONTRACT_REQUIRED',
          package: facts.name,
          capability,
          message,
          error: asyncContractError(message, {
            package: facts.name,
            packageContract: facts.packageContract,
            provider: entry.package,
            capability: contractDiagnosticIdentity(entry.capability),
            capabilityVersion: entry.version,
            capabilityContract: offered.capabilityContract,
          }),
        });
      }
    }
  }

  const graphContracts = new Map();
  for (const facts of packageFacts.values()) {
    if (!graphContracts.has(facts.packageContract)) graphContracts.set(facts.packageContract, facts.name);
  }
  if (graphContracts.size > 1) {
    const entries = [...graphContracts.entries()].sort(([a], [b]) => a - b);
    const message = `Package graph mixes ${entries.map(([contract, name]) => `packageContract ${contract} ("${name}")`).join(' and ')}; `
      + 'sync-v1 and async-v2 packages must be composed in separate application graphs';
    fail({
      code: 'PACKAGE_ASYNC_CONTRACT_REQUIRED',
      message,
      error: asyncContractError(message, {
        packages: [...packageFacts.values()].map((facts) => ({
          name: facts.name,
          packageContract: facts.packageContract,
        })),
      }),
    });
  }

  // Depth-first cycle detection over the declared graph. Each cycle is reported
  // once, keyed by the set of packages in it, so a three-package cycle does not
  // arrive three times in a different rotation.
  const state = new Map();
  const seenCycles = new Set();
  const visit = (name, trail) => {
    const mark = state.get(name);
    if (mark === 'done') return;
    if (mark === 'visiting') {
      const cycle = [...trail.slice(trail.indexOf(name)), name];
      const key = [...cycle].slice(0, -1).sort().join(',');
      if (!seenCycles.has(key)) {
        seenCycles.add(key);
        fail({
          code: 'DEPENDENCY_CYCLE', package: name, path: cycle,
          message: `Cyclic package dependency: ${[...trail, name].join(' → ')}`,
        });
      }
      return;
    }
    state.set(name, 'visiting');
    for (const entry of packageFacts.get(name)?.requires ?? []) {
      if (packages.has(entry.package)) visit(entry.package, [...trail, name]);
    }
    state.set(name, 'done');
  };
  for (const name of packages.keys()) visit(name, []);

  return { problems, packages, packageFacts, resources, capabilities, policies };
}
