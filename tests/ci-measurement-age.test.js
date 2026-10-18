// @ts-check

/**
 * `ci-measurement-age.js`: the push-time signal reports how old the ledger's
 * measurement is — a notice inside the window, a warning past it, and a
 * warning (never a failure) when nothing datable exists.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MEASURE_WINDOW_HOURS,
  describeMeasurementAge,
  formatAge,
  resolveMeasuredAtMs,
  runRecordNamesLedger,
} from '../scripts/ci-measurement-age.js';

const HOUR = 3600000;
const NOW = Date.parse('2026-10-18T12:00:00Z');

test('formatAge spans read short: minutes, hours, days', () => {
  assert.equal(formatAge(30 * 1000), 'just now');
  assert.equal(formatAge(42 * 60000), '42m');
  assert.equal(formatAge(5 * HOUR + 12 * 60000), '5h 12m');
  assert.equal(formatAge(19 * 24 * HOUR + 4 * HOUR), '19d 4h');
  assert.equal(formatAge(Number.NaN), 'unknown');
  assert.equal(formatAge(-1), 'unknown');
});

test('a fresh measurement is a notice naming sha, count and age', () => {
  const { annotation, line } = describeMeasurementAge(
    { sha: 'eacce47', tests: 2413, atMs: NOW - 2 * HOUR },
    { nowMs: NOW, windowHours: 6 },
  );
  assert.equal(annotation, 'notice');
  assert.match(line, /eacce47/);
  assert.match(line, /2413 tests/);
  assert.match(line, /2h 0m/);
  assert.match(line, /inside the 6h measure window/);
});

test('a measurement past the window warns and points at the scheduled run', () => {
  const { annotation, line } = describeMeasurementAge(
    { sha: 'eacce47', tests: 2413, atMs: NOW - 30 * HOUR },
    { nowMs: NOW, windowHours: 6 },
  );
  assert.equal(annotation, 'warning');
  assert.match(line, /past the 6h measure window/);
  assert.match(line, /scheduled run re-measures/);
});

test('an undatable ledger warns instead of failing the push', () => {
  for (const record of [{}, { sha: 'eacce47' }, { sha: 'eacce47', atMs: Number.NaN }]) {
    const { annotation, line } = describeMeasurementAge(record, { nowMs: NOW, windowHours: 6 });
    assert.equal(annotation, 'warning');
    assert.match(line, /no dated measurement/);
  }
});

test('the window constant matches the workflow schedule it mirrors', () => {
  assert.equal(MEASURE_WINDOW_HOURS, 6);
});

test('the run timestamp dates the tree, with no git and no clock', () => {
  const sha40 = '16a5299fda2bd85eaa76bc4baadbce06ac869bde';
  const runAt = NOW - 30 * 60000;
  assert.equal(resolveMeasuredAtMs('16a5299', { sha: sha40, measuredAt: runAt }), runAt);
  assert.equal(resolveMeasuredAtMs(sha40, { sha: '16a5299', measuredAt: runAt }), runAt);
});

test('without a run record for this tree the age is unknown, never the commit date', () => {
  // The commit date can already be nearly a window old when its first
  // measurement starts: dating from it would warn on a fresh measurement.
  const other = { sha: 'd906099d906099d906099d906099d906099d9060', measuredAt: NOW - 30 * 60000 };
  assert.equal(resolveMeasuredAtMs('16a5299', other), null);
  assert.equal(resolveMeasuredAtMs('16a5299', { sha: '16a5299', measuredAt: Number.NaN }), null);
  assert.equal(resolveMeasuredAtMs('16a5299', { sha: '16a5299', measuredAt: 0 }), null);
  assert.equal(resolveMeasuredAtMs('16a5299', {}), null);
  assert.equal(resolveMeasuredAtMs('zzzzzzz', other), null);
});

test('runRecordNamesLedger matches prefixes either way, nothing looser', () => {
  const sha40 = '16a5299fda2bd85eaa76bc4baadbce06ac869bde';
  assert.equal(runRecordNamesLedger(sha40, '16a5299'), true);
  assert.equal(runRecordNamesLedger('16a5299', sha40), true);
  assert.equal(runRecordNamesLedger(sha40, sha40), true);
  assert.equal(runRecordNamesLedger(sha40, 'd906099'), false);
  assert.equal(runRecordNamesLedger('zzzzzzz', '16a5299'), false);
  assert.equal(runRecordNamesLedger(undefined, '16a5299'), false);
});
