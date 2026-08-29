// @ts-check

import { createHash } from 'node:crypto';
import { AppError } from './errors.js';
import { CORE_SCHEMA_INTENT } from './core-schema-intent.js';

/**
 * Pinned SHA-256 of released core migration SQL bytes. Backfill writes these
 * constants, never `hash(current source)`. v1–v5 are the M0 baseline; v6–v7
 * are the subsequently released identities. v8 is new and records `hash(sql)`.
 */
export const PINNED_CORE_MIGRATION_CHECKSUMS = Object.freeze({
  '1:initial_crm_schema': '2d386db73f44bc6da6e76942ba8dba2ee37d6799e5442e9c894d035848a2555e',
  '2:opportunity_source_key': 'deed722482124ab96deb2f884ab4e0fb9308318f9411cc8b67e1bf5552d0093a',
  '3:opportunity_pipeline_state': 'fccd2e6dd49aa73245b301b08bfc7f4dc167e7154a24cd5c56fcb66e444a8c6b',
  '4:definition_versions': 'f2b4daf5f0dbee756ae2b04087c28c0debafcfe474fb78f976ac1dfdfde744a8',
  '5:production_spine_identity': 'dd5ab2cc2a946e2f573bd1536952e18974c19a776b71074f4335602a47cc04fc',
  '6:spine_data_plane_binding_marker': 'c0b4e2e7b0bfc7dcd7427c21d11db4ef8d879a1612650667fcffda0912e92d53',
  '7:spine_cross_plane_audit_intents': '399b3f4aa70dd8aeea00a0d37bef21f952e3b32f84828ed1f6c13721b741c94b',
});

export const SCHEMA_MIGRATIONS_CHECKSUM_VERSION = 8;
export const SCHEMA_MIGRATIONS_CHECKSUM_NAME = 'schema_migrations_checksum';

const BOOKKEEPING_OBJECTS = new Set(['schema_migrations', 'module_migrations']);

/**
 * @param {string} sql
 */
export function sqlChecksum(sql) {
  return createHash('sha256').update(sql).digest('hex');
}

/**
 * @param {number} version
 * @param {string} name
 */
export function pinnedChecksumFor(version, name) {
  return PINNED_CORE_MIGRATION_CHECKSUMS[`${version}:${name}`] ?? null;
}

/**
 * @param {{version: number, name: string, sql: string}} migration
 */
export function checksumForReleasedMigration(migration) {
  const pinned = pinnedChecksumFor(migration.version, migration.name);
  if (pinned) return pinned;
  return sqlChecksum(migration.sql);
}

/**
 * @param {{prepare: Function}} raw
 */
export function ledgerHasChecksumColumn(raw) {
  return raw.prepare('PRAGMA table_info(schema_migrations)').all()
    .some((column) => String(column.name) === 'checksum');
}

/**
 * @param {string} value
 */
function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

/**
 * Physical SQLite schema used to decide whether a ledger backfill is safe.
 * Bookkeeping tables are excluded so a live file can be compared with the
 * schema produced by executing released migration SQL alone.
 *
 * @param {{prepare: Function}} database
 */
export function captureBusinessSchema(database) {
  const objects = database.prepare(`
    SELECT type, name, tbl_name AS tableName, sql
      FROM sqlite_schema
     WHERE name NOT LIKE 'sqlite_%' AND type IN ('table', 'index')
     ORDER BY type, name
  `).all()
    .map((row) => ({ ...row }))
    .filter((row) => !BOOKKEEPING_OBJECTS.has(String(row.name)) && !BOOKKEEPING_OBJECTS.has(String(row.tableName)));
  const tables = objects.filter(({ type }) => type === 'table').map(({ name }) => name);
  const tableDetails = Object.fromEntries(tables.map((name) => [name, {
    columns: database.prepare(`PRAGMA table_xinfo(${quoteIdentifier(name)})`).all().map((row) => ({ ...row })),
    foreignKeys: database.prepare(`PRAGMA foreign_key_list(${quoteIdentifier(name)})`).all().map((row) => ({ ...row })),
    indexes: database.prepare(`PRAGMA index_list(${quoteIdentifier(name)})`).all().map((index) => ({
      ...index,
      columns: database.prepare(`PRAGMA index_xinfo(${quoteIdentifier(index.name)})`).all().map((row) => ({ ...row })),
    })),
  }]));
  return { objects, tables: tableDetails };
}

/**
 * Expected business tables/indexes/columns from core schema intent for the
 * applied version set. Intentionally does not open a second SQLite handle —
 * startup already owns the file being upgraded.
 *
 * @param {Array<{version: number, name: string}>} applied
 */
