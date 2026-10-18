// @ts-check

/**
 * `ci-measure-guard.js`: the scheduled run measures unless the committed
 * ledger already names this head — and doubt always measures.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { decideMeasure, headAlreadyMeasured } from '../scripts/ci-measure-guard.js';

const HEAD = '16a5299fda2bd85eaa76bc4baadbce06ac869bde';

test('the recorded head needs no measure, short or full sha', () => {
  assert.equal(headAlreadyMeasured({ headSha: HEAD, recordedSha: '16a5299' }), true);
  assert.equal(headAlreadyMeasured({ headSha: HEAD, recordedSha: HEAD }), true);
  assert.equal(decideMeasure({ headSha: HEAD, recordedSha: '16a5299' }), false);
});

test('a moved head measures', () => {
  assert.equal(headAlreadyMeasured({ headSha: HEAD, recordedSha: 'd906099' }), false);
  assert.equal(decideMeasure({ headSha: HEAD, recordedSha: 'd906099' }), true);
});

test('a recorded sha that is not a prefix of the head measures', () => {
  assert.equal(headAlreadyMeasured({ headSha: HEAD, recordedSha: `${HEAD}1` }), false);
  assert.equal(headAlreadyMeasured({ headSha: HEAD, recordedSha: 'zzzzzzz' }), false);
});

test('missing or malformed values measure, never skip', () => {
  assert.equal(decideMeasure({ headSha: undefined, recordedSha: '16a5299' }), true);
  assert.equal(decideMeasure({ headSha: HEAD, recordedSha: undefined }), true);
  assert.equal(decideMeasure({ headSha: 'not-a-sha', recordedSha: '16a5299' }), true);
  assert.equal(decideMeasure({}), true);
});

test('matching is case-insensitive and trims whitespace', () => {
  assert.equal(headAlreadyMeasured({ headSha: HEAD, recordedSha: '  16A5299\n' }), true);
});
