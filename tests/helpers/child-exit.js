import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileMaxSecFrom } from '../../scripts/measure-piece-runner.js';

/**
 * **How a child process ended, read from its own events.**
 *
 * The property the MCP stdio tests guard is «the process exits on its own after
 * stdin EOF, with no signal from us». That is a fact about *how* the process
 * ended — exit code, terminating signal, whether the test had to send one — not
 * about *how fast*. A wall-clock budget (the old 4/10/15 s timers that sent
 * SIGTERM/SIGKILL and failed) turned a loaded runner into a red guard on PRs
 * that never touched MCP (backlog:f835b90af9ad: 81 s and 164 s per file under
 * load, 8 s idle).
 *
 * So {@link awaitChildExit} waits for `close` (the process has exited *and* its
 * stdout/stderr are drained, so output read afterwards is complete) and returns
 * the cause, plus the signal the test itself sent through `child.kill`, if any.
 *
 * The only timer is a **hang guard**, and it is one deadline per test file, not
 * one per wait: several waits in a row must not add up past the per-file ceiling
 * of the measure (`MEASURE_FILE_MAX_SEC`, default 600 s, agent-crm#729). The
 * deadline is {@link FILE_HANG_BUDGET_MS} after this process started (node --test
 * runs each file in its own process); every wait gets what is left of it. A child
 * that never exits is killed and fails its own test by name, before the measure
 * kills the whole file unnamed. It is a safety cap, not a speed requirement:
 * never tighten it to assert speed.
 */

/** Share of the measure's per-file ceiling the hang guards of one file may use together. */
const FILE_HANG_BUDGET_SHARE = 0.8;

/** Total hang budget of one test file: 80% of the per-file ceiling (480 s by default). */
export const FILE_HANG_BUDGET_MS = Math.floor(fileMaxSecFrom(process.env) * 1000 * FILE_HANG_BUDGET_SHARE);

/**
 * What is left of this file's hang budget, in ms (at least 1: a spawnSync `timeout`
 * of 0 would mean no guard at all). Use it for every timeout that only guards a hang:
 * spawnSync `timeout`, a wait for a ready line, `AbortSignal.timeout`.
 */
export function hangGuardMs() {
  return Math.max(1, Math.floor(FILE_HANG_BUDGET_MS - performance.now()));
}

/**
 * Per child: the last signal the *test* delivered through `child.kill`, and the
 * unwrapped `kill` the hang guard uses, so the guard's own SIGKILL never shows up
 * as a signal from the test.
 *
 * @type {WeakMap<import('node:child_process').ChildProcess, { sent: NodeJS.Signals | number | null, rawKill: (signal?: NodeJS.Signals | number) => boolean }>}
 */
const tracked = new WeakMap();

/**
 * `spawn`, with every signal the test sends through `child.kill` recorded from the
 * first moment, so {@link awaitChildExit} can report it in `signalSent`. Every child
 * awaited with awaitChildExit must come from here: a kill sent before tracking began
 * would be lost and «no signal sent» would prove nothing. A signal sent around it
 * (`process.kill(child.pid)`) is not the test's `child.kill` and is not recorded.
 *
 * @type {typeof spawn}
 */
export const spawnTracked = /** @type {typeof spawn} */ ((...args) => {
  const child = /** @type {import('node:child_process').ChildProcess} */ (spawn(.../** @type {[string, string[], object]} */ (args)));
  const rawKill = child.kill.bind(child);
  const record = { sent: /** @type {NodeJS.Signals | number | null} */ (null), rawKill };
  tracked.set(child, record);
  child.kill = (signal = 'SIGTERM') => {
    const delivered = rawKill(signal);
    if (delivered) record.sent = signal;
    return delivered;
  };
  return child;
});

/** @param {import('node:child_process').ChildProcess} child */
function exited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

/** @param {import('node:child_process').ChildProcess} child */
function closed(child) {
  // Same streams Node waits on before `close`: stdout and stderr (not stdin).
  return exited(child) && [child.stdout, child.stderr].every((stream) => !stream || stream.closed || stream.destroyed);
}

