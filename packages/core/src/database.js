// @ts-check

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { AppError, ConflictError } from './errors.js';
import { createSqliteStorage } from './storage-contract.js';
import { currentTransactionWitness } from './transaction-witness.js';
import { openTransactionScope } from './transaction-minter.js';
import {
  SCHEMA_MIGRATIONS_CHECKSUM_NAME,
  SCHEMA_MIGRATIONS_CHECKSUM_VERSION,
  applySchemaMigrationsChecksumUpgrade,
  checksumForReleasedMigration,
  ledgerHasChecksumColumn,
} from './schema-migrations-ledger.js';

/**
 * @typedef {{
 *   raw: DatabaseSync,
 *   storage: ReturnType<typeof createSqliteStorage>,
 *   path: string,
 *   plane: 'combined'|'data'|'control',
 *   close: () => void,
 *   transaction: <T>(fn: () => T) => T,
 *   transactionAsync: <T>(fn: () => Promise<T>) => Promise<T>
 * }} AccordoDatabase
 */

/**
 * **The tenant CRM data plane.** Every record, audit row, workflow run and
 * trace span a tenant's users can reach. One database file per tenant when a
 * tenant binding is configured (ADR-038). A fresh file receives only this
 * family; explicit adoption may preserve dormant tables from a released
 * combined file, but CRM services still receive only this dedicated handle.
 */
const DATA_PLANE_MIGRATIONS = [
  {
    version: 1,
    name: 'initial_crm_schema',
    sql: `
      CREATE TABLE IF NOT EXISTS companies (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        domain TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS contacts (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        first_name TEXT NOT NULL,
        last_name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        role TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS opportunities (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
        contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('new_business', 'renewal', 'upsell')),
        value_cents INTEGER NOT NULL CHECK(value_cents >= 0),
        currency TEXT NOT NULL,
        stage TEXT NOT NULL CHECK(stage IN ('discovery', 'qualification', 'proposal', 'approval_pending', 'negotiation', 'won', 'lost')),
        owner TEXT NOT NULL,
        expected_close_date TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        opportunity_id TEXT NOT NULL REFERENCES opportunities(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'rejected')),
        reason TEXT NOT NULL,
        requested_by TEXT NOT NULL,
        decided_by TEXT,
        requested_at TEXT NOT NULL,
        decided_at TEXT
      ) STRICT;

      CREATE UNIQUE INDEX IF NOT EXISTS approvals_one_pending_per_opportunity
        ON approvals(opportunity_id)
        WHERE status = 'pending';

      CREATE TABLE IF NOT EXISTS workflow_runs (
        id TEXT PRIMARY KEY,
        workflow_name TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed')),
        input_json TEXT NOT NULL,
        output_json TEXT,
        error TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT
      ) STRICT;

      CREATE TABLE IF NOT EXISTS trace_spans (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
        parent_span_id TEXT,
        name TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('running', 'completed', 'failed', 'compensated')),
        input_json TEXT,
        output_json TEXT,
        error TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT
      ) STRICT;

      CREATE INDEX IF NOT EXISTS trace_spans_run_id ON trace_spans(run_id);

      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        actor_type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        data_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS audit_events_entity ON audit_events(entity_type, entity_id);
      CREATE INDEX IF NOT EXISTS audit_events_created_at ON audit_events(created_at DESC);
    `,
  },
  {
    version: 2,
    name: 'opportunity_source_key',
    // A deterministic origin key for opportunities created by a workflow/action
    // (e.g. lead conversion: 'lead-conversion:<leadId>'). The partial UNIQUE
    // index makes duplicate-origin opportunities impossible at the database
    // layer while leaving ordinary opportunities (NULL key) untouched.
    sql: `
      ALTER TABLE opportunities ADD COLUMN source_key TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS opportunities_source_key
        ON opportunities(source_key)
        WHERE source_key IS NOT NULL;
    `,
  },
  {
    version: 3,
    name: 'opportunity_pipeline_state',
    // Configurable-pipeline state (ADR-014). Nullable: pre-pipeline
    // opportunities (and projects with no pipeline installed) stay valid with
    // pipeline_key NULL — "not on a board". These columns are server-managed:
    // the service refuses them in public create input and only its in-process
    // applyManaged path writes them.
    sql: `
      ALTER TABLE opportunities ADD COLUMN pipeline_key TEXT;
      ALTER TABLE opportunities ADD COLUMN pipeline_stage TEXT;
      ALTER TABLE opportunities ADD COLUMN stage_entered_at TEXT;
      ALTER TABLE opportunities ADD COLUMN closed_at TEXT;
      ALTER TABLE opportunities ADD COLUMN close_reason TEXT;
      CREATE INDEX IF NOT EXISTS opportunities_pipeline_stage
        ON opportunities(pipeline_key, pipeline_stage);
    `,
  },
  {
    version: 4,
    name: 'definition_versions',
    // Runtime identity for versioned code-first definitions (ADR-015): every
    // published scoring model / routing policy {type, name, version} records
    // its deterministic source fingerprint here at startup. Git history alone
    // is not runtime policy versioning — a definition whose source changes
    // under an already-registered version must fail loudly at boot, and every
    // run additionally stores the fingerprint it executed under.
    sql: `
      CREATE TABLE IF NOT EXISTS definition_versions (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        version INTEGER NOT NULL,
        fingerprint TEXT NOT NULL,
        registered_at TEXT NOT NULL,
        UNIQUE(type, name, version)
      ) STRICT;
    `,
  },
  {
    version: 6,
    name: 'spine_data_plane_binding_marker',
    // M2 cross-plane audit recovery needs a destination identity that is not a
    // path, URL or credential. The one row is written/verified before an
    // Organization can be resolved and is immutable afterwards. Version 6 is
    // globally append-only: the released v1-v5 prefix is never renumbered.
    sql: `
      CREATE TABLE spine_data_plane_binding (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        tenant_slug TEXT NOT NULL,
        data_plane_id TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TRIGGER spine_data_plane_binding_no_update
      BEFORE UPDATE ON spine_data_plane_binding
      BEGIN
        SELECT RAISE(ABORT, 'spine data-plane binding is immutable');
      END;

      CREATE TRIGGER spine_data_plane_binding_no_delete
      BEFORE DELETE ON spine_data_plane_binding
      BEGIN
        SELECT RAISE(ABORT, 'spine data-plane binding is immutable');
      END;
    `,
  },
];

