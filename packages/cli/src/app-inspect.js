// @ts-check

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { actionMetadata } from '../../core/src/action-registry.js';
import { resolvePackageComposition } from '../../core/src/package-composition.js';
import { readModuleState } from '../../core/src/module-evolution.js';
import { SUPPORTED_PACKAGE_CONTRACT } from '../../core/src/package-registry.js';
import { repoRelative, safeMessage } from './safe-text.js';

/**
 * **Application inspection** (AX1) — one deterministic document describing the
 * application a project has actually composed.
 *
 * Today a coding agent assembles that picture from five surfaces by hand:
 * `crm package inspect` once per package, `/api/schema` from a running server,
 * the checked-in composition file, each package README, and `PROJECT_STATUS.md`
 * in prose. This replaces the assembly.
 *
 * Three properties make it trustworthy, and each is a deliberate restriction:
 *
 * - **source-only.** It reads the checked-in composition — the same files the
 *   application boots from — and never opens the configured database. Booting
 *   would run migrations and persist fingerprints, and an inspector that
 *   mutates what it inspects is not an inspector.
 * - **no second set of rules.** Composition validity comes from
 *   `resolvePackageComposition`, the same function `PackageRegistry` throws
 *   from at startup; action metadata comes from `actionMetadata`, the same
 *   function `/api/schema` publishes. The report can be wrong about the
 *   application only if the application is wrong about itself.
 * - **honest about its gaps.** Everything it cannot know is named in
 *   `limitations`, by machine-readable code. No Markdown document is parsed
 *   into structured truth: `PROJECT_STATUS.md` and the JTBD matrix are
 *   referenced by path and never interpreted.
 *
 * What it is not: a planner, an installer, a deployer, a migrator, a sandbox,
 * or a claim about any running system.
 *
 * **Trust boundary.** Reading a code-first definition means importing it, so a
 * package's module body runs with this process's authority — the same boundary
 * `crm package validate` documents and the same one the checked-in composition
 * file has: repository source is trusted. Nothing here is sandboxed, and the
 * report says so rather than implying otherwise.
 */

export const APPLICATION_INSPECTION_CONTRACT = 1;

/**
 * A package's `metadata()` block is free-form by design, so it is the one place
 * a package can make the report arbitrarily large. Bounded here, per package,
 * with the refusal reported rather than silently truncated.
 */
const MAX_METADATA_BYTES = 256 * 1024;

/** The checked-in composition files, and the export each one contributes. */
const COMPOSITION = Object.freeze([
  { key: 'packages', path: 'packages/domains/generated/index.js', exportName: 'generatedDomains' },
  { key: 'modules', path: 'packages/modules/generated/index.js', exportName: 'generatedModules' },
  { key: 'actions', path: 'packages/actions/generated/index.js', exportName: 'generatedActions' },
  { key: 'pipelines', path: 'packages/pipelines/generated/index.js', exportName: 'generatedPipelines' },
]);

/** Handwritten kernel modules. They are composed by the kernel, not by a project. */
const CORE_MODULES = Object.freeze(['approval', 'company', 'contact', 'opportunity']);

