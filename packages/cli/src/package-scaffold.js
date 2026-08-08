// @ts-check

import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { SUPPORTED_PACKAGE_CONTRACT, canonicalJson, validatePackageDefinition } from '../../core/index.js';
import { safeMessage } from './safe-text.js';

/**
 * `crm package scaffold <name>` — DX3.
 *
 * It writes the smallest thing that is honestly a package: an identity, a
 * contract version, empty declarations and a README. Nothing else.
 *
 * **It invents no domain semantics.** No record, no action, no policy, no
 * provider, no capability, no Admin section, no Solution Plan, no MCP tool and
 * no per-package Skill. Every one of those would be a guess about a business
 * nobody described, and a guess an agent then has to notice and delete is worse
 * than an empty file it has to fill. What the scaffold produces is a package
 * that **already conforms** — `crm package test` exits 0 on it with no manual
 * edit — so the author starts from a known-good baseline and adds meaning to it.
 *
 * **It composes nothing.** The scaffold writes source and stops. It does not
 * touch `packages/domains/generated/index.js`, does not run a migration, does
 * not open a database and does not install, publish or register anything.
 * Composition is one line a human adds, deliberately, and that is the security
 * model the framework already has.
 *
 * Dry-run is the default; `--apply` is the only thing that writes.
 */

export const PACKAGE_SCAFFOLD_CONTRACT = 1;

/** Where a package lives unless the caller says otherwise. */
const PACKAGES_DIR = 'packages';

/** Staging directory prefix; the finalize step is a single rename. */
const STAGING_PREFIX = '.scaffold-';

/** Everything the scaffold deliberately does not do, stated by code. */
const LIMITATIONS = Object.freeze([
  ['NO_DOMAIN_SEMANTICS', 'the scaffold writes an identity and nothing else. No record, action, policy, provider, capability, Admin section, Solution Plan or MCP tool is generated, because a guess about a business nobody described is worse than an empty file'],
  ['NO_COMPOSITION', 'the package is not added to packages/domains/generated/index.js. Composing it is one line a human adds deliberately, which is the framework’s security model'],
  ['NO_DATABASE_OR_MIGRATION', 'no database is opened and no migration runs. A package owns records only once you add a module manifest and apply it with `crm module create`'],
  ['NO_INSTALL_OR_PUBLISH', 'nothing is downloaded, installed, signed, published or registered anywhere. A package is source in your own repository'],
  ['CONFORMANCE_IS_NOT_CORRECTNESS', 'freshly scaffolded output passes `crm package test`, which proves it satisfies the framework contract. It proves nothing about a domain it does not yet model'],
  ['IDENTITY_UNIQUENESS_NOT_CHECKED', 'the target directory is checked; the composed application is not. Reading which package names are already registered means importing the composition, which runs code, and this command runs none. A duplicate identity is refused by the registry at startup, naming the collision'],
]);

/** @param {string} value */
function posix(value) {
  return value.split(sep).join('/');
}

/**
 * Validate a package name through the contract itself rather than a second
 * slugger. A name the framework would refuse at registration must be refused
 * here, with the framework's own message, and never silently rewritten — an
 * author who asked for `My Package` needs to know what the canonical form is,
 * not to be given something they did not ask for.
 *
 * @param {string} name
 */
