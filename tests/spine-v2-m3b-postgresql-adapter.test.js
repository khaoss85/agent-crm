// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import pg from 'pg';
import { TRANSACTION_PROOF, proveCallerTransaction } from '../packages/core/index.js';
import {
  createPostgresqlDatabase,
  POSTGRESQL_DRIVER,
  probePostgresqlQuery,
  probePostgresqlQueryDeadline,
} from '../packages/core/src/postgresql-storage.js';
import { STORAGE_CONTRACT } from '../packages/core/src/storage-contract.js';
import {
  assertNoSecrets,
  openPostgresqlFixture,
  PG_TEST_URL,
} from './helpers/storage-contract-cases.js';

const require = createRequire(import.meta.url);
const { Pool } = pg;

function serviceFor(storage) {
  return { database: { storage } };
}

function insertCompany(id, name) {
  return {
    kind: 'insert', table: 'companies', values: [
      { column: 'id', value: id }, { column: 'name', value: name },
      { column: 'domain', value: null }, { column: 'created_at', value: '2026-01-01T00:00:00.000Z' },
      { column: 'updated_at', value: '2026-01-01T00:00:00.000Z' },
    ],
  };
}

function selectName(id) {
  return {
    kind: 'select', table: 'companies', columns: ['name'],
    where: [{ column: 'id', op: 'eq', value: id }],
  };
}

test('M3B pins pg@8.23.0 as the only production runtime dependency', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.dependencies, { pg: '8.23.0' });
  assert.equal(manifest.dependencies['pg-native'], undefined);
  assert.equal(POSTGRESQL_DRIVER.name, 'pg');
  assert.equal(POSTGRESQL_DRIVER.version, '8.23.0');
  const installed = require('pg/package.json');
  assert.equal(installed.version, '8.23.0');
  assert.equal(installed.name, 'pg');
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  const locked = lock.packages?.['node_modules/pg'];
  assert.equal(locked?.version, '8.23.0');
  assert.equal(lock.packages?.['node_modules/pg-native'], undefined);
});

