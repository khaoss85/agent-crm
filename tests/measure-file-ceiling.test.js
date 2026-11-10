// @ts-check

/**
 * The measure's per-file ceiling (backlog:3d560518f3e2).
 *
 * Run 42754208151 (10/11): piece 5 of 6 printed nothing from 05:01:56 to
 * 05:31:56 and was killed by the 1800 s lock maximum (exit 124) — one
 * buffered `node --test` over 79 files, so the file that never ended was
 * never named. These tests pin the cure: a file that never ends is killed by
 * its own ceiling and named, the piece fails in seconds, every finished file
 * is logged, and the files still running are named on a heartbeat.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitIn } from './helpers/isolated-git.js';
import { FILE_MAX_SEC, fileMaxSecFrom, runPieceFiles } from '../scripts/measure-piece-runner.js';
import { stableKey } from './helpers/contracts-project.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

const GREEN = "import test from 'node:test';\ntest('one', () => {});\ntest('two', () => {});\n";
/**
 * Never ends: an open interval keeps the file's process alive, and a detached
 * grandchild proves the whole process group goes when the ceiling fires.
 * @param {string} pidFile
 */
const HANGING = (pidFile) => [
  "import test from 'node:test';",
  "import { spawn } from 'node:child_process';",
  "import { writeFileSync } from 'node:fs';",
  "const sleeper = spawn('sleep', ['300'], { stdio: 'ignore' });",
  `writeFileSync(${JSON.stringify(pidFile)}, String(sleeper.pid));`,
  "test('never ends', async () => { await new Promise(() => { setInterval(() => {}, 1000); }); });",
  '',
].join('\n');

/**
 * Whether a process still runs. A killed process its parent has not reaped yet
 * is a zombie that still answers kill(pid, 0), so the state is read instead:
 * /proc/<pid>/stat on Linux, `ps -o stat=` elsewhere; gone or Z is not alive.
 * @param {number} pid
 */
function alive(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2)[0] !== 'Z';
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT' && existsSync('/proc/self/stat')) return false;
  }
  const ps = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  const state = (ps.stdout ?? '').trim();
  return state !== '' && !state.startsWith('Z');
}

