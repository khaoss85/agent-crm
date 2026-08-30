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
import { attestPostgresqlStartup, fingerprintMigrationSet } from './startup-attestation.js';

export const POSTGRES_APPLICATION_SCHEMA = POSTGRES_SCHEMA_NAME;
export const CONTROL_ADVISORY_LOCK = Object.freeze({ classId: 1094927186, objectId: 1129598001 });
export const DATA_ADVISORY_LOCK = Object.freeze({ classId: 1094927186, objectId: 1145197617 });

const LEDGER_TABLE = 'schema_migrations';
const MODULE_LEDGER_TABLE = 'module_migrations';
const STARTUP_AUDIT_TABLE = 'startup_audit';
const BINDING_TABLE = 'spine_data_plane_binding';
const CONTROL_BINDING_TABLE = 'spine_tenant_bindings';

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

function tenantFingerprint(tenantId) {
  return createHash('sha256').update(`accordo.tenant.v1\0${tenantId}`).digest('hex');
}

function nowIso(clock) {
  return clock ? clock() : new Date().toISOString();
}

function fault(options, name) {
  if (options?.faultInject === name) {
    refuse('STARTUP_FAULT_INJECTED', 'injected startup fault', { boundary: name });
  }
}

/**
 * @param {any} client
 * @param {string} sql
 * @param {unknown[]} [params]
 */
async function exec(client, sql, params = []) {
  try {
    return await client.query(sql, params);
  } catch (error) {
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
        tenantFingerprint(tenantId),
        attestation.evidence.identityFingerprint,
        attestation.evidence.evidenceFingerprint,
        attestation.resource.resourceFingerprint,
        attestation.migrationSetFingerprint,
        attestation.challengeFingerprint,
        attestation.evidence.permission,
        `${plane}:${migration.name}`,
        nowIso(clock),
      ],
    );
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
        tenantFingerprint(tenantId),
        attestation.evidence.identityFingerprint,
        attestation.evidence.evidenceFingerprint,
        attestation.resource.resourceFingerprint,
        attestation.migrationSetFingerprint,
        attestation.challengeFingerprint,
        attestation.evidence.permission,
        `module:${migration.name}`,
        nowIso(clock),
      ],
    );
    fault({ faultInject }, `${prefix}-after-module-${migration.name}`);
  }
}