/** Everything AX1 cannot answer, stated once, by code. */
const LIMITATIONS = Object.freeze([
  ['DATABASE_NOT_INSPECTED', 'the configured application database is never opened, so what a particular database has applied, holds or is missing is unknown'],
  ['PACKAGE_SOURCE_TRUSTED', 'reading a code-first package means importing it, so package code runs with this process’s authority. Nothing here is sandboxed'],
  ['PROCESS_ISOLATION_BOUNDED', 'the load runs in its own process group and a timeout stops that group, so an ordinary child a package spawns is stopped with it. A package that deliberately detaches a process into a new group outlives the inspection; tracking descendants is not attempted and would not be a sandbox either'],
  ['EVIDENCE_NOT_AGGREGATED', 'JTBD and quality-gate status live in Markdown maintained by people; they are referenced by path and never parsed into structured claims'],
  ['CI_EVIDENCE_NOT_INFERRED', 'no CI, browser-smoke or benchmark result is read or inferred'],
  ['SECRETS_NOT_INSPECTED', 'no secret, credential, token or environment value is read, and no provider is contacted or authenticated'],
  ['PROVIDER_HEALTH_UNKNOWN', 'a registered provider definition says a provider was composed, never that it is reachable, configured or operational'],
  ['PRODUCTION_SPINE_ABSENT', 'Production Spine v1 (ADR-038) adds verified identity, organizations, memberships, server-authoritative authorization and one-tenant-per-instance storage isolation — but none of it can be reported from SOURCE: which mode a deployment chose, which tenant it is bound to, whether a verifier is configured and who holds which membership are all runtime facts, published by a running application at /api/schema. One application instance serves exactly one tenant; two tenants means two instances, and a configuration naming two is refused at startup. Shared-database row-level tenancy and PostgreSQL are NOT implemented, and durable jobs, secrets, backups and deployment are still absent. This is not a production-readiness statement'],
  ['ADMIN_EXTENSIONS_UNSUPPORTED', 'the framework has no seam for a package to contribute an Admin extension, so adminExtensions is empty for every project — not merely empty for this one'],
  ['DATA_QUALITY_UNKNOWN', 'source-only inspection can say which records exist, never whether their data is correct, complete or duplicated'],
  ['RUNTIME_STATE_UNKNOWN', 'nothing here reports what is running, deployed or reachable'],
]);

/** Import one composition file, turning any failure into a problem rather than a throw. */
async function loadComposition(rootDir, entry, problems) {
  const full = resolve(rootDir, entry.path);
  if (!existsSync(full)) {
    problems.push({
      code: 'COMPOSITION_FILE_MISSING',
      message: `Composition file ${entry.path} does not exist`,
      source: entry.path,
    });
    return null;
  }
  try {
    return await import(pathToFileURL(full).href);
  } catch (error) {
    problems.push({
      code: 'COMPOSITION_LOAD_FAILED',
      message: `Composition file ${entry.path} could not be loaded: ${safeMessage(error, rootDir)}`,
      source: entry.path,
    });
    return null;
  }
}

/** Ordered, JSON-safe input metadata for one action, from the kernel's own function. */
function describeAction(action, owner) {
  const meta = actionMetadata(action);
  return {
    module: action.module,
    name: action.name,
    owner,
    label: meta.label,
    description: meta.description,
    actionContract: meta.actionContract,
    input: meta.input,
    // Declared *static* applicability, never authorization and never a claim
    // about one record: an action with `fromStates: null` declares none, which
    // is a different fact from "applies in every state".
    fromStates: meta.fromStates,
    stateField: meta.stateField,
    confirm: meta.confirm,
    // Some actions declare a human-actor boundary in their own metadata; the
    // kernel does not model it, so it is reported only where it is declared.
    externalOperation: typeof action.external === 'function' || Array.isArray(action.phases),
    path: meta.path,
  };
}

/** The safe, function-free shape of one declared field. */
function describeField(field) {
  return {
    name: field.name,
    type: field.type,
    required: field.required === true,
    unique: field.unique === true,
    writable: field.writable ?? 'public',
    ...(field.values ? { values: [...field.values] } : {}),
    ...(field.references ? { references: field.references, targetModule: field.targetModule ?? null } : {}),
  };
}

/**
 * Everything the source says about one record module. Deliberately absent:
 * migration SQL, row counts, and any claim about a database.
 */