export function checkPackageName(name) {
  try {
    validatePackageDefinition({
      packageContract: SUPPORTED_PACKAGE_CONTRACT, name, version: 1, label: 'Scaffold', resources: [],
    });
    return { ok: true, message: null, suggestion: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A suggestion, never an automatic rename.
    const suggestion = String(name ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/^[^a-z]+/, '')
      .slice(0, 64);
    return { ok: false, message, suggestion: suggestion === '' ? null : suggestion };
  }
}

/**
 * Resolve the directory a scaffold would write to, refusing anything that
 * leaves the project — a traversal, an absolute path, or a symlink whose real
 * location is elsewhere.
 *
 * @param {{rootDir: string, name: string, into?: string}} params
 */
export function resolveTarget({ rootDir, name, into = PACKAGES_DIR }) {
  if (isAbsolute(into)) throw new Error('The target directory must be relative to the project, not an absolute path');
  const parent = resolve(rootDir, into);
  const within = relative(rootDir, parent);
  if (within.split(sep)[0] === '..') {
    throw new Error('The target directory must live inside the project: a package is composed by relative import');
  }
  // A symlinked parent could point anywhere; resolve it before trusting it.
  //
  // The parent need not exist — `--into examples/custom-packages` may be the
  // thing that creates it — so the check climbs to the nearest ancestor that
  // *does* exist and resolves that. Checking only an existing parent would let
  // `--into <symlink-out-of-project>/deep` through, because the leaf is absent
  // and `mkdir -p` would happily follow the link on the way to creating it.
  let existing = parent;
  while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
  const realRoot = realpathSync(rootDir);
  const real = join(realpathSync(existing), relative(existing, parent));
  if (relative(realRoot, real).split(sep)[0] === '..') {
    throw new Error('The target directory resolves outside the project through a symbolic link');
  }
  const dir = join(parent, name);
  // `lstat`, not `exists`: a dangling symlink is not "nothing there", and
  // writing through it is exactly the case a target check exists to refuse.
  if (lstatSafe(dir)) {
    throw new Error(`${posix(relative(rootDir, dir))} already exists — scaffolding never overwrites, and a package identity is not reusable`);
  }
  return { parent, dir, relativeDir: posix(relative(rootDir, dir)) };
}

/**
 * The paths the generated content contains, derived from `into` and `name`
 * alone — no filesystem, no root directory. That is what makes the plan
 * byte-identical for the same request in two different checkouts, and it is
 * also why a refused plan can still show what it *would* have written.
 *
 * @param {{name: string, into?: string}} params
 */
export function scaffoldPaths({ name, into = PACKAGES_DIR }) {
  const packagePath = posix(join(into, name));
  // `--into` may nest, so the depth of the kernel import is computed, never
  // assumed. Same for the import a human pastes into the composition file.
  const relativeTo = (from, to) => {
    const value = posix(relative(from, to));
    return value.startsWith('.') ? value : `./${value}`;
  };
  return {
    packagePath,
    coreImport: relativeTo(join(packagePath, 'src'), join(PACKAGES_DIR, 'core/index.js')),
    composeFrom: relativeTo(join(PACKAGES_DIR, 'domains/generated'), packagePath),
  };
}

/** @param {string} path */
function lstatSafe(path) {
  try { return lstatSync(path); } catch { return null; }
}

/**
 * The files a scaffold writes. Two of them, and neither contains a guess.
 *
 * `coreImport` and `packagePath` come from the resolved target rather than
 * being assumed, because `--into` changes both the depth of the kernel import
 * and every path the README tells the author to type.
 *
 * @param {{name: string, into?: string}} params
 */
export function scaffoldFiles({ name, into = PACKAGES_DIR }) {
  const { packagePath, coreImport, composeFrom } = scaffoldPaths({ name, into });
  const identifier = `create${name.split('-').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('')}Package`;
  const source = `// @ts-check

import { definePackage } from '${coreImport}';

/**
 * The **${name}** domain package.
 *
 * Scaffolded empty on purpose: it declares an identity and owns nothing yet.
 * That is already a conforming package — \`crm package test ${packagePath}\`
 * exits 0 on it — so everything you add from here starts from a known-good
 * baseline.
 *
 * ## What to add, and where
 *
 * - **a record you own** — write \`modules/<record>.module.json\`, apply it with
 *   \`npm run crm -- module create ${packagePath}/modules/<record>.module.json --apply\`,
 *   and add its name to \`resources\`.
 * - **an action** — add it to \`actions\`, targeting a record in \`resources\`. An
 *   action targeting a record another *package* owns needs a capability of that
 *   package declared in \`requires\`; a record no package owns belongs to the host
 *   application and needs no declaration.
 * - **a capability you offer** — add it to \`capabilities\`. It is the only
 *   sanctioned way another package may reach your data.
 * - **a policy** — add it to \`policies\`, versioned, with its thresholds in
 *   declared \`config\` so they are covered by the fingerprint.
 *
 * ## Rules this package must keep
 *
 * Import only from \`packages/core/index.js\` — never \`packages/core/src/…\`, and
 * never another package's private \`src/\`. Keep \`metadata()\` function-free and
 * deterministic. Nothing here is loaded dynamically: this package exists because
 * one line in \`packages/domains/generated/index.js\` imports it, and deleting
 * that line removes it.
 *
 * Guides: \`docs/PACKAGE_AUTHORING.md\`, \`DECISIONS.md\` (ADR-018), and the
 * \`build-custom-domain-package\` Skill.
 */
export function ${identifier}(options = {}) {
  void options;
  return definePackage({
    packageContract: ${SUPPORTED_PACKAGE_CONTRACT},
    name: '${name}',
    label: '${name}',
    version: 1,
    description: 'Scaffolded package. Replace this with what it actually does, and what it deliberately does not.',
    // Records this package owns. Each needs a manifest under modules/.
    resources: [],
    // Capabilities of other packages this one reaches. A capability edge is the
    // only sanctioned reach; a private import is refused.
    requires: [],
    // Capabilities this package offers to others, each with a create().
    capabilities: [],
    // Actions on records this package owns.
    actions: [],
    // Versioned, fingerprinted policies. Thresholds live in declared config.
    policies: [],
    /** Function-free, deterministic schema metadata. Never a handler or a secret. */
    metadata() {
      return { ${name.replace(/-([a-z])/g, (_, c) => c.toUpperCase())}Contract: 1 };
    },
  });
}
`;

  const readme = `# ${name}

A domain package for this repository. Scaffolded with \`crm package scaffold\`,
which writes an identity and nothing else — every business decision below is
still yours to make.

## What it owns

Nothing yet. Add a record by writing \`modules/<record>.module.json\`, applying it
with the module factory, and listing its name in \`resources\`.

## What it needs

Nothing yet. A package reaches another package **only** through a declared
capability in \`requires\`. Acting on a record another package owns without
declaring that package is refused by \`crm package test\`, because the package
could not then be composed into a project that lacks the owner. Records that no
package owns belong to the host application and need no declaration.

## What it deliberately does not do

Say so here, explicitly. A package that lists its omissions is a package nobody
has to guess about — and the reviews in this repository treat an overstated
capability as a defect of the same kind as a missing check.

## Enabling it

Composition is deliberate and manual. Add one line to
\`packages/domains/generated/index.js\`:

\`\`\`js
import { ${identifier} } from '${composeFrom}/src/index.js';

export const generatedDomains = [
  ${identifier}(),
];
\`\`\`

Deleting that line removes the package. Its data is left alone — the framework
never drops your tables behind you.

## Proving it

\`\`\`bash
npm run crm -- package inspect ${packagePath}
npm run crm -- package validate ${packagePath}
npm run crm -- package test ${packagePath} --json
npm run verify
\`\`\`

\`package test\` proves this package satisfies the **framework contract**. It
proves nothing about whether the domain logic is right — that is what this
package's own tests are for, and the report says so as
\`DOMAIN_CORRECTNESS_NOT_PROVEN\`.

Guides: \`docs/PACKAGE_AUTHORING.md\`, \`DECISIONS.md\` (ADR-018).
`;

  return [
    { relativePath: 'src/index.js', content: source },
    { relativePath: 'README.md', content: readme },
  ];
}

/**
 * The deterministic plan. Same inputs, byte-identical output — no timestamp, no
 * random id, no absolute path and no environment-dependent content.
 *
 * @param {{name: string, rootDir?: string, into?: string}} params
 */
export function planPackageScaffold({ name, rootDir = process.cwd(), into = PACKAGES_DIR }) {
  const root = isAbsolute(rootDir) ? rootDir : resolve(process.cwd(), rootDir);
  /** @type {Array<{code: string, message: string}>} */
  const problems = [];

  const named = checkPackageName(name);
  if (!named.ok) {
    problems.push({
      code: 'PACKAGE_NAME_INVALID',
      message: `${named.message}${named.suggestion ? `. A canonical form of this name would be "${named.suggestion}" — ask for it explicitly rather than having it chosen for you` : ''}`,
    });
  }

  let target = null;
  if (named.ok) {
    try {
      target = resolveTarget({ rootDir: root, name, into });
    } catch (error) {
      // Scrubbed like every other read-only report in this repository: a
      // refusal is pasted into issues, and the operator's home directory is
      // not diagnostic.
      problems.push({ code: 'TARGET_UNAVAILABLE', message: safeMessage(error, root) });
    }
  }

  // Content depends on `name` and `into` only, so a refused plan can still show
  // what it would have written — unless `into` itself is the thing refused.
  const describable = named.ok && !isAbsolute(into);
  const files = describable ? scaffoldFiles({ name, into }) : [];
  const plan = {
    packageScaffoldContract: PACKAGE_SCAFFOLD_CONTRACT,
    command: 'package:scaffold',
    ok: problems.length === 0,
    mode: 'plan',
    name,
    // Repository-relative, never absolute: this JSON is written for agents and
    // pasted into issues.
    target: target?.relativeDir ?? (describable ? scaffoldPaths({ name, into }).packagePath : null),
    files: files.map((file) => ({
      relativePath: file.relativePath,
      operation: 'create',
      bytes: Buffer.byteLength(file.content, 'utf8'),
      // The content itself is deliberately not in the document: a plan is a
      // description of what would happen, and a reader who wants the bytes can
      // apply it into a throwaway directory.
      contentHash: createHash('sha256').update(file.content).digest('hex'),
    })),
    package: {
      name,
      version: 1,
      packageContract: SUPPORTED_PACKAGE_CONTRACT,
      resources: [],
      actions: [],
      requires: [],
      provides: [],
      policies: [],
    },
    conformance: {
      expectation: 'passes `crm package validate`, `crm package inspect` and `crm package test` with no manual edit',
      notApplicableReasons: ['NO_RESOURCES_DECLARED', 'NO_ACTIONS_DECLARED', 'NO_DEPENDENCIES_DECLARED', 'NO_CAPABILITIES_OFFERED', 'NO_POLICIES_DECLARED'],
      proves: 'framework conformance only; it models no domain yet',
    },
    problems,
    limitations: LIMITATIONS.map(([code, message]) => ({ code, message })),
  };
  // The digest covers what would be written, not where the caller stood.
  plan.fingerprint = createHash('sha256').update(canonicalJson({
    packageScaffoldContract: plan.packageScaffoldContract,
    name: plan.name,
    files: plan.files,
    package: plan.package,
    problems: problems.map((entry) => entry.code).sort(),
  })).digest('hex');
  return { plan, files, root, target };
}

/**
 * Write the scaffold, atomically.
 *
 * Every file is staged in a sibling directory and the package appears through a
 * single rename, so a failure at any point leaves no partial package behind and
 * two concurrent applies resolve to one winner and one stable conflict.
 *
 * @param {{name: string, rootDir?: string, into?: string}} params
 */
export function applyPackageScaffold({ name, rootDir = process.cwd(), into = PACKAGES_DIR }) {
  // Re-planned here rather than trusting a plan the caller is holding: the
  // filesystem may have moved since they asked.
  const { plan, files, root, target } = planPackageScaffold({ name, rootDir, into });
  if (!plan.ok || !target) return { ...plan, mode: 'refused' };

  const staging = join(target.parent, `${STAGING_PREFIX}${name}`);
  const cleanup = () => { rmSync(staging, { recursive: true, force: true }); };

  try {
    mkdirSync(target.parent, { recursive: true });
    // Non-recursive on purpose: `mkdir` without `recursive` fails on an
    // existing directory, which makes claiming the staging slot atomic. A
    // `exists ? refuse : create` pair would leave a window in which two
    // concurrent applies both believe they own it.
    mkdirSync(staging);
  } catch (error) {
    return {
      ...plan,
      mode: 'refused',
      ok: false,
      problems: [...plan.problems, error.code === 'EEXIST' ? {
        code: 'SCAFFOLD_IN_PROGRESS',
        message: `${posix(relative(root, staging))} exists: another scaffold of this package is running, or one failed and left staging behind`,
      } : {
        code: 'SCAFFOLD_NOT_WRITTEN',
        message: `nothing was written: ${safeMessage(error, root)}`,
      }],
    };
  }

  try {
    for (const file of files) {
      const destination = join(staging, ...file.relativePath.split('/'));
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, file.content);
    }
    // The package appears in one step. Rename onto an existing directory fails,
    // which is exactly the outcome a second concurrent apply should get.
    renameSync(staging, target.dir);
  } catch (error) {
    cleanup();
    return {
      ...plan,
      mode: 'refused',
      ok: false,
      problems: [...plan.problems, {
        code: 'SCAFFOLD_NOT_WRITTEN',
        message: `nothing was written: ${safeMessage(error, root)}`,
      }],
    };
  }

  // Verify what landed, rather than reporting what was intended.
  const written = readdirSync(target.dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => posix(relative(target.dir, join(entry.parentPath ?? entry.path, entry.name))))
    .sort();
  const expected = files.map((file) => file.relativePath).sort();
  if (JSON.stringify(written) !== JSON.stringify(expected)) {
    return {
      ...plan,
      mode: 'refused',
      ok: false,
      problems: [...plan.problems, {
        code: 'SCAFFOLD_INCOMPLETE',
        message: `the scaffold landed with ${written.join(', ') || 'no files'} instead of ${expected.join(', ')}`,
      }],
    };
  }

  return {
    ...plan,
    mode: 'applied',
    created: expected.map((relativePath) => posix(join(target.relativeDir, relativePath))),
    nextSteps: [
      `npm run crm -- package test ${target.relativeDir} --json`,
      'Add records, actions, capabilities and policies — the scaffold declares none.',
      `Compose it by adding one import to ${posix(join(PACKAGES_DIR, 'domains/generated/index.js'))}; the scaffold deliberately does not.`,
    ],
  };
}

