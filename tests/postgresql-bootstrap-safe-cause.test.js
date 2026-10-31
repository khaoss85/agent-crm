import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bootstrapPlane,
  bootstrapPostgresqlApplication,
  startupStorageFailure,
} from '../packages/core/src/postgresql-bootstrap.js';
import { createTestVerifier } from './helpers/identity-verifier-fixture.mjs';

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

// backlog:bfab36ae: the two tests above call the helper directly, so reverting
// any one of the four wired call sites (exec, connectBounded, either
// migration-transaction catch) back to a causeless throw leaves them green.
// The tests below drive each site with a scripted pool or verifier and fail
// when that site stops carrying the redacted cause.

const SECRET_MESSAGE = 'password authentication failed for user "pg-user" password=s3cret host=db.internal:5432';

function codedDriverError(code, message = SECRET_MESSAGE) {
  return Object.assign(new Error(message), { code });
}

function scriptedClient(onQuery) {
  return {
    query: async (sql, params) => onQuery(String(sql), params),
    release: () => {},
  };
}

function scriptedPool({ client = null, connectError = null } = {}) {
  return {
    connect: async () => {
      if (connectError) throw connectError;
      return client;
    },
    end: async () => {},
    on: () => {},
  };
}

const okClient = () => scriptedClient(async () => ({ rows: [] }));

function errorGraphText(error, seen = new Set()) {
  if (error === null || error === undefined) return '';
  if (typeof error !== 'object') return String(error);
  if (seen.has(error)) return '';
  seen.add(error);
  const parts = [];
  for (const key of ['message', 'stack', 'code', 'name']) {
    if (typeof error[key] === 'string') parts.push(error[key]);
  }
  if (error.cause !== undefined) parts.push(errorGraphText(error.cause, seen));
  if (error.details !== undefined) parts.push(errorGraphText(error.details, seen));
  return parts.join('\n');
}

function assertRedactedCause(error, code) {
  assert.deepEqual({ ...error.cause }, { code, name: 'Error' });
  assert.ok(Object.isFrozen(error.cause), 'the cause stays frozen');
  const text = errorGraphText(error);
  for (const needle of ['s3cret', 'db.internal', 'pg-user']) {
    assert.ok(!text.includes(needle), `nothing of the driver message leaks (${needle})`);
  }
}

function planeInput(overrides = {}) {
  return {
    plane: 'control',
    lock: { classId: 11, objectId: 22 },
    migrations: [],
    moduleMigrations: [],
    attestation: null,
    tenantId: 'acme',
    ...overrides,
  };
}

test('a COMMIT lost at startup keeps the mapped failure as cause', async () => {
  const pool = scriptedPool({
    client: scriptedClient(async (sql) => {
      if (sql === 'COMMIT') throw codedDriverError('40001');
      return { rows: [] };
    }),
  });
  await assert.rejects(
    () => bootstrapPlane(pool, planeInput()),
    (error) => {
      assert.equal(error.code, 'COMMIT_OUTCOME_UNKNOWN');
      assert.equal(error.message, 'PostgreSQL commit outcome is unknown');
      assert.equal(error.cause?.code, 'STORAGE_UNAVAILABLE');
      assertRedactedCause(error.cause, '40001');
      return true;
    },
  );
});

test('a query refused at startup surfaces the redacted cause through exec', async () => {
  const pool = scriptedPool({
    client: scriptedClient(async (sql) => {
      if (sql.includes('CREATE SCHEMA')) throw codedDriverError('42501');
      return { rows: [] };
    }),
  });
  await assert.rejects(
    () => bootstrapPlane(pool, planeInput()),
    (error) => {
      assert.equal(error.code, 'STORAGE_UNAVAILABLE');
      assert.equal(error.message, 'PostgreSQL startup storage failed');
      assertRedactedCause(error, '42501');
      return true;
    },
  );
});

test('a refused connection at startup surfaces the redacted cause through connectBounded', async () => {
  const pool = scriptedPool({
    connectError: codedDriverError('ECONNREFUSED', 'connect ECONNREFUSED db.internal:5432 user pg-user password=s3cret'),
  });
  await assert.rejects(
    () => bootstrapPlane(pool, planeInput()),
    (error) => {
      assert.equal(error.code, 'STORAGE_UNAVAILABLE');
      assert.equal(error.message, 'PostgreSQL startup storage failed');
      assertRedactedCause(error, 'ECONNREFUSED');
      return true;
    },
  );
});

