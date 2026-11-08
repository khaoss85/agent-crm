import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCustomerDataPackage } from '../packages/customer-data/src/index.js';

// backlog:d271d723: the GDPR erasure (erase-customer) joined customer-data's
// declared surface, so the package moved to version 3 (the pilot registers each
// surface's fingerprint and refuses a changed surface under an old version).
test('customer-data is version 3 since erase-customer joined its surface', () => {
  const pkg = createCustomerDataPackage();
  assert.equal(pkg.version, 3);
  assert.ok(pkg.operations.some((operation) => operation.name === 'erase-customer'),
    'the version-3 surface carries the GDPR erasure operation (erase-customer)');
});
