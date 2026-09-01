// @ts-check

import { createHash, randomUUID } from 'node:crypto';
import { AppError } from './errors.js';
import { CORE_SCHEMA_INTENT, renderCorePostgresSql } from './core-schema-intent.js';
import { POSTGRES_SCHEMA_NAME, quotePostgresIdent } from './physical-name.js';
import { SCHEMA_MIGRATIONS_CHECKSUM_VERSION, sqlChecksum } from './schema-migrations-ledger.js';
import {
  createPostgresqlPool,
  createPostgresqlStorage,
} from './postgresql-storage.js';
import { createWriterReadinessObserver } from './observability-export.js';
import { DATA_ADVISORY_LOCK, DATA_RESTORE_CHILD_LOCK } from './postgresql-authority.js';
import { attestPostgresqlStartup, fingerprintMigrationSet } from './startup-attestation.js';

export { DATA_ADVISORY_LOCK, DATA_RESTORE_CHILD_LOCK } from './postgresql-authority.js';

export const POSTGRES_APPLICATION_SCHEMA = POSTGRES_SCHEMA_NAME;
export const CONTROL_ADVISORY_LOCK = Object.freeze({ classId: 1094927186, objectId: 1129598001 });
export const PROVISIONING_ADVISORY_LOCK = Object.freeze({ classId: 1094927187 });
export const WRITER_LEASE_TTL_MS = 60_000;
export const WRITER_LEASE_TABLE = 'spine_writer_leases';

const LEDGER_TABLE = 'schema_migrations';
const MODULE_LEDGER_TABLE = 'module_migrations';
const STARTUP_AUDIT_TABLE = 'startup_audit';
const BINDING_TABLE = 'spine_data_plane_binding';
const CONTROL_BINDING_TABLE = 'spine_tenant_bindings';
const DEFAULT_ACQUISITION_MS = 2_000;
const DEFAULT_QUERY_MS = 5_000;
const DESTROYED = new WeakSet();

/**
 * @param {string} code
 * @param {string} message
 * @param {Record<string, unknown>} [details]
 * @returns {never}
 */
function refuse(code, message, details = {}) {
  throw new AppError(message, { code, status: 500, details });
}

function qualify(name) {
  return `${quotePostgresIdent(POSTGRES_APPLICATION_SCHEMA)}.${quotePostgresIdent(name)}`;
}

function planeIntents(plane) {
  return CORE_SCHEMA_INTENT.filter((intent) => intent.plane === plane && intent.version !== SCHEMA_MIGRATIONS_CHECKSUM_VERSION);
}

function postgresMigration(intent) {
  const rendered = renderCorePostgresSql(intent);
  return Object.freeze({
    version: intent.version,
    name: intent.name,
    plane: intent.plane,
    sql: rendered.sql,
    checksum: sqlChecksum(rendered.sql),
  });
}

export function postgresqlControlMigrations() {
  return planeIntents('control').map(postgresMigration);
}

export function postgresqlDataMigrations() {
  return planeIntents('data').map(postgresMigration);
}

export function fingerprintPostgresqlRepository(extra = []) {
  const core = CORE_SCHEMA_INTENT.map((intent) => ({
    version: intent.version,
    name: intent.name,
    plane: intent.plane,
    checksum: intent.version === SCHEMA_MIGRATIONS_CHECKSUM_VERSION
      ? 'ledger'
      : sqlChecksum(renderCorePostgresSql(intent).sql),
  }));
  return createHash('sha256').update(JSON.stringify({ core, extra })).digest('hex');
}

export function fingerprintPostgresqlTenant(tenantId) {
  return createHash('sha256').update(`accordo.tenant.v1\0${tenantId}`).digest('hex');
}

export function provisioningLockObjectId(tenantId) {
  const digest = createHash('sha256').update('accordo.provision.v1\0').update(String(tenantId)).digest();
  const n = digest.readInt32BE(0);
  return n === 0 ? 1 : n;
}

function nowIso(clock) {
  return clock ? clock() : new Date().toISOString();
}

function epochNow(now) {
  return typeof now === 'function' ? now() : Date.now();
}

function fault(options, name) {
  if (options?.faultInject === name) {
    refuse('STARTUP_FAULT_INJECTED', 'injected startup fault', { boundary: name });
  }
}

