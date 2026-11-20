import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCustomerDataPackage } from '../packages/customer-data/src/index.js';
import { CUSTOMER_COLUMNS, CUSTOMER_SORTS } from '../packages/customer-data/src/customers.js';

// backlog:d271d723: the GDPR erasure (erase-customer) joined customer-data's
// declared surface, so the package moved to version 3 (the pilot registers each
// surface's fingerprint and refuses a changed surface under an old version).
// Version 4: the erasure declares its inventory and fail-closed contract.
// Version 5: the erasure reason is a code from a closed list.
// Version 6 (backlog:c6c56dad): AI field proposal and fill joined the
// declared surface (propose-field-from-question, fill-ai-field-values).
// Version 7 (backlog:e80c6aee42c5): the contact-fit score joined the list
// surface (punteggio column, fit sort, spaceId-scored reads).
// Version 8 (review agent-crm#987 P1): the scorer arrives as the fitScorer
// composition option instead of an intelligence import.
test('customer-data is version 8 since the scorer became a composition option', () => {
  const pkg = createCustomerDataPackage();
  assert.equal(pkg.version, 8);
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
  assert.ok(CUSTOMER_SORTS.some((sort) => sort.id === 'fit'),
    'the version-7 surface carries the fit sort for the contact-fit score');
  assert.ok(CUSTOMER_COLUMNS.some((column) => column.id === 'punteggio'),
    'the version-7 surface carries the punteggio column for the contact-fit score');
});
