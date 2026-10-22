import test from 'node:test';
import assert from 'node:assert/strict';
import { startupStorageFailure } from '../packages/core/src/postgresql-bootstrap.js';

// backlog:112ff66d: a migration that failed during startup printed
// STORAGE_UNAVAILABLE with no cause, so the production diagnosis of a sealed
// space could not say which SQLSTATE stopped it.
test('a startup storage failure keeps the driver reason as a redacted cause', () => {
  const driver = Object.assign(new Error('permission denied for schema accordo, user slot_w on db.internal:5432 password=secret'), { code: '42501' });
  const failure = startupStorageFailure(driver);
  assert.equal(failure.code, 'STORAGE_UNAVAILABLE');
  assert.equal(failure.message, 'PostgreSQL startup storage failed');
  assert.deepEqual({ ...failure.cause }, { code: '42501', name: 'Error' });
  assert.ok(Object.isFrozen(failure.cause));
  const seen = JSON.stringify({ message: failure.message, cause: failure.cause, details: failure.details });
  assert.ok(!seen.includes('secret') && !seen.includes('db.internal'), 'nothing of the driver message leaks');
});

test('a startup failure without a code still names its kind', () => {
  const failure = startupStorageFailure(new TypeError('boom'));
  assert.deepEqual({ ...failure.cause }, { code: 'UNKNOWN', name: 'TypeError' });
});
