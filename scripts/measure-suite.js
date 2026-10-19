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
 *   node scripts/measure-suite.js --refresh  re-anchor the record at HEAD without
 *                                            a full re-run (see below)
 *   node scripts/measure-suite.js --shard <i>/<n> --out <file>
 *                                            run only piece i of n and write its
 *                                            green report to <file> (see below)
 *   node scripts/measure-suite.js --combine <shard-file>... [--apply]
 *                                            join the n piece reports into the
 *                                            block, or refuse when a piece is
 *                                            missing, red, or off-corpus
 *   node scripts/measure-suite.js --plan <n>  print which files each of the n
 *                                            pieces would run (no tests run)
 *
 * Exit codes: 0 measured, 1 the suite failed or the tree is dirty, 2 unusable input.
 *
 * ## Why pieces (`--shard` / `--combine`) exist
 *
 * A full measurement used to run the whole `npm run verify` (~25-40 minutes)
 * under ONE machine-lock acquisition, and on the shared Mac that one hold
 * queued every other factory's heavy step behind it (backlog:9fff957f3968).
 * Priority orders the queue, not the length of a running job: while the
 * measure runs, nothing else may start. So `npm run measure`
 * (`scripts/measure-pieces.sh`) runs the corpus in `MEASURE_SHARDS` pieces
 * (default 6), each piece under its OWN heavy-job acquisition with its OWN
 * declared maximum: the lock is free between two pieces, and a piece past
 * its maximum fails red instead of holding the machine. The combine step
 * runs no tests and takes no lock.
 *
 * Pieces are dealt round-robin over the HEAD-sorted `*.test.js` list, so no
 * hand-maintained file list can rot: the combine refuses unless the pieces'
 * union is exactly the corpus at the measured commit — same files, none
 * lost, none doubled — and every piece green. A red piece writes no report,
 * and a missing report refuses the combine: one red piece reddens the whole
 * measure, exactly as a red file reddens the monolith.
 *
 * ## Why `--refresh` exists
 *
 * A full measurement takes the whole `npm run verify` (~25 minutes) plus its own
 * verification, and the ledger calls a record current only while HEAD's tests/
 * tree is byte-identical to the measured one. On a repository where anyone
 * works, a tests/ merge landing inside that window makes the fresh measurement
 * stale on arrival — the re-measure race of backlog:79405f9df589, lost fifteen
 * times in a row. The way out is not a faster full run but a smaller one.
 *
 * `--apply` records the same run's machine summaries beside its total: which `*.test.js`
 * file contributed how many passing tests. `--refresh` diffs the recorded
 * tests/ tree against HEAD's, runs ONLY the added and changed test files,
 * requires them green, and carries every untouched file's contribution
 * forward exactly. A one-file reword that changes no count re-anchors in
 * about a minute, and concurrent merges do not invalidate the run: the
 * refresh chases the tip, extending its file set while HEAD keeps moving,
 * and refuses honestly when the tip outruns it instead of recording a guess.
 *
 * What `--refresh` refuses, and why:
 *
 * - a record without a per-file map (every record written before the map
 *   existed): there is nothing exact to carry, so run `--apply` once;
 * - any change under tests/ that is not an added, changed or removed
 *   `*.test.js` file (helpers, fixtures, snapshots): the blast radius of a
 *   helper edit is unknowable without running its importers, so only a full
 *   run may speak for the new tree;
 * - inputs outside tests/, except a ledger-only measuredAgainst update: even
 *   unchanged tests can change outcome when the source or their inputs change;
 * - a recorded commit that is not an ancestor of HEAD: the lineage is broken
 *   and no diff can bridge it;
 * - a red targeted run, or a per-file count that does not reconcile: carried
 *   arithmetic rests on green runs, same as the full record.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { spawnGit } from './git-env.js';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MeasurementError, assertMeasurementUnchanged, parseMeasurementReport } from './measurement-report.js';

const root = process.cwd();
const claimsPath = join(root, 'site', 'claims.json');

const git = (/** @type {string[]} */ args) => {
  const run = spawnGit(args, { cwd: root });
  return { status: run.status ?? 1, stdout: String(run.stdout ?? '').trim() };
};

