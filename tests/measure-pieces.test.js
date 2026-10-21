// @ts-check

/**
 * Piecemeal measurement (backlog:9fff957f3968): the corpus is dealt into
 * short pieces, each under its own machine-lock acquisition, and the combine
 * refuses unless the pieces' union is exactly the measured corpus — same
 * files, none lost, none doubled — and every piece green. These tests pin
 * the dealing and the join on fixtures (fast: no suite ever runs here), plus
 * one dealing run over the committed corpus itself.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitIn } from './helpers/isolated-git.js';

import {
  MEASURE_COMMAND,
  buildCombinedRecord,
  combineShards,
  planShards,
  shardTestFiles,
} from '../scripts/measure-suite.js';
import { MeasurementError } from '../scripts/measurement-report.js';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const TREE_A = 'c'.repeat(40);

const fileNames = (count) => Array.from({ length: count }, (_, k) => `tests/${String(k).padStart(3, '0')}-suite.test.js`);

/**
 * @param {number} shard
 * @param {number} shards
 * @param {string[]} files
 * @param {number} [perFile]
 */
function makeReport(shard, shards, files, perFile = 3) {
  return {
    shard,
    shards,
    sha: SHA_A,
    testsTree: TREE_A,
    tests: files.length * perFile,
    failures: 0,
    files: Object.fromEntries(files.map((path) => [path, { tests: perFile }])),
  };
}

test('pieces cover the corpus exactly, with no file in two pieces', () => {
  for (const total of [1, 2, 3, 6]) {
    const files = fileNames(10);
    const union = [];
    for (let i = 1; i <= total; i += 1) union.push(...shardTestFiles(files, i, total));
    assert.deepEqual([...union].sort(), [...files].sort(), `piece union differs for ${total} pieces`);
    assert.equal(new Set(union).size, union.length, `a file runs twice for ${total} pieces`);
  }
});

test('the dealing is deterministic and independent of listing order', () => {
  const files = fileNames(25);
  const shuffled = [...files].reverse();
  for (let i = 1; i <= 6; i += 1) {
    assert.deepEqual(shardTestFiles(shuffled, i, 6), shardTestFiles(files, i, 6));
  }
});

test('round-robin spreads neighbouring files across pieces', () => {
  const pieceOfFirst = shardTestFiles(fileNames(12), 1, 6).length;
  assert.ok(pieceOfFirst > 0);
  const first = shardTestFiles(fileNames(12), 1, 6);
  const second = shardTestFiles(fileNames(12), 2, 6);
  assert.ok(!first.some((path) => second.includes(path)));
  const files = fileNames(12).sort();
  assert.ok(!shardTestFiles(files, 1, 6).includes(files[1]), 'neighbours pile into one piece');
});

test('piece bounds refuse instead of measuring the wrong corpus', () => {
  const files = fileNames(10);
  for (const [index, total] of [[0, 6], [7, 6], [1, 0], [2, 1]]) {
    assert.throws(() => shardTestFiles(files, index, total), MeasurementError);
  }
});

test('a piece that would run nothing refuses: bare node --test would discover the whole suite', () => {
  assert.throws(() => shardTestFiles(fileNames(3), 4, 4), MeasurementError);
  assert.throws(() => planShards(fileNames(2), 5), MeasurementError);
});

test('the dealing carries no per-piece maximum: every piece declares the same 900 s', () => {
  const plan = planShards(fileNames(30), 6);
  for (const piece of plan) {
    assert.deepEqual(Object.keys(piece).sort(), ['files', 'shard'], `a piece carries a key the driver does not read: ${Object.keys(piece)}`);
  }
});

test('the 6-piece dealing covers exactly the committed corpus: same files, none lost, none doubled', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const listed = gitIn(root)(['ls-tree', '-r', '--name-only', 'HEAD', 'tests/']);
  assert.equal(listed.status, 0, 'the corpus list must read from the commit');
  const files = String(listed.stdout).split('\n').filter((path) => path.endsWith('.test.js'));
  assert.ok(files.length > 6, 'the corpus must exceed the piece count');
  const plan = planShards(files, 6);
  const union = plan.flatMap((piece) => piece.files);
  assert.deepEqual([...union].sort(), [...files].sort(), 'piece union is not the committed corpus');
  assert.equal(new Set(union).size, union.length, 'a committed file runs in two pieces');
  const sizes = plan.map((piece) => piece.files.length);
  assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, `pieces are unbalanced: ${sizes.join(',')}`);
});

