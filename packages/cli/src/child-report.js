// @ts-check

import { spawn } from 'node:child_process';

/**
 * Run a child process that produces a JSON report, under explicit bounds.
 *
 * This is AX1's isolation, extracted so `crm package test` uses it rather than
 * forking it. Three details make the isolation actually hold, each of which
 * failed in an earlier draft of AX1 and was found by attacking it:
 *
 * - **the report does not travel on stdout.** A package is entitled to
 *   `console.log` while its module body runs, and that lands on the child's
 *   stdout. Sharing that stream meant one logging package made the whole
 *   application unreadable. The report comes back on **file descriptor 3**;
 *   the child's stdout and stderr are package noise, returned separately.
 * - **the child leads its own process group**, so a timeout stops the group
 *   rather than only the process we started. A package that *deliberately*
 *   detaches a process into a new group still outlives the run — reaching it
 *   would mean tracking descendants, which is neither attempted nor a sandbox.
 * - **every stream is bounded**, so a package with enormous metadata fails as
 *   an explained size refusal instead of as a mysterious timeout.
 *
 * It is **isolation, not a sandbox**: the child holds this user's authority.
 */

/** The descriptor the child writes its report to. */
export const REPORT_FD = 3;
/** A hung import must not hang the operator's terminal. Generous, and finite. */
export const LOAD_TIMEOUT_MS = 60_000;
/** A report is a document, not a stream; a runaway one is a defect. */
export const MAX_REPORT_BYTES = 16 * 1024 * 1024;
/** Package chatter is diagnostic, and a package that floods it is not. */
export const MAX_NOISE_BYTES = 64 * 1024;
/** Between asking the process group to stop and insisting. */
export const KILL_GRACE_MS = 2_000;
/** After the reporting process exits, how long to collect what it wrote. */
export const DRAIN_MS = 250;

/**
 * @param {{
 *   loader: string,
 *   args?: string[],
 *   timeoutMs?: number,
 *   maxReportBytes?: number,
 *   maxNoiseBytes?: number,
 *   hints?: {timeout?: string, size?: string, empty?: string},
 * }} options
 * @returns {Promise<{report: any, noise: string, diagnostic: string}>}
 */
export function runReportingChild({
  loader,
  args = [],
  timeoutMs = LOAD_TIMEOUT_MS,
  maxReportBytes = MAX_REPORT_BYTES,
  maxNoiseBytes = MAX_NOISE_BYTES,
  hints = {},
}) {
  return new Promise((settle) => {
    const child = spawn(process.execPath, ['--no-warnings', loader, ...args], {
      // Its own process group: a timeout must reach a grandchild a package
      // spawned, not only the process we started.
      detached: true,
      // No stdin — a reader never prompts, so a package that reads it gets EOF
      // instead of stalling a CI job. fd 3 carries the report; 1 and 2 belong
      // to whatever the project's own source decides to print.
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    });

    const streams = {
      report: { chunks: /** @type {string[]} */ ([]), bytes: 0, limit: maxReportBytes, exceeded: false },
      noise: { chunks: /** @type {string[]} */ ([]), bytes: 0, limit: maxNoiseBytes, exceeded: false },
    };
    const collect = (key, stream) => {
      if (!stream) return;
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        const target = streams[key];
        if (target.exceeded) return;
        target.bytes += Buffer.byteLength(chunk, 'utf8');
        if (target.bytes > target.limit) {
          target.exceeded = true;
          if (key === 'report') stop('size');
          return;
        }
        target.chunks.push(chunk);
      });
      // A stream torn down by the kill is not a diagnostic.
      stream.on('error', () => {});
    };
    collect('report', /** @type {any} */ (child.stdio[REPORT_FD]));
    collect('noise', child.stdout);
    collect('noise', child.stderr);

    /** @type {'timeout'|'size'|null} */
    let stopped = null;
    /** @type {any} */
    let insist = null;
    const stop = (reason) => {
      if (stopped) return;
      stopped = reason;
      killGroup(child, 'SIGTERM');
      insist = setTimeout(() => killGroup(child, 'SIGKILL'), KILL_GRACE_MS);
      if (typeof insist.unref === 'function') insist.unref();
    };

    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    let settled = false;
    const finish = (spawnError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (insist) clearTimeout(insist);
      if (drain) clearTimeout(drain);
      const noise = streams.noise.chunks.join('')
        + (streams.noise.exceeded ? `\n… truncated at ${maxNoiseBytes} bytes\n` : '');

      if (spawnError) {
        settle({ report: null, noise, diagnostic: `${spawnError.message}\n` });
        return;
      }
      if (stopped === 'timeout') {
        settle({
          report: null, noise,
          diagnostic: `Timed out after ${timeoutMs / 1000}s. ${hints.timeout ?? 'A module body that does not return on import will do this.'}\n`,
        });
        return;
      }
      if (stopped === 'size' || streams.report.exceeded) {
        settle({
          report: null, noise,
          diagnostic: `The report exceeded ${maxReportBytes / 1024 / 1024} MB and was refused. ${hints.size ?? 'Very large metadata() will do this.'}\n`,
        });
        return;
      }
      const raw = streams.report.chunks.join('');
      try {
        settle({ report: JSON.parse(raw), noise, diagnostic: '' });
      } catch {
        settle({
          report: null, noise,
          diagnostic: raw.trim() === ''
            ? `${hints.empty ?? 'No report was produced.'}\n`
            : 'The report was not valid JSON.\n',
        });
      }
    };

    // Settle on the child's **exit**, not on its streams closing.
    //
    // A grandchild the package spawned inherits these pipes and holds them open
    // for as long as it lives, so `close` can be minutes after the process we
    // started has already finished and written its report. Waiting for it made
    // every package that spawns anything at import time take the full timeout.
    // `exit` says the reporting process is done; a short drain window collects
    // whatever it wrote, and an inherited pipe that never closes is then simply
    // not our problem — which is also what PROCESS_ISOLATION_BOUNDED says.
    let drain = null;
    child.once('error', (error) => finish(error));
    child.once('close', () => finish(null));
    child.once('exit', () => {
      if (settled || drain) return;
      drain = setTimeout(() => finish(null), DRAIN_MS);
      if (typeof drain.unref === 'function') drain.unref();
    });
  });
}

/** Signal the child's whole process group, tolerating a group that is already gone. */
export function killGroup(child, signal) {
  try {
    if (child.pid) process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* already gone */ }
  }
}