function describeModule({ rootDir, name, kind, definition, owner, problems }) {
  /** @type {any} */
  let state = null;
  // A package-owned record is a generated module that a package claims: it has
  // the same manifest, the same state file and the same evolution path. Reading
  // state only for the unclaimed ones would silently blank the revision of
  // every record a package owns — which is most of them.
  if (kind !== 'core') {
    try {
      state = readModuleState(rootDir, name);
    } catch (error) {
      problems.push({
        code: 'MODULE_STATE_INVALID',
        message: `Module "${name}": ${safeMessage(error, rootDir)}`,
        module: name,
      });
    }
  }
  return {
    name,
    kind,
    owner,
    table: definition?.table ?? null,
    manifestVersion: definition?.manifestVersion ?? null,
    // The checked-in revision and the migrations the source declares. What a
    // particular database has applied is a different question, and AX1 does not
    // answer it (see limitations).
    revision: state ? state.revision : null,
    adopted: state ? state.adopted === true : null,
    migrations: state
      ? state.migrations.map((entry) => ({
        name: entry.migrationName,
        checksum: checksumOf(entry.sql),
      }))
      : null,
    stateFile: kind === 'core' ? null : state ? (state.adopted ? 'reconstructed' : 'valid') : 'unreadable',
    capabilities: [...(definition?.capabilities ?? [])].sort(),
    fields: (definition?.fields ?? []).map(describeField),
    references: (definition?.references ?? []).map((entry) => ({
      field: entry.field,
      targetModule: entry.targetModule,
      targetTable: entry.targetTable,
      required: entry.required === true,
    })),
  };
}

/** The identity of a migration, never its text: SQL is not published here. */
function checksumOf(sql) {
  return createHash('sha256').update(sql).digest('hex');
}

/**
 * Inspect the application composed in `rootDir`.
 *
 * @param {{rootDir: string}} options
 * @returns {Promise<{report: any, valid: boolean}>}
 */