test('the six oracle slices land in six distinct pieces at every supported shard count', () => {
  // The load-bearing assumption of the 900 s uniform maximum: each full
  // oracle slice must run alone in its piece. Round-robin dealing separates
  // consecutive filenames by accident of adjacency, so this pins the fact
  // over the committed corpus — a rename, a reorder or a seventh oracle
  // file fails here instead of silently co-locating two full slices in one
  // piece (backlog:664d5f481a96). Smaller counts cannot separate six
  // slices at all and are refused by scripts/measure-pieces.sh.
  const root = fileURLToPath(new URL('..', import.meta.url));
  const listed = gitIn(root)(['ls-tree', '-r', '--name-only', 'HEAD', 'tests/']);
  assert.equal(listed.status, 0, 'the corpus list must read from the commit');
  const files = String(listed.stdout).split('\n').filter((path) => path.endsWith('.test.js'));
  const slices = files.filter((path) => /^tests\/shell-oracle-[a-z]\.test\.js$/.test(path)).sort();
  assert.deepEqual(
    slices,
    [
      'tests/shell-oracle-a.test.js',
      'tests/shell-oracle-b.test.js',
      'tests/shell-oracle-c.test.js',
      'tests/shell-oracle-d.test.js',
      'tests/shell-oracle-e.test.js',
      'tests/shell-oracle-f.test.js',
    ],
    'the oracle slice set changed: update the dealing floor in scripts/measure-pieces.sh alongside it',
  );
  for (const total of [6, 7, 12]) {
    const plan = planShards(files, total);
    const holders = new Map();
    for (const piece of plan) {
      for (const slice of slices) {
        if (piece.files.includes(slice)) {
          assert.ok(!holders.has(slice), `${slice} runs in two pieces at ${total} pieces`);
          holders.set(slice, piece.shard);
        }
      }
    }
    assert.equal(holders.size, slices.length, `an oracle slice runs in no piece at ${total} pieces`);
    assert.equal(
      new Set(holders.values()).size,
      slices.length,
      `two oracle slices share one piece at ${total} pieces: ${[...holders].map(([s, p]) => `${s}->${p}`).join(', ')}`,
    );
  }
});

test('the join adds green pieces into one record', () => {
  const files = fileNames(7);
  const reports = [makeReport(1, 3, files.slice(0, 3)), makeReport(2, 3, files.slice(3, 5)), makeReport(3, 3, files.slice(5))];
  const combined = combineShards(reports, files);
  assert.equal(combined.tests, 21);
  assert.equal(combined.testFiles, 7);
  assert.equal(combined.sha, SHA_A);
  assert.deepEqual(Object.keys(combined.files), [...files].sort());
});

test('one red piece reddens the whole measure', () => {
  const files = fileNames(4);
  const red = { ...makeReport(2, 2, files.slice(2)), tests: 6, failures: 2 };
  assert.throws(
    () => combineShards([makeReport(1, 2, files.slice(0, 2)), red], files),
    /red piece reddens the measure/,
  );
});

test('a missing piece report refuses: a red piece writes nothing', () => {
  const files = fileNames(4);
  assert.throws(
    () => combineShards([makeReport(1, 2, files.slice(0, 2))], files),
    /missing piece report for piece 2/,
  );
  assert.throws(() => combineShards([], files), /no piece reports/);
});

test('pieces from two commits, two corpora, or two measures never join', () => {
  const files = fileNames(4);
  const first = makeReport(1, 2, files.slice(0, 2));
  const otherSha = { ...makeReport(2, 2, files.slice(2)), sha: SHA_B };
  assert.throws(() => combineShards([first, otherSha], files), /another commit or corpus/);
  const otherTree = { ...makeReport(2, 2, files.slice(2)), testsTree: SHA_B };
  assert.throws(() => combineShards([first, otherTree], files), /another commit or corpus/);
  const otherCount = { ...makeReport(2, 3, files.slice(2)), shards: 3 };
  assert.throws(() => combineShards([first, otherCount], files), /does not belong/);
  const duplicate = makeReport(1, 2, files.slice(0, 2));
  assert.throws(() => combineShards([first, duplicate], files), /reported twice/);
  const outOfRange = { ...makeReport(1, 2, files.slice(0, 2)), shard: 3 };
  assert.throws(() => combineShards([outOfRange, makeReport(2, 2, files.slice(2))], files), /outside 1..2/);
});

