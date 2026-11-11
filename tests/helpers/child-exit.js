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

/** @type {WeakMap<import('node:child_process').ChildProcess, NodeJS.Signals | number | null>} */
const signalsSent = new WeakMap();

/**
 * Record every signal the test sends through `child.kill` from now on, so
 * {@link awaitChildExit} can report it in `signalSent`. Call it right after `spawn`
 * when the test may signal the child before awaiting it (awaitChildExit calls it
 * too). A signal sent around it (`process.kill(child.pid)`) is not seen.
 *
 * @template {import('node:child_process').ChildProcess} T
 * @param {T} child
 * @returns {T}
 */
export function trackSignals(child) {
  if (signalsSent.has(child)) return child;
  signalsSent.set(child, null);
  const kill = child.kill.bind(child);
  child.kill = (signal = 'SIGTERM') => {
    const delivered = kill(signal);
    if (delivered) signalsSent.set(child, signal);
    return delivered;
  };
  return child;
}

/** @param {import('node:child_process').ChildProcess} child */
function closed(child) {
  if (child.exitCode === null && child.signalCode === null) return false;
  // Same streams Node waits on before `close`: stdout and stderr (not stdin).
  return [child.stdout, child.stderr].every((stream) => !stream || stream.closed || stream.destroyed);
}

/**
 * Wait for `child` to exit with its output drained, and report how it ended.
 *
 * @param {import('node:child_process').ChildProcess} child
 * @param {{ label: string, hangGuardMs?: number, diagnostics?: () => string }} options
 *   `label` names the test in the hang error; `diagnostics` adds e.g. the child's stderr;
 *   `hangGuardMs` defaults to what is left of the file's budget ({@link hangGuardMs}).
 * @returns {Promise<{ code: number | null, signal: NodeJS.Signals | null, signalSent: NodeJS.Signals | number | null }>}
 *   `signalSent` is the last signal the test delivered through `child.kill` (see
 *   {@link trackSignals}), `null` if it sent none.
 */
export function awaitChildExit(child, { label, hangGuardMs: guardMs = hangGuardMs(), diagnostics = () => '' }) {
  trackSignals(child);
  // `close` waits for stdout/stderr to end; a stream nobody reads would never end,
  // so one the test left unconsumed is drained (its data was not wanted).
  for (const stream of [child.stdout, child.stderr]) {
    if (stream && stream.readableFlowing === null) stream.resume();
  }
  return new Promise((resolve, reject) => {
    if (closed(child)) {
      resolve({ code: child.exitCode, signal: child.signalCode, signalSent: signalsSent.get(child) ?? null });
      return;
    }
    let hung = false;
    const guard = setTimeout(() => {
      hung = true;
      child.kill('SIGKILL');
    }, guardMs);
    child.once('close', (code, signal) => {
      clearTimeout(guard);
      if (hung) {
        const extra = diagnostics();
        reject(new Error(
          `${label}: child never exited within its ${guardMs} ms hang guard (what was left of the file's `
          + `${FILE_HANG_BUDGET_MS} ms budget; killed with SIGKILL; exit ${code}, signal ${signal})${extra ? `: ${extra}` : ''}`,
        ));
        return;
      }
      resolve({ code, signal, signalSent: signalsSent.get(child) ?? null });
    });
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
