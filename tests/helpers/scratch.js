import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readlinkSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { after } from 'node:test';

/**
 * **Run-owned scratch, and the residual policy over it** (ADR-039 Amendment 1).
 *
 * The compromise this implements, in two halves that answer different questions:
 *
 * - **Per test — retry, warn, register.** A throwaway directory that will not go
 *   does *not* redden a test whose assertions have all passed. Turning a
 *   housekeeping race into a failing assertion reports a defect that is not
 *   there, and a suite people re-run instead of read is the habit ADR-039 exists
 *   to break — reproduced inside its own tests when `82976f1` passed 1527/1527
 *   on one runner and 1526/1527 on another, the single failure being a `t.after`
 *   with `ENOTEMPTY: rmdir '<fixture>/.git'`.
 * - **Per run — retry once more, then fail.** Warning and moving on is the right
 *   answer to a *transient* race and the wrong answer to a *permanent* leak: the
 *   first half alone made a genuine leak invisible, which is the same shape of
 *   failure as a stale document nothing checks. After every test in the file, the
 *   registered residue is retried once, and anything still standing — a
 *   directory or a process still sitting inside the run's scratch — fails the
 *   run deterministically.
 *
 * **Why the run owns a root of its own.** Every scratch directory is created
 * *inside* one `mkdtemp` root per test process, so:
 *
 * - the sweep deletes exactly what this run created and can name nothing else —
 *   there is no pattern match over `os.tmpdir()` that could reach a sibling;
 * - two runs in flight at once cannot touch each other's directories, because
 *   `mkdtemp` gives each root a name the other cannot derive or guess. Proved by
 *   `tests/helpers/scratch-concurrency-probe.js`, which runs two of these side
 *   by side and asserts each survives the other's full sweep.
 *
 * **Nothing is ever killed.** A process still holding a scratch directory is
 * *reported* — by program name, never by pid or path — and the run fails. Signals
 * are not this helper's business.
 *
 * **The detached auto-gc explanation stays a hypothesis.** Every git call in the
 * truth suite runs with `gc.auto=0` and `maintenance.auto=false` on the theory
 * that a detached `git gc --auto` goes on writing inside `.git` after
 * `spawnSync` has returned, and races the teardown. It did not reproduce locally
 * in 75 rounds under three concurrent workers, so it is written down as a
 * hypothesis and this gate does not assert it. The gate reports *what* is left,
 * not why.
 */

/** The one scratch root this test process owns, and the only tree it may delete. */
const RUN_ROOT = mkdtempSync(join(realpathSync(tmpdir()), 'accordo-run-'));

/** Residue registered by a per-test cleanup that could not finish: class → count. */
/** @type {Map<string, number>} */
const registered = new Map();

/**
 * The **class** of a scratch directory: the prefix it was asked for, with
 * `mkdtemp`'s six random characters removed.
 *
 * Reports name this and never an absolute path. A path under `os.tmpdir()`
 * carries the runner's user and directory layout, and a machine-facing report
 * that leaks them tells a reader nothing they needed and something they did not
 * ask for. The class is the part that identifies *which fixture* leaked, which
 * is the whole diagnostic value.
 *
 * @param {string} name a scratch directory name or absolute path
 */
export function scratchClass(name) {
  const base = String(name).split(sep).pop() ?? '';
  return base.replace(/.{6}$/, '') || base;
}

/** Whether a path is inside the run's own scratch root. Nothing else is deletable. */
function insideRun(path) {
  const step = relative(RUN_ROOT, path);
  return step !== '' && !step.startsWith('..') && !step.startsWith(sep);
}

/**
 * Remove a directory, refusing outright to touch anything outside the run root.
 *
 * The guard is not defensive decoration: this helper's whole licence to delete a
 * whole tree comes from the tree being one this process created inside a root it
 * owns. A path that fails the check is a bug in the caller, and a recursive
 * delete is not the place to find out.
 *
 * @param {string} path
 */