/**
 * **The control plane.** Organizations and Memberships — the tenant of the
 * SOFTWARE and the people who may act inside it. Deliberately a separate list
 * from the data plane. Fresh files have disjoint schemas, so a stray write
 * across the boundary raises `no such table`. Explicit adoption may retain
 * dormant opposite-plane tables; service wiring and distinct handles remain
 * the enforcement rather than a destructive migration.
 *
 * A legacy single-file project applied this as version 5 of one combined list.
 * It still does — `plane: 'combined'` is the default — so nothing that boots
 * today stops booting.
 */
const CONTROL_PLANE_MIGRATIONS = [
  {
    version: 5,
    name: 'production_spine_identity',
    // Production Spine v1 (ADR-038). These hold the tenant of the SOFTWARE and
    // the people who may act inside it — infrastructure, not a CRM domain.
    //
    // The `spine_` prefix is deliberate and load-bearing: an Accordo
    // Organization is NOT a CRM Company. A Company is a customer recorded
    // inside one tenant's data; an Organization is the tenant itself. Naming
    // them apart in the schema is the cheapest possible place to stop the two
    // being confused, and every layer above repeats the distinction.
    //
    // `provenance` records how an organization came to exist, because a local
    // development tenant created by a migration must never later be mistaken
    // for one an operator deliberately configured.
    sql: `
      CREATE TABLE IF NOT EXISTS spine_organizations (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        provenance TEXT NOT NULL CHECK(provenance IN ('operator-configured', 'local-development-migration')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS spine_memberships (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL REFERENCES spine_organizations(id) ON DELETE CASCADE,
        subject TEXT NOT NULL,
        issuer TEXT,
        role TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active', 'suspended')),
        granted_by_subject TEXT,
        granted_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(organization_id, subject)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS spine_memberships_subject
        ON spine_memberships(subject);
    `,
  },
  {
    version: 7,
    name: 'spine_cross_plane_audit_intents',
    // M2 bounded recovery for Organization/Membership audit. This is not a
    // general outbox: its schema is closed over exactly one security-evidence
    // event and permits one terminal transition, pending -> delivered.
    sql: `
      ALTER TABLE spine_organizations ADD COLUMN audit_revision INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE spine_memberships ADD COLUMN audit_revision INTEGER NOT NULL DEFAULT 0;

      CREATE TRIGGER spine_organizations_audit_revision_insert
      BEFORE INSERT ON spine_organizations
      WHEN NEW.audit_revision < 0 OR NEW.audit_revision > 9007199254740991
      BEGIN
        SELECT RAISE(ABORT, 'spine audit revision must be a non-negative safe integer');
      END;

      CREATE TRIGGER spine_organizations_audit_revision_update
      BEFORE UPDATE OF audit_revision ON spine_organizations
      WHEN NEW.audit_revision < 0 OR NEW.audit_revision > 9007199254740991
      BEGIN
        SELECT RAISE(ABORT, 'spine audit revision must be a non-negative safe integer');
      END;

      CREATE TRIGGER spine_memberships_audit_revision_insert
      BEFORE INSERT ON spine_memberships
      WHEN NEW.audit_revision < 0 OR NEW.audit_revision > 9007199254740991
      BEGIN
        SELECT RAISE(ABORT, 'spine audit revision must be a non-negative safe integer');
      END;

      CREATE TRIGGER spine_memberships_audit_revision_update
      BEFORE UPDATE OF audit_revision ON spine_memberships
      WHEN NEW.audit_revision < 0 OR NEW.audit_revision > 9007199254740991
      BEGIN
        SELECT RAISE(ABORT, 'spine audit revision must be a non-negative safe integer');
      END;

      CREATE TABLE spine_tenant_bindings (
        tenant_slug TEXT PRIMARY KEY,
        data_plane_id TEXT UNIQUE,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TRIGGER spine_tenant_bindings_no_update
      BEFORE UPDATE ON spine_tenant_bindings
      WHEN NEW.tenant_slug IS NOT OLD.tenant_slug
        OR NEW.created_at IS NOT OLD.created_at
        OR OLD.data_plane_id IS NOT NULL
        OR NEW.data_plane_id IS NULL
      BEGIN
        SELECT RAISE(ABORT, 'spine tenant binding permits only its first data-plane claim');
      END;

      CREATE TRIGGER spine_tenant_bindings_no_delete
      BEFORE DELETE ON spine_tenant_bindings
      BEGIN
        SELECT RAISE(ABORT, 'spine tenant binding is immutable');
      END;

      CREATE TABLE spine_audit_intents (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        destination_tenant_slug TEXT NOT NULL,
        audit_event_id TEXT NOT NULL UNIQUE,
        payload_fingerprint TEXT NOT NULL,
        actor_type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        data_json TEXT NOT NULL,
        mutation_revision INTEGER NOT NULL
          CHECK(mutation_revision BETWEEN 1 AND 9007199254740991),
        created_at TEXT NOT NULL,
        delivered_at TEXT,
        UNIQUE(entity_type, entity_id, mutation_revision),
        FOREIGN KEY(destination_tenant_slug)
          REFERENCES spine_tenant_bindings(tenant_slug) ON DELETE RESTRICT
      ) STRICT;

      CREATE INDEX spine_audit_intents_pending_destination
        ON spine_audit_intents(destination_tenant_slug, created_at, id)
        WHERE delivered_at IS NULL;

      CREATE TRIGGER spine_audit_intents_terminal_update
      BEFORE UPDATE ON spine_audit_intents
      WHEN NEW.id IS NOT OLD.id
        OR NEW.idempotency_key IS NOT OLD.idempotency_key
        OR NEW.destination_tenant_slug IS NOT OLD.destination_tenant_slug
        OR NEW.audit_event_id IS NOT OLD.audit_event_id
        OR NEW.payload_fingerprint IS NOT OLD.payload_fingerprint
        OR NEW.actor_type IS NOT OLD.actor_type
        OR NEW.actor_id IS NOT OLD.actor_id
        OR NEW.action IS NOT OLD.action
        OR NEW.entity_type IS NOT OLD.entity_type
        OR NEW.entity_id IS NOT OLD.entity_id
        OR NEW.data_json IS NOT OLD.data_json
        OR NEW.mutation_revision IS NOT OLD.mutation_revision
        OR NEW.created_at IS NOT OLD.created_at
        OR OLD.delivered_at IS NOT NULL
        OR NEW.delivered_at IS NULL
      BEGIN
        SELECT RAISE(ABORT, 'spine audit intent is immutable except pending-to-delivered');
      END;

      CREATE TRIGGER spine_audit_intents_no_delete
      BEFORE DELETE ON spine_audit_intents
      BEGIN
        SELECT RAISE(ABORT, 'spine audit intent history is immutable');
      END;
    `,
  },
];

