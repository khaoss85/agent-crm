// @ts-check

import { ValidationError } from './errors.js';
import { computeDefinitionFingerprint } from './definition-fingerprint.js';
import { validatePackageDefinition } from './package-registry.js';

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

/** A name safe to put in a problem, whatever the definition actually is. */
function safeName(pkg) {
  const name = pkg && typeof pkg === 'object' ? /** @type {any} */ (pkg).name : undefined;
  return typeof name === 'string' ? name.slice(0, 64) : '(unnamed)';
}

/**
 * Resolve a composition and report everything wrong with it.
 *
 * @param {any[]} [list] package definitions, in composition order
 * @returns {{
 *   problems: CompositionProblem[],
 *   packages: Map<string, any>,
 *   resources: Map<string, string>,
 *   capabilities: Map<string, {package: string, entry: any}>,
 *   policies: Map<string, {domain: string, kind: string, definition: any, fingerprint: string}>,
 * }}
 */
export function resolvePackageComposition(list = []) {
  /** @type {CompositionProblem[]} */
  const problems = [];
  /** @type {Map<string, any>} */
  const packages = new Map();
  /** @type {Map<string, string>} */
  const resources = new Map();
  /** @type {Map<string, {package: string, entry: any}>} */
  const capabilities = new Map();
  /** @type {Map<string, {domain: string, kind: string, definition: any, fingerprint: string}>} */
  const policies = new Map();
  /** @type {Map<string, string>} appMethod alias → owning package (ADR-032) */
  const operationAliases = new Map();

  const fail = (problem) => {
    problems.push({ ...problem, error: problem.error ?? new ValidationError(problem.message) });
  };

  for (const pkg of list ?? []) {
    try {
      validatePackageDefinition(pkg);
    } catch (error) {
      // A definition that does not satisfy the contract is not registered at
      // all: every later rule would be asking questions of a shape that has
      // already failed to be a package.
      fail({
        code: 'PACKAGE_INVALID',
        package: safeName(pkg),
        message: error instanceof Error ? error.message : String(error),
        error: error instanceof Error ? error : undefined,
      });
      continue;
    }
    if (packages.has(pkg.name)) {
      fail({ code: 'PACKAGE_DUPLICATE', package: pkg.name, message: `Duplicate domain package name: ${pkg.name}` });
      continue;
    }
    packages.set(pkg.name, pkg);

    // A resource belongs to exactly one package: two packages claiming the
    // same record module would fight over its table and its meaning.
    for (const resource of pkg.resources ?? []) {
      const owner = resources.get(resource);
      if (owner !== undefined) {
        fail({
          code: 'RESOURCE_COLLISION', package: pkg.name, resource,
          message: `Resource collision: "${resource}" is claimed by packages "${owner}" and "${pkg.name}"`,
        });
        continue;
      }
      resources.set(resource, pkg.name);
    }

    for (const entry of pkg.capabilities ?? []) {
      const key = `${entry.name}@${entry.version}`;
      const existing = capabilities.get(key);
      if (existing !== undefined) {
        fail({
          code: 'CAPABILITY_COLLISION', package: pkg.name, capability: key,
          message: `Capability collision: "${key}" is offered by packages "${existing.package}" and "${pkg.name}"`,
        });
        continue;
      }
      capabilities.set(key, { package: pkg.name, entry });
    }

    // Declared operation aliases share ONE application surface (ADR-032): two
    // packages claiming the same app method would fight over a single key the
    // way two packages claiming a resource would fight over a table.
    for (const entry of pkg.operations ?? []) {
      if (entry.appMethod === undefined) continue;
      const existing = operationAliases.get(entry.appMethod);
      if (existing !== undefined) {
        fail({
          code: 'OPERATION_ALIAS_COLLISION', package: pkg.name,
          message: `Operation alias collision: app method "${entry.appMethod}" is declared by packages "${existing}" and "${pkg.name}"`,
        });
        continue;
      }
      operationAliases.set(entry.appMethod, pkg.name);
    }

    for (const { kind, definition } of pkg.policies ?? []) {
      const key = `${pkg.name}/${kind}/${definition.name}@${definition.version}`;
      if (policies.has(key)) {
        fail({ code: 'POLICY_DUPLICATE', package: pkg.name, message: `Duplicate policy identity: ${key}` });
        continue;
      }
      policies.set(key, {
        domain: pkg.name,
        kind,
        definition,
        // The declared-definition fingerprint (ADR-015): canonical source plus
        // declared JSON-safe config. Closure-held values stay invisible to it,
        // which is why thresholds belong in `config`.
        fingerprint: computeDefinitionFingerprint({
          type: `domain-policy:${kind}`,
          domain: pkg.name,
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

  // Every declared requirement must be offered by a registered package at the
  // declared version. A package that silently loses a dependency would fail
  // later, inside a transaction.
  for (const pkg of packages.values()) {
    for (const entry of pkg.requires ?? []) {
      const provider = packages.get(entry.package);
      if (!provider) {
        fail({
          code: 'DEPENDENCY_MISSING_PACKAGE', package: pkg.name, capability: `${entry.capability}@${entry.version}`,
          message: `Package "${pkg.name}" requires package "${entry.package}", which is not registered`,
        });
        continue;
      }
      const offered = capabilities.get(`${entry.capability}@${entry.version}`);
      if (!offered || offered.package !== entry.package) {
        const available = [...capabilities.entries()]
          .filter(([, value]) => value.package === entry.package)
          .map(([key]) => key);
        fail({
          code: 'DEPENDENCY_UNSATISFIED', package: pkg.name, capability: `${entry.capability}@${entry.version}`,
          message: `Package "${pkg.name}" requires "${entry.package}" capability ${entry.capability}@${entry.version}, `
            + `which it does not offer (offers: ${available.join(', ') || 'none'})`,
        });
      }
    }
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
    for (const entry of packages.get(name)?.requires ?? []) {
      if (packages.has(entry.package)) visit(entry.package, [...trail, name]);
    }
    state.set(name, 'done');
  };
  for (const name of packages.keys()) visit(name, []);

  return { problems, packages, resources, capabilities, policies };
}
