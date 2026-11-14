import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CHARACTERIZATION_SUITES } from '../../scripts/ci-touched-tests.js';
import {
  CHARACTERIZATION_BASELINES, realignAll, realignSource, serializeBaseline,
} from '../../scripts/realign-characterization-source.mjs';

/**
 * backlog:e03475513020, criterion 4: the source hashes #850 made advisory
 * realign on `main` through a normal PR, with a command that rewrites the
 * `source` map and nothing else. Whether behaviour moved is the gate of that
 * PR (the changed baseline selects its characterization suite), so this
 * command must never touch an observation, a count or the fingerprint.
 *
 * Fixture paths are invented (`packages/example/...`): no domain internal
 * appears here.
 */

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

const OLD = Object.freeze({
  'packages/example/src/a.js': 'a'.repeat(64),
  'packages/example/src/b.js': 'b'.repeat(64),
});

const document = (source = OLD) => ({
  domain: 'example',
  attachment: 'fixture',
  counts: { contractual: 1 },
  fingerprint: 'f'.repeat(64),
  limitations: ['LIMIT'],
  observations: [{ id: 'one', category: 'pricing', classification: 'contractual', surface: 'sdk', observed: { total: 100 } }],
  source: { ...source },
});

const withoutSource = ({ source: _source, ...rest }) => rest;

test('a stale source map is replaced, and nothing else in the baseline moves', () => {
  const current = { ...OLD, 'packages/example/src/b.js': 'c'.repeat(64) };
  const before = document();
  const result = realignSource(before, current);
  assert.equal(result.ok, true);
  assert.deepEqual(result.drifted, ['packages/example/src/b.js']);
  assert.deepEqual(result.baseline.source, current);
  assert.deepEqual(withoutSource(result.baseline), withoutSource(before),
    'observations, counts, limitations and fingerprint are untouched');
  assert.deepEqual(before.source, OLD, 'the input is not mutated');
});

test('a file added to or dropped from the digest set realigns too', () => {
  const current = { 'packages/example/src/a.js': OLD['packages/example/src/a.js'], 'packages/example/src/new.js': 'd'.repeat(64) };
  const result = realignSource(document(), current);
  assert.equal(result.ok, true);
  assert.deepEqual(result.drifted, ['packages/example/src/b.js', 'packages/example/src/new.js']);
  assert.deepEqual(result.baseline.source, current);
});

test('an aligned baseline is returned as it is', () => {
  const before = document();
  const result = realignSource(before, { ...OLD });
  assert.equal(result.ok, true);
  assert.deepEqual(result.drifted, []);
  assert.equal(result.baseline, before);
});

test('an absent digest is refused, never written', () => {
  const result = realignSource(document(), { ...OLD, 'packages/example/src/b.js': 'absent' });
  assert.equal(result.ok, false);
  assert.deepEqual(result.absent, ['packages/example/src/b.js']);
});

function fixtureRoot(t, documents) {
  const root = mkdtempSync(join(tmpdir(), 'realign-source-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'tests/characterization'), { recursive: true });
  const baselines = Object.entries(documents).map(([name, body]) => {
    const baseline = `tests/characterization/${name}-baseline.json`;
    writeFileSync(join(root, baseline), serializeBaseline(body));
    return { baseline, runner: `fixture:${name}` };
  });
  return { root, baselines, read: (baseline) => readFileSync(join(root, baseline), 'utf8') };
}

test('realignAll rewrites only the source lines, is idempotent, and a dry run writes nothing', async (t) => {
  const { root, baselines, read } = fixtureRoot(t, { alpha: document(), beta: document() });
  const moved = { ...OLD, 'packages/example/src/a.js': 'e'.repeat(64) };
  const fingerprints = async (entry) => (entry.runner === 'fixture:alpha' ? moved : { ...OLD });
  const beforeAlpha = read(baselines[0].baseline);
  const beforeBeta = read(baselines[1].baseline);

  const dry = await realignAll({ rootDir: root, dryRun: true, baselines, fingerprints });
  assert.equal(dry.ok, true);
  assert.deepEqual(dry.written, []);
  assert.deepEqual(dry.report.map((row) => row.drifted), [['packages/example/src/a.js'], []]);
  assert.equal(read(baselines[0].baseline), beforeAlpha, 'a dry run writes nothing');

  const first = await realignAll({ rootDir: root, baselines, fingerprints });
  assert.deepEqual(first.written, [baselines[0].baseline]);
  const afterAlpha = read(baselines[0].baseline);
  assert.equal(afterAlpha, serializeBaseline({ ...document(), source: moved }),
    'byte-identical to a full regeneration whose behaviour did not move');
  assert.deepEqual(withoutSource(JSON.parse(afterAlpha)), withoutSource(JSON.parse(beforeAlpha)));
  assert.equal(read(baselines[1].baseline), beforeBeta, 'an aligned baseline is not rewritten');
  const changedLines = afterAlpha.split('\n').filter((line, index) => line !== beforeAlpha.split('\n')[index]);
  assert.deepEqual(changedLines, [`    "packages/example/src/a.js": "${'e'.repeat(64)}",`],
    'the diff is the one moved hash line');

  const second = await realignAll({ rootDir: root, baselines, fingerprints });
  assert.deepEqual(second.written, []);
  assert.equal(read(baselines[0].baseline), afterAlpha, 'idempotent');
});

test('one refused domain writes nothing in any domain', async (t) => {
  const { root, baselines, read } = fixtureRoot(t, { alpha: document(), beta: document() });
  const before = baselines.map((entry) => read(entry.baseline));
  const fingerprints = async (entry) => (entry.runner === 'fixture:alpha'
    ? { ...OLD, 'packages/example/src/a.js': 'e'.repeat(64) }
    : { ...OLD, 'packages/example/src/b.js': 'absent' });
  const result = await realignAll({ rootDir: root, baselines, fingerprints });
  assert.equal(result.ok, false);
  assert.deepEqual(result.written, []);
  assert.deepEqual(result.report[1].absent, ['packages/example/src/b.js']);
  assert.deepEqual(baselines.map((entry) => read(entry.baseline)), before);
});

test('the command covers exactly the baselines the fast gate knows', () => {
  assert.deepEqual(
    CHARACTERIZATION_BASELINES.map((entry) => entry.baseline).sort(),
    CHARACTERIZATION_SUITES.map((suite) => suite.baseline).sort(),
    'a baseline added to CHARACTERIZATION_SUITES must be realignable too',
  );
});

test('on this tree every runner reports a digest for every source, and a dry run writes nothing', async () => {
  const before = CHARACTERIZATION_BASELINES.map((entry) => readFileSync(join(repoRoot, entry.baseline), 'utf8'));
  const result = await realignAll({ dryRun: true });
  assert.equal(result.ok, true, JSON.stringify(result.report));
  assert.deepEqual(result.written, []);
  assert.deepEqual(CHARACTERIZATION_BASELINES.map((entry) => readFileSync(join(repoRoot, entry.baseline), 'utf8')), before);
});
