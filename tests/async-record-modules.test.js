// @ts-check

/**
 * Selected record modules in the async composition (M1: SQLite).
 *
 * A `{name, manifest}` entry in `selected.modules` registers a runtime
 * record module built from the manifest — with its migration applied — and
 * the module executes reads and managed writes on the composed storage.
 * Name strings keep their old meaning (action eligibility only) and still
 * register nothing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const { createAccordoAppAsync } = await import('../packages/app/src/index.js');

function loadManifest(packageName, recordName) {
  const path = join(HERE, '..', 'packages', packageName, 'modules', `${recordName}.module.json`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function syntheticManifest() {
  return {
    manifestVersion: 1,
    name: 'port-widget',
    description: 'M1 probe: one public field, one managed field.',
    table: 'port_test_widgets',
    fields: [
      { name: 'title', type: 'string' },
      { name: 'status', type: 'enum', values: ['new', 'done'], writable: 'managed' },
    ],
  };
}

/** @param {{after: (fn: () => void) => void}} t */
function scratchDir(t) {
  const directory = mkdtempSync(join(tmpdir(), 'accordo-record-modules-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('a manifest-selected record registers, migrates and runs managed writes', async (t) => {
  const app = await createAccordoAppAsync({
    dbPath: join(scratchDir(t), 'records.sqlite'),
    selected: {
      packageContract: 2,
      packages: [],
      actions: [],
      modules: [{ name: 'canonical-link', manifest: loadManifest('customer-data', 'canonical-link') }],
    },
  });
  t.after(() => app.close());

  const names = app.modules.list().map((module) => module.name);
  assert.ok(names.includes('canonical-link'), 'the selected record is a registered module');
  assert.ok(names.includes('company'), 'the kernel modules are still registered');

  const created = await app.modules.get('canonical-link').service.createManaged({
    sourceKey: 'owner-csv:X1',
    clusterKey: 'cluster-1',
    subjectResource: 'contact',
    subjectId: 'contact-1',
    subjectOwner: 'host',
    subjectOwnerPackage: 'accordo',
    subjectLabel: 'A B',
    role: 'canonical',
    decisionId: 'decision-1',
    reason: 'same email',
    decidedByType: 'user',
    decidedById: 'operator-1',
    decidedAt: '2026-09-09T10:00:00.000Z',
    status: 'active',
    withdrawnReason: null,
    withdrawnAt: null,
  }, { actor: { type: 'user', id: 'operator-1' } });
  assert.equal(created.sourceKey, 'owner-csv:X1');

  const read = await app.modules.get('canonical-link').service.get(created.id);
  assert.equal(read.clusterKey, 'cluster-1');

  const found = await app.modules.get('canonical-link').service.listWhere({ subjectId: 'contact-1' });
  assert.equal(found.length, 1);
  assert.equal(
    await app.modules.get('canonical-link').service.countWhere({ subjectId: 'contact-1' }),
    1,
  );

  const trails = await app.audit.list({ entityType: 'canonical-link', entityId: created.id });
  assert.ok(trails.length >= 1, 'the managed write left an audit trail');
  assert.equal(trails[0].action, 'canonical-link.created');
});

test('a mixed public/managed manifest runs create, update and applyManaged', async (t) => {
  const app = await createAccordoAppAsync({
    dbPath: join(scratchDir(t), 'mixed.sqlite'),
    selected: {
      packageContract: 2, packages: [], actions: [],
      modules: [{ name: 'port-widget', manifest: syntheticManifest() }],
    },
  });
  t.after(() => app.close());

  const service = app.modules.get('port-widget').service;
  const created = await service.create({ title: 'first' });
  assert.equal(created.title, 'first');
  assert.equal(created.status, null);

  await assert.rejects(
    () => service.create({ title: 'bad', status: 'new' }),
    /managed by a workflow action/,
    'public create refuses managed fields',
  );

  const updated = await service.update(created.id, { title: 'second' });
  assert.equal(updated.title, 'second');

  const applied = await service.applyManaged(created.id, { status: 'done' });
  assert.equal(applied.status, 'done');

  const page = await service.list({ limit: 10 });
  assert.equal(page.length, 1);
  assert.throws(() => service.listWhere({ ghost: 1 }), /Unknown filter field/);
  assert.throws(() => service.listWhere({ title: [] }), /must not be empty/);
});

test('selection mistakes fail closed at composition', async (t) => {
  const manifest = loadManifest('customer-data', 'canonical-link');
  const badSelections = [
    { label: 'non-object entry', modules: [42] },
    { label: 'name/manifest mismatch', modules: [{ name: 'other', manifest }] },
    {
      label: 'duplicate selection',
      modules: [{ name: 'canonical-link', manifest }, { name: 'canonical-link', manifest }],
    },
    {
      label: 'core table claim',
      modules: [{ name: 'port-widget', manifest: { ...syntheticManifest(), table: 'companies' } }],
    },
    {
      label: 'kernel name squat',
      modules: [{ name: 'company', manifest: { ...syntheticManifest(), name: 'company', table: 'port_test_squat' } }],
    },
  ];
  for (const { label, modules } of badSelections) {
    await assert.rejects(
      () => createAccordoAppAsync({
        dbPath: join(scratchDir(t), 'closed.sqlite'),
        selected: { packageContract: 2, packages: [], actions: [], modules },
      }),
      (error) => error.code === 'ValidationError' || error.code === 'ConflictError' || error.code === 'CONFLICT'
        || /reserved|must be|twice|agree|companies|already registered/.test(String(error.message)),
      `${label} refuses instead of composing half-working state`,
    );
  }
});

test('a name string still selects eligibility only, registering nothing', async (t) => {
  const app = await createAccordoAppAsync({
    dbPath: join(scratchDir(t), 'strings.sqlite'),
    selected: {
      packageContract: 2, packages: [], actions: [],
      modules: ['canonical-link'],
    },
  });
  t.after(() => app.close());

  assert.deepEqual(
    app.modules.list().map((module) => module.name).sort(),
    ['approval', 'company', 'contact', 'opportunity'],
    'strings keep their old meaning: no module is registered',
  );
});