function timeoutError(kind) {
  return new AppError(`PostgreSQL ${kind} deadline exceeded`, {
    code: 'STORAGE_TIMEOUT',
    status: 504,
  });
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
      timer = setTimeout(() => reject(timeoutError(kind)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
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

function releaseClient(client) {
  if (DESTROYED.has(client)) return;
  try { client.release(); } catch { /* already gone */ }
}

/**
 * @param {any} client
 * @param {string} sql
 * @param {unknown[]} [params]
 * @param {number} [queryDeadlineMs]
 */
async function exec(client, sql, params = [], queryDeadlineMs = DEFAULT_QUERY_MS) {
  try {
    return await withDeadline(client.query(sql, params), queryDeadlineMs, 'query');
  } catch (error) {
    if (error instanceof AppError && error.code === 'STORAGE_TIMEOUT') {
      destroyClient(client);
      throw error;
    }
    if (error instanceof AppError) throw error;
    refuse('STORAGE_UNAVAILABLE', 'PostgreSQL startup storage failed');
  }
}

async function connectBounded(pool, acquisitionDeadlineMs = DEFAULT_ACQUISITION_MS) {
  const pending = pool.connect();
  let timedOut = false;
  pending.then(
    (client) => { if (timedOut) destroyClient(client); },
    () => {},
  );
  try {
    return await withDeadline(pending, acquisitionDeadlineMs, 'acquisition');
  } catch (error) {
    timedOut = true;
    if (error instanceof AppError) throw error;
    refuse('STORAGE_UNAVAILABLE', 'PostgreSQL startup storage failed');
  }
}

async function ensureLedger(client) {
  await exec(client, `
    CREATE TABLE IF NOT EXISTS ${qualify(LEDGER_TABLE)} (
      version BIGINT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL,
      checksum TEXT NOT NULL
    )
  `);
  await exec(client, `
    CREATE TABLE IF NOT EXISTS ${qualify(MODULE_LEDGER_TABLE)} (
      name TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL
    )
  `);
  await exec(client, `
    CREATE TABLE IF NOT EXISTS ${qualify(STARTUP_AUDIT_TABLE)} (
      id TEXT PRIMARY KEY,
      plane TEXT NOT NULL,
      tenant_fingerprint TEXT NOT NULL,
      identity_fingerprint TEXT NOT NULL,
      evidence_fingerprint TEXT NOT NULL,
      resource_fingerprint TEXT NOT NULL,
      migration_set_fingerprint TEXT NOT NULL,
      challenge_fingerprint TEXT NOT NULL,
      permission TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    )
  `);
}

async function ensureWriterLeaseTable(client) {
  await exec(client, `
    CREATE TABLE IF NOT EXISTS ${qualify(WRITER_LEASE_TABLE)} (
      tenant_slug TEXT PRIMARY KEY,
      binding_uuid TEXT NOT NULL,
      lease_id TEXT NOT NULL,
      generation BIGINT NOT NULL,
      resource_fingerprint TEXT NOT NULL,
      evidence_fingerprint TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    )
  `);
}

async function recordStartupAudit(client, {
  plane, tenantId, attestation, reason, clock,
}) {
  await exec(
    client,
    `INSERT INTO ${qualify(STARTUP_AUDIT_TABLE)}(
      id, plane, tenant_fingerprint, identity_fingerprint, evidence_fingerprint,
      resource_fingerprint, migration_set_fingerprint, challenge_fingerprint,
      permission, reason, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      randomUUID(),
      plane,
      fingerprintPostgresqlTenant(tenantId),
      attestation.evidence.identityFingerprint,
      attestation.evidence.evidenceFingerprint,
      attestation.resource.resourceFingerprint,
      attestation.migrationSetFingerprint,
      attestation.challengeFingerprint,
      attestation.evidence.permission,
      reason,
      nowIso(clock),
    ],
  );
}

async function applyUnits(client, {
  plane, migrations, moduleMigrations = [], attestation, tenantId, clock, faultInject, prefix,
}) {
  const applied = await exec(client, `SELECT version, name, checksum FROM ${qualify(LEDGER_TABLE)}`);
  const recorded = new Map((applied.rows ?? []).map((row) => [Number(row.version), row]));
  for (const migration of migrations) {
    const existing = recorded.get(migration.version);
    if (existing) {
      if (String(existing.name) !== migration.name || String(existing.checksum) !== migration.checksum) {
        refuse('CORE_MIGRATION_CHECKSUM_MISMATCH', 'schema_migrations checksum does not match the rendered PostgreSQL identity');
      }
      continue;
    }
    fault({ faultInject }, `${prefix}-before-ddl-${migration.version}`);
    await exec(client, migration.sql);
    fault({ faultInject }, `${prefix}-after-ddl-${migration.version}`);
    await exec(
      client,
      `INSERT INTO ${qualify(LEDGER_TABLE)}(version, name, applied_at, checksum) VALUES ($1, $2, $3, $4)`,
      [migration.version, migration.name, nowIso(clock), migration.checksum],
    );
    fault({ faultInject }, `${prefix}-after-ledger-${migration.version}`);
    await recordStartupAudit(client, {
      plane,
      tenantId,
      attestation,
      reason: `${plane}:${migration.name}`,
      clock,
    });
    fault({ faultInject }, `${prefix}-after-audit-${migration.version}`);
  }

  const moduleApplied = await exec(client, `SELECT name, checksum FROM ${qualify(MODULE_LEDGER_TABLE)}`);
  const moduleRecorded = new Map((moduleApplied.rows ?? []).map((row) => [String(row.name), String(row.checksum)]));
  for (const migration of moduleMigrations) {
    const checksum = sqlChecksum(migration.sql);
    const existing = moduleRecorded.get(migration.name);
    if (existing) {
      if (existing !== checksum) {
        refuse('MODULE_MIGRATION_CHECKSUM_MISMATCH', 'module migration SQL is immutable once applied');
      }
      continue;
    }
    fault({ faultInject }, `${prefix}-before-module-${migration.name}`);
    await exec(client, migration.sql);
    await exec(
      client,
      `INSERT INTO ${qualify(MODULE_LEDGER_TABLE)}(name, checksum, applied_at) VALUES ($1, $2, $3)`,
      [migration.name, checksum, nowIso(clock)],
    );
    await recordStartupAudit(client, {
      plane,
      tenantId,
      attestation,
      reason: `module:${migration.name}`,
      clock,
    });
    fault({ faultInject }, `${prefix}-after-module-${migration.name}`);
  }
}

async function ensureWriteOutcomes(client) {
  await exec(client, `
    CREATE TABLE IF NOT EXISTS ${qualify('write_outcomes')} (
      tenant_namespace TEXT NOT NULL,
      raw_key TEXT NOT NULL,
      phase TEXT NOT NULL,
      subject_fingerprint TEXT NOT NULL,
      operation TEXT NOT NULL,
      target TEXT NOT NULL,
      contract_version TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      record_ids_json TEXT NOT NULL,
      response_json TEXT,
      event_intents_json TEXT NOT NULL,
      trace_intent_json TEXT NOT NULL,
      run_id TEXT NOT NULL,
      events_promoted BIGINT NOT NULL DEFAULT 0,
      external_finalize_declared BIGINT,
      created_at TIMESTAMPTZ NOT NULL,
      acknowledged_at TIMESTAMPTZ,
      PRIMARY KEY (tenant_namespace, raw_key, phase)
    )
  `);
  await exec(client, `
    ALTER TABLE ${qualify('write_outcomes')}
      ADD COLUMN IF NOT EXISTS acknowledged_at TIMESTAMPTZ
  `);
  await exec(client, `
    ALTER TABLE ${qualify('write_outcomes')}
      ADD COLUMN IF NOT EXISTS external_finalize_declared BIGINT
  `);
  await exec(client, `
    ALTER TABLE ${qualify('write_outcomes')}
      ALTER COLUMN external_finalize_declared DROP DEFAULT,
      ALTER COLUMN external_finalize_declared DROP NOT NULL
  `);
}

async function inspectDataMarker(client) {
  const present = await exec(
    client,
    'SELECT to_regclass($1) AS name',
    [`${POSTGRES_APPLICATION_SCHEMA}.${BINDING_TABLE}`],
  );
  if (!present.rows?.[0]?.name) return null;
  const existing = await exec(
    client,
    `SELECT tenant_slug, data_plane_id FROM ${qualify(BINDING_TABLE)} WHERE singleton = 1`,
  );
  const row = existing.rows?.[0];
  if (!row) return null;
  return Object.freeze({
    tenantSlug: String(row.tenant_slug),
    dataPlaneId: String(row.data_plane_id),
  });
}

async function readControlBinding(client, tenantId) {
  const existing = await exec(
    client,
    `SELECT tenant_slug, data_plane_id FROM ${qualify(CONTROL_BINDING_TABLE)} WHERE tenant_slug = $1`,
    [tenantId],
  );
  const row = existing.rows?.[0];
  if (!row) return null;
  return Object.freeze({
    tenantSlug: String(row.tenant_slug),
    dataPlaneId: row.data_plane_id == null ? null : String(row.data_plane_id),
  });
}

async function claimDataPlane(client, { tenantId, clock, faultInject, existing }) {
  if (existing) {
    if (existing.tenantSlug !== tenantId) {
      refuse('TENANT_BINDING_MISMATCH', 'the PostgreSQL data plane is already bound to a different tenant');
    }
    return existing;
  }
  fault({ faultInject }, 'data-before-claim');
  const dataPlaneId = randomUUID();
  await exec(
    client,
    `INSERT INTO ${qualify(BINDING_TABLE)}(singleton, tenant_slug, data_plane_id, created_at) VALUES (1, $1, $2, $3)`,
    [tenantId, dataPlaneId, nowIso(clock)],
  );
  return Object.freeze({ tenantSlug: tenantId, dataPlaneId });
}

async function claimControlBinding(client, { tenantId, dataPlaneId, clock }) {
  const existing = await readControlBinding(client, tenantId);
  if (existing) {
    if (existing.dataPlaneId && existing.dataPlaneId !== dataPlaneId) {
      refuse('TENANT_BINDING_MISMATCH', 'the control plane already maps this tenant to a different data plane');
    }
    if (!existing.dataPlaneId) {
      await exec(
        client,
        `UPDATE ${qualify(CONTROL_BINDING_TABLE)} SET data_plane_id = $1 WHERE tenant_slug = $2 AND data_plane_id IS NULL`,
        [dataPlaneId, tenantId],
      );
    }
    return existing.dataPlaneId ? existing : Object.freeze({ tenantSlug: tenantId, dataPlaneId });
  }
  await exec(
    client,
    `INSERT INTO ${qualify(CONTROL_BINDING_TABLE)}(tenant_slug, data_plane_id, created_at) VALUES ($1, $2, $3)`,
    [tenantId, dataPlaneId, nowIso(clock)],
  );
  return Object.freeze({ tenantSlug: tenantId, dataPlaneId });
}

/**
 * @param {any} client
 * @param {{
 *   tenantId: string,
 *   bindingUuid: string,
 *   resourceFingerprint: string,
 *   evidenceFingerprint: string,
 *   clock?: () => string,
 *   now?: () => number,
 *   leaseTtlMs: number,
 * }} input
 */
async function acquireWriterLease(client, input) {
  const now = epochNow(input.now);
  const expiresAt = new Date(now + input.leaseTtlMs).toISOString();
  const leaseId = randomUUID();
  const existing = await exec(
    client,
    `SELECT lease_id, generation, resource_fingerprint, evidence_fingerprint, expires_at
     FROM ${qualify(WRITER_LEASE_TABLE)} WHERE tenant_slug = $1`,
    [input.tenantId],
  );
  const row = existing.rows?.[0];
  if (!row) {
    await exec(
      client,
      `INSERT INTO ${qualify(WRITER_LEASE_TABLE)}(
        tenant_slug, binding_uuid, lease_id, generation, resource_fingerprint,
        evidence_fingerprint, expires_at, created_at
      ) VALUES ($1, $2, $3, 1, $4, $5, $6, $7)`,
      [
        input.tenantId,
        input.bindingUuid,
        leaseId,
        input.resourceFingerprint,
        input.evidenceFingerprint,
        expiresAt,
        nowIso(input.clock),
      ],
    );
    return Object.freeze({
      leaseId,
      generation: 1,
      expiresAt,
      bindingUuid: input.bindingUuid,
    });
  }

  if (String(row.resource_fingerprint) !== input.resourceFingerprint) {
    refuse('CLONE_PROMOTION_REFUSED', 'a cloned data plane cannot assume writer authority');
  }

  const rawExpiry = row.expires_at;
  const currentExpiry = rawExpiry instanceof Date ? rawExpiry.getTime() : Date.parse(String(rawExpiry ?? ''));
  if (Number.isFinite(currentExpiry) && currentExpiry > now) {
    refuse('WRITER_LEASE_HELD', 'another writer already holds the unexpired lease');
  }

  const nextGeneration = Number(row.generation) + 1;
  const updated = await exec(
    client,
    `UPDATE ${qualify(WRITER_LEASE_TABLE)}
     SET lease_id = $1, generation = $2, expires_at = $3, evidence_fingerprint = $4, binding_uuid = $5
     WHERE tenant_slug = $6 AND lease_id = $7 AND generation = $8 AND expires_at = $9 AND resource_fingerprint = $10`,
    [
      leaseId,
      nextGeneration,
      expiresAt,
      input.evidenceFingerprint,
      input.bindingUuid,
      input.tenantId,
      String(row.lease_id),
      Number(row.generation),
      row.expires_at,
      input.resourceFingerprint,
    ],
  );
  if (Number(updated.rowCount ?? 0) !== 1) {
    refuse('WRITER_LEASE_MISMATCH', 'writer lease compare-and-set failed');
  }
  return Object.freeze({
    leaseId,
    generation: nextGeneration,
    expiresAt,
    bindingUuid: input.bindingUuid,
  });
}

async function expireWriterLease(client, { tenantId, leaseId, generation, clock, now }) {
  const expiredAt = typeof clock === 'function' ? clock() : new Date(epochNow(now)).toISOString();
  await exec(
    client,
    `UPDATE ${qualify(WRITER_LEASE_TABLE)}
     SET expires_at = $1
     WHERE tenant_slug = $2 AND lease_id = $3 AND generation = $4`,
    [expiredAt, tenantId, leaseId, generation],
  );
}

/**
 * Compare-and-set renewal. Callers must supply the expected lease/generation/expiry.
 *
 * @param {any} client
 * @param {{
 *   tenantId: string,
 *   expectedLeaseId: string,
 *   expectedGeneration: number,
 *   expectedExpiresAt: string,
 *   resourceFingerprint: string,
 *   evidenceFingerprint: string,
 *   clock?: () => string,
 *   now?: () => number,
 *   leaseTtlMs: number,
 * }} input
 */
export async function renewWriterLease(client, input) {
  const now = epochNow(input.now);
  const expectedExpiry = Date.parse(input.expectedExpiresAt);
  if (!Number.isFinite(expectedExpiry) || expectedExpiry <= now) {
    refuse('WRITER_LEASE_EXPIRED', 'writer lease has expired and cannot be renewed without a fresh attestation');
  }
  const expiresAt = new Date(now + input.leaseTtlMs).toISOString();
  const leaseId = randomUUID();
  const updated = await exec(
    client,
    `UPDATE ${qualify(WRITER_LEASE_TABLE)}
     SET lease_id = $1, expires_at = $2, evidence_fingerprint = $3
     WHERE tenant_slug = $4 AND lease_id = $5 AND generation = $6 AND expires_at = $7 AND resource_fingerprint = $8`,
    [
      leaseId,
      expiresAt,
      input.evidenceFingerprint,
      input.tenantId,
      input.expectedLeaseId,
      input.expectedGeneration,
      input.expectedExpiresAt,
      input.resourceFingerprint,
    ],
  );
  if (Number(updated.rowCount ?? 0) !== 1) {
    refuse('WRITER_LEASE_MISMATCH', 'writer lease compare-and-set failed');
  }
  return Object.freeze({
    leaseId,
    generation: input.expectedGeneration,
    expiresAt,
  });
}

async function rollbackQuietly(client) {
  if (DESTROYED.has(client)) return;
  try { await client.query('ROLLBACK'); } catch { /* primary wins */ }
}

async function commitOrUnknown(client) {
  try {
    await exec(client, 'COMMIT');
  } catch (error) {
    if (!(error instanceof AppError && error.code === 'STORAGE_TIMEOUT')) {
      destroyClient(client);
    }
    throw new AppError('PostgreSQL commit outcome is unknown', {
      code: 'COMMIT_OUTCOME_UNKNOWN', status: 503,
    });
  }
}

async function bootstrapPlane(pool, {
  plane, lock, migrations, moduleMigrations, attestation, tenantId, clock, faultInject,
  afterSchema, acquisitionDeadlineMs,
}) {
  const client = await connectBounded(pool, acquisitionDeadlineMs);
  let active = false;
  try {
    await exec(client, 'BEGIN');
    active = true;
    await exec(client, 'SELECT pg_advisory_xact_lock($1, $2)', [lock.classId, lock.objectId]);
    if (lock.classId === DATA_ADVISORY_LOCK.classId && lock.objectId === DATA_ADVISORY_LOCK.objectId) {
      await exec(client, 'SELECT pg_advisory_xact_lock($1, $2)', [
        DATA_RESTORE_CHILD_LOCK.classId, DATA_RESTORE_CHILD_LOCK.objectId,
      ]);
    }
    await exec(client, 'SET LOCAL search_path TO pg_catalog');
    await exec(client, `CREATE SCHEMA IF NOT EXISTS ${quotePostgresIdent(POSTGRES_APPLICATION_SCHEMA)}`);
    await ensureLedger(client);
    await applyUnits(client, {
      plane,
      migrations,
      moduleMigrations,
      attestation,
      tenantId,
      clock,
      faultInject,
      prefix: plane,
    });
    const extra = afterSchema ? await afterSchema(client) : undefined;
    await commitOrUnknown(client);
    active = false;
    return extra;
  } catch (error) {
    if (active) await rollbackQuietly(client);
    throw error instanceof AppError ? error : new AppError('PostgreSQL startup storage failed', {
      code: 'STORAGE_UNAVAILABLE', status: 500,
    });
  } finally {
    releaseClient(client);
  }
}

function assertSeparateEndpoints(control, data) {
  const identity = (endpoint) => `${String(endpoint.host).toLowerCase()}|${endpoint.port ?? 5432}|${endpoint.database}`;
  if (identity(control) === identity(data)) {
    refuse('DEPLOYMENT_STORAGE_PLANES_ALIAS', 'PostgreSQL control and data planes must not share an endpoint identity');
  }
}

function describeWriterHealth(writerLease, now, closed = false) {
  if (closed) {
    return Object.freeze({
      ok: true,
      ready: false,
      storage: Object.freeze({ adapter: 'postgresql', available: false }),
      reason: 'WRITER_LEASE_RELEASED',
    });
  }
  const current = epochNow(now);
  const expiresAt = Date.parse(writerLease.expiresAt);
  const ready = Number.isFinite(expiresAt) && current < expiresAt;
  return Object.freeze({
    ok: true,
    ready,
    storage: Object.freeze({ adapter: 'postgresql', available: ready }),
    ...(ready ? {} : { reason: 'WRITER_LEASE_EXPIRED' }),
  });
}

/**
 * Bootstrap control then data on PostgreSQL. Attestation completes before any
 * DDL. Each plane's migration units, ledger rows and startup audit commit
 * together under `pg_advisory_xact_lock`. First data-plane claim inspects the
 * singleton marker before remaining domain DDL and records the inverse
 * `{canonicalTenant, bindingUuid}` under a tenant-keyed exclusive provisioning
 * lock on the shared control plane.
 *
 * @param {{
 *   control: { host: string, port?: number, database: string, user: string, password: string, ssl?: false | object, max?: number, acquisitionDeadlineMs?: number },
 *   data: { host: string, port?: number, database: string, user: string, password: string, ssl?: false | object, max?: number, acquisitionDeadlineMs?: number, queryDeadlineMs?: number },
 *   tenantId: string,
 *   identityVerifier: { operations: any },
 *   moduleMigrations?: Array<{name: string, sql: string}>,
 *   selectedExtra?: unknown[],
 *   clock?: () => string,
 *   faultInject?: string,
 *   now?: () => number,
 *   leaseTtlMs?: number,
 *   queryDeadlineMs?: number,
 *   acquisitionDeadlineMs?: number,
 *   rebind?: unknown,
 *   promoteClone?: unknown,
 * }} options
 */
export async function bootstrapPostgresqlApplication(options) {
  if (options?.rebind === true || options?.promoteClone === true) {
    refuse('TENANT_REBIND_REFUSED', 'requested rebind or clone promotion is not supported');
  }
  assertSeparateEndpoints(options.control, options.data);
  const controlMigrations = postgresqlControlMigrations();
  const dataMigrations = postgresqlDataMigrations();
  const moduleMigrations = options.moduleMigrations ?? [];
  const repositoryFingerprint = fingerprintPostgresqlRepository(options.selectedExtra ?? []);
  const acquisitionDeadlineMs = options.acquisitionDeadlineMs
    ?? options.control?.acquisitionDeadlineMs
    ?? DEFAULT_ACQUISITION_MS;
  const queryDeadlineMs = options.queryDeadlineMs
    ?? options.data?.queryDeadlineMs
    ?? DEFAULT_QUERY_MS;
  const leaseTtlMs = Number.isInteger(options.leaseTtlMs) && options.leaseTtlMs > 0
    ? options.leaseTtlMs
    : WRITER_LEASE_TTL_MS;
  const controlPool = createPostgresqlPool({ ...options.control, acquisitionDeadlineMs });
  const dataPool = createPostgresqlPool({ ...options.data, acquisitionDeadlineMs });
  let controlStorage;
  let dataStorage;
  /** @type {any} */
  let writerLease = null;
  try {
    const controlAttestation = await attestPostgresqlStartup({
      operations: options.identityVerifier.operations,
      tenantId: options.tenantId,
      repositoryFingerprint,
      controlMigrations,
      dataMigrations: [],
      now: options.now,
      phase: 'control',
    });
    await bootstrapPlane(controlPool, {
      plane: 'control',
      lock: CONTROL_ADVISORY_LOCK,
      migrations: controlMigrations,
      attestation: controlAttestation.control,
      tenantId: options.tenantId,
      clock: options.clock,
      faultInject: options.faultInject,
      acquisitionDeadlineMs,
      afterSchema: (client) => ensureWriterLeaseTable(client),
    });
    controlStorage = createPostgresqlStorage(controlPool, {
      schema: POSTGRES_APPLICATION_SCHEMA,
      acquisitionDeadlineMs,
      queryDeadlineMs,
    });

    const dataAttestation = await attestPostgresqlStartup({
      operations: options.identityVerifier.operations,
      tenantId: options.tenantId,
      repositoryFingerprint,
      controlMigrations,
      dataMigrations: [
        ...dataMigrations,
        ...moduleMigrations.map((migration) => ({ name: migration.name, checksum: sqlChecksum(migration.sql) })),
      ],
      now: options.now,
      phase: 'data',
      priorControl: controlAttestation.control,
    });
    const controlClient = await connectBounded(controlPool, acquisitionDeadlineMs);
    let controlActive = false;
    /** @type {any} */
    let dataClient = null;
    let dataActive = false;
    /** @type {{ tenantSlug: string, dataPlaneId: string } | undefined} */
    let binding;
    try {
      await exec(controlClient, 'BEGIN');
      controlActive = true;
      await exec(
        controlClient,
        'SELECT pg_advisory_xact_lock($1, $2)',
        [PROVISIONING_ADVISORY_LOCK.classId, provisioningLockObjectId(options.tenantId)],
      );
      await exec(controlClient, 'SET LOCAL search_path TO pg_catalog');
      const mapping = await readControlBinding(controlClient, options.tenantId);

      dataClient = await connectBounded(dataPool, acquisitionDeadlineMs);
      await exec(dataClient, 'BEGIN');
      dataActive = true;
      await exec(dataClient, 'SELECT pg_advisory_xact_lock($1, $2)', [DATA_ADVISORY_LOCK.classId, DATA_ADVISORY_LOCK.objectId]);
      await exec(dataClient, 'SELECT pg_advisory_xact_lock($1, $2)', [
        DATA_RESTORE_CHILD_LOCK.classId, DATA_RESTORE_CHILD_LOCK.objectId,
      ]);
      await exec(dataClient, 'SET LOCAL search_path TO pg_catalog');

      const marker = await inspectDataMarker(dataClient);
      if (marker && marker.tenantSlug !== options.tenantId) {
        refuse('TENANT_BINDING_MISMATCH', 'the PostgreSQL data plane is already bound to a different tenant');
      }
      if (marker && mapping?.dataPlaneId && mapping.dataPlaneId !== marker.dataPlaneId) {
        refuse('TENANT_BINDING_MISMATCH', 'the control plane already maps this tenant to a different data plane');
      }
      if (!marker && mapping?.dataPlaneId) {
        refuse('TENANT_BINDING_MISMATCH', 'the control plane already maps this tenant to a different data plane');
      }

      const leaseInput = {
        tenantId: options.tenantId,
        resourceFingerprint: dataAttestation.data.resource.resourceFingerprint,
        evidenceFingerprint: dataAttestation.data.evidence.evidenceFingerprint,
        clock: options.clock,
        now: options.now,
        leaseTtlMs,
      };
      if (marker) {
        writerLease = await acquireWriterLease(controlClient, {
          ...leaseInput,
          bindingUuid: marker.dataPlaneId,
        });
      }

      await exec(dataClient, `CREATE SCHEMA IF NOT EXISTS ${quotePostgresIdent(POSTGRES_APPLICATION_SCHEMA)}`);
      await ensureLedger(dataClient);
      await ensureWriteOutcomes(dataClient);
      await applyUnits(dataClient, {
        plane: 'data',
        migrations: dataMigrations,
        moduleMigrations,
        attestation: dataAttestation.data,
        tenantId: options.tenantId,
        clock: options.clock,
        faultInject: options.faultInject,
        prefix: 'data',
      });
      binding = await claimDataPlane(dataClient, {
        tenantId: options.tenantId,
        clock: options.clock,
        faultInject: options.faultInject,
        existing: marker,
      });
      await recordStartupAudit(dataClient, {
        plane: 'data',
        tenantId: options.tenantId,
        attestation: dataAttestation.data,
        reason: marker ? 'data:binding-verified' : 'data:claim',
        clock: options.clock,
      });
      await commitOrUnknown(dataClient);
      dataActive = false;

      await claimControlBinding(controlClient, {
        tenantId: options.tenantId,
        dataPlaneId: binding.dataPlaneId,
        clock: options.clock,
      });
      if (!writerLease) {
        writerLease = await acquireWriterLease(controlClient, {
          ...leaseInput,
          bindingUuid: binding.dataPlaneId,
        });
      }
      await recordStartupAudit(controlClient, {
        plane: 'control',
        tenantId: options.tenantId,
        attestation: controlAttestation.control,
        reason: `control:writer-lease:${writerLease.generation}`,
        clock: options.clock,
      });
      await commitOrUnknown(controlClient);
      controlActive = false;
    } catch (error) {
      if (dataActive && dataClient) await rollbackQuietly(dataClient);
      if (controlActive) await rollbackQuietly(controlClient);
      throw error instanceof AppError ? error : new AppError('PostgreSQL startup storage failed', {
        code: 'STORAGE_UNAVAILABLE', status: 500,
      });
    } finally {
      if (dataClient) releaseClient(dataClient);
      releaseClient(controlClient);
    }

    const leaseState = { holder: writerLease, closed: false };
    // Spine v4C. Readiness is a pull here — `health()` is asked and
    // `writerGuard` runs per write — so an expired lease would otherwise emit
    // one signal per refused write. The observer holds one boolean and reports
    // transitions; the lease row stays the authority and no state is added for
    // telemetry. Absent `options.telemetry`, every call below is a no-op.
    const readiness = createWriterReadinessObserver(options.telemetry ?? null);
    const observeReadiness = (snapshot) => readiness.observe(snapshot, {
      expiresAt: leaseState.holder.expiresAt,
      now: new Date(epochNow(options.now)).toISOString(),
    });
    dataStorage = createPostgresqlStorage(dataPool, {
      schema: POSTGRES_APPLICATION_SCHEMA,
      acquisitionDeadlineMs,
      queryDeadlineMs,
      writerGuard: () => {
        const snapshot = describeWriterHealth(leaseState.holder, options.now, leaseState.closed);
        observeReadiness(snapshot);
        if (!snapshot.ready) {
          refuse(snapshot.reason ?? 'WRITER_LEASE_EXPIRED', 'this process does not hold an unexpired writer lease');
        }
      },
    });
    observeReadiness(describeWriterHealth(leaseState.holder, options.now, false));
    return Object.freeze({
      adapter: 'postgresql',
      schema: POSTGRES_APPLICATION_SCHEMA,
      controlStorage,
      dataStorage,
      binding,
      writerLease: Object.freeze({
        generation: leaseState.holder.generation,
        expiresAt: leaseState.holder.expiresAt,
      }),
      attestation: Object.freeze({
        control: controlAttestation.control.evidence,
        data: dataAttestation.data.evidence,
      }),
      backupEvidence: Object.freeze({
        contract: 1,
        adapter: 'postgresql',
        bindingUuid: binding.dataPlaneId,
        tenantFingerprint: fingerprintPostgresqlTenant(options.tenantId),
        resourceFingerprint: dataAttestation.data.resource.resourceFingerprint,
        migrationSetFingerprint: dataAttestation.data.migrationSetFingerprint,
        repositoryFingerprint,
      }),
      health() {
        const snapshot = describeWriterHealth(leaseState.holder, options.now, leaseState.closed);
        observeReadiness(snapshot);
        return snapshot;
      },
      async close() {
        if (leaseState.closed) return;
        leaseState.closed = true;
        observeReadiness(describeWriterHealth(leaseState.holder, options.now, true));
        const releaser = await connectBounded(controlPool, acquisitionDeadlineMs).catch(() => null);
        if (releaser) {
          try {
            await exec(releaser, 'BEGIN');
            await exec(
              releaser,
              'SELECT pg_advisory_xact_lock($1, $2)',
              [PROVISIONING_ADVISORY_LOCK.classId, provisioningLockObjectId(options.tenantId)],
            );
            await exec(releaser, 'SET LOCAL search_path TO pg_catalog');
            await expireWriterLease(releaser, {
              tenantId: options.tenantId,
              leaseId: leaseState.holder.leaseId,
              generation: leaseState.holder.generation,
              clock: options.clock,
              now: options.now,
            });
            await exec(releaser, 'COMMIT');
          } catch {
            await rollbackQuietly(releaser);
          } finally {
            releaseClient(releaser);
          }
        }
        try { await dataStorage.close(); } catch { try { await dataPool.end(); } catch { /* ignore */ } }
        try { await controlStorage.close(); } catch { try { await controlPool.end(); } catch { /* ignore */ } }
      },
    });
  } catch (error) {
    try { await dataStorage?.close(); } catch { try { await dataPool.end(); } catch { /* ignore */ } }
    try { await controlStorage?.close(); } catch { try { await controlPool.end(); } catch { /* ignore */ } }
    throw error;
  }
}

export { fingerprintMigrationSet, describeWriterHealth };
