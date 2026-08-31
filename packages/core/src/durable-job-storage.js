// @ts-check

import { AppError } from './errors.js';
import { proveCallerTransaction, TRANSACTION_PROOF } from './transaction-witness.js';

/** Private adapter registry. Raw drivers never cross this file boundary. */
const DURABLE_JOB_STORAGE = new WeakMap();
const DURABLE_JOB_OWNER = new WeakMap();
const DURABLE_JOB_TRANSACTION_AUTHORITY = new WeakMap();

export function registerDurableJobStorageOwner(storage, owner) {
  DURABLE_JOB_OWNER.set(storage, owner);
}

export function durableJobStorageOwnerFor(storage) {
  const owner = DURABLE_JOB_OWNER.get(storage);
  if (!owner) {
    throw new AppError('Storage does not provide durable-job transaction identity', {
      code: 'DURABLE_JOB_STORAGE_UNAVAILABLE', status: 500,
    });
  }
  return owner;
}

/** Bind a callback-only transaction handle to the storage witness it must prove. */
export function registerDurableJobTransactionAuthority(transaction, authority) {
  DURABLE_JOB_TRANSACTION_AUTHORITY.set(transaction, authority);
}

export function assertActiveDurableJobTransaction(transaction) {
  if (!transaction || (typeof transaction !== 'object' && typeof transaction !== 'function')) {
    throw new AppError('Durable-job transactional enqueue requires a live transaction handle', {
      code: 'DURABLE_JOB_TRANSACTION_REQUIRED', status: 500,
      details: { proof: TRANSACTION_PROOF.NO_STORAGE },
    });
  }
  const authority = DURABLE_JOB_TRANSACTION_AUTHORITY.get(transaction);
  const proof = authority
    ? proveCallerTransaction({ database: { storage: authority } })
    : TRANSACTION_PROOF.NO_TRANSACTION;
  if (proof !== TRANSACTION_PROOF.ACTIVE) {
    throw new AppError('Durable-job transactional enqueue requires the current caller-owned transaction', {
      code: 'DURABLE_JOB_TRANSACTION_REQUIRED', status: 500, details: { proof },
    });
  }
}

export function durableJobStorageFor(storage) {
  const adapter = DURABLE_JOB_STORAGE.get(storage);
  if (!adapter) {
    throw new AppError('Storage does not provide the durable-job capability', {
      code: 'DURABLE_JOB_STORAGE_UNAVAILABLE', status: 500,
    });
  }
  return adapter;
}

const COLUMNS = [
  'id', 'contract_version', 'tenant_id', 'kind', 'handler_name', 'handler_contract', 'handler_version',
  'payload_json', 'payload_fingerprint', 'schedule_intent', 'schedule_at', 'state', 'attempt',
  'max_attempts', 'claim_worker_id', 'claim_id', 'claim_generation',
  'claim_expires_at', 'execution_started_at', 'idempotency_root', 'outcome_reference', 'created_at',
  'updated_at', 'last_error_code',
];

const valuesOf = (row) => COLUMNS.map((column) => row[column]);

