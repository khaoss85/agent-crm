// @ts-check

/**
 * Re-anchor `site/claims.json` at the measurement the CI `verify` job just
 * produced on this same tree — no local `measure-suite --apply` run needed.
 *
 *   node scripts/apply-ci-measurement.js <measurement.json>
 *
 * `<measurement.json>` is the `claims-measurement-<sha>` artifact `verify`
 * uploads: `{ measuredAgainst: { sha, tests, failures, testFiles, testsTree,
 * files, ... } }`, measured by `measure-suite.js` from a real green
 * `npm run verify` on a clean tree. This script binds that record to THIS
 * checkout before writing anything:
 *
 * - the tree must be clean (a record names a commit, never uncommitted edits);
 * - the record must name HEAD (a short prefix is accepted, as recorded);
 * - `HEAD:tests` must equal the recorded `testsTree` (the corpus the run was
 *   taken over — same checkout ref, same run, so equal by construction);
 * - the record must come from a green run (`failures` 0, positive counts).
 *
 * Anything else refuses with the reason, and `site/claims.json` is left
 * untouched. The deeper fact checks (command plausibility, per-file map
 * reconciliation, citations) stay where they belong: `repo:truth --check
 * --require-current` runs right after this in the `public-claims` job, on a
 * freshly regenerated `docs/repository-truth.json`. A missing or failed CI
 * measurement therefore fails the job red instead of passing quietly.
 *
 * Exit codes: 0 applied, 1 the record does not describe this tree, 2 unusable
 * input (missing file, unparsable JSON, wrong shape, no git checkout).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const claimsPath = (/** @type {string} */ root) => join(root, 'site', 'claims.json');

/**
 * @param {string[]} args
 * @param {string} cwd
 */
const git = (args, cwd) => {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { status: run.status ?? 1, stdout: String(run.stdout ?? '').trim() };
};

/**
 * Why this record may not be applied, or null when its shape is sound. Pure:
 * no filesystem, no git. The tree binding (HEAD, testsTree) is checked by
 * the caller, against live git, because a stubbed answer there would prove
 * nothing.
 *
 * @param {any} record the artifact's `measuredAgainst` block
 * @returns {string | null} the refusal reason, or null when applicable
 */
export function validateArtifactRecord(record) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    return 'the artifact carries no measuredAgainst record object.';
  }
  if (!/^[0-9a-f]{7,40}$/.test(String(record.sha ?? ''))) {
    return `measuredAgainst.sha ${JSON.stringify(record.sha ?? null)} is not a commit SHA.`;
  }
  if (!Number.isInteger(record.tests) || record.tests <= 0) {
    return `measuredAgainst.tests ${JSON.stringify(record.tests ?? null)} is not a positive whole number, so no run produced it.`;
  }
  if (record.failures !== 0) {
    return `measuredAgainst.failures is ${JSON.stringify(record.failures ?? null)}. A claims ledger rests on a green run.`;
  }
  if (!Number.isInteger(record.testFiles) || record.testFiles < 0) {
    return `measuredAgainst.testFiles ${JSON.stringify(record.testFiles ?? null)} is not a whole number.`;
  }
  if (!/^[0-9a-f]{40}$/.test(String(record.testsTree ?? ''))) {
    return 'measuredAgainst.testsTree is not a git tree id, so the corpus the run was taken over cannot be checked.';
  }
  if (record.files !== undefined && (record.files === null || typeof record.files !== 'object' || Array.isArray(record.files))) {
    return 'measuredAgainst.files is not a map of test files to counts.';
  }
  return null;
}

function main() {
  const root = process.cwd();
  const [artifactPath] = process.argv.slice(2);
  if (!artifactPath || process.argv.length !== 3) {
    process.stderr.write('apply-ci-measurement: usage: node scripts/apply-ci-measurement.js <measurement.json>\n');
    process.exit(2);
  }

  let artifact;
  try {
    artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
  } catch (error) {
    process.stderr.write(`apply-ci-measurement: cannot read ${artifactPath}: ${/** @type {any} */ (error)?.message ?? error}\n`);
    process.exit(2);
  }
  const refusal = validateArtifactRecord(artifact?.measuredAgainst);
  if (refusal) {
    process.stderr.write(`apply-ci-measurement: refusing the CI record: ${refusal} Nothing was changed.\n`);
    process.exit(2);
  }
  const record = artifact.measuredAgainst;

  const head = git(['rev-parse', 'HEAD'], root);
  if (head.status !== 0 || !head.stdout) {
    process.stderr.write('apply-ci-measurement: this is not a git checkout, so the record cannot be bound to a tree. Nothing was changed.\n');
    process.exit(2);
  }
  if (!head.stdout.startsWith(record.sha)) {
    process.stderr.write(
      `apply-ci-measurement: the CI record was measured at ${record.sha}, but this checkout is at ${head.stdout.slice(0, 12)}. `
      + 'A record only ever describes the tree it was taken over. Nothing was changed.\n',
    );
    process.exit(1);
  }
  const dirty = git(['status', '--porcelain'], root);
  if (dirty.status !== 0) {
    process.stderr.write('apply-ci-measurement: this is not a git checkout. Nothing was changed.\n');
    process.exit(2);
  }
  if (dirty.stdout) {
    process.stderr.write(
      'apply-ci-measurement: the working tree is dirty. A measurement record names a commit; applying it over '
      + `uncommitted edits would describe a tree nobody can fetch. Commit first.\n\n${dirty.stdout}\n`,
    );
    process.exit(1);
  }
  const tree = git(['rev-parse', 'HEAD:tests'], root);
  if (tree.status !== 0 || !tree.stdout) {
    process.stderr.write('apply-ci-measurement: this tree has no tests/ to bind the record against. Nothing was changed.\n');
    process.exit(1);
  }
  if (tree.stdout !== record.testsTree) {
    process.stderr.write(
      `apply-ci-measurement: tests/ moved under the measurement (recorded ${record.testsTree.slice(0, 12)}, `
      + `HEAD holds ${tree.stdout.slice(0, 12)}). The record no longer describes this tree. Nothing was changed.\n`,
    );
    process.exit(1);
  }

  let ledger;
  try {
    ledger = JSON.parse(readFileSync(claimsPath(root), 'utf8'));
  } catch (error) {
    process.stderr.write(`apply-ci-measurement: site/claims.json cannot be read: ${/** @type {any} */ (error)?.message ?? error}\n`);
    process.exit(2);
  }
  ledger.measuredAgainst = record;
  writeFileSync(claimsPath(root), `${JSON.stringify(ledger, null, 2)}\n`);
  process.stdout.write(
    `site/claims.json measuredAgainst re-anchored at the CI record: ${record.tests} tests, 0 failing, at ${record.sha}.\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`apply-ci-measurement: ${/** @type {any} */ (error)?.stack ?? error}\n`);
    process.exit(2);
  }
}