/**
 * Checksum column on `schema_migrations`. Every plane receives it once so a
 * dedicated data file, a dedicated control file and a combined legacy file
 * all grow the same ledger. Not a CRM table.
 */
const LEDGER_MIGRATIONS = [
  {
    version: SCHEMA_MIGRATIONS_CHECKSUM_VERSION,
    name: SCHEMA_MIGRATIONS_CHECKSUM_NAME,
    sql: `
      ALTER TABLE schema_migrations ADD COLUMN checksum TEXT;
    `,
  },
];

/**
 * Which migrations a database receives.
 *
 * `combined` is the historical single-file shape and remains the default, so
 * every existing composition is byte-for-byte unaffected. A spine with a
 * tenant binding opens two databases and asks for one plane each.
 */
const MIGRATION_PLANES = Object.freeze({
  // The plane subsets have holes by design (data owns v6, control owns v7).
  // A combined legacy database must retain the globally ordered v1-v5 prefix,
  // so concatenating the subsets would incorrectly run v6 before v5.
  combined: [...DATA_PLANE_MIGRATIONS, ...CONTROL_PLANE_MIGRATIONS, ...LEDGER_MIGRATIONS]
    .sort((left, right) => left.version - right.version),
  data: [...DATA_PLANE_MIGRATIONS, ...LEDGER_MIGRATIONS]
    .sort((left, right) => left.version - right.version),
  control: [...CONTROL_PLANE_MIGRATIONS, ...LEDGER_MIGRATIONS]
    .sort((left, right) => left.version - right.version),
});

