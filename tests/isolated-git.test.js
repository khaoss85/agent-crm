// @ts-check

/**
 * The git-isolation contract (LEARNINGS S59, backlog:848b76c6).
 *
 * 1. Behaviour: with a polluted `GIT_DIR` in the air — the pre-push-hook
 *    condition that committed fixtures onto the real branch on 2026-10-16 —
 *    the helper still creates and commits the scratch repository, and the
 *    repository `GIT_DIR` points at receives no commit.
 * 2. Guard: no test file outside `tests/helpers/isolated-git.js` spawns git
 *    directly, so a future test cannot reintroduce the unisolated call.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { gitIn, isolatedGitEnv, spawnGit } from './helpers/isolated-git.js';

const testsRoot = fileURLToPath(new URL('.', import.meta.url));

test('a polluted GIT_DIR cannot divert fixture git into another repository', (t) => {
  const parent = mkdtempSync(join(tmpdir(), 'accordo-git-isolation-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));

  // The decoy another repository would be: `GIT_DIR` aimed at it makes every
  // unisolated `git init` / `git commit` write there instead of the fixture.
  const decoy = join(parent, 'decoy.git');
  assert.equal(spawnGit(['init', '--bare', '--quiet', decoy]).status, 0);
  const decoyCommits = () => spawnGit(['rev-list', '--all', '--count'], { cwd: decoy });
  assert.equal(decoyCommits().stdout.trim(), '0');

  const scratch = join(parent, 'scratch');
  const git = gitIn(scratch);
  const gitDir = process.env.GIT_DIR;
  process.env.GIT_DIR = decoy;
  t.after(() => {
    if (gitDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = gitDir;
  });
  try {
    mkdirSync(scratch, { recursive: true });
    assert.equal(git(['init', '--quiet']).status, 0);
    assert.equal(git(['config', 'user.email', 'isolation@example.invalid']).status, 0);
    assert.equal(git(['config', 'user.name', 'isolation']).status, 0);
    assert.equal(git(['config', 'commit.gpgsign', 'false']).status, 0);
    writeFileSync(join(scratch, 'proof.txt'), 'the commit belongs here\n');
    assert.equal(git(['add', '-A']).status, 0);
    assert.equal(git(['commit', '--quiet', '-m', 'isolated fixture']).status, 0);

    // The scratch repository holds the commit …
    assert.match(git(['log', '--format=%s', '-1']).stdout, /isolated fixture/);
    // … and the decoy `GIT_DIR` named received nothing.
    assert.equal(
      decoyCommits().stdout.trim(),
      '0',
      'the decoy repository must stay commit-free while GIT_DIR names it',
    );
  } finally {
    if (gitDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = gitDir;
  }
});

test('isolatedGitEnv drops every GIT_* variable and smuggled extras', () => {
  process.env.ACCORDO_ISOLATION_PROBE = 'kept';
  try {
    const env = isolatedGitEnv({
      ACCORDO_ISOLATION_EXTRA: 'kept',
      GIT_DIR: '/smuggled',
    });
    assert.equal(env.ACCORDO_ISOLATION_PROBE, 'kept');
    assert.equal(env.ACCORDO_ISOLATION_EXTRA, 'kept');
    assert.ok(
      Object.keys(env).every((key) => !key.startsWith('GIT_')),
      'no GIT_* variable may survive, from the process or from extras',
    );
  } finally {
    delete process.env.ACCORDO_ISOLATION_PROBE;
  }
});

// ------------------------------------------------------------------ the guard

/** A direct git spawn: `spawnSync('git', …)`, `execFileSync('git', …)` and kin. */
const DIRECT_GIT = /(?:spawnSync|execFileSync|execSync|spawn|execFile)\(\s*['"`]git['"`]/;

/**
 * Lines that match the pattern above yet spawn no git of their own, each with
 * the reason it is not a hole. A changed line fails the guard on purpose: the
 * exception must be re-justified, never silently widened.
 */
const JUSTIFIED = [
  {
    file: 'measurement-report.test.js',
    line: `['moved HEAD', "execFileSync('git', ['commit', '--allow-empty', '--quiet', '-m', 'tip moved']);"],`,
    reason: 'fixture payload, not a test spawn: it runs inside the fixture during `npm verify`, which the fixture inherits through the isolated child env, so it can only ever touch the fixture',
  },
];

/** @param {string} dir */
function testSources(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...testSources(path));
    else if (/\.m?js$/.test(entry.name)) found.push(path);
  }
  return found.sort();
}

test('no test spawns git except through tests/helpers/isolated-git.js', () => {
  const offenders = [];
  for (const path of testSources(testsRoot)) {
    const name = relative(testsRoot, path);
    // The helper is the sanctioned spawn site; this file only names the
    // pattern in prose, it never spawns git.
    if (name === join('helpers', 'isolated-git.js')) continue;
    if (name === 'isolated-git.test.js') continue;
    const lines = readFileSync(path, 'utf8').split('\n');
    lines.forEach((text, index) => {
      if (!DIRECT_GIT.test(text)) return;
      const justified = JUSTIFIED.some(
        (entry) => entry.file === name && entry.line === text.trim(),
      );
      if (!justified) offenders.push(`${name}:${index + 1}: ${text.trim()}`);
    });
  }
  assert.deepEqual(
    offenders,
    [],
    `direct git spawns outside the isolated helper (route them through tests/helpers/isolated-git.js):\n${offenders.join('\n')}`,
  );
});