/** Attach synchronous SQLite operations to one already-private storage handle. */
export function registerSqliteDurableJobStorage(storage, raw, owner) {
  const selectColumns = COLUMNS.join(', ');
  const sql = Object.freeze({
    insert: `
    INSERT OR IGNORE INTO spine_jobs (${COLUMNS.join(', ')})
    VALUES (${COLUMNS.map(() => '?').join(', ')})
  `,
    get: `SELECT ${selectColumns} FROM spine_jobs WHERE tenant_id = ? AND id = ?`,
    byRoot: `SELECT ${selectColumns} FROM spine_jobs WHERE tenant_id = ? AND idempotency_root = ?`,
    due: `
    SELECT id, claim_generation FROM spine_jobs
     WHERE tenant_id = ?
       AND ((state IN ('pending', 'failed_retryable') AND attempt < max_attempts AND schedule_at <= ?)
         OR (state = 'claimed' AND claim_expires_at <= ? AND execution_started_at IS NULL))
     ORDER BY schedule_at, created_at, id
     LIMIT 1
  `,
    dueById: `
    SELECT id, claim_generation FROM spine_jobs
     WHERE tenant_id = ? AND id = ?
       AND ((state IN ('pending', 'failed_retryable') AND attempt < max_attempts AND schedule_at <= ?)
         OR (state = 'claimed' AND claim_expires_at <= ? AND execution_started_at IS NULL))
     LIMIT 1
  `,
    expired: `
    SELECT id, claim_generation FROM spine_jobs
     WHERE tenant_id = ? AND state = 'claimed' AND claim_expires_at <= ?
       AND execution_started_at IS NOT NULL
     ORDER BY claim_expires_at, id
     LIMIT 100
  `,
    expiredById: `
    SELECT id, claim_generation FROM spine_jobs
     WHERE tenant_id = ? AND id = ? AND state = 'claimed' AND claim_expires_at <= ?
       AND execution_started_at IS NOT NULL
     LIMIT 1
  `,
    terminalizeExpired: `
    UPDATE spine_jobs
       SET state = 'failed_terminal', updated_at = ?,
           last_error_code = 'JOB_EXECUTION_OUTCOME_RECONCILIATION_REQUIRED',
           claim_worker_id = NULL, claim_id = NULL, claim_expires_at = NULL
     WHERE tenant_id = ? AND id = ? AND state = 'claimed'
       AND claim_expires_at <= ? AND execution_started_at IS NOT NULL
  `,
    claim: `
    UPDATE spine_jobs
       SET state = 'claimed',
           attempt = CASE WHEN state = 'claimed' THEN attempt ELSE attempt + 1 END,
           claim_worker_id = ?, claim_id = ?, claim_generation = claim_generation + 1,
           claim_expires_at = ?, execution_started_at = NULL,
           updated_at = ?, last_error_code = NULL
     WHERE tenant_id = ? AND id = ? AND claim_generation = ?
       AND ((state IN ('pending', 'failed_retryable') AND attempt < max_attempts AND schedule_at <= ?)
         OR (state = 'claimed' AND claim_expires_at <= ? AND execution_started_at IS NULL))
  `,
    beginExecution: `
    UPDATE spine_jobs SET execution_started_at = ?, updated_at = ?
     WHERE tenant_id = ? AND id = ? AND state = 'claimed'
       AND claim_worker_id = ? AND claim_id = ? AND claim_generation = ?
       AND claim_expires_at > ? AND execution_started_at IS NULL
  `,
    finish: `
    UPDATE spine_jobs
       SET state = ?, schedule_at = ?, outcome_reference = ?, updated_at = ?,
           last_error_code = ?, claim_worker_id = NULL, claim_id = NULL,
           claim_expires_at = NULL
     WHERE tenant_id = ? AND id = ? AND state = 'claimed'
       AND claim_worker_id = ? AND claim_id = ? AND claim_generation = ?
       AND claim_expires_at > ? AND (? = (execution_started_at IS NOT NULL))
  `,
    release: `
    UPDATE spine_jobs
       SET state = 'failed_retryable', attempt = attempt - 1,
           schedule_at = ?, updated_at = ?, last_error_code = 'JOB_CLAIM_RELEASED',
           claim_worker_id = NULL, claim_id = NULL, claim_expires_at = NULL,
           execution_started_at = NULL
     WHERE tenant_id = ? AND id = ? AND state = 'claimed' AND attempt > 0
       AND claim_worker_id = ? AND claim_id = ? AND claim_generation = ?
       AND claim_expires_at > ? AND execution_started_at IS NULL
  `,
    cancel: `
    UPDATE spine_jobs SET state = 'cancelled', updated_at = ?, last_error_code = NULL,
           execution_started_at = NULL
     WHERE tenant_id = ? AND id = ? AND state IN ('pending', 'failed_retryable')
  `,
    reschedule: `
    UPDATE spine_jobs SET state = 'pending', schedule_intent = 'scheduled',
           schedule_at = ?, updated_at = ?, last_error_code = NULL,
           execution_started_at = NULL
     WHERE tenant_id = ? AND id = ? AND state IN ('pending', 'failed_retryable')
  `,
    list: `
    SELECT ${selectColumns} FROM spine_jobs WHERE tenant_id = ?
     ORDER BY created_at DESC, id DESC LIMIT ?
  `,
  });
  const statement = (name) => raw.prepare(sql[name]);

  DURABLE_JOB_STORAGE.set(storage, Object.freeze({
    dialect: 'sqlite',
    insert(row) { return Number(statement('insert').run(...valuesOf(row)).changes) === 1; },
    get(tenantId, id) { return statement('get').get(tenantId, id) ?? null; },
    getByRoot(tenantId, root) { return statement('byRoot').get(tenantId, root) ?? null; },
    claim(input) {
      const terminalized = input.id == null
        ? statement('expired').all(input.tenantId, input.now)
        : statement('expiredById').all(input.tenantId, input.id, input.now);
      for (const row of terminalized) {
        statement('terminalizeExpired').run(input.now, input.tenantId, row.id, input.now);
      }
      const candidate = input.id == null
        ? statement('due').get(input.tenantId, input.now, input.now)
        : statement('dueById').get(input.tenantId, input.id, input.now, input.now);
      if (!candidate) return { row: null, terminalized };
      const changed = statement('claim').run(
        input.workerId, input.claimId, input.expiresAt, input.now,
        input.tenantId, candidate.id, candidate.claim_generation,
        input.now, input.now,
      );
      return {
        row: Number(changed.changes) === 1 ? statement('get').get(input.tenantId, candidate.id) : null,
        terminalized,
      };
    },
    finish(input) {
      return Number(statement('finish').run(
        input.state, input.scheduleAt, input.outcomeReference, input.now,
        input.errorCode, input.tenantId, input.id, input.workerId,
        input.claimId, input.generation, input.now, input.executionRequired ? 1 : 0,
      ).changes);
    },
    beginExecution(input) {
      return Number(statement('beginExecution').run(
        input.now, input.now, input.tenantId, input.id, input.workerId,
        input.claimId, input.generation, input.now,
      ).changes);
    },
    release(input) {
      return Number(statement('release').run(
        input.now, input.now, input.tenantId, input.id, input.workerId,
        input.claimId, input.generation, input.now,
      ).changes);
    },
    cancel(input) { return Number(statement('cancel').run(input.now, input.tenantId, input.id).changes); },
    reschedule(input) {
      return Number(statement('reschedule').run(input.scheduleAt, input.now, input.tenantId, input.id).changes);
    },
    list(tenantId, limit) { return statement('list').all(tenantId, limit); },
  }));
  registerDurableJobStorageOwner(storage, owner);
}

