import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDatabase } from '../packages/core/src/database.js';
import { generateModuleMigration } from '../packages/core/src/module-manifest.js';
import {
  generatePostgresModuleBootstrap,
} from '../packages/core/src/module-evolution.js';
import {
  PINNED_MODULE_BOOTSTRAP_PREDECESSORS,
  isPinnedModuleBootstrapPredecessor,
} from '../packages/core/src/schema-migrations-ledger.js';
import {
  postgresRecordModuleMigrations,
  recordModuleMigrations,
} from '../packages/core/src/record-module-runtime.js';
import {
  assertCallerHistoryMatchesRegistry,
  recordModuleHistoryFor,
  recordModuleHistoryPath,
} from '../packages/core/src/record-module-history.js';
import { preflightSelectedGraph } from '../packages/app/src/async-lifecycle.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const sha = (sql) => createHash('sha256').update(sql).digest('hex');

const loadJson = (path) => JSON.parse(readFileSync(join(HERE, path), 'utf8'));

const currentManifest = () => loadJson('../packages/work/modules/work-activity.module.json');
const historyFile = () => loadJson('../packages/work/modules/work-activity.history.json');
const workTaskManifest = () => loadJson('../packages/work/modules/work-task.module.json');
const currentDqiManifest = () => loadJson('../packages/customer-data/modules/data-quality-issue.module.json');
const dqiHistoryFile = () => loadJson('../packages/customer-data/modules/data-quality-issue.history.json');
const dqiHistoryEntry = () => ({
  name: 'data-quality-issue',
  manifest: currentDqiManifest(),
  previousManifests: dqiHistoryFile().previousManifests,
});
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
// The checksum presti-group's database recorded for data-quality-issue
// revision 1 (`pg_bootstrap_data_quality_issues`, named by the supervisor's
// diagnosis job on release 1b1b879). Commit b8266ea widened the `kind` enum
// without raising the revision, so the framework re-rendered that migration
// (44aec90d…) and every seed on a database b8266ea's predecessors migrated
// failed with MODULE_MIGRATION_CHECKSUM_MISMATCH. The SQLite checksum is the
// same revision rendered with the current code.
const RECORDED_DQI_SQLITE_CHECKSUM = 'c686673b293b8df6e29104514a7be7dd578901d72e25039e44c7210e93c3c192';
const RECORDED_DQI_PG_CHECKSUM = '6d601a00c1bd40d3c3618f0a204cf9c16c35e024b051828c7739b63dad2c3b63';

/**
 * Framework revision of a module must not break databases the previous
 * revision created (accordo 97a4fbbea85b: the work-activity revision 2
 * manifest re-rendered the applied `pg_bootstrap_work_activities` migration,
 * and every seed on a database the framework b48b09e migrated failed with
 * MODULE_MIGRATION_CHECKSUM_MISMATCH).
 *
 * The cure: the framework reads the module's checked-in `<name>.history.json`
 * itself, so a plain `{name, manifest}` entry composes the original migration
 * byte-identical plus one additive evolution per later revision, on both
 * dialects — never a re-render of the applied migration. A caller-supplied
 * `previousManifests` is only an assertion: it must match the checked-in
 * history exactly.
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

test('a manifest-only entry for a revised module composes the checked-in history without caller help', () => {
  // The production path: no `previousManifests` on the entry — the framework
  // supplies the checked-in history itself, so every composer (portable app,
  // async factory, pilot writer) renders the same migrations.
  const entry = { name: 'work-activity', manifest: currentManifest() };
  const sqlite = recordModuleMigrations([entry]);
  assert.deepEqual(sqlite.map((migration) => migration.name), ['create_work_activities', 'evolve_work_activities_r2']);
  assert.equal(sha(sqlite[0].sql), RECORDED_SQLITE_CHECKSUM);
  const postgres = postgresRecordModuleMigrations([entry]);
  assert.deepEqual(postgres.map((migration) => migration.name), ['pg_bootstrap_work_activities', 'pg_evolve_work_activities_r2']);
  assert.equal(sha(postgres[0].sql), RECORDED_PG_CHECKSUM);
});

test('a manifest-only entry at the old revision composes exactly what the old framework composed', () => {
  // The database the previous framework migrated was composed from the
  // revision 1 manifest alone. Replaying that entry today must render the
  // same single migration — the recorded checksum, byte for byte.
  const entry = { name: 'work-activity', manifest: historyFile().previousManifests[0] };
  const sqlite = recordModuleMigrations([entry]);
  assert.equal(sqlite.length, 1);
  assert.equal(sqlite[0].name, 'create_work_activities');
  assert.equal(sha(sqlite[0].sql), RECORDED_SQLITE_CHECKSUM);
  const postgres = postgresRecordModuleMigrations([entry]);
  assert.equal(postgres.length, 1);
  assert.equal(postgres[0].name, 'pg_bootstrap_work_activities');
  assert.equal(sha(postgres[0].sql), RECORDED_PG_CHECKSUM);
});

test('an edited copy of an old revision refuses instead of forking the history', () => {
  const edited = { ...historyFile().previousManifests[0], description: 'edited old copy' };
  assert.throws(
    () => postgresRecordModuleMigrations([{ name: 'work-activity', manifest: edited }]),
    /manifest at revision 1 does not match the checked-in/,
  );
});

/**
 * Framework revision of data-quality-issue must not break databases its
 * revision 1 created (accordo 4c3ad4870a5f: b8266ea widened the `kind` enum
 * with `identity_conflict_windowed_scope` without raising the revision, so
 * the seed on presti-group — migrated before b8266ea — failed with
 * MODULE_MIGRATION_CHECKSUM_MISMATCH on `pg_bootstrap_data_quality_issues`).
 *
 * The cure mirrors work-activity: the current manifest is revision 2 and the
 * framework reads the checked-in `data-quality-issue.history.json` itself, so
 * a plain `{name, manifest}` entry composes the recorded original migration
 * byte-identical plus one additive evolution, on both dialects.
 */

