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
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
    // A summary may be as terse as "MK1" (a blocking milestone); it may not be empty.
    assert.ok(typeof job.summary === 'string' && job.summary.length > 0, `${job.id} has no summary`);
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

// Ten rows are marked *validated end to end* in the matrix without naming a test in
// the row itself: their evidence sits in the milestone docs and the section prose
// rather than inline. That is a real gap in the matrix — a reader of jobs.json sees
// a validated job with an empty `tests` array — and it is recorded here rather than
// hidden. The list is a ratchet: it may shrink as rows gain citations, and any new
// id appearing outside it fails.
const VALIDATED_WITHOUT_INLINE_TEST = new Set([
  'JTBD-AX-02',
  'JTBD-CO-01',
  'JTBD-CO-03',
  'JTBD-CO-07',
  'JTBD-LI-01',
  'JTBD-LI-02',
  'JTBD-LI-04',
  'JTBD-LI-07',
  'JTBD-PK-01',
  'JTBD-PK-02',
]);

test('a validated job names a test, or is a known uncited row', () => {
  const unproven = index.jobs
    .filter((/** @type {any} */ job) => job.status === 'validated end to end' && job.tests.length === 0)
    .map((/** @type {any} */ job) => job.id)
    .filter((/** @type {string} */ id) => !VALIDATED_WITHOUT_INLINE_TEST.has(id));
  assert.deepEqual(
    unproven,
    [],
    'a job was marked validated end to end with no test named in its row. The matrix promotes a row '
    + 'only when an automated test proves it (AGENTS.md) — cite the test in the row so jobs.json carries it.',
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
  // The generator resolves everything from the working directory, so a copy of the
  // three directories it reads is a complete, disposable repository for its purposes.
  const work = mkdtempSync(join(tmpdir(), 'jobs-check-'));
  try {
    for (const directory of ['scripts', 'docs', 'tests']) {
      cpSync(join(root, directory), join(work, directory), { recursive: true });
    }
    // Three kinds of drift at once: a job the matrix gained, a job it no longer
    // has, and a job whose status moved. All three must be named, not just counted.
    const copied = join(work, 'docs', 'benchmarks', 'jobs.json');
    const stale = JSON.parse(readFileSync(copied, 'utf8'));
    stale.jobs[0].status = 'not supported';
    stale.jobs.pop();
    stale.jobs.push({
      id: 'JTBD-ZZ-99',
      title: 'A job the matrix does not have',
      status: 'not supported',
      summary: 'invented',
      tests: [],
      docs: [],
      section: 'nowhere',
    });
    // Keep the fixture internally consistent, so the drift the check reports is the
    // drift against the matrix rather than an artefact of hand-edited counts.
    for (const status of stale.statusVocabulary) stale.counts[status] = 0;
    for (const job of stale.jobs) stale.counts[job.status] += 1;
    stale.counts.total = stale.jobs.length;
    writeFileSync(copied, `${JSON.stringify(stale, null, 2)}\n`);

    const result = spawnSync(process.execPath, ['--no-warnings', join(work, 'scripts', 'generate-jobs.js'), '--check'], {
      cwd: work,
      encoding: 'utf8',
    });
    assert.equal(result.status, 1, `--check must exit 1 on a stale file\n${result.stderr}`);
    assert.match(result.stderr, /is stale/, '--check must say the file is stale');
    assert.match(result.stderr, /added \(1\): JTBD-PK-07/, '--check must name the job the matrix gained');
    assert.match(result.stderr, /removed \(1\): JTBD-ZZ-99/, '--check must name the job the matrix no longer has');
    assert.match(result.stderr, /status JTBD-01: "not supported" → "validated end to end"/, '--check must name the job whose status moved');
    assert.match(result.stderr, /count "not supported": \d+ → \d+/, '--check must report the count drift');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('--check reports a missing file rather than passing', () => {
  const work = mkdtempSync(join(tmpdir(), 'jobs-missing-'));
  try {
    for (const directory of ['scripts', 'docs', 'tests']) {
      cpSync(join(root, directory), join(work, directory), { recursive: true });
    }
    rmSync(join(work, 'docs', 'benchmarks', 'jobs.json'));
    const result = spawnSync(process.execPath, ['--no-warnings', join(work, 'scripts', 'generate-jobs.js'), '--check'], {
      cwd: work,
      encoding: 'utf8',
    });
    assert.equal(result.status, 1, '--check must exit 1 when the file is absent');
    assert.match(result.stderr, /does not exist/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('an unclassifiable row is a hard error naming the line', () => {
  // The property the whole design rests on: a row shape the parser does not know
  // must stop the build, because a silently dropped job is a claim by omission.
  const work = mkdtempSync(join(tmpdir(), 'jobs-badrow-'));
  try {
    for (const directory of ['scripts', 'docs', 'tests']) {
      cpSync(join(root, directory), join(work, directory), { recursive: true });
    }
    const matrix = join(work, 'docs', 'benchmarks', 'CRM_JTBD_MATRIX.md');
    const lines = readFileSync(matrix, 'utf8').split('\n');
    const firstRow = lines.findIndex((line) => line.startsWith('| JTBD-'));
    assert.ok(firstRow > 0, 'the matrix should contain at least one table row');
    lines.splice(firstRow, 0, '| JTBD-ZZ-99 | A job in a shape nobody taught the parser |');
    writeFileSync(matrix, lines.join('\n'));

    const result = spawnSync(process.execPath, ['--no-warnings', join(work, 'scripts', 'generate-jobs.js')], {
      cwd: work,
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0, 'an unclassifiable row must fail, not be skipped');
    assert.match(result.stderr, /neither a header, a separator nor a job row/);
    assert.match(result.stderr, /JTBD-ZZ-99/, 'the error must print the offending line');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test('a status outside the vocabulary is a hard error', () => {
  const work = mkdtempSync(join(tmpdir(), 'jobs-badstatus-'));
  try {
    for (const directory of ['scripts', 'docs', 'tests']) {
      cpSync(join(root, directory), join(work, directory), { recursive: true });
    }
    const matrix = join(work, 'docs', 'benchmarks', 'CRM_JTBD_MATRIX.md');
    // Target a real row, not the status legend at the top of the document.
    const text = readFileSync(matrix, 'utf8').replace(
      '| JTBD-DO-04 | Export records | **not supported** |',
      '| JTBD-DO-04 | Export records | **mostly works** |',
    );
    assert.ok(text.includes('**mostly works**'), 'the fixture row moved — update this test');
    writeFileSync(matrix, text);

    const result = spawnSync(process.execPath, ['--no-warnings', join(work, 'scripts', 'generate-jobs.js')], {
      cwd: work,
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0, 'an unknown status must fail');
    assert.match(result.stderr, /is not one of/);
    assert.match(result.stderr, /mostly works/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
