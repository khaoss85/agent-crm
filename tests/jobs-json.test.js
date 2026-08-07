// @ts-check

/**
 * `docs/benchmarks/jobs.json` is the answer an agent gets when it asks whether
 * this framework can do a thing. It is generated from the JTBD matrix, which
 * means it can silently stop being true: someone promotes a row to *validated
 * end to end*, nobody reruns the generator, and the machine-readable surface
 * keeps serving the old status to every agent that fetches it.
 *
 * These tests hold the four properties that make the file worth publishing:
 *
 *   1. it is in sync with the matrix (the `--check` contract CI runs);
 *   2. every status is one of the four vocabulary values — no invented status;
 *   3. every test named as evidence exists on disk — a claim whose proof was
 *      deleted is an overclaim;
 *   4. the ids are unique and the counts add up, so no job is double-counted
 *      or dropped.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const generator = join(root, 'scripts', 'generate-jobs.js');
const target = join(root, 'docs', 'benchmarks', 'jobs.json');
const source = join(root, 'docs', 'benchmarks', 'CRM_JTBD_MATRIX.md');

const raw = readFileSync(target, 'utf8');
const index = JSON.parse(raw);

/** @param {string[]} args */
function run(args) {
  return spawnSync(process.execPath, ['--no-warnings', generator, ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

test('the committed jobs.json is in sync with the JTBD matrix', () => {
  const result = run(['--check']);
  assert.equal(
    result.status,
    0,
    `docs/benchmarks/jobs.json is stale against docs/benchmarks/CRM_JTBD_MATRIX.md.\n${result.stderr}`
    + 'Run: node scripts/generate-jobs.js',
  );
});

test('regenerating produces byte-identical output', () => {
  const result = run(['--stdout']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    raw,
    'the generator is not deterministic, or the committed file was hand-edited. '
    + 'jobs.json is generated output: edit the matrix, not the JSON.',
  );
});

test('the file declares its contract, its source and the status vocabulary', () => {
  assert.equal(index.jobsContract, 1);
  assert.equal(index.generatedFrom, 'docs/benchmarks/CRM_JTBD_MATRIX.md');
  assert.ok(existsSync(join(root, index.generatedFrom)), 'generatedFrom must name a real file');
  assert.deepEqual(index.statusVocabulary, [
    'not supported',
    'partially supported',
    'technically supported',
    'validated end to end',
  ]);
  assert.ok(raw.endsWith('\n'), 'the file must end with a trailing newline');
});

test('every job carries a status from the vocabulary', () => {
  const vocabulary = new Set(index.statusVocabulary);
  const offenders = index.jobs
    .filter((/** @type {any} */ job) => !vocabulary.has(job.status))
    .map((/** @type {any} */ job) => `${job.id}: "${job.status}"`);
  assert.deepEqual(
    offenders,
    [],
    'a status outside the four-value vocabulary makes the index unreadable by machine',
  );
});

test('every job has an id, a title and a summary', () => {
  for (const job of index.jobs) {
    assert.match(job.id, /^JTBD-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/, `bad id: ${JSON.stringify(job.id)}`);
    assert.ok(job.title && job.title.length > 3, `${job.id} has no usable title`);
    assert.ok(job.summary && job.summary.length > 3, `${job.id} has no usable summary`);
    assert.ok(typeof job.section === 'string', `${job.id} has no section`);
    assert.ok(Array.isArray(job.tests) && Array.isArray(job.docs), `${job.id} has malformed evidence`);
  }
});

test('job ids are unique and sorted', () => {
  const ids = index.jobs.map((/** @type {any} */ job) => job.id);
  const duplicates = ids.filter((/** @type {string} */ id, /** @type {number} */ i) => ids.indexOf(id) !== i);
  assert.deepEqual([...new Set(duplicates)], [], 'a duplicate id means one job overwrote another');

  const sorted = [...ids].sort();
  assert.deepEqual(ids, sorted, 'jobs must be sorted by id so the file is byte-stable across runs');
});

test('counts add up to the total and to the number of jobs', () => {
  const perStatus = index.statusVocabulary.reduce(
    (/** @type {number} */ sum, /** @type {string} */ status) => {
      assert.equal(typeof index.counts[status], 'number', `counts is missing "${status}"`);
      return sum + index.counts[status];
    },
    0,
  );
  assert.equal(perStatus, index.counts.total, 'per-status counts do not sum to total');
  assert.equal(index.counts.total, index.jobs.length, 'total does not match the number of jobs');

  const recounted = Object.fromEntries(index.statusVocabulary.map((/** @type {string} */ s) => [s, 0]));
  for (const job of index.jobs) recounted[job.status] += 1;
  for (const status of index.statusVocabulary) {
    assert.equal(recounted[status], index.counts[status], `count for "${status}" disagrees with the jobs`);
  }
});

test('every test named as evidence exists on disk', () => {
  const missing = [];
  for (const job of index.jobs) {
    for (const path of job.tests) {
      assert.match(path, /^tests\/.*\.test\.js$/, `${job.id} lists a non-test in tests[]: ${path}`);
      if (!existsSync(join(root, path))) missing.push(`${job.id} → ${path}`);
    }
  }
  assert.deepEqual(
    missing,
    [],
    'a job cites a test that does not exist. Evidence that cannot be run is not evidence.',
  );
});

test('every doc named as evidence exists on disk', () => {
  const missing = [];
  for (const job of index.jobs) {
    for (const path of job.docs) {
      if (!existsSync(join(root, path))) missing.push(`${job.id} → ${path}`);
    }
  }
  assert.deepEqual(missing, [], 'a job cites a document that does not exist');
});

test('a validated job names at least one test', () => {
  const unproven = index.jobs
    .filter((/** @type {any} */ job) => job.status === 'validated end to end' && job.tests.length === 0)
    .map((/** @type {any} */ job) => job.id);
  assert.deepEqual(
    unproven,
    [],
    'the matrix marks a job validated end to end only when an automated test proves it (AGENTS.md). '
    + 'Either the row is overclaimed or its evidence names no test path.',
  );
});

test('every JTBD id in the matrix is present in the index', () => {
  // The guard against the quiet failure mode: a row shape the generator does not
  // recognise. It errors on an unclassifiable row, but this checks the result from
  // the other side — no id may appear in the Markdown and be absent from the JSON.
  const matrix = readFileSync(source, 'utf8');
  const declared = new Set(
    (matrix.match(/^(?:#{2,6}\s+|\|\s*)(JTBD-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)\b/gm) ?? [])
      .map((match) => /JTBD-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*/.exec(match)?.[0]),
  );
  const indexed = new Set(index.jobs.map((/** @type {any} */ job) => job.id));
  const dropped = [...declared].filter((id) => id && !indexed.has(id));
  assert.deepEqual(
    dropped,
    [],
    'the matrix declares a job the index does not carry. A dropped row is a claim by omission.',
  );
  assert.ok(declared.size > 100, 'the id sweep matched almost nothing — the regex has drifted from the matrix');
});

test('--check fails loudly when the committed file is stale', () => {
  // Proves the CI contract actually detects drift rather than always exiting 0.
  const result = spawnSync(
    process.execPath,
    ['--no-warnings', '-e', `
      const { readFileSync, writeFileSync, mkdtempSync, cpSync } = require('node:fs');
      const { tmpdir } = require('node:os');
      const { join } = require('node:path');
      const { spawnSync } = require('node:child_process');
      const root = process.argv[1];
      const work = mkdtempSync(join(tmpdir(), 'jobs-check-'));
      cpSync(join(root, 'scripts'), join(work, 'scripts'), { recursive: true });
      cpSync(join(root, 'docs', 'benchmarks'), join(work, 'docs', 'benchmarks'), { recursive: true });
      cpSync(join(root, 'tests'), join(work, 'tests'), { recursive: true });
      const target = join(work, 'docs', 'benchmarks', 'jobs.json');
      const doc = JSON.parse(readFileSync(target, 'utf8'));
      doc.jobs[0].status = 'not supported';
      doc.jobs.pop();
      writeFileSync(target, JSON.stringify(doc, null, 2) + '\\n');
      const out = spawnSync(process.execPath, [join(work, 'scripts', 'generate-jobs.js'), '--check'], {
        cwd: work, encoding: 'utf8',
      });
      process.stdout.write(JSON.stringify({ status: out.status, stderr: out.stderr }));
    `, root],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  const outcome = JSON.parse(result.stdout);
  assert.equal(outcome.status, 1, '--check must exit 1 on a stale file');
  assert.match(outcome.stderr, /is stale/, '--check must say the file is stale');
  assert.match(outcome.stderr, /removed \(1\)/, '--check must name the dropped job');
  assert.match(outcome.stderr, /status JTBD-01:/, '--check must name the job whose status moved');
});
