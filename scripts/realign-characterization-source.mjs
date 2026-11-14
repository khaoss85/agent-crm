#!/usr/bin/env node
// @ts-check

/**
 * Realign the source hashes of the characterization baselines — and nothing else.
 *
 *   npm run characterize:realign-source               rewrite the stale `source` maps
 *   npm run characterize:realign-source -- --dry-run  name the drifted files, write nothing
 *
 * Since backlog:e0347551 (#850) the `source` map of each
 * `tests/characterization/*-baseline.json` is advisory: a PR that edits a
 * digested file without moving any observed value stays green, warns
 * `CHARACTERIZATION_DRIFT_ADVISORY`, and regenerates nothing — so two such PRs
 * never conflict on hash lines. The hashes then lag `main` until someone
 * realigns them. This is that step (backlog:e03475513020):
 *
 * - it rewrites ONLY the `source` map, with the digests the domain runner's own
 *   `sourceFingerprints` computes (the same function `generateBaseline` uses),
 *   so the file is byte-identical to a full `npm run characterize:*` on a tree
 *   whose behaviour did not move — observations, counts and `fingerprint` are
 *   left exactly as they are;
 * - it boots nothing and runs no case: whether behaviour moved is decided by
 *   the gate of the PR that carries the realignment. A changed
 *   `*-baseline.json` selects its characterization suite in the fast gate
 *   (`CHARACTERIZATION_SUITES`, scripts/ci-touched-tests.js), and that suite
 *   still compares every observed value in full;
 * - it never commits, pushes or opens anything. On `main` after merges, the
 *   procedure is a normal PR (docs/QUALITY_GATES.md §6.2):
 *     git switch -c chore/characterization-realign origin/main
 *     npm run characterize:realign-source
 *     git commit -am 'chore(characterization): realign source hashes'
 *     gh pr create ...
 *   and the PR merges through its gate like any other. Never a push to `main`;
 * - a digest the runner reports `absent` (a `SOURCE_FILES` entry that names a
 *   file this tree does not have) is refused, not written: the suite asserts no
 *   digest is absent, so writing one would only move the failure.
 *
 * Exit codes: 0 aligned, realigned, or a dry run; 1 refused (an absent source);
 * 2 unusable input.
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { sortKeysDeep } from '../tests/characterization/characterization-contract.mjs';
import { driftedSourceFiles } from '../tests/characterization/source-drift.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * Every characterization baseline with a `source` map, and the runner whose
 * `sourceFingerprints(rootDir)` produced it. Kept equal to the baselines of
 * `CHARACTERIZATION_SUITES` by tests/characterization/realign-source.test.js,
 * so a new baseline cannot be forgotten here.
 */
export const CHARACTERIZATION_BASELINES = Object.freeze([
  Object.freeze({ baseline: 'tests/characterization/commercial-baseline.json', runner: '../tests/characterization/run-commercial-characterization.mjs' }),
  Object.freeze({ baseline: 'tests/characterization/intelligence-baseline.json', runner: '../tests/characterization/run-intelligence-characterization.mjs' }),
  Object.freeze({ baseline: 'tests/characterization/signature-baseline.json', runner: '../tests/characterization/run-signature-characterization.mjs' }),
]);

/**
 * The checked-in serialization of every `characterize-*.mjs`: sorted keys,
 * two-space indent, one final newline.
 *
 * @param {any} baseline
 */
export function serializeBaseline(baseline) {
  return `${JSON.stringify(sortKeysDeep(baseline), null, 2)}\n`;
}

/**
 * Pure: the baseline with only its `source` map replaced by `current`.
 *
 * @param {any} baseline the checked-in document
 * @param {Record<string, string>} current fresh `sourceFingerprints()` of the same domain
 * @returns {{ok: boolean, absent: string[], drifted: string[], baseline: any}}
 */