/**
 * Internal M0 characterization seam. It exposes the evaluated descriptors the
 * SQLite migrator actually consumes, so the pre-PostgreSQL checksum baseline is
 * independent of this file's object-literal formatting. It is deliberately not
 * re-exported from `packages/core/index.js` and is not a product API.
 */
export const CORE_MIGRATIONS_FOR_CHARACTERIZATION = Object.freeze([
  ...DATA_PLANE_MIGRATIONS.map((migration) => Object.freeze({ plane: 'data', ...migration })),
  ...CONTROL_PLANE_MIGRATIONS.map((migration) => Object.freeze({ plane: 'control', ...migration })),
  ...LEDGER_MIGRATIONS.map((migration) => Object.freeze({ plane: 'ledger', ...migration })),
].sort((left, right) => left.version - right.version));

/** The migration versions each plane owns, published so a test can pin them. */
export const MIGRATION_VERSIONS = Object.freeze({
  combined: Object.freeze(MIGRATION_PLANES.combined.map((m) => m.version)),
  data: Object.freeze(MIGRATION_PLANES.data.map((m) => m.version)),
  control: Object.freeze(MIGRATION_PLANES.control.map((m) => m.version)),
});

/**
 * True for the SQLite "database is locked / busy" family of errors — another
 * connection holds the write lock and the busy timeout expired.
 * @param {unknown} error
 */
function isBusyError(error) {
  if (!(error instanceof Error)) return false;
  const code = /** @type {any} */ (error).code;
  return (
    code === 'ERR_SQLITE_BUSY' ||
    /database (?:table )?is locked|SQLITE_BUSY/i.test(error.message)
  );
}

const STARTUP_BUSY_RETRY_DELAYS_MS = Object.freeze([5, 20, 50]);
const startupWaitCell = new Int32Array(new SharedArrayBuffer(4));
const CORE_MIGRATION_BY_VERSION = new Map(
  MIGRATION_PLANES.combined.map((migration) => [migration.version, migration]),
);

function startupBusyError() {
  return new AppError(
    'Database startup could not acquire its bounded migration lock; retry startup',
    { code: 'CORE_DATABASE_STARTUP_BUSY', status: 503 },
  );
}

/** Startup-only bounded retry. Runtime/business writes never call this helper. */
function withStartupBusyRetry(operation) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      if (!isBusyError(error)) throw error;
      const delay = STARTUP_BUSY_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) throw startupBusyError();
      Atomics.wait(startupWaitCell, 0, 0, delay);
    }
  }
}

function expectedMigrationChecksum(migration) {
  return checksumForReleasedMigration(migration);
}