/** Poll until the process is gone or a zombie; true when it went within the deadline. */
async function goneWithin(pid, ms) {
  const deadline = Date.now() + ms;
  while (alive(pid)) {
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
  return true;
}

/** Child env without the outer runner context (a nested `node --test` would report to us). */
function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

test('the per-file ceiling defaults to 600 s and refuses a malformed override', () => {
  assert.equal(FILE_MAX_SEC, 600);
  assert.equal(fileMaxSecFrom({}), 600);
  assert.equal(fileMaxSecFrom({ MEASURE_FILE_MAX_SEC: '45' }), 45);
  for (const bad of ['0', '-3', '1.5', 'ten']) {
    assert.throws(() => fileMaxSecFrom({ MEASURE_FILE_MAX_SEC: bad }), /MEASURE_FILE_MAX_SEC/);
  }
});

test('the runner refuses a concurrency below one and a file listed twice', async () => {
  const base = { root: repoRoot, env: childEnv(), log: () => {} };
  for (const concurrency of [0, -1, 1.5, Number.NaN]) {
    await assert.rejects(() => runPieceFiles({ ...base, files: ['tests/a.test.js'], concurrency }), /concurrency/);
  }
  await assert.rejects(
    () => runPieceFiles({ ...base, files: ['tests/a.test.js', 'tests/b.test.js', 'tests/a.test.js'] }),
    /duplicate test files: tests\/a\.test\.js/,
  );
});

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

test('a file that never ends is killed at its ceiling, named, and fails the piece in seconds', async () => {
  const root = mkdtempSync(join(tmpdir(), 'accordo-file-ceiling-'));
  try {
    mkdirSync(join(root, 'tests'));
    const pidFile = join(root, 'sleeper.pid');
    writeFileSync(join(root, 'tests', 'a-green.test.js'), GREEN);
    writeFileSync(join(root, 'tests', 'b-hang.test.js'), HANGING(pidFile));
    writeFileSync(join(root, 'tests', 'c-green.test.js'), GREEN);
    /** @type {string[]} */
    const lines = [];
    const started = Date.now();
    const run = await runPieceFiles({
      root,
      files: ['tests/a-green.test.js', 'tests/b-hang.test.js', 'tests/c-green.test.js'],
      env: childEnv(),
      concurrency: 1,
      fileMaxSec: 3,
      heartbeatSec: 1,
      log: (line) => lines.push(line),
    });
    const seconds = (Date.now() - started) / 1000;
    const log = lines.join('\n');
    assert.equal(run.ok, false);
    assert.deepEqual(run.timedOut, ['tests/b-hang.test.js']);
    assert.ok(seconds < 30, `the piece took ${seconds}s: the ceiling did not stop it`);
    assert.match(log, /tests\/a-green\.test\.js green: 2 tests/, 'a finished file is logged');
    assert.match(log, /tests\/b-hang\.test\.js TIMED OUT .*3s per-file ceiling/, 'the hanging file is named');
    assert.match(log, /still running: tests\/b-hang\.test\.js \(\d+s\)/, 'the heartbeat names the file in progress');
    assert.ok(!log.includes('c-green'), 'nothing new starts once the piece is red');
    const sleeper = Number(readFileSync(pidFile, 'utf8'));
    assert.ok(await goneWithin(sleeper, 5000), 'the hanging file\'s process group is killed, grandchildren included');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('green files are counted per file, exactly as the reporter measured them', async () => {
  const root = mkdtempSync(join(tmpdir(), 'accordo-file-ceiling-'));
  try {
    mkdirSync(join(root, 'tests'));
    writeFileSync(join(root, 'tests', 'a.test.js'), GREEN);
    writeFileSync(join(root, 'tests', 'b.test.js'), "import test from 'node:test';\ntest('x', () => {});\n");
    writeFileSync(join(root, 'tests', 'c.test.js'), "import test from 'node:test';\ntest('red', () => { throw new Error('boom'); });\n");
    /** @type {string[]} */
    const lines = [];
    const green = await runPieceFiles({
      root, files: ['tests/a.test.js', 'tests/b.test.js'], env: childEnv(), log: (line) => lines.push(line),
    });
    assert.equal(green.ok, true);
    assert.equal(green.pass, 3);
    assert.deepEqual(green.files, { 'tests/a.test.js': { tests: 2 }, 'tests/b.test.js': { tests: 1 } });
    assert.equal(lines.filter((line) => / green: \d+ tests in \d+s\.$/.test(line)).length, 2);
    const red = await runPieceFiles({
      root, files: ['tests/a.test.js', 'tests/c.test.js'], env: childEnv(), log: (line) => lines.push(line),
    });
    assert.equal(red.ok, false);
    assert.deepEqual(red.timedOut, []);
    assert.match(lines.join('\n'), /tests\/c\.test\.js RED/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('reproTest: a measure piece holding a file that never ends fails at the ceiling and names it', () => {
  const root = mkdtempSync(join(tmpdir(), 'accordo-file-ceiling-repo-'));
  try {
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, 'tests'));
    for (const name of ['measure-suite.js', 'measure-piece-runner.js', 'measurement-report.js',
      'measurement-reporter.js', 'git-env.js']) {
      copyFileSync(join(repoRoot, 'scripts', name), join(root, 'scripts', name));
    }
    writeFileSync(join(root, 'package.json'), '{ "type": "module" }\n');
    writeFileSync(join(root, 'tests', 'a-green.test.js'), GREEN);
    writeFileSync(join(root, 'tests', 'b-hang.test.js'), HANGING('/dev/null'));
    const git = gitIn(root);
    for (const args of [['init', '-q'], ['add', '-A'],
      ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--no-gpg-sign', '-m', 'fixture']]) {
      assert.equal(git(args).status, 0, `git ${args.join(' ')}`);
    }
    const out = join(tmpdir(), `accordo-file-ceiling-${process.pid}.json`);
    const started = Date.now();
    const run = spawnSync(process.execPath, ['scripts/measure-suite.js', '--shard', '1/1', '--out', out], {
      cwd: root, encoding: 'utf8', env: childEnv({ MEASURE_FILE_MAX_SEC: '3' }), timeout: 60_000,
    });
    const seconds = (Date.now() - started) / 1000;
    assert.notEqual(run.status, 0, 'the piece must fail');
    assert.ok(seconds < 30, `the piece took ${seconds}s instead of failing at the 3 s ceiling`);
    assert.match(run.stderr, /each file runs under its own 3s ceiling/);
    assert.match(run.stderr, /tests\/a-green\.test\.js green: 2 tests/);
    assert.match(run.stderr, /tests\/b-hang\.test\.js passed the 3s per-file ceiling and was killed; nothing recorded/);
    assert.ok(!existsSync(out), 'a timed-out piece writes no joinable report');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
