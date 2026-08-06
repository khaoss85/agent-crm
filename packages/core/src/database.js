// @ts-check

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { AppError, ConflictError } from './errors.js';

/**
 * @typedef {{
 *   raw: DatabaseSync,
 *   path: string,
 *   close: () => void,
 *   transaction: <T>(fn: () => T) => T,
 *   transactionAsync: <T>(fn: () => Promise<T>) => Promise<T>
 * }} AgentCrmDatabase
 */

const MIGRATIONS = [
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
 * @param {{path?: string, moduleMigrations?: Array<{name: string, sql: string}>, busyTimeoutMs?: number}} [options]
 * @returns {AgentCrmDatabase}
 */
export function createDatabase(options = {}) {
  const requestedPath = options.path ?? process.env.CRM_DB_PATH ?? './data/agent-crm.sqlite';
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

  for (const migration of MIGRATIONS) {
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
    raw.exec('BEGIN IMMEDIATE;');
    try {
      raw.exec(migration.sql);
      // Referential integrity is verified inside the migration's own
      // transaction, so a migration that leaves a dangling reference rolls back
      // rather than being recorded as applied. This covers every module
      // migration, not only the ones that rebuild a table (ADR-019).
      const violations = raw.prepare('PRAGMA foreign_key_check').all();
      if (violations.length > 0) {
        const first = violations[0];
        throw new Error(
          `Module migration "${migration.name}" left ${violations.length} foreign key violation(s), `
            + `starting in table "${String(first.table ?? first['table'])}". The migration was rolled back.`,
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
        `[agent-crm] rollback failed after: ${primaryError instanceof Error ? primaryError.message : String(primaryError)} — rollback error: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
      );
    }
  }

  return {
    raw,
    path: dbPath,
    close: () => raw.close(),
    transaction: (fn) => {
      begin();
      try {
        const result = fn();
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
    },
    transactionAsync: async (fn) => {
      begin();
      try {
        const result = await fn();
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
    },
  };
}
