import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createPostgresqlPool,
  createPostgresqlStorage,
} from '../packages/core/src/postgresql-storage.js';
import { classifyEnvironmentGap } from '../scripts/repo-truth.js';

/**
 * The `pg` driver is a pool-opening dependency, not a module-loading one.
 * Importing this file IS the first assertion: before the driver loaded
 * lazily, merely importing the storage seam threw `Cannot find package 'pg'`
 * in a checkout without `node_modules`, so every test in this file — and the
 * repository-truth probe's read-only leg — failed before proving anything.
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

test('the read-only seam refuses before SQL with an injected pool and no driver', async () => {
  const pool = screamingPool();
  const storage = createPostgresqlStorage(/** @type {any} */ (pool), { schema: 'accordo', readOnly: true });

  await assert.rejects(
    () => storage.execute({ kind: 'insert', table: 'companies', values: { id: 'c1' } }),
    (error) => error.code === 'STORAGE_READ_ONLY' && pool.touched.length === 0,
  );
});

test('opening a real pool without the driver is a typed refusal, not a loader failure', async () => {
  let pgPresent = true;
  try {
    await import('pg');
  } catch {
    pgPresent = false;
  }
  // With the driver installed this seam cannot be exercised without
  // connecting; the refusal is pinned by the no-dependency run of this same
  // file instead — the same early-return shape the live-database tests use.
  if (pgPresent) return;
  assert.throws(
    () => createPostgresqlPool({ host: '127.0.0.1', database: 'probe', user: 'probe', password: '' }),
    (error) => error.code === 'STORAGE_UNAVAILABLE',
  );
});

/**
 * A probe that cannot load its modules for lack of an environment package has
 * established nothing: the fact is undetermined, with the reason, rather
 * than absent. Only a missing *package* (a bare specifier) is an environment
 * gap — any other load failure keeps the strict negative reading.
 */

test('a missing package is an environment gap, with the reason', () => {
  const error = Object.assign(
    new Error("Cannot find package 'pg' imported from /checkout/packages/core/src/postgresql-storage.js"),
    { code: 'ERR_MODULE_NOT_FOUND' },
  );
  assert.deepEqual(classifyEnvironmentGap(error), {
    undetermined: true,
    reason: "environment lacks package 'pg'",
  });
});

test('a generic failure is not an environment gap', () => {
  assert.deepEqual(classifyEnvironmentGap(new Error('boom')), { undetermined: false, reason: null });
  assert.deepEqual(classifyEnvironmentGap(undefined), { undetermined: false, reason: null });
});

test('a missing file is not an environment gap', () => {
  const error = Object.assign(
    new Error("Cannot find module '/checkout/packages/core/src/missing.js' imported from /checkout/x.js"),
    { code: 'ERR_MODULE_NOT_FOUND' },
  );
  assert.deepEqual(classifyEnvironmentGap(error), { undetermined: false, reason: null });
});
