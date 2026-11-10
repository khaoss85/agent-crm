// @ts-check

/**
 * Runs one measure piece file by file, each file under its own ceiling
 * (backlog:3d560518f3e2).
 *
 * A piece used to be ONE `spawnSync(node --test <79 files>)`: its spec output
 * was buffered until the child ended, so a single test file that never ended
 * held the piece silent until the 1800 s machine-lock maximum killed the whole
 * wrapper (exit 124) — 30 minutes with no line in the log and no name for the
 * culprit (run 42754208151, piece 5 of 6, 10/11).
 *
 * Here every file is its own `node --test <file>` child (the runner already
 * isolates each file in its own process, so the tests see the same thing),
 * at most `concurrency` at a time, each with:
 *   - a per-file ceiling: past it the file's whole process group is killed,
 *     the file is named in the log and the piece fails at once;
 *   - one log line when it finishes (green or red, tests, seconds);
 *   - a heartbeat every `heartbeatSec` naming the files still running.
 * Each file writes its own measurement-reporter stream, read back with the
 * same strict parser as before, so the per-file counts keep their provenance.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMeasurementReport } from './measurement-report.js';

/** Default per-file ceiling: the one `runTestFile` already used for one file. */
export const FILE_MAX_SEC = 600;
/** Default heartbeat period. */
export const HEARTBEAT_SEC = 60;

/**
 * The per-file ceiling from the environment (`MEASURE_FILE_MAX_SEC`), or the
 * default. A non-positive or non-integer value is refused, never ignored.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {number}
 */
export function fileMaxSecFrom(env) {
  const raw = env.MEASURE_FILE_MAX_SEC;
  if (raw === undefined || raw === '') return FILE_MAX_SEC;
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new Error(`MEASURE_FILE_MAX_SEC must be a positive whole number of seconds, got ${JSON.stringify(raw)}.`);
  }
  return Number(raw);
}

/**
 * @typedef {{ file: string, status: 'green' | 'red' | 'timeout', seconds: number,
 *   output: string, tests?: number, fail?: number, files?: Record<string, { tests: number }>,
 *   reason?: string }} FileResult
 */

/**
 * @param {{
 *   root: string,
 *   files: string[],
 *   env: NodeJS.ProcessEnv,
 *   concurrency?: number,
 *   fileMaxSec?: number,
 *   heartbeatSec?: number,
 *   log?: (line: string) => void,
 * }} options
 * @returns {Promise<{ ok: boolean, pass: number, fail: number,
 *   files: Record<string, { tests: number }>, results: FileResult[], timedOut: string[] }>}
 */
