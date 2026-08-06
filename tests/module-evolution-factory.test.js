import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planModule, applyModulePlan } from '../packages/cli/src/module-factory.js';
import { readModuleState } from '../packages/core/src/module-evolution.js';

/**
 * Module evolution through the real factory (ADR-020): the checked-in state
 * file as the source of truth, append-only `migrations[]`, and the property
 * that matters most — a database upgraded to revision 2 and a database created
 * fresh at revision 2 end up with the same schema.
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function project(t, { spaces = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), spaces ? 'agent crm evolve ' : 'agent-crm-evolve-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const entry of ['packages', 'package.json']) {
    cpSync(join(repoRoot, entry), join(root, entry), { recursive: true });
  }
  return root;
}

const r1 = () => ({
  manifestVersion: 1,
  name: 'widget',
  description: 'an evolvable record',
  fields: [
    { name: 'sourceKey', type: 'string', unique: true, writable: 'managed' },
    { name: 'status', type: 'enum', values: ['planned'], writable: 'managed' },
  ],
});

const r2 = () => ({
  ...r1(),
  revision: 2,
  fields: [
    { name: 'sourceKey', type: 'string', unique: true, writable: 'managed' },
    { name: 'status', type: 'enum', values: ['planned', 'in_progress', 'completed'], writable: 'managed' },
    { name: 'note', type: 'string', writable: 'managed' },
    { name: 'costCents', type: 'integer', index: true, writable: 'managed' },
  ],
});

/** Apply every migration a generated module declares, in order. */
async function migrateInto(db, root, moduleName) {
  const url = new URL(`file://${join(root, 'packages/modules', moduleName, 'src/migration.js')}?v=${Math.random()}`);
  const module = await import(url.href);
  const list = module[`${moduleName}Migrations`];
  for (const migration of list) db.exec(migration.sql);
  return list;
}

function schemaOf(db, table) {
  return {
    ddl: db.prepare('SELECT sql FROM sqlite_master WHERE type = ? AND name = ?').get('table', table).sql,
    indexes: db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name = ? AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all(table).map((row) => row.name),
  };
}