/**
 * Wait for `child` to exit with its output drained, and report how it ended.
 *
 * When the hang guard expires the wait **always** rejects, by name, whatever the
 * pipes do: a child still running is killed (SIGKILL, by the guard, not counted as
 * the test's signal) and awaited to its `exit`; a child that exited but whose
 * stdout/stderr never closed (a grandchild inherited the descriptors) has its
 * streams destroyed. The error carries `signalSent` (the test's) and `guardSignal`
 * (the guard's, or `null` when the child had already exited).
 *
 * @param {import('node:child_process').ChildProcess} child spawned with {@link spawnTracked}
 * @param {{ label: string, hangGuardMs?: number, diagnostics?: () => string }} options
 *   `label` names the test in the hang error; `diagnostics` adds e.g. the child's stderr;
 *   `hangGuardMs` defaults to what is left of the file's budget ({@link hangGuardMs}).
 * @returns {Promise<{ code: number | null, signal: NodeJS.Signals | null, signalSent: NodeJS.Signals | number | null }>}
 *   `signalSent` is the last signal the test delivered through `child.kill`, `null` if none.
 */
export function awaitChildExit(child, { label, hangGuardMs: guardMs = hangGuardMs(), diagnostics = () => '' }) {
  const record = tracked.get(child);
  if (!record) {
    return Promise.reject(new TypeError(`${label}: spawn the child with spawnTracked, so the signals the test sent are known from the start`));
  }
  // `close` waits for stdout/stderr to end; a stream nobody reads would never end,
  // so one the test left unconsumed is drained (its data was not wanted).
  for (const stream of [child.stdout, child.stderr]) {
    if (stream && stream.readableFlowing === null) stream.resume();
  }
  return new Promise((resolve, reject) => {
    if (closed(child)) {
      resolve({ code: child.exitCode, signal: child.signalCode, signalSent: record.sent });
      return;
    }
    let settled = false;
    const onClose = (/** @type {number | null} */ code, /** @type {NodeJS.Signals | null} */ signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      resolve({ code, signal, signalSent: record.sent });
    };
    const fail = (/** @type {NodeJS.Signals | null} */ guardSignal, /** @type {string} */ what) => {
      const extra = diagnostics();
      const error = Object.assign(new Error(
        `${label}: ${what} within its ${guardMs} ms hang guard (what was left of the file's ${FILE_HANG_BUDGET_MS} ms budget; `
        + `exit ${child.exitCode}, signal ${child.signalCode}; test sent ${record.sent ?? 'no signal'}, `
        + `guard sent ${guardSignal ?? 'no signal'})${extra ? `: ${extra}` : ''}`,
      ), { signalSent: record.sent, guardSignal });
      reject(error);
    };
    const guard = setTimeout(() => {
      settled = true;
      child.off('close', onClose);
      // Whatever holds the pipes, the wait ends here: the streams go, the error names the test.
      const drop = () => { for (const stream of [child.stdout, child.stderr]) stream?.destroy(); };
      if (exited(child)) {
        drop();
        fail(null, 'child exited but its stdout/stderr never closed (a descendant holds them)');
        return;
      }
      child.once('exit', () => {
        drop();
        fail('SIGKILL', 'child never exited');
      });
      record.rawKill('SIGKILL');
    }, guardMs);
    child.once('close', onClose);
  });
}

/**
 * The same hang guard for a `spawnSync` child: pass `timeout: hangGuardMs()` and call
 * this before reading the result, so a child that never exits fails by name instead of
 * as an unexplained `null !== 0` (a fixed 10 s `timeout` did exactly that under load on
 * the touched-files phase of #796).
 *
 * @param {import('node:child_process').SpawnSyncReturns<string>} result
 * @param {string} label
 */
export function assertSyncChildExited(result, label) {
  const error = /** @type {NodeJS.ErrnoException | undefined} */ (result.error);
  if (error?.code === 'ETIMEDOUT') {
    throw new Error(`${label}: child never exited within the hang guard (what was left of the file's `
      + `${FILE_HANG_BUDGET_MS} ms budget; killed with ${result.signal}): ${result.stderr ?? ''}`);
  }
}
