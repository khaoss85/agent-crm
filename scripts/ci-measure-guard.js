// @ts-check

/**
 * Head-changed guard for the scheduled `main` measurement (backlog:911355123044).
 *
 * A push to `main` never starts `measure-suite.js`: the full suite with its
 * measurement holds the shared Mac's single heavy lock ~25 minutes per run,
 * and one runner serves this repository plus Arvo. The measurement instead
 * runs on a schedule (see the `schedule` trigger in `.github/workflows/ci.yml`,
 * the configured window), and then only when the head moved since the last
 * recording — this script is that second condition.
 *
 *   node scripts/ci-measure-guard.js [--root <dir>] [--state-file <path>]
 *   node scripts/ci-measure-guard.js --record [--root <dir>] [--state-file <path>]
 *
 * Prints `true` when the tree must be measured, `false` when the committed
 * `site/claims.json` already names this head or the runner-local state file
 * does. The committed ledger alone cannot answer: measuring commit A and
 * merging the re-anchored ledger creates commit B, so `HEAD !==
 * measuredAgainst.sha` on every clean checkout and a ledger-only guard would
 * re-measure every window. The scheduled run therefore records each
 * successful measurement in the state file (`--record`), which lives outside
 * the checkout on the single self-hosted runner — the same durable place the
 * run already keeps its measurement copy. The direction is conservative:
 * anything unreadable, unparsable or unrecognised answers `true` — a skipped
 * measurement the tree needed would leave stale claims behind with only a
 * warning (the push-time `public-claims` job signals age, it does not gate),
 * while a redundant measurement costs at most one run inside its window.
 * Exit code is always 0 for the same reason: doubt measures, never skips.
 * `--record` follows the same spirit: a recording failure prints a
 * `::warning::` and exits 0, so a bookkeeping failure never reddens a green
 * measurement — the next window simply measures again.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { spawnGit } from './git-env.js';

/** Where the scheduled run records its successful measurements. */
export const DEFAULT_STATE_FILE = join(homedir(), '.accordo-ci', 'main-last-measurement.json');

/**
 * Whether the recorded measurement already describes this head. The ledger
 * records a short prefix (`measure-suite.js --apply` writes 7 hex chars), so
 * a recorded value the full head starts with counts as the same head.
 * Anything else — missing values, malformed SHAs, a different commit —
 * counts as changed, because skipping there would need proof this script
 * cannot have.
 *
 * @param {{ headSha?: unknown, recordedSha?: unknown }} input
 * @returns {boolean} true only when the record provably names this head
 */
export function headAlreadyMeasured({ headSha, recordedSha }) {
  const head = String(headSha ?? '').trim().toLowerCase();
  const recorded = String(recordedSha ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(head)) return false;
  if (!/^[0-9a-f]{7,40}$/.test(recorded)) return false;
  return head.startsWith(recorded);
}

/**
 * Parse the runner-local state file the scheduled run maintains with
 * `--record`. Pure: the caller reads the file, this decides what it means.
 * Anything unreadable-shaped resolves to "no usable record", never to a
 * skip — only a well-formed 40-hex head counts.
 *
 * @param {unknown} text the state file's raw content
 * @returns {{ sidecarSha?: string }} the recorded head, when usable
 */
export function parseStateRecord(text) {
  try {
    const record = JSON.parse(String(text ?? ''));
    const sha = typeof record?.sha === 'string' ? record.sha.trim().toLowerCase() : '';
    if (/^[0-9a-f]{40}$/.test(sha)) return { sidecarSha: sha };
  } catch {
    // Fall through: no usable record means measure.
  }
  return {};
}

/**
 * Build the state-file payload for one successful measurement. Pure, so the
 * record format and its test cannot disagree.
 *
 * @param {unknown} headSha the measured checkout head
 * @param {unknown} nowMs the recording clock
 * @returns {{ sha: string, measuredAt: number } | null} null when unusable
 */
