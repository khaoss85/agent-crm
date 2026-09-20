import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveDropInsight } from '../packages/marketing/src/funnel.js';

/**
 * MK1 funnel insight derivation: the single largest relative step-to-step
 * drop, computed deterministically from one run's counts. A run with no
 * measurable drop produces no insight row — "nothing to propose from" rather
 * than a half-filled cause.
 */

test('the largest relative drop wins, in integer basis points', () => {
  const insight = deriveDropInsight({
    steps: ['visited', 'signed_up', 'activated', 'paid'],
    counts: [1000, 800, 760, 380],
  });
  assert.deepEqual(insight, {
    stepIndex: 3, step: 'paid', previousStep: 'activated',
    previousCount: 760, stepCount: 380, dropRateBps: 5000,
  });
});

test('a monotone run has no drop to diagnose, so there is no insight', () => {
  assert.equal(deriveDropInsight({ steps: ['a', 'b', 'c'], counts: [10, 10, 12] }), null);
  assert.equal(deriveDropInsight({ steps: ['a', 'b'], counts: [5, 5] }), null);
});

test('a loss from a zero count is not a measurable rate', () => {
  // 0 -> 0 carries no information; a nonzero step after zero is growth, not a drop.
  assert.equal(deriveDropInsight({ steps: ['a', 'b', 'c'], counts: [0, 0, 0] }), null);
  assert.equal(deriveDropInsight({ steps: ['a', 'b'], counts: [0, 7] }), null);
});

test('ties resolve to the earliest step, so the answer is stable', () => {
  const insight = deriveDropInsight({ steps: ['a', 'b', 'c'], counts: [100, 50, 25] });
  assert.equal(insight.step, 'b');
  assert.equal(insight.dropRateBps, 5000);
});

test('malformed runs fail closed instead of guessing', () => {
  for (const run of [
    { steps: ['only'], counts: [1] },
    { steps: ['a', 'b'], counts: [1] },
    { steps: ['a', 'b'], counts: [1, -2] },
    { steps: ['a', 'b'], counts: [1, 1.5] },
    { steps: ['a', ''], counts: [1, 0] },
    { steps: 'nope', counts: [1, 2] },
    null,
  ]) {
    assert.throws(() => deriveDropInsight(run), /must/, JSON.stringify(run));
  }
});

test('the insight is frozen: a consumer copies it, never edits it', () => {
  const insight = deriveDropInsight({ steps: ['a', 'b'], counts: [100, 40] });
  assert.ok(Object.isFrozen(insight));
});


test('safe-integer counts retain exact basis-point truncation near the numeric limit', () => {
  const insight = deriveDropInsight({ steps: ['first', 'second'], counts: [9007199254740991, 4503599627370496] });
  assert.equal(insight.dropRateBps, 4999);
});
