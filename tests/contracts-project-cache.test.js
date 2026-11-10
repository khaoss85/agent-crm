// @ts-check

/**
 * The contracts-project template cache key (backlog:3d560518f3e2): one build
 * per option set, whatever order the options were written in.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { stableKey } from './helpers/contracts-project.js';

test('the project cache key is stable at every depth and tells real differences apart', () => {
  assert.equal(
    stableKey({ withWork: true, priceRules: { b: 2, a: { y: 1, x: 0 } } }),
    stableKey({ priceRules: { a: { x: 0, y: 1 }, b: 2 }, withWork: true }),
  );
  assert.equal(stableKey({ withDomain: undefined }), stableKey({}));
  assert.notEqual(stableKey({ withWork: true }), stableKey({ withWork: false }));
  assert.notEqual(stableKey({ priceRules: { a: 1 } }), stableKey({ priceRules: { a: 2 } }));
  assert.notEqual(stableKey({ priceRules: [1, 2] }), stableKey({ priceRules: [2, 1] }));
});