/** Attach PostgreSQL operations to one pool or connection-affine storage handle. */
export function registerPostgresqlDurableJobStorage(storage, { query, table, owner }) {
  const selectColumns = COLUMNS.map((column) => `"${column}"`).join(', ');
  const returning = COLUMNS.map((column) => `j."${column}"`).join(', ');
  DURABLE_JOB_STORAGE.set(storage, Object.freeze({
    dialect: 'postgresql',
    async insert(row) {
      const result = await query(
        `INSERT INTO ${table} (${COLUMNS.map((column) => `"${column}"`).join(', ')})
         VALUES (${COLUMNS.map((_column, index) => `$${index + 1}`).join(', ')})
         ON CONFLICT ("tenant_id", "idempotency_root") DO NOTHING`,
        valuesOf(row),
      );
      return Number(result.rowCount ?? 0) === 1;
    },
    async get(tenantId, id) {
      const result = await query(`SELECT ${selectColumns} FROM ${table} WHERE "tenant_id" = $1 AND "id" = $2`, [tenantId, id]);
      return result.rows[0] ?? null;
    },
    async getByRoot(tenantId, root) {
      const result = await query(`SELECT ${selectColumns} FROM ${table} WHERE "tenant_id" = $1 AND "idempotency_root" = $2`, [tenantId, root]);
      return result.rows[0] ?? null;
    },
    async claim(input) {
      const exhaustedResult = await query(`
        WITH exhausted AS (
          SELECT "id" FROM ${table}
           WHERE "tenant_id" = $2 AND ($3::text IS NULL OR "id" = $3)
             AND "state" = 'claimed' AND "claim_expires_at" <= $1
             AND "execution_started_at" IS NOT NULL
           ORDER BY "claim_expires_at", "id"
           FOR UPDATE SKIP LOCKED
           LIMIT 100
        )
        UPDATE ${table} AS j
           SET "state" = 'failed_terminal', "updated_at" = $1,
               "last_error_code" = 'JOB_EXECUTION_OUTCOME_RECONCILIATION_REQUIRED',
               "claim_worker_id" = NULL, "claim_id" = NULL, "claim_expires_at" = NULL
          FROM exhausted
         WHERE j."id" = exhausted."id" AND j."tenant_id" = $2
         RETURNING j."id", j."claim_generation"
      `, [input.now, input.tenantId, input.id ?? null]);
      const result = await query(`
        WITH candidate AS (
          SELECT "id" FROM ${table}
           WHERE "tenant_id" = $1 AND ($6::text IS NULL OR "id" = $6)
             AND (("state" IN ('pending', 'failed_retryable') AND "attempt" < "max_attempts" AND "schedule_at" <= $2)
               OR ("state" = 'claimed' AND "claim_expires_at" <= $2 AND "execution_started_at" IS NULL))
           ORDER BY "schedule_at", "created_at", "id"
           FOR UPDATE SKIP LOCKED
           LIMIT 1
        )
        UPDATE ${table} AS j
           SET "state" = 'claimed',
               "attempt" = CASE WHEN j."state" = 'claimed' THEN j."attempt" ELSE j."attempt" + 1 END,
               "claim_worker_id" = $3, "claim_id" = $4,
               "claim_generation" = j."claim_generation" + 1,
               "claim_expires_at" = $5, "execution_started_at" = NULL, "updated_at" = $2,
               "last_error_code" = NULL
          FROM candidate
         WHERE j."id" = candidate."id" AND j."tenant_id" = $1
         RETURNING ${returning}
      `, [input.tenantId, input.now, input.workerId, input.claimId, input.expiresAt, input.id ?? null]);
      return { row: result.rows[0] ?? null, terminalized: exhaustedResult.rows };
    },
    async beginExecution(input) {
      const result = await query(`
        UPDATE ${table} SET "execution_started_at" = $1, "updated_at" = $1
         WHERE "tenant_id" = $2 AND "id" = $3 AND "state" = 'claimed'
           AND "claim_worker_id" = $4 AND "claim_id" = $5
           AND "claim_generation" = $6 AND "claim_expires_at" > $1
           AND "execution_started_at" IS NULL
      `, [input.now, input.tenantId, input.id, input.workerId, input.claimId, input.generation]);
      return Number(result.rowCount ?? 0);
    },
    async finish(input) {
      const result = await query(`
        UPDATE ${table}
           SET "state" = $1, "schedule_at" = $2, "outcome_reference" = $3,
               "updated_at" = $4, "last_error_code" = $5,
               "claim_worker_id" = NULL, "claim_id" = NULL, "claim_expires_at" = NULL
         WHERE "tenant_id" = $6 AND "id" = $7 AND "state" = 'claimed'
           AND "claim_worker_id" = $8 AND "claim_id" = $9
           AND "claim_generation" = $10 AND "claim_expires_at" > $4
           AND $11 = ("execution_started_at" IS NOT NULL)
      `, [
        input.state, input.scheduleAt, input.outcomeReference, input.now,
        input.errorCode, input.tenantId, input.id, input.workerId,
        input.claimId, input.generation, input.executionRequired,
      ]);
      return Number(result.rowCount ?? 0);
    },
    async release(input) {
      const result = await query(`
        UPDATE ${table}
           SET "state" = 'failed_retryable', "attempt" = "attempt" - 1,
               "schedule_at" = $1, "updated_at" = $1,
               "last_error_code" = 'JOB_CLAIM_RELEASED',
               "claim_worker_id" = NULL, "claim_id" = NULL, "claim_expires_at" = NULL,
               "execution_started_at" = NULL
         WHERE "tenant_id" = $2 AND "id" = $3 AND "state" = 'claimed'
           AND "attempt" > 0 AND "claim_worker_id" = $4 AND "claim_id" = $5
           AND "claim_generation" = $6 AND "claim_expires_at" > $1
           AND "execution_started_at" IS NULL
      `, [
        input.now, input.tenantId, input.id, input.workerId,
        input.claimId, input.generation,
      ]);
      return Number(result.rowCount ?? 0);
    },
    async cancel(input) {
      const result = await query(`
        UPDATE ${table} SET "state" = 'cancelled', "updated_at" = $1, "last_error_code" = NULL,
               "execution_started_at" = NULL
         WHERE "tenant_id" = $2 AND "id" = $3 AND "state" IN ('pending', 'failed_retryable')
      `, [input.now, input.tenantId, input.id]);
      return Number(result.rowCount ?? 0);
    },
    async reschedule(input) {
      const result = await query(`
        UPDATE ${table} SET "state" = 'pending', "schedule_intent" = 'scheduled', "schedule_at" = $1,
               "updated_at" = $2, "last_error_code" = NULL, "execution_started_at" = NULL
         WHERE "tenant_id" = $3 AND "id" = $4 AND "state" IN ('pending', 'failed_retryable')
      `, [input.scheduleAt, input.now, input.tenantId, input.id]);
      return Number(result.rowCount ?? 0);
    },
    async list(tenantId, limit) {
      const result = await query(`
        SELECT ${selectColumns} FROM ${table} WHERE "tenant_id" = $1
         ORDER BY "created_at" DESC, "id" DESC LIMIT $2
      `, [tenantId, limit]);
      return result.rows;
    },
  }));
  registerDurableJobStorageOwner(storage, owner);
}
