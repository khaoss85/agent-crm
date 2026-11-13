// @ts-check

/**
 * The cached twin of tests/helpers/contracts-project.js (backlog:3d560518f3e2).
 *
 * Same exports — everything is re-exported from the original helper — except
 * `project()`, which builds each option set ONCE and hands every test a fresh
 * private copy of that build. A test file switches by changing only its import
 * path. The original helper stays untouched: any edit to it selects all of its
 * ~41 importers in the PR gate's touched tests, more than one fast run can
 * hold (agent-crm#731), so the importers move here in small batches instead.
 *
 * Two cache levels: per process (a Map) and across the test processes of one
 * CI job (a template published under RUNNER_TEMP, keyed by HEAD sha + option
 * key). The cross-process level is the lane's work from agent-crm#731
 * (e3388c5f, "template condiviso tra processi via RUNNER_TEMP"), moved here
 * unchanged in behaviour.
 */

import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { project as buildFreshProject } from './contracts-project.js';
import { spawnGit } from './isolated-git.js';

export * from './contracts-project.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

/**
 * @param {import('node:test').TestContext | { after(fn: () => void): void }} t
 * @param {object} [options] the same options as the original `project()`.
 * @returns {string} a throwaway project root private to this test.
 */
export function project(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'accordo-contracts-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(projectTemplate(options), root, { recursive: true });
  return root;
}

/**
 * Built projects, one per option set: the per-process level of the cache
 * (backlog:3d560518f3e2). Building one runs the real CLI once per record
 * manifest — 26 to 50 `accordo module create` processes, 15-70 s each build on
 * the loaded CI server — and a file of six to fifteen tests rebuilt the same
 * project for every test: tests/contracts-review.test.js (6) and
 * tests/work-operations-e2e.test.js (15) alone held a measure piece for over
 * ten minutes. The build is deterministic over an unchanged checkout and
 * embeds no absolute path, so each test gets a fresh private copy of the one
 * build: the same files, still a throwaway root per test, still built by the
 * real CLI and module factory. The cross-process level (`sharedTemplate`
 * below) publishes the one build where sibling test processes can copy it;
 * this map keeps the per-process fast path and the fallback when sharing is
 * off or fails.
 * @type {Map<string, string>}
 */
const templates = new Map();
/** @type {string | undefined} */
let templateParent;
let uncachedBuilds = 0;

/**
 * How long a process waits for another process's build before building alone
 * in its own scratch space (see `sharedTemplate`). A finished build takes
 * 15-70 s on the loaded CI server; anything past this is a dead builder, and
 * the waiter falls back to the per-process build rather than wedging the file.
 */
const SHARE_WAIT_MS = 300_000;
/** A build lock older than this outlived any real build: take it over. */
const SHARE_LOCK_STALE_MS = 120_000;

/**
 * Whether this checkout may publish and reuse shared templates, resolved once
 * per process: the job-scoped scratch directory plus the HEAD sha, or null
 * when sharing is off (no `RUNNER_TEMP`), unavailable (no git) or unsafe (a
 * checkout whose copied paths differ from HEAD — every such process builds
 * alone, exactly as before). `undefined` is "not probed yet".
 * @type {{ base: string, sha: string } | null | undefined}
 */
let sharingScopeMemo;

/**
 * A stable cache key: keys sorted at every depth, so `{ a, b }` and `{ b, a }`
 * (and nested `priceRules` written in another order) name the same build.
 * @param {unknown} value
 * @returns {string}
 */
