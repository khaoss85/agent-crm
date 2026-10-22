// @ts-check

// Custom module bundles (BO-F5-01, docs/BUNDLES.md).
//
// A bundle is a versioned set of manifest-generated modules that lives
// SEPARATELY from the kernel: `bundles/<name>/<version>/` holds the module
// sources produced by the module factory, a `bundle.json` manifest, and a
// bundle-local test. Installing a bundle never writes under `packages/` (the
// shared process composition is untouched); a host composes a bundle only by
// passing its entries explicitly to `createAccordoApp({ bundles })`.
//
// The coding-agent flow this serves (docs/MODULE_FACTORY.md "For coding
// agents"): the agent drafts a module manifest from the user's description,
// runs `bundle create --apply`, then `bundle verify` proves the result really
// installs — a bundle that does not boot and serve records is refused, never
// simulated.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ConflictError, ValidationError } from '../../core/src/errors.js';
import {
  CORE_RESERVED_TABLES,
  validateModuleManifest,
} from '../../core/src/module-manifest.js';
import { validateGeneratedModuleDefinition } from '../../core/src/generated-module-contract.js';
import { planModule, applyModulePlan, scanExistingModules } from './module-factory.js';

export const BUNDLE_FORMAT = 1;
export const BUNDLE_MANIFEST_FILE = 'bundle.json';
/** Registry of installed bundles, relative to the project root. */
export const BUNDLE_REGISTRY_FILE = join('bundles', 'registry.json');
export const BUNDLE_NAME_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;
export const BUNDLE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export const BUNDLE_CREATED_BY = Object.freeze(['ai', 'manual', 'accordo']);

/**
 * Kernel-owned tables a bundle module may never claim. The factory already
 * refuses CORE_RESERVED_TABLES; this adds the framework-owned storage the
 * factory does not know (spine bindings, definition versions, write
 * outcomes). The lifecycle test boots the real kernel and asserts EVERY live
 * kernel table is refused, so a new kernel table fails the test until it is
 * listed here — the list cannot rot silently.
 */
export const BUNDLE_PROTECTED_TABLES = Object.freeze(new Set([
  ...CORE_RESERVED_TABLES,
  'definition_versions',
  'spine_audit_intents',
  'spine_data_plane_binding',
  'spine_jobs',
  'spine_memberships',
  'spine_organizations',
  'spine_tenant_bindings',
  'write_outcomes',
]));

/**
 * Parse `name@version` (both required, exact semver). Anything else is a
 * ValidationError, never a guess.
 *
 * @param {unknown} ref
 */
export function parseBundleRef(ref) {
  if (typeof ref !== 'string' || ref === '') {
    throw new ValidationError('A bundle ref looks like "reporting@1.2.0" (name@version)');
  }
  const at = ref.lastIndexOf('@');
  if (at <= 0 || at === ref.length - 1) {
    throw new ValidationError(`Bundle ref "${ref}" must be "name@version"`);
  }
  const name = ref.slice(0, at);
  const version = ref.slice(at + 1);
  assertBundleName(name);
  assertBundleVersion(version);
  return { name, version };
}

/** @param {unknown} name */
export function assertBundleName(name) {
  if (typeof name !== 'string' || !BUNDLE_NAME_PATTERN.test(name)) {
    throw new ValidationError(
      `Bundle name ${JSON.stringify(name)} must match ${BUNDLE_NAME_PATTERN} (lowercase, digits, hyphens)`,
    );
  }
}

/** @param {unknown} version */
export function assertBundleVersion(version) {
  if (typeof version !== 'string' || !BUNDLE_VERSION_PATTERN.test(version)) {
    throw new ValidationError(
      `Bundle version ${JSON.stringify(version)} must be exact semver X.Y.Z (no ranges, no prefixes)`,
    );
  }
}

/** @param {unknown} createdBy */
export function assertCreatedBy(createdBy) {
  if (!BUNDLE_CREATED_BY.includes(/** @type {any} */ (createdBy))) {
    throw new ValidationError(
      `createdBy must be one of ${BUNDLE_CREATED_BY.join(', ')} (who generated this bundle)`,
    );
  }
}

/**
 * @param {string} name @param {string} version
 */
export function bundleDirFor(name, version) {
  return join('bundles', name, version);
}

/**
 * Kernel module directories (handwritten `contact`, `company`,
 * `opportunity`, `approval` plus generated ones): names a bundle may never
 * take. Read from disk, not hardcoded — a new kernel module is protected
 * the moment it lands.
 *
 * @param {string} rootDir
 */
