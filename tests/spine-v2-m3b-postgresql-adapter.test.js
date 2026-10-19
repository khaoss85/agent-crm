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
  PG_REQUIRED,
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

test('M3B PostgreSQL adapter loads pg only where it opens a real pool', () => {
  // The static `import pg from 'pg'` used to be pinned here, so a missing
  // driver crashed at module load. That pin is exactly what made the
  // repository-truth probe environment-dependent: without `node_modules` the
  // probe could not even load the module it inspects, and the fact was
  // published as `absent` on the same code that reads `implemented` with
  // dependencies installed (backlog:4b50a89f7171). The pin's purpose —
  // `pg` stays the only driver and its absence fails loudly, never falls
  // back — survives the move and is re-asserted below; only the location of
  // the load changed. Loading the module must not need the driver; opening a
  // real pool still does.
  const source = readFileSync(new URL('../packages/core/src/postgresql-storage.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /^import pg from 'pg';$/m);
  assert.doesNotMatch(source, /from 'pg'/);
  assert.match(source, /await import\('pg'\)/);
  assert.match(source, /STORAGE_DRIVER_UNAVAILABLE/);
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
    const first = storage.transaction(async (tx) => {
      await tx.maybeOne(selectName('race'));
      releaseFirst();
      await firstHold;
      await tx.execute({
        kind: 'update', table: 'companies', values: [{ column: 'name', value: 'First' }],
        where: [{ column: 'id', op: 'eq', value: 'race' }],
      });
    });
    try {
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
    } finally {
      try { holdFirst(); } catch { /* already released */ }
      await first.catch(() => {});
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
  let acquired;
  const started = new Promise((resolve) => { acquired = resolve; });
  const first = db.storage.transaction(async () => {
    acquired();
    await hold;
  });
  try {
    await started;
    await assert.rejects(db.storage.transaction(async () => {}), (error) => {
      assert.equal(error.code, 'STORAGE_TIMEOUT');
      assertNoSecrets(error);
      return true;
    });
  } finally {
    try { release(); } catch { /* already released */ }
    await first.catch(() => {});
  }
  await db.storage.execute(insertCompany('recovered', 'Recovered'));
  assert.equal((await db.storage.maybeOne(selectName('recovered'))).name, 'Recovered');
});

test('M3B close returns while a max:1 transaction still holds its client', { timeout: 15_000 }, async (t) => {
  const db = await openPostgresqlFixture(t, { max: 1, acquisitionDeadlineMs: 200 });
  if (!db) return;
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  let acquired;
  const started = new Promise((resolve) => { acquired = resolve; });
  const first = db.storage.transaction(async () => {
    acquired();
    await hold;
  });
  await started;
  await db.close();
  try { release(); } catch { /* already released */ }
  await first.catch(() => {});
});

test('M3B database open bounds setup statements instead of hanging', { timeout: 15_000 }, async (t) => {
  // Setup DDL used to wait without any deadline: on a half-dead connection
  // the file never settles and reads as stuck-idle (no CPU, idle PG) instead
  // of failing fast (backlog:b705667ad23b).
  const started = Date.now();
  const outcome = await createPostgresqlDatabase({
    ddl: ['SELECT pg_sleep(5)'], acquisitionDeadlineMs: 300, max: 1,
  }).then(
    async (db) => { await db.close().catch(() => {}); return 'opened'; },
    (error) => error,
  );
  if (outcome === 'opened') assert.fail('setup DDL outlived the acquisition deadline');
  if (outcome.code === 'STORAGE_UNAVAILABLE') {
    if (!PG_REQUIRED) { t.skip('PostgreSQL 16 is not reachable locally'); return; }
    throw outcome;
  }
  assert.equal(outcome.code, 'STORAGE_TIMEOUT');
  assert.ok(Date.now() - started < 4000, `setup wait took ${Date.now() - started}ms`);
});

test('M3B timed-out setup drops the schema it already created', { timeout: 15_000 }, async (t) => {
  // A later setup statement can time out after CREATE SCHEMA has committed.
  // Creation then rejects without a handle, so the setup path itself must
  // drop the orphan schema: callers could never close() it away.
  const schema = `accordo_setup_timeout_${Date.now().toString(36)}`;
  const outcome = await createPostgresqlDatabase({
    schema,
    ddl: ['SELECT pg_sleep(5)'], acquisitionDeadlineMs: 300, max: 1,
  }).then(
    async (db) => { await db.close().catch(() => {}); return 'opened'; },
    (error) => error,
  );
  if (outcome === 'opened') assert.fail('setup DDL outlived the acquisition deadline');
  if (outcome.code === 'STORAGE_UNAVAILABLE') {
    if (!PG_REQUIRED) { t.skip('PostgreSQL 16 is not reachable locally'); return; }
    throw outcome;
  }
  assert.equal(outcome.code, 'STORAGE_TIMEOUT');
  const admin = new pg.Client({ connectionString: PG_TEST_URL, connectionTimeoutMillis: 2000 });
  await admin.connect();
  try {
    const found = await admin.query('SELECT 1 AS orphan FROM pg_namespace WHERE nspname = $1', [schema]);
    assert.equal(found.rowCount, 0, `timed-out setup left schema ${schema} behind`);
  } finally {
    await admin.end();
  }
});

test('M3B timed-out CREATE SCHEMA leaves no orphan schema behind', { timeout: 15_000 }, async (t) => {
  // A CREATE SCHEMA can time out on the client after committing on the
  // server: the client sees STORAGE_TIMEOUT for a schema that exists. The
  // old cleanup ran only when the CREATE was observed succeeding and left
  // that schema orphaned (backlog:a23d9cd02b8f). Delay the CREATE response
  // past the setup deadline while the server commits immediately, then prove
  // the setup path still drops the schema and names the setup phase.
  const schema = `accordo_setup_create_${Date.now().toString(36)}`;
  const originalQuery = pg.Client.prototype.query;
  pg.Client.prototype.query = /** @type {any} */ (function (/** @type {any} */ queryText, /** @type {any[]} */ ...rest) {
    const sql = typeof queryText === 'string' ? queryText : queryText?.text;
    const result = originalQuery.apply(this, [queryText, ...rest]);
    if (typeof sql === 'string' && sql.startsWith('CREATE SCHEMA')) {
      return result.then(
        (value) => new Promise((resolve) => { setTimeout(() => resolve(value), 600); }),
        (error) => new Promise((resolve, reject) => { setTimeout(() => reject(error), 600); }),
      );
    }
    return result;
  });
  let outcome;
  try {
    outcome = await createPostgresqlDatabase({
      schema,
      ddl: [], acquisitionDeadlineMs: 150, max: 1,
    }).then(
      async (db) => { await db.close().catch(() => {}); return 'opened'; },
      (error) => error,
    );
  } finally {
    pg.Client.prototype.query = originalQuery;
  }
  if (outcome === 'opened') assert.fail('CREATE SCHEMA outlived the setup deadline');
  if (outcome.code === 'STORAGE_UNAVAILABLE') {
    if (!PG_REQUIRED) { t.skip('PostgreSQL 16 is not reachable locally'); return; }
    throw outcome;
  }
  assert.equal(outcome.code, 'STORAGE_TIMEOUT');
  assert.match(String(outcome.message), /setup deadline exceeded/);
  const admin = new pg.Client({ connectionString: PG_TEST_URL, connectionTimeoutMillis: 2000 });
  await admin.connect();
  try {
    const found = await admin.query('SELECT 1 AS orphan FROM pg_namespace WHERE nspname = $1', [schema]);
    assert.equal(found.rowCount, 0, `timed-out CREATE left schema ${schema} behind`);
  } finally {
    await admin.end();
  }
});

test('M3B setup failure never drops a pre-existing schema', { timeout: 30_000 }, async (t) => {
  // Cleanup once dropped any schema the setup touched: after a fast CREATE
  // failure on a pre-existing schema (duplicate_schema) the catch still ran
  // DROP SCHEMA CASCADE and deleted live data (review of #273 head c695163,
  // P1). Cleanup now only removes a schema this setup may have created, so a
  // failure at any setup step must leave a pre-existing schema and its rows
  // alone, while a fresh schema that fails later is still removed
  // (backlog:a23d9cd02b8f).
  const admin = new pg.Client({ connectionString: PG_TEST_URL, connectionTimeoutMillis: 2000 });
  try {
    await admin.connect();
  } catch (error) {
    if (!PG_REQUIRED) { t.skip('PostgreSQL 16 is not reachable locally'); return; }
    throw error;
  }
  const stamp = Date.now().toString(36);
  const lived = `accordo_setup_pre_${stamp}`;
  const fresh = `accordo_setup_fresh_${stamp}`;
  const rowCount = async (name) => {
    const found = await admin.query(`SELECT COUNT(*)::int AS n FROM "${name}".keep`);
    return Number(found.rows[0].n);
  };
  const schemaExists = async (name) => {
    const found = await admin.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [name]);
    return (found.rowCount ?? 0) > 0;
  };
  try {
    await admin.query(`CREATE SCHEMA "${lived}"`);
    await admin.query(`CREATE TABLE "${lived}".keep (id int PRIMARY KEY)`);
    await admin.query(`INSERT INTO "${lived}".keep (id) VALUES (1)`);
    // Step 1, fast CREATE failure: the schema already exists, so CREATE
    // fails with duplicate_schema and cleanup must stay hands-off.
    const duplicate = await createPostgresqlDatabase({
      schema: lived, ddl: [], acquisitionDeadlineMs: 300, max: 1,
    }).then(
      async (db) => { await db.close().catch(() => {}); return 'opened'; },
      (error) => error,
    );
    assert.notEqual(duplicate, 'opened', 'CREATE on a pre-existing schema must fail');
    assert.equal(await rowCount(lived), 1, 'fast CREATE failure dropped a live row');
    // Step 1, CREATE timeout on a pre-existing schema: the outcome is
    // unknown to the client, but the pre-probe saw the schema, so cleanup
    // still stays hands-off.
    const originalQuery = pg.Client.prototype.query;
    pg.Client.prototype.query = /** @type {any} */ (function (/** @type {any} */ queryText, /** @type {any[]} */ ...rest) {
      const sql = typeof queryText === 'string' ? queryText : queryText?.text;
      const result = originalQuery.apply(this, [queryText, ...rest]);
      if (typeof sql === 'string' && sql.startsWith('CREATE SCHEMA')) {
        return result.then(
          (value) => new Promise((resolve) => { setTimeout(() => resolve(value), 600); }),
          (error) => new Promise((resolve, reject) => { setTimeout(() => reject(error), 600); }),
        );
      }
      return result;
    });
    let timedOut;
    try {
      timedOut = await createPostgresqlDatabase({
        schema: lived, ddl: [], acquisitionDeadlineMs: 150, max: 1,
      }).then(
        async (db) => { await db.close().catch(() => {}); return 'opened'; },
        (error) => error,
      );
    } finally {
      pg.Client.prototype.query = originalQuery;
    }
    if (timedOut === 'opened') assert.fail('CREATE SCHEMA outlived the setup deadline');
    if (timedOut.code === 'STORAGE_UNAVAILABLE') {
      if (!PG_REQUIRED) { t.skip('PostgreSQL 16 is not reachable locally'); return; }
      throw timedOut;
    }
    assert.equal(timedOut.code, 'STORAGE_TIMEOUT');
    assert.equal(await rowCount(lived), 1, 'timed-out CREATE dropped a live row');
    // Step 2, later failure on a fresh schema: this schema IS ours, so the
    // injected SET failure must still clean it up (no over-correction).
    const originalSetQuery = pg.Client.prototype.query;
    pg.Client.prototype.query = /** @type {any} */ (function (/** @type {any} */ queryText, /** @type {any[]} */ ...rest) {
      const sql = typeof queryText === 'string' ? queryText : queryText?.text;
      if (typeof sql === 'string' && sql.startsWith('SET search_path')) {
        throw new Error('injected SET search_path failure');
      }
      return originalSetQuery.apply(this, [queryText, ...rest]);
    });
    let setFailed;
    try {
      setFailed = await createPostgresqlDatabase({
        schema: fresh, ddl: [], acquisitionDeadlineMs: 300, max: 1,
      }).then(
        async (db) => { await db.close().catch(() => {}); return 'opened'; },
        (error) => error,
      );
    } finally {
      pg.Client.prototype.query = originalSetQuery;
    }
    assert.notEqual(setFailed, 'opened', 'injected SET failure must fail setup');
    assert.equal(await schemaExists(fresh), false, `failed setup left fresh schema ${fresh} behind`);
  } finally {
    await admin.query(`DROP SCHEMA IF EXISTS "${lived}" CASCADE`).catch(() => {});
    await admin.query(`DROP SCHEMA IF EXISTS "${fresh}" CASCADE`).catch(() => {});
    await admin.end();
  }
});

test('M3B query deadline destroys a black-holed client and recovers', { timeout: 15_000 }, async (t) => {
  const db = await openPostgresqlFixture(t, { queryDeadlineMs: 80, max: 2 });
  if (!db) return;
  await assert.rejects(probePostgresqlQueryDeadline(db.storage, 2), (error) => {
    assert.equal(error.code, 'STORAGE_TIMEOUT');
    assertNoSecrets(error);
    return true;
  });
  // Recovery runs on the same 80ms-deadline handle that just destroyed a
  // client. The pool must serve the very next write: one fixed id, one
  // attempt, no retry loop with a fresh id per attempt (backlog:a23d9cd02b8f).
  // A fresh id per attempt passes as long as any of ten writes succeeds and
  // can hide a pool that never recovers. COMMIT_OUTCOME_UNKNOWN is the only
  // acceptable ambiguity — the write may have applied, so confirm it by
  // reading the same id back instead of writing again. Anything else
  // rethrows: real defects must stay red.
  const recoveredId = 'after-timeout';
  try {
    await db.storage.execute(insertCompany(recoveredId, 'Alive'));
  } catch (error) {
    if (error?.code !== 'COMMIT_OUTCOME_UNKNOWN') throw error;
  }
  assert.equal(
    (await db.storage.maybeOne(selectName(recoveredId)))?.name,
    'Alive',
    'pool did not recover after the black-holed client was destroyed',
  );
});

test('M3B lock_timeout maps to STORAGE_TIMEOUT without leaking the URL', { timeout: 15_000 }, async (t) => {
  const db = await openPostgresqlFixture(t, { lockTimeoutMs: 150, max: 2 });
  if (!db) return;
  await db.storage.execute(insertCompany('locked', 'Lock'));
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
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
  try {
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
  } finally {
    try { release(); } catch { /* already released */ }
    await holder.catch(() => {});
  }
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
