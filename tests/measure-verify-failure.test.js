// @ts-check

/**
 * The verify child can die without reporting a failing test (killed from the
 * outside under machine pressure). The CI log then shows a truncated mid-line
 * dump and exit 1 with no named cause — which reads exactly like a red suite.
 * These tests pin the diagnosis line so the two cases stay distinguishable.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { failingTestLines, formatVerifyFailure } from '../scripts/measure-suite.js';

test('an externally killed suite names the signal and clears the tests', () => {
  const line = formatVerifyFailure({ status: null, signal: 'SIGKILL' });
  assert.match(line, /signal=SIGKILL/);
  assert.match(line, /without reporting a failing test/);
  assert.match(line, /suspect the machine/);
});

test('a red suite names its exit code and stays silent about the machine', () => {
  const line = formatVerifyFailure({ status: 1, signal: null });
  assert.match(line, /exit=1/);
  assert.doesNotMatch(line, /suspect the machine/);
});

test('a spawn failure names the spawn error', () => {
  const line = formatVerifyFailure({ status: null, signal: null, error: new Error('spawn npm ENOBUFS') });
  assert.match(line, /spawn npm ENOBUFS/);
});

test('the failing test lines are picked out of the run, in order and once', () => {
  const output = [
    '✔ a passing test (1ms)',
    '✖ the outbox drains in order (12ms)',
    '  AssertionError: expected 2',
    'not ok 7 - a TAP failure',
    '✖ the outbox drains in order (12ms)',
  ].join('\n');
  assert.deepEqual(failingTestLines(output), [
    '✖ the outbox drains in order (12ms)',
    'not ok 7 - a TAP failure',
  ]);
});

test('a green or truncated output names no failing test', () => {
  assert.deepEqual(failingTestLines('✔ one (1ms)\n✔ concurrent buffered sc'), []);
});
