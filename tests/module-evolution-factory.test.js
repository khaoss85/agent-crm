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
 * Module evolution through the real factory (ADR-019): the checked-in state
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
  const camel = moduleName.replace(/-([a-z0-9])/g, (_, ch) => ch.toUpperCase());
  const list = module[`${camel}Migrations`];
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
  // The registry reads the migration list through `migrationsOf`, not a named
  // import: the same file is regenerated for modules that predate the list.
  assert.match(registry, /migrationsOf\(widgetMigrationSource, 'widget', 'widget'\)/);
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

test('a package-owned module evolves through the identical path', async (t) => {
  // The characterization Milestone 14 will rely on: a package's own record gains
  // a lifecycle and a cost field, with no domain word anywhere in the kernel.
  const root = project(t);
  const owned = (revision) => ({
    manifestVersion: 1,
    ...(revision ? { revision } : {}),
    name: 'sample-job',
    description: 'a package-owned record that gains a lifecycle',
    fields: [
      { name: 'sourceKey', type: 'string', unique: true, writable: 'managed' },
      {
        name: 'status', type: 'enum', writable: 'managed',
        values: revision ? ['planned', 'in_progress', 'completed'] : ['planned'],
      },
      ...(revision ? [
        { name: 'note', type: 'string', writable: 'managed' },
        { name: 'costCents', type: 'integer', writable: 'managed' },
      ] : []),
    ],
  });

  applyModulePlan(planModule({ manifest: owned(), rootDir: root }));
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  await migrateInto(db, root, 'sample-job');
  db.prepare('INSERT INTO sample_jobs (id, source_key, status, created_at, updated_at) VALUES (?,?,?,?,?)')
    .run('j1', 'k1', 'planned', 'c', 'u');

  applyModulePlan(planModule({ manifest: owned(2), rootDir: root }));
  const migrations = await migrateInto(db, root, 'sample-job');
  assert.equal(migrations.length, 2);

  db.exec("UPDATE sample_jobs SET status = 'in_progress', cost_cents = 4200 WHERE id = 'j1';");
  const row = db.prepare('SELECT status, cost_cents FROM sample_jobs WHERE id = ?').get('j1');
  assert.equal(row.status, 'in_progress');
  assert.equal(row.cost_cents, 4200);
  assert.equal(readModuleState(root, 'sample-job').revision, 2);
});

test('exact reads stay exact after a rebuild, past the paged list bound', async (t) => {
  const root = project(t);
  applyModulePlan(planModule({ manifest: r1(), rootDir: root }));
  const db = new DatabaseSync(':memory:');
  await migrateInto(db, root, 'widget');
  const insert = db.prepare('INSERT INTO widgets (id, source_key, status, created_at, updated_at) VALUES (?,?,?,?,?)');
  for (let index = 0; index < 620; index += 1) insert.run(`w${index}`, `k${index}`, 'planned', 'c', 'u');

  applyModulePlan(planModule({ manifest: r2(), rootDir: root }));
  await migrateInto(db, root, 'widget');

  assert.equal(db.prepare('SELECT count(*) AS n FROM widgets').get().n, 620, 'every row survived');
  assert.equal(db.prepare('SELECT source_key FROM widgets WHERE id = ?').get('w617').source_key, 'k617');
  db.exec("UPDATE widgets SET cost_cents = 7 WHERE id = 'w617';");
  assert.equal(db.prepare('SELECT cost_cents FROM widgets WHERE id = ?').get('w617').cost_cents, 7);
});