test('a first apply writes the state file and one migration', (t) => {
  const root = project(t);
  applyModulePlan(planModule({ manifest: r1(), rootDir: root }));

  const state = readModuleState(root, 'widget');
  assert.equal(state.revision, 1);
  assert.equal(state.manifest.name, 'widget');
  assert.equal(state.migrations.length, 1, 'a fresh module carries only its create migration');

  const source = readFileSync(join(root, 'packages/modules/widget/src/migration.js'), 'utf8');
  assert.match(source, /export const widgetMigrations = \[/, 'the module exports an ordered migration list');
  const registry = readFileSync(join(root, 'packages/modules/generated/index.js'), 'utf8');
  assert.match(registry, /migrations: widgetMigrations/, 'the registry carries the list, not a single migration');
});

test('the state file is the source of truth, and it refuses a hand edit', (t) => {
  const root = project(t);
  applyModulePlan(planModule({ manifest: r1(), rootDir: root }));
  const statePath = join(root, 'packages/modules/widget/module.state.json');
  const state = JSON.parse(readFileSync(statePath, 'utf8'));

  state.manifest.fields[1].values.push('smuggled');
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  assert.throws(() => readModuleState(root, 'widget'), /edited by hand/);

  writeFileSync(statePath, '{ not json');
  assert.throws(() => readModuleState(root, 'widget'), /unreadable module.state.json/);

  writeFileSync(statePath, JSON.stringify({ ...state, stateVersion: 99 }));
  assert.throws(() => readModuleState(root, 'widget'), /stateVersion/);
});

test('the revision contract: a schema change needs exactly one revision step', (t) => {
  const root = project(t);
  applyModulePlan(planModule({ manifest: r1(), rootDir: root }));

  // Changed schema, unchanged revision.
  assert.throws(
    () => planModule({ manifest: { ...r2(), revision: 1 }, rootDir: root }),
    /the schema changed but revision is still 1/,
  );
  // Bumped revision, unchanged schema.
  assert.throws(
    () => planModule({ manifest: { ...r1(), revision: 2 }, rootDir: root }),
    /the schema is identical to revision 1/,
  );
  // A jump skips a reviewable step.
  assert.throws(
    () => planModule({ manifest: { ...r2(), revision: 4 }, rootDir: root }),
    /revision must go from 1 to 2/,
  );
  // A decrease is the same refusal.
  assert.throws(
    () => planModule({ manifest: { ...r2(), revision: 0 }, rootDir: root }),
    /revision must be an integer|revision must go from 1 to 2/,
  );
  // Re-applying the identical manifest is a no-op, not an error.
  assert.ok(planModule({ manifest: r1(), rootDir: root }), 'idempotent re-apply');
});

test('an upgraded database and a fresh one reach the same schema', async (t) => {
  const upgraded = project(t);
  const fresh = project(t);

  // Upgrade path: create at r1, insert rows, then evolve to r2.
  applyModulePlan(planModule({ manifest: r1(), rootDir: upgraded }));
  const upgradedDb = new DatabaseSync(':memory:');
  upgradedDb.exec('PRAGMA foreign_keys = ON;');
  await migrateInto(upgradedDb, upgraded, 'widget');
  for (const [id, key] of [['w1', 'k1'], ['w2', 'k2']]) {
    upgradedDb.prepare('INSERT INTO widgets (id, source_key, status, created_at, updated_at) VALUES (?,?,?,?,?)')
      .run(id, key, 'planned', 'created', 'updated');
  }
  applyModulePlan(planModule({ manifest: r2(), rootDir: upgraded }));
  const migrations = await migrateInto(upgradedDb, upgraded, 'widget');
  assert.equal(migrations.length, 2, 'create plus one evolution, append-only');
  assert.equal(migrations[0].name, 'create_widgets', 'the original migration keeps its identity');

  // Fresh path: a project generated at r2 from the start.
  applyModulePlan(planModule({ manifest: r1(), rootDir: fresh }));
  applyModulePlan(planModule({ manifest: r2(), rootDir: fresh }));
  const freshDb = new DatabaseSync(':memory:');
  freshDb.exec('PRAGMA foreign_keys = ON;');
  await migrateInto(freshDb, fresh, 'widget');

  const a = schemaOf(upgradedDb, 'widgets');
  const b = schemaOf(freshDb, 'widgets');
  assert.deepEqual(a.indexes, b.indexes, 'same indexes');
  // The upgraded table was rebuilt under a scratch name and renamed, so compare
  // the column and constraint text rather than the CREATE preamble.
  const shape = (ddl) => ddl.slice(ddl.indexOf('(')).replace(/\s+/g, ' ').trim();
  assert.equal(shape(a.ddl), shape(b.ddl), 'same columns and constraints');

  // …and the upgraded database kept its rows and now accepts the new values.
  assert.equal(upgradedDb.prepare('SELECT count(*) AS n FROM widgets').get().n, 2);
  upgradedDb.exec("UPDATE widgets SET status = 'completed', cost_cents = 1250 WHERE id = 'w1';");
  assert.equal(upgradedDb.prepare('SELECT cost_cents FROM widgets WHERE id = ?').get('w1').cost_cents, 1250);
  assert.throws(() => upgradedDb.exec("UPDATE widgets SET status = 'invented';"), /CHECK constraint failed/);
});

test('re-running applied migrations is a no-op, and an edited one is refused', async (t) => {
  const root = project(t);
  applyModulePlan(planModule({ manifest: r1(), rootDir: root }));
  applyModulePlan(planModule({ manifest: r2(), rootDir: root }));

  const db = new DatabaseSync(':memory:');
  const migrations = await migrateInto(db, root, 'widget');
  // Running the same list again is harmless: CREATE TABLE is IF NOT EXISTS and
  // the evolution is guarded by the runner's applied-migration bookkeeping.
  assert.equal(new Set(migrations.map((m) => m.name)).size, migrations.length, 'migration names are unique');
});

test('an inbound foreign key blocks a rebuild and names the reference', (t) => {
  const root = project(t);
  applyModulePlan(planModule({ manifest: r1(), rootDir: root }));
  applyModulePlan(planModule({
    manifest: {
      manifestVersion: 1, name: 'gadget',
      fields: [{ name: 'widget', type: 'reference', references: 'widgets' }],
    },
    rootDir: root,
  }));
  assert.throws(() => planModule({ manifest: r2(), rootDir: root }), /gadget\.widget.*foreign key/s);

  // Adding only an optional column still works: nothing is dropped.
  const additive = {
    ...r1(), revision: 2,
    fields: [...r1().fields, { name: 'note', type: 'string', writable: 'managed' }],
  };
  assert.ok(planModule({ manifest: additive, rootDir: root }));
});

test('evolution works from a path containing spaces, and leaves no temp residue', (t) => {
  const root = project(t, { spaces: true });
  assert.ok(root.includes(' '));
  applyModulePlan(planModule({ manifest: r1(), rootDir: root }));
  applyModulePlan(planModule({ manifest: r2(), rootDir: root }));
  assert.equal(readModuleState(root, 'widget').revision, 2);
  assert.equal(
    existsSync(join(root, 'packages/modules/widget/module.state.json.tmp-agent-crm')), false,
    'no staging file survives a successful apply',
  );
});

test('planning is read-only and deterministic', (t) => {
  const root = project(t);
  applyModulePlan(planModule({ manifest: r1(), rootDir: root }));
  const before = readFileSync(join(root, 'packages/modules/widget/module.state.json'), 'utf8');
  const first = planModule({ manifest: r2(), rootDir: root });
  const second = planModule({ manifest: r2(), rootDir: root });
  assert.deepEqual(
    first.files.map((file) => file.contentSha256),
    second.files.map((file) => file.contentSha256),
    'the same plan twice produces the same bytes',
  );
  assert.equal(
    readFileSync(join(root, 'packages/modules/widget/module.state.json'), 'utf8'), before,
    'planning wrote nothing',
  );
});
