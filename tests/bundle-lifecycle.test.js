// @ts-check

// BO-F5-01 acceptance (backlog:8691acfc): custom bundles install beside the
// kernel, versioned and removable, without touching clienti, pipeline or
// calendario — and the "Crea con l'AI" path generates a bundle that really
// installs (it boots and serves records), never a simulation.
//
// The coding-agent role in the "Crea con l'AI" flow (docs/BUNDLES.md) is
// played by this file: it drafts the module manifest from a description,
// runs the real `bundle create --apply`, then proves installability with
// `bundle verify` (a live boot that serves a record) — the same commands a
// human agent runs. Nothing here stubs the install.

import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  listBundles,
  parseBundleRef,
  planBundleCreate,
} from '../packages/cli/src/bundle-manager.js';
import { createAccordoApp } from '../packages/app/src/index.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const ACTOR = { type: 'human', id: 'bundle-lifecycle' };

// The description the user typed in the backoffice ("Crea con l'AI"). The
// agent's job is exactly this step: turn the description into a manifest.
// Everything after the manifest is mechanical and proven below.
const DESCRIPTION = 'un modulo sonde per i KPI del pilota (etichetta + conteggio)';

const probeManifest = {
  manifestVersion: 1,
  name: 'lifecycle-probe',
  description: `Probe module drafted from the description: "${DESCRIPTION}".`,
  fields: [
    { name: 'label', type: 'string', required: true },
    { name: 'count', type: 'integer' },
  ],
};

/**
 * @param {string} root
 */
function tableNamesOfDatabase(raw) {
  return raw.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all().map((row) => row.name);
}

test('bundle plan refuses kernel names, kernel tables and loose versions', () => {
  // A bundle may not shadow a kernel module (contact = clienti).
  assert.throws(
    () => planBundleCreate({ manifest: { ...probeManifest, name: 'contact' }, name: 'contact', version: '0.0.1', createdBy: 'ai', rootDir: repoRoot }),
    /kernel module|shadow/i,
  );
  // A bundle may not claim kernel storage (contacts, opportunities, audit…).
  // Probe names stay valid bundle names (underscores become hyphens) so the
  // refusal under test is the table guard, not the name guard.
  for (const table of ['contacts', 'companies', 'opportunities', 'approvals', 'audit_events']) {
    const probe = `probe-${table.replaceAll('_', '-')}`;
    assert.throws(
      () => planBundleCreate({
        manifest: { ...probeManifest, name: probe, table },
        name: probe,
        version: '0.0.1',
        createdBy: 'ai',
        rootDir: repoRoot,
      }),
      /kernel-owned/i,
      `table ${table} must be refused`,
    );
  }
  // Versions are exact semver: no ranges, no prefixes, no bare names.
  for (const bad of ['1.2', 'v1.2.0', 'latest', '1.2.0-beta', '']) {
    assert.throws(() => parseBundleRef(`probe@${bad}`), /version/i, `version ${JSON.stringify(bad)} must be refused`);
  }
  assert.throws(() => parseBundleRef('probe'), /name@version/i);
  assert.throws(
    () => planBundleCreate({ manifest: probeManifest, name: 'lifecycle-probe', version: '0.0.1', createdBy: 'wizard', rootDir: repoRoot }),
    /createdBy/i,
  );
});

test('bundle create writes only under bundles/ and versions are immutable', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'accordo-bundle-plan-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { applyBundleCreate } = await import('../packages/cli/src/bundle-manager.js');

  const plan = planBundleCreate({ manifest: probeManifest, name: 'lifecycle-probe', version: '0.0.1', createdBy: 'ai', rootDir: root });
  for (const file of [...plan.modulePlan.files, ...plan.files]) {
    assert.ok(!file.path.startsWith('packages/'), `${file.path} must not touch the kernel`);
    assert.ok(file.path.startsWith(join('bundles', 'lifecycle-probe', '0.0.1')), file.path);
  }
  const applied = applyBundleCreate(plan);
  assert.equal(applied.bundle, 'lifecycle-probe');
  assert.equal(applied.version, '0.0.1');
  assert.ok(existsSync(join(root, 'bundles', 'lifecycle-probe', '0.0.1', 'bundle.json')));
  const recorded = JSON.parse(readFileSync(join(root, 'bundles', 'lifecycle-probe', '0.0.1', 'bundle.json'), 'utf8'));
  assert.equal(recorded.createdBy, 'ai');
  assert.deepEqual(recorded.modules, [{ name: 'lifecycle-probe', table: applied.table, migration: applied.migrationName }]);

  // A version never regenerates in place: the same ref plans no more.
  assert.throws(
    () => planBundleCreate({ manifest: probeManifest, name: 'lifecycle-probe', version: '0.0.1', createdBy: 'ai', rootDir: root }),
    /new bundle version/i,
  );
  // …while a new version plans cleanly.
  const next = planBundleCreate({ manifest: probeManifest, name: 'lifecycle-probe', version: '0.0.2', createdBy: 'ai', rootDir: root });
  assert.equal(next.version, '0.0.2');
});

