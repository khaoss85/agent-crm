import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { generateModuleMigration, validateModuleManifest } from '../packages/core/src/module-manifest.js';
import { generateModuleEvolution, planModuleEvolution, manifestRevision } from '../packages/core/src/module-evolution.js';

/**
 * Module manifest evolution (ADR-019).
 *
 * The gap it closes: a generated module's migration is `CREATE TABLE IF NOT
 * EXISTS` and its enum values are a baked-in SQL `CHECK`, so a record that
 * gains a lifecycle after it ships had no upgrade path at all — re-applying an
 * edited manifest silently no-ops and the old CHECK keeps refusing the new
 * values.
 */

const base = () => ({
  manifestVersion: 1,
  name: 'thing',
  description: 'a thing',
  fields: [
    { name: 'sourceKey', type: 'string', unique: true, writable: 'managed' },
    { name: 'status', type: 'enum', values: ['pending_kickoff'], writable: 'managed' },
  ],
});

const grown = () => ({
  ...base(),
  revision: 2,
  fields: [
    { name: 'sourceKey', type: 'string', unique: true, writable: 'managed' },
    { name: 'status', type: 'enum', values: ['pending_kickoff', 'active', 'completed'], writable: 'managed' },
    { name: 'startedAt', type: 'string', writable: 'managed' },
    { name: 'completedAt', type: 'string', index: true, writable: 'managed' },
  ],
});

test('the gap is real: a baked-in enum CHECK refuses a value the manifest later allows', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(generateModuleMigration(base()).sql);
  db.prepare('INSERT INTO things (id, source_key, status, created_at, updated_at) VALUES (?,?,?,?,?)')
    .run('t1', 'k1', 'pending_kickoff', 'now', 'now');
  assert.throws(() => db.exec("UPDATE things SET status = 'active';"), /CHECK constraint failed/);
  // …and re-applying the widened manifest is no upgrade path either: the CREATE
  // TABLE is IF NOT EXISTS so the old CHECK survives, and the run fails on the
  // index for a column the table never gained.
  assert.throws(() => db.exec(generateModuleMigration(grown()).sql), /no such column: completed_at/);
  assert.throws(() => db.exec("UPDATE things SET status = 'active';"), /CHECK constraint failed/);
});

test('an additive evolution preserves every row, widens the enum and keeps the constraints', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(generateModuleMigration(base()).sql);
  for (const [id, key] of [['t1', 'k1'], ['t2', 'k2']]) {
    db.prepare('INSERT INTO things (id, source_key, status, created_at, updated_at) VALUES (?,?,?,?,?)')
      .run(id, key, 'pending_kickoff', 'created', 'updated');
  }

  const evolution = generateModuleEvolution({ previous: base(), next: grown() });
  assert.equal(evolution.strategy, 'rebuild', 'widening an enum needs a rebuild: SQLite cannot ALTER a CHECK');
  assert.equal(evolution.migrationName, 'evolve_things_r2', 'a new migration name, never an edit to an applied one');
  assert.deepEqual(evolution.addedFields, ['startedAt', 'completedAt']);
  assert.deepEqual(evolution.widenedEnums, [{ field: 'status', added: ['active', 'completed'] }]);

  db.exec('BEGIN IMMEDIATE;');
  db.exec(evolution.sql);
  db.exec('COMMIT;');

  const rows = db.prepare('SELECT * FROM things ORDER BY id').all();
  assert.equal(rows.length, 2, 'every row survives the rebuild');
  assert.equal(rows[0].source_key, 'k1');
  assert.equal(rows[0].created_at, 'created', 'bookkeeping columns are carried, not regenerated');
  assert.equal(rows[0].started_at, null, 'a new optional column arrives null');

  db.exec("UPDATE things SET status = 'active', started_at = '2026-09-01' WHERE id = 't1';");
  assert.equal(db.prepare('SELECT status FROM things WHERE id = ?').get('t1').status, 'active');

  // The constraints the original table carried are still enforced afterwards.
  assert.throws(
    () => db.prepare('INSERT INTO things (id, source_key, status, created_at, updated_at) VALUES (?,?,?,?,?)')
      .run('t3', 'k1', 'active', 'n', 'n'),
    /UNIQUE constraint failed/,
  );
  assert.throws(() => db.exec("UPDATE things SET status = 'invented';"), /CHECK constraint failed/);
  assert.ok(
    db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='things_completed_at'").get(),
    'a newly indexed field gets its index',
  );
});

test('adding only optional columns alters in place rather than rebuilding', () => {
  const next = {
    ...base(), revision: 2,
    fields: [...base().fields, { name: 'note', type: 'string', writable: 'managed' }],
  };
  const evolution = generateModuleEvolution({ previous: base(), next });
  assert.equal(evolution.strategy, 'alter');
  assert.match(evolution.sql, /ALTER TABLE things ADD COLUMN note TEXT;/);

  const db = new DatabaseSync(':memory:');
  db.exec(generateModuleMigration(base()).sql);
  db.prepare('INSERT INTO things (id, source_key, status, created_at, updated_at) VALUES (?,?,?,?,?)')
    .run('t1', 'k1', 'pending_kickoff', 'n', 'n');
  db.exec(evolution.sql);
  assert.equal(db.prepare('SELECT note FROM things').get().note, null);
});

