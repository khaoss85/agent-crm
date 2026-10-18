// @ts-check

/**
 * The git-isolation contract (LEARNINGS S59, backlog:848b76c6).
 *
 * 1. Behaviour: with a polluted `GIT_DIR` in the air — the pre-push-hook
 *    condition that committed fixtures onto the real branch on 2026-10-16 —
 *    the helper still creates and commits the scratch repository, and the
 *    repository `GIT_DIR` points at receives no commit.
 * 2. Scripts: the scripts the tests drive (`scripts/measurement.js`,
 *    `scripts/apply-ci-measurement.js` and every other script spawning git)
 *    run under the same hooks, so they scrub `GIT_*` too: a polluted
 *    `GIT_DIR` diverts neither their reads nor their writes.
 * 3. Guard: no test file outside `tests/helpers/isolated-git.js` — and no
 *    script outside `scripts/git-env.js` — spawns git directly, so a future
 *    test or script cannot reintroduce the unisolated call.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { gitIn, isolatedGitEnv, spawnGit } from './helpers/isolated-git.js';
import { gitIn as scriptGitIn } from '../scripts/measurement.js';

const testsRoot = fileURLToPath(new URL('.', import.meta.url));
const scriptsRoot = fileURLToPath(new URL('../scripts/', import.meta.url));
const applier = fileURLToPath(new URL('../scripts/apply-ci-measurement.js', import.meta.url));

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

test('script git stays in its own directory under a polluted GIT_DIR', (t) => {
  const parent = mkdtempSync(join(tmpdir(), 'accordo-script-git-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));

  const decoy = join(parent, 'decoy.git');
  assert.equal(spawnGit(['init', '--bare', '--quiet', decoy]).status, 0);
  const decoyCommits = () => spawnGit(['rev-list', '--all', '--count'], { cwd: decoy });
  assert.equal(decoyCommits().stdout.trim(), '0');

  const scratch = join(parent, 'scratch');
  mkdirSync(scratch, { recursive: true });
  const git = scriptGitIn(scratch);
  const gitDir = process.env.GIT_DIR;
  process.env.GIT_DIR = decoy;
  t.after(() => {
    if (gitDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = gitDir;
  });
  try {
    assert.equal(git(['init', '--quiet']).status, 0);
    assert.equal(git(['config', 'user.email', 'script@example.invalid']).status, 0);
    assert.equal(git(['config', 'user.name', 'script']).status, 0);
    assert.equal(git(['config', 'commit.gpgsign', 'false']).status, 0);
    writeFileSync(join(scratch, 'proof.txt'), 'the script commit belongs here\n');
    assert.equal(git(['add', '-A']).status, 0);
    assert.equal(git(['commit', '--quiet', '-m', 'script fixture']).status, 0);

    assert.match(git(['log', '--format=%s', '-1']).stdout, /script fixture/);
    assert.equal(
      decoyCommits().stdout.trim(),
      '0',
      'a script must not commit into the repository a polluted GIT_DIR names',
    );
  } finally {
    if (gitDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = gitDir;
  }
});

test('the apply-ci-measurement CLI binds the fixture tree under a polluted GIT_DIR', (t) => {
  const parent = mkdtempSync(join(tmpdir(), 'accordo-applier-git-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));

  const decoy = join(parent, 'decoy.git');
  assert.equal(spawnGit(['init', '--bare', '--quiet', decoy]).status, 0);

  const root = join(parent, 'repo');
  const run = gitIn(root);
  const setup = (/** @type {string[]} */ args) => {
    const result = run(args);
    assert.equal(result.status, 0, `git ${args.join(' ')} failed in the fixture`);
    return result.stdout;
  };
  mkdirSync(join(root, 'tests'), { recursive: true });
  mkdirSync(join(root, 'site'), { recursive: true });
  setup(['init', '-q']);
  setup(['config', 'user.email', 'applier@example.invalid']);
  setup(['config', 'user.name', 'applier']);
  setup(['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(root, 'tests', 'a.test.js'), 'placeholder\n');
  writeFileSync(join(root, 'site', 'claims.json'), `${JSON.stringify({ claims: [] })}\n`);
  setup(['add', '-A']);
  setup(['commit', '--quiet', '-m', 'fixture']);
  const head = setup(['rev-parse', 'HEAD']);
  const headTree = setup(['rev-parse', 'HEAD:tests']);

  const artifact = join(parent, 'measurement.json');
  writeFileSync(artifact, JSON.stringify({
    measuredAgainst: {
      date: '2026-10-18',
      sha: head.slice(0, 7),
      command: 'npm run verify',
      tests: 1,
      failures: 0,
      testFiles: 1,
      testsTree: headTree,
      files: { 'tests/a.test.js': { tests: 1 } },
    },
  }));

  // The hook condition: GIT_DIR names another repository, and the CLI gets
  // the polluted environment as-is — no scrubbing by the caller.
  const polluted = { ...process.env, GIT_DIR: decoy };
  const applied = spawnSync(process.execPath, [applier, artifact], {
    cwd: root,
    encoding: 'utf8',
    env: polluted,
  });
  assert.equal(applied.status, 0, `expected exit 0, stderr: ${applied.stderr}`);
  const ledger = JSON.parse(readFileSync(join(root, 'site', 'claims.json'), 'utf8'));
  assert.equal(ledger.measuredAgainst.sha, head.slice(0, 7));
  assert.equal(ledger.measuredAgainst.testsTree, headTree);
  assert.equal(
    spawnGit(['rev-list', '--all', '--count'], { cwd: decoy }).stdout.trim(),
    '0',
    'the applier must not touch the repository a polluted GIT_DIR names',
  );
});

