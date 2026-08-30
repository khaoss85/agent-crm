// @ts-check

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectFiles } from './project-files.js';

/**
 * `create-accordo <directory>` — the project bootstrap.
 *
 * It answers the one question no other command in this framework can:
 *
 * > **Give me a new Accordo project from nothing.**
 *
 * ## Why this is not `accordo package scaffold`
 *
 * DX3 writes an empty *package* into a project that already exists. It is a
 * subcommand of `accordo`, so running it requires having `accordo` — which
 * requires having a project, which is exactly what the caller does not have. A
 * rung that requires the ladder cannot be the bottom of the ladder. This
 * command is the bottom: it creates the container a package later goes into,
 * and it composes no domain at all.
 *
 * ## Why it may not import the framework
 *
 * Every other command here is free to reach for `canonicalJson`,
 * `validatePackageDefinition` or `safeMessage` from `packages/core`. This one
 * runs at the moment *before* the framework exists on the caller's disk, and
 * a malformed or incomplete package may have no framework beside it at all. So
 * it is standalone Node with a local canonical serializer, and when
 * the framework source is absent it reports `FRAMEWORK_SOURCE_UNAVAILABLE` and
 * exits 2 rather than crashing on an import. That duplication is deliberate.
 *
 * ## What it deliberately does not do
 *
 * It reaches **no network**: nothing is fetched, downloaded, installed,
 * published or registered, and the framework's standing rule that nothing here
 * touches the network is the reason. It composes **no domain package** — the
 * generated `packages/domains/generated/index.js` is the empty one this
 * repository ships, because a project that arrives carrying somebody else's
 * Lead model is a guess about a business nobody described. It runs **no
 * migration** and opens **no database**. And it publishes nothing to npm: the
 * registry names are reservations, and turning one into a real package is a
 * human decision this code cannot take.
 *
 * Dry-run is the default; `--apply` is the only thing that writes.
 */

export const PROJECT_BOOTSTRAP_CONTRACT = 1;

/** Staging directory prefix; the finalize step is a single rename. */
const STAGING_PREFIX = '.accordo-bootstrap-';

/**
 * The framework files whose presence defines "this directory is the framework
 * source". All four, not one: a directory with a stray `packages/core` is not a
 * checkout, and a bootstrap that copied from it would produce a project that
 * cannot boot.
 */
const SOURCE_MARKERS = Object.freeze([
  'packages/core/index.js',
  'packages/cli/bin/accordo.js',
  'packages/app/src/index.js',
  'packages/domains/generated/index.js',
]);

/**
 * What is copied into a new project, declared rather than globbed.
 *
 * A glob of "everything" would drag in this repository's own tests, site,
 * benchmarks, plans and ADRs — none of which belong to a customer's project,
 * and `docs/SKILL_PACKAGING.md` already decides that no repository Markdown
 * ships into a generated project.
 *
 * `skills/` is the exception that proves the rule: it is the *published*
 * bundle, whose every entry declares `tier: generated-project | any-project`
 * and a `degradesTo`. A project created here is precisely that audience.
 */
export const SOURCE_MANIFEST = Object.freeze([
  { path: 'packages', why: 'the framework: kernel, CLI, MCP server, modules, domain packages and SDK' },
  { path: 'apps', why: 'the local HTTP server and the generated Admin' },
  { path: 'skills', why: 'the published agent skills, whose declared tiers target exactly this project' },
  { path: 'examples/modules', why: 'the two module manifests the create-crm-module skill names as its project surface' },
]);

/**
 * Never copied. `create-accordo` excludes itself because a project is not a
 * bootstrapper, and `data`/`node_modules`/`.git` are state rather than source.
 */
const EXCLUDED = Object.freeze([
  'node_modules',
  '.git',
  'data',
  'packages/create-accordo',
]);

/** Filenames that are never source, wherever they appear. */
const EXCLUDED_NAMES = Object.freeze([/^\.DS_Store$/, /^\.scaffold-/, /^\.accordo-bootstrap-/, /\.sqlite(-shm|-wal)?$/]);

/**
 * Everything the generated project is not, stated by code rather than left to a
 * reader's optimism. Every one of these is a hard boundary on what may be
 * claimed about the output.
 */