test('everything that could lose or reinterpret stored data is refused', () => {
  const cases = [
    ['a removed field', { ...base(), revision: 2, fields: [base().fields[0]] }, /was removed/],
    ['a narrowed enum', {
      ...base(), revision: 2,
      fields: [base().fields[0], { name: 'status', type: 'enum', values: ['active'], writable: 'managed' }],
    }, /removed enum value/],
    ['a changed type', {
      ...base(), revision: 2,
      fields: [{ name: 'sourceKey', type: 'integer', unique: true, writable: 'managed' }, base().fields[1]],
    }, /changed type/],
    // The manifest contract already refuses a managed required field with no
    // default; evolution never sees it, and either refusal is the right answer.
    ['a new required field', {
      ...base(), revision: 2,
      fields: [...base().fields, { name: 'owner', type: 'string', required: true, writable: 'managed' }],
    }, /needs a "default"|new and required/],
    ['a new unique field', {
      ...base(), revision: 2,
      fields: [...base().fields, { name: 'code', type: 'string', unique: true, writable: 'managed' }],
    }, /new and unique/],
    ['a changed unique flag', {
      ...base(), revision: 2,
      fields: [{ name: 'sourceKey', type: 'string', writable: 'managed' }, base().fields[1]],
    }, /changed unique/],
  ];
  for (const [label, next, pattern] of cases) {
    assert.throws(() => planModuleEvolution({ previous: base(), next }), pattern, label);
  }
});

test('a revision must increase, and a revision that changes nothing is a mistake', () => {
  assert.throws(
    () => planModuleEvolution({ previous: base(), next: { ...grown(), revision: 1 } }),
    /revision must increase/,
  );
  assert.throws(
    () => planModuleEvolution({ previous: grown(), next: { ...grown(), revision: 2 } }),
    /revision must increase/,
  );
  assert.throws(
    () => generateModuleEvolution({ previous: base(), next: { ...base(), revision: 2 } }),
    /changes nothing/,
  );
  assert.throws(
    () => planModuleEvolution({ previous: base(), next: { ...grown(), name: 'widget' } }),
    /compares one module with itself/,
  );
});

test('a rebuild is refused while another table holds a foreign key into this one', () => {
  assert.throws(
    () => generateModuleEvolution({ previous: base(), next: grown(), referencedBy: ['widgets'] }),
    /widgets.*foreign key.*design decision/s,
  );
  // An in-place alter is unaffected: nothing is dropped.
  const next = { ...base(), revision: 2, fields: [...base().fields, { name: 'note', type: 'string', writable: 'managed' }] };
  assert.equal(generateModuleEvolution({ previous: base(), next, referencedBy: ['widgets'] }).strategy, 'alter');
});

test('revision is part of the manifest contract, and defaults to 1', () => {
  assert.equal(manifestRevision(validateModuleManifest(base())), 1, 'a manifest written before evolution existed is revision 1');
  assert.equal(validateModuleManifest(grown()).revision, 2);
  assert.throws(() => validateModuleManifest({ ...base(), revision: 0 }), /revision must be an integer/);
  assert.throws(() => validateModuleManifest({ ...base(), revision: 1.5 }), /revision must be an integer/);
  assert.throws(() => validateModuleManifest({ ...base(), revision: 'two' }), /revision must be an integer/);
});

test('the generated evolution SQL is deterministic', () => {
  const first = generateModuleEvolution({ previous: base(), next: grown() });
  const second = generateModuleEvolution({ previous: base(), next: grown() });
  assert.equal(first.sql, second.sql);
});

/**
 * Adversarial review of PR #19. Each case below failed before the fix it names.
 */

test('a table rename is refused, not turned into a migration against a table that does not exist', () => {
  const previous = { manifestVersion: 1, name: 'thing', fields: [{ name: 'a', type: 'string' }] };
  const next = { ...previous, revision: 2, table: 'renamed_things', fields: [...previous.fields, { name: 'b', type: 'string' }] };
  assert.throws(
    () => planModuleEvolution({ previous, next }),
    /table name changed/,
    'a renamed table produced ALTER TABLE renamed_things … against a table that was never created',
  );
});

test('a removed index is applied, not silently left behind', () => {
  const previous = {
    manifestVersion: 1, name: 'thing',
    fields: [{ name: 'a', type: 'string', index: true }, { name: 'b', type: 'string' }],
  };
  const next = {
    ...previous, revision: 2,
    fields: [{ name: 'a', type: 'string' }, { name: 'b', type: 'string' }, { name: 'c', type: 'string' }],
  };
  const plan = planModuleEvolution({ previous, next });
  assert.deepEqual(plan.removedIndexes, ['a'], 'the dropped declaration is part of the plan');

  const db = new DatabaseSync(':memory:');
  db.exec(generateModuleMigration(previous).sql);
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='things_a'").get());
  db.exec(generateModuleEvolution({ previous, next }).sql);
  assert.equal(
    db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='things_a'").get(), undefined,
    'the index the manifest no longer declares is gone, so declared and actual schema agree',
  );
});

test('a change that alters behaviour but not storage is a first-class metadata evolution', () => {
  const previous = {
    manifestVersion: 1, name: 'thing',
    fields: [{ name: 'status', type: 'enum', values: ['planned'], writable: 'managed' }],
  };
  // `writable` decides whether public CRUD may set the field: a real API, schema
  // and Admin change with no schema change at all. It used to be impossible —
  // the fingerprint demanded a revision, then generation refused it as pointless.
  const next = {
    ...previous, revision: 2,
    fields: [{ name: 'status', type: 'enum', values: ['planned'], writable: 'public' }],
  };
  const plan = planModuleEvolution({ previous, next });
  assert.equal(plan.strategy, 'metadata', 'classified, not mistaken for "nothing changed"');
  const evolution = generateModuleEvolution({ previous, next });
  assert.equal(evolution.sql.trim(), '', 'a metadata evolution emits no migration');
  assert.equal(evolution.migrationName, null, 'and claims no migration identity');

  // A genuinely empty revision bump is still a mistake, and says so.
  assert.throws(
    () => generateModuleEvolution({ previous, next: { ...previous, revision: 2 } }),
    /changes nothing/,
  );
});