/** The human view. `--json` is the contract; this is a convenience. */
export function renderScaffold(result) {
  const lines = [];
  lines.push(`Agent CRM package scaffold (contract ${result.packageScaffoldContract})`);
  lines.push(`Package: ${result.name}`);
  lines.push(`Target:  ${result.target}`);
  lines.push(`Mode:    ${result.mode}`);
  if (result.problems.length > 0) {
    lines.push('', 'Problems');
    for (const problem of result.problems) lines.push(`  [${problem.code}] ${problem.message}`);
  } else if (result.mode === 'applied') {
    lines.push('', 'Created');
    for (const file of result.created) lines.push(`  ${file}`);
    lines.push('', 'Next');
    for (const step of result.nextSteps) lines.push(`  ${step}`);
  } else {
    lines.push('', 'Would create');
    for (const file of result.files) lines.push(`  ${file.relativePath} (${file.bytes} bytes)`);
    lines.push('', 'Nothing was written. Re-run with --apply.');
  }
  lines.push('', 'Limitations');
  for (const limitation of result.limitations) lines.push(`  [${limitation.code}] ${limitation.message}`);
  lines.push('', 'Run with --json for the machine-readable plan — this view is a convenience, not the contract.');
  return lines.join('\n');
}

/**
 * The CLI entry point.
 *
 * Exit codes are part of the contract, because an agent checks its own work by
 * reading them: **0** planned or applied, **1** refused. There is no third
 * code — the scaffold reads no package and boots no application, so it has no
 * "unreadable" case to distinguish.
 *
 * `--apply` is the only thing that writes, and an explicit `--dry-run` beats it,
 * matching `module:create` and `module:migration`.
 *
 * @param {{name?: string, rootDir?: string, into?: string, apply?: boolean, json?: boolean}} params
 */
export function packageScaffoldCommand({ name, rootDir = process.cwd(), into = PACKAGES_DIR, apply = false, json = false } = {}) {
  if (typeof name !== 'string' || name === '') {
    const refusal = {
      packageScaffoldContract: PACKAGE_SCAFFOLD_CONTRACT,
      command: 'package:scaffold',
      ok: false,
      mode: 'refused',
      name: name ?? null,
      target: null,
      files: [],
      problems: [{ code: 'PACKAGE_NAME_MISSING', message: 'Usage: agent-crm package scaffold <package-name> [--into dir] [--apply] [--json]' }],
      limitations: LIMITATIONS.map(([code, message]) => ({ code, message })),
    };
    console.log(json ? JSON.stringify(refusal, null, 2) : renderScaffold(refusal));
    return { exitCode: 1, result: refusal };
  }

  const result = apply
    ? applyPackageScaffold({ name, rootDir, into })
    : planPackageScaffold({ name, rootDir, into }).plan;
  console.log(json ? JSON.stringify(result, null, 2) : renderScaffold(result));
  return { exitCode: result.ok ? 0 : 1, result };
}
