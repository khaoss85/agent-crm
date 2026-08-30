// @ts-check

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { AppError, ConflictError } from './errors.js';
import {
  quoteStorageIdentifier,
  renderPostgresqlStatement,
  requireStorageMethodKind,
  STORAGE_CONTRACT,
  STORAGE_READ_KINDS,
  STORAGE_WRITE_KINDS,
} from './storage-contract.js';
import { openTransactionScope } from './transaction-minter.js';
import { currentTransactionWitness } from './transaction-witness.js';

const { Pool, Client } = pg;

const DEFAULT_ACQUISITION_MS = 2_000;
const DEFAULT_QUERY_MS = 5_000;
const DEFAULT_LOCK_TIMEOUT_MS = 1_000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 5_000;
const SCHEMA_NAME = /^[a-z][a-z0-9_]{0,62}$/;
const CANONICAL_INT = /^-?(?:0|[1-9]\d*)$/;
const INT_OIDS = new Set([20, 21, 23, 26]);
const BOOL_OID = 16;
const TIMESTAMP_OIDS = new Set([1082, 1114, 1184]);
const PROBES = new WeakMap();
const TX_BIND = new AsyncLocalStorage();
const DESTROYED = new WeakSet();

/**
 * @typedef {{
 *   poolStorage: object,
 *   client: any,
 *   affine: object | null,
 *   closed: boolean,
 *   destroyed: boolean,
 * }} TxBind
 */

function publicUnavailable() {
  return new AppError('PostgreSQL storage is unavailable', {
    code: 'STORAGE_UNAVAILABLE',
    status: 503,
  });
}

function publicTimeout(kind) {
  return new AppError(`PostgreSQL ${kind} deadline exceeded`, {
    code: 'STORAGE_TIMEOUT',
    status: 504,
  });
}

function integerUnsafe() {
  return new AppError('PostgreSQL integer is outside JavaScript safe-integer range', {
    code: 'STORAGE_INTEGER_UNSAFE',
    status: 500,
  });
}

function connectionLost(error) {
  const code = error && typeof error === 'object' ? /** @type {any} */ (error).code : undefined;
  const message = error instanceof Error ? error.message : String(error ?? '');
  return (
    code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ECONNRESET' || code === 'ETIMEDOUT'
    || code === '57P01' || code === '08000' || code === '08003' || code === '08006' || code === '08001'
    || /connection (?:terminated|refused|ended)|client has encountered a connection|server closed the connection/i.test(message)
  );
}

/**
 * Map a driver failure to a bounded framework error. Driver messages, hosts,
 * users, passwords and URLs never leave this function.
 * @param {unknown} error
 */
function isPgDriverError(error) {
  const code = error && typeof error === 'object' ? /** @type {any} */ (error).code : undefined;
  if (typeof code !== 'string' || code.length === 0) return false;
  if (/^[0-9A-Z]{5}$/.test(code)) return true;
  return connectionLost(error);
}

function sanitizePgError(error) {
  if (error instanceof AppError) return error;
  if (error instanceof Error && !isPgDriverError(error)) return error;
  const code = error && typeof error === 'object' ? /** @type {any} */ (error).code : undefined;
  if (code === '23505') {
    return new ConflictError('The write conflicts with an existing row', { dialect: 'postgresql' });
  }
  if (code === '40001') {
    return new ConflictError('The write lost a serialization contest; retry the request', {
      transient: true, reason: 'serialization', dialect: 'postgresql',
    });
  }
  if (code === '40P01') {
    return new ConflictError('The write deadlocked; retry the request', {
      transient: true, reason: 'deadlock', dialect: 'postgresql',
    });
  }
  if (code === '57014' || code === '55P03') return publicTimeout('statement');
  if (code === '53300' || code === '53400' || code === '57P03') return publicUnavailable();
  if (code === '28P01' || code === '28000' || code === '3D000' || connectionLost(error)) {
    return publicUnavailable();
  }
  return new AppError('PostgreSQL storage failed', { code: 'STORAGE_UNAVAILABLE', status: 503 });
}