test('data-quality-issue revision 2 keeps the original SQLite migration identical and adds one evolution', () => {
  const migrations = recordModuleMigrations([dqiHistoryEntry()]);
  assert.equal(migrations.length, 2);
  assert.equal(migrations[0].name, 'create_data_quality_issues');
  assert.equal(migrations[1].name, 'evolve_data_quality_issues_r2');
  // The original migration is what revision 1 generated, byte for byte.
  assert.equal(migrations[0].sql, generateModuleMigration(dqiHistoryFile().previousManifests[0]).sql);
  assert.equal(sha(migrations[0].sql), RECORDED_DQI_SQLITE_CHECKSUM);
  // The evolution is additive: the widened enum, nothing else.
  assert.match(migrations[1].sql, /identity_conflict_windowed_scope/);
});

test('data-quality-issue revision 2 keeps the original Postgres bootstrap identical and adds one evolution', () => {
  const migrations = postgresRecordModuleMigrations([dqiHistoryEntry()]);
  assert.equal(migrations.length, 2);
  assert.equal(migrations[0].name, 'pg_bootstrap_data_quality_issues');
  assert.equal(migrations[1].name, 'pg_evolve_data_quality_issues_r2');
  // The original migration is what presti-group's database recorded, byte for
  // byte: it recomposes without a checksum mismatch.
  assert.equal(migrations[0].sql, generatePostgresModuleBootstrap(dqiHistoryFile().previousManifests[0]).sql);
  assert.equal(sha(migrations[0].sql), RECORDED_DQI_PG_CHECKSUM);
  // The evolution is additive with a new name: the widened enum check.
  assert.match(migrations[1].sql, /identity_conflict_windowed_scope/);
});

test('a manifest-only data-quality-issue entry composes the checked-in history without caller help', () => {
  // The production path: no `previousManifests` on the entry — the framework
  // supplies the checked-in history itself, so the seed composes the recorded
  // bootstrap plus the single evolution.
  const entry = { name: 'data-quality-issue', manifest: currentDqiManifest() };
  const sqlite = recordModuleMigrations([entry]);
  assert.deepEqual(sqlite.map((migration) => migration.name), ['create_data_quality_issues', 'evolve_data_quality_issues_r2']);
  assert.equal(sha(sqlite[0].sql), RECORDED_DQI_SQLITE_CHECKSUM);
  const postgres = postgresRecordModuleMigrations([entry]);
  assert.deepEqual(postgres.map((migration) => migration.name), ['pg_bootstrap_data_quality_issues', 'pg_evolve_data_quality_issues_r2']);
  assert.equal(sha(postgres[0].sql), RECORDED_DQI_PG_CHECKSUM);
});