test('a union that loses or doubles a file refuses', () => {
  const files = fileNames(4);
  const dropped = makeReport(2, 2, files.slice(3));
  assert.throws(() => combineShards([makeReport(1, 2, files.slice(0, 2)), dropped], files), /none lost, none doubled/);
  const extra = makeReport(2, 2, [...files.slice(2), 'tests/ghost.test.js']);
  assert.throws(() => combineShards([makeReport(1, 2, files.slice(0, 2)), extra], files), /none lost, none doubled/);
  const overlap = makeReport(2, 2, files.slice(1));
  assert.throws(() => combineShards([makeReport(1, 2, files.slice(0, 2)), overlap], files), /two pieces/);
});

test('parts that do not add up to the whole refuse', () => {
  const files = fileNames(4);
  const short = { ...makeReport(2, 2, files.slice(2)), tests: 999 };
  assert.throws(() => combineShards([makeReport(1, 2, files.slice(0, 2)), short], files), /do not add up/);
  const zero = { ...makeReport(1, 1, files), tests: 0, files: Object.fromEntries(files.map((p) => [p, { tests: 0 }])) };
  assert.throws(() => combineShards([zero], files), /no tests/);
});

test('malformed piece reports refuse', () => {
  const files = fileNames(2);
  assert.throws(() => combineShards([null], files), MeasurementError);
  assert.throws(() => combineShards([{ ...makeReport(1, 1, files), shards: 0 }], files), /no piece count/);
  assert.throws(() => combineShards([{ ...makeReport(1, 1, files), sha: 'zzz' }], files), /no measured commit/);
  assert.throws(() => combineShards([{ ...makeReport(1, 1, files), files: {} }], files), /names no files/);
});

test('the wrapper keeps stdout parsable: progress and heavy children go to stderr', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const script = readFileSync(join(root, 'scripts', 'measure-pieces.sh'), 'utf8');
  // Join backslash continuations: a redirect at the end of a wrapped command
  // covers every physical line of it.
  const logical = script.replace(/\\\n/g, ' ');
  for (const line of logical.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || trimmed === '') continue;
    if (/(^|[;\s])echo(\s|$)/.test(line)) {
      assert.ok(line.includes('>&2'), `stdout leak: progress echo without >&2: ${trimmed}`);
    }
    if (line.includes('ci-heavy.sh')) {
      assert.ok(line.includes('>&2'), `stdout leak: heavy child without >&2: ${trimmed}`);
    }
  }
});

