// @ts-check

/**
 * **Two runs, one `/tmp`: prove neither sweep can reach the other.**
 *
 *   node tests/helpers/scratch-concurrency-probe.js            drive both workers
 *   node tests/helpers/scratch-concurrency-probe.js worker <dir> <a|b>
 *
 * The run-level residual gate in `tests/helpers/scratch.js` is only safe because
 * it removes a tree this process created and can name nothing else. That is a
 * claim about concurrency, so it is driven concurrently rather than argued: two
 * worker processes each build scratch directories the way every test does, each
 * publishes its run root, each waits until it can see the other's, and each then
 * runs a **full sweep** of its own. A worker fails if its own directories
 * survive its sweep, or — the property that matters — if the other worker's did
 * not survive it.
 *
 * A shared `/tmp` glob (`accordo-*`, which is how the directories were named
 * before this helper existed) passes the first check and fails the second. That
 * is exactly why the run root is a `mkdtemp` name the other side cannot derive.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url);

/** Sleep without a timer, so the worker can stay synchronous and readable. */
function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Spin until a file appears, or give up — a probe may never hang a suite. */
function waitFor(path, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return readFileSync(path, 'utf8').trim();
    pause(25);
  }
  throw new Error(`timed out waiting for ${path}`);
}

const CLASSES = ['accordo-truth-fixture-', 'accordo-truth-measure-', 'accordo-probe-'];

async function worker(handshakeDir, name) {
  const scratch = await import(new URL('./scratch.js', import.meta.url).href);
  const root = scratch.scratchRoot();
  assert.equal(scratch.gateIsArmed, false, `${name}: the exit gate armed outside the test runner`);

  const otherName = name === 'a' ? 'b' : 'a';
  const step = (label) => {
    writeFileSync(join(handshakeDir, `${name}.${label}`), label);
    waitFor(join(handshakeDir, `${otherName}.${label}`));
  };
  const populate = () => {
    for (const prefix of CLASSES) writeFileSync(join(mkdtempSync(join(root, prefix)), 'marker'), name);
  };
  const survived = (when) => {
    const mine = readdirSync(root).sort();
    assert.equal(mine.length, CLASSES.length,
      `${name}: ${when} left ${mine.length} of its ${CLASSES.length} directories — a sweep reached across runs`);
    for (const directory of mine) {
      assert.equal(readFileSync(join(root, directory, 'marker'), 'utf8'), name,
        `${name}: a marker file did not survive ${when}`);
    }
  };

  populate();
  writeFileSync(join(handshakeDir, `${name}.root`), root);
  const otherRoot = waitFor(join(handshakeDir, `${otherName}.root`));
  assert.notEqual(otherRoot, root, `${name}: both workers claimed the same run root`);
  step('populated');

  // Round 1 — `a` sweeps everything it owns while `b` is standing beside it.
  if (name === 'a') scratch.sweepRunScratch();
  step('swept-a');
  if (name === 'b') survived("the concurrent run's full sweep");
  else assert.deepEqual(readdirSync(root), [], 'a: its own sweep left its own scratch behind');

  // Round 2 — the same, the other way round, so both directions are evidence.
  if (name === 'a') populate();
  step('repopulated');
  if (name === 'b') scratch.sweepRunScratch();
  step('swept-b');
  if (name === 'a') survived("the concurrent run's full sweep");
  else assert.deepEqual(readdirSync(root), [], 'b: its own sweep left its own scratch behind');

  // The guard is not merely unused here: a path outside the run root is refused
  // when asked directly, which is what makes "delete this whole tree" safe.
  assert.throws(() => scratch.removeForProbe(otherRoot), /not inside this run's scratch root/,
    `${name}: the out-of-scope guard did not refuse the concurrent run's root`);
  assert.equal(readdirSync(otherRoot).length >= 0, true);

  // A probe that leaves an empty run root behind is a leak in the thing built to
  // find leaks. The workers are not under the test runner, so they tear down
  // explicitly instead of relying on the gate.
  step('verified');
  scratch.disposeRunScratch();
  process.stdout.write(`${name}: both rounds clean — its own scratch survived ${otherName}'s full sweep\n`);
}

/**
 * Run both workers **at the same time** and return their results.
 *
 * `spawn`, not `spawnSync`: running them in sequence would prove nothing about
 * two runs in flight, which is the only thing this probe is for.
 */
export async function runConcurrencyProbe() {
  const handshakeDir = mkdtempSync(join(tmpdir(), 'accordo-scratch-probe-'));
  try {
    return await Promise.all(['a', 'b'].map((name) => new Promise((settle) => {
      // A worker is a plain script, not a test. `NODE_TEST_CONTEXT` is inherited
      // when the probe is driven *from* a test, and inheriting it would arm the
      // exit gate inside the worker and have it sweep itself mid-handshake.
      const env = { ...process.env };
      delete env.NODE_TEST_CONTEXT;
      const child = spawn(process.execPath, [self, 'worker', handshakeDir, name], { env });
      let out = '';
      let err = '';
      child.stdout.setEncoding('utf8').on('data', (chunk) => { out += chunk; });
      child.stderr.setEncoding('utf8').on('data', (chunk) => { err += chunk; });
      child.on('close', (code) => settle({ name, code, out, err }));
    })));
  } finally {
    rmSync(handshakeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

if (process.argv[1] === self) {
  if (process.argv[2] === 'worker') {
    worker(process.argv[3], process.argv[4]).catch((error) => {
      process.stderr.write(`${process.argv[4]}: ${error?.stack ?? error}\n`);
      process.exit(1);
    });
  } else {
    runConcurrencyProbe().then((results) => {
      for (const result of results) {
        process.stdout.write(`worker ${result.name}: exit ${result.code}\n${result.out}${result.err}`);
      }
      process.exit(results.every((result) => result.code === 0) ? 0 : 1);
    });
  }
}
