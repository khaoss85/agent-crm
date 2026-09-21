import test from 'node:test';
import assert from 'node:assert/strict';

import { createPostgresqlStorage } from '../packages/core/src/postgresql-storage.js';

/**
 * The constraint the owner stated is not "a mutation fails". It is that a
 * mutation is refused **before the first SQL** — no statement rendered, no
 * connection taken, nothing for the database to reject and nothing to roll
 * back.
 *
 * Those are two different claims and only a pool that screams when touched can
 * tell them apart. A test against a real database would pass for the weaker
 * one: a write that opens a transaction, is rejected, and rolls back leaves the
 * same rows behind as a write that never happened.
 */
function screamingPool() {
  const touched = [];
  return {
    touched,
    connect() {
      touched.push('connect');
      throw new Error('the read-only storage took a connection, which is one hop too far');
    },
    query() {
      touched.push('query');
      throw new Error('the read-only storage issued SQL, which is the thing being prevented');
    },
    async end() { touched.push('end'); },
    on() {},
  };
}

test('execute is refused with the pool untouched', async () => {
  const pool = screamingPool();
  const storage = createPostgresqlStorage(/** @type {any} */ (pool), { schema: 'accordo', readOnly: true });

  await assert.rejects(
    () => storage.execute({ kind: 'insert', table: 'companies', values: { id: 'c1' } }),
    (error) => error.code === 'STORAGE_READ_ONLY' && error.details?.method === 'execute',
  );
  assert.deepEqual(pool.touched, [], 'a refused write must not reach the pool at all');
});

test('transaction is refused with the pool untouched, and the callback never runs', async () => {
  const pool = screamingPool();
  const storage = createPostgresqlStorage(/** @type {any} */ (pool), { schema: 'accordo', readOnly: true });
  let entered = false;

  await assert.rejects(
    () => storage.transaction(async () => { entered = true; }),
    (error) => error.code === 'STORAGE_READ_ONLY' && error.details?.method === 'transaction',
  );
  assert.equal(entered, false, 'the transaction body must not run: it is where the writes are');
  assert.deepEqual(pool.touched, [], 'a refused transaction must not open one');
});

/**
 * The asymmetry is the whole design. `writerGuard` could not have expressed it:
 * it is applied uniformly to all four entry points, because holding the lease
 * is required even to read. Here reads are untouched and writes are refused, so
 * a read must reach the pool — proved by the pool complaining that it did.
 */
test('reads are not guarded, which is why this is a mode and not a guard', async () => {
  const pool = screamingPool();
  const storage = createPostgresqlStorage(/** @type {any} */ (pool), { schema: 'accordo', readOnly: true });

  await assert.rejects(
    () => storage.many({ kind: 'select', table: 'companies', columns: '*' }),
    (error) => error.code !== 'STORAGE_READ_ONLY',
  );
  assert.ok(pool.touched.includes('connect'), 'a read must be allowed through to the connection');
});

test('a writer guard and read-only together are refused rather than silently combined', () => {
  assert.throws(
    () => createPostgresqlStorage(/** @type {any} */ (screamingPool()), {
      schema: 'accordo', readOnly: true, writerGuard: () => {},
    }),
    (error) => error.code === 'STORAGE_READ_ONLY_INVALID',
  );
});

test('read-only is requested with true or not at all', () => {
  for (const value of [false, 'yes', 1, null]) {
    assert.throws(
      () => createPostgresqlStorage(/** @type {any} */ (screamingPool()), {
        schema: 'accordo', readOnly: /** @type {any} */ (value),
      }),
      (error) => error.code === 'STORAGE_READ_ONLY_INVALID',
      `readOnly: ${JSON.stringify(value)} must not be accepted as a mode`,
    );
  }
});

/**
 * The inertness twin. Every property above must cost nothing to a composition
 * that does not ask for the mode: without `readOnly`, `execute` reaches the
 * pool exactly as it did before this existed.
 */
test('storage composed without the mode behaves as it did before the mode existed', async () => {
  const pool = screamingPool();
  const storage = createPostgresqlStorage(/** @type {any} */ (pool), { schema: 'accordo' });

  await assert.rejects(
    () => storage.execute({ kind: 'insert', table: 'companies', values: { id: 'c1' } }),
    (error) => error.code !== 'STORAGE_READ_ONLY',
  );
  assert.ok(pool.touched.includes('connect'), 'the ordinary write path must still reach the pool');
});
