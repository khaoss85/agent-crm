// @ts-check

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * The throwaway project `crm package test` composes a package into.
 *
 * It exists because the questions DX4 asks — does this attach, does it detach,
 * do its migrations apply, do its actions register, does its capability edge
 * resolve — cannot be answered against the caller's real application without
 * writing to it. So the package is composed into a copy, in a temporary
 * directory, which is removed whether the run succeeds, fails or times out.
 *
 * Three rules make it safe and repeatable:
 *
 * - **the caller's project is never written to.** Every CLI invocation targets
 *   the scratch copy's own binary with `--root <scratch>` *and* `cwd: <scratch>`;
 *   using the caller's CLI, or omitting `--root`, generates modules into their
 *   real repository.
 * - **the package keeps its path.** Relative import depth is load-bearing —
 *   `examples/custom-packages/partner-scorecard/src/index.js` reaches the kernel
 *   through `../../../../packages/core/index.js` — so the package is copied to
 *   the same relative location it occupies in the caller's project, never
 *   relocated under `packages/`.
 * - **every argument is an array element, never a shell string**, so a project
 *   living under a path with spaces behaves exactly like one that does not.
 */

/** One scratch root per invocation; concurrent applies share a staging name. */
const SCRATCH_PREFIX = 'agent-crm-package-test-';

/** Copied unconditionally: the framework, its apps, and the manifest. */
const ALWAYS_COPY = Object.freeze(['packages', 'apps', 'package.json']);

/** The one composition file DX4 writes. Everything else stays at its default. */
const DOMAINS_COMPOSITION = 'packages/domains/generated/index.js';

/** @param {string} value */
export function posix(value) {
  return value.split(sep).join('/');
}

/**
 * Resolve a package directory the way `crm package validate` does, and refuse
 * one that lives outside the project being tested.
 *
 * @param {{packagePath: string, rootDir: string}} params
 */
export function resolvePackageLocation({ packagePath, rootDir }) {
  if (typeof packagePath !== 'string' || packagePath.trim() === '') {
    throw new Error('Usage: crm package test <package-directory>');
  }
  const dir = isAbsolute(packagePath) ? packagePath : resolve(process.cwd(), packagePath);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`Not a directory: ${packagePath}`);
  if (!existsSync(join(dir, 'src', 'index.js'))) {
    throw new Error(`No package entry point at ${posix(join(relative(rootDir, dir), 'src', 'index.js'))} (a package exports its definition from src/index.js)`);
  }
  const within = relative(rootDir, dir);
  if (within === '' || isAbsolute(within) || within.split(sep)[0] === '..') {
    throw new Error(
      'The package directory must live inside the project being tested: a package is composed by relative import, and copying it elsewhere would change what it can reach.',
    );
  }
  return { dir, relativeDir: posix(within), topSegment: within.split(sep)[0] };
}

/**
 * Which package in this project owns a given record.
 *
 * A package may declare an action on a record another package owns — the
 * `partner-scorecard` fixture rates a `delivery-partner-engagement` — and the
 * package contract has no way to declare that: `requires` expresses a
 * capability edge, not record-level coupling. Without the owner composed, the
 * application refuses to start with `target module "…" is not a generated
 * module`.
 *
 * So the owner is discovered mechanically, by asking every package in the
 * project which records it declares. Nothing here knows what any package is
 * for; it reads `resources` and nothing else.
 *
 * @param {{rootDir: string, records: string[], load: (entry: string) => Promise<any[]>}} params
 */
export async function findRecordOwners({ rootDir, records, load }) {
  const wanted = new Set(records);
  if (wanted.size === 0) return [];
  const packagesDir = join(rootDir, 'packages');
  if (!existsSync(packagesDir)) return [];
  /** @type {Array<{name: string, relativeDir: string, topSegment: string, dir: string, exportName: string, isFactory: boolean, definition: any, records: string[]}>} */
  const owners = [];
  for (const entry of readdirSync(packagesDir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!entry.isDirectory()) continue;
    const dir = join(packagesDir, entry.name);
    if (!existsSync(join(dir, 'src', 'index.js'))) continue;
    let found;
    try {
      found = await load(join(dir, 'src', 'index.js'));
    } catch {
      continue; // a package that will not load is not this check's business
    }
    if (found.length !== 1) continue;
    const definition = found[0].definition;
    const owned = [...(definition?.resources ?? [])].filter((resource) => wanted.has(resource));
    if (owned.length === 0) continue;
    owners.push({
      name: String(definition.name),
      dir,
      relativeDir: posix(join('packages', entry.name)),
      topSegment: 'packages',
      exportName: found[0].export,
      isFactory: /^create[A-Za-z0-9]*(Package|Domain)$/.test(found[0].export),
      definition,
      records: owned.sort(),
    });
  }
  return owners;
}

