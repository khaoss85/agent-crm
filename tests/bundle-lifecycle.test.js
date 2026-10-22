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
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

test('bundle ownership registry: one module and one table per bundle (every round in one table)', async (t) => {
  // NOT_GENERAL (backlog:8691acfc): the atomic-apply and ledger-forget cures
  // of the previous round and the table-collision finding of this round share
  // one root — bundle storage ownership enforced piecemeal. The single source
  // of truth is scanBundleModules (name + table + owner), read once by
  // planBundleCreate for both refusals. This table holds every case of the
  // earlier rounds and this one; a new ownership case extends this table,
  // never a new ad-hoc check.
  const root = mkdtempSync(join(tmpdir(), 'accordo-bundle-ownership-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { applyBundleCreate } = await import('../packages/cli/src/bundle-manager.js');

  const owner = { ...probeManifest, name: 'sonde', table: 'sonde_rows' };
  applyBundleCreate(planBundleCreate({ manifest: owner, name: 'sonde', version: '0.0.1', createdBy: 'ai', rootDir: root }));
  // A foreign bundle dir (hand-placed, like an orphan from an interrupted
  // apply): bundle "estera" owns a module named "intrusa".
  const foreignDir = join(root, 'bundles', 'estera', '0.0.1');
  mkdirSync(foreignDir, { recursive: true });
  writeFileSync(
    join(foreignDir, 'module.manifest.json'),
    JSON.stringify({ ...probeManifest, name: 'intrusa', table: 'intrusa_rows' }, null, 2),
    'utf8',
  );

  /** @type {Array<[string, any, string, string, RegExp | null]>} */
  const cases = [
    // Earlier round: a version never regenerates in place.
    ['same bundle same version regenerates nothing', owner, 'sonde', '0.0.1', /new bundle version/i],
    // Earlier round: a different bundle may not take the module name…
    ['cross-bundle module name (foreign dir)', { ...probeManifest, name: 'intrusa', table: 'intrusa_rows' }, 'intrusa', '0.0.1', /one module, one bundle/i],
    // …nor the table (this round): two services on one physical table mix
    // rows while the second CREATE TABLE IF NOT EXISTS silently no-ops.
    ['cross-bundle table', { ...probeManifest, name: 'nuova', table: 'sonde_rows' }, 'nuova', '0.0.1', /one table, one bundle/i],
    // The registry covers foreign dirs too: same source of truth, no second path.
    ['cross-bundle table from a foreign dir', { ...probeManifest, name: 'nuova', table: 'intrusa_rows' }, 'nuova', '0.0.1', /one table, one bundle/i],
    // A new version of the SAME bundle reuses its name AND its table
    // (versions are immutable: 0.0.1 stays, 0.0.2 plans beside it).
    ['same bundle new version reuses name and table', owner, 'sonde', '0.0.2', null],
    // Control: a fresh bundle with its own name and table plans cleanly.
    ['fresh bundle plans cleanly', { ...probeManifest, name: 'nuova', table: 'nuova_rows' }, 'nuova', '0.0.1', null],
  ];
  for (const [label, manifest, bundleName, bundleVersion, expected] of cases) {
    if (expected === null) {
      planBundleCreate({ manifest, name: bundleName, version: bundleVersion, createdBy: 'ai', rootDir: root });
    } else {
      assert.throws(
        () => planBundleCreate({ manifest, name: bundleName, version: bundleVersion, createdBy: 'ai', rootDir: root }),
        expected,
        label,
      );
    }
  }
});

test('verifyBundle boots the target tree kernel, never the CLI checkout', async (t) => {
  // P2 bundle-manager.js:731: verifyBundle loaded the bundle from rootDir but
  // the app kernel always from the CLI checkout, so `bundle verify --root`
  // proved a composition that is not the target tree.
  const { applyBundleCreate, verifyBundle } = await import('../packages/cli/src/bundle-manager.js');

  // A --root without the app kernel is refused loudly instead of verifying
  // against the wrong composition.
  const bare = mkdtempSync(join(tmpdir(), 'accordo-bundle-nokernel-'));
  t.after(() => rmSync(bare, { recursive: true, force: true }));
  cpSync(join(repoRoot, 'packages', 'core'), join(bare, 'packages', 'core'), { recursive: true });
  const barePlan = planBundleCreate({ manifest: probeManifest, name: 'lifecycle-probe', version: '0.0.1', createdBy: 'ai', rootDir: bare });
  applyBundleCreate(barePlan);
  await assert.rejects(
    verifyBundle({ name: 'lifecycle-probe', version: '0.0.1', rootDir: bare }),
    /no app kernel.*--root must point at the project checkout/,
    'a --root without packages/app is refused, never verified against the CLI checkout',
  );

  // A --root WITH a kernel boots that kernel: poison the target tree's app
  // entry and prove the poison — not the CLI checkout's healthy kernel —
  // is what verify loads.
  const other = createProjectCopy(t);
  const otherPlan = planBundleCreate({ manifest: probeManifest, name: 'lifecycle-probe', version: '0.0.1', createdBy: 'ai', rootDir: other });
  applyBundleCreate(otherPlan);
  writeFileSync(join(other, 'packages', 'app', 'src', 'index.js'), 'throw new Error(\'target-kernel-marker\');\n', 'utf8');
  await assert.rejects(
    verifyBundle({ name: 'lifecycle-probe', version: '0.0.1', rootDir: other }),
    /target-kernel-marker/,
    'verify loads the app kernel from --root, not from the CLI checkout',
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

test('bundle create --apply is atomic: a second-phase collision leaves no half-bundle', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'accordo-bundle-atomic-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const copy = await import('../packages/cli/src/bundle-manager.js');

  // The bundle-local test file already exists (an interrupted apply, a disk
  // that filled mid-write): the second phase must refuse…
  const stray = join(root, 'bundles', 'lifecycle-probe', '0.0.1', 'tests', 'lifecycle-probe-bundle.test.js');
  mkdirSync(dirname(stray), { recursive: true });
  writeFileSync(stray, '// stray file from an interrupted apply\n', 'utf8');

  const plan = copy.planBundleCreate({ manifest: probeManifest, name: 'lifecycle-probe', version: '0.0.1', createdBy: 'ai', rootDir: root });
  assert.throws(() => copy.applyBundleCreate(plan), /already exists|refusing to overwrite/i);

  // …and NOTHING else may remain: no bundle.json, no module sources, no
  // orphan module that scanBundleModules would see and that would block a
  // retry or another bundle claiming the name.
  const versionDir = join(root, 'bundles', 'lifecycle-probe', '0.0.1');
  assert.ok(!existsSync(join(versionDir, 'bundle.json')), 'no half-bundle manifest remains');
  assert.ok(!existsSync(join(versionDir, 'module.manifest.json')), 'no half-bundle module manifest remains');
  assert.ok(!existsSync(join(versionDir, 'module.state.json')), 'no half-bundle module state remains');
  assert.ok(!existsSync(join(versionDir, 'src')), 'no half-bundle sources remain');
  assert.deepEqual(copy.scanBundleModules(root), [], 'no orphan module blocks other bundles');
  // The stray file itself is untouched: it is not ours to delete.
  assert.equal(readFileSync(stray, 'utf8'), '// stray file from an interrupted apply\n');
  // A retry after removing the stray file succeeds: no stale state blocks it.
  rmSync(stray);
  const retry = copy.applyBundleCreate(
    copy.planBundleCreate({ manifest: probeManifest, name: 'lifecycle-probe', version: '0.0.1', createdBy: 'ai', rootDir: root }),
  );
  assert.equal(retry.bundle, 'lifecycle-probe');
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
    if (table === 'module_migrations') continue; // checked below: the uninstall forgets exactly the bundle's rows
    assert.ok(table in after, `kernel table ${table} survives the uninstall`);
    assert.equal(after[table], snapshot[table], `kernel table ${table} keeps its rows`);
  }
  assert.equal(
    after.module_migrations,
    snapshot.module_migrations - entries[0].migrations.length,
    'uninstall forgets exactly the bundle ledger rows (reinstall re-applies the CREATE)',
  );
  assert.equal(reopened.services.contacts.get(contact.id).id, contact.id);
  assert.equal(reopened.services.opportunities.get(opportunity.id).id, opportunity.id);
  assert.equal(reopened.modules.get('appointment').service.get(appointment.id).id, appointment.id);
  assert.deepEqual(copy.listBundles({ rootDir: root }).bundles.map((entry) => entry.installed), [false]);

  // Reinstall the SAME version on the SAME file: the uninstall dropped the
  // bundle's ledger rows with its tables, so the CREATE re-applies and the
  // bundle serves again — never a boot with the service registered but the
  // table missing ("no such table" on the first create/list).
  const reinstalled = await copy.installBundle({ name: 'lifecycle-probe', version: '0.0.1', rootDir: root });
  assert.deepEqual(reinstalled.installed, [{ name: 'lifecycle-probe', version: '0.0.1' }]);
  const reentries = await copy.createBundleEntries({ rootDir: root, bundles: [{ name: 'lifecycle-probe', version: '0.0.1' }] });
  const rebooted = createCopyApp({ dbPath, bundles: reentries });
  t.after(() => rebooted.close());
  const again = await rebooted.modules.get('lifecycle-probe').service.create({ label: 'kpi dopo reinstall', count: 1 }, { actor: ACTOR });
  assert.ok(typeof again.id === 'string' && again.id !== '', 'the reinstalled bundle serves a real record');
  assert.equal(rebooted.modules.get('lifecycle-probe').service.list().length, 1);
  assert.equal(rebooted.services.contacts.get(contact.id).id, contact.id, 'kernel rows survive the reinstall');
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
