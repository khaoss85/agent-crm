// @ts-check

/**
 * Produces the measurement record `site/claims.json` publishes.
 *
 * The record used to be hand-typed, and a hand-typed number is a number that is wrong
 * by the next merge: four public surfaces were quoting 373, 701 and 793 tests at the
 * same time. The count itself is not the problem — typing it is. So this runs the suite,
 * reads the numbers out of the run, and records them beside a fingerprint of the corpus
 * they were taken over, which is what `scripts/site-check.js` checks them against.
 *
 * It refuses to measure a dirty tree. A record names a commit; a run over uncommitted
 * edits describes something no reader can fetch.
 *
 *   node scripts/measure-suite.js            run and print the block
 *   node scripts/measure-suite.js --apply    run and write it into site/claims.json
 *
 * Exit codes: 0 measured, 1 the suite failed or the tree is dirty, 2 unusable input.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const root = process.cwd();
const claimsPath = join(root, 'site', 'claims.json');

for (const flag of new Set(process.argv.slice(2))) {
  if (flag !== '--apply') {
    process.stderr.write(`measure-suite: unknown flag ${flag}\n`);
    process.exit(2);
  }
}
const apply = process.argv.includes('--apply');

const git = (/** @type {string[]} */ args) => {
  const run = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return { status: run.status ?? 1, stdout: String(run.stdout ?? '').trim() };
};

const dirty = git(['status', '--porcelain']);
if (dirty.status !== 0) {
  process.stderr.write('measure-suite: this is not a git checkout, so there is no commit to measure against.\n');
  process.exit(2);
}
if (dirty.stdout) {
  process.stderr.write(
    'measure-suite: the working tree is dirty. A measurement record names a commit; measuring '
    + 'uncommitted edits records a tree nobody can fetch. Commit first, then measure.\n\n'
    + `${dirty.stdout}\n`,
  );
  process.exit(1);
}

const sha = git(['rev-parse', 'HEAD']).stdout;
const testsTree = git(['rev-parse', 'HEAD:tests']).stdout;
const testFiles = git(['ls-tree', '-r', '--name-only', 'HEAD', 'tests/']).stdout
  .split('\n')
  .filter((path) => path.endsWith('.test.js')).length;

const command = 'npm run verify';
process.stderr.write(`measure-suite: running \`${command}\` at ${sha.slice(0, 7)} over ${testFiles} test files…\n`);

const run = spawnSync('npm', ['run', 'verify'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;

const pass = lastNumber(output, /^[^\n]*\bpass\s+(\d+)\s*$/gm);
const fail = lastNumber(output, /^[^\n]*\bfail\s+(\d+)\s*$/gm);

if (pass === null || fail === null) {
  process.stderr.write('measure-suite: could not read pass/fail counts out of the run. The reporter changed; fix this parser rather than typing a number.\n');
  process.exit(1);
}
if (run.status !== 0 || fail !== 0) {
  process.stderr.write(`measure-suite: \`${command}\` exited ${run.status} with ${fail} failing. A claims ledger rests on a green run; nothing recorded.\n`);
  process.exit(1);
}

const record = {
  date: new Date().toISOString().slice(0, 10),
  sha: sha.slice(0, 7),
  command,
  tests: pass,
  failures: fail,
  testFiles,
  testsTree,
  note: 'Written by `node scripts/measure-suite.js --apply` from a real run on a clean tree. '
    + 'Never edit these numbers by hand: scripts/site-check.js verifies sha, testsTree and testFiles '
    + 'against the commit, so a record moved forward without a re-run fails the build.',
};

if (!apply) {
  process.stdout.write(`${JSON.stringify({ measuredAgainst: record }, null, 2)}\n`);
  process.stderr.write('measure-suite: nothing written. Re-run with --apply to update site/claims.json.\n');
  process.exit(0);
}

const source = readFileSync(claimsPath, 'utf8');
const ledger = JSON.parse(source);
ledger.measuredAgainst = record;
writeFileSync(claimsPath, `${JSON.stringify(ledger, null, 2)}\n`);
process.stdout.write(`site/claims.json measuredAgainst updated: ${pass} tests, 0 failing, at ${record.sha}.\n`);

/**
 * The last match wins: `npm run verify` runs two child processes and only the suite's
 * summary is the one being recorded.
 * @param {string} text
 * @param {RegExp} pattern
 */
function lastNumber(text, pattern) {
  let value = null;
  for (const match of text.matchAll(pattern)) value = Number(match[1]);
  return value;
}