function assertRecordedChecksum(version, name, recordedChecksum) {
  if (recordedChecksum === undefined || recordedChecksum === null) {
    throw new AppError('schema_migrations checksum is missing after the ledger upgrade', {
      code: 'CORE_MIGRATION_CHECKSUM_MISSING',
      status: 500,
      details: { version, name },
    });
  }
  const known = CORE_MIGRATION_BY_VERSION.get(version);
  if (!known) return;
  const expected = expectedMigrationChecksum(known);
  if (String(recordedChecksum) !== expected) {
    throw new AppError('schema_migrations checksum does not match the pinned released identity', {
      code: 'CORE_MIGRATION_CHECKSUM_MISMATCH',
      status: 500,
      details: { version, name },
    });
  }
}

function assertCoreMigrationIdentity(applied, checksums) {
  for (const [version, recordedName] of applied) {
    const known = CORE_MIGRATION_BY_VERSION.get(version);
    if (known && recordedName !== known.name) {
      throw new AppError(
        `Core migration version ${version} is recorded with the wrong immutable name`,
        {
          code: 'CORE_MIGRATION_IDENTITY_MISMATCH', status: 500,
          details: { version, expectedName: known.name },
        },
      );
    }
    if (checksums?.has(version)) {
      assertRecordedChecksum(version, recordedName, checksums.get(version));
    }
  }
}

function assertMigrationPlane(applied, expectedPlane) {
  if (expectedPlane === 'combined' || applied.size === 0) return;
  const hasDataHistory = [1, 2, 3, 4].some((version) => applied.has(version));
  const hasDataIdentity = applied.has(6);
  const hasControlIdentity = applied.has(5) || applied.has(7);
  const recordedPlane = hasDataIdentity && hasControlIdentity
    ? 'combined'
    : hasDataIdentity || (hasDataHistory && !hasControlIdentity)
      ? 'data'
      : hasControlIdentity
        ? 'control'
        : null;

  // A released combined file can be copied into a dedicated plane without
  // deleting the other family's dormant tables. Data history distinguishes
  // that compatibility input from a control-only file. v6 is the persistent
  // data-file identity and can never be adopted as control; a control-only
  // ledger has no data history and can never be adopted as data.
  const mismatch = expectedPlane === 'control'
    ? hasDataIdentity || (hasDataHistory && !hasControlIdentity)
    : hasControlIdentity && !hasDataHistory;
  if (recordedPlane && mismatch) {
    throw new AppError(
      'The selected database file carries a different core migration plane identity',
      {
        code: 'CORE_DATABASE_PLANE_MISMATCH', status: 500,
        details: { expectedPlane, recordedPlane },
      },
    );
  }
}

/**
 * @param {{path?: string, moduleMigrations?: Array<{name: string, sql: string}>, busyTimeoutMs?: number, plane?: 'combined'|'data'|'control'}} [options]
 * @returns {AccordoDatabase}
 */
