// @ts-check

import { readFileSync } from 'node:fs';
import {
  PackageRegistry,
} from '../../core/index.js';
import { resolvePackageComposition } from '../../core/src/package-composition.js';
import { validatePackageDefinitionForComposition } from '../../core/src/package-registry.js';
import { SUPPORTED_PACKAGE_CONTRACTS } from '../../core/src/package-contract-versions.js';
import { importSpecifiers, importsPrivateKernelPath, packageSources } from './package-sources.js';

/**
 * The conformance checks that need no database and no boot.
 *
 * Every one of them is **mechanical**: it applies to any package, with no
 * knowledge of what the package is for. Where a question cannot be answered
 * without knowing the domain, it is not asked here and is reported as skipped
 * with a reason — a check that quietly passes because it could not run is worse
 * than no check.
 *
 * Each check names the authority that produced its verdict, so a reader can go
 * and re-run that authority rather than trusting this file.
 */

/** @type {'passed'|'failed'|'skipped'|'not_applicable'} */
const PASSED = 'passed';

/**
 * The authority a check speaks for. A conformance kit that invents rules is a
 * second, undocumented package contract, so every row names where its rule
 * comes from and a reader can go and re-read that rule.
 *
 *   package-contract  `validatePackageDefinition` — ADR-018's contract itself
 *   composition       `resolvePackageComposition` / `PackageRegistry`
 *   authoring-rule    `docs/PACKAGE_AUTHORING.md` + `tests/helpers/package-conformance.js`,
 *                     the rules every package in this repository already follows
 *   module-factory    the manifest, state-file and migration machinery
 *   application-boot  `createAccordoApp` — what actually happens at startup
 *   app-inspect       AX1's report of the composed project
 *
 * There is deliberately no `dx4` authority. A rule this command would have had
 * to invent is either advisory or absent.
 */
export const AUTHORITIES = Object.freeze([
  'package-contract', 'composition', 'authoring-rule', 'module-factory',
  'application-boot', 'app-inspect',
]);

/**
 * A check row. `evidence` is what was observed; `reason` is why it did not run;
 * `authority` is the rule it speaks for.
 */
function check(id, category, status, evidence, reason, authority) {
  const row = { id, category, status, evidence };
  if (reason !== undefined) row.reason = reason;
  if (authority !== undefined) row.authority = authority;
  return row;
}