test('a refused shard leaves no joinable report: a seeded --out is removed', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const scratch = mkdtempSync(join(tmpdir(), 'accordo-measure-pieces-test-'));
  try {
    for (const shard of ['7/6', '0/6']) {
      const outPath = join(scratch, `shard-${shard.replace('/', '-')}.json`);
      writeFileSync(outPath, `${JSON.stringify(makeReport(1, 6, fileNames(2)))}\n`);
      let status = 0;
      try {
        execFileSync(process.execPath, ['scripts/measure-suite.js', '--shard', shard, '--out', outPath], {
          cwd: root,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        status = /** @type {{ status?: number }} */ (error).status ?? 1;
      }
      assert.notEqual(status, 0, `shard ${shard} must refuse`);
      assert.ok(!existsSync(outPath), `a refused shard ${shard} left a joinable report at ${outPath}`);
      const leftovers = readdirSync(scratch).filter((name) => name.startsWith('shard-') && name.includes('.tmp-'));
      assert.deepEqual(leftovers, [], `a refused shard ${shard} left a pending report: ${leftovers.join(',')}`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('the combined record keeps the ledger shape and names the piecemeal runner', () => {
  const files = fileNames(3);
  const combined = combineShards([makeReport(1, 1, files)], files);
  const record = buildCombinedRecord(combined);
  assert.equal(record.command, MEASURE_COMMAND);
  assert.equal(record.command, 'npm run measure');
  assert.equal(record.failures, 0);
  assert.equal(record.tests, 9);
  assert.equal(record.testFiles, 3);
  assert.match(record.sha, /^[0-9a-f]{7}$/);
  assert.deepEqual(Object.keys(record.files), [...files].sort());
  assert.match(record.note, /--combine/);
});

/**
 * Driver-level proofs (backlog:664d5f481a96). The real children are too heavy
 * for a unit test — the check piece runs the typecheck, a shard piece runs
 * the suite — so these tests run the REAL scripts/measure-pieces.sh against
 * a shadow tree: a stub `scripts/ci-heavy.sh` (waiter file while it waits
 * and runs, like heavy-job.sh, then runs its child), a stub
 * `scripts/measure-suite.js` (`--plan` prints a canned dealing, `--shard`
 * writes a canned report, `--combine` records and succeeds) and a stub `npm`
 * first on PATH (the check child). The driver logic under test — the serial
 * loop, the declared maxima, the fail-fast — is the repository's own: the
 * stubs only make it observable in seconds.
 *
 * MEASURE_TEST_DRIVER overrides which driver runs (default: the repository's
 * own): sensitivity probes run these same tests against an intentionally
 * parallelised copy to prove they redden.
 */
function writeShadowTree(shadow) {
  const scriptsDir = join(shadow, 'scripts');
  const binDir = join(shadow, 'bin');
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(scriptsDir, 'ci-heavy.sh'), [
    '#!/usr/bin/env bash',
    'set -u',
    'log="${MEASURE_TEST_LOG:?}"',
    'lockdir="${MEASURE_TEST_LOCKDIR:?}"',
    'name="$1"; shift',
    '[ "${1:-}" = "--" ] && shift',
    'printf \'start %s MAX=%s\\n\' "$name" "${HEAVY_JOB_MAX_SEC:-unset}" >> "$log"',
    'touch "$lockdir/wait-$name"',
    'sleep "${MEASURE_TEST_SLEEP:-0.2}"',
    'waiters=$(ls "$lockdir"/wait-* 2>/dev/null | wc -l | tr -d " ")',
    'printf \'end %s waiters=%s\\n\' "$name" "$waiters" >> "$log"',
    'rm -f "$lockdir/wait-$name"',
    'if [ "${MEASURE_TEST_FAIL_PIECE:-}" = "$name" ]; then exit 1; fi',
    'exec "$@"',
    '',
  ].join('\n'));
  writeFileSync(join(scriptsDir, 'measure-suite.js'), [
    '// Test double for scripts/measure-suite.js: canned dealing and reports.',
    "import { appendFileSync, writeFileSync } from 'node:fs';",
    'const args = process.argv.slice(2);',
    'const log = process.env.MEASURE_TEST_LOG;',
    "if (args[0] === '--plan') {",
    '  const total = Number(args[1]);',
    '  const pieces = Array.from({ length: total }, (_, k) => ({',
    '    shard: k + 1,',
    '    files: [`tests/shadow-${k + 1}.test.js`],',
    '  }));',
    `  process.stdout.write(JSON.stringify({ sha: '${SHA_A}', testsTree: '${TREE_A}', shards: total, pieces }) + '\\n');`,
    "} else if (args[0] === '--shard') {",
    "  const [index, total] = args[1].split('/').map(Number);",
    "  const out = args[args.indexOf('--out') + 1];",
    "  appendFileSync(log, `shard-child ${index}/${total}\\n`);",
    "  writeFileSync(out, JSON.stringify({ shard: index, shards: total }) + '\\n');",
    "} else if (args[0] === '--combine') {",
    "  appendFileSync(log, `combine ${args.slice(1).join(' ')}\\n`);",
    "  process.stdout.write(JSON.stringify({ ok: true }) + '\\n');",
    '} else {',
    '  process.stderr.write(`shadow measure-suite: unexpected args ${args.join(\' \')}\\n`);',
    '  process.exit(2);',
    '}',
    '',
  ].join('\n'));
  writeFileSync(join(binDir, 'npm'), [
    '#!/usr/bin/env bash',
    'printf \'npm %s\\n\' "$*" >> "${MEASURE_TEST_LOG:?}"',
    'exit 0',
    '',
  ].join('\n'));
  chmodSync(join(scriptsDir, 'ci-heavy.sh'), 0o755);
  chmodSync(join(binDir, 'npm'), 0o755);
}

/**
 * @param {string} shadow
 * @param {{ shards?: number, failPiece?: string }} [options]
 */
function runDriver(shadow, { shards = 3, failPiece = null } = {}) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const driver = process.env.MEASURE_TEST_DRIVER ?? join(root, 'scripts', 'measure-pieces.sh');
  const log = join(shadow, 'driver.log');
  const lockdir = join(shadow, 'lock');
  mkdirSync(lockdir, { recursive: true });
  writeFileSync(log, '');
  let status = 0;
  let stdout = '';
  try {
    stdout = execFileSync('bash', [driver], {
      cwd: shadow,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${join(shadow, 'bin')}${delimiter}${process.env.PATH ?? ''}`,
        MEASURE_SHARDS: String(shards),
        MEASURE_TEST_LOG: log,
        MEASURE_TEST_LOCKDIR: lockdir,
        MEASURE_TEST_SLEEP: '0.2',
        ...(failPiece ? { MEASURE_TEST_FAIL_PIECE: failPiece } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    status = /** @type {{ status?: number }} */ (error).status ?? 1;
    stdout = /** @type {{ stdout?: string }} */ (error).stdout ?? '';
  }
  return { status, stdout, log: readFileSync(log, 'utf8') };
}

/**
 * @param {string} log
 * @param {string} name
 */
function maxOf(log, name) {
  const line = log.split('\n').find((entry) => entry.startsWith(`start ${name} MAX=`));
  assert.ok(line, `no lock acquisition recorded for ${name}:\n${log}`);
  return line.split('MAX=')[1];
}

test('pieces queue one at a time: the driver never holds two lock waiters', () => {
  const shadow = mkdtempSync(join(tmpdir(), 'accordo-measure-driver-test-'));
  try {
    writeShadowTree(shadow);
    const { status, stdout, log } = runDriver(shadow, { shards: 6 });
    assert.equal(status, 0, `driver must stay green:\n${log}`);
    assert.doesNotThrow(() => JSON.parse(stdout), `driver stdout must stay parsable JSON, got: ${stdout}`);
    const starts = log.split('\n').filter((line) => line.startsWith('start ')).map((line) => line.split(' ')[1]);
    assert.deepEqual(starts, [
      'measure-check',
      'measure-1-of-6',
      'measure-2-of-6',
      'measure-3-of-6',
      'measure-4-of-6',
      'measure-5-of-6',
      'measure-6-of-6',
    ]);
    const ends = log.split('\n').filter((line) => line.startsWith('end '));
    assert.equal(ends.length, 7, `check plus 6 pieces must each finish:\n${log}`);
    for (const line of ends) {
      assert.match(line, /waiters=1$/, `two lock waiters at once: ${line}\n${log}`);
    }
  } finally {
    rmSync(shadow, { recursive: true, force: true });
  }
});

test('every piece declares the same machine-lock maximum: 900 s', () => {
  const shadow = mkdtempSync(join(tmpdir(), 'accordo-measure-driver-test-'));
  try {
    writeShadowTree(shadow);
    const { status, log } = runDriver(shadow, { shards: 6 });
    assert.equal(status, 0, `driver must stay green:\n${log}`);
    assert.equal(maxOf(log, 'measure-check'), '900');
    // No heavy piece: the full shell-oracle corpus is sliced one grouping
    // per file (tests/shell-oracle-a/b/c/d/e/f.test.js, backlog:664d5f481a96),
    // so no piece needs more than the common 900 s.
    for (let i = 1; i <= 6; i += 1) {
      assert.equal(maxOf(log, `measure-${i}-of-6`), '900');
    }
  } finally {
    rmSync(shadow, { recursive: true, force: true });
  }
});

test('fewer than six pieces refuse before taking any lock: two oracle slices would share one', () => {
  for (const shards of [5, 2, 1]) {
    const shadow = mkdtempSync(join(tmpdir(), 'accordo-measure-driver-test-'));
    try {
      writeShadowTree(shadow);
      const { status, log } = runDriver(shadow, { shards });
      assert.notEqual(status, 0, `${shards} pieces must refuse, got status ${status}:\n${log}`);
      assert.ok(
        !log.split('\n').some((line) => line.startsWith('start ')),
        `${shards} pieces took a lock before refusing:\n${log}`,
      );
    } finally {
      rmSync(shadow, { recursive: true, force: true });
    }
  }
});

test('a red piece reddens the measure: the driver exits non-zero and never combines', () => {
  const shadow = mkdtempSync(join(tmpdir(), 'accordo-measure-driver-test-'));
  try {
    writeShadowTree(shadow);
    const { status, log } = runDriver(shadow, { shards: 6, failPiece: 'measure-2-of-6' });
    assert.notEqual(status, 0, `a red piece must redden the measure, got status ${status}:\n${log}`);
    assert.ok(!log.split('\n').some((line) => line.startsWith('combine ')), `no combine after a red piece:\n${log}`);
    assert.ok(
      !log.split('\n').some((line) => line.startsWith('start measure-3-of-6 ')),
      `pieces after the red one must not run:\n${log}`,
    );
  } finally {
    rmSync(shadow, { recursive: true, force: true });
  }
});