test('a raw error after the schema lands is wrapped by the plane catch', async () => {
  const pool = scriptedPool({ client: okClient() });
  await assert.rejects(
    () => bootstrapPlane(pool, planeInput({
      afterSchema: () => { throw codedDriverError('XX000'); },
    })),
    (error) => {
      assert.equal(error.code, 'STORAGE_UNAVAILABLE');
      assert.equal(error.message, 'PostgreSQL startup storage failed');
      assertRedactedCause(error, 'XX000');
      return true;
    },
  );
});

test('a raw driver error from attestation is wrapped by the outer catch', async () => {
  const operations = {
    async discoverControlResource() { throw codedDriverError('XX000'); },
    async attestControlStartup() { throw new Error('unreachable'); },
    async discoverDataResource() { throw new Error('unreachable'); },
    async attestDataStartup() { throw new Error('unreachable'); },
  };
  await assert.rejects(
    () => bootstrapPostgresqlApplication({
      control: { host: '127.0.0.1', port: 1, database: 'accordo_control', user: 'u', password: 'p' },
      data: { host: '127.0.0.1', port: 1, database: 'accordo', user: 'u', password: 'p' },
      tenantId: 'acme',
      identityVerifier: { operations },
    }),
    (error) => {
      assert.equal(error.code, 'STORAGE_UNAVAILABLE');
      assert.equal(error.message, 'PostgreSQL startup storage failed');
      assertRedactedCause(error, 'XX000');
      return true;
    },
  );
});

test('a corrupt driver row inside the data transaction is wrapped by the inner catch', async () => {
  const controlPool = scriptedPool({ client: okClient() });
  const dataPool = scriptedPool({
    client: scriptedClient(async (sql) => {
      // A driver that answers the migration-ledger read with a null row:
      // the ledger walk throws a TypeError past exec, so only the inner
      // transaction catch can redact it.
      if (sql.startsWith('SELECT version, name, checksum')) return { rows: [null] };
      return { rows: [] };
    }),
  });
  await assert.rejects(
    () => bootstrapPostgresqlApplication({
      control: { host: 'db.test', port: 5432, database: 'accordo_control', user: 'u', password: 'p' },
      data: { host: 'db.test', port: 5432, database: 'accordo', user: 'u', password: 'p' },
      tenantId: 'acme',
      identityVerifier: createTestVerifier({ tenantId: 'acme' }),
      createPool: async (endpoint) => (endpoint.database === 'accordo_control' ? controlPool : dataPool),
    }),
    (error) => {
      assert.equal(error.code, 'STORAGE_UNAVAILABLE');
      assert.equal(error.message, 'PostgreSQL startup storage failed');
      assert.deepEqual({ ...error.cause }, { code: 'UNKNOWN', name: 'TypeError' });
      assert.ok(Object.isFrozen(error.cause), 'the cause stays frozen');
      return true;
    },
  );
});

// backlog:86652c075724: every refused or failed composition used to leak the
// pools whose storage was never created (each WRITER_LEASE_HELD refusal left
// a data pool with four idle connections until the process exited). The
// failure path now ends them; this test fails if it stops doing so.
test('a failed composition ends every pool, including one whose storage was never created', async () => {
  const ended = [];
  const countingPool = (name, client) => ({
    connect: async () => client,
    end: async () => { ended.push(name); },
    on: () => {},
  });
  const controlPool = countingPool('control', okClient());
  const dataPool = countingPool('data', scriptedClient(async (sql) => {
    if (sql.startsWith('SELECT version, name, checksum')) return { rows: [null] };
    return { rows: [] };
  }));
  await assert.rejects(
    () => bootstrapPostgresqlApplication({
      control: { host: 'db.test', port: 5432, database: 'accordo_control', user: 'u', password: 'p' },
      data: { host: 'db.test', port: 5432, database: 'accordo', user: 'u', password: 'p' },
      tenantId: 'acme',
      identityVerifier: createTestVerifier({ tenantId: 'acme' }),
      createPool: async (endpoint) => (endpoint.database === 'accordo_control' ? controlPool : dataPool),
    }),
    (error) => error.code === 'STORAGE_UNAVAILABLE',
  );
  assert.ok(ended.includes('control'), `the control pool is ended, saw [${ended.join(', ')}]`);
  assert.ok(ended.includes('data'), `the data pool is ended even though no data storage was created, saw [${ended.join(', ')}]`);
});
