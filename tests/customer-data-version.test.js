import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCustomerDataPackage } from '../packages/customer-data/src/index.js';

// backlog:d271d723: the GDPR erasure (erase-customer) joined customer-data's
// declared surface, so the package moved to version 3 (the pilot registers each
// surface's fingerprint and refuses a changed surface under an old version).
// Version 4: the erasure declares its inventory and fail-closed contract.
// Version 5: the erasure reason is a code from a closed list.
// Version 6 (backlog:c6c56dad): AI field proposal and fill joined the
// declared surface (propose-field-from-question, fill-ai-field-values).
test('customer-data is version 6 since AI field proposal and fill joined the surface', () => {
  const pkg = createCustomerDataPackage();
  assert.equal(pkg.version, 6);
  assert.ok(pkg.operations.some((operation) => operation.name === 'propose-field-from-question'),
    'the version-6 surface carries the AI field proposal operation (propose-field-from-question)');
  assert.ok(pkg.operations.some((operation) => operation.name === 'fill-ai-field-values'),
    'the version-6 surface carries the AI field fill operation (fill-ai-field-values)');
  assert.ok(pkg.operations.some((operation) => operation.name === 'erase-customer'),
    'the surface carries the GDPR erasure operation (erase-customer)');
  assert.ok(Array.isArray(pkg.metadata().erasure.inventory) && pkg.metadata().erasure.inventory.length > 0,
    'the surface declares the erasure inventory');
  assert.deepEqual(pkg.metadata().erasure.reasons, ['richiesta-interessato', 'fine-rapporto', 'dati-errati', 'altro'],
    'the version-5 surface declares the closed list of reason codes');
});
