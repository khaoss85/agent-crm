// @ts-check

/**
 * Selected record modules on real PostgreSQL (M2).
 *
 * Same seam as the SQLite suite, executed where `storage.sync` is absent:
 * the manifest DDL is the PostgreSQL rendering computed from the manifest,
 * reads settle through the async handle, and writes run inside affine
 * transactions with the audit row in the same unit.
 *
 * Skips cleanly without a database (the helper returns null); set
 * ACCORDO_PG_TEST_URL at a real PostgreSQL 16 to execute.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const { bootPostgresqlApp } = await import('./helpers/postgresql-application.js');

function loadManifest(packageName, recordName) {
  const path = join(HERE, '..', 'packages', packageName, 'modules', `${recordName}.module.json`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function syntheticManifest() {
  return {
    manifestVersion: 1,
    name: 'port-pg-widget',
    description: 'M2 probe on PostgreSQL: public, managed and boolean fields.',
    table: 'port_test_pg_widgets',
    fields: [
      { name: 'title', type: 'string' },
      { name: 'flag', type: 'boolean' },
      { name: 'status', type: 'enum', values: ['new', 'done'], writable: 'managed' },
    ],
  };
}

function selected(modules) {
  return { packageContract: 2, packages: [], actions: [], modules };
}

test('a manifest-selected record migrates and runs on PostgreSQL', { timeout: 120_000 }, async (t) => {
  const booted = await bootPostgresqlApp(t, {
    selected: selected([
      { name: 'canonical-link', manifest: loadManifest('customer-data', 'canonical-link') },
      { name: 'port-pg-widget', manifest: syntheticManifest() },
    ]),
  });
  if (!booted) return;
  const { app } = booted;

  const names = app.modules.list().map((module) => module.name);
  assert.ok(names.includes('canonical-link'), 'the package record is registered on PostgreSQL');
  assert.ok(names.includes('port-pg-widget'), 'the synthetic record is registered on PostgreSQL');

  const links = app.modules.get('canonical-link').service;
  const created = await links.createManaged({
    sourceKey: 'pg:X1',
    clusterKey: 'pg-cluster-1',
    subjectResource: 'contact',
    subjectId: 'contact-9',
    subjectOwner: 'host',
    subjectOwnerPackage: 'accordo',
    subjectLabel: 'PG Proof',
    role: 'canonical',
    decisionId: 'decision-pg-1',
    reason: 'same email',
    decidedByType: 'user',
    decidedById: 'operator-1',
    decidedAt: '2026-09-09T10:00:00.000Z',
    status: 'active',
    withdrawnReason: null,
    withdrawnAt: null,
  }, { actor: { type: 'user', id: 'operator-1' } });
  assert.equal((await links.get(created.id)).clusterKey, 'pg-cluster-1');
  assert.equal((await links.listWhere({ subjectId: 'contact-9' })).length, 1);
  assert.equal(await links.countWhere({ subjectId: 'contact-9' }), 1);

  const widgets = app.modules.get('port-pg-widget').service;
  const widget = await widgets.create({ title: 'pg first', flag: true });
  assert.equal(widget.flag, true);
  assert.equal((await widgets.get(widget.id)).flag, true);
  assert.equal((await widgets.listWhere({ flag: true })).length, 1);
  const updated = await widgets.update(widget.id, { flag: false });
  assert.equal(updated.flag, false);
  const applied = await widgets.applyManaged(widget.id, { status: 'done' });
  assert.equal(applied.status, 'done');

  const trails = await app.audit.list({ entityType: 'canonical-link', entityId: created.id });
  assert.ok(trails.some((entry) => entry.action === 'canonical-link.created'), 'audit trail on PostgreSQL');

  const replay = await links.createManaged({
    sourceKey: 'pg:X1', clusterKey: 'pg-cluster-1', subjectResource: 'contact', subjectId: 'contact-9',
    subjectOwner: 'host', subjectOwnerPackage: 'accordo', subjectLabel: 'PG Proof', role: 'canonical',
    decisionId: 'decision-pg-1', reason: 'same email', decidedByType: 'user', decidedById: 'operator-1',
    decidedAt: '2026-09-09T10:00:00.000Z', status: 'active', withdrawnReason: null, withdrawnAt: null,
  }, { actor: { type: 'user', id: 'operator-1' } }).then(() => null, (error) => error);
  assert.ok(replay, 'a duplicate unique key refuses on PostgreSQL');
  assert.equal(replay.code, 'CONFLICT');
});

function packageManifests(packageName) {
  const dir = join(HERE, '..', 'packages', packageName, 'modules');
  return readdirSync(dir)
    .filter((file) => file.endsWith('.module.json'))
    .map((file) => {
      const manifest = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      return { name: manifest.name, manifest };
    });
}

test('package operations and the customer profile run on PostgreSQL', { timeout: 120_000 }, async (t) => {
  const customerData = await import('../packages/customer-data/src/index.js');
  const work = await import('../packages/work/src/index.js');
  const intelligence = await import('../packages/intelligence/src/index.js');
  const records = [
    ...packageManifests('customer-data'),
    ...packageManifests('work'),
    ...packageManifests('intelligence'),
  ];
  const booted = await bootPostgresqlApp(t, {
    selected: {
      packageContract: 2,
      packages: [
        customerData.createCustomerDataPackageV2(),
        work.createWorkPackageV2(),
        intelligence.createIntelligenceDomainV2(),
      ],
      actions: [],
      modules: [...records, 'lead'],
    },
  });
  if (!booted) return;
  const { app } = booted;

  const applied = await app.operations.run('apply-customer-import', {
    system: 'owner-csv',
    rows: [{ externalId: 'PG1', email: 'pg@acme.example', firstName: 'P', lastName: 'G' }],
    acceptance: 'partial',
  });
  assert.equal(applied.mode, 'apply');
  assert.ok(applied.runId);

  const company = await app.services.companies.create({ name: 'Acme PG' });
  const contact = await app.services.contacts.create({
    companyId: company.id, firstName: 'P', lastName: 'G', email: 'boss@pg.example',
  });
  const profile = await app.operations.run('read-customer-profile', { resource: 'contact', id: contact.id });
  assert.equal(profile.customerProfileContract, 1);
  assert.equal(profile.subject.id, contact.id);
});
