// @ts-check

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { AppError, ConflictError } from './errors.js';
import { createSqliteStorage } from './storage-contract.js';
import { claimTransactionMinter, currentTransactionWitness } from './transaction-witness.js';

/**
 * The right to open an owned transaction scope, claimed once at module load so
 * that nothing else in the process can take it (Spine v2 M2D). Claiming here
 * rather than inside `createDatabase` is deliberate: the capability must be
 * gone before any package's code can run, not merely before the first
 * database is opened.
 */
const openTransactionScope = claimTransactionMinter();

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
 * tenant binding is configured (ADR-038), and these migrations are the only
 * ones that file ever receives.
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
];

/**
 * **The control plane.** Organizations and Memberships — the tenant of the
 * SOFTWARE and the people who may act inside it. Deliberately a separate list
 * from the data plane, so a control-plane database has no CRM table and a
 * tenant database has no membership table: a stray write across the boundary
 * raises `no such table` instead of quietly succeeding, which is what turns a
 * convention into an enforcement.
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
];

/**
 * Which migrations a database receives.
 *
 * `combined` is the historical single-file shape and remains the default, so
 * every existing composition is byte-for-byte unaffected. A spine with a
 * tenant binding opens two databases and asks for one plane each.
 */
const MIGRATION_PLANES = Object.freeze({
  combined: [...DATA_PLANE_MIGRATIONS, ...CONTROL_PLANE_MIGRATIONS],
  data: DATA_PLANE_MIGRATIONS,
  control: CONTROL_PLANE_MIGRATIONS,
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
]);

/** The migration versions each plane owns, published so a test can pin them. */
export const MIGRATION_VERSIONS = Object.freeze({
  combined: Object.freeze(MIGRATION_PLANES.combined.map((m) => m.version)),
  data: Object.freeze(DATA_PLANE_MIGRATIONS.map((m) => m.version)),
  control: Object.freeze(CONTROL_PLANE_MIGRATIONS.map((m) => m.version)),
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
  raw.exec('PRAGMA foreign_keys = ON;');
  raw.exec(`PRAGMA busy_timeout = ${Number.isInteger(options.busyTimeoutMs) && /** @type {number} */ (options.busyTimeoutMs) >= 0 ? options.busyTimeoutMs : 5000};`);
  if (dbPath !== ':memory:') raw.exec('PRAGMA journal_mode = WAL;');

  raw.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);

  const applied = new Set(
    raw.prepare('SELECT version FROM schema_migrations').all().map((row) => Number(row.version)),
  );

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    raw.exec('BEGIN IMMEDIATE;');
    try {
      raw.exec(migration.sql);
      raw.prepare(
        'INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)',
      ).run(migration.version, migration.name, new Date().toISOString());
      raw.exec('COMMIT;');
    } catch (error) {
      raw.exec('ROLLBACK;');
      throw error;
    }
  }

  // Generated-module migrations are keyed by name, not version, so the set can
  // grow in any order without renumbering migrations that already ran. The SQL
  // checksum makes drift detectable: an applied migration whose SQL later
  // changes must fail loudly, never be silently treated as already applied.
  raw.exec(`
    CREATE TABLE IF NOT EXISTS module_migrations (
      name TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);
  const appliedModuleMigrations = new Map(
    raw
      .prepare('SELECT name, checksum FROM module_migrations')
      .all()
      .map((row) => [String(row.name), String(row.checksum)]),
  );
  const seenMigrationNames = new Set();
  for (const migration of options.moduleMigrations ?? []) {
    if (seenMigrationNames.has(migration.name)) {
      throw new Error(
        `Duplicate module migration name "${migration.name}": two modules claim the same migration identity.`,
      );
    }
    seenMigrationNames.add(migration.name);
    const checksum = createHash('sha256').update(migration.sql).digest('hex');
    const appliedChecksum = appliedModuleMigrations.get(migration.name);
    if (appliedChecksum !== undefined) {
      if (appliedChecksum !== checksum) {
        throw new Error(
          `Module migration "${migration.name}" was already applied with different SQL. ` +
            'Applied migrations are immutable: add a new migration instead of editing an applied one.',
        );
      }
      continue;
    }
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
    const preExisting = fingerprintViolations();
    raw.exec('BEGIN IMMEDIATE;');
    try {
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
      raw.exec('COMMIT;');
    } catch (error) {
      raw.exec('ROLLBACK;');
      throw error;
    }
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
      const result = openTransactionScope(storage, fn);
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
}