/** Sorted, so two runs of the same package produce the same document. */
export function sortChecks(checks) {
  return [...checks].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Identity, declaration shape and the published graph — the questions
 * `validatePackageDefinition` and `PackageRegistry` already answer.
 *
 * @param {{definition: any, dir: string, rootDir: string}} params
 */
export function runDeclarationChecks({ definition, dir }) {
  const checks = [];
  const problems = [];

  let valid = true;
  let validated = null;
  try {
    validated = validatePackageDefinitionForComposition(definition);
  } catch (error) {
    valid = false;
    problems.push({ code: 'PACKAGE_INVALID', message: error instanceof Error ? error.message : String(error) });
  }
  checks.push(check('declaration.valid', 'declaration', valid ? PASSED : 'failed',
    valid ? 'validatePackageDefinition accepted the definition' : 'validatePackageDefinition refused the definition',
    undefined, 'package-contract'));

  const declared = valid ? validated.packageContract : definition?.packageContract;
  checks.push(check('declaration.contract', 'declaration',
    // The accepted SET, not the emitted version. Checking against the single
    // current version would fail a package the registry accepts — a conformance
    // kit contradicting the contract it exists to prove.
    SUPPORTED_PACKAGE_CONTRACTS.includes(declared) ? PASSED : 'failed',
    `declares packageContract ${JSON.stringify(declared)}; this framework supports ${SUPPORTED_PACKAGE_CONTRACTS.join(', ')}`,
    undefined, 'package-contract'));

  const declaredLabel = definition?.label;
  const hasLabel = typeof declaredLabel === 'string' && declaredLabel.length > 0;
  checks.push(check('declaration.label', 'declaration', hasLabel ? PASSED : 'failed',
    hasLabel
      ? 'has a human label'
      : 'a package without a label is unreadable in every report that lists it. `validatePackageDefinition` allows one to be absent; every package in this repository has one',
    undefined, 'authoring-rule'));

  // Resources, actions, requires and provides as the registry publishes them.
  const resourceDefinitions = definition?.resources ?? [];
  const actionDefinitions = definition?.actions ?? [];
  const resources = [...resourceDefinitions].sort();
  const actions = actionDefinitions.map((action) => `${action?.module}.${action?.name}`).sort();
  const requires = (valid ? validated.requires : (definition?.requires ?? []))
    .map((entry) => `${entry?.package}/${entry?.capability}@${entry?.version}`).sort();
  const provides = valid
    ? validated.capabilities.map((entry) => `${entry.name}@${entry.version}`).sort()
    : (definition?.capabilities ?? []).map((entry) => `${entry?.name}@${entry?.version}`).sort();
  checks.push(check('declaration.surface', 'declaration', PASSED,
    `${resources.length} resource(s), ${actions.length} action(s), ${requires.length} declared dependency(ies), ${provides.length} capability(ies) offered`,
    undefined, 'package-contract'));

  if (!valid) {
    return { checks, problems, published: { resources, actions, requires, provides } };
  }

  // These observers are used only by the accepted-declaration probes. Keep
  // them after the validity gate so an earlier identity failure retains its
  // historical precedence over later executable getters.
  const policyDefinitions = definition?.policies ?? [];
  const operationDefinitions = definition?.operations ?? [];
  const declaredDescription = definition?.description;

  // Build invariant probes from the exact facts the first validation accepted.
  // Re-reading package/capability accessors would let a mutable getter make the
  // declaration report contradict `declaration.valid`; spreading the authored
  // object also destroys class/private receivers. Only the five graph facts
  // under M2E-1's first-read guarantee are snapshotted. Existing resource,
  // action, policy and operation behavior keeps its historical boundary.
  const capabilityProbes = validated.capabilities.map((fact) => ({
    name: fact.name,
    version: fact.version,
    capabilityContract: fact.capabilityContract,
    ...(fact.description === undefined ? {} : { description: fact.description }),
    create(...args) { return fact.entry.create(...args); },
  }));
  const metadataMethod = definition?.metadata;
  const acceptedProbe = {
    packageContract: validated.packageContract,
    name: validated.name,
    version: validated.version,
    ...(declaredLabel === undefined ? {} : { label: declaredLabel }),
    ...(declaredDescription === undefined ? {} : { description: declaredDescription }),
    resources: resourceDefinitions,
    actions: actionDefinitions,
    policies: policyDefinitions,
    operations: operationDefinitions,
    requires: [],
    capabilities: capabilityProbes,
    ...(typeof metadataMethod === 'function'
      ? { metadata() { return metadataMethod.call(definition); } }
      : {}),
  };

  // Metadata: data, never behaviour, and the same twice.
  let metadata = null;
  let metadataStatus = PASSED;
  let metadataEvidence = 'metadata() is absent, which is allowed';
  try {
    const first = new PackageRegistry({ packages: [acceptedProbe] }).metadata()[validated.name];
    const second = new PackageRegistry({ packages: [acceptedProbe] }).metadata()[validated.name];
    metadata = first;
    const stable = JSON.stringify(first) === JSON.stringify(second);
    const functionFree = !JSON.stringify(first ?? {}).includes('function');
    metadataStatus = stable && functionFree ? PASSED : 'failed';
    metadataEvidence = stable
      ? (functionFree ? `${Buffer.byteLength(JSON.stringify(first ?? {}), 'utf8')} bytes, function-free, identical across two renderings`
        : 'metadata() published something that serializes as a function')
      : 'metadata() rendered differently twice, so the published schema is not deterministic';
  } catch (error) {
    metadataStatus = 'failed';
    metadataEvidence = error instanceof Error ? error.message : String(error);
    problems.push({ code: 'PACKAGE_METADATA_INVALID', message: metadataEvidence });
  }
  checks.push(check('declaration.metadata', 'declaration', metadataStatus, metadataEvidence,
    undefined, 'authoring-rule'));

  // Every declared policy carries a fingerprint, so a changed rule is visible.
  const policies = policyDefinitions;
  if (policies.length === 0) {
    checks.push(check('declaration.policy-fingerprints', 'declaration', 'not_applicable',
      'the package declares no policy', 'NO_POLICIES_DECLARED', 'package-contract'));
  } else {
    const composed = resolvePackageComposition([acceptedProbe]);
    const fingerprinted = [...composed.policies.values()]
      .filter((entry) => /^[0-9a-f]{64}$/.test(String(entry.fingerprint ?? '')));
    checks.push(check('declaration.policy-fingerprints', 'declaration',
      fingerprinted.length === policies.length ? PASSED : 'failed',
      `${fingerprinted.length}/${policies.length} declared policy(ies) carry a 64-hex declared-definition fingerprint`,
      undefined, 'composition'));
  }

  // Public imports only, and no dynamic composition.
  const sources = packageSources(dir);
  const privateImports = [];
  const dynamic = [];
  for (const file of sources) {
    const source = readFileSync(file, 'utf8');
    const shortName = file.slice(dir.length + 1).split(/[\\/]/).join('/');
    if (importsPrivateKernelPath(source)) privateImports.push(shortName);
    if (/\beval\s*\(/.test(source)) dynamic.push(`${shortName}: eval`);
    if (/\bnew Function\s*\(/.test(source)) dynamic.push(`${shortName}: new Function`);
    if (/\bawait import\s*\(/.test(source)) dynamic.push(`${shortName}: dynamic import`);
  }
  checks.push(check('boundary.sources', 'boundary', sources.length > 0 ? PASSED : 'failed',
    `${sources.length} JavaScript source file(s)`, undefined, 'authoring-rule'));
  checks.push(check('boundary.private-import', 'boundary', privateImports.length === 0 ? PASSED : 'failed',
    privateImports.length === 0
      ? 'no source reaches into packages/core/src'
      : `reaches a private kernel path: ${privateImports.join(', ')}`,
    undefined, 'authoring-rule'));
  checks.push(check('boundary.static-source', 'boundary', dynamic.length === 0 ? PASSED : 'failed',
    dynamic.length === 0
      ? 'no eval, no Function constructor and no dynamic import'
      : `builds behaviour at runtime: ${dynamic.join(', ')}`,
    undefined, 'authoring-rule'));

  // Reaching into another package's private source. Resolved, not substring
  // matched: `packages/contracts/src/service-capability.js` contains the text
  // "service" in the sense of a filename, not a package boundary.
  const declaredPackages = new Set(validated.requires.map((entry) => entry.package));
  const crossPackage = [];
  for (const file of sources) {
    const shortName = file.slice(dir.length + 1).split(/[\\/]/).join('/');
    for (const specifier of importSpecifiers(readFileSync(file, 'utf8'))) {
      const match = /(?:^|\/)packages\/([a-z][a-z0-9-]*)\/src\//.exec(specifier);
      if (!match) continue;
      const other = match[1];
      if (other === validated.name || other === 'core') continue;
      if (declaredPackages.has(other)) {
        crossPackage.push(`${shortName} imports ${other}'s private source (declared as a dependency, but a capability is the only sanctioned reach)`);
      } else {
        crossPackage.push(`${shortName} imports ${other}'s private source, which it does not even declare`);
      }
    }
  }
  checks.push(check('boundary.cross-package-import', 'boundary', crossPackage.length === 0 ? PASSED : 'failed',
    crossPackage.length === 0
      ? 'no source imports another package\'s private src/'
      : crossPackage.sort().join('; '),
    undefined, 'authoring-rule'));

  return { checks, problems, published: { resources, actions, requires, provides }, metadata };
}

/**
 * Composition: the rules a real application enforces at startup, asked of this
 * package against the providers it declares.
 *
 * @param {{definition: any, providers: any[]}} params
 */
export function runCompositionChecks({ definition, providers }) {
  const checks = [];
  const problems = [];

  const composed = resolvePackageComposition([...providers, definition]);
  for (const problem of composed.problems) {
    problems.push({
      code: problem.code,
      message: String(problem.message ?? ''),
      ...(problem.package ? { package: problem.package } : {}),
      ...(problem.capability ? { capability: problem.capability } : {}),
      ...(problem.resource ? { resource: problem.resource } : {}),
      ...(Array.isArray(problem.path) ? { path: [...problem.path] } : {}),
    });
  }
  const clean = composed.problems.length === 0;
  checks.push(check('compose.clean', 'composition', clean ? PASSED : 'failed',
    clean
      ? `composes with ${providers.length} declared provider package(s) and no problem`
      : composed.problems.map((problem) => problem.code).sort().join(', '),
    undefined, 'composition'));

  const accepted = [...composed.packageFacts.values()]
    .find((facts) => facts.definition === definition);
  if (!accepted) {
    for (const id of [
      'compose.duplicate-refused',
      'compose.resource-collision-refused',
      'compose.capability-collision-refused',
      'compose.unmet-dependency-refused',
      'compose.undeclared-reach-refused',
    ]) {
      checks.push(check(
        id,
        'composition',
        'skipped',
        'the initial composition did not accept this package definition',
        'PACKAGE_NOT_ACCEPTED',
        'composition',
      ));
    }
    return { checks, problems };
  }

  let probeName = 'conformance-probe';
  for (let suffix = 2; composed.packages.has(probeName); suffix += 1) {
    probeName = `conformance-probe-${suffix}`;
  }

  // Behavioral probes are deliberately small definitions derived from facts
  // the first composition accepted. Re-composing the author's executable
  // definition would rerun mutable accessors and could test a different
  // contract from `compose.clean`; spreading it would instead erase classes,
  // private receivers and non-enumerable declarations.
  const packageProbe = (name, extra = {}) => ({
    packageContract: accepted.packageContract,
    name,
    version: accepted.version,
    ...extra,
  });

  // Registering the same package twice is refused.
  const duplicate = packageProbe(accepted.name);
  const duplicated = resolvePackageComposition([duplicate, duplicate]);
  const duplicateRefused = duplicated.problems.some((problem) => problem.code === 'PACKAGE_DUPLICATE');
  checks.push(check('compose.duplicate-refused', 'composition', duplicateRefused ? PASSED : 'failed',
    duplicateRefused ? 'the same package cannot be registered twice' : 'a duplicate registration was not refused',
    undefined, 'composition'));

  // Two packages cannot own one record.
  const resources = [...composed.resources.entries()]
    .filter(([, owner]) => owner === accepted.name)
    .map(([resource]) => resource);
  if (resources.length === 0) {
    checks.push(check('compose.resource-collision-refused', 'composition', 'not_applicable',
      'the package owns no record', 'NO_RESOURCES_DECLARED', 'composition'));
  } else {
    const collision = resolvePackageComposition([
      packageProbe(accepted.name, { resources: [resources[0]] }),
      packageProbe(probeName, { resources: [resources[0]] }),
    ]);
    const collisionRefused = collision.problems.some((problem) => problem.code === 'RESOURCE_COLLISION');
    checks.push(check('compose.resource-collision-refused', 'composition', collisionRefused ? PASSED : 'failed',
      collisionRefused ? `a second package claiming "${resources[0]}" is refused` : 'a resource collision was not refused',
      undefined, 'composition'));
  }

  // Two packages cannot offer one capability at one version.
  // Use the composition snapshot, not mutable declaration accessors. The
  // collision probe must test the same identity/version/contract that this
  // composition accepted and that runtime observers publish.
  const offered = [...composed.capabilities.values()]
    .filter((entry) => entry.package === accepted.name);
  if (offered.length === 0) {
    checks.push(check('compose.capability-collision-refused', 'composition', 'not_applicable',
      'the package offers no capability', 'NO_CAPABILITIES_OFFERED', 'composition'));
  } else {
    const capabilityProbe = (accepted) => ({
      name: accepted.name,
      version: accepted.version,
      capabilityContract: accepted.capabilityContract,
      ...(accepted.description === undefined ? {} : { description: accepted.description }),
      // If a future probe reaches behavior, invoke the exact executable entry
      // as its receiver. A clone/Proxy would break class private fields.
      create(...args) { return accepted.entry.create(...args); },
    });
    const collision = resolvePackageComposition([
      packageProbe(accepted.name, { capabilities: [capabilityProbe(offered[0])] }),
      packageProbe(probeName, { capabilities: [capabilityProbe(offered[0])] }),
    ]);
    const collisionRefused = collision.problems.some((problem) => problem.code === 'CAPABILITY_COLLISION');
    checks.push(check('compose.capability-collision-refused', 'composition', collisionRefused ? PASSED : 'failed',
      collisionRefused
        ? `a second provider of "${offered[0].name}@${offered[0].version}" is refused`
        : 'a duplicate capability provider was not refused',
      undefined, 'composition'));
  }

  // EVERY declared dependency, not just the first: a package with two
  // dependencies must prove both, or the second is decoration.
  const requires = accepted.requires;
  if (requires.length === 0) {
    checks.push(check('compose.unmet-dependency-refused', 'composition', 'not_applicable',
      'the package declares no dependency', 'NO_DEPENDENCIES_DECLARED', 'composition'));
  } else {
    const acceptedRequires = requires.map((entry) => ({
      package: entry.package, capability: entry.capability, version: entry.version,
    }));
    const withoutProviders = resolvePackageComposition([
      packageProbe(accepted.name, { requires: acceptedRequires }),
    ]);
    const unproven = [];
    for (const entry of requires) {
      const refused = withoutProviders.problems.some((problem) => (
        problem.package === accepted.name
        && problem.capability === `${entry.capability}@${entry.version}`
        && ['DEPENDENCY_MISSING_PACKAGE', 'DEPENDENCY_UNSATISFIED'].includes(problem.code)
      ));
      if (!refused) unproven.push(`${entry.package}/${entry.capability}@${entry.version}`);
    }
    checks.push(check('compose.unmet-dependency-refused', 'composition', unproven.length === 0 ? PASSED : 'failed',
      unproven.length === 0
        ? `all ${requires.length} declared dependency(ies) stop registration when unmet`
        : `unmet dependency not refused for: ${unproven.join(', ')}`,
      undefined, 'composition'));
  }

  // An undeclared reach is refused even when the capability exists.
  if (offered.length === 0) {
    checks.push(check('compose.undeclared-reach-refused', 'composition', 'not_applicable',
      'the package offers no capability to reach for', 'NO_CAPABILITIES_OFFERED', 'composition'));
  } else {
    const offeredFact = offered[0];
    const provider = packageProbe(accepted.name, {
      capabilities: [{
        name: offeredFact.name,
        version: offeredFact.version,
        capabilityContract: offeredFact.capabilityContract,
        ...(offeredFact.description === undefined ? {} : { description: offeredFact.description }),
        create(...args) { return offeredFact.entry.create(...args); },
      }],
    });
    let refused = false;
    let detail = '';
    try {
      const registry = new PackageRegistry({
        packages: [
          provider,
          packageProbe(probeName),
        ],
      });
      registry.capability({
        consumer: probeName,
        capability: offered[0].name,
        version: offered[0].version,
        context: {},
      });
    } catch (error) {
      refused = error?.code === 'CAPABILITY_NOT_DECLARED';
      detail = String(error?.code ?? error?.message ?? '');
    }
    checks.push(check('compose.undeclared-reach-refused', 'composition', refused ? PASSED : 'failed',
      refused
        ? `a package that did not declare "${offered[0].name}@${offered[0].version}" is refused (${detail})`
        : 'an undeclared consumer was allowed to open a capability',
      undefined, 'composition'));
  }

  return { checks, problems };
}

export { check };
