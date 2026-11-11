/**
 * **How a child process ended, read from its own `exit` event.**
 *
 * The property the MCP stdio tests guard is «the process exits on its own after
 * stdin EOF, with no signal from us». That is a fact about *how* the process
 * ended — exit code, terminating signal, whether the test had to send one — not
 * about *how fast*. A wall-clock budget (the old 4/10/15 s timers that sent
 * SIGTERM/SIGKILL and failed) turned a loaded runner into a red guard on PRs
 * that never touched MCP (backlog:f835b90af9ad: 81 s and 164 s per file under
 * load, 8 s idle).
 *
 * So this helper waits for `exit` and returns its cause. The only timer is a
 * **hang guard**: if the child never exits at all, it is killed with SIGKILL
 * after {@link CHILD_EXIT_HANG_GUARD_MS} and the promise rejects with the
 * caller's label, so a hung process fails its own test by name instead of
 * running into the per-file ceiling of the measure (600 s, agent-crm#729). It
 * is a safety cap, not a speed requirement: never tighten it to assert speed.
 */

/** Hang guard: generous, well below the per-file ceiling (600 s). Not a speed budget. */
export const CHILD_EXIT_HANG_GUARD_MS = 180_000;

/**
 * Wait for `child` to exit and report how it ended.
 *
 * @param {import('node:child_process').ChildProcess} child
 * @param {{ label: string, hangGuardMs?: number, diagnostics?: () => string }} options
 *   `label` names the test in the hang error; `diagnostics` adds e.g. the child's stderr.
 * @returns {Promise<{ code: number | null, signal: NodeJS.Signals | null, signalSent: NodeJS.Signals | null }>}
 *   `signalSent` is the signal the test itself sent (always `null` on resolve: the
 *   helper only signals on a hang, and a hang rejects).
 */
export function awaitChildExit(child, { label, hangGuardMs = CHILD_EXIT_HANG_GUARD_MS, diagnostics = () => '' }) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ code: child.exitCode, signal: child.signalCode, signalSent: null });
      return;
    }
    /** @type {NodeJS.Signals | null} */
    let signalSent = null;
    const guard = setTimeout(() => {
      signalSent = 'SIGKILL';
      child.kill('SIGKILL');
    }, hangGuardMs);
    child.once('exit', (code, signal) => {
      clearTimeout(guard);
      if (signalSent) {
        const extra = diagnostics();
        reject(new Error(
          `${label}: child never exited within the ${hangGuardMs} ms hang guard `
          + `(killed with ${signalSent}; exit ${code}, signal ${signal})${extra ? `: ${extra}` : ''}`,
        ));
        return;
      }
      resolve({ code, signal, signalSent });
    });
  });
}