export function expectedSchemaFromIntent(applied) {
  const appliedVersions = new Map(applied.map((row) => [Number(row.version), String(row.name)]));
  /** @type {Map<string, string[]>} */
  const tables = new Map();
  /** @type {Set<string>} */
  const indexes = new Set();
  for (const intent of CORE_SCHEMA_INTENT) {
    if (intent.version >= SCHEMA_MIGRATIONS_CHECKSUM_VERSION) continue;
    const recordedName = appliedVersions.get(intent.version);
    if (recordedName === undefined) continue;
    if (recordedName !== intent.name) throw ledgerUnknown(intent.version, recordedName);
    for (const statement of intent.statements) {
      if (statement.kind === 'createTable') {
        tables.set(statement.name, statement.columns.map((column) => column.name));
      }
      if (statement.kind === 'addColumn') {
        const columns = tables.get(statement.table) ?? [];
        columns.push(statement.column.name);
        tables.set(statement.table, columns);
      }
      if (statement.kind === 'createIndex') indexes.add(statement.name);
    }
  }
  return { tables, indexes };
}

/**
 * @param {number} version
 * @param {string} name
 */
function ledgerUnknown(version, name) {
  return new AppError('schema_migrations row is not a pinned released identity', {
    code: 'CORE_MIGRATION_LEDGER_UNKNOWN',
    status: 500,
    details: { version, name },
  });
}

/**
 * @param {{objects: any[], tables: Record<string, any>}} observed
 * @param {{tables: Map<string, string[]>, indexes: Set<string>}} expected
 */
export function diffObservedToIntent(observed, expected) {
  const observedTables = new Set(observed.objects.filter((entry) => entry.type === 'table').map((entry) => entry.name));
  const observedIndexes = new Set(observed.objects.filter((entry) => entry.type === 'index').map((entry) => entry.name));
  const missing = [
    ...[...expected.tables.keys()].filter((name) => !observedTables.has(name)).map((name) => `table:${name}`),
    ...[...expected.indexes].filter((name) => !observedIndexes.has(name)).map((name) => `index:${name}`),
  ];
  const extraTables = [...observedTables].filter((name) => !expected.tables.has(name));
  const extraIndexes = [...observedIndexes].filter((name) => !expected.indexes.has(name));
  /** @type {string[]} */
  const extraColumns = [];
  for (const [table, columns] of expected.tables) {
    const observedColumns = (observed.tables[table]?.columns ?? []).map((column) => column.name);
    for (const column of columns) {
      if (!observedColumns.includes(column) && !missing.includes(`table:${table}`)) {
        missing.push(`column:${table}.${column}`);
      }
    }
    for (const column of observedColumns) {
      if (!columns.includes(column)) extraColumns.push(`${table}.${column}`);
    }
  }
  return { missing, extra: [...extraTables.map((name) => `table:${name}`), ...extraIndexes.map((name) => `index:${name}`), ...extraColumns] };
}

/**
 * Validate applied ledger rows and observed schema, then add `checksum` and
 * stamp pinned values. Callers run this inside the version-8 startup
 * transaction.
 *
 * @param {any} raw
 * @param {{alterSql: string, releasedMigrations: Array<{version: number, name: string, sql: string}>}} input
 */
export function applySchemaMigrationsChecksumUpgrade(raw, input) {
  const applied = raw.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all()
    .map((row) => ({ version: Number(row.version), name: String(row.name) }));

  for (const row of applied) {
    const pinned = pinnedChecksumFor(row.version, row.name);
    if (!pinned) throw ledgerUnknown(row.version, row.name);
    const released = input.releasedMigrations.find((migration) => migration.version === row.version);
    if (!released || released.name !== row.name) throw ledgerUnknown(row.version, row.name);
    if (sqlChecksum(released.sql) !== pinned) {
      throw new AppError('Released core migration SQL does not match its pinned checksum', {
        code: 'CORE_MIGRATION_CHECKSUM_DRIFT',
        status: 500,
        details: { version: row.version, name: row.name },
      });
    }
  }

  const observed = captureBusinessSchema(raw);
  const expected = expectedSchemaFromIntent(applied);
  const { missing, extra } = diffObservedToIntent(observed, expected);
  if (missing.length > 0) {
    throw new AppError('Observed schema is missing objects from the pinned released identity', {
      code: 'CORE_MIGRATION_SCHEMA_MISSING_OBJECT',
      status: 500,
      details: { missing: missing.slice(0, 8) },
    });
  }
  if (extra.length > 0) {
    throw new AppError('Observed schema diverges from the pinned released identity', {
      code: 'CORE_MIGRATION_SCHEMA_DIVERGED',
      status: 500,
    });
  }

  if (!ledgerHasChecksumColumn(raw)) {
    raw.exec(input.alterSql);
  }
  for (const row of applied) {
    const checksum = pinnedChecksumFor(row.version, row.name);
    raw.prepare('UPDATE schema_migrations SET checksum = ? WHERE version = ?').run(checksum, row.version);
  }
}
