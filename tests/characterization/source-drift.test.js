import test from 'node:test';
import assert from 'node:assert/strict';

import { compareToBaseline } from './characterization-contract.mjs';
import {
  classifySourceDrift, driftedSourceFiles, formatBlockingDrift, formatDriftAdvisory,
} from './source-drift.mjs';

/**
 * The new gate proof for backlog:e0347551: a source hash that moves without
 * moving any observed value is an advisory, never a failure — and a moved
 * observed value without a regenerated baseline still fails.
 *
 * These cases run against the real `compareToBaseline` with small fixture
 * documents, so they prove the wiring of the gate rather than a rewording
 * of it. Fixture paths are invented (`packages/example/...`): no domain
 * internal may appear here, quoted or not — the wiring seam of every domain
 * stays owned by its harness.
 */

const SOURCE = Object.freeze({
  'packages/example/src/a.js': 'a'.repeat(64),
  'packages/example/src/b.js': 'b'.repeat(64),
});

const contract = (id, observed) => ({
  id, category: 'pricing', classification: 'contractual', surface: 'sdk', observed,
});

const baselineOf = (observations, source = SOURCE) => ({ source: { ...source }, observations });

const freshOf = (observations) => observations;

test('identical hashes and identical observations are neither blocking nor advisory', () => {
  const observations = [contract('one', { total: 100 })];
  const verdict = classifySourceDrift({
    baselineSource: { ...SOURCE },
    current: { ...SOURCE },
    comparison: compareToBaseline(baselineOf(observations), freshOf(observations)),
  });
  assert.equal(verdict.blocking, false);
  assert.equal(verdict.advisory, false);
  assert.deepEqual(verdict.drifted, []);
});

test('a hash-only drift is advisory, never blocking', () => {
  const observations = [contract('one', { total: 100 })];
  const current = { ...SOURCE, 'packages/example/src/a.js': 'c'.repeat(64) };
  const verdict = classifySourceDrift({
    baselineSource: { ...SOURCE },
    current,
    comparison: compareToBaseline(baselineOf(observations), freshOf(observations)),
  });
  assert.equal(verdict.blocking, false);
  assert.equal(verdict.advisory, true);
  assert.deepEqual(verdict.drifted, ['packages/example/src/a.js']);
});

test('a moved observed value stays blocking even when every hash matches', () => {
  // The acceptance direction that must never go quiet: behaviour changed,
  // baseline not regenerated — the gate fails on the value, not on the hash.
  const before = [contract('one', { total: 100 })];
  const after = [contract('one', { total: 101 })];
  const verdict = classifySourceDrift({
    baselineSource: { ...SOURCE },
    current: { ...SOURCE },
    comparison: compareToBaseline(baselineOf(before), freshOf(after)),
  });
  assert.equal(verdict.blocking, true);
  assert.equal(verdict.advisory, false);
  assert.deepEqual(verdict.changed.map((entry) => entry.id), ['one']);
});

test('a moved value stays blocking when the hashes drifted too', () => {
  const before = [contract('one', { total: 100 })];
  const after = [contract('one', { total: 101 })];
  const verdict = classifySourceDrift({
    baselineSource: { ...SOURCE },
    current: { ...SOURCE, 'packages/example/src/b.js': 'd'.repeat(64) },
    comparison: compareToBaseline(baselineOf(before), freshOf(after)),
  });
  assert.equal(verdict.blocking, true);
  assert.equal(verdict.advisory, false);
  assert.deepEqual(verdict.drifted, ['packages/example/src/b.js']);
});

test('a missing observation is blocking, with or without hash drift', () => {
  const before = [contract('one', { total: 100 }), contract('two', { total: 200 })];
  const after = [contract('one', { total: 100 })];
  const clean = classifySourceDrift({
    baselineSource: { ...SOURCE },
    current: { ...SOURCE },
    comparison: compareToBaseline(baselineOf(before), freshOf(after)),
  });
  assert.equal(clean.blocking, true);
  assert.deepEqual(clean.missing, ['two']);
  const drifted = classifySourceDrift({
    baselineSource: { ...SOURCE },
    current: { ...SOURCE, 'packages/example/src/a.js': 'e'.repeat(64) },
    comparison: compareToBaseline(baselineOf(before), freshOf(after)),
  });
  assert.equal(drifted.blocking, true);
  assert.equal(drifted.advisory, false);
});

test('an absent or added file counts as drifted', () => {
  assert.deepEqual(
    driftedSourceFiles({ ...SOURCE }, { 'packages/example/src/a.js': 'a'.repeat(64) }),
    ['packages/example/src/b.js'],
  );
  assert.deepEqual(
    driftedSourceFiles({ ...SOURCE }, { ...SOURCE, 'packages/example/src/c.js': 'f'.repeat(64) }),
    ['packages/example/src/c.js'],
  );
  assert.deepEqual(driftedSourceFiles({ ...SOURCE }, { ...SOURCE }), []);
});

test('the advisory names the files and the deliberate-regeneration command', () => {
  const text = formatDriftAdvisory({
    domain: 'example',
    drifted: ['packages/example/src/a.js'],
    regenerate: 'npm run characterize:example',
  });
  assert.match(text, /CHARACTERIZATION_DRIFT_ADVISORY example/);
  assert.match(text, /packages\/example\/src\/a\.js/);
  assert.match(text, /npm run characterize:example/);
  assert.match(text, /No baseline regeneration is needed/);
  assert.match(text, /never a direct push/);
});

test('the blocking detail names what moved and the deliberate fix', () => {
  const before = [contract('one', { total: 100 })];
  const after = [contract('one', { total: 101 })];
  const verdict = classifySourceDrift({
    baselineSource: { ...SOURCE },
    current: { ...SOURCE },
    comparison: compareToBaseline(baselineOf(before), freshOf(after)),
  });
  const text = formatBlockingDrift({ domain: 'example', verdict, regenerate: 'npm run characterize:example' });
  assert.match(text, /changed=\[one\]/);
  assert.match(text, /npm run characterize:example/);
});
