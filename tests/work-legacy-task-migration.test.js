import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { legacyKey, migrateLegacyTasks } from '../packages/work/src/legacy-tasks.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * **An existing starter database must stay readable, and it does.**
 *
 * Before Work v1 the B2B starter shipped its own `task` module: table `tasks`,
 * `title`, `status` in `open`/`done`, `dueAt`, a **required** `leadId`
 * reference to `leads`, a unique `sourceKey`, and every field publicly
 * writable. That module is gone, replaced rather than evolved — Module
 * Evolution (ADR-019) is additive and forward-only, so a required
 * `REFERENCES leads(id)` cannot be relaxed into a generic subject.
 *
 * The table is **never touched**: not renamed, not altered, not dropped. This
 * file builds a database in exactly that old shape, boots the *new* source
 * against it, and proves three things a customer would otherwise find out the
 * hard way:
 *
 *   1. the application still boots and every historical row is still readable;
 *   2. `migrateLegacyTasks` is dry-run by default and writes nothing until asked;
 *   3. applying it is idempotent, maps `done → completed`, turns `leadId` into a
 *      host-owned subject, and **refuses rather than guesses** for a row it
 *      cannot map.
 */

/** The manifest the starter used to ship, reproduced here as the migration's input. */
const LEGACY_TASK_MANIFEST = {
  manifestVersion: 1,
  name: 'legacy-task',
  table: 'tasks',
  description: 'The pre-Work-v1 starter Task, rebuilt here so the forward migration is tested against the real old shape rather than a hand-written table.',
  fields: [
    { name: 'title', type: 'string', required: true },
    { name: 'status', type: 'enum', values: ['open', 'done'] },
    { name: 'dueAt', type: 'timestamp' },
    { name: 'leadId', type: 'reference', references: 'leads', required: true },
    { name: 'sourceKey', type: 'string', unique: true },
  ],
};

function cli(root, args) {
  return spawnSync(process.execPath, ['--no-warnings', join(root, 'packages/cli/bin/accordo.js'), ...args, '--root', root],
    { encoding: 'utf8', cwd: root });
}

