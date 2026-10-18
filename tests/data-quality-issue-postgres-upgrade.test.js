import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generatePostgresModuleBootstrap } from '../packages/core/src/module-evolution.js';
import { PINNED_MODULE_BOOTSTRAP_PREDECESSORS } from '../packages/core/src/schema-migrations-ledger.js';
import { bootPostgresqlApp, bootPostgresqlReader, GADGET_MIGRATION, openIsolatedPostgresqlPlanes } from './helpers/postgresql-application.js';

const { Client } = pg;
const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Both data-quality-issue generations must upgrade through the production
 * path (accordo 4c3ad4870a5f: b8266ea widened the `kind` enum without
 * raising the revision, so revision 1 shipped two released bootstrap
 * identities — the original `6d601a00…` recorded by presti-group and the
 * widened `44aec90d…` recorded by every database bootstrapped from b8266ea
 * until the revision-2 fix. The first revision of this cure only bridged the
 * first generation; databases of the second failed with
 * MODULE_MIGRATION_CHECKSUM_MISMATCH on `pg_bootstrap_data_quality_issues`).
 *
 * This test replays both upgrades on real PostgreSQL: migrate with the
 * revision 1 manifest (pre-b8266ea) and with the widened manifest (b8266ea),
 * then compose through the production path — plain `{name, manifest}`
 * entries built from the checked-in `*.module.json` files alone, exactly
 * what `startPortablePostgresqlApp` and the pilot writer composition pass.
 * The framework reads the checked-in `<name>.history.json` itself and the
 * ledger bridge accepts the widened recording as the same migration; no
 * caller attaches anything.
 * Skips cleanly without a database; CI always runs this suite against
 * postgres:16.
 */

const loadJson = (path) => JSON.parse(readFileSync(join(HERE, path), 'utf8'));
const DQI_MODULES_DIR = join(HERE, '../packages/customer-data/modules');
const dqiRevision1 = () => loadJson('../packages/customer-data/modules/data-quality-issue.history.json').previousManifests[0];
// What b8266ea shipped: the revision 1 manifest plus its one known edit, no
// revision key — the honest source of the pinned predecessor, never copied.
const dqiWidenedRevision1 = () => {
  const widened = JSON.parse(JSON.stringify(dqiRevision1()));
  const kind = widened.fields.find((field) => field.name === 'kind');
  kind.values.splice(kind.values.indexOf('conflicting_external_identity') + 1, 0, 'identity_conflict_windowed_scope');
  return widened;
};
const sha = (sql) => createHash('sha256').update(sql).digest('hex');

// The current production selection for these modules: every checked-in
// `*.module.json` as a plain `{name, manifest}` entry, the way the pilot
// builds its selection. The framework supplies the checked-in history for
// data-quality-issue itself.
const selectedProduction = () => ({
  packageContract: 2, packages: [], actions: [],
  modules: readdirSync(DQI_MODULES_DIR)
    .filter((file) => file.endsWith('.module.json'))
    .sort()
    .map((file) => {
      const manifest = JSON.parse(readFileSync(join(DQI_MODULES_DIR, file), 'utf8'));
      return { name: manifest.name, manifest };
    }),
});
const selectedWithoutDqi = () => {
  const selected = selectedProduction();
  return { ...selected, modules: selected.modules.filter((entry) => entry.name !== 'data-quality-issue') };
};
// The database as framework b8266ea left it for this module: the widened
// manifest composed directly — no history mechanism existed — so the single
// bootstrap below is recorded under the widened checksum.
const widenedBootstrapMigration = () => ({
  name: 'pg_bootstrap_data_quality_issues',
  sql: generatePostgresModuleBootstrap(dqiWidenedRevision1()).sql,
});

async function connectTo(plane) {
  const client = new Client({
    host: plane.host, port: plane.port, user: plane.user, password: plane.password,
    database: plane.database, connectionTimeoutMillis: 5000,
  });
  await client.connect();
  return client;
}

async function dqiLedger(client) {
  const ledger = await client.query(
    'SELECT name, checksum FROM accordo.module_migrations WHERE name LIKE \'%data_quality_issue%\' ORDER BY name',
  );
  return ledger.rows;
}

async function insertDqiRow(client, id, kind) {
  await client.query(
    'INSERT INTO accordo.data_quality_issues (id, source_key, kind, created_at, updated_at) VALUES ($1, $2, $3, now(), now())',
    [id, `seed:${id}`, kind],
  );
}