/** Directories that never contain a project's own module manifests. */
const NOT_A_SOURCE_DIR = new Set(['node_modules', 'data', 'dist', 'build', 'coverage']);

/**
 * Every module manifest in the project, indexed by the record it declares.
 *
 * A package's action may target a record that belongs to the *project* rather
 * than to any package — `contracts` acts on `order`, which a project creates
 * from its own manifest. Nothing owns those records in the package sense, so
 * the only mechanical way to compose such a package is to find the manifest
 * that declares the name and apply it.
 *
 * This reads `name` and `fields[].targetModule` and nothing else: it does not
 * know, and must not know, what any record is for.
 *
 * @param {string} rootDir
 */
export function indexModuleManifests(rootDir) {
  /** @type {Map<string, {name: string, path: string, references: string[]}>} */
  const index = new Map();
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return; // an unreadable directory is not a manifest source
    }
    for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (entry.name.startsWith('.') || NOT_A_SOURCE_DIR.has(entry.name)) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.module.json')) continue;
      let manifest;
      try {
        manifest = JSON.parse(readFileSync(full, 'utf8'));
      } catch {
        continue; // a manifest that will not parse is the factory's problem
      }
      const name = manifest?.name;
      if (typeof name !== 'string' || index.has(name)) continue;
      const references = (Array.isArray(manifest?.fields) ? manifest.fields : [])
        .map((field) => field?.targetModule)
        .filter((target) => typeof target === 'string');
      index.set(name, { name, path: full, references: [...new Set(references)].sort() });
    }
  };
  walk(rootDir);
  return index;
}

/**
 * Close a set of required record names over the manifests that declare them and
 * everything those manifests reference, so a manifest is never applied without
 * the records its foreign keys point at.
 *
 * @param {{index: Map<string, {name: string, path: string, references: string[]}>, records: string[], provided: Set<string>}} params
 */
export function closeManifestSet({ index, records, provided }) {
  /** @type {Map<string, {name: string, path: string, references: string[]}>} */
  const chosen = new Map();
  const missing = new Set();
  const queue = [...new Set(records)].sort();
  while (queue.length > 0) {
    const record = queue.shift();
    if (provided.has(record) || chosen.has(record)) continue;
    const manifest = index.get(record);
    if (!manifest) {
      missing.add(record);
      continue;
    }
    chosen.set(record, manifest);
    for (const reference of manifest.references) queue.push(reference);
  }
  return {
    manifests: [...chosen.values()].sort((a, b) => (a.name < b.name ? -1 : 1)),
    missing: [...missing].sort(),
  };
}

/** Every module manifest a package ships, sorted so the apply order is stable. */
export function packageManifests(dir) {
  const modulesDir = join(dir, 'modules');
  if (!existsSync(modulesDir)) return [];
  return readdirSync(modulesDir)
    .filter((name) => name.endsWith('.module.json'))
    .sort()
    .map((name) => join(modulesDir, name));
}

/**
 * Build the scratch project.
 *
 * `providers` are the packages this one declares a dependency on, each already
 * located; their manifests are applied first and they are composed first, so a
 * dependency edge has something to resolve against.
 *
 * `projectManifests` are records the composition needs that no package owns —
 * a project's own manifests — applied first so a package action that targets
 * one has something to target.
 *
 * @param {{rootDir: string, location: {dir: string, relativeDir: string, topSegment: string},
 *   providers?: Array<{name: string, relativeDir: string, topSegment: string, dir: string, exportName: string, isFactory: boolean}>,
 *   projectManifests?: Array<{name: string, path: string}>,
 *   exportName: string, isFactory: boolean, name: string}} params
 */