test('a manifest-only data-quality-issue entry at revision 1 composes exactly what the old framework composed', () => {
  // The database presti-group holds was composed from the revision 1 manifest
  // alone. Replaying that entry today must render the same single migration.
  const entry = { name: 'data-quality-issue', manifest: dqiHistoryFile().previousManifests[0] };
  const sqlite = recordModuleMigrations([entry]);
  assert.equal(sqlite.length, 1);
  assert.equal(sqlite[0].name, 'create_data_quality_issues');
  assert.equal(sha(sqlite[0].sql), RECORDED_DQI_SQLITE_CHECKSUM);
  const postgres = postgresRecordModuleMigrations([entry]);
  assert.equal(postgres.length, 1);
  assert.equal(postgres[0].name, 'pg_bootstrap_data_quality_issues');
  assert.equal(sha(postgres[0].sql), RECORDED_DQI_PG_CHECKSUM);
});

test('a caller history identical to the checked-in one composes the same migrations', () => {
  const explicit = postgresRecordModuleMigrations([historyEntry()]);
  const implicit = postgresRecordModuleMigrations([{ name: 'work-activity', manifest: currentManifest() }]);
  assert.deepEqual(explicit, implicit);
});

test('a module with no checked-in history still renders the single current migration', () => {
  // Every module without history keeps today's behavior, whatever its
  // revision: databases created at its current revision keep matching.
  const entry = { name: 'work-task', manifest: workTaskManifest() };
  assert.equal(recordModuleHistoryFor('work-task'), undefined);
  assert.equal(recordModuleHistoryPath('work-task'), undefined);
  assert.equal(recordModuleMigrations([entry]).length, 1);
  assert.equal(postgresRecordModuleMigrations([entry]).length, 1);
  assert.equal(postgresRecordModuleMigrations([entry])[0].name, 'pg_bootstrap_work_tasks');
});

test('a caller history that disagrees with the checked-in one refuses loudly', () => {
  assert.throws(
    () => postgresRecordModuleMigrations([{
      name: 'work-activity', manifest: currentManifest(), previousManifests: [],
    }]),
    /does not match the checked-in revision history/,
  );
  const tampered = [...historyFile().previousManifests];
  tampered[0] = { ...tampered[0], description: 'forged' };
  assert.throws(
    () => postgresRecordModuleMigrations([{
      name: 'work-activity', manifest: currentManifest(), previousManifests: tampered,
    }]),
    /does not match the checked-in revision history/,
  );
  assert.throws(
    () => assertCallerHistoryMatchesRegistry('work-activity', []),
    /does not match the checked-in revision history/,
  );
});

test('a caller history for a module with no checked-in history refuses loudly', () => {
  assert.throws(
    () => postgresRecordModuleMigrations([{
      name: 'work-task', manifest: workTaskManifest(), previousManifests: [workTaskManifest()],
    }]),
    /ships no checked-in work-task.history.json/,
  );
});