async function claimDataPlane(client, { tenantId, clock, faultInject }) {
  const existing = await exec(client, `SELECT tenant_slug, data_plane_id FROM ${qualify(BINDING_TABLE)} WHERE singleton = 1`);
  const row = existing.rows?.[0];
  if (row) {
    if (String(row.tenant_slug) !== tenantId) {
      refuse('TENANT_BINDING_MISMATCH', 'the PostgreSQL data plane is already bound to a different tenant');
    }
    return Object.freeze({ tenantSlug: String(row.tenant_slug), dataPlaneId: String(row.data_plane_id) });
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
  const existing = await exec(
    client,
    `SELECT tenant_slug, data_plane_id FROM ${qualify(CONTROL_BINDING_TABLE)} WHERE tenant_slug = $1`,
    [tenantId],
  );
  const row = existing.rows?.[0];
  if (row) {
    if (row.data_plane_id && String(row.data_plane_id) !== dataPlaneId) {
      refuse('TENANT_BINDING_MISMATCH', 'the control plane already maps this tenant to a different data plane');
    }
    if (!row.data_plane_id) {
      await exec(
        client,
        `UPDATE ${qualify(CONTROL_BINDING_TABLE)} SET data_plane_id = $1 WHERE tenant_slug = $2 AND data_plane_id IS NULL`,
        [dataPlaneId, tenantId],
      );
    }
    return;
  }
  await exec(
    client,
    `INSERT INTO ${qualify(CONTROL_BINDING_TABLE)}(tenant_slug, data_plane_id, created_at) VALUES ($1, $2, $3)`,
    [tenantId, dataPlaneId, nowIso(clock)],
  );
}

async function bootstrapPlane(pool, {
  plane, lock, migrations, moduleMigrations, attestation, tenantId, clock, faultInject,
  afterSchema,
}) {
  const client = await pool.connect();
  let active = false;
  try {
    await exec(client, 'BEGIN');
    active = true;
    await exec(client, 'SELECT pg_advisory_xact_lock($1, $2)', [lock.classId, lock.objectId]);
    await exec(client, `SET LOCAL search_path TO pg_catalog`);
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
    await exec(client, 'COMMIT');
    active = false;
    return extra;
  } catch (error) {
    if (active) {
      try { await client.query('ROLLBACK'); } catch { /* primary wins */ }
    }
    throw error instanceof AppError ? error : new AppError('PostgreSQL startup storage failed', {
      code: 'STORAGE_UNAVAILABLE', status: 500,
    });
  } finally {
    try { client.release(); } catch { /* already gone */ }
  }
}

function assertSeparateEndpoints(control, data) {
  const identity = (endpoint) => `${String(endpoint.host).toLowerCase()}|${endpoint.port ?? 5432}|${endpoint.database}`;
  if (identity(control) === identity(data)) {
    refuse('DEPLOYMENT_STORAGE_PLANES_ALIAS', 'PostgreSQL control and data planes must not share an endpoint identity');
  }
}

/**
 * Bootstrap control then data on PostgreSQL. Attestation completes before any
 * DDL. Each plane's migration units, ledger rows and startup audit commit
 * together under `pg_advisory_xact_lock`.
 *
 * @param {{
 *   control: { host: string, port?: number, database: string, user: string, password: string, ssl?: false | object, max?: number },
 *   data: { host: string, port?: number, database: string, user: string, password: string, ssl?: false | object, max?: number },
 *   tenantId: string,
 *   identityVerifier: { operations: any },
 *   moduleMigrations?: Array<{name: string, sql: string}>,
 *   selectedExtra?: unknown[],
 *   clock?: () => string,
 *   faultInject?: string,
 *   now?: () => number,
 * }} options
 */
export async function bootstrapPostgresqlApplication(options) {
  assertSeparateEndpoints(options.control, options.data);
  const controlMigrations = postgresqlControlMigrations();
  const dataMigrations = postgresqlDataMigrations();
  const moduleMigrations = options.moduleMigrations ?? [];
  const repositoryFingerprint = fingerprintPostgresqlRepository(options.selectedExtra ?? []);
  const attestation = await attestPostgresqlStartup({
    operations: options.identityVerifier.operations,
    tenantId: options.tenantId,
    repositoryFingerprint,
    controlMigrations,
    dataMigrations: [
      ...dataMigrations,
      ...moduleMigrations.map((migration) => ({ name: migration.name, checksum: sqlChecksum(migration.sql) })),
    ],
    now: options.now,
  });

  const controlPool = createPostgresqlPool(options.control);
  const dataPool = createPostgresqlPool(options.data);
  let controlStorage;
  let dataStorage;
  try {
    await bootstrapPlane(controlPool, {
      plane: 'control',
      lock: CONTROL_ADVISORY_LOCK,
      migrations: controlMigrations,
      attestation: attestation.control,
      tenantId: options.tenantId,
      clock: options.clock,
      faultInject: options.faultInject,
    });
    controlStorage = createPostgresqlStorage(controlPool, { schema: POSTGRES_APPLICATION_SCHEMA });

    const binding = await bootstrapPlane(dataPool, {
      plane: 'data',
      lock: DATA_ADVISORY_LOCK,
      migrations: dataMigrations,
      moduleMigrations,
      attestation: attestation.data,
      tenantId: options.tenantId,
      clock: options.clock,
      faultInject: options.faultInject,
      afterSchema: (client) => claimDataPlane(client, {
        tenantId: options.tenantId,
        clock: options.clock,
        faultInject: options.faultInject,
      }),
    });

    const controlClient = await controlPool.connect();
    try {
      await controlClient.query('BEGIN');
      await controlClient.query('SELECT pg_advisory_xact_lock($1, $2)', [CONTROL_ADVISORY_LOCK.classId, CONTROL_ADVISORY_LOCK.objectId]);
      await controlClient.query(`SET LOCAL search_path TO pg_catalog`);
      await claimControlBinding(controlClient, {
        tenantId: options.tenantId,
        dataPlaneId: binding.dataPlaneId,
        clock: options.clock,
      });
      await controlClient.query('COMMIT');
    } catch (error) {
      try { await controlClient.query('ROLLBACK'); } catch { /* primary */ }
      throw error instanceof AppError ? error : new AppError('PostgreSQL startup storage failed', {
        code: 'STORAGE_UNAVAILABLE', status: 500,
      });
    } finally {
      try { controlClient.release(); } catch { /* ignore */ }
    }

    dataStorage = createPostgresqlStorage(dataPool, { schema: POSTGRES_APPLICATION_SCHEMA });
    let closed = false;
    return Object.freeze({
      adapter: 'postgresql',
      schema: POSTGRES_APPLICATION_SCHEMA,
      controlStorage,
      dataStorage,
      binding,
      attestation: Object.freeze({
        control: attestation.control.evidence,
        data: attestation.data.evidence,
      }),
      async close() {
        if (closed) return;
        closed = true;
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

export { fingerprintMigrationSet };