async function main() {
  const { flags, values, positionals } = parseArgs(process.argv.slice(2));
  const apply = flags.has('--apply');
  const refresh = flags.has('--refresh');
  const shard = values.get('--shard');
  const out = values.get('--out');
  const combine = flags.has('--combine');
  const plan = values.get('--plan');
  if (apply && refresh) {
    process.stderr.write('measure-suite: --apply and --refresh cannot be combined: one measures the whole suite, the other carries a record forward.\n');
    process.exit(2);
  }
  if (shard !== undefined && (apply || refresh || combine || plan !== undefined || positionals.length > 0)) {
    process.stderr.write('measure-suite: --shard runs one piece and takes only --out beside it.\n');
    process.exit(2);
  }
  if (shard !== undefined && out === undefined) {
    process.stderr.write('measure-suite: --shard needs --out <file>: a red piece writes nothing, a green piece writes its report there.\n');
    process.exit(2);
  }
  if (plan !== undefined && (apply || refresh || combine || shard !== undefined || out !== undefined || positionals.length > 0)) {
    process.stderr.write('measure-suite: --plan prints the dealing and takes no other flag.\n');
    process.exit(2);
  }
  if (combine && (refresh || shard !== undefined || plan !== undefined || out !== undefined)) {
    process.stderr.write('measure-suite: --combine takes only shard files and --apply beside it.\n');
    process.exit(2);
  }
  if (!combine && positionals.length > 0) {
    process.stderr.write(`measure-suite: unexpected argument ${JSON.stringify(positionals[0])}: shard files belong to --combine.\n`);
    process.exit(2);
  }
  if (out !== undefined && shard === undefined) {
    process.stderr.write('measure-suite: --out belongs to --shard.\n');
    process.exit(2);
  }

  if (plan !== undefined) {
    printPlan(plan);
    return;
  }

  if (shard !== undefined) {
    runShard(shard, /** @type {string} */ (out));
    return;
  }

  if (combine) {
    combineReports(positionals, apply);
    return;
  }

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

  if (refresh) {
    refreshRecord();
    return;
  }

  const sha = git(['rev-parse', 'HEAD']).stdout;
  const testsTree = git(['rev-parse', 'HEAD:tests']).stdout;
  const testFiles = git(['ls-tree', '-r', '--name-only', 'HEAD', 'tests/']).stdout
    .split('\n')
    .filter((path) => path.endsWith('.test.js'));

  const command = 'npm run verify';
  process.stderr.write(`measure-suite: running \`${command}\` at ${sha.slice(0, 7)} over ${testFiles.length} test files…\n`);

  // npm forwards the first `--` to verify; the next makes its final npm test
  // forward reporter arguments to node. The checked-in verify still runs check
  // AND the suite, once. A script that stops forwarding refuses (no receipt).
  const scratch = mkdtempSync(join(tmpdir(), 'accordo-measure-'));
  let measured;
  try {
    const reportPath = join(scratch, 'summary.jsonl');
    const reporter = fileURLToPath(new URL('./measurement-reporter.js', import.meta.url));
    const run = spawnSync('npm', ['run', 'verify', '--', '--',
      `--test-reporter=${reporter}`, '--test-reporter-destination=stdout',
      `--test-reporter-destination=${reportPath}`], {
      cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: standaloneEnv(),
    });
    if (run.status !== 0 || run.error || run.signal) {
      // Synchronous, all of it: an async write of the suite's stdout is cut when
      // the process exits right after, and the failing test's line is exactly the
      // part that went missing (2026-10-16, run 38976039643: ~700 of ~2400 lines).
      writeAllSync(2, `${run.stdout ?? ''}\n${run.stderr ?? ''}\n`);
      const failing = failingTestLines(run.stdout ?? '');
      if (failing.length > 0) writeAllSync(2, `measure-suite: failing tests:\n${failing.join('\n')}\n`);
      // Synchronous: this diagnosis must reach the log even though the process
      // exits right after. The async write it replaces lost this exact line on
      // CI, leaving a truncated mid-line dump and exit 1 with no named cause.
      writeSync(2, `${formatVerifyFailure(run)}\n`);
      throw new MeasurementError(formatVerifyFailure(run));
    }
    measured = parseMeasurementReport(readFileSync(reportPath, 'utf8'), root, testFiles);
    assertMeasurementUnchanged(git, sha);
  } catch (error) {
    throw new MeasurementError(error.message);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const { pass, fail, files } = measured;

  const record = {
    date: new Date().toISOString().slice(0, 10),
    sha: sha.slice(0, 7),
    command,
    tests: pass,
    failures: fail,
    testFiles: testFiles.length,
    testsTree,
    files,
    note: 'Written by `node scripts/measure-suite.js --apply` from a real run on a clean tree. '
      + 'Never edit these numbers by hand: scripts/site-check.js verifies sha, testsTree, testFiles '
      + 'and the per-file map against the commit, so a record moved forward without a re-run fails the build.',
  };

  if (!apply) {
    process.stdout.write(`${JSON.stringify({ measuredAgainst: record }, null, 2)}\n`);
    process.stderr.write('measure-suite: nothing written. Re-run with --apply to update site/claims.json.\n');
    return;
  }

  assertMeasurementUnchanged(git, sha);
  const source = readFileSync(claimsPath, 'utf8');
  const ledger = JSON.parse(source);
  ledger.measuredAgainst = record;
  writeFileSync(claimsPath, `${JSON.stringify(ledger, null, 2)}\n`);
  process.stdout.write(`site/claims.json measuredAgainst updated: ${pass} tests, 0 failing, at ${record.sha}.\n`);
}

/**
 * The one test file whose own run dominates a piece: with
 * `ACCORDO_FULL_SHELL_ORACLE=1` (the CI measurement) its oracle driver alone
 * takes ~13-20 minutes against its own 40-minute budget, while the other
 * ~250 files share the remaining ~25. `scripts/measure-pieces.sh` gives the
 * piece holding this file the oracle maximum (1800 s) and every other piece
 * the normal maximum (600 s). If this file is renamed, no piece is marked
 * heavy and the holding piece fails red past 600 s instead of silently
 * measuring less: the constant is then updated, not the corpus.
 */
export const HEAVY_MEASURE_FILE = 'tests/agent-tool-selection-prompts.test.js';

/** The `npm run <script>` name a piecemeal measurement record carries. */
export const MEASURE_COMMAND = 'npm run measure';

/**
 * Split `process.argv` into bare flags, valued options (`--shard`, `--out`,
 * `--plan` take the next word) and positionals. Unknown flags and a missing
 * option value refuse here with exit 2, before any git or test runs.
 *
 * @param {string[]} argv words after the script name
 */
function parseArgs(argv) {
  /** @type {Set<string>} */
  const flags = new Set();
  /** @type {Map<string, string>} */
  const values = new Map();
  /** @type {string[]} */
  const positionals = [];
  const valued = new Set(['--shard', '--out', '--plan']);
  for (let i = 0; i < argv.length; i += 1) {
    const word = argv[i] ?? '';
    if (valued.has(word)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        process.stderr.write(`measure-suite: ${word} needs a value.\n`);
        process.exit(2);
      }
      if (values.has(word)) {
        process.stderr.write(`measure-suite: ${word} given twice.\n`);
        process.exit(2);
      }
      values.set(word, value);
      i += 1;
    } else if (word === '--apply' || word === '--refresh' || word === '--combine') {
      flags.add(word);
    } else if (word.startsWith('--')) {
      process.stderr.write(`measure-suite: unknown flag ${word}\n`);
      process.exit(2);
    } else {
      positionals.push(word);
    }
  }
  return { flags, values, positionals };
}