export function realignSource(baseline, current) {
  const absent = Object.entries(current ?? {})
    .filter(([, digest]) => digest === 'absent').map(([file]) => file).sort();
  if (absent.length > 0) return { ok: false, absent, drifted: [], baseline };
  const drifted = driftedSourceFiles(baseline?.source, current);
  if (drifted.length === 0) return { ok: true, absent: [], drifted, baseline };
  return { ok: true, absent: [], drifted, baseline: { ...baseline, source: { ...current } } };
}

/**
 * The runner's own fingerprints for a baseline entry.
 *
 * @param {{runner: string}} entry
 * @param {string} rootDir
 * @returns {Promise<Record<string, string>>}
 */
async function runnerFingerprints(entry, rootDir) {
  const runner = await import(new URL(entry.runner, import.meta.url).href);
  return runner.sourceFingerprints(rootDir);
}

/**
 * Realign every baseline under `rootDir`. Writes through a staged rename, so
 * an interrupted run never leaves a truncated baseline behind; a refused
 * domain writes nothing at all (every domain is decided before any write).
 *
 * @param {{rootDir?: string, dryRun?: boolean,
 *   baselines?: ReadonlyArray<{baseline: string, runner: string}>,
 *   fingerprints?: (entry: {baseline: string, runner: string}, rootDir: string) => Promise<Record<string, string>>}} [options]
 */
export async function realignAll({
  rootDir = repoRoot, dryRun = false, baselines = CHARACTERIZATION_BASELINES, fingerprints = runnerFingerprints,
} = {}) {
  const decided = [];
  for (const entry of baselines) {
    const path = join(rootDir, entry.baseline);
    const before = readFileSync(path, 'utf8');
    const { ok, absent, drifted, baseline: document } = realignSource(
      JSON.parse(before), await fingerprints(entry, rootDir),
    );
    decided.push({ baseline: entry.baseline, path, before, ok, absent, drifted, document });
  }
  const refused = decided.filter((row) => !row.ok);
  const report = decided.map(({ baseline, ok, absent, drifted }) => ({ baseline, ok, absent, drifted }));
  if (refused.length > 0) return { ok: false, written: [], report };
  const written = [];
  for (const row of decided) {
    if (dryRun || row.drifted.length === 0) continue;
    const after = serializeBaseline(row.document);
    if (after === row.before) continue;
    const staging = `${row.path}.writing`;
    writeFileSync(staging, after);
    renameSync(staging, row.path);
    written.push(row.baseline);
  }
  return { ok: true, written, report };
}

async function main() {
  const argv = process.argv.slice(2);
  const unknown = argv.filter((flag) => flag !== '--dry-run');
  if (unknown.length > 0) {
    process.stderr.write(`realign-characterization-source: unknown argument ${unknown.join(' ')}. `
      + 'Usage: node scripts/realign-characterization-source.mjs [--dry-run]\n');
    process.exit(2);
  }
  const dryRun = argv.includes('--dry-run');
  const { ok, written, report } = await realignAll({ dryRun });
  for (const row of report) {
    if (!row.ok) {
      process.stderr.write(`realign-characterization-source: ${row.baseline} refused — the runner reports `
        + `no file for ${row.absent.join(', ')}. Fix SOURCE_FILES in its harness; nothing was written.\n`);
      continue;
    }
    const state = row.drifted.length === 0 ? 'aligned' : `${row.drifted.length} drifted`;
    process.stdout.write(`${row.baseline}: ${state}\n`);
    for (const file of row.drifted) process.stdout.write(`  drifted ${file}\n`);
  }
  if (!ok) process.exit(1);
  if (dryRun) {
    process.stdout.write('Dry run: nothing written.\n');
  } else if (written.length === 0) {
    process.stdout.write('Every source map is current: nothing written.\n');
  } else {
    process.stdout.write([
      `Rewrote the source map of ${written.length} baseline(s); observations and fingerprints are untouched.`,
      'Commit it on a branch from main and open a normal PR: its gate runs the characterization',
      'suite of every changed baseline. Never push it to main directly.',
      '',
    ].join('\n'));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`realign-characterization-source: ${error?.stack ?? error}\n`);
    process.exit(2);
  });
}