export function createDatabase(options = {}) {
  // Which plane this file is. Defaults to the historical combined shape, so a
  // caller that does not know about planes keeps the database it always got.
  const plane = options.plane ?? 'combined';
  const migrations = MIGRATION_PLANES[plane];
  if (!migrations) {
    throw new Error(`Unknown migration plane "${plane}": expected combined, data or control.`);
  }
  const requestedPath = options.path ?? process.env.CRM_DB_PATH ?? './data/accordo.sqlite';
  const dbPath = requestedPath === ':memory:' ? requestedPath : resolve(requestedPath);
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });

  const raw = new DatabaseSync(dbPath);
  try {
    withStartupBusyRetry(() => raw.exec('PRAGMA foreign_keys = ON;'));
    withStartupBusyRetry(() => raw.exec(`PRAGMA busy_timeout = ${Number.isInteger(options.busyTimeoutMs) && /** @type {number} */ (options.busyTimeoutMs) >= 0 ? options.busyTimeoutMs : 5000};`));
    if (dbPath !== ':memory:') withStartupBusyRetry(() => raw.exec('PRAGMA journal_mode = WAL;'));

    withStartupBusyRetry(() => raw.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      ) STRICT;
    `));

    const checksumColumn = () => ledgerHasChecksumColumn(raw);
    const readCoreMigration = (version) => raw
      .prepare(checksumColumn()
        ? 'SELECT version, name, checksum FROM schema_migrations WHERE version = ?'
        : 'SELECT version, name FROM schema_migrations WHERE version = ?')
      .get(version);
    const readCoreMigrations = () => new Map(
      raw.prepare(checksumColumn()
        ? 'SELECT version, name, checksum FROM schema_migrations'
        : 'SELECT version, name FROM schema_migrations').all()
        .map((row) => [Number(row.version), String(row.name)]),
    );
    const readCoreChecksums = () => {
      if (!checksumColumn()) return null;
      return new Map(
        raw.prepare('SELECT version, checksum FROM schema_migrations').all()
          .map((row) => [Number(row.version), row.checksum === null ? null : String(row.checksum)]),
      );
    };
    const applied = withStartupBusyRetry(readCoreMigrations);
    // Identity is global, not selected-plane-local. A data file carrying a
    // wrong control migration name (or the reverse) must never pass merely
    // because this boot would not execute that migration family.
    assertCoreMigrationIdentity(applied, withStartupBusyRetry(readCoreChecksums) ?? undefined);
    assertMigrationPlane(applied, plane);

    const startupTransaction = (fn) => withStartupBusyRetry(() => {
      let active = false;
      try {
        raw.exec('BEGIN IMMEDIATE;');
        active = true;
        const result = fn();
        raw.exec('COMMIT;');
        active = false;
        return result;
      } catch (error) {
        if (active) {
          try { raw.exec('ROLLBACK;'); } catch {}
        }
        throw error;
      }
    });

    for (const migration of migrations) {
      startupTransaction(() => {
        // Re-read only after owning the write lock. Two fresh processes may
        // both have observed an empty ledger; the second must converge on the
        // first process's committed migration, not rerun it or race its INSERT.
        const recorded = readCoreMigration(migration.version);
        if (recorded) {
          const checksums = recorded.checksum !== undefined
            ? new Map([[Number(recorded.version), recorded.checksum === null ? null : String(recorded.checksum)]])
            : undefined;
          assertCoreMigrationIdentity(new Map([[Number(recorded.version), String(recorded.name)]]), checksums);
          return;
        }
        const isLedgerUpgrade = migration.version === SCHEMA_MIGRATIONS_CHECKSUM_VERSION
          && migration.name === SCHEMA_MIGRATIONS_CHECKSUM_NAME;
        if (isLedgerUpgrade) {
          applySchemaMigrationsChecksumUpgrade(raw, {
            alterSql: migration.sql,
            releasedMigrations: CORE_MIGRATIONS_FOR_CHARACTERIZATION.filter(
              (entry) => entry.version < SCHEMA_MIGRATIONS_CHECKSUM_VERSION,
            ),
          });
        } else {
          raw.exec(migration.sql);
        }
        const checksum = expectedMigrationChecksum(migration);
        if (ledgerHasChecksumColumn(raw)) {
          raw.prepare(
            'INSERT INTO schema_migrations(version, name, applied_at, checksum) VALUES (?, ?, ?, ?)',
          ).run(migration.version, migration.name, new Date().toISOString(), checksum);
        } else {
          raw.prepare(
            'INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)',
          ).run(migration.version, migration.name, new Date().toISOString());
        }
      });
    }

  // Generated-module migrations are keyed by name, not version, so the set can
  // grow in any order without renumbering migrations that already ran. The SQL
  // checksum makes drift detectable: an applied migration whose SQL later
  // changes must fail loudly, never be silently treated as already applied.
    withStartupBusyRetry(() => raw.exec(`
      CREATE TABLE IF NOT EXISTS module_migrations (
        name TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      ) STRICT;
    `));
    const seenMigrationNames = new Set();
    for (const migration of options.moduleMigrations ?? []) {
      if (seenMigrationNames.has(migration.name)) {
        throw new Error(
          `Duplicate module migration name "${migration.name}": two modules claim the same migration identity.`,
        );
      }
      seenMigrationNames.add(migration.name);
      const checksum = createHash('sha256').update(migration.sql).digest('hex');
    // Referential integrity is verified inside the migration's own transaction,
    // so a migration that leaves a dangling reference rolls back rather than
    // being recorded as applied (ADR-019).
    //
    // Deliberately scoped to violations *this* migration introduced: an
    // unrelated pre-existing violation is a real problem, but blocking every
    // future migration on it means such a database can never be upgraded —
    // which is the worse outcome. The check is a before/after comparison
    // because it needs no list of the tables a migration happened to touch.
      const fingerprintViolations = () => new Set(
        raw.prepare('PRAGMA foreign_key_check').all()
          .map((row) => `${String(row.table)}#${String(row.rowid)}#${String(row.fkid)}`),
      );
      startupTransaction(() => {
        const recorded = raw.prepare(
          'SELECT checksum FROM module_migrations WHERE name = ?',
        ).get(migration.name);
        if (recorded) {
          if (String(recorded.checksum) !== checksum) {
            throw new Error(
              `Module migration "${migration.name}" was already applied with different SQL. ` +
                'Applied migrations are immutable: add a new migration instead of editing an applied one.',
            );
          }
          return;
        }
        const preExisting = fingerprintViolations();
        raw.exec(migration.sql);
        const introduced = [...fingerprintViolations()].filter((key) => !preExisting.has(key));
        if (introduced.length > 0) {
          throw new Error(
            `Module migration "${migration.name}" introduced ${introduced.length} foreign key violation(s), `
              + `starting at ${introduced[0]}. The migration was rolled back.`,
          );
        }
        raw
          .prepare('INSERT INTO module_migrations(name, checksum, applied_at) VALUES (?, ?, ?)')
          .run(migration.name, checksum, new Date().toISOString());
      });
    }

  // One outer transaction at a time per connection. SQLite cannot nest BEGIN,
  // so a nested attempt (an action invoking another action, a workflow inside
  // an action) must fail with a clear framework error instead of a raw
  // "cannot start a transaction within a transaction".
  let inOuterTransaction = false;

  function begin() {
    if (inOuterTransaction) {
      throw new AppError(
        'Nested outer transactions are not supported on one connection: actions and workflows cannot start a transaction inside another. Compose module services inside a single action instead.',
        { code: 'NESTED_TRANSACTION', status: 500 },
      );
    }
    try {
      raw.exec('BEGIN IMMEDIATE;');
    } catch (error) {
      if (isBusyError(error)) {
        // Another connection holds the write lock and the busy timeout
        // expired. Surface a stable retryable conflict, never a raw
        // SQLITE_BUSY 500.
        throw new ConflictError('The database is busy with a concurrent write; retry the request', { transient: true });
      }
      throw error;
    }
    inOuterTransaction = true;
  }

  /** @param {unknown} primaryError — never masked by a rollback failure */
  function rollbackSafely(primaryError) {
    try {
      raw.exec('ROLLBACK;');
    } catch (rollbackError) {
      console.error(
        `[accordo] rollback failed after: ${primaryError instanceof Error ? primaryError.message : String(primaryError)} — rollback error: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
      );
    }
  }

  const transaction = (fn) => {
    begin();
    try {
      // The scope mints the witness only after BEGIN has actually succeeded —
      // a witness for a transaction that was never opened would be the one lie
      // this mechanism exists to make impossible — publishes it into the async
      // context running `fn`, and drops it however `fn` ends.
      //
      // `allowAsync: false` because the COMMIT below runs the moment this
      // returns. An async `fn` would be committed mid-flight, which this
      // wrapper has always done, and would additionally have its continuation
      // told it still owns the transaction. Refused instead.
      const result = openTransactionScope(storage, fn, { allowAsync: false });
      raw.exec('COMMIT;');
      return result;
    } catch (error) {
      rollbackSafely(error);
      throw isBusyError(error)
        ? new ConflictError('The database is busy with a concurrent write; retry the request', { transient: true })
        : error;
    } finally {
      inOuterTransaction = false;
    }
  };
  const transactionAsync = async (fn) => {
    begin();
    try {
      const result = await openTransactionScope(storage, fn);
      raw.exec('COMMIT;');
      return result;
    } catch (error) {
      rollbackSafely(error);
      throw isBusyError(error)
        ? new ConflictError('The database is busy with a concurrent write; retry the request', { transient: true })
        : error;
    } finally {
      inOuterTransaction = false;
    }
  };
  // Both transaction wrappers above refer to `storage` — legal because they can
  // only run after this function has returned, and deliberate: the witness must
  // be bound to the very handle a consumer will later ask about.
  const storage = createSqliteStorage(raw, transaction, transactionAsync, () => currentTransactionWitness(storage));

    return {
      raw,
      storage,
      path: dbPath,
      /** Which migration plane this file received. Published so a test can pin it. */
      plane,
      close: () => raw.close(),
      transaction,
      transactionAsync,
    };
  } catch (error) {
    // createDatabase owns the raw handle until it returns. Any startup refusal
    // — including a persistent lock — closes it without masking the cause.
    try { raw.close(); } catch {}
    throw isBusyError(error) ? startupBusyError() : error;
  }
}
