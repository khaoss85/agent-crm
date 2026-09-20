// @ts-check

/**
 * `measure-suite --refresh`: re-anchor a measurement at HEAD by running only
 * the test files the recorded tree and HEAD disagree on.
 *
 * The re-measure race of backlog:79405f9df589 is a 45-minute window (full
 * `npm run verify` plus its verification) during which any tests/ merge
 * makes the fresh measurement stale on arrival. The refresh shrinks the
 * window to the changed files: a reword that changes no count re-anchors in
 * about a minute, and a tip that keeps moving is chased, not guessed.
 *
 * `planRefresh` and the TAP counting are unit-tested against stubs and tiny
 * files; the CLI contract (exit codes, what gets written, what refuses) is
 * driven end to end on throwaway repositories with real `node --test` runs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { enumerateTestFiles, planRefresh, runTestFile } from '../scripts/measure-suite.js';
import { gitIn } from '../scripts/measurement.js';

const measureSuite = fileURLToPath(new URL('../scripts/measure-suite.js', import.meta.url));

/** @param {string} prefix */
function scratch(prefix) {
  return mkdtempSync(join(tmpdir(), `accordo-${prefix}-`));
}

/**
 * Git with background maintenance off, asserting success for fixture setup.
 * @param {string} cwd
 */
function setupGit(cwd) {
  const git = gitIn(cwd);
  return (/** @type {string[]} */ args) => {
    const result = git(args);
    assert.equal(result.status, 0, `git ${args.join(' ')} failed in the fixture`);
    return result.stdout;
  };
}

const commitAll = (run, message) => {
  run(['add', '-A']);
  run(['-c', 'user.email=refresh@example.invalid', '-c', 'user.name=refresh', 'commit', '--quiet', '-m', message]);
  return run(['rev-parse', 'HEAD']);
};

const TEST_FILE = (name, count) => {
  const bodies = [];
  for (let index = 0; index < count; index += 1) {
    bodies.push(`test('${name} ${index}', () => { assert.equal(${index} + 1, ${index + 1}); });\n`);
  }
  return `import test from 'node:test';\nimport assert from 'node:assert/strict';\n${bodies.join('')}`;
};

// ---------------------------------------------------------------- counting units

