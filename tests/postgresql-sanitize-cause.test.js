import test from 'node:test';
import assert from 'node:assert/strict';

import { createPostgresqlStorage } from '../packages/core/src/postgresql-storage.js';
import { assertNoSecrets } from './helpers/storage-contract-cases.js';

/**
 * The presti-group compose failure (backlog:112ff66d) printed
 * `STORAGE_UNAVAILABLE` with no SQLSTATE and no chain: `sanitizePgError`
 * mapped the driver error to a new public error and dropped it, so the
 * diagnosis had nothing to print. The public message stays bounded — no
 * driver text, host, user or URL ever enters it — but a redacted cause
 * survives as `{ code, name }` tokens, so a diagnostic layer can walk the
 * chain and print safe tokens (code/name per level) from it. The raw
 * driver error (message/stack may carry host, port, db user or URL) never
 * enters the error graph the leak detector walks.
 */

const SENTINEL = 'postgres://pg-user:s3cret-unavailable@127.0.0.1:1/accordo_test';

function failingPool({ connectError = null, queryError = null } = {}) {
  const client = {
    query: async () => {
      if (queryError) throw queryError;
      return { rows: [], fields: [] };
    },
    release: () => {},
    on: () => {},
    listenerCount: () => 1,
  };
  return {
    async connect() {
      if (connectError) throw connectError;
      return client;
    },
    async query() {
      return { rows: [], fields: [] };
    },
    async end() {},
    on() {},
  };
}

function driverError(code, message) {
  return Object.assign(new Error(message ?? `driver refused (${code})`), { code });
}

test('an authentication refusal keeps only redacted tokens as cause', async () => {
  const driver = driverError('28P01', 'password authentication failed for user "pg-user"');
  const storage = createPostgresqlStorage(failingPool({ connectError: driver }));

  await assert.rejects(
    () => storage.many({ kind: 'select', table: 'companies', columns: '*' }),
    (error) => {
      assert.equal(error.code, 'STORAGE_UNAVAILABLE');
      assert.equal(error.message, 'PostgreSQL storage is unavailable');
      assert.notEqual(error.cause, driver);
      assert.deepEqual(error.cause, { code: '28P01', name: 'Error' });
      assert.doesNotMatch(error.message, /pg-user|s3cret|127\.0\.0\.1/);
      assertNoSecrets(error, SENTINEL);
      return true;
    },
  );
});

