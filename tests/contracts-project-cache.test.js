// @ts-check

/**
 * The contracts-project template cache (backlog:3d560518f3e2): one build per
 * option set per process, whatever order the options were written in — and one
 * build per option set across processes under a job-scoped scratch dir, so the
 * 41 files importing the helper stop paying the 15-70 s build each
 * (agent-crm#731: the fast gate's 4 x 420 s budget could not hold ~2 250
 * part-seconds of builds alone).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stableKey, optionsShareable, templateDirName, publishBuild } from './helpers/contracts-project-cache.js';
import * as cached from './helpers/contracts-project-cache.js';
import * as original from './helpers/contracts-project.js';
import { createHash } from 'node:crypto';
import { spawnGit } from './helpers/isolated-git.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
/**
 * Sharing engages only when the checkout matches HEAD over exactly the paths
 * the build copies (see `sharingScope` in the helper): with unrelated work in
 * progress the children below would correctly fall back to per-process builds,
 * so the sharing proof runs only where it can engage.
 */
function sharingEngages() {
  try {
    const head = spawnGit(['rev-parse', 'HEAD'], { cwd: repoRoot });
    if (head.status !== 0 || !/^[0-9a-f]{40}$/.test(head.stdout.trim())) return false;
    const status = spawnGit(['status', '--porcelain', '--', 'packages', 'apps', 'examples', 'package.json'],
      { cwd: repoRoot },
    );
    return status.status === 0 && status.stdout.trim() === '';
  } catch {
    return false;
  }
}

test('the project cache key is stable at every depth and tells real differences apart', () => {
  assert.equal(
    stableKey({ withWork: true, priceRules: { b: 2, a: { y: 1, x: 0 } } }),
    stableKey({ priceRules: { a: { x: 0, y: 1 }, b: 2 }, withWork: true }),
  );
  assert.equal(stableKey({ withDomain: undefined }), stableKey({}));
  assert.notEqual(stableKey({ withWork: true }), stableKey({ withWork: false }));
  assert.notEqual(stableKey({ priceRules: { a: 1 } }), stableKey({ priceRules: { a: 2 } }));
  assert.notEqual(stableKey({ priceRules: [1, 2] }), stableKey({ priceRules: [2, 1] }));
});

test('the shared directory name is stable per head plus key and filesystem-safe', () => {
  const sha = 'd023b3aa11eaa9f1d3340eb949c07b8e9f0734ef';
  const a = templateDirName(sha, stableKey({ withWork: true, priceRules: { b: 2, a: 1 } }));
  const b = templateDirName(sha, stableKey({ priceRules: { a: 1, b: 2 }, withWork: true }));
  assert.equal(a, b);
  assert.match(a, /^accordo-contracts-tpl-[0-9a-f]{12}-[0-9a-f]{16}$/);
  assert.notEqual(a, templateDirName(sha, stableKey({ withWork: false })));
  assert.notEqual(a, templateDirName(`${'0'.repeat(40)}`, stableKey({ withWork: true })));
});

test('an option set holding a function is not shareable', () => {
  assert.equal(optionsShareable({}), true);
  assert.equal(optionsShareable({ withWork: true, priceRules: { a: [1, null] } }), true);
  assert.equal(optionsShareable(undefined), true);
  assert.equal(optionsShareable({ clock: () => 0 }), false);
  assert.equal(optionsShareable({ priceRules: { nested: { fn: () => 0 } } }), false);
});

test('only plain JSON-like option sets are cacheable: anything stableKey would blur builds fresh', () => {
  // Each of these stringifies lossily, so two different values would share
  // one cache key (or throw): never cached, never shared.
  class Rules { constructor() { this.a = 1; } }
  const cyclic = { a: 1 };
  /** @type {any} */ (cyclic).self = cyclic;
  for (const [label, options] of /** @type {Array<[string, unknown]>} */ ([
    ['Map', { priceRules: new Map([['a', 1]]) }],
    ['Set', { priceRules: new Set([1]) }],
    ['Date', { asOf: new Date(0) }],
    ['class instance', { priceRules: new Rules() }],
    ['BigInt', { limit: 1n }],
    ['Symbol', { tag: Symbol('x') }],
    ['NaN', { ratio: Number.NaN }],
    ['Infinity', { ratio: Number.POSITIVE_INFINITY }],
    ['symbol key', { [Symbol('k')]: 1 }],
    ['cycle', cyclic],
  ])) {
    assert.equal(optionsShareable(options), false, label);
  }
  assert.equal(optionsShareable({ withWork: true, priceRules: { rules: [{ pct: 5, sku: 'A' }] }, n: null }), true);
  assert.equal(optionsShareable(Object.assign(Object.create(null), { withWork: true })), true);
});