export function kernelModuleNames(rootDir) {
  const modulesDir = resolve(rootDir, 'packages', 'modules');
  /** @type {Set<string>} */
  const names = new Set();
  if (!existsSync(modulesDir)) return names;
  for (const entry of readdirSync(modulesDir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== 'generated') names.add(entry.name);
  }
  return names;
}

/**
 * Every bundle module on disk: `{ bundleName, version, moduleName, table }`.
 * A malformed installed manifest fails loudly here instead of producing a
 * composition that breaks app boot.
 *
 * @param {string} rootDir
 */
export function scanBundleModules(rootDir) {
  /** @type {Array<{bundleName: string, version: string, moduleName: string, table: string, dir: string}>} */
  const out = [];
  const bundlesDir = resolve(rootDir, 'bundles');
  if (!existsSync(bundlesDir)) return out;
  for (const bundleEntry of readdirSync(bundlesDir, { withFileTypes: true })) {
    if (!bundleEntry.isDirectory()) continue;
    const bundleName = bundleEntry.name;
    const bundlePath = join(bundlesDir, bundleName);
    for (const versionEntry of readdirSync(bundlePath, { withFileTypes: true })) {
      if (!versionEntry.isDirectory()) continue;
      const version = versionEntry.name;
      const dir = join('bundles', bundleName, version);
      const manifestPath = resolve(rootDir, dir, 'module.manifest.json');
      if (!existsSync(manifestPath)) continue;
      let manifest;
      try {
        manifest = validateModuleManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
      } catch (error) {
        throw new ValidationError(
          `Bundle ${bundleName}@${version} has an invalid module.manifest.json; fix or remove it before planning another bundle`,
          { bundle: `${bundleName}@${version}`, cause: error instanceof Error ? error.message : String(error) },
        );
      }
      out.push({ bundleName, version, moduleName: manifest.name, table: manifest.table, dir });
    }
  }
  return out;
}

/**
 * The single source of truth for bundle table ownership (NOT_GENERAL
 * backlog:8691acfc): every bundle module on disk (table + owner), read from
 * scanBundleModules. planBundleCreate refuses a table another bundle owns;
 * uninstallBundle refuses to drop a table this bundle does not exclusively
 * own. Both paths call this helper — a new ownership case extends the
 * ownership table test in tests/bundle-lifecycle.test.js, never a new
 * ad-hoc check.
 *
 * A new version of the SAME bundle reuses its tables (versions are
 * immutable: 0.0.1 stays, 0.0.2 plans beside it), so the bundle's own name
 * is excluded via `excludeBundleName`. Matching is case-insensitive, like
 * the module-name check in planBundleCreate.
 *
 * @param {string} rootDir @param {string} table @param {string} [excludeBundleName]
 * @returns {{bundleName: string, version: string, moduleName: string, table: string, dir: string} | null}
 */
export function findBundleTableOwner(rootDir, table, excludeBundleName) {
  const wanted = table.toLowerCase();
  for (const other of scanBundleModules(rootDir)) {
    if (excludeBundleName !== undefined && other.bundleName === excludeBundleName) continue;
    if (other.table.toLowerCase() === wanted) return other;
  }
  return null;
}

/**
 * Kernel generated-module tables on this rootDir, lowercased: the tables of
 * every generated module under `packages/modules` (read via the factory's
 * own scan, never a copy of its directory walk). Handwritten kernel modules
 * need no entry here: their tables are already in BUNDLE_PROTECTED_TABLES
 * via CORE_RESERVED_TABLES. A missing `packages/modules` dir means no
 * kernel tables (bare roots used by some unit tests).
 *
 * @param {string} rootDir
 * @returns {Set<string>}
 */
export function kernelGeneratedTables(rootDir) {
  /** @type {Set<string>} */
  const tables = new Set();
  for (const entry of scanExistingModules(rootDir)) {
    if (entry.kind === 'generated' && entry.manifest) tables.add(entry.manifest.table.toLowerCase());
  }
  return tables;
}

/**
 * Read and validate `bundles/<name>/<version>/bundle.json`. The recorded
 * name/version must match the directory: a moved bundle is a new bundle,
 * never a silent rename.
 *
 * @param {string} rootDir @param {string} name @param {string} version
 */