/**
 * Parse `i/n` into a 1-based piece index and a piece count. Refuses with
 * exit 2: a piece nobody can place would measure the wrong corpus.
 *
 * @param {string} text the `--shard` or `--plan` value
 * @param {string} flag which flag it came from, for the message
 * @returns {{ index: number, total: number }}
 */
function parsePieceCount(text, flag) {
  const match = /^(\d+)\/(\d+)$/.exec(text);
  const index = match ? Number(match[1]) : NaN;
  const total = match ? Number(match[2]) : NaN;
  if (!match || !Number.isSafeInteger(index) || !Number.isSafeInteger(total) || index < 1 || total < 1 || index > total) {
    process.stderr.write(`measure-suite: ${flag} needs <i>/<n> with 1 <= i <= n, got ${JSON.stringify(text)}.\n`);
    process.exit(2);
  }
  return { index: /** @type {number} */ (index), total: /** @type {number} */ (total) };
}

/**
 * Deal files round-robin over pieces: file j (0-based, sorted order) runs in
 * piece (j % total) + 1. Round-robin, not contiguous slices: the slow files
 * cluster by name (the tool-selection corpus, the characterization suites),
 * and contiguous slices would pile a whole cluster into one piece. Sorting
 * inside keeps the dealing independent of listing order. Throws when the
 * piece would run nothing: `node --test` with no file arguments discovers
 * the whole suite, which would measure every file into one piece's report.
 *
 * @param {string[]} files repo-relative test paths
 * @param {number} index 1-based piece to deal
 * @param {number} total piece count
 * @returns {string[]} the piece's files, in sorted order
 */
export function shardTestFiles(files, index, total) {
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(total) || index < 1 || total < 1 || index > total) {
    throw new MeasurementError(`shardTestFiles: need 1 <= index <= total, got ${index}/${total}.`);
  }
  const sorted = [...new Set(files)].sort();
  const piece = sorted.filter((_, j) => (j % total) + 1 === index);
  if (piece.length === 0) {
    throw new MeasurementError(
      `shardTestFiles: piece ${index} of ${total} holds no file over ${sorted.length} files — use fewer pieces.`,
    );
  }
  return piece;
}

/**
 * The whole dealing: one sorted file list per piece, each marked when it
 * holds the oracle file that needs the long maximum (see
 * HEAVY_MEASURE_FILE). Pure, so `--plan` and the tests drive the same
 * dealing the pieces run.
 *
 * @param {string[]} files repo-relative test paths
 * @param {number} total piece count
 * @returns {Array<{ shard: number, files: string[], heavy: boolean }>}
 */
export function planShards(files, total) {
  if (!Number.isSafeInteger(total) || total < 1) {
    throw new MeasurementError(`planShards: need at least one piece, got ${total}.`);
  }
  return Array.from({ length: total }, (_, k) => {
    const piece = shardTestFiles(files, k + 1, total);
    return { shard: k + 1, files: piece, heavy: piece.includes(HEAVY_MEASURE_FILE) };
  });
}

/**
 * Print the dealing for `--plan <i/n>`: commit, corpus fingerprint, and each
 * piece's files with its heavy mark. Runs no tests.
 *
 * @param {string} text the `--plan` value
 */
function printPlan(text) {
  if (!/^\d+$/.test(text) || Number(text) < 1) {
    process.stderr.write(`measure-suite: --plan needs a piece count of at least 1, got ${JSON.stringify(text)}.\n`);
    process.exit(2);
  }
  const total = Number(text);
  const sha = git(['rev-parse', 'HEAD']).stdout;
  const testsTree = git(['rev-parse', 'HEAD:tests']).stdout;
  const testFiles = git(['ls-tree', '-r', '--name-only', 'HEAD', 'tests/']).stdout
    .split('\n')
    .filter((path) => path.endsWith('.test.js'));
  process.stdout.write(`${JSON.stringify({ sha, testsTree, shards: total, pieces: planShards(testFiles, total) }, null, 2)}\n`);
}

/**
 * Run one piece: the same `node --test` flags as `npm test`
 * (`--test-concurrency=2`, proven on the shared runner), restricted to the
 * piece's explicit file list, with the measurement reporter writing the
 * machine summary beside stdout. A red piece, an unparsable report, or a
 * HEAD that moved mid-piece writes NOTHING and exits 1: the combine then
 * finds no report and refuses, so one red piece reddens the whole measure.
 *
 * @param {string} text the `--shard` value
 * @param {string} outPath where the green piece report is written
 */
