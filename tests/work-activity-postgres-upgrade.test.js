import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bootPostgresqlApp, openIsolatedPostgresqlPlanes } from './helpers/postgresql-application.js';
import { createTestVerifier } from './helpers/identity-verifier-fixture.mjs';
import { createAccordoAppAsync } from '../packages/app/src/index.js';

const { Client } = pg;
const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * A framework revision must not break databases the previous framework
 * migrated (accordo 97a4fbbea85b: presti-group's database, migrated with the
 * work-activity revision 1 modules of framework b48b09e, could no longer
 * compose with the revision 2 framework 39d45ad — the seed failed with
 * MODULE_MIGRATION_CHECKSUM_MISMATCH).
 *
 * This test replays that upgrade on real PostgreSQL: migrate with the
 * revision 1 manifest (what b48b09e shipped), then compose through the
 * production path — plain `{name, manifest}` entries built from the
 * checked-in `*.module.json` files alone, exactly what `startPortablePostgresqlApp`
 * and the pilot writer composition pass. The framework reads the checked-in
 * `<name>.history.json` itself; no caller attaches anything.
 * Skips cleanly without a database; CI always runs this suite against
 * postgres:16.
 */

const loadJson = (path) => JSON.parse(readFileSync(join(HERE, path), 'utf8'));
const WORK_MODULES_DIR = join(HERE, '../packages/work/modules');
const revision1 = () => loadJson('../packages/work/modules/work-activity.history.json').previousManifests[0];
const revision2 = () => loadJson('../packages/work/modules/work-activity.module.json');
const workTask = () => loadJson('../packages/work/modules/work-task.module.json');

// The database as framework b48b09e left it: plain `{name, manifest}`
// entries with the revision 1 manifest — no history support at all.
const selectedRev1 = () => ({
  packageContract: 2, packages: [], actions: [],
  modules: [
    { name: 'work-activity', manifest: revision1() },
    { name: 'work-task', manifest: workTask() },
  ],
});
// The current production path: every `*.module.json` as a plain
// `{name, manifest}` entry, the way the pilot builds its selection. The
// framework supplies the checked-in history for work-activity itself.
const selectedRev2Production = () => ({
  packageContract: 2, packages: [], actions: [],
  modules: readdirSync(WORK_MODULES_DIR)
    .filter((file) => file.endsWith('.module.json'))
    .sort()
    .map((file) => {
      const manifest = JSON.parse(readFileSync(join(WORK_MODULES_DIR, file), 'utf8'));
      return { name: manifest.name, manifest };
    }),
});

async function connectTo(plane) {
  const client = new Client({
    host: plane.host, port: plane.port, user: plane.user, password: plane.password,
    database: plane.database, connectionTimeoutMillis: 5000,
  });
  await client.connect();
  return client;
}

test('a revision-1 database composes with the current framework through the production path', { timeout: 300_000 }, async (t) => {
  const planes = await openIsolatedPostgresqlPlanes(t);
  if (!planes) return;

  // The database as framework b48b09e left it: migrated with the revision 1
  // modules, holding a row written before `seq` existed.
  const old = await bootPostgresqlApp(t, { planes, selected: selectedRev1() });
  const setup = await connectTo(planes.data);
  try {
    await setup.query(
      `INSERT INTO accordo.work_activities (id, source_key, kind, created_at, updated_at)
       VALUES ('legacy-1', 'seed:legacy:1', 'note', now(), now())`,
    );
  } finally {
    await setup.end();
  }
  await old.app.close();

  // The current framework composes over that database from manifest-only
  // entries: the recorded bootstrap matches, and revision 2 arrives as the
  // additive `pg_evolve_work_activities_r2` migration.
  const upgraded = await bootPostgresqlApp(t, { planes, selected: selectedRev2Production() });
  const check = await connectTo(planes.data);
  try {
    const ledger = await check.query('SELECT name FROM accordo.module_migrations WHERE name LIKE \'%work_activit%\' ORDER BY name');
    assert.deepEqual(
      ledger.rows.map((row) => row.name),
      ['pg_bootstrap_work_activities', 'pg_evolve_work_activities_r2'],
    );
    const columns = await check.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'accordo' AND table_name = 'work_activities' AND column_name = 'seq'`,
    );
    assert.equal(columns.rowCount, 1, 'the revision 2 column exists after the upgrade');
    const legacy = await check.query('SELECT id, source_key, seq FROM accordo.work_activities WHERE id = \'legacy-1\'');
    assert.equal(legacy.rowCount, 1, 'the pre-upgrade row survives');
    assert.equal(legacy.rows[0].source_key, 'seed:legacy:1');
    assert.equal(legacy.rows[0].seq, null);
  } finally {
    await check.end();
  }

  // And the upgraded composition writes through the new column.
  const service = upgraded.app.modules.get('work-activity').service;
  const written = await service.createManaged({
    sourceKey: 'seed:post-upgrade:1',
    kind: 'note',
    subjectResource: 'contact',
    subjectId: 'contact-1',
    taskId: 'task-1',
    body: 'after the upgrade',
    occurredAt: '2026-10-18T08:00:00.000Z',
    actorType: 'user',
    actorId: 'operator-1',
    sourcePackage: 'work',
    sourceAction: 'test',
    seq: 1,
  }, { actor: { type: 'user', id: 'operator-1' } });
  assert.equal(written.seq, 1);
});

test('a hand-built history that disagrees with the checked-in one refuses loudly', { timeout: 300_000 }, async (t) => {
  const planes = await openIsolatedPostgresqlPlanes(t);
  if (!planes) return;

  const old = await bootPostgresqlApp(t, { planes, selected: selectedRev1() });
  await old.app.close();

  // The framework always renders the checked-in history. A caller that claims
  // "no history" (or any other chain) for a module that ships one is refused
  // before any migration renders — never silently re-applied.
  const identityVerifier = createTestVerifier({ tenantId: 'acme' });
  await assert.rejects(
    createAccordoAppAsync({
      adapter: 'postgresql',
      testHarness: { loopback: true, control: planes.control, data: planes.data },
      spine: { mode: 'local-development', tenant: { id: 'acme' } },
      identityVerifier,
      selected: {
        packageContract: 2, packages: [], actions: [],
        modules: [{ name: 'work-activity', manifest: revision2(), previousManifests: [] }],
      },
    }),
    (error) => {
      assert.equal(error.code, 'VALIDATION_ERROR');
      assert.match(error.message, /does not match the checked-in revision history/);
      return true;
    },
  );
});