function withDeadline(promise, ms, kind) {
  if (!Number.isInteger(ms) || ms <= 0) return Promise.resolve(promise);
  /** @type {any} */
  let timer;
  const guarded = Promise.resolve(promise);
  guarded.catch(() => {});
  return Promise.race([
    guarded,
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(publicTimeout(kind)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function fromDriverInteger(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'bigint') {
    if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw integerUnsafe();
    }
    return Number(value);
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw integerUnsafe();
    return value;
  }
  if (typeof value === 'string') {
    if (!CANONICAL_INT.test(value)) throw integerUnsafe();
    const n = Number(value);
    if (!Number.isSafeInteger(n) || String(n) !== value) throw integerUnsafe();
    return n;
  }
  throw integerUnsafe();
}

function fromDriverTimestamp(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new AppError('PostgreSQL timestamp is not a valid date', {
        code: 'STORAGE_UNAVAILABLE', status: 500,
      });
    }
    return value.toISOString();
  }
  if (typeof value === 'string') return value;
  throw new AppError('PostgreSQL timestamp is not a valid date', {
    code: 'STORAGE_UNAVAILABLE', status: 500,
  });
}

function normalizeValue(value, oid) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date || TIMESTAMP_OIDS.has(oid)) return fromDriverTimestamp(value);
  if (oid === BOOL_OID || typeof value === 'boolean') return value ? 1 : 0;
  if (INT_OIDS.has(oid) || typeof value === 'bigint') return fromDriverInteger(value);
  return value;
}

function normalizeRow(row, fields) {
  if (!row) return null;
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const field of fields) {
    out[field.name] = normalizeValue(row[field.name], field.dataTypeID);
  }
  return out;
}

function bindValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'bigint') return fromDriverInteger(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw integerUnsafe();
    return value;
  }
  return value;
}

function bindParams(params) {
  return params.map((value) => bindValue(value));
}

function destroyClient(client) {
  DESTROYED.add(client);
  try {
    client.release(new Error('accordo-postgresql-client-destroyed'));
  } catch {
    try { client.release(true); } catch {
      try { client.end(); } catch { /* already gone */ }
    }
  }
}

function isPoolCheckoutTimeout(error) {
  if (error instanceof AppError && error.code === 'STORAGE_TIMEOUT') return true;
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /timeout exceeded when trying to connect/i.test(message);
}

function releaseClient(client) {
  if (DESTROYED.has(client)) return;
  try { client.release(); } catch { /* already gone */ }
}

/**
 * PostgreSQL adapter for Storage Contract v1. Raw driver access never leaves
 * this closure. The object a consumer proves a transaction against is the
 * **acquired client handle**, never this pool facade (ADR-018 addendum 8).
 *
 * @param {import('pg').Pool} pool
 * @param {{
 *   schema?: string,
 *   acquisitionDeadlineMs?: number,
 *   queryDeadlineMs?: number,
 *   lockTimeoutMs?: number,
 *   statementTimeoutMs?: number,
 * }} [options]
 */