export async function runPieceFiles(options) {
  const {
    root, files, env,
    concurrency = 2,
    fileMaxSec = FILE_MAX_SEC,
    heartbeatSec = HEARTBEAT_SEC,
    log = (line) => process.stderr.write(`${line}\n`),
  } = options;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error(`runPieceFiles: concurrency must be a whole number of at least 1, got ${concurrency}.`);
  }
  const duplicates = files.filter((file, k) => files.indexOf(file) !== k);
  if (duplicates.length > 0) {
    // A file run twice would be counted twice, and its two summaries would
    // collide in the per-file map: refuse instead of measuring a wrong corpus.
    throw new Error(`runPieceFiles: duplicate test files: ${[...new Set(duplicates)].join(', ')}.`);
  }
  const reporter = fileURLToPath(new URL('./measurement-reporter.js', import.meta.url));
  const scratch = mkdtempSync(join(tmpdir(), 'accordo-measure-files-'));
  /** @type {Map<string, { child: import('node:child_process').ChildProcess, started: number }>} */
  const running = new Map();
  /** @type {FileResult[]} */
  const results = [];
  const queue = [...files];
  let done = 0;
  let spawned = 0;
  let aborted = false;

  const killGroup = (/** @type {import('node:child_process').ChildProcess} */ child) => {
    if (child.pid === undefined) return;
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
  };
  // The machine lock's own maximum ends this process with SIGTERM: the file
  // children are process-group leaders, so they would outlive it. Take them along.
  const onSignal = (/** @type {NodeJS.Signals} */ signal) => {
    for (const { child } of running.values()) killGroup(child);
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);

  const heartbeat = setInterval(() => {
    const now = Date.now();
    const list = [...running].map(([file, { started }]) => `${file} (${Math.round((now - started) / 1000)}s)`);
    log(`measure-suite: ${done}/${files.length} files done; still running: ${list.join(', ') || 'none'}.`);
  }, heartbeatSec * 1000);

  /** @param {string} file @returns {Promise<FileResult>} */
  const runOne = (file) => new Promise((resolveRun) => {
    const reportPath = join(scratch, `${spawned++}.jsonl`);
    const started = Date.now();
    const child = spawn(process.execPath,
      // --test-concurrency=2 as the single-run piece always passed it.
      ['--no-warnings', '--test', '--test-concurrency=2',
        '--test-reporter=spec', '--test-reporter-destination=stdout',
        `--test-reporter=${reporter}`, `--test-reporter-destination=${reportPath}`, file],
      { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    running.set(file, { child, started });
    let output = '';
    child.stdout?.on('data', (chunk) => { output += chunk; });
    child.stderr?.on('data', (chunk) => { output += chunk; });
    let timedOut = false;
    const ceiling = setTimeout(() => { timedOut = true; killGroup(child); }, fileMaxSec * 1000);
    const finish = (/** @type {number | null} */ code, /** @type {string | null} */ signal, /** @type {Error | null} */ error) => {
      clearTimeout(ceiling);
      running.delete(file);
      const seconds = Math.round((Date.now() - started) / 1000);
      if (timedOut) {
        resolveRun({ file, status: 'timeout', seconds, output, reason: `still running after the ${fileMaxSec}s per-file ceiling: killed` });
        return;
      }
      if (error || code !== 0) {
        resolveRun({ file, status: 'red', seconds, output, reason: `exit=${code}, signal=${signal}, error=${error?.message ?? 'none'}` });
        return;
      }
      try {
        const measured = parseMeasurementReport(readFileSync(reportPath, 'utf8'), root, [file]);
        resolveRun({ file, status: 'green', seconds, output, tests: measured.pass, fail: measured.fail, files: measured.files });
      } catch (parseError) {
        resolveRun({ file, status: 'red', seconds, output, reason: /** @type {Error} */ (parseError).message });
      }
    };
    let settled = false;
    child.on('error', (error) => { if (!settled) { settled = true; finish(null, null, error); } });
    child.on('close', (code, signal) => { if (!settled) { settled = true; finish(code, signal, null); } });
  });

  try {
    await new Promise((resolveAll) => {
      const pump = () => {
        if ((aborted || queue.length === 0) && running.size === 0) { resolveAll(undefined); return; }
        while (!aborted && running.size < concurrency && queue.length > 0) {
          const file = /** @type {string} */ (queue.shift());
          runOne(file).then((result) => {
            results.push(result);
            done += 1;
            if (result.status === 'green') {
              log(`measure-suite: [${done}/${files.length}] ${file} green: ${result.tests} tests in ${result.seconds}s.`);
            } else if (aborted && result.status === 'red') {
              log(`measure-suite: [${done}/${files.length}] ${file} stopped after ${result.seconds}s: the piece is already red.`);
            } else {
              log(`measure-suite: [${done}/${files.length}] ${file} ${result.status === 'timeout' ? 'TIMED OUT' : 'RED'} in ${result.seconds}s (${result.reason}).`);
            }
            if (result.status === 'timeout' && !aborted) {
              // A file past its ceiling fails the piece now: the files still
              // running are stopped and nothing new starts, so the lock is
              // released in minutes instead of at the piece maximum.
              aborted = true;
              for (const { child } of running.values()) killGroup(child);
            }
            pump();
          });
        }
      };
      pump();
    });
  } finally {
    clearInterval(heartbeat);
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('SIGINT', onSignal);
    rmSync(scratch, { recursive: true, force: true });
  }

  /** @type {Record<string, { tests: number }>} */
  const map = {};
  let pass = 0;
  let fail = 0;
  for (const result of results) {
    if (result.status !== 'green') continue;
    pass += /** @type {number} */ (result.tests);
    fail += /** @type {number} */ (result.fail);
    Object.assign(map, result.files);
  }
  const sorted = Object.fromEntries(Object.entries(map).sort(([a], [b]) => a.localeCompare(b)));
  const timedOut = results.filter((r) => r.status === 'timeout').map((r) => r.file);
  const ok = !aborted && results.length === files.length && results.every((r) => r.status === 'green');
  return { ok, pass, fail, files: sorted, results, timedOut };
}