const LIMITATIONS = Object.freeze([
  ['SOURCE_ORIGIN_NOT_VERIFIED', 'the command found framework source beside itself, either in a checkout or in a bundled package. That proves the bytes are present, not where they came from, whether npm served them or whether a provenance attestation exists'],
  ['NO_AUTHENTICATION', 'the generated project has no authentication. Actor headers are not identity, and its HTTP server is local-development-only'],
  ['NO_TENANCY', 'there is no data boundary between customers. One database is one undivided dataset'],
  ['NO_RBAC', 'there is no role-based access control. Approval keys are labels, and only the actor *type* is enforced'],
  ['SQLITE_ONLY', 'the only database adapter is SQLite through node:sqlite. No PostgreSQL adapter exists'],
  ['LOCAL_DEVELOPMENT_ONLY', 'nothing in the generated project is deployable. There is no deploy path, no hosting and no production configuration, and the three gaps above are why'],
  ['NO_DOMAIN_PACKAGES_COMPOSED', 'the project starts with the kernel only: packages/domains/generated/index.js composes zero domain packages, exactly as the framework repository does. The domain source is on disk and inert until one line composes it — `accordo package scaffold <name>` writes a new one'],
  ['NO_NETWORK_ACCESS', 'nothing is fetched, downloaded, installed, published or registered. The project is a copy of source that was already on this disk'],
  ['SOURCE_IS_A_COPY_NOT_A_DEPENDENCY', 'the framework is vendored into the project rather than depended on by version. You own the result outright, and upgrading means merging changes rather than bumping a version'],
  ['PROVIDERS_ARE_OFFLINE_FIXTURES', 'every provider adapter in the copied source is an offline fixture. No real enrichment, signature or catalog provider has ever been contacted'],
  ['NO_SCHEDULER_OR_OUTBOX', 'there is no scheduler and no durable outbox. Nothing fires on a date, and post-commit event delivery dies with the process'],
  ['SOURCE_IS_TRUSTED', 'the copied source runs with the operator’s authority. Nothing here is sandboxed, signed or verified, and this command executes none of it'],
  ['CONFORMANCE_IS_NOT_CORRECTNESS', 'the generated project boots, inspects cleanly and passes its own declared checks. It models no business, and none of that is evidence that anything you build on it is right'],
  ['FINALIZATION_REPLACES_AN_EMPTY_DIRECTORY', 'the project is committed by one `rename` onto the target, which POSIX refuses for a file, a symlink and a non-empty directory but allows onto an *empty* one. A target checked as free microseconds earlier and created empty in between would therefore be replaced. Nothing is lost — an empty directory has no content — and Windows refuses every existing destination'],
]);

/**
 * npm names that are structurally valid but must never be a project name.
 *
 * `__proto__` is already refused by the leading-underscore rule; `constructor`
 * and `prototype` are not, and they are refused here so that no downstream
 * consumer of this report — a generator, a template, a tool that reads the name
 * back into an object — can be handed one of them by this command.
 */
const REFUSED_NAMES = Object.freeze(['__proto__', 'constructor', 'prototype', 'node_modules', 'favicon.ico']);

/** Node core module names. npm refuses a new package that shadows one. */
const CORE_MODULE_NAMES = Object.freeze([
  'assert', 'buffer', 'child_process', 'cluster', 'console', 'constants', 'crypto', 'dgram', 'dns',
  'domain', 'events', 'fs', 'http', 'http2', 'https', 'inspector', 'module', 'net', 'os', 'path',
  'perf_hooks', 'process', 'punycode', 'querystring', 'readline', 'repl', 'stream', 'string_decoder',
  'sys', 'timers', 'tls', 'trace_events', 'tty', 'url', 'util', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
]);

/** @param {string} value */
function posix(value) {
  return value.split(sep).join('/');
}