export function createPostgresqlStorage(pool, options = {}) {
  const schema = options.schema;
  if (schema !== undefined && (typeof schema !== 'string' || !SCHEMA_NAME.test(schema))) {
    throw new AppError('PostgreSQL schema name is not a closed identifier', {
      code: 'STORAGE_STATEMENT_UNSUPPORTED', status: 500,
    });
  }
  const acquisitionDeadlineMs = options.acquisitionDeadlineMs ?? DEFAULT_ACQUISITION_MS;
  const queryDeadlineMs = options.queryDeadlineMs ?? DEFAULT_QUERY_MS;
  const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const statementTimeoutMs = options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS;
  const quotedSchema = schema ? quoteStorageIdentifier(schema, 'schema') : null;
  const checkedOut = new Set();

  /** @type {object} */
  const poolStorage = {};

  function track(client) {
    checkedOut.add(client);
    return client;
  }

  function forget(client) {
    checkedOut.delete(client);
  }

  function destroyTracked(client) {
    forget(client);
    destroyClient(client);
  }

  function releaseTracked(client) {
    forget(client);
    releaseClient(client);
  }

  async function acquire() {
    let timedOut = false;
    let settled = false;
    const pending = pool.connect();
    pending.then(
      (client) => {
        if (settled && timedOut) destroyTracked(client);
      },
      () => {},
    );
    try {
      const client = await withDeadline(pending, acquisitionDeadlineMs, 'acquisition');
      settled = true;
      track(client);
      if (client.listenerCount('error') === 0) {
        client.on('error', () => {
          destroyTracked(client);
        });
      }
      if (quotedSchema) {
        await queryOn(client, `SET search_path TO ${quotedSchema}`, []);
      }
      return client;
    } catch (error) {
      timedOut = isPoolCheckoutTimeout(error);
      settled = true;
      if (timedOut) throw publicTimeout('acquisition');
      throw error instanceof AppError ? error : sanitizePgError(error);
    }
  }

  /**
   * @param {any} client
   * @param {string} sql
   * @param {unknown[]} [params]
   */
  async function queryOn(client, sql, params = []) {
    try {
      return await withDeadline(client.query(sql, params), queryDeadlineMs, 'query');
    } catch (error) {
      const mapped = error instanceof AppError ? error : sanitizePgError(error);
      if (mapped.code === 'STORAGE_TIMEOUT' || mapped.code === 'STORAGE_UNAVAILABLE') {
        destroyTracked(client);
        const bind = /** @type {TxBind | undefined} */ (TX_BIND.getStore());
        if (bind && bind.client === client) bind.destroyed = true;
      }
      throw mapped;
    }
  }

  async function executeOn(client, statement) {
    requireStorageMethodKind('execute', statement, STORAGE_WRITE_KINDS);
    const rendered = renderPostgresqlStatement(statement);
    const result = await queryOn(client, rendered.sql, bindParams(rendered.params));
    return Object.freeze({ affectedRows: Number(result.rowCount ?? 0) });
  }

  async function maybeOneOn(client, statement) {
    requireStorageMethodKind('maybeOne', statement, STORAGE_READ_KINDS);
    const rendered = renderPostgresqlStatement(statement);
    const result = await queryOn(client, rendered.sql, bindParams(rendered.params));
    const row = result.rows[0];
    return row ? Object.freeze(normalizeRow(row, result.fields)) : null;
  }

  async function manyOn(client, statement) {
    requireStorageMethodKind('many', statement, STORAGE_READ_KINDS);
    const rendered = renderPostgresqlStatement(statement);
    const result = await queryOn(client, rendered.sql, bindParams(rendered.params));
    return result.rows.map((row) => Object.freeze(normalizeRow(row, result.fields)));
  }

  async function beginSerializable(client) {
    await queryOn(client, 'BEGIN ISOLATION LEVEL SERIALIZABLE');
    await queryOn(client, `SET LOCAL lock_timeout = '${lockTimeoutMs}ms'`);
    await queryOn(client, `SET LOCAL statement_timeout = '${statementTimeoutMs}ms'`);
  }

  async function rollbackSafely(client, primaryError) {
    try {
      await client.query('ROLLBACK');
    } catch {
      console.error('[accordo] PostgreSQL rollback failed after a storage error');
    }
    void primaryError;
  }

  async function commitOrUnknown(client) {
    try {
      await queryOn(client, 'COMMIT');
    } catch (error) {
      destroyTracked(client);
      const bind = /** @type {TxBind | undefined} */ (TX_BIND.getStore());
      if (bind && bind.client === client) bind.destroyed = true;
      const mapped = error instanceof AppError ? error : sanitizePgError(error);
      const lost = mapped.code === 'STORAGE_TIMEOUT'
        || mapped.code === 'STORAGE_UNAVAILABLE'
        || mapped.code === 'STORAGE_CLIENT_AFFINITY'
        || connectionLost(error);
      if (lost) {
        throw new AppError('PostgreSQL commit outcome is unknown', {
          code: 'COMMIT_OUTCOME_UNKNOWN', status: 503,
        });
      }
      throw mapped;
    }
  }

  function assertAffine(bind, client) {
    if (!bind || bind.closed) {
      throw new AppError('PostgreSQL transaction is closed', {
        code: 'STORAGE_TRANSACTION_CLOSED', status: 500,
      });
    }
    if (bind.client !== client || bind.destroyed) {
      throw new AppError('PostgreSQL statement is not bound to the active transaction client', {
        code: 'STORAGE_CLIENT_AFFINITY', status: 500,
      });
    }
    const current = /** @type {TxBind | undefined} */ (TX_BIND.getStore());
    if (!current || current.client !== client) {
      throw new AppError('PostgreSQL statement is not bound to the active transaction client', {
        code: 'STORAGE_CLIENT_AFFINITY', status: 500,
      });
    }
  }

  /**
   * @param {any} client
   * @param {TxBind} bind
   */
  function createAffineStorage(client, bind) {
    /** @type {any} */
    const affine = {};
    const run = {
      async execute(statement) {
        assertAffine(bind, client);
        return executeOn(client, statement);
      },
      async maybeOne(statement) {
        assertAffine(bind, client);
        return maybeOneOn(client, statement);
      },
      async many(statement) {
        assertAffine(bind, client);
        return manyOn(client, statement);
      },
      async savepoint(name, fn) {
        assertAffine(bind, client);
        const safeName = quoteStorageIdentifier(name, 'savepoint');
        await queryOn(client, `SAVEPOINT ${safeName}`);
        try {
          const result = await fn();
          await queryOn(client, `RELEASE SAVEPOINT ${safeName}`);
          return result;
        } catch (error) {
          try {
            await queryOn(client, `ROLLBACK TO SAVEPOINT ${safeName}`);
            await queryOn(client, `RELEASE SAVEPOINT ${safeName}`);
          } catch {
            /* primary error wins */
          }
          throw error;
        }
      },
      async transaction() {
        throw new AppError(
          'Nested outer transactions are not supported on one connection: actions and workflows cannot start a transaction inside another. Compose module services inside a single action instead.',
          { code: 'NESTED_TRANSACTION', status: 500 },
        );
      },
    };
    Object.assign(affine, {
      contract: STORAGE_CONTRACT,
      activeTransaction: () => currentTransactionWitness(affine),
      execute: run.execute,
      maybeOne: run.maybeOne,
      many: run.many,
      savepoint: run.savepoint,
      transaction: run.transaction,
    });
    Object.freeze(affine);
    PROBES.set(affine, { queryOn: (sql, params) => queryOn(client, sql, params), client });
    return affine;
  }

  function refusePoolDuringTx() {
    const bind = /** @type {TxBind | undefined} */ (TX_BIND.getStore());
    if (bind && bind.poolStorage === poolStorage && !bind.closed) {
      throw new AppError(
        'PostgreSQL pool storage cannot run statements while a connection-affine transaction is open; use the transaction handle',
        { code: 'STORAGE_CLIENT_AFFINITY', status: 500 },
      );
    }
  }

  async function withAutocommitWrite(fn) {
    refusePoolDuringTx();
    const client = await acquire();
    let active = false;
    try {
      await beginSerializable(client);
      active = true;
      const result = await fn(client);
      await commitOrUnknown(client);
      active = false;
      return result;
    } catch (error) {
      if (active) await rollbackSafely(client, error);
      throw error instanceof AppError ? error : sanitizePgError(error);
    } finally {
      const bind = /** @type {TxBind | undefined} */ (TX_BIND.getStore());
      if (!(bind && bind.destroyed && bind.client === client)) releaseTracked(client);
    }
  }

  async function withAutocommitRead(fn) {
    refusePoolDuringTx();
    const client = await acquire();
    try {
      return await fn(client);
    } catch (error) {
      throw error instanceof AppError ? error : sanitizePgError(error);
    } finally {
      const bind = /** @type {TxBind | undefined} */ (TX_BIND.getStore());
      if (!(bind && bind.destroyed && bind.client === client)) releaseTracked(client);
    }
  }

  async function runTransaction(fn) {
    const current = /** @type {TxBind | undefined} */ (TX_BIND.getStore());
    if (current && current.poolStorage === poolStorage && !current.closed) {
      throw new AppError(
        'Nested outer transactions are not supported on one connection: actions and workflows cannot start a transaction inside another. Compose module services inside a single action instead.',
        { code: 'NESTED_TRANSACTION', status: 500 },
      );
    }
    const client = await acquire();
    /** @type {TxBind} */
    const bind = { poolStorage, client, affine: null, closed: false, destroyed: false };
    const affine = createAffineStorage(client, bind);
    bind.affine = affine;
    let active = false;
    try {
      return await TX_BIND.run(bind, async () => {
        await beginSerializable(client);
        active = true;
        try {
          const result = await openTransactionScope(affine, () => fn(affine));
          await commitOrUnknown(client);
          active = false;
          return result;
        } catch (error) {
          if (active && !bind.destroyed) await rollbackSafely(client, error);
          throw error instanceof AppError ? error : sanitizePgError(error);
        }
      });
    } finally {
      bind.closed = true;
      if (!bind.destroyed) releaseTracked(client);
    }
  }

  function abandonCheckedOut() {
    for (const client of [...checkedOut]) destroyTracked(client);
  }

  Object.assign(poolStorage, {
    contract: STORAGE_CONTRACT,
    activeTransaction: () => null,
    async execute(statement) {
      return withAutocommitWrite((client) => executeOn(client, statement));
    },
    async maybeOne(statement) {
      return withAutocommitRead((client) => maybeOneOn(client, statement));
    },
    async many(statement) {
      return withAutocommitRead((client) => manyOn(client, statement));
    },
    async savepoint() {
      throw new AppError('PostgreSQL savepoints require an open connection-affine transaction', {
        code: 'STORAGE_SAVEPOINT_WITHOUT_TRANSACTION', status: 500,
      });
    },
    transaction: runTransaction,
    async close() {
      abandonCheckedOut();
      await pool.end();
    },
  });
  Object.freeze(poolStorage);

  PROBES.set(poolStorage, {
    pool, acquire, queryOn, destroyClient: destroyTracked, releaseClient: releaseTracked, abandonCheckedOut,
  });
  return poolStorage;
}