test('a lost connection mid-query keeps only redacted tokens as cause', async () => {
  const driver = Object.assign(
    new Error(`failed to connect to ${SENTINEL}`),
    { code: 'ECONNRESET' },
  );
  const storage = createPostgresqlStorage(failingPool({ queryError: driver }));

  await assert.rejects(
    () => storage.many({ kind: 'select', table: 'companies', columns: '*' }),
    (error) => {
      assert.equal(error.code, 'STORAGE_UNAVAILABLE');
      assert.equal(error.message, 'PostgreSQL storage is unavailable');
      assert.notEqual(error.cause, driver);
      assert.deepEqual(error.cause, { code: 'ECONNRESET', name: 'Error' });
      assert.doesNotMatch(error.message, /pg-user|s3cret|127\.0\.0\.1|postgres:\/\//);
      assertNoSecrets(error, SENTINEL);
      return true;
    },
  );
});

test('an unmapped SQLSTATE keeps only redacted tokens as cause', async () => {
  const driver = driverError('XX000');
  const storage = createPostgresqlStorage(failingPool({ connectError: driver }));

  await assert.rejects(
    () => storage.many({ kind: 'select', table: 'companies', columns: '*' }),
    (error) => {
      assert.equal(error.code, 'STORAGE_UNAVAILABLE');
      assert.equal(error.message, 'PostgreSQL storage failed');
      assert.notEqual(error.cause, driver);
      assert.deepEqual(error.cause, { code: 'XX000', name: 'Error' });
      assertNoSecrets(error, SENTINEL);
      return true;
    },
  );
});

test('a statement timeout keeps the redacted deadline error as cause', async () => {
  const driver = driverError('57014');
  const storage = createPostgresqlStorage(failingPool({ queryError: driver }));

  await assert.rejects(
    () => storage.many({ kind: 'select', table: 'companies', columns: '*' }),
    (error) => {
      assert.equal(error.code, 'STORAGE_TIMEOUT');
      assert.equal(error.message, 'PostgreSQL statement deadline exceeded');
      assert.notEqual(error.cause, driver);
      assert.deepEqual(error.cause, { code: '57014', name: 'Error' });
      assertNoSecrets(error, SENTINEL);
      return true;
    },
  );
});

test('a codeless connection termination maps to unavailable, not raw', async () => {
  // pg@8.23.0 emits a plain `Error('Connection terminated unexpectedly')`
  // with no code when a handshake is dropped (backlog:732c0a9a5dd3). The
  // open fixture retries only bounded STORAGE_UNAVAILABLE/STORAGE_TIMEOUT,
  // so this must map instead of passing through raw.
  const driver = new Error('Connection terminated unexpectedly');
  const storage = createPostgresqlStorage(failingPool({ connectError: driver }));

  await assert.rejects(
    () => storage.many({ kind: 'select', table: 'companies', columns: '*' }),
    (error) => {
      assert.equal(error.code, 'STORAGE_UNAVAILABLE');
      assert.equal(error.message, 'PostgreSQL storage is unavailable');
      assert.notEqual(error.cause, driver);
      assert.deepEqual(error.cause, { code: 'UNKNOWN', name: 'Error' });
      assertNoSecrets(error, SENTINEL);
      return true;
    },
  );
});

test('a non-driver error still passes through untouched', async () => {
  const plain = new Error('no code, no mapping');
  const storage = createPostgresqlStorage(failingPool({ connectError: plain }));

  await assert.rejects(
    () => storage.many({ kind: 'select', table: 'companies', columns: '*' }),
    (error) => {
      assert.equal(error, plain);
      return true;
    },
  );
});

test('a pool-checkout timeout keeps the deadline error as its chain', async () => {
  const hanging = {
    async connect() { return new Promise(() => {}); },
    async query() { return { rows: [], fields: [] }; },
    async end() {},
    on() {},
  };
  const storage = createPostgresqlStorage(hanging, { acquisitionDeadlineMs: 30 });

  await assert.rejects(
    () => storage.many({ kind: 'select', table: 'companies', columns: '*' }),
    (error) => {
      assert.equal(error.code, 'STORAGE_TIMEOUT');
      assert.equal(error.message, 'PostgreSQL acquisition deadline exceeded');
      assert.ok(error.cause instanceof Error);
      assert.equal(error.cause.code, 'STORAGE_TIMEOUT');
      assertNoSecrets(error, SENTINEL);
      return true;
    },
  );
});

test('a connection loss during COMMIT keeps the mapped error as its chain', async () => {
  const commitDriver = Object.assign(
    new Error('server closed the connection unexpectedly'),
    { code: '57P01' },
  );
  const client = {
    async query(sql) {
      if (sql === 'COMMIT') throw commitDriver;
      return { rows: [], fields: [] };
    },
    release: () => {},
    on: () => {},
    listenerCount: () => 1,
  };
  const pool = {
    async connect() { return client; },
    async query() { return { rows: [], fields: [] }; },
    async end() {},
    on() {},
  };
  const storage = createPostgresqlStorage(pool);

  await assert.rejects(
    () => storage.transaction(async () => {}),
    (error) => {
      assert.equal(error.code, 'COMMIT_OUTCOME_UNKNOWN');
      assert.equal(error.message, 'PostgreSQL commit outcome is unknown');
      assert.equal(error.cause?.code, 'STORAGE_UNAVAILABLE');
      assert.deepEqual(error.cause?.cause, { code: '57P01', name: 'Error' });
      assertNoSecrets(error, SENTINEL);
      return true;
    },
  );
});