/**
 * Deterministic JSON, so a fingerprint means the same thing in two checkouts.
 * A local copy of the kernel's `canonicalJson` for the reason stated at the top
 * of this file: this command must work when the kernel is not there.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.keys(/** @type {Record<string, unknown>} */ (value))
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(/** @type {Record<string, unknown>} */ (value)[key])}`);
  return `{${entries.join(',')}}`;
}

/**
 * An error message with absolute paths reduced to something relative, because
 * this report is written for agents and pasted into issues and the operator's
 * home directory is not diagnostic.
 *
 * @param {unknown} error @param {string[]} roots
 */
export function safeMessage(error, roots = []) {
  let message = error instanceof Error ? error.message : String(error);
  for (const root of roots.filter(Boolean).sort((a, b) => b.length - a.length)) {
    message = message.split(root).join('.');
  }
  return message.split('\n')[0].slice(0, 300);
}

/** Text that is safe to echo back into a JSON document. */
function echoable(value, limit = 200) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '\ufffd').slice(0, limit);
}

/**
 * Validate a project name against npm's package-name rules, deterministically
 * and offline. It never contacts the registry: whether a name is *taken* is not
 * a property this command can know, and pretending otherwise would make the
 * result depend on the network.
 *
 * A refusal carries a **suggestion**, and the suggestion is never applied. An
 * author who typed `My CRM` needs to be told the canonical form is `my-crm`,
 * not handed a project they did not ask for.
 *
 * @param {unknown} name
 */
export function checkProjectName(name) {
  const failure = nameFailure(name);
  if (failure === null) return { ok: true, message: null, suggestion: null };
  return { ok: false, message: failure, suggestion: suggestName(name) };
}

/**
 * The rules themselves, with **no** suggestion attached.
 *
 * Split out from `checkProjectName` for one reason, found by the tests rather
 * than by inspection: a suggestion has to be validated before it is offered,
 * and a validator that produces a suggestion which it then validates recurses
 * forever on any input whose canonical form is also refused (`__proto__` is
 * exactly that — it canonicalizes to `proto`, but `---` canonicalizes to the
 * empty string and `constructor` to itself). One direction of the dependency,
 * and the cycle cannot exist.
 *
 * @param {unknown} name
 * @returns {string|null} the reason it is refused, or null if it is fine
 */
function nameFailure(name) {
  if (typeof name !== 'string' || name === '') return 'a project name is required';
  if (name.length > 214) return `an npm package name is at most 214 characters; this one is ${name.length}`;
  if (name !== name.trim()) return 'a project name may not begin or end with whitespace';
  if (name.toLowerCase() !== name) return 'an npm package name may not contain uppercase letters';
  if (name.startsWith('.') || name.startsWith('_')) return 'an npm package name may not begin with a dot or an underscore';
  if (name.includes('/') || name.includes('\\')) return 'a project name is a name, not a path: it may not contain a path separator';
  if (name.includes('..')) return 'a project name may not contain ".."';
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) {
    return 'an npm package name may contain only lowercase letters, digits, hyphen, dot and underscore, and must start with a letter or a digit';
  }
  if (REFUSED_NAMES.includes(name)) return `"${name}" is never a safe project name`;
  if (CORE_MODULE_NAMES.includes(name)) return `"${name}" is the name of a Node core module, which npm refuses for a new package`;
  return null;
}

/**
 * A canonical form of whatever was typed. Returned as advice; applying it is
 * the caller's explicit act, through `--name`.
 *
 * @param {unknown} name
 */
function suggestName(name) {
  const candidate = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 214);
  if (candidate === '') return null;
  // A suggestion this command would itself refuse is not a suggestion.
  return nameFailure(candidate) === null ? candidate : null;
}

/**
 * Find the framework source by walking up from this file.
 *
 * In this repository the answer is the repository root, two levels up. In the
 * assembled npm package the answer is the sibling `framework/` directory. When
 * neither layout exists the answer is `null`, and the caller reports it rather
 * than crashing on a missing import.
 *
 * @param {string} [from]
 */
export function resolveFrameworkSource(from = dirname(fileURLToPath(import.meta.url))) {
  let directory = resolve(from);
  const bundled = resolve(directory, '..', 'framework');
  if (SOURCE_MARKERS.every((marker) => existsSync(join(bundled, ...marker.split('/'))))) return bundled;
  for (;;) {
    if (SOURCE_MARKERS.every((marker) => existsSync(join(directory, ...marker.split('/'))))) return directory;
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

/** @param {string} path */
function lstatSafe(path) {
  try { return lstatSync(path); } catch { return null; }
}

/**
 * Resolve the physical destination of a path that may not exist yet.
 *
 * `realpath` cannot resolve a missing target, so walk to the nearest existing
 * ancestor, resolve every symlink there, then append the missing suffix. This
 * keeps the source-overlap boundary true when the caller reaches the checkout
 * through a symlinked parent rather than naming the checkout lexically.
 *
 * @param {string} path
 * @returns {string|null}
 */
function physicalDestination(path) {
  let cursor = path;
  const suffix = [];
  while (!lstatSafe(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) return null;
    suffix.unshift(basename(cursor));
    cursor = parent;
  }
  try {
    return resolve(realpathSync(cursor), ...suffix);
  } catch {
    return null;
  }
}

/** @param {string} parent @param {string} child */
function pathsOverlap(parent, child) {
  const fromParent = relative(parent, child);
  const toParent = relative(child, parent);
  const inside = fromParent === '' || (!fromParent.startsWith('..') && !isAbsolute(fromParent));
  const contains = toParent === '' || (!toParent.startsWith('..') && !isAbsolute(toParent));
  return inside || contains;
}

/**
 * Every file the manifest covers, with its content hash.
 *
 * Symlinks are **refused, never followed**. A symlink in the source would make
 * the copy depend on something outside the manifest, which is the one property
 * this command sells. Directory entries are sorted so the inventory — and
 * therefore the fingerprint — is identical on two machines whose filesystems
 * return entries in different orders.
 *
 * @param {string} sourceRoot
 * @returns {{files: {path: string, bytes: number, hash: string}[], problems: {code: string, message: string}[]}}
 */
export function collectSource(sourceRoot) {
  /** @type {{path: string, bytes: number, hash: string}[]} */
  const files = [];
  /** @type {{code: string, message: string}[]} */
  const problems = [];
  const excluded = new Set(EXCLUDED.map((path) => posix(path)));

  /** @param {string} relativeDir */
  const walk = (relativeDir) => {
    const absolute = join(sourceRoot, ...relativeDir.split('/'));
    let entries;
    try {
      entries = readdirSync(absolute, { withFileTypes: true });
    } catch (error) {
      problems.push({ code: 'SOURCE_NOT_READABLE', message: `${relativeDir} could not be read: ${safeMessage(error, [sourceRoot])}` });
      return;
    }
    for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const child = `${relativeDir}/${entry.name}`;
      if (excluded.has(child) || EXCLUDED.includes(entry.name)) continue;
      if (EXCLUDED_NAMES.some((pattern) => pattern.test(entry.name))) continue;
      if (entry.isSymbolicLink()) {
        problems.push({ code: 'SOURCE_NOT_READABLE', message: `${child} is a symbolic link; the bootstrap copies files, never links out of the manifest` });
        continue;
      }
      if (entry.isDirectory()) { walk(child); continue; }
      if (!entry.isFile()) {
        problems.push({ code: 'SOURCE_NOT_READABLE', message: `${child} is neither a file nor a directory` });
        continue;
      }
      const full = join(sourceRoot, ...child.split('/'));
      try {
        const content = readFileSync(full);
        files.push({ path: child, bytes: content.byteLength, hash: createHash('sha256').update(content).digest('hex') });
      } catch (error) {
        problems.push({ code: 'SOURCE_NOT_READABLE', message: `${child} could not be read: ${safeMessage(error, [sourceRoot])}` });
      }
    }
  };

  for (const entry of SOURCE_MANIFEST) {
    const absolute = join(sourceRoot, ...entry.path.split('/'));
    const stat = lstatSafe(absolute);
    if (!stat || !stat.isDirectory()) {
      problems.push({ code: 'FRAMEWORK_SOURCE_INCOMPLETE', message: `the framework source has no ${entry.path}/ directory, which carries ${entry.why}` });
      continue;
    }
    walk(entry.path);
  }

  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  return { files, problems };
}

/**
 * Where the project would go, and every reason it could not go there.
 *
 * An absolute target is ordinary usage here and is allowed: this is the
 * caller's own machine and there is no project to escape from yet. What is
 * refused is a target that is not empty, is not a directory, or lives inside
 * the framework source — bootstrapping the framework onto itself would copy a
 * tree into its own subdirectory while reading it.
 *
 * @param {{directory: unknown, cwd: string, sourceRoot: string|null}} params
 */
export function resolveTarget({ directory, cwd, sourceRoot }) {
  if (typeof directory !== 'string' || directory.trim() === '') {
    return { ok: false, code: 'TARGET_MISSING', message: 'a target directory is required: create-accordo <directory>', target: null };
  }
  if (/[\u0000-\u001f\u007f]/.test(directory)) {
    return { ok: false, code: 'TARGET_PATH_INVALID', message: 'the target directory contains a control character or a null byte', target: null };
  }

  const target = isAbsolute(directory) ? resolve(directory) : resolve(cwd, directory);

  if (sourceRoot) {
    const physicalSource = physicalDestination(resolve(sourceRoot));
    const physicalTarget = physicalDestination(target);
    if (pathsOverlap(resolve(sourceRoot), target)
      || (physicalSource && physicalTarget && pathsOverlap(physicalSource, physicalTarget))) {
      return {
        ok: false,
        code: 'TARGET_INSIDE_FRAMEWORK_SOURCE',
        message: 'the target overlaps the framework source this bootstrap copies from. Choose a directory outside the framework checkout',
        target,
      };
    }
  }

  // `lstat`, not `exists`: a dangling symlink is not "nothing there", and
  // writing through it is exactly the case a target check exists to refuse.
  const stat = lstatSafe(target);
  if (stat && !stat.isDirectory()) {
    return {
      ok: false,
      code: 'TARGET_NOT_A_DIRECTORY',
      // The last path segment only, and bounded: enough to identify what is in
      // the way, without pasting the operator's directory layout into a report
      // that gets attached to issues.
      message: `${echoable(basename(target), 80)} already exists and is not a directory. The bootstrap never overwrites anything`,
      target,
    };
  }
  if (stat) {
    let entries = [];
    try {
      entries = readdirSync(target);
    } catch (error) {
      return { ok: false, code: 'TARGET_PATH_INVALID', message: `the target directory could not be read: ${safeMessage(error, [target, cwd])}`, target };
    }
    if (entries.length > 0) {
      return {
        ok: false,
        code: 'TARGET_NOT_EMPTY',
        message: `the target directory already contains ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}. The bootstrap refuses a non-empty directory rather than merging into it or overwriting a file`,
        target,
      };
    }
  }
  return { ok: true, code: null, message: null, target };
}

/**
 * The deterministic plan. Same checkout, same request, byte-identical answer —
 * no timestamp, no random id, no absolute path in the document.
 *
 * @param {{directory: unknown, name?: unknown, cwd?: string, sourceRoot?: string|null}} params
 */
export function planProjectBootstrap({ directory, name, cwd = process.cwd(), sourceRoot = resolveFrameworkSource() }) {
  /** @type {{code: string, message: string}[]} */
  const problems = [];

  // The name defaults to the directory's basename, and a basename that is not a
  // valid npm package name is a refusal with a suggestion — never a rename.
  // Resolved against the caller's `cwd`, not `process.cwd()`: `.` and `../thing`
  // must name the directory the caller meant, not the one this process happens
  // to stand in.
  const requestedName = name === undefined || name === null
    ? (typeof directory === 'string' && directory.trim() !== '' ? basename(resolve(cwd, String(directory))) : '')
    : name;
  const named = checkProjectName(requestedName);
  if (!named.ok) {
    problems.push({
      code: 'PROJECT_NAME_INVALID',
      message: `${named.message}${named.suggestion ? `. A canonical form of this name would be "${named.suggestion}" — pass it with --name rather than having it chosen for you` : ''}`,
    });
  }

  if (!sourceRoot) {
    problems.push({
      code: 'FRAMEWORK_SOURCE_UNAVAILABLE',
      message: 'no Accordo framework source was found beside this command, so there is nothing to create a project from. '
        + 'This bootstrap copies source already bundled with it or available in a framework checkout; it downloads nothing',
    });
  }

  const located = resolveTarget({ directory, cwd, sourceRoot });
  if (!located.ok) problems.push({ code: located.code, message: located.message });

  const source = sourceRoot ? collectSource(sourceRoot) : { files: [], problems: [] };
  problems.push(...source.problems);

  const projectName = named.ok ? String(requestedName) : null;
  const files = projectName ? projectFiles({ name: projectName }) : [];

  const sourceFingerprint = sourceRoot
    ? createHash('sha256').update(canonicalJson(source.files.map((file) => [file.path, file.hash]))).digest('hex')
    : null;

  const report = {
    projectBootstrapContract: PROJECT_BOOTSTRAP_CONTRACT,
    command: 'project:bootstrap',
    ok: problems.length === 0,
    mode: 'plan',
    // Why this run is in this mode, always present: a plan and a successful
    // apply both answer 0, and a caller who passed `--apply` and got a plan is
    // entitled to be told which flag won rather than left to infer it.
    modeReason: 'no --apply was given, so nothing was written',
    project: {
      name: projectName,
      // Echoed as the caller typed it, sanitized and bounded. This one path is
      // the subject of the command rather than incidental machine layout, so
      // hiding it would remove the only thing the reader asked about.
      directory: echoable(directory),
      kind: 'accordo-application',
      // Stated, not discovered: the generated composition file is the empty one.
      composedPackages: [],
      databaseBackend: 'sqlite (node:sqlite)',
      productionPosture: 'not a readiness claim: the framework authenticates nobody (a deployment adapter supplies verified identity), while tenancy — one tenant per application instance — and authorization are owned and enforced by the framework. SQLite or dedicated-database PostgreSQL; shared-database tenancy, durable jobs, secrets and backups are absent',
    },
    source: {
      resolved: Boolean(sourceRoot),
      manifest: SOURCE_MANIFEST.map((entry) => ({ path: entry.path, why: entry.why })),
      excluded: [...EXCLUDED].sort(),
      files: source.files.length,
      bytes: source.files.reduce((total, file) => total + file.bytes, 0),
      // Content-addressed over every copied file, so two bootstraps can be
      // compared without comparing two hundred files.
      fingerprint: sourceFingerprint,
    },
    files: files.map((file) => ({
      relativePath: file.relativePath,
      operation: 'create',
      bytes: Buffer.byteLength(file.content, 'utf8'),
      // The bytes themselves are deliberately not in the document: a plan
      // describes what would happen, and a reader who wants the content can
      // apply it into a throwaway directory.
      contentHash: createHash('sha256').update(file.content).digest('hex'),
    })),
    checks: {
      declared: ['npm test', 'npm run smoke', 'npm run check', 'npm run verify'],
      expectation: 'the generated project needs no install, boots on node:sqlite, reports valid from `accordo app inspect --json` and exits 0 from `accordo project doctor --json`',
    },
    nextSteps: projectName
      ? [
        `cd ${projectName}`,
        'npm run verify',
        'npm run crm -- app inspect --json',
        'npm run crm -- project doctor --json',
        'npm run crm -- package scaffold <your-domain>   # then compose it by hand',
      ]
      : [],
    problems,
    limitations: LIMITATIONS.map(([code, message]) => ({ code, message })),
  };

  report.fingerprint = createHash('sha256').update(canonicalJson({
    projectBootstrapContract: report.projectBootstrapContract,
    name: report.project.name,
    files: report.files,
    source: report.source.fingerprint,
    problems: problems.map((entry) => entry.code).sort(),
    // Deliberately NOT included: the target directory and the mode. The
    // fingerprint identifies the *project this bootstrap produces*, so two
    // checkouts asking the same question agree; where somebody chose to put it
    // is not part of that question.
  })).digest('hex');

  return { report, files, sourceRoot, target: located.target, sourceFiles: source.files };
}

/**
 * A staging directory name unique to this run.
 *
 * Unique, not fixed, and that is the whole design: a fixed name is a lock, and
 * a lock a crashed process holds forever has to be broken by hand. Two calls
 * never agree, so no run can be blocked by — or write into — another run's
 * directory.
 */
export function stagingName() {
  return `${STAGING_PREFIX}${randomUUID().slice(0, 8)}`;
}

/**
 * Write the project.
 *
 * **Where the commit point is.** Everything is written into a staging directory
 * whose name is unique to this run, beside the target, and the project becomes
 * visible through one `rename` of that directory onto the target. That rename
 * is the commit point and the only race: before it, nothing of this run exists
 * at the target; after it, everything does. There is no window in which a
 * half-copied project looks like a project.
 *
 * @param {{directory: unknown, name?: unknown, cwd?: string, sourceRoot?: string|null}} params
 */
export function applyProjectBootstrap({ directory, name, cwd = process.cwd(), sourceRoot = resolveFrameworkSource() }) {
  // Re-planned here rather than trusting a plan the caller is holding: a plan
  // reserves nothing, and the filesystem may have moved since they asked.
  const planned = planProjectBootstrap({ directory, name, cwd, sourceRoot });
  const { report, files, target, sourceFiles } = planned;
  if (!report.ok || !target || !sourceRoot) return { ...report, mode: 'refused', modeReason: 'the request was refused, so nothing was written' };

  const scrub = [sourceRoot, cwd, dirname(target)];
  const refuse = (code, message) => ({
    ...report,
    mode: 'refused',
    ok: false,
    modeReason: 'the write was refused or failed, so nothing was left behind',
    problems: [...report.problems, { code, message }],
  });

  let staging = null;
  const cleanup = () => { if (staging) rmSync(staging, { recursive: true, force: true }); };

  try {
    mkdirSync(dirname(target), { recursive: true });
    // Non-recursive on purpose, so that even the astronomically unlikely name
    // collision is an error rather than two runs sharing a directory.
    staging = join(dirname(target), stagingName());
    mkdirSync(staging);
  } catch (error) {
    staging = null;
    return refuse('BOOTSTRAP_NOT_WRITTEN', `nothing was written: ${safeMessage(error, scrub)}`);
  }

  try {
    for (const file of sourceFiles) {
      const destination = join(staging, ...file.path.split('/'));
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, readFileSync(join(sourceRoot, ...file.path.split('/'))));
    }
    for (const file of files) {
      const destination = join(staging, ...file.relativePath.split('/'));
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, file.content, file.mode ? { mode: file.mode } : undefined);
    }
  } catch (error) {
    cleanup();
    return refuse('BOOTSTRAP_NOT_WRITTEN', `nothing was written: ${safeMessage(error, scrub)}`);
  }

  // The commit point. `lstat` first is not redundant with the rename: POSIX
  // `rename(2)` refuses a file, a symlink and a non-empty directory but
  // *replaces* an empty one, and the check turns that into a refusal for every
  // target that exists when we look. What is left is a target created in the
  // gap between these two lines, recorded as
  // FINALIZATION_REPLACES_AN_EMPTY_DIRECTORY.
  const existing = lstatSafe(target);
  if (existing && (!existing.isDirectory() || readdirSync(target).length > 0)) {
    cleanup();
    return refuse('TARGET_CLAIMED', 'the target directory was created by something else while this bootstrap was writing, so nothing was committed');
  }
  try {
    // `rmdir`, not `rm`. The target here is known to be an empty directory —
    // `mkdir my-crm && create-accordo my-crm --apply` is an ordinary thing to
    // do — and `rmdirSync` is the call that removes exactly that and refuses
    // anything else. A non-recursive `rmSync` throws EISDIR on a directory,
    // which turned this ordinary invocation into BOOTSTRAP_NOT_WRITTEN.
    if (existing) rmdirSync(target);
    renameSync(staging, target);
  } catch (error) {
    cleanup();
    const claimed = ['ENOTEMPTY', 'EEXIST', 'ENOTDIR', 'EPERM'].includes(/** @type {any} */ (error).code);
    return refuse(
      claimed ? 'TARGET_CLAIMED' : 'BOOTSTRAP_NOT_WRITTEN',
      claimed
        ? 'the target directory was claimed while this bootstrap was writing, so nothing was committed'
        : `nothing was committed: ${safeMessage(error, scrub)}`,
    );
  }

  return {
    ...report,
    mode: 'applied',
    modeReason: '--apply was given, and the project was committed by a single rename',
  };
}
