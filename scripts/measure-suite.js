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
 *
 * Exit codes: 0 measured, 1 the suite failed or the tree is dirty, 2 unusable input.
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

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MeasurementError, assertMeasurementUnchanged, parseMeasurementReport } from './measurement-report.js';

const root = process.cwd();
const claimsPath = join(root, 'site', 'claims.json');

const git = (/** @type {string[]} */ args) => {
  const run = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return { status: run.status ?? 1, stdout: String(run.stdout ?? '').trim() };
};

async function main() {
  const flags = new Set(process.argv.slice(2));
  for (const flag of flags) {
    if (flag !== '--apply' && flag !== '--refresh') {
      process.stderr.write(`measure-suite: unknown flag ${flag}\n`);
      process.exit(2);
    }
  }
  if (flags.has('--apply') && flags.has('--refresh')) {
    process.stderr.write('measure-suite: --apply and --refresh cannot be combined: one measures the whole suite, the other carries a record forward.\n');
    process.exit(2);
  }
  const apply = flags.has('--apply');
  const refresh = flags.has('--refresh');

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
      process.stderr.write(`${run.stdout ?? ''}\n${run.stderr ?? ''}`);
      throw new MeasurementError(`verify failed: exit=${run.status}, signal=${run.signal}, error=${run.error?.message ?? 'none'}; nothing recorded`);
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

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`measure-suite: ${error?.stack ?? error}\n`);
    process.exit(error.exitCode ?? 2);
  });
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
