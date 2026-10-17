// @ts-check

/**
 * `apply-ci-measurement.js`: re-anchor `site/claims.json` at the measurement
 * the CI `verify` job produced on the same tree, instead of a local
 * `measure-suite --apply` commit.
 *
 * The record validation is unit-tested against values; the tree binding (HEAD
 * prefix, tests/ fingerprint, dirty-tree and wrong-tree refusals) is driven
 * end to end on throwaway repositories with real git, because a stubbed git
 * there would prove nothing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateArtifactRecord } from '../scripts/apply-ci-measurement.js';
import { gitIn, isolatedGitEnv } from './helpers/isolated-git.js';

const applier = fileURLToPath(new URL('../scripts/apply-ci-measurement.js', import.meta.url));

/** @param {string} prefix */
function scratch(prefix) {
  return mkdtempSync(join(tmpdir(), `accordo-apply-${prefix}-`));
}

/**
 * Git asserting success for fixture setup, isolated from any enclosing
 * repository (LEARNINGS S59: run from a git hook with GIT_DIR set, an
 * unisolated fixture `git commit` writes into the real repository instead of
 * the scratch one — on 2026-10-16 this file committed its fixtures onto the
 * branch being pushed, deleting 1869 files).
 * @param {string} cwd
 */
function setupGit(cwd) {
  const git = gitIn(cwd);
  return (/** @type {string[]} */ args) => {
    const result = git(args);
    assert.equal(result.status, 0, `git ${args.join(' ')} failed in the fixture`);
    return String(result.stdout ?? '').trim();
  };
}

/**
 * A fixture repository: two test files (never executed — the applier runs no
 * suite), a claims ledger naming an older commit, and a clean tree at HEAD.
 */
function fixture() {
  const root = scratch('repo-');
  const run = setupGit(root);
  run(['init', '-q']);
  run(['config', 'user.email', 'apply@example.invalid']);
  run(['config', 'user.name', 'apply']);
  run(['config', 'commit.gpgsign', 'false']);
  mkdirSync(join(root, 'tests'), { recursive: true });
  mkdirSync(join(root, 'site'), { recursive: true });
  writeFileSync(join(root, 'tests', 'a.test.js'), 'placeholder\n');
  writeFileSync(join(root, 'site', 'claims.json'), `${JSON.stringify({
    claims: [],
    measuredAgainst: {
      sha: '0000000', tests: 1, failures: 0, testFiles: 1, testsTree: '0'.repeat(40),
    },
  }, null, 2)}\n`);
  run(['add', '-A']);
  run(['commit', '--quiet', '-m', 'old measurement']);
  const oldTree = run(['rev-parse', 'HEAD:tests']);
  writeFileSync(join(root, 'tests', 'b.test.js'), 'placeholder\n');
  run(['add', '-A']);
  run(['commit', '--quiet', '-m', 'tests moved']);
  const head = run(['rev-parse', 'HEAD']);
  const headTree = run(['rev-parse', 'HEAD:tests']);
  assert.notEqual(headTree, oldTree, 'the fixture must move tests/ between commits');
  return { root, head, headTree };
}

const record = (/** @type {any} */ overrides) => ({
  sha: 'abc1234', tests: 42, failures: 0, testFiles: 3, testsTree: '1'.repeat(40), ...overrides,
});

/** Run the CLI in a fixture root. The artifact lives outside the repo: an
 * untracked file inside it would dirty the tree the script guards. */