function runShard(text, outPath) {
  const { index, total } = parsePieceCount(text, '--shard');
  const sha = git(['rev-parse', 'HEAD']).stdout;
  const testsTree = git(['rev-parse', 'HEAD:tests']).stdout;
  const testFiles = git(['ls-tree', '-r', '--name-only', 'HEAD', 'tests/']).stdout
    .split('\n')
    .filter((path) => path.endsWith('.test.js'));
  let piece;
  try {
    piece = shardTestFiles(testFiles, index, total);
  } catch (error) {
    process.stderr.write(`measure-suite: ${/** @type {Error} */ (error).message}\n`);
    process.exit(2);
  }
  const dirty = git(['status', '--porcelain']);
  if (dirty.status !== 0) {
    process.stderr.write('measure-suite: this is not a git checkout, so there is no commit to measure against.\n');
    process.exit(2);
  }
  if (dirty.stdout) {
    process.stderr.write(
      'measure-suite: the working tree is dirty. A measurement record names a commit; measuring '
      + `uncommitted edits records a tree nobody can fetch. Commit first, then measure.\n\n${dirty.stdout}\n`,
    );
    process.exit(1);
  }
  process.stderr.write(`measure-suite: running piece ${index} of ${total} at ${sha.slice(0, 7)} over ${piece.length} test files…\n`);

  const scratch = mkdtempSync(join(tmpdir(), 'accordo-measure-'));
  try {
    const reportPath = join(scratch, 'summary.jsonl');
    const reporter = fileURLToPath(new URL('./measurement-reporter.js', import.meta.url));
    const run = spawnSync(process.execPath,
      ['--no-warnings', '--test', '--test-concurrency=2', `--test-reporter=${reporter}`,
        '--test-reporter-destination=stdout', `--test-reporter-destination=${reportPath}`, ...piece], {
        cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: standaloneEnv(),
      });
    if (run.status !== 0 || run.error || run.signal) {
      writeAllSync(2, `${run.stdout ?? ''}\n${run.stderr ?? ''}\n`);
      const failing = failingTestLines(run.stdout ?? '');
      if (failing.length > 0) writeAllSync(2, `measure-suite: failing tests:\n${failing.join('\n')}\n`);
      writeSync(2, `${formatVerifyFailure(run)}\n`);
      throw new MeasurementError(formatVerifyFailure(run));
    }
    const measured = parseMeasurementReport(readFileSync(reportPath, 'utf8'), root, piece);
    assertMeasurementUnchanged(git, sha);
    const report = {
      shard: index,
      shards: total,
      sha,
      testsTree,
      tests: measured.pass,
      failures: measured.fail,
      files: measured.files,
    };
    writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
    process.stderr.write(`measure-suite: piece ${index} of ${total} green: ${measured.pass} tests over ${piece.length} files.\n`);
  } catch (error) {
    throw new MeasurementError(/** @type {Error} */ (error).message);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Join piece reports into one measured record. Refuses (exit 1, ledger
 * untouched) when the reports do not describe ONE green full-corpus run:
 * a missing piece (a red piece writes nothing), a piece from another
 * commit or corpus, a piece counted twice, a hand-placed red report, or a
 * union that loses or doubles a file. The record has the monolith's shape,
 * so every downstream check (`apply-ci-measurement.js`, `repo:truth
 * --require-current`, `site-check.js`) reads it unchanged.
 *
 * @param {string[]} shardPaths report files, one per piece
 * @param {boolean} apply write the record into site/claims.json
 */
function combineReports(shardPaths, apply) {
  if (shardPaths.length === 0) {
    process.stderr.write('measure-suite: --combine needs at least one piece report.\n');
    process.exit(2);
  }
  /** @type {Array<{ shard: number, shards: number, sha: string, testsTree: string, tests: number, failures: number, files: Record<string, { tests: number }> }>} */
  const reports = [];
  for (const shardPath of shardPaths) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(shardPath, 'utf8'));
    } catch (error) {
      process.stderr.write(`measure-suite: cannot read piece report ${shardPath}: ${/** @type {any} */ (error)?.message ?? error}\n`);
      process.exit(2);
    }
    reports.push(parsed);
  }
  const sha = reports.length > 0 ? String(reports[0]?.sha ?? '') : '';
  const expected = sha && /^[0-9a-f]{40}$/.test(sha)
    ? git(['ls-tree', '-r', '--name-only', sha, 'tests/']).stdout.split('\n').filter((path) => path.endsWith('.test.js'))
    : [];
  let combined;
  try {
    combined = combineShards(reports, expected);
  } catch (error) {
    process.stderr.write(`measure-suite: cannot combine piece reports: ${/** @type {Error} */ (error).message}\n`);
    process.exit(1);
  }
  const record = buildCombinedRecord(combined);

  if (!apply) {
    process.stdout.write(`${JSON.stringify({ measuredAgainst: record }, null, 2)}\n`);
    process.stderr.write('measure-suite: nothing written. Re-run with --apply to update site/claims.json.\n');
    return;
  }

  assertMeasurementUnchanged(git, combined.sha);
  const head = git(['rev-parse', 'HEAD']).stdout;
  if (head !== combined.sha) {
    throw new MeasurementError(
      `HEAD moved past the measured commit ${combined.sha.slice(0, 12)}; nothing recorded`,
    );
  }
  const source = readFileSync(claimsPath, 'utf8');
  const ledger = JSON.parse(source);
  ledger.measuredAgainst = record;
  writeFileSync(claimsPath, `${JSON.stringify(ledger, null, 2)}\n`);
  process.stdout.write(`site/claims.json measuredAgainst updated: ${record.tests} tests, 0 failing, at ${record.sha}.\n`);
}