/**
 * Isolated PostgreSQL handle for Storage Contract tests. Not an application
 * factory: it does not compose modules, migrate the CRM schema, or replace
 * `createAccordoApp()`.
 *
 * @param {{
 *   connection?: string,
 *   ddl?: string[],
 *   max?: number,
 *   acquisitionDeadlineMs?: number,
 *   queryDeadlineMs?: number,
 *   lockTimeoutMs?: number,
 *   statementTimeoutMs?: number,
 *   schema?: string,
 * }} [options]
 */
export async function createPostgresqlDatabase(options = {}) {
  const connection = options.connection
    ?? process.env.ACCORDO_PG_TEST_URL
    ?? 'postgres://postgres@127.0.0.1:5432/accordo_test';
  const schema = options.schema ?? `accordo_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  if (!SCHEMA_NAME.test(schema)) {
    throw new AppError('PostgreSQL schema name is not a closed identifier', {
      code: 'STORAGE_STATEMENT_UNSUPPORTED', status: 500,
    });
  }
  const quoted = quoteStorageIdentifier(schema, 'schema');
  const pool = new Pool({
    connectionString: connection,
    max: options.max ?? 4,
    connectionTimeoutMillis: options.acquisitionDeadlineMs ?? DEFAULT_ACQUISITION_MS,
    idleTimeoutMillis: 10_000,
    allowExitOnIdle: true,
  });
  pool.on('error', () => {
    /* never log connection details */
  });
  let setup;
  const setupPending = pool.connect();
  let setupTimedOut = false;
  setupPending.then(
    (client) => { if (setupTimedOut) destroyClient(client); },
    () => {},
  );
  try {
    setup = await withDeadline(setupPending, options.acquisitionDeadlineMs ?? DEFAULT_ACQUISITION_MS, 'acquisition');
    await setup.query(`CREATE SCHEMA ${quoted}`);
    await setup.query(`SET search_path TO ${quoted}`);
    for (const sql of options.ddl ?? []) await setup.query(sql);
  } catch (error) {
    setupTimedOut = isPoolCheckoutTimeout(error);
    try { if (setup) setup.release(); } catch { /* ignore */ }
    try { await pool.end(); } catch { /* ignore */ }
    throw error instanceof AppError ? error : sanitizePgError(error);
  }
  setup.release();

  const storage = createPostgresqlStorage(pool, {
    schema,
    acquisitionDeadlineMs: options.acquisitionDeadlineMs ?? DEFAULT_ACQUISITION_MS,
    queryDeadlineMs: options.queryDeadlineMs ?? DEFAULT_QUERY_MS,
    lockTimeoutMs: options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
    statementTimeoutMs: options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS,
  });

  let closed = false;
  return Object.freeze({
    storage,
    adapter: 'postgresql',
    schema,
    async close() {
      if (closed) return;
      closed = true;
      const probe = PROBES.get(storage);
      try { probe?.abandonCheckedOut?.(); } catch { /* already gone */ }
      const admin = new Client({ connectionString: connection, connectionTimeoutMillis: 2000 });
      try {
        await withDeadline(admin.connect(), 2000, 'acquisition');
        await admin.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`);
      } catch {
        /* teardown is best-effort */
      } finally {
        try { await admin.end(); } catch { /* ignore */ }
      }
      try { await storage.close(); } catch {
        try { await pool.end(); } catch { /* ignore */ }
      }
    },
  });
}