export async function inspectApplication({ rootDir: requested }) {
  const rootDir = resolve(requested ?? process.cwd());
  if (!existsSync(join(rootDir, 'packages', 'core', 'index.js'))) {
    const error = new Error(
      `Not an accordo project: ${repoRelative(process.cwd(), rootDir) || '.'} has no packages/core/index.js`,
    );
    /** @type {any} */ (error).fatal = true;
    throw error;
  }

  /** @type {any[]} */
  const problems = [];
  /** @type {Record<string, any>} */
  const loaded = {};
  for (const entry of COMPOSITION) {
    loaded[entry.key] = await loadComposition(rootDir, entry, problems);
  }

  // ── packages and capabilities ────────────────────────────────────────────
  const packageDefinitions = Array.isArray(loaded.packages?.generatedDomains)
    ? loaded.packages.generatedDomains
    : [];
  const composition = resolvePackageComposition(packageDefinitions);
  for (const problem of composition.problems) {
    problems.push({
      code: problem.code,
      message: problem.message,
      ...(problem.package ? { package: problem.package } : {}),
      ...(problem.capability ? { capability: problem.capability } : {}),
      ...(problem.resource ? { resource: problem.resource } : {}),
      ...(problem.path ? { path: [...problem.path] } : {}),
    });
  }

  /** Accepted capability facts, snapshotted by composition before observers run. */
  const capabilityFactsByPackage = new Map();
  for (const value of composition.capabilities.values()) {
    const entries = capabilityFactsByPackage.get(value.package) ?? [];
    entries.push(value);
    capabilityFactsByPackage.set(value.package, entries);
  }

  const packages = [...composition.packageFacts.values()]
    .map((facts) => {
      const pkg = facts.definition;
      return {
        name: facts.name,
        version: facts.version,
        packageContract: facts.packageContract,
        label: pkg.label ?? facts.name,
        description: pkg.description ?? null,
        resources: [...(pkg.resources ?? [])].sort(),
        actions: (pkg.actions ?? []).map((action) => `${action.module}.${action.name}`).sort(),
        requires: facts.requires
          .map((entry) => ({ package: entry.package, capability: entry.capability, version: entry.version }))
          .sort((a, b) => compare(`${a.package}/${a.capability}@${a.version}`, `${b.package}/${b.capability}@${b.version}`)),
        provides: (capabilityFactsByPackage.get(facts.name) ?? [])
          .map((entry) => ({
            name: entry.name,
            version: entry.version,
            capabilityContract: entry.capabilityContract,
            description: entry.description ?? null,
          }))
          .sort((a, b) => compare(`${a.name}@${a.version}`, `${b.name}@${b.version}`)),
        // Declared application-scoped operations (ADR-032): additive, and gone
        // when the package detaches.
        operations: (pkg.operations ?? [])
          .map((entry) => ({
            name: entry.name,
            operationContract: entry.operationContract,
            ...(entry.appMethod ? { appMethod: entry.appMethod } : {}),
          }))
          .sort((a, b) => compare(a.name, b.name)),
        policies: [...composition.policies.values()]
          .filter((entry) => entry.domain === facts.name)
          .map((entry) => `${entry.kind}/${entry.definition.name}@${entry.definition.version}`)
          .sort(compare),
        metadata: safeMetadata(pkg, facts.name, problems, rootDir),
      };
    })
    .sort((a, b) => compare(a.name, b.name));
  const packageContracts = [...new Set(packages.map((pkg) => pkg.packageContract))];

  // The capability graph, from both ends: who offers it and who consumes it.
  /** @type {Map<string, any>} */
  const capabilityRows = new Map();
  for (const [key, value] of composition.capabilities) {
    capabilityRows.set(key, {
      name: value.name,
      version: value.version,
      capabilityContract: value.capabilityContract,
      provider: value.package,
      consumers: [],
      status: 'resolved',
      description: value.description ?? null,
    });
  }
  for (const facts of composition.packageFacts.values()) {
    for (const entry of facts.requires) {
      const key = `${entry.capability}@${entry.version}`;
      const row = capabilityRows.get(key);
      if (row && row.provider === entry.package) {
        row.consumers.push(facts.name);
        continue;
      }
      // An unresolved requirement is still part of the graph — reporting only
      // what resolved would hide exactly the edge the reader is looking for.
      const missing = capabilityRows.get(key) ?? {
        name: entry.capability, version: entry.version, provider: null,
        consumers: [], status: 'missing', description: null,
      };
      if (missing.provider !== null && missing.provider !== entry.package) missing.status = 'provider-mismatch';
      missing.consumers.push(facts.name);
      capabilityRows.set(key, missing);
    }
  }
  const capabilities = [...capabilityRows.values()]
    .map((row) => ({ ...row, consumers: [...row.consumers].sort(compare) }))
    .sort((a, b) => compare(`${a.name}@${a.version}`, `${b.name}@${b.version}`));

  // ── modules and resources ────────────────────────────────────────────────
  const resourceOwner = composition.resources;
  const modules = [];
  for (const name of CORE_MODULES) {
    const definition = await coreModuleDefinition(rootDir, name, problems);
    modules.push(describeModule({ rootDir, name, kind: 'core', definition, owner: null, problems }));
  }
  const generatedEntries = Array.isArray(loaded.modules?.generatedModules) ? loaded.modules.generatedModules : [];
  for (const entry of generatedEntries) {
    const name = typeof entry?.name === 'string' ? entry.name : null;
    if (!name) {
      problems.push({ code: 'MODULE_ENTRY_INVALID', message: 'A generated module registry entry has no name' });
      continue;
    }
    const definition = await generatedModuleDefinition(rootDir, name, problems);
    const owner = resourceOwner.get(name) ?? null;
    modules.push(describeModule({
      rootDir, name, kind: owner ? 'package-owned' : 'generated', definition, owner, problems,
    }));
  }
  modules.sort((a, b) => compare(a.name, b.name));

  // ── actions ──────────────────────────────────────────────────────────────
  const actions = [
    ...(Array.isArray(loaded.actions?.generatedActions) ? loaded.actions.generatedActions : [])
      .map((action) => describeAction(action, null)),
    ...[...composition.packageFacts.values()].flatMap((facts) =>
      (facts.definition.actions ?? []).map((action) => describeAction(action, facts.name))),
  ].sort((a, b) => compare(`${a.module}.${a.name}`, `${b.module}.${b.name}`));

  // ── policies and providers ───────────────────────────────────────────────
  const policies = [...composition.policies.values()]
    .map((entry) => ({
      owner: entry.domain,
      kind: entry.kind,
      name: entry.definition.name,
      version: entry.definition.version,
      label: entry.definition.label ?? entry.definition.name,
      fingerprint: entry.fingerprint,
      configKeys: Object.keys(entry.definition.config ?? {}).sort(compare),
    }))
    .sort((a, b) => compare(`${a.owner}/${a.kind}/${a.name}@${a.version}`, `${b.owner}/${b.kind}/${b.name}@${b.version}`));

  const providers = collectProviders(loaded, problems, rootDir);

  const report = {
    applicationInspectionContract: APPLICATION_INSPECTION_CONTRACT,
    valid: problems.length === 0,
    application: {
      name: readProjectName(rootDir, problems),
      packageContract: packageContracts.length === 0
        ? SUPPORTED_PACKAGE_CONTRACT
        : packageContracts.length === 1 ? packageContracts[0] : null,
      composition: COMPOSITION.map((entry) => entry.path),
      // Declared statically by the framework, not read from a running system.
      databaseBackend: 'sqlite (node:sqlite)',
      // This sentence is the one every agent reads to learn what the framework
      // is, and it is the first of the two failures ADR-039 exists to close: it
      // once said "no authentication, tenancy or RBAC exists" in the same report
      // whose PRODUCTION_SPINE_ABSENT message described all three (PR #101).
      // truth: retired-claim no authentication, tenancy or RBAC exists — the line above names the retired posture as the recorded failure; the report below never asserts it
      //
      // The citations below bind the *values* each clause rests on. They do not
      // bind the sentence: restoring the retired posture with these lines left
      // untouched kept `--check` green, which is why RETIRED_CLAIMS exists and
      // why generating this sentence from its own facts is v2
      // (POSTURE_PROSE_NOT_GENERATED).
      // truth: spine.identity.contract=1
      // truth: spine.authentication.framework_verifier=absent
      // truth: spine.authorization.enforced=enforced
      // truth: spine.tenant.isolation.mode=one_tenant_per_instance
      // truth: spine.tenant.crm_data_plane_enforced=enforced_by_binding
      // truth: spine.multi_tenant_single_instance=refused_at_startup
      // truth: spine.postgresql.implemented=absent
      // truth: spine.durable_jobs.implemented=absent
      // truth: spine.secrets_backups.implemented=absent
      productionPosture: 'not a readiness claim: the framework authenticates nobody (a deployment adapter supplies verified identity), while tenancy — one tenant per application instance — and authorization are owned and enforced by the framework. SQLite only; shared-database tenancy, PostgreSQL, durable jobs, secrets and backups are absent',
    },
    packages,
    capabilities,
    resources: [...resourceOwner.entries()]
      .map(([resource, owner]) => ({ resource, package: owner }))
      .sort((a, b) => compare(a.resource, b.resource)),
    actions,
    policies,
    providers,
    modules,
    // The framework has no seam for a package-contributed Admin extension, so
    // this is empty for every project. Saying "none declared" without saying
    // "none can be" would read as a property of this project.
    adminExtensions: [],
    problems: problems.map((problem) => ({ ...problem })),
    limitations: LIMITATIONS.map(([code, message]) => ({ code, message })),
    evidence: {
      status: 'not_aggregated',
      qualityGatesPath: 'docs/QUALITY_GATES.md',
      jtbdMatrixPath: 'docs/benchmarks/CRM_JTBD_MATRIX.md',
      projectStatusPath: 'docs/PROJECT_STATUS.md',
      note: 'these documents are prose maintained by people; AX1 references them and never parses them into structured claims',
    },
  };
  report.valid = report.problems.length === 0;
  return { report, valid: report.valid };
}