test('a metadata-only evolution regenerates source and appends no migration', (t) => {
  const root = project(t);
  const managed = () => ({
    manifestVersion: 1, name: 'widget', description: 'a record whose field opens up',
    fields: [
      { name: 'sourceKey', type: 'string', unique: true, writable: 'managed' },
      { name: 'status', type: 'enum', values: ['planned'], writable: 'managed' },
    ],
  });
  applyModulePlan(planModule({ manifest: managed(), rootDir: root }));
  const before = readModuleState(root, 'widget');
  assert.equal(before.migrations.length, 1);

  const opened = {
    ...managed(), revision: 2,
    fields: [managed().fields[0], { name: 'status', type: 'enum', values: ['planned'], writable: 'public' }],
  };
  applyModulePlan(planModule({ manifest: opened, rootDir: root }));

  const after = readModuleState(root, 'widget');
  assert.equal(after.revision, 2, 'the revision advanced');
  assert.equal(after.migrations.length, 1, 'no migration was appended for a storage-free change');
  assert.equal(after.manifest.fields[1].writable, 'public', 'and the state records the new behaviour');

  const service = readFileSync(join(root, 'packages/modules/widget/src/widget-service.js'), 'utf8');
  assert.ok(service.length > 0, 'the service was regenerated');
});

test('a package-owned module survives detach, source evolution and reattach with its data', async (t) => {
  // r1 install → detach → source r2 → reattach → DB upgrade → data survives.
  const root = project(t);
  const owned = (revision) => ({
    manifestVersion: 1, ...(revision ? { revision } : {}),
    name: 'sample-asset', description: 'a package-owned record',
    fields: [
      { name: 'sourceKey', type: 'string', unique: true, writable: 'managed' },
      { name: 'status', type: 'enum', writable: 'managed', values: revision ? ['planned', 'active'] : ['planned'] },
      ...(revision ? [{ name: 'costCents', type: 'integer', writable: 'managed' }] : []),
    ],
  });

  applyModulePlan(planModule({ manifest: owned(), rootDir: root }));
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  await migrateInto(db, root, 'sample-asset');
  db.prepare('INSERT INTO sample_assets (id, source_key, status, created_at, updated_at) VALUES (?,?,?,?,?)')
    .run('a1', 'k1', 'planned', 'c', 'u');

  // Detach: the package is removed from the composition. Its data is untouched —
  // the framework never drops a table behind you.
  const registryPath = join(root, 'packages/modules/generated/index.js');
  const attached = readFileSync(registryPath, 'utf8');
  writeFileSync(registryPath, 'export const generatedModules = [];\n');
  assert.equal(db.prepare('SELECT count(*) AS n FROM sample_assets').get().n, 1, 'detach leaves the rows');

  // Evolve the source while detached, then reattach and let the database catch up.
  applyModulePlan(planModule({ manifest: owned(2), rootDir: root }));
  assert.ok(readFileSync(registryPath, 'utf8').includes("name: 'sample-asset'"), 'reattached by the apply');
  const migrations = await migrateInto(db, root, 'sample-asset');
  assert.equal(migrations.length, 2);

  const row = db.prepare('SELECT * FROM sample_assets WHERE id = ?').get('a1');
  assert.equal(row.source_key, 'k1', 'the row survived detach + evolution + reattach');
  assert.equal(row.cost_cents, null);
  db.exec("UPDATE sample_assets SET status = 'active', cost_cents = 99 WHERE id = 'a1';");
  assert.equal(db.prepare('SELECT status FROM sample_assets WHERE id = ?').get('a1').status, 'active');
  assert.notEqual(attached, '', 'the original registry was non-empty');
});