/**
 * The pure join the combine step and the tests drive: every piece present
 * exactly once, all from the same commit and corpus, every corpus file in
 * exactly one piece, every piece green, totals reconciled. Anything else
 * throws: a count nobody ran green end-to-end is not a count.
 *
 * @param {Array<{ shard: number, shards: number, sha: string, testsTree: string, tests: number, failures: number, files: Record<string, { tests: number }> }>} reports
 *   one report per piece
 * @param {string[]} expectedFiles the measured commit's full `*.test.js` list
 * @returns {{ sha: string, testsTree: string, tests: number, testFiles: number, files: Record<string, { tests: number }> }}
 */
export function combineShards(reports, expectedFiles) {
  if (reports.length === 0) throw new MeasurementError('no piece reports: a red piece writes nothing, so this measure is red.');
  const total = reports[0]?.shards;
  if (!Number.isSafeInteger(total) || /** @type {number} */ (total) < 1) {
    throw new MeasurementError('the first piece report names no piece count.');
  }
  const seen = new Set();
  /** @type {Record<string, { tests: number }>} */
  const files = {};
  let tests = 0;
  let sha = '';
  let testsTree = '';
  for (const report of reports) {
    if (report === null || typeof report !== 'object') throw new MeasurementError('a piece report is not an object.');
    if (report.shards !== total) {
      throw new MeasurementError(`piece ${report.shard} of ${report.shards} does not belong to this ${total}-piece measure.`);
    }
    if (!Number.isSafeInteger(report.shard) || report.shard < 1 || report.shard > /** @type {number} */ (total)) {
      throw new MeasurementError(`piece index ${report.shard} is outside 1..${total}.`);
    }
    if (seen.has(report.shard)) throw new MeasurementError(`piece ${report.shard} is reported twice: counts would double.`);
    seen.add(report.shard);
    if (sha === '') {
      sha = String(report.sha ?? '');
      testsTree = String(report.testsTree ?? '');
      if (!/^[0-9a-f]{40}$/.test(sha)) throw new MeasurementError('the piece reports name no measured commit.');
      if (!/^[0-9a-f]{40}$/.test(testsTree)) throw new MeasurementError('the piece reports name no corpus fingerprint.');
    } else if (report.sha !== sha || report.testsTree !== testsTree) {
      throw new MeasurementError(`piece ${report.shard} was measured at another commit or corpus: pieces must share one run's tree.`);
    }
    if (report.failures !== 0) {
      throw new MeasurementError(`piece ${report.shard} reports ${report.failures} failures: one red piece reddens the measure.`);
    }
    if (!Number.isSafeInteger(report.tests) || report.tests < 0) {
      throw new MeasurementError(`piece ${report.shard} reports no usable test count.`);
    }
    const entries = report.files !== null && typeof report.files === 'object' && !Array.isArray(report.files)
      ? Object.entries(report.files)
      : null;
    if (entries === null || entries.length === 0) throw new MeasurementError(`piece ${report.shard} names no files.`);
    for (const [path, value] of entries) {
      if (files[path] !== undefined) throw new MeasurementError(`\`${path}\` is reported by two pieces: counts would double.`);
      if (value === null || typeof value !== 'object' || !Number.isSafeInteger(value.tests) || value.tests < 0) {
        throw new MeasurementError(`piece ${report.shard} reports no usable count for \`${path}\`.`);
      }
      files[path] = { tests: value.tests };
    }
    tests += report.tests;
  }
  if (seen.size !== total) {
    const missing = Array.from({ length: /** @type {number} */ (total) }, (_, k) => k + 1).filter((i) => !seen.has(i));
    throw new MeasurementError(`missing piece report for piece ${missing.join(', ')}: a red piece writes nothing, so this measure is red.`);
  }
  const mapped = Object.keys(files).sort();
  const actual = [...new Set(expectedFiles)].sort();
  if (JSON.stringify(mapped) !== JSON.stringify(actual)) {
    throw new MeasurementError(
      `the pieces name ${mapped.length} test files, but the measured commit holds ${actual.length}: same files, none lost, none doubled.`,
    );
  }
  const sum = Object.values(files).reduce((n, entry) => n + entry.tests, 0);
  if (sum !== tests) throw new MeasurementError(`the pieces sum to ${sum} tests but report ${tests}: the parts do not add up.`);
  if (tests <= 0) throw new MeasurementError('the pieces report no tests: no run produced this record.');
  return { sha, testsTree, tests, testFiles: actual.length, files };
}

/**
 * The ledger record for a combined run: the monolith's shape, with the
 * command naming the piecemeal runner and the note saying how the numbers
 * were produced, so no reader mistakes them for one `npm run verify`.
 *
 * @param {{ sha: string, testsTree: string, tests: number, testFiles: number, files: Record<string, { tests: number }> }} combined
 */