export function stableKey(value) {
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .filter((key) => /** @type {Record<string, unknown>} */ (value)[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableKey(/** @type {Record<string, unknown>} */ (value)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

/**
 * An option set is cacheable — per process and across processes — only when
 * `stableKey` names its build exactly, i.e. it is plain JSON-like data:
 * strings, finite numbers, booleans, null/undefined, arrays and plain
 * objects. Anything else stringifies lossily (two functions, two Maps, two
 * Dates or two class instances can share one key, a BigInt throws), so such
 * an option set is never cached: every call builds fresh, exactly like the
 * original helper. Pure: unit-tested.
 * @param {unknown} options
 * @returns {boolean}
 */
export function optionsShareable(options) {
  const seen = new Set();
  /** @param {unknown} value @returns {boolean} */
  const walk = (value) => {
    if (value === null || value === undefined) return true;
    const kind = typeof value;
    if (kind === 'string' || kind === 'boolean') return true;
    if (kind === 'number') return Number.isFinite(value);
    if (kind !== 'object') return false; // function, symbol, bigint
    if (seen.has(value)) return false; // a cycle has no finite key
    seen.add(value);
    if (Array.isArray(value)) return value.every(walk);
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return false;
    if (Object.getOwnPropertySymbols(value).length > 0) return false;
    return Object.values(/** @type {object} */ (value)).every(walk);
  };
  return walk(options ?? {});
}

/**
 * The shared directory name for one HEAD plus one option key. Pure:
 * unit-tested.
 * @param {string} headSha
 * @param {string} optionsKey
 * @returns {string}
 */
export function templateDirName(headSha, optionsKey) {
  const digest = createHash('sha1').update(optionsKey).digest('hex').slice(0, 16);
  return `accordo-contracts-tpl-${headSha.slice(0, 12)}-${digest}`;
}

/**
 * @param {string} path
 * @returns {boolean}
 */
function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The job-scoped share for this checkout, or null. `RUNNER_TEMP` is the
 * scratch directory the CI job's parallel parts share (the runner wipes it
 * with the job, so entries never go stale); the HEAD sha keys the build, and
 * any difference from HEAD over exactly the paths the original build copies
 * disables sharing for the whole process.
 * @returns {{ base: string, sha: string } | null}
 */
function sharingScope() {
  if (sharingScopeMemo !== undefined) return sharingScopeMemo;
  sharingScopeMemo = null;
  try {
    const base = process.env.RUNNER_TEMP;
    if (!base || !isDirectory(base)) return sharingScopeMemo;
    const head = spawnGit(['rev-parse', 'HEAD'], { cwd: repoRoot });
    if (head.status !== 0) return sharingScopeMemo;
    const sha = head.stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(sha)) return sharingScopeMemo;
    const status = spawnGit(['status', '--porcelain', '--', 'packages', 'apps', 'examples', 'package.json'],
      { cwd: repoRoot },
    );
    if (status.status !== 0 || status.stdout.trim() !== '') return sharingScopeMemo;
    sharingScopeMemo = { base, sha };
  } catch {
    sharingScopeMemo = null;
  }
  return sharingScopeMemo;
}

/**
 * Take over a build lock its holder outlived. Safe even when the holder is
 * in fact still alive: builds never write into the shared directory, they
 * publish with one same-directory rename (`publishBuild`), so two builders
 * can only race to that rename, and the loser keeps the winner's build.
 * @param {string} lock
 * @returns {boolean} true when this process now holds the lock.
 */
function takeOverStaleLock(lock) {
  try {
    if (Date.now() - statSync(lock).mtimeMs <= SHARE_LOCK_STALE_MS) return false;
    rmSync(lock, { recursive: true, force: true });
    mkdirSync(lock);
    return true;
  } catch {
    return false;
  }
}

/**
 * One build per key across test processes (backlog:3d560518f3e2). The first
 * process builds and publishes under the job scratch dir keyed by HEAD sha
 * plus the option key; the others copy from it. The template directory only
 * ever appears whole, by an atomic rename inside its own parent directory,
 * so "the directory exists" means "a complete build". The lock only saves
 * duplicate work. The `.ready` sidecar records sha and key for the log.
 * Fail-open throughout — null on any doubt — so the caller falls back to a
 * per-process build.
 * @param {object} options
 * @param {string} key
 * @returns {string | null} the shared template directory, or null.
 */
function sharedTemplate(options, key) {
  const scope = sharingScope();
  if (!scope || !optionsShareable(options)) return null;
  const dir = join(scope.base, templateDirName(scope.sha, key));
  const lock = `${dir}.lock`;
  if (!isDirectory(dir)) {
    let mine = false;
    try {
      mkdirSync(lock);
      mine = true;
    } catch {
      mine = takeOverStaleLock(lock);
    }
    if (mine) {
      try {
        if (!isDirectory(dir)) publishBuild(scope.base, dir, options);
        const ready = `${dir}.ready`;
        if (isDirectory(dir) && !existsSync(ready)) {
          const pending = `${ready}.${process.pid}`;
          writeFileSync(pending, JSON.stringify({ sha: scope.sha, key, builtAt: new Date().toISOString() }));
          renameSync(pending, ready);
        }
      } catch {
        // Fail open: the caller builds per process.
      } finally {
        rmSync(lock, { recursive: true, force: true });
      }
    } else {
      const deadline = Date.now() + SHARE_WAIT_MS;
      while (Date.now() < deadline && !isDirectory(dir)) {
        // The holder removes the lock however it ends: lock gone without a
        // published build is a failed or reaped build, so fall back at once.
        if (!existsSync(lock)) break;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
      }
    }
  }
  return isDirectory(dir) ? dir : null;
}

/**
 * One build per key. `publishBuild` is synchronous (spawnSync all the way
 * down), so two builds can never interleave inside one process: the first
 * call fills the map before any other call can run, and every later call for
 * the same key copies that one build. Across processes the shared template
 * above serves the same key; a process that cannot share builds into its own
 * mkdtemp parent, so processes never share a directory except through a
 * complete, published build.
 * @param {object} options
 */
function projectTemplate(options) {
  if (templateParent === undefined) {
    templateParent = mkdtempSync(join(tmpdir(), 'accordo-contracts-templates-'));
    const parent = templateParent;
    process.once('exit', () => rmSync(parent, { recursive: true, force: true }));
  }
  if (!optionsShareable(options)) {
    // No exact key: never cached, built fresh for this call.
    const root = join(templateParent, `uncached-${uncachedBuilds += 1}`);
    publishBuild(templateParent, root, options);
    return root;
  }
  const key = stableKey(options ?? {});
  const cached = templates.get(key);
  if (cached && existsSync(cached)) return cached;
  const shared = sharedTemplate(options, key);
  if (shared) {
    templates.set(key, shared);
    return shared;
  }
  const root = join(templateParent, `cached-${templates.size}`);
  rmSync(root, { recursive: true, force: true });
  publishBuild(templateParent, root, options);
  templates.set(key, root);
  return root;
}

/**
 * Build one project with the ORIGINAL helper's `project()` — the real CLI and
 * module factory, byte for byte the build every uncached test gets — and
 * publish it at `dir` with ONE atomic rename. The build is first staged in a
 * private directory under `parent` (the parent of `dir`, so the final rename
 * never crosses filesystems); only staging may copy across filesystems.
 * Returns true when this call published `dir`; false when another builder
 * published it first (this build is discarded, theirs is used).
 * @param {string} parent the directory `dir` lives in
 * @param {string} dir an absent directory the project ends up in
 * @param {object} options
 * @returns {boolean}
 */
export function publishBuild(parent, dir, options, build = buildFreshProject) {
  /** @type {Array<() => void>} */
  const cleanups = [];
  const staging = mkdtempSync(join(parent, '.accordo-contracts-staging-'));
  try {
    const built = build({ after: (fn) => { cleanups.push(fn); } }, options);
    const staged = join(staging, 'project');
    try {
      renameSync(built, staged);
    } catch {
      // Another filesystem (tmpdir vs RUNNER_TEMP): copy into the private
      // staging dir; nobody reads it until the rename below.
      cpSync(built, staged, { recursive: true });
    }
    try {
      renameSync(staged, dir);
      return true;
    } catch (error) {
      const code = /** @type {NodeJS.ErrnoException} */ (error).code;
      if ((code === 'EEXIST' || code === 'ENOTEMPTY') && isDirectory(dir)) return false;
      throw error;
    }
  } finally {
    for (const cleanup of cleanups) cleanup();
    rmSync(staging, { recursive: true, force: true });
  }
}
