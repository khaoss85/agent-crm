// @ts-check

/**
 * The fast gate's busy rule (backlog:3d560518f3e2): a touched-tests timeout
 * while the machine is full (load1 > 1.5 x CPUs at the start or at the bound)
 * with no failed file is "busy", not red, and the gate retries the touched
 * tests once after the load drops; a timeout on a machine under the bound, or
 * with a failed file, stays red. Every load here is injected.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUSY_LOAD_FACTOR, busyVerdict, decideTimeout, readLoad1 } from '../scripts/ci-touched-tests.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const retryScript = join(repoRoot, 'scripts', 'ci-fast-busy-retry.sh');

test('full means load1 above 1.5 x CPUs, at the start or at the bound', () => {
  assert.equal(BUSY_LOAD_FACTOR, 1.5);
  assert.deepEqual(busyVerdict({ loadStart: 30, loadEnd: 20, cpus: 16 }), { busy: true, threshold: 24 });
  assert.deepEqual(busyVerdict({ loadStart: 10, loadEnd: 36, cpus: 16 }), { busy: true, threshold: 24 });
  assert.deepEqual(busyVerdict({ loadStart: 24, loadEnd: 24, cpus: 16 }), { busy: false, threshold: 24 });
  assert.deepEqual(busyVerdict({ loadStart: null, loadEnd: null, cpus: 16 }), { busy: false, threshold: 24 });
});

test('load1 is read from the loadavg file, null where there is none', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-busy-'));
  try {
    writeFileSync(join(dir, 'loadavg'), '36.12 40.01 41.50 3/1200 4242\n');
    assert.equal(readLoad1(join(dir, 'loadavg')), 36.12);
    assert.equal(readLoad1(join(dir, 'missing')), null);
    writeFileSync(join(dir, 'bad'), 'not a load\n');
    assert.equal(readLoad1(join(dir, 'bad')), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a timeout on a full machine with no failed file is busy and leaves the retry record', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-busy-'));
  try {
    const busyFile = join(dir, 'busy.json');
    const decision = decideTimeout({ loadStart: 36, loadEnd: 44, cpus: 16, failedFiles: [], remaining: ['tests/slow.test.js'], busyFile });
    assert.equal(decision.busy, true);
    assert.match(decision.line, /load1 36 at start, 44 at the bound \(busy above 24 = 1\.5 x 16 CPUs\): busy: not counted as red/);
    assert.deepEqual(JSON.parse(readFileSync(busyFile, 'utf8')), {
      loadStart: 36, loadEnd: 44, threshold: 24, cpus: 16, remaining: ['tests/slow.test.js'],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a timeout stays red on a machine under the bound, with a failed file, or on the retry itself', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-busy-'));
  try {
    const busyFile = join(dir, 'busy.json');
    const calm = decideTimeout({ loadStart: 8, loadEnd: 12, cpus: 16, failedFiles: [], remaining: ['a'], busyFile });
    assert.equal(calm.busy, false);
    assert.match(calm.line, /red: the machine was not full/);
    const failed = decideTimeout({ loadStart: 40, loadEnd: 40, cpus: 16, failedFiles: ['tests/red.test.js'], remaining: ['a'], busyFile });
    assert.equal(failed.busy, false);
    assert.match(failed.line, /red: a file failed/);
    const retry = decideTimeout({ loadStart: 40, loadEnd: 40, cpus: 16, failedFiles: [], remaining: ['a'] });
    assert.equal(retry.busy, false);
    assert.match(retry.line, /red: busy, but this run is already the retry/);
    assert.equal(existsSync(busyFile), false, 'no retry record for a red timeout');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * @param {string} dir
 * @param {Record<string, string>} env
 */
function runRetry(dir, env) {
  return spawnSync('bash', [retryScript], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, CI_TOUCHED_BUSY_FILE: join(dir, 'busy.json'), CI_LOADAVG_FILE: join(dir, 'loadavg'), CI_BUSY_POLL_SEC: '1', ...env },
    timeout: 60_000,
  });
}

/** @param {string} dir @param {number} load */
function setup(dir, load) {
  writeFileSync(join(dir, 'busy.json'), JSON.stringify({ loadStart: 40, loadEnd: 44, threshold: 24, cpus: 16, remaining: ['a'] }));
  writeFileSync(join(dir, 'loadavg'), `${load} 30.00 30.00 1/100 1\n`);
}

test('the retry waits for the load to drop, then retries once and its result is the gate\'s', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-busy-'));
  try {
    setup(dir, 40);
    // No timing race: the load drops (atomically: write then rename) only
    // once the script has logged that it is waiting on the high load.
    const child = spawn('bash', [retryScript], {
      cwd: repoRoot,
      env: { ...process.env, CI_TOUCHED_BUSY_FILE: join(dir, 'busy.json'), CI_LOADAVG_FILE: join(dir, 'loadavg'), CI_BUSY_POLL_SEC: '1', CI_BUSY_WAIT_SEC: '60', CI_BUSY_RETRY_CMD: 'echo RETRY-RAN; exit 0' },
    });
    const closed = new Promise((resolve) => child.on('close', resolve));
    let out = '';
    let dropped = false;
    child.stdout.on('data', (chunk) => {
      out += chunk;
      if (!dropped && /load1 40 > 24 after 0s, waiting/.test(out)) {
        dropped = true;
        writeFileSync(join(dir, 'loadavg.next'), '10.00 30.00 30.00 1/100 1\n');
        renameSync(join(dir, 'loadavg.next'), join(dir, 'loadavg'));
      }
    });
    const code = await closed;
    assert.equal(code, 0, out);
    assert.match(out, /load1 40 > 24 after 0s, waiting/);
    assert.match(out, /load1 10\.00 <= 24 after \d+s: retrying the touched tests once/);
    assert.match(out, /RETRY-RAN/);
    assert.match(out, /the retry passed: the gate is green/);
    assert.equal(existsSync(join(dir, 'busy.json')), false, 'the record is consumed: one retry only');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('past the wait cap the retry still runs once, and a red retry is red', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-busy-'));
  try {
    setup(dir, 40);
    const run = runRetry(dir, { CI_BUSY_WAIT_SEC: '2', CI_BUSY_RETRY_CMD: 'echo RETRY-RAN; exit 1' });
    assert.equal(run.status, 1, run.stdout + run.stderr);
    assert.match(run.stdout, /load1 40 still > 24 after 2s \(cap 2s\): retrying anyway, once/);
    assert.match(run.stdout, /RETRY-RAN/);
    assert.match(run.stdout, /the retry failed \(exit 1\): the gate is red/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no busy record means nothing to retry: the gate\'s red stands', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ci-busy-'));
  try {
    const run = runRetry(dir, { CI_BUSY_RETRY_CMD: 'echo RETRY-RAN' });
    assert.equal(run.status, 2);
    assert.doesNotMatch(run.stdout, /RETRY-RAN/);
    assert.match(run.stdout, /no busy record/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
