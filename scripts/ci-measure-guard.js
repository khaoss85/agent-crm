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
 *   node scripts/ci-measure-guard.js [--root <dir>]
 *
 * Prints `true` when the tree must be measured, `false` when the committed
 * `site/claims.json` already names this head. The direction is conservative:
 * anything unreadable, unparsable or unrecognised answers `true` — a skipped
 * measurement the tree needed would leave stale claims behind with only a
 * warning (the push-time `public-claims` job signals age, it does not gate),
 * while a redundant measurement costs at most one run inside its window.
 * Exit code is always 0 for the same reason: doubt measures, never skips.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { spawnGit } from './git-env.js';

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
 * The workflow decision: measure unless the head is already recorded.
 *
 * @param {{ headSha?: unknown, recordedSha?: unknown }} input
 * @returns {boolean} true when the scheduled run must measure this tree
 */
export function decideMeasure({ headSha, recordedSha }) {
  return !headAlreadyMeasured({ headSha, recordedSha });
}

/**
 * Read this checkout's head and its recorded measurement. Never throws:
 * every failure mode resolves to "measure", the conservative answer.
 *
 * @param {string} root repository root
 * @returns {{ headSha?: string, recordedSha?: string }}
 */
export function readGuardInput(root) {
  /** @type {{ headSha?: string, recordedSha?: string }} */
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
  return input;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const argv = process.argv.slice(2);
  const rootIndex = argv.indexOf('--root');
  const root = rootIndex === -1
    ? join(fileURLToPath(import.meta.url), '..', '..')
    : String(argv[rootIndex + 1] ?? '.');
  const input = readGuardInput(root);
  process.stdout.write(`${decideMeasure(input) ? 'true' : 'false'}\n`);
}