/**
 * Test-only probe: run `SELECT pg_sleep($1)` through the same query-deadline
 * wrapper. Not a statement-vocabulary escape hatch and not exported from the
 * public kernel.
 *
 * @param {object} storage
 * @param {number} seconds
 */
/**
 * Test-only probe: run one SQL string on the affine client. Not a statement
 * vocabulary escape hatch and not exported from the public kernel.
 *
 * @param {object} storage
 * @param {string} sql
 * @param {unknown[]} [params]
 */
export async function probePostgresqlQuery(storage, sql, params = []) {
  const probe = PROBES.get(storage);
  if (!probe?.queryOn) {
    throw new AppError('PostgreSQL query probe requires an adapter handle', {
      code: 'STORAGE_UNAVAILABLE', status: 500,
    });
  }
  if (probe.acquire) {
    const client = await probe.acquire();
    try {
      return await probe.queryOn(client, sql, params);
    } finally {
      const bind = /** @type {TxBind | undefined} */ (TX_BIND.getStore());
      if (!(bind && bind.destroyed && bind.client === client)) {
        if (probe.releaseClient) probe.releaseClient(client);
        else try { client.release(); } catch { /* ignore */ }
      }
    }
  }
  return probe.queryOn(sql, params);
}

export async function probePostgresqlQueryDeadline(storage, seconds) {
  const probe = PROBES.get(storage);
  if (!probe) {
    throw new AppError('PostgreSQL query-deadline probe requires an adapter handle', {
      code: 'STORAGE_UNAVAILABLE', status: 500,
    });
  }
  const client = await probe.acquire();
  try {
    await probe.queryOn(client, 'SELECT pg_sleep($1)', [seconds]);
  } finally {
    const bind = /** @type {TxBind | undefined} */ (TX_BIND.getStore());
    if (!(bind && bind.destroyed && bind.client === client)) {
      if (probe.releaseClient) probe.releaseClient(client);
      else try { client.release(); } catch { /* ignore */ }
    }
  }
}

export const POSTGRESQL_DRIVER = Object.freeze({ name: 'pg', version: '8.23.0' });