/**
 * Copy the project (the e2e pattern): generated bundle code imports the
 * framework relatively, so installability is proven inside a real tree.
 *
 * @param {import('node:test').TestContext} t
 */
function createProjectCopy(t) {
  const root = mkdtempSync(join(tmpdir(), 'accordo-bundle-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const entry of ['packages', 'apps', 'examples', 'package.json']) {
    cpSync(join(repoRoot, entry), join(root, entry), { recursive: true });
  }
  return root;
}

test('dalla descrizione al bundle installato ("Crea con l\'AI"): genera, verifica, installa, serve, rimuovi', async (t) => {
  const root = createProjectCopy(t);

  // Kernel calendario in the copy: the appointment module, generated like any
  // kernel module (the same command the milestones use). Generated BEFORE the
  // copy's app is first imported: the app reads the generated registry with a
  // static import, so a module generated after that import would not exist
  // for this boot — the same ordering a real checkout has.
  const { planModule, applyModulePlan } = await import(pathToFileURL(join(root, 'packages/cli/src/module-factory.js')).href);
  const appointmentManifest = JSON.parse(readFileSync(join(root, 'packages/appointments/modules/appointment.module.json'), 'utf8'));
  applyModulePlan(planModule({ manifest: appointmentManifest, rootDir: root }));

  const copy = await import(pathToFileURL(join(root, 'packages/cli/src/bundle-manager.js')).href);
  const { createAccordoApp: createCopyApp } = await import(pathToFileURL(join(root, 'packages/app/src/index.js')).href);

  // The agent step: description -> manifest (above) -> real bundle on disk.
  const plan = copy.planBundleCreate({ manifest: probeManifest, name: 'lifecycle-probe', version: '0.0.1', createdBy: 'ai', rootDir: root });
  copy.applyBundleCreate(plan);
  const kernelRegistry = readFileSync(join(root, 'packages/modules/generated/index.js'), 'utf8');
  assert.ok(!kernelRegistry.includes('lifecycle-probe'), 'the kernel registry never names the bundle');

  // Verify IS the installability proof: it boots the copy's app with the
  // bundle composed and serves a record. A bundle that does not boot and
  // serve is refused here — never simulated.
  const proof = await copy.verifyBundle({ name: 'lifecycle-probe', version: '0.0.1', rootDir: root });
  assert.equal(proof.modules.length, 1);
  assert.equal(proof.modules[0].rows, 1);

  const installed = await copy.installBundle({ name: 'lifecycle-probe', version: '0.0.1', rootDir: root });
  assert.deepEqual(installed.installed, [{ name: 'lifecycle-probe', version: '0.0.1' }]);
  assert.deepEqual(copy.listBundles({ rootDir: root }).bundles.map((entry) => [entry.name, entry.version, entry.installed]), [
    ['lifecycle-probe', '0.0.1', true],
  ]);

  // Live data on every protected surface: clienti (companies+contacts),
  // pipeline (opportunities), calendario (appointments), bundle (probe).
  const dbPath = join(root, 'data', 'lifecycle.sqlite');
  const entries = await copy.createBundleEntries({ rootDir: root, bundles: [{ name: 'lifecycle-probe', version: '0.0.1' }] });
  const app = createCopyApp({ dbPath, bundles: entries });
  // Closed explicitly before the reopen below; the hook is a once-guard so
  // the teardown never closes twice.
  let appOpen = true;
  t.after(() => { if (appOpen) { appOpen = false; app.close(); } });
  const company = await app.services.companies.create({ name: 'Palestra Presti' }, { actor: ACTOR });
  const contact = await app.services.contacts.create(
    { companyId: company.id, firstName: 'Guido', lastName: 'Presti', email: 'guido@presti.example' },
    { actor: ACTOR },
  );
  const opportunity = await app.services.opportunities.create(
    { companyId: company.id, contactId: contact.id, name: 'Abbonamento annuale', type: 'new_business', valueCents: 120000, currency: 'EUR', stage: 'discovery', owner: 'guido' },
    { actor: ACTOR },
  );
  const appointment = await app.modules.get('appointment').service.createManaged({
    sourceKey: 'gym:lifecycle:1',
    subjectResource: 'contact',
    subjectId: contact.id,
    subjectOwner: 'host',
    teamMemberId: 'coach-guido',
    serviceKey: 'pt-single',
    priceCents: 4000,
    currency: 'EUR',
    startsAt: '2026-10-23T17:00:00.000Z',
    endsAt: '2026-10-23T18:00:00.000Z',
    status: 'booked',
  }, { actor: ACTOR });
  const probe = await app.modules.get('lifecycle-probe').service.create({ label: 'kpi del pilota', count: 3 }, { actor: ACTOR });
  assert.ok(typeof probe.id === 'string' && probe.id !== '', 'the bundle serves a real record');

  const raw = app.database.raw;
  const snapshot = {};
  for (const table of tableNamesOfDatabase(raw)) {
    snapshot[table] = raw.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n;
  }
  const probeTable = proof.modules[0].table;
  assert.equal(snapshot[probeTable], 1);
  const kernelTablesBefore = Object.keys(snapshot).filter((table) => table !== probeTable);

  // Uninstall with the live database: only the bundle's own tables drop.
  const uninstalled = await copy.uninstallBundle({ name: 'lifecycle-probe', version: '0.0.1', rootDir: root, database: app.database });
  assert.deepEqual(uninstalled.dropped, [proof.modules[0].table]);
  appOpen = false;
  app.close();

  // The app boots clean without the bundle; every kernel table and every
  // kernel row survived.
  const reopened = createCopyApp({ dbPath });
  t.after(() => reopened.close());
  const after = {};
  for (const table of tableNamesOfDatabase(reopened.database.raw)) {
    after[table] = reopened.database.raw.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n;
  }
  assert.ok(!(probeTable in after), 'bundle table is gone');
  for (const table of kernelTablesBefore) {
    assert.ok(table in after, `kernel table ${table} survives the uninstall`);
    assert.equal(after[table], snapshot[table], `kernel table ${table} keeps its rows`);
  }
  assert.equal(reopened.services.contacts.get(contact.id).id, contact.id);
  assert.equal(reopened.services.opportunities.get(opportunity.id).id, opportunity.id);
  assert.equal(reopened.modules.get('appointment').service.get(appointment.id).id, appointment.id);
  assert.deepEqual(copy.listBundles({ rootDir: root }).bundles.map((entry) => entry.installed), [false]);
});

test('la guardia copre ogni tabella kernel viva (nessuna nuova tabella resta fuori)', async () => {
  // Self-maintaining: boot the real kernel, and refuse a bundle claiming ANY
  // of its live tables. A new kernel table fails this test until it is
  // protected in BUNDLE_PROTECTED_TABLES.
  const app = createAccordoApp({ dbPath: ':memory:' });
  try {
    const live = tableNamesOfDatabase(app.database.raw);
    assert.ok(live.includes('contacts') && live.includes('opportunities'), 'clienti e pipeline ci sono davvero');
    let refused = 0;
    for (const table of live) {
      assert.throws(
        () => planBundleCreate({
          manifest: { ...probeManifest, name: 'guard-probe', table },
          name: 'guard-probe',
          version: '0.0.1',
          createdBy: 'ai',
          rootDir: repoRoot,
        }),
        /kernel-owned|core framework/i,
        `live kernel table ${table} must be refused`,
      );
      refused += 1;
    }
    assert.ok(refused >= 10, `expected a real kernel table set, got ${refused}`);
  } finally {
    app.close();
  }
  assert.deepEqual(
    listBundles().bundles.filter((entry) => entry.installed),
    [],
    'no bundle is installed implicitly in this checkout',
  );
});