/** A project holding BOTH the historical `tasks` table and the new Work records. */
function legacyProject(t) {
  const root = mkdtempSync(join(tmpdir(), 'accordo-work-legacy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const entry of ['packages', 'apps', 'examples', 'package.json']) {
    cpSync(join(repoRoot, entry), join(root, entry), { recursive: true });
  }
  const starter = join(root, 'examples/starters/b2b-lead-qualification');
  assert.equal(cli(root, ['module', 'create', join(starter, 'lead.module.json'), '--apply']).status, 0, 'lead');
  const legacyManifest = join(root, 'legacy-task.module.json');
  writeFileSync(legacyManifest, JSON.stringify(LEGACY_TASK_MANIFEST, null, 2));
  const applied = cli(root, ['module', 'create', legacyManifest, '--apply']);
  assert.equal(applied.status, 0, applied.stderr);
  for (const manifest of ['work-task.module.json', 'work-activity.module.json']) {
    assert.equal(cli(root, ['module', 'create', join(root, 'packages/work/modules', manifest), '--apply']).status, 0, manifest);
  }
  writeFileSync(join(root, 'packages/actions/generated/index.js'),
    ['// @ts-check', 'export const generatedActions = [];', ''].join('\n'));
  writeFileSync(join(root, 'packages/domains/generated/index.js'), [
    '// @ts-check',
    "import { createWorkPackage } from '../../work/src/index.js';",
    'export const generatedDomains = [createWorkPackage()];',
    '',
  ].join('\n'));
  return root;
}

const ACTOR = { type: 'user', id: 'migration' };
const NOW = () => '2026-08-12T00:00:00.000Z';

test('an old-shape database still opens, its rows are still readable, and the migration is dry-run by default', async (t) => {
  const root = legacyProject(t);
  const { createAccordoApp } = await import(pathToFileURL(join(root, 'packages/app/src/index.js')).href);
  const app = createAccordoApp({ dbPath: join(root, 'data', 'legacy.sqlite') });
  t.after(() => app.close());

  const leads = app.modules.get('lead').service;
  const legacy = app.modules.get('legacy-task').service;
  const dana = await leads.create({ firstName: 'Dana', lastName: 'Rossi', email: 'dana@acme.example' }, { actor: ACTOR });
  const sam = await leads.create({ firstName: 'Sam', lastName: 'Neri', email: 'sam@beta.example' }, { actor: ACTOR });
  await legacy.create({
    title: 'Follow up with Dana Rossi', status: 'open',
    dueAt: '2026-08-12T09:00:00.000Z', leadId: dana.id, sourceKey: `qualify:${dana.id}`,
  }, { actor: ACTOR });
  await legacy.create({
    title: 'Follow up with Sam Neri', status: 'done',
    dueAt: null, leadId: sam.id, sourceKey: `qualify:${sam.id}`,
  }, { actor: ACTOR });

  // 1. The historical rows are readable, exactly as they were written.
  const historical = app.database.raw.prepare('SELECT id, title, status, lead_id FROM tasks ORDER BY title').all();
  assert.equal(historical.length, 2);
  assert.deepEqual(historical.map((row) => row.status), ['open', 'done']);

  // 2. Dry-run by default: a plan, and not one row written.
  const plan = await migrateLegacyTasks({ database: app.database, modules: app.modules, actor: ACTOR, now: NOW });
  assert.equal(plan.mode, 'dry-run');
  assert.equal(plan.found, 2);
  assert.equal(plan.wouldAdopt, 2);
  assert.equal(plan.adopted, 0);
  assert.deepEqual(plan.refused, []);
  assert.deepEqual([...plan.legacySourceKeys].sort(), [`qualify:${dana.id}`, `qualify:${sam.id}`].sort());
  assert.equal(app.modules.get('work-task').service.list().length, 0, 'a plan writes nothing');

  // 3. Applying it adopts each row forward, once.
  const applied = await migrateLegacyTasks(
    { database: app.database, modules: app.modules, actor: ACTOR, now: NOW }, { apply: true },
  );
  assert.equal(applied.mode, 'apply');
  assert.equal(applied.adopted, 2);
  const tasks = app.modules.get('work-task').service;
  assert.equal(tasks.list().length, 2);

  const adoptedOpen = tasks.listWhere({ sourceKey: legacyKey(historical.find((r) => r.status === 'open').id) })[0];
  assert.equal(adoptedOpen.status, 'open');
  assert.equal(adoptedOpen.subjectResource, 'lead');
  assert.equal(adoptedOpen.subjectId, dana.id);
  assert.equal(adoptedOpen.subjectOwner, 'host', 'a Lead belongs to the project');
  assert.equal(adoptedOpen.sourcePackage, 'host');
  assert.equal(adoptedOpen.sourceAction, 'qualify');

  const adoptedDone = tasks.listWhere({ sourceKey: legacyKey(historical.find((r) => r.status === 'done').id) })[0];
  assert.equal(adoptedDone.status, 'completed', 'done maps to completed');
  // The legacy row recorded no completion actor or instant, so neither is
  // invented: an absent value is the honest answer, not a made-up one.
  assert.equal(adoptedDone.completedBy, null);
  assert.equal(adoptedDone.completedAt, null);

  // 4. Idempotent: a second apply adopts nothing twice.
  const second = await migrateLegacyTasks(
    { database: app.database, modules: app.modules, actor: ACTOR, now: NOW }, { apply: true },
  );
  assert.equal(second.adopted, 0);
  assert.equal(second.alreadyAdopted, 2);
  assert.equal(tasks.list().length, 2);

  // 5. The old table is still exactly the old table. Nothing renamed it,
  //    altered it or dropped it, and every historical row is still there.
  assert.deepEqual(
    app.database.raw.prepare('SELECT id, title, status, lead_id FROM tasks ORDER BY title').all(),
    historical,
  );
});

test('a row the migration cannot map is refused and named, never guessed', async (t) => {
  const root = legacyProject(t);
  const { createAccordoApp } = await import(pathToFileURL(join(root, 'packages/app/src/index.js')).href);
  const app = createAccordoApp({ dbPath: join(root, 'data', 'unmapped.sqlite') });
  t.after(() => app.close());

  const lead = await app.modules.get('lead').service.create(
    { firstName: 'Odd', lastName: 'State', email: 'odd@x.example' }, { actor: ACTOR },
  );
  // An even older shape: a `status` with no CHECK and a nullable `lead_id`,
  // which is what a database written before the starter's last manifest
  // actually looks like. The migration's job here is to refuse rather than to
  // guess, and to name what it refused.
  app.database.raw.exec(`CREATE TABLE old_tasks (
    id TEXT PRIMARY KEY, title TEXT, status TEXT, due_at TEXT,
    lead_id TEXT, source_key TEXT, created_at TEXT NOT NULL, updated_at TEXT
  )`);
  const insert = app.database.raw.prepare(
    'INSERT INTO old_tasks (id, title, status, due_at, lead_id, source_key, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
  );
  insert.run('t-odd', 'Ancient task', 'archived', null, lead.id, 'qualify:odd', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z');
  insert.run('t-orphan', 'Task with no subject', 'open', null, null, 'qualify:orphan', '2025-01-02T00:00:00.000Z', '2025-01-02T00:00:00.000Z');
  insert.run('t-good', 'A task it can map', 'open', null, lead.id, 'qualify:good', '2025-01-03T00:00:00.000Z', '2025-01-03T00:00:00.000Z');

  const report = await migrateLegacyTasks(
    { database: app.database, modules: app.modules, actor: ACTOR, now: NOW, table: 'old_tasks' }, { apply: true },
  );
  assert.equal(report.found, 3);
  assert.equal(report.adopted, 1, 'only the row it could map honestly');
  assert.deepEqual(report.refused, [
    { id: 't-odd', reason: 'UNMAPPED_STATUS', status: 'archived' },
    { id: 't-orphan', reason: 'NO_SUBJECT', status: 'open' },
  ]);
  const tasks = app.modules.get('work-task').service;
  assert.equal(tasks.list().length, 1,
    'a status nobody can map and a row with no subject produce no task at all, rather than guessed ones');
  assert.equal(tasks.listWhere({ sourceKey: legacyKey('t-good') }).length, 1);
});

test('a database that never had the legacy table reports nothing to do rather than failing', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'accordo-work-nolegacy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const entry of ['packages', 'apps', 'examples', 'package.json']) {
    cpSync(join(repoRoot, entry), join(root, entry), { recursive: true });
  }
  for (const manifest of ['work-task.module.json', 'work-activity.module.json']) {
    assert.equal(cli(root, ['module', 'create', join(root, 'packages/work/modules', manifest), '--apply']).status, 0, manifest);
  }
  writeFileSync(join(root, 'packages/actions/generated/index.js'),
    ['// @ts-check', 'export const generatedActions = [];', ''].join('\n'));
  writeFileSync(join(root, 'packages/domains/generated/index.js'), [
    '// @ts-check',
    "import { createWorkPackage } from '../../work/src/index.js';",
    'export const generatedDomains = [createWorkPackage()];',
    '',
  ].join('\n'));
  const { createAccordoApp } = await import(pathToFileURL(join(root, 'packages/app/src/index.js')).href);
  const app = createAccordoApp({ dbPath: join(root, 'data', 'fresh.sqlite') });
  t.after(() => app.close());

  const report = await migrateLegacyTasks({ database: app.database, modules: app.modules, actor: ACTOR, now: NOW });
  assert.equal(report.found, 0);
  assert.equal(report.adopted, 0);
  assert.match(report.note, /nothing to migrate/);
});

test('the migration refuses a table name that is not a canonical identifier', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'accordo-work-badtable-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  await assert.rejects(
    () => migrateLegacyTasks({ database: { raw: { prepare: () => ({ get: () => null }) } }, modules: { get: () => ({ service: { createManaged: () => {}, listWhere: () => [] } }) }, table: 'tasks; DROP TABLE leads' }),
    (error) => error.status === 400 && error.details?.field === 'table',
  );
});
