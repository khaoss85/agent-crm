import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase } from '../packages/core/src/database.js';

const MIGRATION_A = {
  name: 'create_widgets',
  sql: 'CREATE TABLE IF NOT EXISTS widgets (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;',
};
const MIGRATION_B = {
  name: 'create_gadgets',
  sql: 'CREATE TABLE IF NOT EXISTS gadgets (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;',
};

function tempDbPath(t) {
  const directory = mkdtempSync(join(tmpdir(), 'accordo-migrations-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'test.sqlite');
}

function appliedNames(database) {
  return database.raw.prepare('SELECT name FROM module_migrations ORDER BY name').all().map((row) => row.name);
}

test('same name + same SQL is applied once and reopening is a no-op', (t) => {
  const path = tempDbPath(t);
  const first = createDatabase({ path, moduleMigrations: [MIGRATION_A] });
  assert.deepEqual(appliedNames(first), ['create_widgets']);
  first.close();
  const second = createDatabase({ path, moduleMigrations: [MIGRATION_A] });
  assert.deepEqual(appliedNames(second), ['create_widgets']);
  second.raw.prepare('SELECT * FROM widgets').all();
  second.close();
});

test('same name + changed SQL fails loudly instead of being treated as applied', (t) => {
  const path = tempDbPath(t);
  createDatabase({ path, moduleMigrations: [MIGRATION_A] }).close();
  assert.throws(
    () =>
      createDatabase({
        path,
        moduleMigrations: [{ name: 'create_widgets', sql: `${MIGRATION_A.sql}\n-- drifted` }],
      }),
    /create_widgets.*already applied with different SQL.*immutable/s,
  );
});

test('a failed migration is rolled back and not recorded as applied', (t) => {
  const path = tempDbPath(t);
  assert.throws(() =>
    createDatabase({ path, moduleMigrations: [{ name: 'create_broken', sql: 'CREATE BROKEN SYNTAX;' }] }),
  );
  const database = createDatabase({ path });
  assert.deepEqual(appliedNames(database), []);
  database.close();
});

test('two modules cannot claim the same migration identity', (t) => {
  const path = tempDbPath(t);
  assert.throws(
    () => createDatabase({ path, moduleMigrations: [MIGRATION_A, { name: 'create_widgets', sql: MIGRATION_B.sql }] }),
    /Duplicate module migration name "create_widgets"/,
  );
});

test('registration order does not change identity: reverse order converges', (t) => {
  const pathAB = tempDbPath(t);
  const pathBA = tempDbPath(t);
  const ab = createDatabase({ path: pathAB, moduleMigrations: [MIGRATION_A, MIGRATION_B] });
  const ba = createDatabase({ path: pathBA, moduleMigrations: [MIGRATION_B, MIGRATION_A] });
  assert.deepEqual(appliedNames(ab), appliedNames(ba));
  // Adding B to a database that already ran A does not renumber or re-run A.
  ab.close();
  const again = createDatabase({ path: pathAB, moduleMigrations: [MIGRATION_A, MIGRATION_B] });
  assert.deepEqual(appliedNames(again), ['create_gadgets', 'create_widgets']);
  again.close();
  ba.close();
});

test('an existing Milestone 0 database upgrades cleanly to module migrations', (t) => {
  const path = tempDbPath(t);
  // Created before any generated module existed: core migrations only.
  const before = createDatabase({ path });
  before.raw.prepare('SELECT * FROM companies').all();
  before.close();
  const after = createDatabase({ path, moduleMigrations: [MIGRATION_A] });
  assert.deepEqual(appliedNames(after), ['create_widgets']);
  after.raw.prepare('SELECT * FROM widgets').all();
  after.raw.prepare('SELECT * FROM companies').all();
  after.close();
});
