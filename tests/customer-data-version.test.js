import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCustomerDataPackage } from '../packages/customer-data/src/index.js';

// backlog:be9dd6c0c89f: agent-crm#668 added unmerge to customer-data's declared
// surface, so the package moved to version 2 (the pilot registers each surface's
// fingerprint and refuses a changed surface under an old version).
test('customer-data is version 2 since unmerge joined its surface', () => {
  const pkg = createCustomerDataPackage();
  assert.equal(pkg.version, 2);
  assert.ok(pkg.actions.some((action) => action.name === 'unlink-canonical-identity'),
    'the version-2 surface carries the unmerge action (unlink-canonical-identity)');
});