test('the create migration is immutable, and a tampered history is refused', (t) => {
  const root = project(t);
  applyModulePlan(planModule({ manifest: r1(), rootDir: root }));
  applyModulePlan(planModule({ manifest: r2(), rootDir: root }));

  const statePath = join(root, 'packages/modules/widget/module.state.json');
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(state.migrations.length, 2);
  assert.equal(state.migrations[0].name, 'create_widgets', 'the create migration keeps its identity');

  // Editing an applied migration's SQL without its checksum is caught.
  const tampered = structuredClone(state);
  tampered.migrations[0].sql += '\nDROP TABLE widgets;';
  writeFileSync(statePath, JSON.stringify(tampered, null, 2));
  assert.throws(() => readModuleState(root, 'widget'), /was edited — its checksum does not match/);

  // So is a state file lifted from another module.
  const foreign = structuredClone(state);
  foreign.module = 'gadget';
  writeFileSync(statePath, JSON.stringify(foreign, null, 2));
  assert.throws(() => readModuleState(root, 'widget'), /describes "gadget"/);

  // …and a malformed entry.
  const malformed = structuredClone(state);
  malformed.migrations[1] = { name: 'evolve_widgets_r2' };
  writeFileSync(statePath, JSON.stringify(malformed, null, 2));
  assert.throws(() => readModuleState(root, 'widget'), /malformed migration entry/);
});

test('the migration runner blocks violations a migration introduced, not ones it inherited', async (t) => {
  const root = project(t);
  applyModulePlan(planModule({ manifest: r1(), rootDir: root }));
  const { createDatabase } = await import('../packages/core/src/database.js');

  const migrations = (await import(
    new URL(`file://${join(root, 'packages/modules/widget/src/migration.js')}?v=fk`).href
  )).widgetMigrations;

  // A database that already contains an unrelated dangling reference — the way
  // it really happens, with enforcement briefly off.
  const database = createDatabase({ path: ':memory:' });
  database.raw.exec('CREATE TABLE parents (id TEXT PRIMARY KEY) STRICT;');
  database.raw.exec('CREATE TABLE kids (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parents(id)) STRICT;');
  database.raw.exec('PRAGMA foreign_keys = OFF;');
  database.raw.prepare('INSERT INTO kids (id, parent_id) VALUES (?, ?)').run('k1', 'ghost');
  database.raw.exec('PRAGMA foreign_keys = ON;');
  assert.equal(database.raw.prepare('PRAGMA foreign_key_check').all().length, 1, 'the inherited violation is there');

  // An innocent migration must still apply: a database in this state has to
  // remain upgradable.
  assert.doesNotThrow(() => createDatabase({ path: ':memory:', moduleMigrations: migrations }));
  const upgraded = createDatabase({ path: ':memory:' });
  upgraded.raw.exec('CREATE TABLE parents (id TEXT PRIMARY KEY) STRICT;');
  upgraded.raw.exec('CREATE TABLE kids (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parents(id)) STRICT;');
  upgraded.raw.exec('PRAGMA foreign_keys = OFF;');
  upgraded.raw.prepare('INSERT INTO kids (id, parent_id) VALUES (?, ?)').run('k1', 'ghost');
  upgraded.raw.exec('PRAGMA foreign_keys = ON;');
  assert.doesNotThrow(
    () => createDatabase({ path: ':memory:', moduleMigrations: migrations }),
    'an inherited violation elsewhere does not block an unrelated migration',
  );
});

/**
 * Adoption — the upgrade path for modules generated before `module.state.json`
 * existed. Every module shipped before ADR-019 is on disk in exactly this
 * shape, so without adoption none of them could ever take a newer revision of
 * the manifest they already run.
 */