test('a pre-b8266ea database upgrades through the production path', { timeout: 300_000 }, async (t) => {
  const planes = await openIsolatedPostgresqlPlanes(t);
  if (!planes) return;

  // The database presti-group holds: migrated with the original revision 1
  // modules, holding a row written before the widened value existed.
  const selected = selectedProduction();
  const old = await bootPostgresqlApp(t, {
    planes,
    selected: {
      ...selected,
      modules: selected.modules.map((entry) => (entry.name === 'data-quality-issue'
        ? { name: 'data-quality-issue', manifest: dqiRevision1() }
        : entry)),
    },
  });
  const setup = await connectTo(planes.data);
  try {
    await insertDqiRow(setup, 'legacy-1', 'conflicting_external_identity');
  } finally {
    await setup.end();
  }
  await old.app.close();

  const upgraded = await bootPostgresqlApp(t, { planes, selected: selectedProduction() });
  const check = await connectTo(planes.data);
  try {
    const ledger = await dqiLedger(check);
    assert.deepEqual(ledger.map((row) => row.name), ['pg_bootstrap_data_quality_issues', 'pg_evolve_data_quality_issues_r2']);
    assert.equal(ledger[0].checksum, '6d601a00c1bd40d3c3618f0a204cf9c16c35e024b051828c7739b63dad2c3b63');
    const legacy = await check.query('SELECT id, source_key, kind FROM accordo.data_quality_issues WHERE id = \'legacy-1\'');
    assert.equal(legacy.rowCount, 1, 'the pre-upgrade row survives');
    assert.equal(legacy.rows[0].source_key, 'seed:legacy-1');
    await insertDqiRow(check, 'post-upgrade-1', 'identity_conflict_windowed_scope');
  } finally {
    await check.end();
  }
  await upgraded.app.close();
});

test('a b8266ea database upgrades through the production path instead of mismatching', { timeout: 300_000 }, async (t) => {
  const planes = await openIsolatedPostgresqlPlanes(t);
  if (!planes) return;

  // The generation the first revision of this cure broke: the widened
  // bootstrap recorded under the same migration name. b8266ea composed the
  // manifest directly, so the setup passes its SQL as a raw migration —
  // byte-identical to what that framework recorded (proven below).
  const widened = widenedBootstrapMigration();
  assert.equal(
    sha(widened.sql),
    PINNED_MODULE_BOOTSTRAP_PREDECESSORS['pg_bootstrap_data_quality_issues'].predecessors[0],
  );
  const old = await bootPostgresqlApp(t, {
    planes,
    selected: selectedWithoutDqi(),
    moduleMigrations: [GADGET_MIGRATION, widened],
  });
  const setup = await connectTo(planes.data);
  try {
    await insertDqiRow(setup, 'legacy-1', 'conflicting_external_identity');
    await insertDqiRow(setup, 'legacy-2', 'identity_conflict_windowed_scope');
  } finally {
    await setup.end();
  }
  await old.app.close();

  // The current framework composes over that database from manifest-only
  // entries: the widened recording is bridged as the same migration (its row
  // is never rewritten) and revision 2 arrives as the additive evolution,
  // converging both generations to the same schema.
  const upgraded = await bootPostgresqlApp(t, {
    planes,
    selected: selectedProduction(),
    moduleMigrations: [GADGET_MIGRATION],
  });
  const check = await connectTo(planes.data);
  try {
    const ledger = await dqiLedger(check);
    assert.deepEqual(ledger.map((row) => row.name), ['pg_bootstrap_data_quality_issues', 'pg_evolve_data_quality_issues_r2']);
    assert.equal(
      ledger[0].checksum,
      PINNED_MODULE_BOOTSTRAP_PREDECESSORS['pg_bootstrap_data_quality_issues'].predecessors[0],
      'the widened recording stands: history is bridged, never rewritten',
    );
    const legacy = await check.query('SELECT id, kind FROM accordo.data_quality_issues WHERE id IN (\'legacy-1\', \'legacy-2\') ORDER BY id');
    assert.equal(legacy.rowCount, 2, 'both pre-upgrade rows survive');
    assert.equal(legacy.rows[0].kind, 'conflicting_external_identity');
    assert.equal(legacy.rows[1].kind, 'identity_conflict_windowed_scope');
    await insertDqiRow(check, 'post-upgrade-1', 'identity_conflict_windowed_scope');
    await assert.rejects(
      insertDqiRow(check, 'bad-kind-1', 'not_a_kind'),
      /CHECK|check/i,
      'the converged CHECK still rejects unknown kinds',
    );
  } finally {
    await check.end();
  }

  // A reader over the upgraded plane renders the same migrations and must
  // accept the bridged recording too — otherwise the writer boots and the
  // web does not.
  const reader = await bootPostgresqlReader(t, {
    data: upgraded.data, tenantId: upgraded.tenantId, selected: selectedProduction(),
  });
  assert.ok(reader, 'the reader composes over the bridged plane');
});
