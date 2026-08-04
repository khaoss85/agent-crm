// @ts-check

import { DatabaseSync } from 'node:sqlite';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

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
];

/** @param {{path?: string}} [options] @returns {AgentCrmDatabase} */
export function createDatabase(options = {}) {
  const requestedPath = options.path ?? process.env.CRM_DB_PATH ?? './data/agent-crm.sqlite';
  const dbPath = requestedPath === ':memory:' ? requestedPath : resolve(requestedPath);
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });

  const raw = new DatabaseSync(dbPath);
  raw.exec('PRAGMA foreign_keys = ON;');
  raw.exec('PRAGMA busy_timeout = 5000;');
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

  return {
    raw,
    path: dbPath,
    close: () => raw.close(),
    transaction: (fn) => {
      raw.exec('BEGIN IMMEDIATE;');
      try {
        const result = fn();
        raw.exec('COMMIT;');
        return result;
      } catch (error) {
        raw.exec('ROLLBACK;');
        throw error;
      }
    },
    transactionAsync: async (fn) => {
      raw.exec('BEGIN IMMEDIATE;');
      try {
        const result = await fn();
        raw.exec('COMMIT;');
        return result;
      } catch (error) {
        raw.exec('ROLLBACK;');
        throw error;
      }
    },
  };
}