export function readBundleManifest(rootDir, name, version) {
  assertBundleName(name);
  assertBundleVersion(version);
  const dir = bundleDirFor(name, version);
  const path = resolve(rootDir, dir, BUNDLE_MANIFEST_FILE);
  if (!existsSync(path)) {
    throw new ValidationError(`Bundle ${name}@${version} does not exist at ${dir}`, { bundle: `${name}@${version}` });
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new ValidationError(`Bundle ${name}@${version} has an unreadable ${BUNDLE_MANIFEST_FILE}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ValidationError(`Bundle ${name}@${version} has a malformed ${BUNDLE_MANIFEST_FILE}`);
  }
  if (parsed.format !== BUNDLE_FORMAT) {
    throw new ValidationError(
      `Bundle ${name}@${version} declares format ${JSON.stringify(parsed.format)}; this framework reads format ${BUNDLE_FORMAT}`,
    );
  }
  if (parsed.name !== name || parsed.version !== version) {
    throw new ValidationError(
      `Bundle at ${dir} names itself ${JSON.stringify(parsed.name)}@${JSON.stringify(parsed.version)}; directory and manifest must agree`,
    );
  }
  if (!Array.isArray(parsed.modules) || parsed.modules.length === 0) {
    throw new ValidationError(`Bundle ${name}@${version} lists no modules`);
  }
  for (const module of parsed.modules) {
    if (!module || typeof module.name !== 'string' || typeof module.table !== 'string'
      || typeof module.migration !== 'string' || module.migration === '') {
      throw new ValidationError(`Bundle ${name}@${version} has a malformed module entry`);
    }
  }
  return Object.freeze({
    format: parsed.format,
    name: parsed.name,
    version: parsed.version,
    createdBy: parsed.createdBy,
    modules: Object.freeze(parsed.modules.map((/** @type {any} */ module) => Object.freeze({ ...module }))),
  });
}

/**
 * The plan-time ownership guards as one function (NOT_GENERAL
 * backlog:8691acfc): "one module, one bundle / one table, one bundle", never
 * a kernel name, never kernel storage. planBundleCreate calls it for a
 * drafted manifest, installBundle re-runs it for the bundle.json on disk —
 * a hand-placed directory that never went through plan cannot bypass the
 * refusal by installing directly (P2 bundle-manager.js:657: install ran
 * verify in isolation and recorded a colliding table). The bundle's own
 * name is excluded, so a new version of the SAME bundle reuses its name
 * and table (versions are immutable: 0.0.1 stays, 0.0.2 plans beside it)
 * and a reinstall after uninstall passes. A new ownership case extends
 * this function, never a new ad-hoc check.
 *
 * @param {{rootDir: string, name: string, moduleName: string, table: string}} input
 */
function assertBundleOwnership(input) {
  const { rootDir, name, moduleName, table } = input;
  // Never shadow the kernel: a handwritten or generated kernel module of this
  // name exists, or another bundle already installed it.
  if (kernelModuleNames(rootDir).has(moduleName)) {
    throw new ConflictError(
      `Module "${moduleName}" is a kernel module; a bundle may not shadow it`,
      { module: moduleName },
    );
  }
  for (const other of scanBundleModules(rootDir)) {
    if (other.bundleName === name) continue;
    if (other.moduleName.toLowerCase() === moduleName.toLowerCase()) {
      throw new ConflictError(
        `Module "${moduleName}" is already installed by bundle ${other.bundleName}@${other.version}; one module, one bundle`,
        { module: moduleName, bundle: `${other.bundleName}@${other.version}` },
      );
    }
  }
  const tableOwner = findBundleTableOwner(rootDir, table, name);
  if (tableOwner !== null) {
    throw new ConflictError(
      `Table "${table}" is already owned by bundle ${tableOwner.bundleName}@${tableOwner.version}; one table, one bundle`,
      { table, bundle: `${tableOwner.bundleName}@${tableOwner.version}` },
    );
  }
  // Never claim kernel storage: clienti, pipeline, calendario and every other
  // kernel-owned table stay kernel-owned. The lifecycle test proves this on
  // the real table set; this is the plan-time refusal.
  if (BUNDLE_PROTECTED_TABLES.has(table)) {
    throw new ConflictError(
      `Table "${table}" is kernel-owned (clienti, pipeline, calendario and framework storage); a bundle claims only its own tables`,
      { table },
    );
  }
  if (kernelGeneratedTables(rootDir).has(table.toLowerCase())) {
    throw new ConflictError(
      `Table "${table}" is kernel-owned (generated kernel module); a bundle claims only its own tables`,
      { table },
    );
  }
}

/**
 * Plan a new bundle from one module manifest (this slice: one module per
 * bundle; a second module is a second bundle version or a follow-up). The
 * factory generates the module sources into the bundle directory with the
 * bundle import depth; this function adds the bundle manifest and the
 * bundle-local installability test.
 *
 * @param {{manifest: unknown, name: string, version: string, createdBy: string, rootDir?: string}} input
 */
export function planBundleCreate(input) {
  const rootDir = resolve(input.rootDir ?? process.cwd());
  assertBundleName(input.name);
  assertBundleVersion(input.version);
  assertCreatedBy(input.createdBy);
  const manifest = validateModuleManifest(input.manifest);
  const dir = bundleDirFor(input.name, input.version);

  if (manifest.name !== input.name) {
    throw new ValidationError(
      `Bundle "${input.name}" must wrap a module of the same name; the manifest names "${manifest.name}"`,
    );
  }
  // One ownership registry for the "one module, one bundle / one table, one
  // bundle" invariant (NOT_GENERAL backlog:8691acfc): the same helper the
  // install and uninstall paths use, so plan-time refusal, install-time
  // refusal and uninstall-time refusal share one source of truth. Two
  // services on one physical table would silently mix rows (the second
  // CREATE TABLE IF NOT EXISTS no-ops), so the table refusal matters as
  // much as the name one.
  assertBundleOwnership({ rootDir, name: input.name, moduleName: manifest.name, table: manifest.table });

  const modulePlan = planModule({ manifest, rootDir, layout: { bundleDir: dir } });
  const bundleManifest = {
    format: BUNDLE_FORMAT,
    name: input.name,
    version: input.version,
    createdBy: input.createdBy,
    modules: [{ name: manifest.name, table: manifest.table, migration: modulePlan.migrationName }],
  };
  /** @type {Array<{path: string, action: string, exists: boolean, bytes: number, contentSha256: string, preview: string, content: string}>} */
  const extraFiles = [
    {
      path: join(dir, BUNDLE_MANIFEST_FILE),
      action: 'create',
      content: `${JSON.stringify(bundleManifest, null, 2)}\n`,
    },
    {
      path: join(dir, 'tests', `${manifest.name}-bundle.test.js`),
      action: 'create',
      content: bundleTestTemplate(manifest, input.version),
    },
  ].map((file) => ({
    ...file,
    exists: existsSync(resolve(rootDir, file.path)),
    bytes: Buffer.byteLength(file.content, 'utf8'),
    contentSha256: createHash('sha256').update(file.content, 'utf8').digest('hex'),
    preview: file.content.split('\n').slice(0, 6).join('\n'),
  }));
  return {
    bundle: input.name,
    version: input.version,
    createdBy: input.createdBy,
    dir,
    module: modulePlan.module,
    table: modulePlan.table,
    migrationName: modulePlan.migrationName,
    rootDir,
    modulePlan,
    bundleManifest,
    files: extraFiles,
  };
}

/**
 * Apply a bundle plan atomically: the factory writes the module sources
 * (refusing overwrites), then the bundle manifest and the bundle-local test.
 * One apply, one rollback — a failed bundle leaves nothing behind.
 *
 * @param {ReturnType<typeof planBundleCreate>} plan
 */
export function applyBundleCreate(plan) {
  // Atomic as documented ("one apply, one rollback"): NOTHING is written
  // unless every target is free. The factory apply below refuses its own
  // collisions, but it used to run BEFORE this second phase — a collision
  // here (an interrupted apply, a stray test file) left the factory files
  // behind without a bundle.json: a half-bundle whose stale
  // module.state.json blocks a retry ("create a new bundle version instead
  // of regenerating") and whose orphan module name blocks other bundles via
  // scanBundleModules. So collisions fail fast here, before any write, and
  // the per-file check below stays as the TOCTOU guard.
  const secondPhaseCollisions = plan.files
    .filter((file) => existsSync(resolve(plan.rootDir, file.path)))
    .map((file) => file.path);
  if (secondPhaseCollisions.length > 0) {
    throw new ConflictError(
      `Bundle files already exist for ${plan.bundle}@${plan.version}; refusing to overwrite`,
      { collisions: secondPhaseCollisions },
    );
  }
  const applied = applyModulePlan(plan.modulePlan);
  /** @type {string[]} */
  const createdPaths = [];
  try {
    for (const file of plan.files) {
      const target = resolve(plan.rootDir, file.path);
      if (relative(plan.rootDir, target).startsWith('..') || !target.startsWith(plan.rootDir + sep)) {
        throw new ValidationError(`Refusing to write ${file.path} outside the project root`);
      }
      if (existsSync(target)) {
        throw new ConflictError(`Bundle file already exists: ${file.path}; refusing to overwrite`, { path: file.path });
      }
      mkdirSync(dirname(target), { recursive: true });
      const temp = `${target}.tmp-accordo`;
      writeFileSync(temp, file.content, 'utf8');
      renameSync(temp, target);
      createdPaths.push(target);
    }
  } catch (error) {
    for (const created of createdPaths) rmSync(created, { force: true });
    // Roll the first phase back too: remove every file the factory apply
    // wrote, then prune directories left empty (deepest first, one bare
    // rmdir each — a directory that still holds anything, such as the
    // colliding file, is left alone, never removed recursively).
    for (const file of applied.files) rmSync(resolve(plan.rootDir, file.path), { force: true });
    pruneEmptyAncestors(
      applied.files.map((file) => resolve(plan.rootDir, file.path)),
      resolve(plan.rootDir, plan.dir),
    );
    throw error;
  }
  return {
    bundle: plan.bundle,
    version: plan.version,
    dir: plan.dir,
    module: applied.module,
    table: applied.table,
    migrationName: applied.migrationName,
    files: [
      ...applied.files,
      ...plan.files.map(({ content: _content, ...file }) => file),
    ],
  };
}

/**
 * Remove directories left empty by a rolled-back apply: every ancestor of a
 * removed file up to (and including) `stopDir`, deepest first, one bare
 * `rmdirSync` each. A directory that still holds anything — the colliding
 * file, a sibling version — fails the rmdir and is left alone, so pruning
 * never deletes content this apply did not create.
 *
 * @param {string[]} removedFiles @param {string} stopDir
 */
function pruneEmptyAncestors(removedFiles, stopDir) {
  /** @type {Set<string>} */
  const dirs = new Set();
  for (const file of removedFiles) {
    let dir = dirname(file);
    while (dir.length >= stopDir.length && (dir === stopDir || dir.startsWith(stopDir + sep))) {
      dirs.add(dir);
      if (dir === stopDir) break;
      dir = dirname(dir);
    }
  }
  for (const dir of [...dirs].sort((a, b) => b.length - a.length)) {
    try {
      rmdirSync(dir);
    } catch {
      // Still holds something that is not ours: leave it alone.
    }
  }
}

/**
 * The bundle-local installability test: boots the real application WITH the
 * bundle composed (opt-in, never implicit) and proves the module migrates,
 * registers and serves records with audit. This is the "installabile vero"
 * proof, and it lives next to the bundle — not in a document.
 *
 * The test file sits at `bundles/<name>/<version>/tests/`, four levels below
 * the project root, hence the `../../../../` framework imports and the
 * four-level `rootDir` climb.
 *
 * @param {{name: string, table: string, fields: Array<{name: string, type: string, required?: boolean, column: string, values?: string[]}>}} manifest
 * @param {string} version
 */
function bundleTestTemplate(manifest, version) {
  const requiredExamples = manifest.fields
    .filter((field) => field.required)
    .map((field) => `  ${field.name}: ${exampleValue(field)},`)
    .join('\n');
  const firstRequired = manifest.fields.find((field) => field.required);
  return `// @ts-check
// Bundle installability proof for ${manifest.name}@${version} (BO-F5-01). Boots the real
// application WITH this bundle composed and proves its module migrates,
// registers and serves records with audit. If this file is red, the bundle
// does not install — no matter what any other document claims.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createBundleEntries } from '../../../../packages/cli/src/bundle-manager.js';
import { createAccordoApp } from '../../../../packages/app/src/index.js';

test('bundle ${manifest.name}@${version} installs: migrates, registers and serves records', async (t) => {
  const rootDir = new URL('../../../..', import.meta.url).pathname;
  const entries = await createBundleEntries({ rootDir, bundles: [{ name: '${manifest.name}', version: '${version}' }] });
  const app = createAccordoApp({ dbPath: ':memory:', bundles: entries });
  t.after(() => app.close());
  const actor = { type: 'human', id: 'test-user' };

  assert.ok(app.modules.list().some((module) => module.name === '${manifest.name}'));
  const service = app.modules.get('${manifest.name}').service;

  const created = await service.create({
${requiredExamples}
  }, { actor });
  assert.ok(created.id);
  assert.deepEqual(service.get(created.id), created);
  assert.equal(service.list().length, 1);

  const auditActions = app.audit
    .list({ entityType: '${manifest.name}' })
    .map((event) => event.action)
    .sort();
  assert.deepEqual(auditActions, ['${manifest.name}.created']);
${firstRequired ? `
  await assert.rejects(() => service.create({}, { actor }), /${firstRequired.name}/);` : ''}
});
`;
}

/**
 * @param {string} moduleName
 */
function namesOf(moduleName) {
  const pascal = moduleName.split('-').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('');
  const camel = pascal.charAt(0).toLowerCase() + pascal.slice(1);
  return { module: moduleName, pascal, camel };
}

/** @param {{name: string, type: string, values?: string[]}} field */
function exampleValue(field) {
  switch (field.type) {
    case 'email':
      return "'someone@example.com'";
    case 'integer':
      return '42';
    case 'boolean':
      return 'true';
    case 'timestamp':
      return "'2026-01-01T00:00:00.000Z'";
    case 'enum':
      return JSON.stringify((field.values ?? [''])[0]);
    default:
      return `'Example ${field.name}'`;
  }
}

/**
 * Read the install registry. Missing file = nothing installed (a fresh
 * checkout installs nothing implicitly — the shared process stays clean).
 *
 * @param {string} rootDir
 */
export function readBundleRegistry(rootDir) {
  const path = resolve(rootDir, BUNDLE_REGISTRY_FILE);
  if (!existsSync(path)) return Object.freeze({ installed: Object.freeze([]) });
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new ValidationError(`Bundle registry at ${BUNDLE_REGISTRY_FILE} is unreadable; restore it from version control`);
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.installed)) {
    throw new ValidationError(`Bundle registry at ${BUNDLE_REGISTRY_FILE} is malformed`);
  }
  return Object.freeze({ installed: Object.freeze(parsed.installed.map((entry) => ({ name: entry.name, version: entry.version }))) });
}

/**
 * @param {string} rootDir @param {{installed: Array<{name: string, version: string}>}} registry
 */
function writeBundleRegistry(rootDir, registry) {
  const sorted = [...registry.installed].sort((a, b) =>
    a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name));
  const target = resolve(rootDir, BUNDLE_REGISTRY_FILE);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify({ installed: sorted }, null, 2)}\n`, 'utf8');
  return Object.freeze({ installed: Object.freeze(sorted) });
}

/**
 * Load composable entries for installed bundles: imports each bundle's
 * module definition and migrations, and validates the definition exactly as
 * the application would at startup. A bundle whose code does not load or
 * whose definition is invalid is refused HERE — never half-composed.
 *
 * @param {{rootDir?: string, bundles: Array<{name: string, version: string}>}} input
 */
export async function createBundleEntries(input) {
  const rootDir = resolve(input.rootDir ?? process.cwd());
  if (!Array.isArray(input.bundles) || input.bundles.length === 0) {
    throw new ValidationError('createBundleEntries needs a non-empty bundles list');
  }
  /** @type {Array<{name: string, createModule: (deps: any) => any, migrations: Array<{name: string, sql: string}>}>} */
  const entries = [];
  for (const ref of input.bundles) {
    const { name, version } = parseBundleRef(`${ref.name}@${ref.version}`);
    const bundle = readBundleManifest(rootDir, name, version);
    const dir = bundleDirFor(name, version);
    const module = bundle.modules[0];
    const names = namesOf(module.name);
    const moduleUrl = pathToFileURL(resolve(rootDir, dir, 'src', 'index.js')).href;
    const migrationUrl = pathToFileURL(resolve(rootDir, dir, 'src', 'migration.js')).href;
    /** @type {any} */
    let moduleSource;
    /** @type {any} */
    let migrationSource;
    try {
      moduleSource = await import(moduleUrl);
      migrationSource = await import(migrationUrl);
    } catch (error) {
      throw new ValidationError(
        `Bundle ${name}@${version} does not load (${error instanceof Error ? error.message : String(error)}); it is not installable`,
        { bundle: `${name}@${version}` },
      );
    }
    const createModule = moduleSource[`create${names.pascal}Module`];
    if (typeof createModule !== 'function') {
      throw new ValidationError(`Bundle ${name}@${version} exports no create${names.pascal}Module from src/index.js`);
    }
    const migrations = Array.isArray(migrationSource[`${names.camel}Migrations`])
      ? migrationSource[`${names.camel}Migrations`]
      : migrationSource[`${names.camel}Migration`] ? [migrationSource[`${names.camel}Migration`]] : null;
    if (!migrations) {
      throw new ValidationError(`Bundle ${name}@${version} exports no migration from src/migration.js; regenerate it from its manifest`);
    }
    // Validate the definition exactly as the application would at startup,
    // with inert dependencies (construction performs no I/O by contract).
    validateGeneratedModuleDefinition(createModule({ database: null, audit: null, events: null, references: null }));
    entries.push({ name: module.name, createModule, migrations });
  }
  return entries;
}

/**
 * Install a bundle: refuse colliding ownership FIRST (the same plan-time
 * guards, re-run on the bundle.json on disk — a hand-placed directory that
 * never went through plan cannot install a table another bundle or the
 * kernel owns), then prove it loads, validates and boots (the same proof
 * `verify` runs), then record it in the registry. A refused bundle never
 * touches the registry. The guards run before the boot so a collision
 * fails fast without composing anything.
 *
 * @param {{name: string, version: string, rootDir?: string}} input
 */
export async function installBundle(input) {
  const rootDir = resolve(input.rootDir ?? process.cwd());
  const { name, version } = parseBundleRef(`${input.name}@${input.version}`);
  const bundle = readBundleManifest(rootDir, name, version);
  for (const module of bundle.modules) {
    assertBundleOwnership({ rootDir, name, moduleName: module.name, table: module.table });
  }
  const proof = await verifyBundle({ name, version, rootDir });
  const registry = readBundleRegistry(rootDir);
  if (registry.installed.some((entry) => entry.name === name && entry.version === version)) {
    throw new ConflictError(`Bundle ${name}@${version} is already installed`, { bundle: `${name}@${version}` });
  }
  if (registry.installed.some((entry) => entry.name === name)) {
    throw new ConflictError(
      `Bundle ${name} is installed at another version; uninstall it first — versions never merge`,
      { bundle: `${name}@${version}` },
    );
  }
  const next = writeBundleRegistry(rootDir, { installed: [...registry.installed, { name, version }] });
  return { bundle: name, version, installed: next.installed, proof };
}

/**
 * Uninstall a bundle: drop ONLY its own tables — every one named in its
 * bundle.json, each re-checked for EXCLUSIVE ownership before any drop runs:
 * the protected set (a table that became kernel-owned since install is
 * refused), another bundle's live tables (a hand-edited or copied-in
 * bundle.json naming them refuses the whole uninstall), and the kernel
 * generated-module tables on this rootDir. A refusal fails closed: the
 * whole uninstall throws, nothing is dropped, the registry is untouched.
 * Then it drops its own module_migrations ledger rows (same transaction, so
 * a reinstall re-applies the CREATE) and removes the registry entry. Kernel
 * data is never touched: the lifecycle test proves it on real rows.
 *
 * @param {{name: string, version: string, rootDir?: string, database?: any}} input
 */
export async function uninstallBundle(input) {
  const rootDir = resolve(input.rootDir ?? process.cwd());
  const { name, version } = parseBundleRef(`${input.name}@${input.version}`);
  const bundle = readBundleManifest(rootDir, name, version);
  const registry = readBundleRegistry(rootDir);
  /** @type {string[]} */
  const dropped = [];
  if (input.database !== undefined && input.database !== null) {
    // DDL goes through the kernel-owned seam on the database handle
    // (`dropTables` in packages/core/src/database.js, the single owner of the
    // raw driver): this file never touches the driver, so the Spine v2 M2 raw
    // boundary holds. Every table is vetted for exclusive ownership BEFORE
    // any drop runs — a foreign name refuses the whole uninstall.
    const handle = input.database;
    if (!handle || typeof handle.dropTables !== 'function') {
      throw new ValidationError('uninstallBundle needs a database handle with the dropTables DDL seam to drop bundle tables');
    }
    /** @type {string[]} */
    const tables = [];
    for (const module of bundle.modules) {
      if (BUNDLE_PROTECTED_TABLES.has(module.table)) {
        throw new ValidationError(
          `Refusing to drop "${module.table}": kernel-owned (fail-closed even though bundle.json names it)`,
          { table: module.table },
        );
      }
      tables.push(module.table);
    }
    // Exclusive ownership (same source of truth as the plan-time refusal,
    // findBundleTableOwner): a table owned by ANOTHER bundle or by a kernel
    // generated module is never dropped, even though bundle.json names it.
    // The bundle's own name is excluded — versions of the same bundle
    // legitimately share their tables (only one version installs at a time).
    const kernelTables = kernelGeneratedTables(rootDir);
    for (const table of tables) {
      const owner = findBundleTableOwner(rootDir, table, name);
      if (owner !== null) {
        throw new ValidationError(
          `Refusing to drop "${table}": owned by bundle ${owner.bundleName}@${owner.version}, not by ${name}@${version} (fail-closed: uninstall drops only its own tables)`,
          { table, bundle: `${name}@${version}`, owner: `${owner.bundleName}@${owner.version}` },
        );
      }
      if (kernelTables.has(table.toLowerCase())) {
        throw new ValidationError(
          `Refusing to drop "${table}": kernel-owned (fail-closed even though bundle.json names it)`,
          { table },
        );
      }
    }
    // The bundle's ledger rows die with its tables, in the same transaction:
    // reinstalling the same version re-applies the CREATE instead of
    // skipping it on a stale checksum and booting with a missing table.
    // Names come from the manifest plus the live entries (evolutions the
    // framework added after the bundle shipped); a bundle whose code no
    // longer loads still uninstalls by manifest names alone.
    /** @type {Set<string>} */
    const migrations = new Set(bundle.modules.map((module) => module.migration));
    try {
      const entries = await createBundleEntries({ rootDir, bundles: [{ name, version }] });
      for (const entry of entries) {
        for (const migration of entry.migrations) migrations.add(migration.name);
      }
    } catch {
      // Uninstall stays possible for a broken bundle: manifest names apply.
    }
    dropped.push(...handle.dropTables(tables, { removeMigrations: [...migrations] }));
  }
  const next = writeBundleRegistry(rootDir, {
    installed: registry.installed.filter((entry) => !(entry.name === name && entry.version === version)),
  });
  return { bundle: name, version, dropped, installed: next.installed };
}

/**
 * List bundles on disk and their install state.
 *
 * @param {{rootDir?: string}} [input]
 */
export function listBundles(input = {}) {
  const rootDir = resolve(input.rootDir ?? process.cwd());
  const registry = readBundleRegistry(rootDir);
  const installedKeys = new Set(registry.installed.map((entry) => `${entry.name}@${entry.version}`));
  /** @type {Array<{name: string, version: string, createdBy: string, modules: Array<{name: string, table: string, migration: string}>, installed: boolean}>} */
  const bundles = [];
  const bundlesDir = resolve(rootDir, 'bundles');
  if (existsSync(bundlesDir)) {
    for (const bundleName of readdirSync(bundlesDir)) {
      const bundlePath = join(bundlesDir, bundleName);
      let entries = [];
      try {
        entries = readdirSync(bundlePath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        try {
          const manifest = readBundleManifest(rootDir, bundleName, entry.name);
          bundles.push({
            name: manifest.name,
            version: manifest.version,
            createdBy: manifest.createdBy,
            modules: [...manifest.modules],
            installed: installedKeys.has(`${manifest.name}@${manifest.version}`),
          });
        } catch {
          // A directory that is not a valid bundle is not listed as one;
          // verifyBundle is the command that says so loudly.
          continue;
        }
      }
    }
  }
  bundles.sort((a, b) => a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name));
  return { bundles };
}

/**
 * The installability proof: validate, load, validate the definition, boot
 * the REAL application with the bundle composed, and serve one record per
 * module (create + read + list) with audit. Returns the observed proof.
 * Anything that does not boot and serve is refused — never simulated.
 *
 * @param {{name: string, version: string, rootDir?: string}} input
 */
export async function verifyBundle(input) {
  const rootDir = resolve(input.rootDir ?? process.cwd());
  const { name, version } = parseBundleRef(`${input.name}@${input.version}`);
  const bundle = readBundleManifest(rootDir, name, version);
  // The proof boots the TARGET tree's kernel, not the CLI checkout's: bundle
  // code loads from rootDir, so the app entry must too. The target-tree
  // check runs BEFORE any bundle code loads — a --root without the app
  // entry is refused loudly instead of misdiagnosed as an uninstallable
  // bundle (bundle load errors) or verified against the wrong composition
  // (a success that proves nothing about the target tree).
  const appEntry = resolve(rootDir, join('packages', 'app', 'src', 'index.js'));
  if (!existsSync(appEntry)) {
    throw new ValidationError(
      `Cannot verify ${name}@${version}: no app kernel at ${appEntry}; --root must point at the project checkout`,
      { bundle: `${name}@${version}`, rootDir },
    );
  }
  const entries = await createBundleEntries({ rootDir, bundles: [{ name, version }] });
  const { createAccordoApp } = await import(pathToFileURL(appEntry).href);
  const app = createAccordoApp({ dbPath: ':memory:', bundles: entries });
  /** @type {Array<{module: string, table: string, rows: number}>} */
  const modules = [];
  try {
    const actor = { type: 'human', id: 'bundle-verify' };
    for (const entry of entries) {
      const service = app.modules.get(entry.name).service;
      const manifestPath = resolve(rootDir, bundleDirFor(name, version), 'module.manifest.json');
      const manifest = validateModuleManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
      const payload = {};
      for (const field of manifest.fields) {
        if (field.required) payload[field.name] = verifyValue(field);
      }
      const created = await service.create(payload, { actor });
      if (!created || typeof created.id !== 'string') {
        throw new ValidationError(`Bundle ${name}@${version} module "${entry.name}" create did not return a record`);
      }
      const read = service.get(created.id);
      if (!read || read.id !== created.id) {
        throw new ValidationError(`Bundle ${name}@${version} module "${entry.name}" read-after-create failed`);
      }
      modules.push({ module: entry.name, table: manifest.table, rows: service.list().length });
    }
  } finally {
    app.close();
  }
  return { bundle: name, version, installed: true, modules };
}

/** @param {{name: string, type: string, values?: string[]}} field */
function verifyValue(field) {
  switch (field.type) {
    case 'email':
      return 'verify@example.com';
    case 'integer':
      return 1;
    case 'boolean':
      return true;
    case 'timestamp':
      return '2026-01-01T00:00:00.000Z';
    case 'enum':
      return (field.values ?? []).length ? field.values[0] : 'example';
    default:
      return `Verify ${field.name}`;
  }
}
