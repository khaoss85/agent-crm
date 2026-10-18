import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateModuleMigration } from '../packages/core/src/module-manifest.js';
import {
  generatePostgresModuleBootstrap,
} from '../packages/core/src/module-evolution.js';
import {
  postgresRecordModuleMigrations,
  recordModuleMigrations,
} from '../packages/core/src/record-module-runtime.js';
import { preflightSelectedGraph } from '../packages/app/src/async-lifecycle.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const sha = (sql) => createHash('sha256').update(sql).digest('hex');

const loadJson = (path) => JSON.parse(readFileSync(join(HERE, path), 'utf8'));

const currentManifest = () => loadJson('../packages/work/modules/work-activity.module.json');
const historyFile = () => loadJson('../packages/work/modules/work-activity.history.json');
const historyEntry = () => ({
  name: 'work-activity',
  manifest: currentManifest(),
  previousManifests: historyFile().previousManifests,
});

// The checksums databases migrated with framework b48b09e recorded for
// work-activity revision 1. Rendered with b48b09e's own code and with the
// current code: byte-identical both ways, so the history file reproduces
// exactly what those databases hold.
const RECORDED_SQLITE_CHECKSUM = '01f618d415ec03a215d8303c973558a3fc3f7c8005b433794cc0b4ba408ba4f0';
const RECORDED_PG_CHECKSUM = 'cf29094ff4b655d4e5dcf9e1d236a89e6e44cc4c64400e6f15acaace82d996c0';

/**
 * Framework revision of a module must not break databases the previous
 * revision created (accordo 97a4fbbea85b: the work-activity revision 2
 * manifest re-rendered the applied `pg_bootstrap_work_activities` migration,
 * and every seed on a database the framework b48b09e migrated failed with
 * MODULE_MIGRATION_CHECKSUM_MISMATCH).
 *
 * The cure: an entry carrying `previousManifests` composes the original
 * migration byte-identical plus one additive evolution per later revision,
 * on both dialects — never a re-render of the applied migration.
 */

test('work-activity revision 2 keeps the original SQLite migration identical and adds one evolution', () => {
  const migrations = recordModuleMigrations([historyEntry()]);
  assert.equal(migrations.length, 2);
  assert.equal(migrations[0].name, 'create_work_activities');
  assert.equal(migrations[1].name, 'evolve_work_activities_r2');
  // The original migration is what revision 1 generated, byte for byte.
  assert.equal(migrations[0].sql, generateModuleMigration(historyFile().previousManifests[0]).sql);
  assert.equal(sha(migrations[0].sql), RECORDED_SQLITE_CHECKSUM);
  // The evolution is additive: the new column, nothing else.
  assert.match(migrations[1].sql, /ADD COLUMN seq INTEGER/);
});

test('work-activity revision 2 keeps the original Postgres bootstrap identical and adds one evolution', () => {
  const migrations = postgresRecordModuleMigrations([historyEntry()]);
  assert.equal(migrations.length, 2);
  assert.equal(migrations[0].name, 'pg_bootstrap_work_activities');
  assert.equal(migrations[1].name, 'pg_evolve_work_activities_r2');
  // The original migration is what revision 1 generated, byte for byte: a
  // database that recorded it recomposes without a checksum mismatch.
  assert.equal(migrations[0].sql, generatePostgresModuleBootstrap(historyFile().previousManifests[0]).sql);
  assert.equal(sha(migrations[0].sql), RECORDED_PG_CHECKSUM);
  // The evolution is additive with a new name: the new column, nothing else.
  assert.match(migrations[1].sql, /ADD COLUMN "seq" BIGINT/);
});

test('the SQLite history upgrades a revision-1 database with its rows intact', () => {
  const db = new DatabaseSync(':memory:');
  const migrations = recordModuleMigrations([historyEntry()]);
  db.exec(migrations[0].sql);
  db.prepare(
    'INSERT INTO work_activities (id, source_key, kind, created_at, updated_at) VALUES (?,?,?,?,?)',
  ).run('a1', 'legacy:1', 'note', 'then', 'then');
  db.exec(migrations[1].sql);
  const row = db.prepare('SELECT id, source_key, seq FROM work_activities WHERE id = ?').get('a1');
  assert.equal(row.source_key, 'legacy:1');
  assert.equal(row.seq, null);
  db.prepare('UPDATE work_activities SET seq = ? WHERE id = ?').run(1, 'a1');
  assert.equal(db.prepare('SELECT seq FROM work_activities WHERE id = ?').get('a1').seq, 1);
  db.close();
});

test('preflight carries the history through to the composed Postgres migrations', () => {
  const accepted = preflightSelectedGraph({
    packageContract: 2,
    packages: [],
    actions: [],
    modules: [historyEntry()],
  });
  const names = accepted.postgresRecordMigrations.map((migration) => migration.name);
  assert.deepEqual(names, ['pg_bootstrap_work_activities', 'pg_evolve_work_activities_r2']);
  const sqliteNames = accepted.recordMigrations.map((migration) => migration.name);
  assert.deepEqual(sqliteNames, ['create_work_activities', 'evolve_work_activities_r2']);
});

test('without history a revision-2 manifest still renders the single current migration', () => {
  // Every module without history keeps today's behavior, whatever its
  // revision: the pilot's current composition is unchanged until it adopts
  // history, and databases created at revision 2 keep matching.
  const entry = { name: 'work-activity', manifest: currentManifest() };
  assert.equal(recordModuleMigrations([entry]).length, 1);
  assert.equal(recordModuleMigrations([entry])[0].name, 'create_work_activities');
  assert.equal(postgresRecordModuleMigrations([entry]).length, 1);
  assert.equal(postgresRecordModuleMigrations([entry])[0].name, 'pg_bootstrap_work_activities');
});

test('history that does not describe this module fails closed', () => {
  const other = {
    manifestVersion: 1,
    name: 'work-task',
    table: 'work_tasks',
    fields: [{ name: 'title', type: 'string', writable: 'managed' }],
  };
  assert.throws(
    () => postgresRecordModuleMigrations([{ name: 'work-activity', manifest: currentManifest(), previousManifests: [other] }]),
    /carries history for "work-task"/,
  );
  assert.throws(
    () => preflightSelectedGraph({
      packageContract: 2, packages: [], actions: [],
      modules: [{ name: 'work-activity', manifest: currentManifest(), previousManifests: 'nope' }],
    }),
    /previousManifests must be an array/,
  );
});

test('history with a skipped revision fails closed instead of guessing', () => {
  const rev3 = {
    ...currentManifest(),
    revision: 3,
    fields: [...currentManifest().fields, { name: 'extra', type: 'string', writable: 'managed' }],
  };
  assert.throws(
    () => postgresRecordModuleMigrations([{
      name: 'work-activity',
      manifest: rev3,
      previousManifests: historyFile().previousManifests,
    }]),
    /must step by one \(1 → 2\); got 1 → 3/,
  );
});

test('history that does not start at revision 1 fails closed', () => {
  assert.throws(
    () => postgresRecordModuleMigrations([{
      name: 'work-activity',
      manifest: currentManifest(),
      previousManifests: [currentManifest()],
    }]),
    /must start at revision 1/,
  );
});
