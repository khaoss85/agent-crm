// @ts-check

/**
 * Measurement-age signal for the push-triggered `public-claims` job
 * (backlog:911355123044).
 *
 * Between a merge and the next scheduled measurement the ledger still names
 * the older tree, and that must stay green: a push to `main` proves agreement
 * (`repo:truth -- --check`) but not freshness. Silence there would hide how
 * far behind the numbers are, so this step reports the measurement's age
 * where the run is already looking — as a `::notice::` while fresh, as a
 * `::warning::` once it outlives the configured measure window.
 *
 * Signal, never gate: the exit code is always 0, including when the ledger
 * is missing or unparsable (that prints a warning, not a failure). A stale
 * number is information for the next scheduled run, not a red push.
 *
 *   node scripts/ci-measurement-age.js [--root <dir>] [--window-hours <n>]
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { spawnGit } from './git-env.js';

/** The scheduled-measure window in `.github/workflows/ci.yml`. Keep the two equal. */
export const MEASURE_WINDOW_HOURS = 6;

/**
 * A duration in milliseconds as a short human span: `42m`, `5h 12m`, `19d 4h`.
 * Pure, so the annotation and its test cannot disagree.
 *
 * @param {number} ms non-negative duration
 * @returns {string} the span, or `unknown` when the input is unusable
 */
export function formatAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * The annotation line for one ledger reading. Pure: no filesystem, no clock.
 *
 * @param {{ sha?: unknown, tests?: unknown, atMs?: unknown }} record what names the measurement
 * @param {{ nowMs?: unknown, windowHours?: unknown }} options
 * @returns {{ annotation: 'notice' | 'warning', line: string }}
 */
export function describeMeasurementAge(record, options = {}) {
  const nowMs = typeof options.nowMs === 'number' ? options.nowMs : Date.now();
  const windowHours = Number(options.windowHours ?? MEASURE_WINDOW_HOURS);
  const windowMs = Number.isFinite(windowHours) && windowHours > 0
    ? windowHours * 3600000
    : MEASURE_WINDOW_HOURS * 3600000;
  const sha = typeof record.sha === 'string' && record.sha ? record.sha.slice(0, 7) : 'unknown';
  const tests = Number.isInteger(record.tests) ? `, ${record.tests} tests` : '';
  if (typeof record.atMs !== 'number' || !Number.isFinite(record.atMs)) {
    return {
      annotation: 'warning',
      line: `no dated measurement: ledger names ${sha}${tests}, age unknown`,
    };
  }
  const ageMs = nowMs - record.atMs;
  const age = formatAge(ageMs);
  if (ageMs > windowMs) {
    return {
      annotation: 'warning',
      line: `measurement ${sha}${tests} is ${age} old, past the ${windowHours}h measure window: the next scheduled run re-measures`,
    };
  }
  return {
    annotation: 'notice',
    line: `measurement ${sha}${tests} is ${age} old, inside the ${windowHours}h measure window`,
  };
}

/**
 * When the recorded measurement was taken, precisely. Prefers the measured
 * commit's committer date from git (the ledger only carries a day), and falls
 * back to the ledger date at UTC midnight. Never throws: null means unknown.
 *
 * @param {string} root repository root
 * @param {unknown} recordedSha the ledger's measuredAgainst.sha
 * @param {unknown} ledgerDate the ledger's measuredAgainst.date
 * @returns {number | null} epoch milliseconds, or null when unknowable
 */
export function resolveMeasuredAtMs(root, recordedSha, ledgerDate) {
  if (typeof recordedSha === 'string' && /^[0-9a-f]{7,40}$/.test(recordedSha.trim())) {
    try {
      const run = spawnGit(['log', '-1', '--format=%cI', recordedSha.trim()], { cwd: root });
      const parsed = Date.parse(String(run.stdout ?? '').trim());
      if (run.status === 0 && Number.isFinite(parsed)) return parsed;
    } catch {
      // Fall through to the ledger date.
    }
  }
  if (typeof ledgerDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(ledgerDate)) {
    const parsed = Date.parse(`${ledgerDate}T00:00:00Z`);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const argv = process.argv.slice(2);
  const flag = (/** @type {string} */ name) => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  const root = String(flag('--root') ?? join(fileURLToPath(import.meta.url), '..', '..'));
  const windowArg = Number(flag('--window-hours') ?? MEASURE_WINDOW_HOURS);
  /** @type {{ sha?: unknown, tests?: unknown, atMs?: unknown }} */
  let record = {};
  try {
    const ledger = JSON.parse(readFileSync(join(root, 'site', 'claims.json'), 'utf8'));
    const measured = ledger?.measuredAgainst ?? {};
    record = {
      sha: measured.sha,
      tests: measured.tests,
      atMs: resolveMeasuredAtMs(root, measured.sha, measured.date),
    };
  } catch {
    record = {};
  }
  const windowHours = Number.isFinite(windowArg) && windowArg > 0 ? windowArg : MEASURE_WINDOW_HOURS;
  const { annotation, line } = describeMeasurementAge(record, { windowHours });
  process.stdout.write(`::${annotation}::${line}\n`);
}