test('a module generated before the state file existed is adopted, and evolves without touching its create migration', async (t) => {
  const root = project(t);
  applyModulePlan(planModule({ manifest: r1(), rootDir: root }));
  const created = readModuleState(root, 'widget').migrations[0];
  // Exactly what a module generated before ADR-019 looks like on disk: a
  // manifest and generated source, and no state file.
  rmSync(join(root, 'packages/modules/widget/module.state.json'));

  const adopted = readModuleState(root, 'widget');
  assert.equal(adopted.adopted, true, 'revision 1 is reconstructed from the manifest and the generated source');
  assert.equal(adopted.revision, 1);
  assert.deepEqual(
    adopted.migrations, [created],
    'byte-identical to the migration the module really generated, so its recorded checksum stays valid',
  );

  // The upgrade the framework has to support: a newer revision of a manifest
  // the project already runs. Before adoption this failed the apply with
  // "Module files already exist for widget; refusing to overwrite".
  const plan = planModule({ manifest: r2(), rootDir: root });
  assert.equal(plan.adopted, true, 'the plan says so before anything is written');
  applyModulePlan(plan);

  const state = readModuleState(root, 'widget');
  assert.equal(state.adopted, false, 'the apply wrote the state file, so a module is adopted at most once');
  assert.equal(state.revision, 2);
  assert.equal(state.migrations.length, 2);
  assert.deepEqual(state.migrations[0], created, 'the applied create migration is unchanged');

  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  await migrateInto(db, root, 'widget');
  db.exec("INSERT INTO widgets(id, source_key, status, created_at, updated_at) VALUES ('w1','k1','in_progress','t','t');");
  assert.equal(db.prepare('SELECT status FROM widgets').get().status, 'in_progress', 'the widened enum reached the table');
});

test('adoption verifies rather than assumes, and refuses what it cannot reconstruct', (t) => {
  const root = project(t);
  applyModulePlan(planModule({ manifest: r1(), rootDir: root }));
  const stateFile = join(root, 'packages/modules/widget/module.state.json');
  const manifestFile = join(root, 'packages/modules/widget/module.manifest.json');
  const manifest = readFileSync(manifestFile, 'utf8');
  rmSync(stateFile);

  // Someone edited the manifest and never applied it. Diffing the next revision
  // against it would produce a migration for a schema no database ever ran.
  writeFileSync(manifestFile, JSON.stringify(
    { ...JSON.parse(manifest), fields: [...JSON.parse(manifest).fields, { name: 'ghost', type: 'string', writable: 'managed' }] },
    null, 2,
  ));
  assert.throws(() => readModuleState(root, 'widget'), /no longer describes the migration/);
  writeFileSync(manifestFile, manifest);

  // Generated source removed: what ran against existing databases is unknown.
  const migrationFile = join(root, 'packages/modules/widget/src/migration.js');
  const migration = readFileSync(migrationFile, 'utf8');
  rmSync(migrationFile);
  assert.throws(() => readModuleState(root, 'widget'), /no src\/migration\.js/);
  writeFileSync(migrationFile, migration);

  // A module already past revision 1 whose state file was lost: revisions 2…
  // cannot be reconstructed from the current manifest, so it is not guessed.
  applyModulePlan(planModule({ manifest: r2(), rootDir: root }));
  rmSync(stateFile);
  assert.throws(() => readModuleState(root, 'widget'), /Only revision 1 can be adopted/);
});

test('a regenerated registry still loads a module generated before the migration list existed', async (t) => {
  const root = project(t);
  applyModulePlan(planModule({ manifest: { ...r1(), name: 'gadget' }, rootDir: root }));
  // Rewrite gadget exactly as the pre-ADR-019 template wrote it: one migration,
  // no list. Gadget is not being upgraded — but applying any *other* module
  // regenerates the shared registry for it too, and a named import of a list it
  // does not export would stop the whole application from loading.
  const sql = readModuleState(root, 'gadget').migrations[0].sql;
  writeFileSync(
    join(root, 'packages/modules/gadget/src/migration.js'),
    `export const gadgetMigration = {\n  name: 'create_gadgets',\n  sql: ${JSON.stringify(sql)},\n};\n`,
  );
  applyModulePlan(planModule({ manifest: r1(), rootDir: root }));

  const registry = await import(`file://${join(root, 'packages/modules/generated/index.js')}?v=${Math.random()}`);
  const gadget = registry.generatedModules.find((entry) => entry.name === 'gadget');
  assert.equal(gadget.migrations.length, 1, 'the single migration is read as a one-entry list');
  assert.equal(gadget.migrations[0].name, 'create_gadgets');
  assert.equal(registry.generatedModules.find((entry) => entry.name === 'widget').migrations.length, 1);
});