test('history that does not describe this module fails closed', () => {
  const other = {
    manifestVersion: 1,
    name: 'work-task',
    table: 'work_tasks',
    fields: [{ name: 'title', type: 'string', writable: 'managed' }],
  };
  // The registry check fires first: any caller chain that is not exactly the
  // checked-in history refuses with the one actionable message, whatever its
  // structural reason.
  assert.throws(
    () => postgresRecordModuleMigrations([{ name: 'work-activity', manifest: currentManifest(), previousManifests: [other] }]),
    /does not match the checked-in revision history/,
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
  // A chain of only the current revision contradicts the checked-in history,
  // so the registry refusal — not the revision-step check — fires.
  assert.throws(
    () => postgresRecordModuleMigrations([{
      name: 'work-activity',
      manifest: currentManifest(),
      previousManifests: [currentManifest()],
    }]),
    /does not match the checked-in revision history/,
  );
});

/**
 * b8266ea widened the data-quality-issue `kind` enum without raising the
 * revision, so revision 1 shipped two released bootstrap identities: the
 * original (recorded by presti-group) and the widened one (recorded by every
 * database bootstrapped from b8266ea until the revision-2 fix). The revision
 * 2 framework renders the original bootstrap plus one additive evolution —
 * and the ledger bridge in `schema-migrations-ledger.js` accepts the widened
 * recording as the same migration, so both generations upgrade instead of
 * failing with MODULE_MIGRATION_CHECKSUM_MISMATCH.
 *
 * What b8266ea shipped, reconstructed from the checked-in history plus its
 * one known edit (the `identity_conflict_windowed_scope` value after
 * `conflicting_external_identity`, no revision key): the honest source of
 * the pinned predecessor checksums below, never a copied constant.
 */
const widenedDqiRevision1 = () => {
  const widened = JSON.parse(JSON.stringify(dqiHistoryFile().previousManifests[0]));
  const kind = widened.fields.find((field) => field.name === 'kind');
  kind.values.splice(kind.values.indexOf('conflicting_external_identity') + 1, 0, 'identity_conflict_windowed_scope');
  return widened;
};

test('the pinned bridge predecessors are exactly what b8266ea rendered', () => {
  const widened = widenedDqiRevision1();
  assert.equal(widened.revision, undefined, 'b8266ea shipped no revision key');
  const pg = PINNED_MODULE_BOOTSTRAP_PREDECESSORS['pg_bootstrap_data_quality_issues'];
  const sqlite = PINNED_MODULE_BOOTSTRAP_PREDECESSORS['create_data_quality_issues'];
  assert.equal(sha(generatePostgresModuleBootstrap(widened).sql), pg.predecessors[0]);
  assert.equal(sha(generateModuleMigration(widened).sql), sqlite.predecessors[0]);
  assert.equal(pg.predecessors[0], '44aec90d03eb7f00803870bf7b18201100e008d6be97ef8153918100c6a565cf');
  // The pinned `rendered` identities are what the revision-2 chain renders
  // today: the bridge only accepts the predecessor while that holds, so new
  // drift is still refused on bridged databases.
  assert.equal(pg.rendered, RECORDED_DQI_PG_CHECKSUM);
  assert.equal(sqlite.rendered, RECORDED_DQI_SQLITE_CHECKSUM);
});

test('isPinnedModuleBootstrapPredecessor bridges only the two released widened bootstraps', () => {
  const pg = PINNED_MODULE_BOOTSTRAP_PREDECESSORS['pg_bootstrap_data_quality_issues'];
  const sqlite = PINNED_MODULE_BOOTSTRAP_PREDECESSORS['create_data_quality_issues'];
  assert.equal(isPinnedModuleBootstrapPredecessor('pg_bootstrap_data_quality_issues', pg.predecessors[0], pg.rendered), true);
  assert.equal(isPinnedModuleBootstrapPredecessor('create_data_quality_issues', sqlite.predecessors[0], sqlite.rendered), true);
  assert.equal(isPinnedModuleBootstrapPredecessor('pg_bootstrap_data_quality_issues', pg.rendered, pg.rendered), false);
  assert.equal(isPinnedModuleBootstrapPredecessor('pg_bootstrap_work_activities', pg.predecessors[0], pg.rendered), false);
  assert.equal(isPinnedModuleBootstrapPredecessor('pg_bootstrap_data_quality_issues', sqlite.predecessors[0], pg.rendered), false);
  assert.equal(isPinnedModuleBootstrapPredecessor('create_data_quality_issues', pg.predecessors[0], sqlite.rendered), false);
  assert.equal(isPinnedModuleBootstrapPredecessor('pg_bootstrap_data_quality_issues', '0'.repeat(64), pg.rendered), false);
  assert.equal(isPinnedModuleBootstrapPredecessor('pg_bootstrap_data_quality_issues', pg.predecessors[0], '0'.repeat(64)), false);
  assert.equal(isPinnedModuleBootstrapPredecessor('no_such_migration', pg.predecessors[0], pg.rendered), false);
});

function tempDqiDbPath(t) {
  const directory = mkdtempSync(join(tmpdir(), 'accordo-dqi-upgrade-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'test.sqlite');
}

function dqiLedger(database) {
  return database.raw.prepare('SELECT name, checksum FROM module_migrations WHERE name LIKE \'%data_quality_issue%\' ORDER BY name').all();
}

function insertDqiRow(database, id, kind) {
  database.raw.prepare(
    'INSERT INTO data_quality_issues (id, source_key, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, `seed:${id}`, kind, 'then', 'then');
}

// The current production path for this module: one manifest-only entry, the
// way every composer builds it — the framework supplies the checked-in
// history itself.
const currentDqiChain = () => recordModuleMigrations([{ name: 'data-quality-issue', manifest: currentDqiManifest() }]);

test('a pre-b8266ea sqlite database upgrades with its rows intact', (t) => {
  // The database presti-group holds: the original revision 1 bootstrap, as
  // the framework rendered it before b8266ea (no history mechanism existed).
  const path = tempDqiDbPath(t);
  const setup = [{ name: 'create_data_quality_issues', sql: generateModuleMigration(dqiHistoryFile().previousManifests[0]).sql }];
  createDatabase({ path, moduleMigrations: setup }).close();
  const seed = createDatabase({ path, moduleMigrations: setup });
  insertDqiRow(seed, 'legacy-1', 'conflicting_external_identity');
  seed.close();

  const upgraded = createDatabase({ path, moduleMigrations: currentDqiChain() });
  try {
    const ledger = dqiLedger(upgraded);
    assert.deepEqual(ledger.map((row) => row.name), ['create_data_quality_issues', 'evolve_data_quality_issues_r2']);
    assert.equal(ledger[0].checksum, RECORDED_DQI_SQLITE_CHECKSUM);
    const legacy = upgraded.raw.prepare('SELECT id, source_key, kind FROM data_quality_issues WHERE id = ?').get('legacy-1');
    assert.equal(legacy.source_key, 'seed:legacy-1');
    assert.equal(legacy.kind, 'conflicting_external_identity');
    insertDqiRow(upgraded, 'post-upgrade-1', 'identity_conflict_windowed_scope');
  } finally {
    upgraded.close();
  }
});

test('a b8266ea sqlite database upgrades with its rows intact instead of mismatching', (t) => {
  // The generation the first revision of this cure broke: bootstrapped from
  // b8266ea until the revision-2 fix, holding the widened bootstrap under
  // the same migration name. The bridge accepts it as the same migration —
  // the recorded row is never rewritten — and the r2 evolution converges it.
  const path = tempDqiDbPath(t);
  const widenedBootstrap = generateModuleMigration(widenedDqiRevision1()).sql;
  assert.equal(sha(widenedBootstrap), PINNED_MODULE_BOOTSTRAP_PREDECESSORS['create_data_quality_issues'].predecessors[0]);
  const setup = [{ name: 'create_data_quality_issues', sql: widenedBootstrap }];
  createDatabase({ path, moduleMigrations: setup }).close();
  const seed = createDatabase({ path, moduleMigrations: setup });
  insertDqiRow(seed, 'legacy-1', 'conflicting_external_identity');
  insertDqiRow(seed, 'legacy-2', 'identity_conflict_windowed_scope');
  seed.close();

  const upgraded = createDatabase({ path, moduleMigrations: currentDqiChain() });
  try {
    const ledger = dqiLedger(upgraded);
    assert.deepEqual(ledger.map((row) => row.name), ['create_data_quality_issues', 'evolve_data_quality_issues_r2']);
    assert.equal(
      ledger[0].checksum,
      PINNED_MODULE_BOOTSTRAP_PREDECESSORS['create_data_quality_issues'].predecessors[0],
      'the widened recording stands: history is bridged, never rewritten',
    );
    assert.equal(upgraded.raw.prepare('SELECT kind FROM data_quality_issues WHERE id = ?').get('legacy-1').kind, 'conflicting_external_identity');
    assert.equal(upgraded.raw.prepare('SELECT kind FROM data_quality_issues WHERE id = ?').get('legacy-2').kind, 'identity_conflict_windowed_scope');
    insertDqiRow(upgraded, 'post-upgrade-1', 'identity_conflict_windowed_scope');
    assert.throws(
      () => insertDqiRow(upgraded, 'bad-kind-1', 'not_a_kind'),
      /CHECK/,
      'the converged CHECK still rejects unknown kinds',
    );
  } finally {
    upgraded.close();
  }
});

test('drifted SQL on a bridged database still refuses instead of being treated as applied', (t) => {
  const path = tempDqiDbPath(t);
  const setup = [{ name: 'create_data_quality_issues', sql: generateModuleMigration(widenedDqiRevision1()).sql }];
  createDatabase({ path, moduleMigrations: setup }).close();
  const chain = currentDqiChain();
  const drifted = [{ ...chain[0], sql: `${chain[0].sql}\n-- drifted` }, chain[1]];
  assert.throws(
    () => createDatabase({ path, moduleMigrations: drifted }),
    /create_data_quality_issues.*already applied with different SQL.*immutable/s,
  );
});