/** Deterministic string order, independent of locale. */
function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * A package's own metadata block, refused rather than published if it is not
 * plain data — or if it is unreasonably large. The bound is here rather than
 * only on the transport: a report is a document an agent reads, and an
 * unbounded block turns one package into a denial of the whole document.
 */
function safeMetadata(pkg, acceptedName, problems, rootDir) {
  if (typeof pkg.metadata !== 'function') return {};
  let declared;
  try {
    declared = pkg.metadata();
  } catch (error) {
    problems.push({
      code: 'PACKAGE_METADATA_FAILED', package: acceptedName,
      message: `Package "${acceptedName}" metadata() threw: ${safeMessage(error, rootDir)}`,
    });
    return {};
  }
  let serialized;
  try {
    serialized = JSON.stringify(declared ?? {});
  } catch (error) {
    problems.push({
      code: 'PACKAGE_METADATA_INVALID', package: acceptedName,
      message: `Package "${acceptedName}" metadata() is not JSON-safe: ${safeMessage(error, rootDir)}`,
    });
    return {};
  }
  if (serialized.length > MAX_METADATA_BYTES) {
    problems.push({
      code: 'PACKAGE_METADATA_TOO_LARGE', package: acceptedName,
      message: `Package "${acceptedName}" metadata() is ${serialized.length} bytes, over the ${MAX_METADATA_BYTES}-byte `
        + 'bound; it is omitted from the report rather than published',
    });
    return {};
  }
  return JSON.parse(serialized);
}

