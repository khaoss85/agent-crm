import test from 'node:test';
import assert from 'node:assert/strict';

import { createPostgresqlStorage } from '../packages/core/src/postgresql-storage.js';

/**
 * The presti-group compose failure (backlog:112ff66d) printed
 * `STORAGE_UNAVAILABLE` with no SQLSTATE and no chain: `sanitizePgError`
 * mapped the driver error to a new public error and dropped it, so the
 * diagnosis had nothing to print. The public message stays bounded — no
 * driver text, host, user or URL ever enters it — but the original error
 * must survive as `cause`, so a diagnostic layer can walk the chain and
 * print safe tokens (code/name per level) from it.
 */
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

function driverError(code) {
  return Object.assign(new Error(`driver refused (${code})`), { code });
}

test('an authentication refusal keeps the driver error as cause', async () => {
  const driver = driverError('28P01');
  const storage = createPostgresqlStorage(failingPool({ connectError: driver }));

  await assert.rejects(
    () => storage.many({ kind: 'select', table: 'companies', columns: '*' }),
    (error) => {
      assert.equal(error.code, 'STORAGE_UNAVAILABLE');
      assert.equal(error.cause, driver);
      return true;
    },
  );
});

test('a lost connection mid-query keeps the driver error as cause', async () => {
  const driver = Object.assign(new Error('server closed the connection'), { code: 'ECONNRESET' });
  const storage = createPostgresqlStorage(failingPool({ queryError: driver }));

  await assert.rejects(
    () => storage.many({ kind: 'select', table: 'companies', columns: '*' }),
    (error) => {
      assert.equal(error.code, 'STORAGE_UNAVAILABLE');
      assert.equal(error.cause, driver);
      return true;
    },
  );
});

test('an unmapped SQLSTATE keeps the driver error as cause', async () => {
  const driver = driverError('XX000');
  const storage = createPostgresqlStorage(failingPool({ connectError: driver }));

  await assert.rejects(
    () => storage.many({ kind: 'select', table: 'companies', columns: '*' }),
    (error) => {
      assert.equal(error.code, 'STORAGE_UNAVAILABLE');
      assert.equal(error.cause, driver);
      return true;
    },
  );
});

test('a statement timeout keeps the deadline error as cause of the public timeout', async () => {
  const driver = driverError('57014');
  const storage = createPostgresqlStorage(failingPool({ queryError: driver }));

  await assert.rejects(
    () => storage.many({ kind: 'select', table: 'companies', columns: '*' }),
    (error) => {
      assert.equal(error.code, 'STORAGE_TIMEOUT');
      assert.equal(error.cause, driver);
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
