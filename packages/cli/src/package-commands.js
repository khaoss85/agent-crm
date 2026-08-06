// @ts-check

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PackageRegistry, validatePackageDefinition } from '../../core/src/package-registry.js';

/**
 * `crm package validate|inspect` — the agent-facing surface of the domain
 * package contract (ADR-018 addendum 3).
 *
 * It runs **the same validator the application runs at startup**, so a package
 * that validates here registers there, and one that fails here fails there for
 * the same stated reason. It is read-only: it writes no file, opens no
 * database, and reaches no network.
 *
 * Loading a package does import its checked-in `src/index.js` — that is how a
 * static, code-first definition is read, and it is the same trust boundary as
 * the composition file itself. It is not a sandbox: repository source is
 * trusted, and the guide says so.
 */

const PRIVATE_IMPORT_RE = /from\s+'[^']*core\/src\/[^']*'/;
const SOURCE_RE = /\.m?js$/;

/** @param {string} value */
function resolvePackageDir(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('Usage: crm package validate <package-directory>');
  }
  const dir = isAbsolute(value) ? value : resolve(process.cwd(), value);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(`Not a directory: ${dir}`);
  }
  const entry = join(dir, 'src', 'index.js');
  if (!existsSync(entry)) {
    throw new Error(`No package entry point at ${entry} (a package exports its definition from src/index.js)`);
  }
  return { dir, entry };
}

/**
 * Import the package module and find its definition: either an exported
 * factory (`create<Name>Package`) or an exported definition object. Both are
 * static; neither is chosen by a request.
 *
 * @param {string} entry
 */
async function loadDefinitions(entry) {
  const module = await import(pathToFileURL(entry).href);
  /** @type {any[]} */
  const found = [];
  for (const [name, value] of Object.entries(module)) {
    if (typeof value === 'function' && /^create[A-Za-z0-9]*(Package|Domain)$/.test(name)) {
      try {
        found.push({ export: name, definition: value({}) });
      } catch (error) {
        throw new Error(`${name}() threw while building the package definition: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else if (value && typeof value === 'object' && 'packageContract' in value) {
      found.push({ export: name, definition: value });
    }
  }
  if (found.length === 0) {
    throw new Error('No package definition found: export a definition object or a create…Package() factory from src/index.js');
  }
  return found;
}

/** Every source file in the package, so import rules can be checked statically. */
function sourceFiles(dir) {
  /** @type {string[]} */
  const out = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        walk(full);
      } else if (SOURCE_RE.test(entry.name)) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * Validate one package directory. The result is the same shape whether it
 * passed or failed, so a machine reads one contract either way.
 *
 * @param {{packagePath: string}} params
 */
export async function validatePackageCommand({ packagePath }) {
  const { dir, entry } = resolvePackageDir(packagePath);
  const definitions = await loadDefinitions(entry);
  /** @type {string[]} */
  const problems = [];

  for (const { export: exportName, definition } of definitions) {
    try {
      validatePackageDefinition(definition);
    } catch (error) {
      problems.push(`${exportName}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // Composition-level checks the registry performs at startup: collisions,
  // duplicate identities and unsatisfiable dependencies inside this package.
  if (problems.length === 0) {
    try {
      const registry = new PackageRegistry({
        // A package is validated on its own, so its declared requirements are
        // reported rather than resolved: the composition decides those.
        packages: definitions.map((entry) => ({ ...entry.definition, requires: [] })),
      });
      registry.report();
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }

  // The public-import rule: a package may not reach into kernel internals.
  const privateImports = sourceFiles(dir)
    .filter((file) => PRIVATE_IMPORT_RE.test(readFileSync(file, 'utf8')))
    .map((file) => file.slice(dir.length + 1));
  for (const file of privateImports) {
    problems.push(`${file} imports a private kernel path (packages/core/src/…); import from packages/core/index.js instead`);
  }

  const packages = definitions.map(({ definition }) => ({
    name: definition.name,
    version: definition.version,
    packageContract: definition.packageContract,
    resources: [...(definition.resources ?? [])].sort(),
    actions: (definition.actions ?? []).map((action) => `${action.module}.${action.name}`).sort(),
    policies: (definition.policies ?? []).map((entry) => `${entry.kind}/${entry.definition?.name}@${entry.definition?.version}`).sort(),
    requires: (definition.requires ?? []).map((entry) => `${entry.package}/${entry.capability}@${entry.version}`).sort(),
    provides: (definition.capabilities ?? []).map((entry) => `${entry.name}@${entry.version}`).sort(),
  }));

  return {
    ok: problems.length === 0,
    command: 'package:validate',
    package: basename(dir),
    path: dir,
    packages,
    privateImports,
    problems,
  };
}

/**
 * Inspect a package: what it declares, what it owns and what it needs, with
 * no execution beyond loading the static definition.
 *
 * @param {{packagePath: string}} params
 */
export async function inspectPackageCommand({ packagePath }) {
  const result = await validatePackageCommand({ packagePath });
  return {
    ...result,
    command: 'package:inspect',
    // Metadata is what the schema would publish: function-free by contract.
    metadata: await packageMetadata(packagePath),
  };
}

/** @param {string} packagePath */
async function packageMetadata(packagePath) {
  const { entry } = resolvePackageDir(packagePath);
  const definitions = await loadDefinitions(entry);
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const { definition } of definitions) {
    out[definition.name] = typeof definition.metadata === 'function' ? definition.metadata() : {};
  }
  return out;
}