/** @param {string} rootDir */
function readProjectName(rootDir, problems) {
  const path = join(rootDir, 'package.json');
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return typeof parsed?.name === 'string' ? parsed.name.slice(0, 120) : null;
  } catch (error) {
    problems.push({ code: 'PROJECT_MANIFEST_INVALID', message: `package.json could not be read: ${safeMessage(error, rootDir)}` });
    return null;
  }
}

/** @param {string} rootDir @param {string} name */
async function coreModuleDefinition(rootDir, name, problems) {
  return moduleDefinitionFrom(rootDir, name, problems);
}

/** @param {string} rootDir @param {string} name */
async function generatedModuleDefinition(rootDir, name, problems) {
  return moduleDefinitionFrom(rootDir, name, problems);
}

/**
 * The static definition a module exports. Never `createModule()`: constructing
 * a service is a runtime act, and the definition is the declared truth.
 * @param {string} rootDir @param {string} name
 */
async function moduleDefinitionFrom(rootDir, name, problems) {
  const path = resolve(rootDir, 'packages', 'modules', name, 'src', 'index.js');
  if (!existsSync(path)) {
    problems.push({ code: 'MODULE_SOURCE_MISSING', module: name, message: `Module "${name}" has no src/index.js` });
    return null;
  }
  try {
    const imported = await import(pathToFileURL(path).href);
    const found = Object.entries(imported).find(([key, value]) =>
      key.endsWith('ModuleDefinition') && value && typeof value === 'object');
    if (!found) {
      problems.push({ code: 'MODULE_DEFINITION_MISSING', module: name, message: `Module "${name}" exports no module definition` });
      return null;
    }
    return found[1];
  } catch (error) {
    problems.push({
      code: 'MODULE_LOAD_FAILED', module: name,
      message: `Module "${name}" could not be loaded: ${safeMessage(error, rootDir)}`,
    });
    return null;
  }
}

/**
 * Provider *definitions* the project composed. A definition says a provider was
 * registered in source — never that it is configured, reachable or
 * authenticated, which is a limitation stated by code above.
 */
function collectProviders(loaded, problems, rootDir) {
  /** @type {any[]} */
  const rows = [];
  const push = (registry, kind, list) => {
    for (const definition of list ?? []) {
      if (!definition || typeof definition !== 'object') {
        problems.push({ code: 'PROVIDER_ENTRY_INVALID', message: `A ${kind} entry is not an object` });
        continue;
      }
      rows.push({
        registry,
        kind,
        name: typeof definition.name === 'string' ? definition.name.slice(0, 120) : null,
        version: Number.isSafeInteger(definition.version) ? definition.version : null,
        label: typeof definition.label === 'string' ? definition.label.slice(0, 120) : null,
        capabilities: Array.isArray(definition.capabilities) ? [...definition.capabilities].sort(compare) : [],
        // Declared config KEYS only. A value could be a credential, and no
        // report is worth leaking one — see the SECRETS_NOT_INSPECTED limitation.
        configKeys: Object.keys(definition.config ?? {}).sort(compare),
        fixture: definition.fixture === true || /fixture|test|memory/i.test(String(definition.name ?? '')),
      });
    }
  };
  push('pipelines', 'pipeline', loaded.pipelines?.generatedPipelines);
  void rootDir;
  return rows.sort((a, b) => compare(
    `${a.registry}/${a.kind}/${a.name}@${a.version}`,
    `${b.registry}/${b.kind}/${b.name}@${b.version}`,
  ));
}