export function recordStatePayload(headSha, nowMs) {
  const sha = String(headSha ?? '').trim().toLowerCase();
  const at = typeof nowMs === 'number' ? nowMs : Date.now();
  if (!/^[0-9a-f]{40}$/.test(sha)) return null;
  if (!Number.isFinite(at) || at <= 0) return null;
  return { sha, measuredAt: at };
}

/**
 * The workflow decision: measure unless the head is already recorded — in
 * the committed ledger or in the runner-local state file. The ledger names
 * the tree the numbers were taken on; the state file names the checkout head
 * a scheduled run already measured (`--record`). Either one provably naming
 * this head skips the run; anything else measures.
 *
 * @param {{ headSha?: unknown, recordedSha?: unknown, sidecarSha?: unknown }} input
 * @returns {boolean} true when the scheduled run must measure this tree
 */
export function decideMeasure({ headSha, recordedSha, sidecarSha }) {
  return !headAlreadyMeasured({ headSha, recordedSha })
    && !headAlreadyMeasured({ headSha, recordedSha: sidecarSha });
}

/**
 * Read this checkout's head, its recorded measurement and the runner-local
 * state file. Never throws: every failure mode resolves to "measure", the
 * conservative answer.
 *
 * @param {string} root repository root
 * @param {string} [stateFile] runner-local state file, defaults to the canonical path
 * @returns {{ headSha?: string, recordedSha?: string, sidecarSha?: string }}
 */
export function readGuardInput(root, stateFile = DEFAULT_STATE_FILE) {
  /** @type {{ headSha?: string, recordedSha?: string, sidecarSha?: string }} */
  const input = {};
  try {
    const run = spawnGit(['rev-parse', 'HEAD'], { cwd: root });
    const head = String(run.stdout ?? '').trim();
    if (run.status === 0 && head) input.headSha = head;
  } catch {
    // Fall through: no head means measure.
  }
  try {
    const ledger = JSON.parse(readFileSync(join(root, 'site', 'claims.json'), 'utf8'));
    const sha = ledger?.measuredAgainst?.sha;
    if (typeof sha === 'string' && sha) input.recordedSha = sha;
  } catch {
    // Fall through: no record means measure.
  }
  try {
    Object.assign(input, parseStateRecord(readFileSync(stateFile, 'utf8')));
  } catch {
    // Fall through: no state file (a fresh runner) means measure once.
  }
  return input;
}

/**
 * Record this checkout's head as successfully measured. Returns the recorded
 * head on success; on any failure the caller warns and stays green (see the
 * header) — returning the sha instead of re-reading the file keeps a racing
 * read from ever reddening a green measurement.
 *
 * @param {string} root repository root
 * @param {string} stateFile runner-local state file to write
 * @param {number} [nowMs] the recording clock
 * @returns {string | null} the recorded head, or null when not recorded
 */
export function recordMeasuredHead(root, stateFile, nowMs) {
  try {
    const run = spawnGit(['rev-parse', 'HEAD'], { cwd: root });
    const payload = recordStatePayload(String(run.stdout ?? '').trim(), nowMs);
    if (run.status !== 0 || payload === null) return null;
    mkdirSync(dirname(stateFile), { recursive: true });
    writeFileSync(stateFile, `${JSON.stringify(payload)}\n`);
    return payload.sha;
  } catch {
    return null;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const argv = process.argv.slice(2);
  const flag = (/** @type {string} */ name) => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  const root = String(flag('--root') ?? join(fileURLToPath(import.meta.url), '..', '..'));
  const stateFile = String(flag('--state-file') ?? DEFAULT_STATE_FILE);
  if (argv.includes('--record')) {
    const recorded = recordMeasuredHead(root, stateFile);
    if (recorded !== null) {
      process.stdout.write(`recorded ${recorded}\n`);
    } else {
      process.stdout.write(`::warning::ci-measure-guard: could not record the measured head in ${stateFile}; the next window measures again\n`);
    }
  } else {
    const input = readGuardInput(root, stateFile);
    process.stdout.write(`${decideMeasure(input) ? 'true' : 'false'}\n`);
  }
}