function removeInsideRun(path) {
  if (!insideRun(path)) {
    throw new Error(`refusing to remove ${scratchClass(path)}: it is not inside this run's scratch root`);
  }
  rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

/**
 * A temporary directory that removes itself, warns rather than failing if it
 * cannot, and registers what it left for the run-level gate.
 *
 * @param {{after: (fn: () => void) => void}} t the test context
 * @param {string} prefix a stable class name, e.g. `accordo-truth-fixture-`
 */
export function disposable(t, prefix) {
  const root = mkdtempSync(join(RUN_ROOT, prefix));
  t.after(() => {
    try {
      removeInsideRun(root);
    } catch (error) {
      // The assertions in this test have already been made and already passed.
      // Recorded for the run-level gate, which is where a *permanent* leak is
      // allowed to fail something.
      const kind = scratchClass(root);
      registered.set(kind, (registered.get(kind) ?? 0) + 1);
      process.stderr.write(`note: scratch residue left behind — class ${kind} `
        + `(${/** @type {any} */ (error)?.code ?? 'unknown'}); the run-level residual gate will retry it\n`);
    }
  });
  return root;
}

/**
 * Programs still sitting inside the run's scratch, by name, never by pid.
 *
 * Read from `/proc/<pid>/cwd`, and only within this run's own root: a scan that
 * matched more widely would be reporting on other people's work on a shared
 * machine. Unreadable entries are skipped rather than guessed at — a process
 * this one cannot see is not this one's residue.
 */
function programsInsideRun() {
  /** @type {Set<string>} */
  const programs = new Set();
  if (!existsSync('/proc')) return programs;
  let pids;
  try {
    pids = readdirSync('/proc').filter((entry) => /^\d+$/.test(entry));
  } catch {
    return programs;
  }
  for (const pid of pids) {
    if (pid === String(process.pid)) continue;
    let cwd;
    try {
      cwd = readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      continue;
    }
    if (!insideRun(cwd)) continue;
    let program = 'unknown';
    try {
      program = readlinkSync(`/proc/${pid}/exe`).split(sep).pop() ?? 'unknown';
    } catch {
      // A process whose exe is unreadable still counts; it is still in there.
    }
    programs.add(program);
  }
  return programs;
}

/**
 * The run-level residual gate: retry once more, then fail deterministically.
 *
 * @returns {void}
 */
function residualGate() {
  // One more attempt, now that every test has finished and released its handles.
  // This is the retry the compromise asks for, and it is the last one.
  try {
    sweepRunScratch();
  } catch {
    // Fall through to the survey; the gate reports what is there, not what threw.
  }
  /** @type {string[]} */
  let remaining = [];
  try {
    remaining = existsSync(RUN_ROOT) ? readdirSync(RUN_ROOT) : [];
  } catch (error) {
    remaining = [`unreadable-root(${/** @type {any} */ (error)?.code ?? 'unknown'})`];
  }
  const programs = [...programsInsideRun()].sort();

  if (remaining.length === 0 && programs.length === 0) {
    unlinkRunRoot();
    return;
  }

  assert.fail(describeResidual({
    directories: [...new Set(remaining.map(scratchClass))].sort(),
    warned: [...registered.keys()].sort(),
    programs,
  }));
}

/**
 * The gate's message, built from **classes** and never from paths.
 *
 * Separated so it can be asserted without running the gate, and because the
 * no-absolute-paths rule is the part most easily lost in a later edit: a path
 * under `os.tmpdir()` carries the runner's user and directory layout, and a
 * machine-facing report that prints them tells a reader nothing they needed.
 *
 * @param {{directories: string[], warned: string[], programs: string[]}} residual
 */
export function describeResidual({ directories, warned, programs }) {
  return 'run-level residual gate: this test run left scratch behind after a retry.\n'
    + `  directory classes still present: ${directories.join(', ') || '(none)'}\n`
    + `  classes a test already warned about: ${warned.join(', ') || '(none)'}\n`
    + `  program classes still inside the run scratch: ${programs.join(', ') || '(none)'}\n`
    + '  Warning and moving on is the right answer to a transient race and the wrong answer to a permanent\n'
    + '  leak, which is why this fails. Nothing was killed, and nothing outside this run\'s own scratch root\n'
    + '  was touched. Residue is named by class, never by absolute path, on purpose.';
}

/**
 * Armed on import, so a file that uses {@link disposable} cannot forget the gate.
 *
 * Only under the test runner. `after()` outside it starts `node:test`'s root
 * suite, which makes a plain script that imports this helper — the concurrency
 * probe, for one — print TAP and sweep itself at exit. A helper that changes what
 * its importer *is* has no business being imported.
 */
export const gateIsArmed = Boolean(process.env.NODE_TEST_CONTEXT);
if (gateIsArmed) after(residualGate);

/** Exposed so a test can drive the gate's survey without waiting for exit. */
export { residualGate };

/** Exposed so a probe can prove one run's sweep cannot reach another's. */
export function scratchRoot() {
  return RUN_ROOT;
}

/**
 * The out-of-scope guard, exposed so a probe can prove it refuses.
 *
 * A guard nothing ever asks is a comment. The concurrency probe hands it the
 * *other* run's root — the one path a glob-based sweep would have eaten.
 *
 * @param {string} path
 */
export function removeForProbe(path) {
  removeInsideRun(path);
}

/**
 * Remove everything **inside** the run's own scratch root, and nothing else.
 *
 * Entry by entry rather than one recursive delete of the root, so the
 * out-of-scope guard is applied to every path this function actually removes.
 * Exposed so the concurrency probe can run the sweep on demand: the property
 * worth proving is that a full sweep by one run leaves a concurrent run's
 * directories exactly where they were.
 */
export function sweepRunScratch() {
  if (!existsSync(RUN_ROOT)) return;
  for (const entry of readdirSync(RUN_ROOT)) removeInsideRun(join(RUN_ROOT, entry));
}

/**
 * Unlink the (empty) run root itself.
 *
 * The gate would otherwise leave one empty `accordo-run-*` directory per run
 * behind — a leak in the thing built to find leaks, which is not a joke this
 * file gets to make. An empty root that will not unlink is not residue worth
 * failing a run for, so this one is best-effort.
 */
function unlinkRunRoot() {
  try {
    rmSync(RUN_ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // Best effort, deliberately.
  }
}

/**
 * Sweep, then unlink the run root — the whole teardown, for a caller that is not
 * under the test runner (the concurrency probe's workers).
 */
export function disposeRunScratch() {
  sweepRunScratch();
  unlinkRunRoot();
}