/** A fake build: a throwaway dir in the OS temp dir holding one file. */
function fakeBuild(/** @type {string} */ content) {
  return (/** @type {{ after(fn: () => void): void }} */ t) => {
    const root = mkdtempSync(join(tmpdir(), 'accordo-fake-build-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    writeFileSync(join(root, 'marker.txt'), content);
    return root;
  };
}

test('a build is published whole by one rename inside the target directory, never half-copied', () => {
  const parent = mkdtempSync(join(tmpdir(), 'accordo-publish-'));
  try {
    const dir = join(parent, 'template');
    assert.equal(publishBuild(parent, dir, {}, fakeBuild('first')), true);
    assert.equal(readFileSync(join(dir, 'marker.txt'), 'utf8'), 'first');
    assert.deepEqual(readdirSync(parent), ['template'], 'no staging directory is left behind');
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('two builders racing for one key: the loser discards its build and the winner\'s stays intact', () => {
  // What a stale-lock takeover can produce when the first holder is still
  // alive: two complete builds. Publication is one rename, so the second
  // cannot overwrite or mix into the first.
  const parent = mkdtempSync(join(tmpdir(), 'accordo-publish-'));
  try {
    const dir = join(parent, 'template');
    assert.equal(publishBuild(parent, dir, {}, fakeBuild('winner')), true);
    assert.equal(publishBuild(parent, dir, {}, fakeBuild('loser')), false);
    assert.equal(readFileSync(join(dir, 'marker.txt'), 'utf8'), 'winner');
    assert.deepEqual(readdirSync(dir), ['marker.txt']);
    assert.deepEqual(readdirSync(parent), ['template']);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

/** @param {string} root @returns {Record<string, string>} path → sha256 */
function tree(root) {
  /** @type {Record<string, string>} */
  const files = {};
  const walk = (/** @type {string} */ dir, /** @type {string} */ rel) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const relPath = rel ? `${rel}/${name}` : name;
      if (statSync(path).isDirectory()) walk(path, relPath);
      else files[relPath] = createHash('sha256').update(readFileSync(path)).digest('hex');
    }
  };
  walk(root, '');
  return files;
}

test(
  'two processes share one template build, file for file the original build, each test a private copy',
  { skip: sharingEngages() ? false : 'checkout differs from HEAD: sharing is off by design here' },
  () => {
  const scratch = mkdtempSync(join(tmpdir(), 'accordo-runner-temp-'));
  /** @type {Array<() => void>} */
  const cleanups = [];
  /** @type {string[]} */
  const roots = [];
  const childPath = join(scratch, 'child.mjs');
  const helper = new URL('./helpers/contracts-project-cache.js', import.meta.url).href;
  writeFileSync(childPath, [
    `import { readdirSync } from 'node:fs';`,
    `import { project } from ${JSON.stringify(helper)};`,
    `const scratch = ${JSON.stringify(scratch)};`,
    `const root = project({ after() {} }, {});`,
    `const shared = readdirSync(scratch).filter((d) => /^accordo-contracts-tpl-[0-9a-f]{12}-[0-9a-f]{16}$/.test(d)).sort();`,
    `console.log(JSON.stringify({ root, shared }));`,
  ].join('\n'));
  /** @param {string} name */
  const runChild = (name) => {
    const start = Date.now();
    const child = spawnSync(process.execPath, ['--no-warnings', childPath], {
      encoding: 'utf8',
      env: { ...process.env, RUNNER_TEMP: scratch },
      timeout: 420_000,
    });
    assert.equal(child.status, 0, `${name} failed: ${child.stderr.slice(-2000)}`);
    const out = JSON.parse(child.stdout.trim());
    roots.push(out.root);
    return { ...out, elapsedMs: Date.now() - start };
  };
  try {
    const first = runChild('first');
    assert.equal(first.shared.length, 1);
    const marker = join(scratch, `${first.shared[0]}.ready`);
    const builtAt = statSync(marker).mtimeMs;
    assert.ok(JSON.parse(readFileSync(marker, 'utf8')).sha, 'the ready sidecar names the head sha');
    const second = runChild('second');
    assert.deepEqual(second.shared, first.shared);
    assert.equal(statSync(marker).mtimeMs, builtAt);
    assert.notEqual(second.root, first.root);
    // One uncached build to compare against: the shared build is file for
    // file what the original helper builds, and each copy is private.
    const fresh = original.project({ after: (fn) => { cleanups.push(fn); } }, {});
    const expected = tree(fresh);
    assert.deepEqual(tree(first.root), expected);
    assert.deepEqual(tree(second.root), expected);
    writeFileSync(join(first.root, 'package.json'), '{}\n');
    assert.deepEqual(tree(second.root), expected, 'a test writing into its copy touches no other copy');
  } finally {
    for (const cleanup of cleanups) cleanup();
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('the cached helper re-exports every export of the original helper', () => {
  for (const name of Object.keys(original)) {
    assert.ok(name in cached, `contracts-project-cache.js is missing ${name}`);
    if (name !== 'project') assert.equal(cached[name], original[name], `${name} is the original's`);
  }
  assert.notEqual(cached.project, original.project);
});