test('M3B PostgreSQL adapter never wraps import pg in try/catch', () => {
  const source = readFileSync(new URL('../packages/core/src/postgresql-storage.js', import.meta.url), 'utf8');
  assert.match(source, /^import pg from 'pg';$/m);
  assert.doesNotMatch(source, /try\s*\{[^}]*import\s+['"]pg['"]/s);
  assert.doesNotMatch(source, /try\s*\{[\s\S]*from 'pg'/);
});

test('M3B live PostgreSQL adapter', { timeout: 30_000 }, async (t) => {
  const db = await openPostgresqlFixture(t, { max: 4 });
  if (!db) return;
  const { storage } = db;
  assert.equal(storage.contract, STORAGE_CONTRACT);
  assert.equal(storage.activeTransaction(), null);

  await t.test('safe integers, booleans, nulls and timestamps match SQLite shapes', async () => {
    await storage.execute({
      kind: 'insert', table: 'integer_values', values: [
        { column: 'id', value: 'max' }, { column: 'amount', value: Number.MAX_SAFE_INTEGER },
      ],
    });
    const max = await storage.maybeOne({
      kind: 'select', table: 'integer_values', columns: ['amount'],
      where: [{ column: 'id', op: 'eq', value: 'max' }],
    });
    assert.equal(max.amount, Number.MAX_SAFE_INTEGER);
    assert.equal(typeof max.amount, 'number');
    assertNoSecrets(max);

    await storage.execute({
      kind: 'insert', table: 'integer_values', values: [
        { column: 'id', value: 'zero' }, { column: 'amount', value: 0 },
      ],
    });
    assert.equal((await storage.maybeOne({
      kind: 'select', table: 'integer_values', columns: ['amount'],
      where: [{ column: 'id', op: 'eq', value: 'zero' }],
    })).amount, 0);

    await storage.execute({
      kind: 'insert', table: 'integer_values', values: [
        { column: 'id', value: 'one' }, { column: 'amount', value: 1 },
      ],
    });
    assert.equal((await storage.maybeOne({
      kind: 'select', table: 'integer_values', columns: ['amount'],
      where: [{ column: 'id', op: 'eq', value: 'one' }],
    })).amount, 1);
    assert.equal((await storage.maybeOne({
      kind: 'count', table: 'integer_values', where: [],
    })).n, 3);

    await assert.rejects(storage.execute({
      kind: 'insert', table: 'integer_values', values: [
        { column: 'id', value: 'unsafe' }, { column: 'amount', value: Number.MAX_SAFE_INTEGER + 1 },
      ],
    }), (error) => {
      assert.equal(error.code, 'STORAGE_INTEGER_UNSAFE');
      assertNoSecrets(error);
      return true;
    });

    const planter = new Pool({ connectionString: PG_TEST_URL, max: 1, connectionTimeoutMillis: 2000 });
    t.after(() => planter.end());
    const client = await planter.connect();
    try {
      await client.query(`SET search_path TO "${db.schema}"`);
      await client.query('INSERT INTO integer_values(id, amount) VALUES ($1, $2::bigint)', ['planted-unsafe', '9007199254740993']);
    } finally {
      client.release();
    }
    await assert.rejects(storage.maybeOne({
      kind: 'select', table: 'integer_values', columns: ['amount'],
      where: [{ column: 'id', op: 'eq', value: 'planted-unsafe' }],
    }), (error) => {
      assert.equal(error.code, 'STORAGE_INTEGER_UNSAFE');
      assertNoSecrets(error);
      return true;
    });

    await storage.execute({
      kind: 'insert', table: 'flags', values: [
        { column: 'id', value: 'flag-true' }, { column: 'flag', value: true },
        { column: 'stamped', value: '2026-01-01T00:00:00.000Z' },
        { column: 'stamped_at', value: '2026-01-01T00:00:00.000Z' },
      ],
    });
    await storage.execute({
      kind: 'insert', table: 'flags', values: [
        { column: 'id', value: 'flag-false' }, { column: 'flag', value: false },
        { column: 'stamped', value: null },
        { column: 'stamped_at', value: null },
      ],
    });
    const truthy = await storage.maybeOne({
      kind: 'select', table: 'flags', columns: '*',
      where: [{ column: 'id', op: 'eq', value: 'flag-true' }],
    });
    const falsy = await storage.maybeOne({
      kind: 'select', table: 'flags', columns: '*',
      where: [{ column: 'id', op: 'eq', value: 'flag-false' }],
    });
    assert.equal(truthy.flag, 1);
    assert.equal(falsy.flag, 0);
    assert.equal(truthy.stamped, '2026-01-01T00:00:00.000Z');
    assert.equal(typeof truthy.stamped_at, 'string');
    assert.equal(truthy.stamped_at, '2026-01-01T00:00:00.000Z');
    assert.equal(truthy.stamped_at instanceof Date, false);
    assert.equal(falsy.stamped, null);
    assert.equal(falsy.stamped_at, null);
    assertNoSecrets(truthy);
    assertNoSecrets(falsy);
  });

  await t.test('connection-affine handle is distinct from the pool facade', async () => {
    await storage.execute(insertCompany('affine-1', 'Affine'));
    let affineHandle;
    await storage.transaction(async (tx) => {
      affineHandle = tx;
      assert.notEqual(tx, storage);
      assert.equal(typeof tx.activeTransaction(), 'object');
      assert.notEqual(tx.activeTransaction(), null);
      assert.equal(storage.activeTransaction(), null);
      assert.equal(proveCallerTransaction([serviceFor(tx)]), TRANSACTION_PROOF.ACTIVE);
      assert.equal(proveCallerTransaction([serviceFor(storage)]), TRANSACTION_PROOF.NO_TRANSACTION);
      await tx.execute({
        kind: 'update', table: 'companies', values: [{ column: 'name', value: 'Inside' }],
        where: [{ column: 'id', op: 'eq', value: 'affine-1' }],
      });
      assert.equal((await tx.maybeOne(selectName('affine-1'))).name, 'Inside');
      await assert.rejects(
        storage.execute({
          kind: 'update', table: 'companies', values: [{ column: 'name', value: 'Pool' }],
          where: [{ column: 'id', op: 'eq', value: 'affine-1' }],
        }),
        (error) => error?.code === 'STORAGE_CLIENT_AFFINITY',
      );
    });
    assert.equal((await storage.maybeOne(selectName('affine-1'))).name, 'Inside');
    await assert.rejects(
      affineHandle.execute(selectName('affine-1')),
      (error) => error?.code === 'STORAGE_TRANSACTION_CLOSED',
    );
    assert.equal(proveCallerTransaction([serviceFor(affineHandle)]), TRANSACTION_PROOF.NO_TRANSACTION);
  });

  await t.test('a different pooled client is refused and the same client is accepted', async () => {
    await storage.execute(insertCompany('clients', 'Clients'));
    /** @type {any} */
    let txB;
    let releaseB;
    const holdB = new Promise((resolve) => { releaseB = resolve; });
    const runB = storage.transaction(async (tx) => {
      txB = tx;
      await tx.maybeOne(selectName('clients'));
      await holdB;
      assert.equal((await tx.maybeOne(selectName('clients'))).name, 'Clients');
    });
    await storage.transaction(async (txA) => {
      while (!txB) await new Promise((resolve) => setImmediate(resolve));
      await assert.rejects(
        txB.execute({
          kind: 'update', table: 'companies', values: [{ column: 'name', value: 'Other client' }],
          where: [{ column: 'id', op: 'eq', value: 'clients' }],
        }),
        (error) => error?.code === 'STORAGE_CLIENT_AFFINITY',
      );
      await txA.execute({
        kind: 'update', table: 'companies', values: [{ column: 'name', value: 'Same client' }],
        where: [{ column: 'id', op: 'eq', value: 'clients' }],
      });
      assert.equal((await txA.maybeOne(selectName('clients'))).name, 'Same client');
      assert.equal(
        proveCallerTransaction([serviceFor(txA), serviceFor(txB)]),
        TRANSACTION_PROOF.SPLIT_STORAGE,
      );
    });
    releaseB();
    await runB;
    assert.equal((await storage.maybeOne(selectName('clients'))).name, 'Same client');
  });

  await t.test('nested savepoint rolls back only the inner work', async () => {
    await storage.execute(insertCompany('savepoint', 'Outer'));
    await storage.transaction(async (tx) => {
      await tx.execute({
        kind: 'update', table: 'companies', values: [{ column: 'name', value: 'Kept' }],
        where: [{ column: 'id', op: 'eq', value: 'savepoint' }],
      });
      await assert.rejects(tx.savepoint('inner', async () => {
        await tx.execute({
          kind: 'update', table: 'companies', values: [{ column: 'name', value: 'Discarded' }],
          where: [{ column: 'id', op: 'eq', value: 'savepoint' }],
        });
        throw new Error('inner failure');
      }), /inner failure/);
      assert.equal((await tx.maybeOne(selectName('savepoint'))).name, 'Kept');
    });
    assert.equal((await storage.maybeOne(selectName('savepoint'))).name, 'Kept');
  });

  await t.test('unique conflicts map to CONFLICT without leaking credentials', async () => {
    await storage.execute(insertCompany('unique', 'First'));
    await assert.rejects(storage.execute(insertCompany('unique', 'Second')), (error) => {
      assert.equal(error.code, 'CONFLICT');
      assertNoSecrets(error);
      return true;
    });
  });

  await t.test('SERIALIZABLE concurrent updates surface a bounded conflict', async () => {
    await storage.execute(insertCompany('race', 'Start'));
    let releaseFirst;
    const firstReady = new Promise((resolve) => { releaseFirst = resolve; });
    let holdFirst;
    const firstHold = new Promise((resolve) => { holdFirst = resolve; });
    t.after(() => { try { holdFirst(); } catch { /* already released */ } });
    const first = storage.transaction(async (tx) => {
      await tx.maybeOne(selectName('race'));
      releaseFirst();
      await firstHold;
      await tx.execute({
        kind: 'update', table: 'companies', values: [{ column: 'name', value: 'First' }],
        where: [{ column: 'id', op: 'eq', value: 'race' }],
      });
    });
    await firstReady;
    const second = storage.transaction(async (tx) => {
      await tx.maybeOne(selectName('race'));
      await tx.execute({
        kind: 'update', table: 'companies', values: [{ column: 'name', value: 'Second' }],
        where: [{ column: 'id', op: 'eq', value: 'race' }],
      });
    });
    const secondResult = second.then((value) => ({ status: 'fulfilled', value }), (reason) => ({ status: 'rejected', reason }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    holdFirst();
    const firstResult = await first.then((value) => ({ status: 'fulfilled', value }), (reason) => ({ status: 'rejected', reason }));
    const other = await secondResult;
    const rejected = [firstResult, other].filter((entry) => entry.status === 'rejected');
    assert.ok(rejected.length >= 1, 'SERIALIZABLE must refuse at least one overlapping writer');
    for (const entry of rejected) {
      assert.equal(entry.reason.code, 'CONFLICT');
      assert.equal(entry.reason.details?.transient, true);
      assertNoSecrets(entry.reason);
    }
  });

  await t.test('a held client is returned only after commit cleanup', async () => {
    const tight = await openPostgresqlFixture(t, { max: 1, acquisitionDeadlineMs: 800 });
    if (!tight) return;
    for (let index = 0; index < 3; index += 1) {
      await tight.storage.transaction(async (tx) => {
        await tx.execute(insertCompany(`reuse-${index}`, `Row ${index}`));
      });
    }
    assert.equal((await tight.storage.maybeOne({
      kind: 'count', table: 'companies', where: [],
    })).n, 3);
  });
});

test('M3B connection loss during COMMIT is unknown and the client is not recycled', { timeout: 15_000 }, async (t) => {
  const db = await openPostgresqlFixture(t, { max: 1 });
  if (!db) return;
  const admin = new Pool({ connectionString: PG_TEST_URL, max: 1, connectionTimeoutMillis: 2000 });
  t.after(() => admin.end());
  await assert.rejects(db.storage.transaction(async (tx) => {
    await tx.execute(insertCompany('terminated', 'Doomed'));
    const pid = await probePostgresqlQuery(tx, 'SELECT pg_backend_pid() AS pid');
    const backend = Number(pid.rows[0].pid);
    const killer = await admin.connect();
    try {
      await killer.query('SELECT pg_terminate_backend($1)', [backend]);
    } finally {
      killer.release();
    }
  }), (error) => {
    assert.equal(error.code, 'COMMIT_OUTCOME_UNKNOWN');
    assertNoSecrets(error);
    return true;
  });
  await db.storage.execute(insertCompany('after-kill', 'Alive'));
  assert.equal((await db.storage.maybeOne(selectName('after-kill'))).name, 'Alive');
});

test('M3B acquisition deadline destroys the waiter and recovers the pool', { timeout: 15_000 }, async (t) => {
  const db = await openPostgresqlFixture(t, { max: 1, acquisitionDeadlineMs: 200 });
  if (!db) return;
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  t.after(() => { try { release(); } catch { /* already released */ } });
  let acquired;
  const started = new Promise((resolve) => { acquired = resolve; });
  const first = db.storage.transaction(async () => {
    acquired();
    await hold;
  });
  await started;
  await assert.rejects(db.storage.transaction(async () => {}), (error) => {
    assert.equal(error.code, 'STORAGE_TIMEOUT');
    assertNoSecrets(error);
    return true;
  });
  release();
  await first;
  await db.storage.execute(insertCompany('recovered', 'Recovered'));
  assert.equal((await db.storage.maybeOne(selectName('recovered'))).name, 'Recovered');
});

test('M3B query deadline destroys a black-holed client and recovers', { timeout: 15_000 }, async (t) => {
  const db = await openPostgresqlFixture(t, { queryDeadlineMs: 80, max: 2 });
  if (!db) return;
  await assert.rejects(probePostgresqlQueryDeadline(db.storage, 2), (error) => {
    assert.equal(error.code, 'STORAGE_TIMEOUT');
    assertNoSecrets(error);
    return true;
  });
  await db.storage.execute(insertCompany('after-timeout', 'Alive'));
  assert.equal((await db.storage.maybeOne(selectName('after-timeout'))).name, 'Alive');
});

test('M3B lock_timeout maps to STORAGE_TIMEOUT without leaking the URL', { timeout: 15_000 }, async (t) => {
  const db = await openPostgresqlFixture(t, { lockTimeoutMs: 150, max: 2 });
  if (!db) return;
  await db.storage.execute(insertCompany('locked', 'Lock'));
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  t.after(() => { try { release(); } catch { /* already released */ } });
  let ready;
  const started = new Promise((resolve) => { ready = resolve; });
  const holder = db.storage.transaction(async (tx) => {
    await tx.execute({
      kind: 'update', table: 'companies', values: [{ column: 'name', value: 'Held' }],
      where: [{ column: 'id', op: 'eq', value: 'locked' }],
    });
    ready();
    await hold;
  });
  await started;
  await assert.rejects(db.storage.transaction(async (tx) => {
    await tx.execute({
      kind: 'update', table: 'companies', values: [{ column: 'name', value: 'Waiter' }],
      where: [{ column: 'id', op: 'eq', value: 'locked' }],
    });
  }), (error) => {
    assert.ok(error.code === 'STORAGE_TIMEOUT' || error.code === 'CONFLICT');
    assertNoSecrets(error);
    return true;
  });
  release();
  await holder;
});

test('M3B connection failure with sentinel credentials never echoes them', async () => {
  const sentinel = 'postgres://pg-user:s3cret-unavailable@127.0.0.1:1/accordo_test';
  await assert.rejects(createPostgresqlDatabase({
    connection: sentinel,
    acquisitionDeadlineMs: 400,
    ddl: [],
  }), (error) => {
    assert.ok(error.code === 'STORAGE_UNAVAILABLE' || error.code === 'STORAGE_TIMEOUT');
    assertNoSecrets(error, sentinel);
    assert.doesNotMatch(String(error.message), /pg-user|s3cret/);
    return true;
  });
});