const artifactDir = (/** @type {any} */ t) => {
  const dir = scratch('artifact-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/** @param {string} dir @param {any} body */
const writeArtifact = (dir, body) => {
  const artifact = join(dir, 'measurement.json');
  writeFileSync(artifact, typeof body === 'string' ? body : JSON.stringify(body));
  return artifact;
};

const apply = (/** @type {string} */ root, /** @type {string} */ artifact) => spawnSync(
  process.execPath, [applier, artifact], { cwd: root, encoding: 'utf8', env: isolatedGitEnv() },
);

// ---------------------------------------------------------------- validator units

test('a sound record validates', () => {
  assert.equal(validateArtifactRecord(record({})), null);
  assert.equal(validateArtifactRecord(record({ files: { 'tests/a.test.js': { tests: 42 } } })), null);
});

test('a record from a red run is refused', () => {
  assert.match(String(validateArtifactRecord(record({ failures: 1 }))), /green run/);
});

test('a record with no countable run is refused', () => {
  assert.ok(validateArtifactRecord(record({ tests: 0 })));
  assert.ok(validateArtifactRecord(record({ sha: 'not-a-sha' })));
  assert.ok(validateArtifactRecord(record({ testsTree: 'short' })));
  assert.ok(validateArtifactRecord(record({ files: [] })));
  assert.ok(validateArtifactRecord(null));
  assert.ok(validateArtifactRecord('measured'));
});

// ---------------------------------------------------------------- CLI on fixtures

test('a record measured at HEAD re-anchors the ledger and keeps its other fields', (t) => {
  const { root, head, headTree } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const artifact = writeArtifact(artifactDir(t), {
    measuredAgainst: {
      date: '2026-10-16',
      sha: head.slice(0, 7),
      command: 'npm run verify',
      tests: 2,
      failures: 0,
      testFiles: 2,
      testsTree: headTree,
      files: { 'tests/a.test.js': { tests: 1 }, 'tests/b.test.js': { tests: 1 } },
    },
  });
  const run = apply(root, artifact);
  assert.equal(run.status, 0, `expected exit 0, stderr: ${run.stderr}`);
  const ledger = JSON.parse(readFileSync(join(root, 'site', 'claims.json'), 'utf8'));
  assert.deepEqual(ledger.claims, [], 'fields outside measuredAgainst are preserved');
  assert.equal(ledger.measuredAgainst.sha, head.slice(0, 7));
  assert.equal(ledger.measuredAgainst.testsTree, headTree);
  assert.match(String(run.stdout), /re-anchored/);
});

test('a record from another commit leaves the ledger untouched', (t) => {
  const { root } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const before = readFileSync(join(root, 'site', 'claims.json'), 'utf8');
  const artifact = writeArtifact(artifactDir(t), {
    measuredAgainst: record({ sha: 'deadbee', testsTree: '2'.repeat(40) }),
  });
  const run = apply(root, artifact);
  assert.notEqual(run.status, 0, 'a foreign record must refuse');
  assert.match(String(run.stderr), /only ever describes the tree it was taken over/);
  assert.equal(readFileSync(join(root, 'site', 'claims.json'), 'utf8'), before);
});

test('a record whose corpus moved under it is refused', (t) => {
  const { root, head } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const before = readFileSync(join(root, 'site', 'claims.json'), 'utf8');
  const artifact = writeArtifact(artifactDir(t), {
    measuredAgainst: record({ sha: head.slice(0, 7), testsTree: '3'.repeat(40) }),
  });
  const run = apply(root, artifact);
  assert.notEqual(run.status, 0, 'a moved corpus must refuse');
  assert.match(String(run.stderr), /moved under the measurement/);
  assert.equal(readFileSync(join(root, 'site', 'claims.json'), 'utf8'), before);
});

test('a dirty tree refuses, even for the right record', (t) => {
  const { root, head, headTree } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'tests', 'uncommitted.test.js'), 'placeholder\n');
  const artifact = writeArtifact(artifactDir(t), {
    measuredAgainst: record({ sha: head.slice(0, 7), testsTree: headTree }),
  });
  const run = apply(root, artifact);
  assert.notEqual(run.status, 0, 'a dirty tree must refuse');
  assert.match(String(run.stderr), /dirty/);
});

test('an unreadable artifact refuses without touching the ledger', (t) => {
  const { root } = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const before = readFileSync(join(root, 'site', 'claims.json'), 'utf8');
  const dir = artifactDir(t);
  const runMissing = apply(root, join(dir, 'missing.json'));
  assert.equal(runMissing.status, 2, `a missing artifact must exit 2, got ${runMissing.status}: ${runMissing.stderr}`);
  for (const body of ['{nope', '{}']) {
    const run = apply(root, writeArtifact(dir, body));
    assert.equal(run.status, 2, `unusable input must exit 2, got ${run.status}: ${run.stderr}`);
  }
  assert.equal(readFileSync(join(root, 'site', 'claims.json'), 'utf8'), before);
});