test('runTestFile counts one file without running the suite', (t) => {
  const root = scratch('refresh-count-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'solo.test.js'), TEST_FILE('solo', 3));
  assert.equal(runTestFile(root, 'solo.test.js'), 3);
});

test('enumerateTestFiles maps a directory, sorted by path', (t) => {
  const root = scratch('refresh-enum-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'b.test.js'), TEST_FILE('b', 1));
  writeFileSync(join(root, 'a.test.js'), TEST_FILE('a', 2));
  assert.deepEqual(enumerateTestFiles(root, ['b.test.js', 'a.test.js']), {
    'a.test.js': { tests: 2 },
    'b.test.js': { tests: 1 },
  });
});

// ---------------------------------------------------------------- plan units

/** A git stub answering name-status with one canned diff. */
const stubGit = (nameStatus) => (/** @type {string[]} */ args) => {
  assert.equal(args[0], 'diff');
  return { status: 0, stdout: nameStatus };
};

const MAP = { 'tests/a.test.js': { tests: 2 }, 'tests/c.test.js': { tests: 1 } };

test('planRefresh runs added and changed test files and drops removed ones', () => {
  const plan = planRefresh(stubGit('M\ttests/a.test.js\nA\ttests/b.test.js\nD\ttests/c.test.js\n'), 's', 'h', MAP);
  assert.deepEqual(plan, { run: ['tests/a.test.js', 'tests/b.test.js'], drop: ['tests/a.test.js', 'tests/c.test.js'] });
});

test('planRefresh refuses a non-test change under tests/', () => {
  for (const line of ['M\ttests/helpers/db.js\n', 'A\ttests/fixtures/seed.json\n', 'D\ttests/__snapshots__/a.snap\n']) {
    const plan = planRefresh(stubGit(line), 's', 'h', MAP);
    assert.ok(plan.refuse, `expected a refusal for ${JSON.stringify(line)}`);
    assert.match(plan.refuse, /not a test file|left tests\//);
  }
});

test('planRefresh refuses a dropped path the recorded map does not cover', () => {
  const plan = planRefresh(stubGit('M\ttests/ghost.test.js\n'), 's', 'h', MAP);
  assert.ok(plan.refuse);
  assert.match(plan.refuse, /does not cover `tests\/ghost\.test\.js`/);
});

test('planRefresh treats a rename as a drop plus a run', () => {
  const plan = planRefresh(stubGit('R100\ttests/a.test.js\ttests/renamed.test.js\n'), 's', 'h', MAP);
  assert.deepEqual(plan, { run: ['tests/renamed.test.js'], drop: ['tests/a.test.js'] });
});

test('planRefresh refuses unknown statuses rather than guessing them', () => {
  const plan = planRefresh(stubGit('X\ttests/a.test.js\n'), 's', 'h', MAP);
  assert.ok(plan.refuse);
  assert.match(plan.refuse, /unrecognised diff status/);
});

// ---------------------------------------------------------------- CLI end to end

/**
 * A repository with a recorded measurement: two test files, three passing
 * tests, and the per-file map a full `--apply` would have written.
 */
function refreshFixture(t, prefix, dependent = false) {
  const root = scratch(prefix);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = setupGit(root);
  run(['init', '--quiet', '--initial-branch=main']);
  run(['config', 'user.email', 'refresh@example.invalid']);
  run(['config', 'user.name', 'refresh']);
  run(['config', 'commit.gpgsign', 'false']);
  mkdirSync(join(root, 'tests'), { recursive: true });
  mkdirSync(join(root, 'site'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'refresh-fixture',
    private: true,
    scripts: { verify: 'node --test tests/', 'measure:refresh': 'node scripts/measure-suite.js --refresh' },
  }));
  writeFileSync(join(root, 'tests', 'a.test.js'), TEST_FILE('a', 2));
  writeFileSync(join(root, 'tests', 'b.test.js'), TEST_FILE('b', 1));
  writeFileSync(join(root, 'site', 'claims.json'), JSON.stringify({ claimsContract: 2 }));
  if (dependent) {
    writeFileSync(join(root, 'value.js'), 'export const value = 1;\n');
    writeFileSync(join(root, 'tests', 'b.test.js'), "import test from 'node:test'; import assert from 'node:assert/strict'; import { value } from '../value.js'; test('source dependency', () => assert.equal(value, 1));\n");
  }
  const base = commitAll(run, 'base corpus');
  const record = {
    date: '2026-09-19',
    sha: base.slice(0, 7),
    command: 'npm run verify',
    tests: 3,
    failures: 0,
    testFiles: 2,
    testsTree: run(['rev-parse', `${base}:tests`]),
    files: { 'tests/a.test.js': { tests: 2 }, 'tests/b.test.js': { tests: 1 } },
    note: 'fixture',
  };
  writeFileSync(join(root, 'site', 'claims.json'), JSON.stringify({ claimsContract: 2, measuredAgainst: record }, null, 2));
  commitAll(run, 'record measurement');
  return { root, run, record };
}

const refresh = (root) => spawnSync(process.execPath, [measureSuite, '--refresh'], { cwd: root, encoding: 'utf8' });
const ledgerOf = (root) => JSON.parse(readFileSync(join(root, 'site', 'claims.json'), 'utf8')).measuredAgainst;

test('refresh carries a reword-only tests/ touch without a full re-run', (t) => {
  const { root, run } = refreshFixture(t, 'refresh-carry-');
  writeFileSync(join(root, 'tests', 'a.test.js'), TEST_FILE('a renamed', 2));
  const head = commitAll(run, 'reword a test name');

  const result = refresh(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1 file\(s\) ran, 1 carried/);
  const next = ledgerOf(root);
  assert.equal(next.sha, head.slice(0, 7));
  assert.equal(next.tests, 3);
  assert.equal(next.testFiles, 2);
  assert.equal(next.failures, 0);
  assert.deepEqual(next.files, { 'tests/a.test.js': { tests: 2 }, 'tests/b.test.js': { tests: 1 } });
});

test('refresh adds a new test file by running only it', (t) => {
  const { root, run } = refreshFixture(t, 'refresh-add-');
  writeFileSync(join(root, 'tests', 'c.test.js'), TEST_FILE('c', 4));
  const head = commitAll(run, 'add a test file');

  const result = refresh(root);
  assert.equal(result.status, 0, result.stderr);
  const next = ledgerOf(root);
  assert.equal(next.sha, head.slice(0, 7));
  assert.equal(next.tests, 7);
  assert.equal(next.testFiles, 3);
  assert.deepEqual(next.files['tests/c.test.js'], { tests: 4 });
});

test('refresh removes a deleted file by subtraction', (t) => {
  const { root, run } = refreshFixture(t, 'refresh-drop-');
  rmSync(join(root, 'tests', 'b.test.js'));
  const head = commitAll(run, 'delete a test file');

  const result = refresh(root);
  assert.equal(result.status, 0, result.stderr);
  const next = ledgerOf(root);
  assert.equal(next.sha, head.slice(0, 7));
  assert.equal(next.tests, 2);
  assert.equal(next.testFiles, 1);
  assert.deepEqual(next.files, { 'tests/a.test.js': { tests: 2 } });
});

test('refresh refuses a helper change under tests/', (t) => {
  const { root, run, record } = refreshFixture(t, 'refresh-helper-');
  mkdirSync(join(root, 'tests', 'helpers'), { recursive: true });
  writeFileSync(join(root, 'tests', 'helpers', 'db.js'), '// shared helper\n');
  commitAll(run, 'change a helper');

  const result = refresh(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /is not a test file/);
  assert.deepEqual(ledgerOf(root).sha, record.sha, 'a refused refresh writes nothing');
});

test('refresh refuses a record without a per-file map', (t) => {
  const { root, run } = refreshFixture(t, 'refresh-legacy-');
  const { files, ...legacy } = ledgerOf(root);
  assert.ok(files, 'the fixture really carries a map to drop');
  writeFileSync(join(root, 'site', 'claims.json'), JSON.stringify({ claimsContract: 2, measuredAgainst: legacy }, null, 2));
  commitAll(run, 'drop the map');
  const droppedSha = ledgerOf(root).sha;
  writeFileSync(join(root, 'tests', 'a.test.js'), TEST_FILE('a renamed', 2));
  commitAll(run, 'reword a test name');

  const result = refresh(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not carry/);
  assert.deepEqual(ledgerOf(root).sha, droppedSha, 'a refused refresh writes nothing');
});

test('refresh refuses a dirty tree', (t) => {
  const { root, record } = refreshFixture(t, 'refresh-dirty-');
  writeFileSync(join(root, 'tests', 'a.test.js'), TEST_FILE('a renamed', 2));

  const result = refresh(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /working tree is dirty/);
  assert.deepEqual(ledgerOf(root).sha, record.sha, 'a refused refresh writes nothing');
});

test('refresh refuses a red changed file and records nothing', (t) => {
  const { root, run, record } = refreshFixture(t, 'refresh-red-');
  writeFileSync(join(root, 'tests', 'a.test.js'), `${TEST_FILE('a', 1)}test('a breaks', () => { assert.equal(1, 2); });\n`);
  commitAll(run, 'break a test');

  const result = refresh(root);
  assert.equal(result.status, 1);
  assert.deepEqual(ledgerOf(root).sha, record.sha, 'a refused refresh writes nothing');
});

test('refresh refuses changed inputs outside tests even when the corpus did not move', (t) => {
  const { root, run, record } = refreshFixture(t, 'refresh-settled-');
  writeFileSync(join(root, 'README.md'), 'unrelated\n');
  commitAll(run, 'change prose');

  const before = readFileSync(join(root, 'site', 'claims.json'), 'utf8');
  const result = refresh(root);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /input outside tests/);
  assert.equal(readFileSync(join(root, 'site', 'claims.json'), 'utf8'), before, 'a settled refresh writes nothing');
  assert.deepEqual(ledgerOf(root).sha, record.sha);
});

// A source-only regression cannot inherit yesterday's green counts.
test('planRefresh refuses source, dependency and runner inputs outside tests', () => {
  for (const path of ['packages/core/index.js', 'scripts/run.js', 'package.json', 'package-lock.json', 'examples/fixture.json']) {
    const plan = planRefresh(stubGit(`M\t${path}\nM\ttests/a.test.js\n`), 's', 'h', MAP);
    assert.match(plan.refuse, /input outside tests/);
  }
});


test('refresh cannot carry a failing unchanged test across a source change', (t) => {
  const { root, run, record } = refreshFixture(t, 'refresh-source-', true);
  writeFileSync(join(root, 'value.js'), 'export const value = 2;\n');
  writeFileSync(join(root, 'tests', 'a.test.js'), TEST_FILE('renamed', 2));
  commitAll(run, 'break source and change an unrelated test');
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const counterexample = spawnSync(process.execPath, ['--test', 'tests/b.test.js'], { cwd: root, encoding: 'utf8', env });
  assert.notEqual(counterexample.status, 0, 'the unchanged dependent test really fails');
  const result = refresh(root);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /input outside tests/);
  assert.deepEqual(ledgerOf(root), record, 'the stale green record is never re-anchored');
});

test('refresh refuses a changed public claim outside the measurement block', (t) => {
  const { root, run } = refreshFixture(t, 'refresh-claim-');
  const path = join(root, 'site', 'claims.json');
  const ledger = JSON.parse(readFileSync(path, 'utf8'));
  ledger.claim = 'new input';
  writeFileSync(path, JSON.stringify(ledger));
  commitAll(run, 'change public claim');
  const before = readFileSync(path, 'utf8');
  const result = refresh(root);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /claims outside measuredAgainst/);
  assert.equal(readFileSync(path, 'utf8'), before);
});