export function buildProbeProject({ rootDir, location, providers = [], projectManifests = [], exportName, isFactory, name }) {
  const scratchRoot = mkdtempSync(join(tmpdir(), SCRATCH_PREFIX));
  const cleanup = () => { rmSync(scratchRoot, { recursive: true, force: true }); };
  try {
    const segments = new Set([
      ...ALWAYS_COPY,
      location.topSegment,
      ...providers.map((entry) => entry.topSegment),
      // Whatever directory a needed project manifest lives in — a starter, an
      // examples tree, or the project root itself.
      ...projectManifests.map((entry) => relative(rootDir, entry.path).split(sep)[0]),
    ]);
    for (const segment of [...segments].sort()) {
      const from = join(rootDir, segment);
      if (!existsSync(from)) continue;
      cpSync(from, join(scratchRoot, segment), { recursive: true });
    }

    /** @type {Array<{manifest: string, ok: boolean, output: string}>} */
    const applied = [];
    const apply = (manifestPath) => {
      const result = spawnSync(
        process.execPath,
        [
          '--no-warnings',
          join(scratchRoot, 'packages', 'cli', 'bin', 'agent-crm.js'),
          'module', 'create', manifestPath, '--apply', '--root', scratchRoot,
        ],
        { encoding: 'utf8', cwd: scratchRoot },
      );
      applied.push({
        manifest: posix(relative(scratchRoot, manifestPath)),
        ok: result.status === 0,
        output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
      });
      return result.status === 0;
    };

    // Project-owned records first: a package action may target one, and the
    // module factory refuses a manifest whose references are not installed.
    for (const manifest of projectManifests) {
      apply(join(scratchRoot, relative(rootDir, manifest.path)));
    }
    // Providers next: a consumer's action may target a provider's record.
    for (const provider of providers) {
      for (const manifest of packageManifests(join(scratchRoot, provider.relativeDir))) apply(manifest);
    }
    for (const manifest of packageManifests(join(scratchRoot, location.relativeDir))) apply(manifest);

    writeComposition(scratchRoot, [...providers, { name, relativeDir: location.relativeDir, exportName, isFactory }]);

    return { scratchRoot, applied, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

/**
 * Write `packages/domains/generated/index.js` — the only place a project names
 * its packages, and the one file this command authors. Import specifiers are
 * always POSIX: the generated registry's own imports are, and `path.join` is
 * not.
 *
 * @param {string} scratchRoot
 * @param {Array<{name: string, relativeDir: string, exportName: string, isFactory: boolean}>} entries
 */
export function writeComposition(scratchRoot, entries) {
  const from = join(scratchRoot, dirname(DOMAINS_COMPOSITION));
  const lines = ['// @ts-check'];
  for (const entry of entries) {
    const target = join(scratchRoot, entry.relativeDir, 'src', 'index.js');
    let specifier = posix(relative(from, target));
    if (!specifier.startsWith('.')) specifier = `./${specifier}`;
    lines.push(`import { ${entry.exportName} } from '${specifier}';`);
  }
  lines.push('export const generatedDomains = [');
  for (const entry of entries) lines.push(`  ${entry.exportName}${entry.isFactory ? '()' : ''},`);
  lines.push('];', '');
  writeFileSync(join(scratchRoot, DOMAINS_COMPOSITION), lines.join('\n'));
  return lines.join('\n');
}

/**
 * Rewrite the composition without one package — the detach probe.
 *
 * A package whose absence breaks a *provider* is not what this proves; the
 * provider stays composed, and only the package under test leaves. It has to be
 * a separate child process from the attach probe: Node caches ES modules by
 * URL, so re-importing a rewritten composition in the same process silently
 * replays the first one and proves nothing.
 *
 * @param {string} scratchRoot
 * @param {Array<{name: string, relativeDir: string, exportName: string, isFactory: boolean}>} entries
 * @param {string} without
 */
export function writeCompositionWithout(scratchRoot, entries, without) {
  return writeComposition(scratchRoot, entries.filter((entry) => entry.name !== without));
}
