import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CORE_MIGRATIONS_FOR_CHARACTERIZATION,
  MIGRATION_VERSIONS,
  createDatabase,
} from '../packages/core/src/database.js';
import {
  PINNED_CORE_MIGRATION_CHECKSUMS,
  captureBusinessSchema,
  sqlChecksum,
} from '../packages/core/src/schema-migrations-ledger.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const m0Fixture = JSON.parse(
  readFileSync(join(root, 'tests/fixtures/spine-v2-m0-sqlite-schema.json'), 'utf8'),
);

function workspaceFor(t) {
  const dir = mkdtempSync(join(tmpdir(), 'accordo-m3a-ledger-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function seedReleasedPrefix(path, throughVersion) {
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);
  for (const migration of CORE_MIGRATIONS_FOR_CHARACTERIZATION.filter(({ version }) => version <= throughVersion && version < 8)) {
    database.exec(migration.sql);
    database.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)')
      .run(migration.version, migration.name, '2026-01-01T00:00:00.000Z');
  }
  database.close();
}

test('MIGRATION_VERSIONS includes the checksum ledger on every plane', () => {
  assert.deepEqual(MIGRATION_VERSIONS, {
    combined: [1, 2, 3, 4, 5, 6, 7, 8],
    data: [1, 2, 3, 4, 6, 8],
    control: [5, 7, 8],
  });
});

test('fresh SQLite databases record pinned checksums and boot again', (t) => {
  const dir = workspaceFor(t);
  const path = join(dir, 'fresh.sqlite');
  const first = createDatabase({ path });
  const rows = first.raw.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version').all();
  assert.deepEqual(rows.map((row) => row.version), [1, 2, 3, 4, 5, 6, 7, 8]);
  for (const row of rows) {
    if (row.version <= 7) {
      assert.equal(row.checksum, PINNED_CORE_MIGRATION_CHECKSUMS[`${row.version}:${row.name}`]);
    } else {
      const v8 = CORE_MIGRATIONS_FOR_CHARACTERIZATION.find((entry) => entry.version === 8);
      assert.equal(row.checksum, sqlChecksum(v8.sql));
    }
  }
  first.close();
  const second = createDatabase({ path });
  t.after(() => second.close());
  assert.equal(second.raw.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n, 8);
});

test('an exact M0-identity SQLite file still boots and backfills pinned checksums', (t) => {
  const dir = workspaceFor(t);
  const path = join(dir, 'm0.sqlite');
  seedReleasedPrefix(path, 5);
  const before = new DatabaseSync(path);
  const m0Observed = captureBusinessSchema(before);
  before.close();
  const expectedM0 = m0Fixture.find((entry) => entry.throughVersion === 5);
  assert.deepEqual(m0Observed, expectedM0.schema);

  const adopted = createDatabase({ path, plane: 'combined' });
  t.after(() => adopted.close());
  const rows = adopted.raw.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version').all();
  assert.deepEqual(rows.map((row) => row.version), [1, 2, 3, 4, 5, 6, 7, 8]);
  for (const row of rows.filter((entry) => entry.version <= 5)) {
    assert.equal(row.checksum, PINNED_CORE_MIGRATION_CHECKSUMS[`${row.version}:${row.name}`]);
  }
});

test('ledger backfill refuses an unknown tuple', (t) => {
  const dir = workspaceFor(t);
  const path = join(dir, 'unknown.sqlite');
  seedReleasedPrefix(path, 7);
  const raw = new DatabaseSync(path);
  raw.prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)')
    .run(99, 'not_a_released_migration', '2026-01-01T00:00:00.000Z');
  raw.close();
  assert.throws(
    () => createDatabase({ path }),
    (error) => error.code === 'CORE_MIGRATION_LEDGER_UNKNOWN'
      && error.details.version === 99
      && !JSON.stringify(error).includes(path)
      && !/postgresql:\/\/|password|credential/i.test(JSON.stringify(error)),
  );
});

test('ledger backfill refuses a missing object', (t) => {
  const dir = workspaceFor(t);
  const path = join(dir, 'missing.sqlite');
  seedReleasedPrefix(path, 7);
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA foreign_keys = OFF; DROP TABLE companies;');
  raw.close();
  assert.throws(
    () => createDatabase({ path }),
    (error) => error.code === 'CORE_MIGRATION_SCHEMA_MISSING_OBJECT'
      && !JSON.stringify(error).includes(path),
  );
});

test('ledger backfill refuses a divergent schema', (t) => {
  const dir = workspaceFor(t);
  const path = join(dir, 'divergent.sqlite');
  seedReleasedPrefix(path, 7);
  const raw = new DatabaseSync(path);
  raw.exec('ALTER TABLE companies ADD COLUMN smuggled TEXT');
  raw.close();
  assert.throws(
    () => createDatabase({ path }),
    (error) => error.code === 'CORE_MIGRATION_SCHEMA_DIVERGED'
      && !JSON.stringify(error).includes(path)
      && !JSON.stringify(error).includes('postgresql://user:secret@sentinel.invalid/accordo'),
  );
});

test('ledger backfill still boots a pre-v8 file that already has module tables', (t) => {
  const dir = workspaceFor(t);
  const path = join(dir, 'with-modules.sqlite');
  seedReleasedPrefix(path, 7);
  const raw = new DatabaseSync(path);
  raw.exec(`
    CREATE TABLE module_migrations (
      name TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE notes (
      id TEXT PRIMARY KEY,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX notes_body ON notes(body);
  `);
  raw.prepare('INSERT INTO module_migrations(name, checksum, applied_at) VALUES (?, ?, ?)')
    .run('create_notes', 'not-a-core-checksum', '2026-01-01T00:00:00.000Z');
  raw.close();
  const adopted = createDatabase({ path });
  t.after(() => adopted.close());
  const rows = adopted.raw.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version').all();
  assert.deepEqual(rows.map((row) => row.version), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(
    adopted.raw.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'notes'").get()?.name,
    'notes',
  );
  assert.equal(adopted.raw.prepare('SELECT COUNT(*) AS n FROM notes').get().n, 0);
});

test('ledger backfill refuses a core column type change', (t) => {
  const dir = workspaceFor(t);
  const path = join(dir, 'type-drift.sqlite');
  seedReleasedPrefix(path, 5);
  const raw = new DatabaseSync(path);
  const rewritten = raw.prepare("SELECT sql FROM sqlite_schema WHERE name = 'opportunities'").get().sql
    .replace('value_cents INTEGER NOT NULL', 'value_cents TEXT NOT NULL');
  raw.exec('PRAGMA writable_schema = ON');
  raw.prepare("UPDATE sqlite_schema SET sql = ? WHERE name = 'opportunities'").run(rewritten);
  raw.exec('PRAGMA writable_schema = OFF');
  raw.close();
  assert.throws(
    () => createDatabase({ path, plane: 'combined' }),
    (error) => error.code === 'CORE_MIGRATION_SCHEMA_DIVERGED'
      && !JSON.stringify(error).includes(path),
  );
});
