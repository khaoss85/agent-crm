import test from 'node:test';
import assert from 'node:assert/strict';

import { createPostgresqlStorage } from '../packages/core/src/postgresql-storage.js';

/**
 * The writer guard covers reads, and the comment that said otherwise.
 *
 * `postgresql-bootstrap.js` described `writerGuard` as running "per write". It
 * does not: `assertWriter()` guards `execute`, `maybeOne`, `many` and
 * `transaction`. The difference is the whole character of an expired lease — a
 * process whose lease lapses is not degraded to read-only, it **stops**, which
 * is why the renewal loop exists and why its absence was a defect rather than a
 * slow leak.
 *
 * A comment cannot be kept true by being rewritten; this file is what keeps it
 * true. It also pins a second property the read-only work will need: **the
 * guard runs before any SQL**, which is what makes a refusal a refusal rather
 * than a rollback.
 *
 * No database. The pool below fails the test if it is ever touched, so a
 * regression that moved the guard after `acquire()` would be caught here rather
 * than in an integration run that has to be looking for it.
 */

/** A pool that is a tripwire: reaching it at all is the failure. */
function poolThatMustNotBeUsed(t) {
  return {
    connect() {
      t.diagnostic('the storage acquired a connection before the guard refused');
      throw new Error('the guard must refuse before any connection is acquired');
    },
    query() { throw new Error('the guard must refuse before any statement runs'); },
    async end() {},
  };
}

/** The refusal an expired lease produces, in the shape the bootstrap throws it. */
function expiredLease() {
  return () => {
    const error = new Error('this process does not hold an unexpired writer lease');
    /** @type {any} */ (error).code = 'WRITER_LEASE_EXPIRED';
    throw error;
  };
}

const READS = ['maybeOne', 'many'];
const WRITES = ['execute'];

test('an expired lease refuses reads as well as writes', async (t) => {
  const storage = createPostgresqlStorage(poolThatMustNotBeUsed(t), {
    schema: 'accordo',
    writerGuard: expiredLease(),
  });

  for (const operation of [...READS, ...WRITES]) {
    await assert.rejects(
      () => storage[operation]({ kind: 'select', table: 'anything', columns: ['id'] }),
      (error) => error?.code === 'WRITER_LEASE_EXPIRED',
      `${operation} must be refused: a lapsed lease stops the process, it does not demote it`,
    );
  }

  await assert.rejects(
    () => storage.transaction(async () => undefined),
    (error) => error?.code === 'WRITER_LEASE_EXPIRED',
    'a transaction must be refused before it opens',
  );
});

test('the refusal happens before any connection is acquired', async (t) => {
  // The property that makes it a refusal rather than a rollback, and the seam a
  // read-only composition would build on: nothing has been sent to the server
  // when the guard says no.
  const pool = poolThatMustNotBeUsed(t);
  let acquired = 0;
  const storage = createPostgresqlStorage(
    { ...pool, connect() { acquired += 1; return pool.connect(); } },
    { schema: 'accordo', writerGuard: expiredLease() },
  );

  await assert.rejects(() => storage.many({ kind: 'select', table: 'anything', columns: ['id'] }));
  await assert.rejects(() => storage.execute({ kind: 'insert', table: 'anything', values: [] }));
  assert.equal(acquired, 0, 'the guard ran after a connection was taken, which makes it a rollback');
});

test('with a guard that passes, the same calls reach the pool', async () => {
  // The control. Without it the test above would pass just as happily against a
  // storage that refuses everything for some other reason — which is exactly
  // the kind of green check this file exists to distrust.
  let acquired = 0;
  const storage = createPostgresqlStorage(
    {
      connect() {
        acquired += 1;
        throw new Error('reached the pool');
      },
      async end() {},
    },
    { schema: 'accordo', writerGuard: () => {} },
  );

  await assert.rejects(
    () => storage.many({ kind: 'select', table: 'anything', columns: ['id'] }),
    /reached the pool/,
  );
  assert.equal(acquired, 1);
});

test('no guard at all is still allowed, and then nothing is refused', async () => {
  // `writerGuard` is optional, and that is what a read-only composition would
  // have to change: removing the guard makes reads work and leaves writes
  // unguarded, so the option cannot simply be dropped — it has to learn the
  // difference. Pinned here because it is the current behaviour, not a wish.
  let acquired = 0;
  const storage = createPostgresqlStorage(
    { connect() { acquired += 1; throw new Error('reached the pool'); }, async end() {} },
    { schema: 'accordo' },
  );
  await assert.rejects(() => storage.execute({ kind: 'insert', table: 'anything', values: [] }), /reached the pool/);
  assert.equal(acquired, 1, 'without a guard a write is not refused; it is attempted');
});