export function buildCombinedRecord(combined) {
  return {
    date: new Date().toISOString().slice(0, 10),
    sha: combined.sha.slice(0, 7),
    command: MEASURE_COMMAND,
    tests: combined.tests,
    failures: 0,
    testFiles: combined.testFiles,
    testsTree: combined.testsTree,
    files: Object.fromEntries(Object.entries(combined.files).sort(([a], [b]) => a.localeCompare(b))),
    note: 'Written by `node scripts/measure-suite.js --combine` from green per-piece runs on a clean tree '
      + '(`npm run measure`: one heavy-job acquisition per piece, lock free between pieces). '
      + 'Never edit these numbers by hand: scripts/site-check.js verifies sha, testsTree, testFiles '
      + 'and the per-file map against the commit, so a record moved forward without a re-run fails the build.',
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    // Synchronous for the same reason as above: the runner must see the cause.
    writeSync(2, `measure-suite: ${error?.stack ?? error}\n`);
    process.exit(error.exitCode ?? 2);
  });
}

/**
 * One-line diagnosis of a dead `npm run verify` child. A run killed from the
 * outside (null exit + signal) reports no failing test by construction, so the
 * message says so outright: without this, an environment kill reads exactly
 * like a red suite with its failure lines missing.
 *
 * @param {{ status: number | null, signal: string | null, error?: { message?: string } | null }} run
 *   the `spawnSync` result of the verify child.
 * @returns {string} the diagnosis line.
 */
/**
 * writeSync for a large string on a pipe that may be non-blocking (stderr is a
 * pipe on the macOS runner, and Node leaves pipes asynchronous there): write in
 * chunks and wait out EAGAIN instead of losing the rest.
 *
 * @param {number} fd
 * @param {string} text
 */
function writeAllSync(fd, text) {
  const buffer = Buffer.from(text, 'utf8');
  const pause = new Int32Array(new SharedArrayBuffer(4));
  let offset = 0;
  while (offset < buffer.length) {
    try {
      offset += writeSync(fd, buffer, offset, Math.min(65536, buffer.length - offset));
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EAGAIN') throw error;
      Atomics.wait(pause, 0, 0, 10);
    }
  }
}

/**
 * The lines of a spec/TAP run that name a failing test, in order, deduplicated.
 * Printed last on a red verify so the cause survives any truncation above it.
 *
 * @param {string} output the suite's stdout
 * @returns {string[]}
 */
export function failingTestLines(output) {
  const seen = new Set();
  const lines = [];
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!/^(✖|not ok\b)/.test(trimmed) || seen.has(trimmed)) continue;
    seen.add(trimmed);
    lines.push(trimmed);
  }
  return lines;
}

export function formatVerifyFailure(run) {
  const base = `verify failed: exit=${run.status}, signal=${run.signal}, `
    + `error=${run.error?.message ?? 'none'}; nothing recorded`;
  if (run.status === null && run.signal) {
    return `${base}. The suite process died (${run.signal}) without reporting a failing test: `
      + 'suspect the machine (concurrent jobs, memory), not the tests.';
  }
  return base;
}

/**
 * Run each test file alone under the TAP reporter and read its pass count
 * out of the summary. Sequential on purpose: the full suite already parallelises,
 * and a second parallel layer over shared test resources (ports, the test
 * database) would measure contention, not the corpus. Exported so tests can
 * drive the counting without a full `npm run verify`.
 *
 * @param {string} root directory to run in
 * @param {string[]} relpaths repo-relative `*.test.js` paths
 * @returns {Record<string, { tests: number }>} sorted by path
 */
export function enumerateTestFiles(root, relpaths) {
  /** @type {Record<string, { tests: number }>} */
  const map = {};
  for (const relpath of [...relpaths].sort()) {
    map[relpath] = { tests: runTestFile(root, relpath) };
  }
  return map;
}

/**
 * The passing-test count of one file, or process exit when it cannot be known.
 * A red file, an unparsable report and a timeout all refuse the same way: a
 * count nobody ran is not a count.
 *
 * @param {string} root directory to run in
 * @param {string} relpath
 * @returns {number}
 */
