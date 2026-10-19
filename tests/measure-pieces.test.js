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
import { fileURLToPath } from 'node:url';
import { gitIn } from './helpers/isolated-git.js';

import {
  HEAVY_MEASURE_FILE,
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

test('the dealing marks exactly the piece holding the oracle file as heavy', () => {
  const files = [...fileNames(30), HEAVY_MEASURE_FILE];
  const plan = planShards(files, 6);
  const heavy = plan.filter((piece) => piece.heavy);
  assert.equal(heavy.length, 1);
  assert.ok(heavy[0]?.files.includes(HEAVY_MEASURE_FILE));
});

test('no piece is heavy when the oracle file is absent from the corpus', () => {
  const plan = planShards(fileNames(30), 6);
  assert.ok(plan.every((piece) => !piece.heavy));
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