// ------------------------------------------------------------------ the guard

/**
 * A direct git spawn: `spawnSync('git', …)`, `execFileSync('git', …)` and kin.
 * Matched against whole file contents (never line by line), so splitting the
 * call across lines does not evade it; the trailing `['"`\s]` also catches
 * the shell-string form (`execSync('git status')`), not just the argv form.
 */
const DIRECT_GIT = /(?:spawnSync|execFileSync|execSync|spawn|execFile)\(\s*['"`]git(?:['"`\s])/g;

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

/**
 * Every direct git spawn in one source root, each with its line number and
 * line text. The whole file content is matched (never line by line), so a
 * call split across lines is still caught.
 * @param {string} rootDir
 * @param {string} label
 * @param {Set<string>} sanctioned files that may spawn git, relative to the root
 * @param {{ file: string, line: string }[]} justified
 */
function directGitOffenders(rootDir, label, sanctioned, justified) {
  const offenders = [];
  for (const path of testSources(rootDir)) {
    const name = relative(rootDir, path);
    if (sanctioned.has(name)) continue;
    const content = readFileSync(path, 'utf8');
    DIRECT_GIT.lastIndex = 0;
    let match;
    while ((match = DIRECT_GIT.exec(content)) !== null) {
      const line = content.slice(0, match.index).split('\n').length;
      const lineStart = content.lastIndexOf('\n', match.index) + 1;
      let lineEnd = content.indexOf('\n', match.index);
      if (lineEnd === -1) lineEnd = content.length;
      const text = content.slice(lineStart, lineEnd).trim();
      const ok = justified.some((entry) => entry.file === name && entry.line === text);
      if (!ok) offenders.push(`${label}/${name}:${line}: ${text.slice(0, 140)}`);
    }
  }
  return offenders;
}

test('no test spawns git except through tests/helpers/isolated-git.js', () => {
  const offenders = directGitOffenders(
    testsRoot,
    'tests',
    // The helper is the sanctioned spawn site; this file only names the
    // pattern in prose, it never spawns git.
    new Set([join('helpers', 'isolated-git.js'), 'isolated-git.test.js']),
    JUSTIFIED,
  );
  assert.deepEqual(
    offenders,
    [],
    `direct git spawns outside the isolated helper (route them through tests/helpers/isolated-git.js):\n${offenders.join('\n')}`,
  );
});

test('no script spawns git except through scripts/git-env.js', () => {
  const offenders = directGitOffenders(scriptsRoot, 'scripts', new Set(['git-env.js']), []);
  assert.deepEqual(
    offenders,
    [],
    `direct git spawns outside the isolated module (route them through scripts/git-env.js):\n${offenders.join('\n')}`,
  );
});