export function runTestFile(root, relpath) {
  const run = spawnSync('node', ['--no-warnings', '--test', '--test-reporter=tap', relpath], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 600_000,
    env: standaloneEnv(),
  });
  if (run.error) {
    process.stderr.write(`measure-suite: ${relpath}: runner did not answer (${run.error.message}). Nothing recorded.\n`);
    process.exit(1);
  }
  const text = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
  const pass = lastNumber(text, /^# pass\s+(\d+)\s*$/gm);
  const fail = lastNumber(text, /^# fail\s+(\d+)\s*$/gm);
  if (pass === null || fail === null || run.status !== 0 || fail !== 0) {
    process.stderr.write(
      `measure-suite: ${relpath}: exit=${run.status}, pass=${pass ?? 'unreadable'}, fail=${fail ?? 'unreadable'}. `
      + 'A claims ledger rests on green runs; nothing recorded.\n',
    );
    process.exit(1);
  }
  return pass;
}

/**
 * The counted file must see a standalone run even when the measurer itself
 * runs nested inside `node --test` (its own suite, CI): under
 * NODE_TEST_CONTEXT a `node --test` child routes its TAP to the parent
 * instead of its own stdout, which would read as zero tests run. Only the
 * runner-context variable goes; everything else (PATH, test database URLs,
 * feature flags) is inherited, so the counted file sees the same environment
 * the suite would.
 */
function standaloneEnv() {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

/**
 * Re-anchor the ledger's record at HEAD by running only the test files the
 * recorded tree and HEAD disagree on. Exits 0 having written nothing when the
 * corpus already matches; exits 1 having written nothing whenever the new
 * numbers cannot be known exactly.
 */
function refreshRecord() {
  const ledger = JSON.parse(readFileSync(claimsPath, 'utf8'));
  const record = ledger.measuredAgainst ?? {};
  const fileMap = record.files;
  if (fileMap === null || typeof fileMap !== 'object' || Array.isArray(fileMap)) {
    process.stderr.write(
      'measure-suite: --refresh needs the per-file map this record does not carry — every record written '
      + 'before the map existed. Run `node scripts/measure-suite.js --apply` once to seed it.\n',
    );
    process.exit(1);
  }
  if (!Number.isInteger(record.tests) || !Number.isInteger(record.testFiles)) {
    process.stderr.write('measure-suite: --refresh needs integer tests/testFiles in the record; this one cannot be carried.\n');
    process.exit(1);
  }
  const recordedSha = String(record.sha ?? '');
  if (!/^[0-9a-f]{7,40}$/.test(recordedSha) || git(['cat-file', '-e', `${recordedSha}^{commit}`]).status !== 0) {
    process.stderr.write(`measure-suite: recorded sha ${recordedSha || '(missing)'} is not a commit here, so no diff can bridge it. Run --apply.\n`);
    process.exit(1);
  }
  if (git(['merge-base', '--is-ancestor', recordedSha, 'HEAD']).status !== 0) {
    process.stderr.write(
      `measure-suite: recorded sha ${recordedSha} is not an ancestor of HEAD. The lineage is broken; `
      + 'no diff can carry it. Run --apply.\n',
    );
    process.exit(1);
  }

  let head = git(['rev-parse', 'HEAD']).stdout;
  const settled = planRefresh(git, recordedSha, head, fileMap);
  if (settled.refuse) {
    process.stderr.write(`measure-suite: ${settled.refuse} Run \`node scripts/measure-suite.js --apply\`.\n`);
    process.exit(1);
  }
  if (settled.run.length === 0 && settled.drop.length === 0) {
    process.stderr.write(`measure-suite: tests/ is unchanged since ${recordedSha} — the record already describes HEAD. Nothing to do.\n`);
    process.exit(0);
  }

  // The tip may move while the refresh runs. Chase it: re-diff every round,
  // extend the file set, and stop only when a whole round leaves HEAD where
  // it was — or when the tip outruns the budget, which is refused, not guessed.
  /** @type {Map<string, { tests: number, hash: string }>} */
  const fresh = new Map();
  for (let round = 0; round < 3; round += 1) {
    head = git(['rev-parse', 'HEAD']).stdout;
    const plan = planRefresh(git, recordedSha, head, fileMap);
    if (plan.refuse) {
      process.stderr.write(`measure-suite: ${plan.refuse} Run \`node scripts/measure-suite.js --apply\`.\n`);
      process.exit(1);
    }
    for (const relpath of plan.run) {
      const hash = git(['hash-object', relpath]).stdout;
      if (!hash) {
        process.stderr.write(`measure-suite: ${relpath} vanished mid-refresh. Run --apply.\n`);
        process.exit(1);
      }
      const done = fresh.get(relpath);
      if (done && done.hash === hash) continue;
      fresh.set(relpath, { tests: runTestFile(root, relpath), hash });
    }
    if (git(['rev-parse', 'HEAD']).stdout === head) break;
    // HEAD moved mid-round: loop and re-diff against the new tip.
  }
  head = git(['rev-parse', 'HEAD']).stdout;
  const final = planRefresh(git, recordedSha, head, fileMap);
  if (final.refuse) {
    process.stderr.write(`measure-suite: the tip moved onto unrefreshable ground mid-refresh: ${final.refuse} Run --apply.\n`);
    process.exit(1);
  }
  for (const relpath of final.run) {
    const done = fresh.get(relpath);
    const hash = git(['hash-object', relpath]).stdout;
    // Ran but stale, or never ran: the tip moved under the final round.
    if (!done || !hash || done.hash !== hash) {
      process.stderr.write(`measure-suite: the tip outran the refresh budget at ${relpath}. Retry when merges pause.\n`);
      process.exit(1);
    }
  }

  const carried = record.tests - final.drop.reduce((total, relpath) => total + oldCount(fileMap, relpath), 0);
  const added = final.run.reduce((total, relpath) => total + fresh.get(relpath).tests, 0);
  const tests = carried + added;
  if (carried < 0 || tests < 0) {
    process.stderr.write(
      `measure-suite: carried arithmetic went negative (record ${record.tests} minus dropped contributions). `
      + 'The recorded map is inconsistent with its totals; run --apply.\n',
    );
    process.exit(1);
  }
  const liveFiles = git(['ls-tree', '-r', '--name-only', head, 'tests/']).stdout
    .split('\n')
    .filter((path) => path.endsWith('.test.js'))
    .sort();

  /** @type {Record<string, { tests: number }>} */
  const files = {};
  for (const relpath of liveFiles) {
    const ran = fresh.get(relpath);
    const count = ran && final.run.includes(relpath) ? ran.tests : oldCount(fileMap, relpath);
    if (!Number.isInteger(count) || count < 0) {
      process.stderr.write(`measure-suite: no exact count for \`${relpath}\` — it never ran and the map does not cover it. Run --apply.\n`);
      process.exit(1);
    }
    files[relpath] = { tests: count };
  }

  const reconciled = Object.values(files).reduce((sum, entry) => sum + entry.tests, 0);
  if (reconciled !== tests) throw new MeasurementError('refresh map does not reconcile with its total; nothing recorded');
  assertMeasurementUnchanged(git, head);

  const next = {
    date: new Date().toISOString().slice(0, 10),
    sha: head.slice(0, 7),
    command: 'npm run measure:refresh',
    tests,
    failures: 0,
    testFiles: liveFiles.length,
    testsTree: git(['rev-parse', `${head}:tests`]).stdout,
    files,
    note: 'Written by `node scripts/measure-suite.js --refresh`: the added and changed test files ran green '
      + 'at this commit, every untouched file carries its count from the green full run the previous record '
      + 'rests on, and the file total was recounted exactly. Never edit these numbers by hand: '
      + 'scripts/site-check.js verifies sha, testsTree, testFiles and the per-file map against the commit.',
  };
  assertMeasurementUnchanged(git, head);
  ledger.measuredAgainst = next;
  writeFileSync(claimsPath, `${JSON.stringify(ledger, null, 2)}\n`);
  process.stdout.write(
    `site/claims.json measuredAgainst refreshed: ${tests} tests, 0 failing, at ${next.sha} `
    + `(${final.run.length} file(s) ran, ${liveFiles.length - final.run.length} carried).\n`,
  );
}

/**
 * The refresh plan between two commits: which test files must run (`run`)
 * and which recorded contributions drop out (`drop`). Fails closed —
 * anything that is not an added, changed or removed `*.test.js` file
 * refuses with the reason why, as does a dropped path the recorded map
 * does not cover. Exported so tests can drive the classification against a
 * stub without staging a repository per case.
 *
 * @param {(args: string[]) => { status: number, stdout: string }} git
 * @param {string} recordedSha
 * @param {string} headSha
 * @param {Record<string, { tests: number }>} fileMap
 */
export function planRefresh(git, recordedSha, headSha, fileMap) {
  const diff = git(['diff', '--name-status', recordedSha, headSha]);
  if (diff.status !== 0) return { refuse: 'the input diff would not read.' };
  /** @type {string[]} */
  const run = [];
  /** @type {string[]} */
  const drop = [];
  for (const line of diff.stdout.split('\n')) {
    if (!line) continue;
    const [status, first, second] = line.split('\t');
    const kind = (status ?? '')[0];
    // Only the prior measurement's own ledger commit may be carried outside
    // tests/. Even a documentation file can be an input to a test: no guessed
    // source/dependency graph, and no green counts carried over unseen edits.
    if (first === 'site/claims.json' && kind === 'M') {
      try {
        const before = git(['show', `${recordedSha}:site/claims.json`]);
        const after = git(['show', `${headSha}:site/claims.json`]);
        if (before.status !== 0 || after.status !== 0) throw new Error('unreadable ledger');
        const { measuredAgainst: _old, ...oldClaims } = JSON.parse(before.stdout);
        const { measuredAgainst: _new, ...newClaims } = JSON.parse(after.stdout);
        if (JSON.stringify(oldClaims) !== JSON.stringify(newClaims)) throw new Error('claims changed');
      } catch {
        return { refuse: 'claims outside measuredAgainst changed or could not be read.' };
      }
      continue;
    }
    if (!first?.startsWith('tests/') || (second && !second.startsWith('tests/'))) {
      return { refuse: `input outside tests/ changed: ${first ?? '(missing path)'}.` };
    }
    if (kind === 'R') {
      // A rename carries nothing: the old path drops out, the new path runs.
      if (!first || !second) return { refuse: `unparsable rename entry ${JSON.stringify(line)}.` };
      drop.push(first);
      if (isTestFile(second)) run.push(second);
      else return { refuse: `a test file became ${second}, which is not a test file.` };
    } else if (kind === 'C') {
      // A copy leaves the source in place: only the new path runs.
      if (!first || !second) return { refuse: `unparsable copy entry ${JSON.stringify(line)}.` };
      if (!isTestFile(second)) return { refuse: `\`${second}\` appeared under tests/ and is not a test file.` };
      run.push(second);
    } else if (kind === 'A' || kind === 'M' || kind === 'T') {
      if (!first) return { refuse: `unparsable diff entry ${JSON.stringify(line)}.` };
      if (!isTestFile(first)) return { refuse: `\`${first}\` changed under tests/ and is not a test file.` };
      if (kind !== 'A') drop.push(first);
      run.push(first);
    } else if (kind === 'D') {
      if (!first) return { refuse: `unparsable diff entry ${JSON.stringify(line)}.` };
      if (!isTestFile(first)) return { refuse: `\`${first}\` left tests/ and is not a test file.` };
      drop.push(first);
    } else {
      return { refuse: `unrecognised diff status ${JSON.stringify(line)}.` };
    }
  }
  for (const relpath of drop) {
    if (oldCount(fileMap, relpath) === null) {
      return { refuse: `the recorded map does not cover \`${relpath}\`.` };
    }
  }
  return { run: [...new Set(run)], drop };
}

function isTestFile(path) {
  return typeof path === 'string' && path.startsWith('tests/') && path.endsWith('.test.js') && !path.includes('..');
}

function oldCount(fileMap, relpath) {
  const entry = fileMap[relpath];
  return entry && typeof entry === 'object' && Number.isInteger(entry.tests) && entry.tests >= 0 ? entry.tests : null;
}

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
