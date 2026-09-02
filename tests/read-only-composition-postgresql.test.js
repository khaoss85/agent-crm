import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

import { bootPostgresqlApp, bootPostgresqlReader, GADGET_MIGRATION } from './helpers/postgresql-application.js';
import { createAccordoAppAsync } from '../packages/app/src/index.js';

const { Client } = pg;

/**
 * The composition a managed pilot's Web Admin runs on: a human can see the
 * customer and the review, and the process cannot write.
 *
 * These run against a real database because the two properties that matter are
 * about what is *absent* from a live process — no lease taken, no migration
 * applied, no audit row — and absence is only provable against something that
 * would have recorded the presence.
 */

async function connectTo(plane) {
  const client = new Client({
    host: plane.host, port: plane.port, user: plane.user, password: plane.password,
    database: plane.database, connectionTimeoutMillis: 2000,
  });
  await client.connect();
  return client;
}

async function snapshotDataPlane(plane) {
  const client = await connectTo(plane);
  try {
    const audit = await client.query('SELECT count(*)::int AS n FROM "accordo"."startup_audit"');
    const ledger = await client.query('SELECT version, checksum FROM "accordo"."schema_migrations" ORDER BY version');
    const modules = await client.query('SELECT name, checksum FROM "accordo"."module_migrations" ORDER BY name');
    return {
      startupAudit: audit.rows[0].n,
      ledger: ledger.rows.map((row) => `${row.version}:${row.checksum}`).join(','),
      modules: modules.rows.map((row) => `${row.name}:${row.checksum}`).join(','),
    };
  } finally {
    await client.end();
  }
}

test('a reader composes over a live data plane and reads while the writer still holds the lease', async (t) => {
  const booted = await bootPostgresqlApp(t);
  if (!booted) return;
  await booted.app.services.companies.create({ name: 'Northwind' });

  // The writer is not closed. This is the pilot's real shape: a worker holding
  // the lease and a web process reading the same data plane beside it.
  const reader = await bootPostgresqlReader(t, { data: booted.data, tenantId: booted.tenantId });

  const companies = await reader.services.companies.list();
  assert.equal(companies.length, 1);
  assert.equal(companies[0].name, 'Northwind');
  assert.equal(reader.storage.mode, 'read-only');
});

test('composing a reader writes nothing: no audit row, no lease, ledger unchanged', async (t) => {
  const booted = await bootPostgresqlApp(t);
  if (!booted) return;
  const before = await snapshotDataPlane(booted.data);

  const reader = await bootPostgresqlReader(t, { data: booted.data, tenantId: booted.tenantId });
  await reader.services.companies.list();

  const after = await snapshotDataPlane(booted.data);
  assert.deepEqual(after, before, 'a reader that changed the data plane is not a reader');

  // The lease lives in the control plane, and the reader was handed no
  // credential for it. One row is the writer's, taken before the reader existed.
  const control = await connectTo(booted.planes.control);
  try {
    const leases = await control.query('SELECT count(*)::int AS n FROM "accordo"."spine_writer_leases"');
    assert.equal(leases.rows[0].n, 1, 'the reader must not have taken a second lease');
  } finally {
    await control.end();
  }
});

test('every mutation surface refuses, and the refusal is typed rather than an accident', async (t) => {
  const booted = await bootPostgresqlApp(t);
  if (!booted) return;
  const reader = await bootPostgresqlReader(t, { data: booted.data, tenantId: booted.tenantId });

  // A module service still carries its write methods. It is the storage seam
  // that refuses, before a statement is rendered.
  await assert.rejects(
    () => reader.services.companies.create({ name: 'Refused Ltd' }),
    (error) => error.code === 'STORAGE_READ_ONLY',
  );
  // `runAction` refuses in the facade: it is the entry point every application
  // shape has, and a missing key there would be a TypeError, not a boundary.
  await assert.rejects(
    async () => reader.runAction({ action: 'anything', input: {} }),
    (error) => error.code === 'READ_ONLY_COMPOSITION',
  );

  const after = await snapshotDataPlane(booted.data);
  const companies = await reader.services.companies.list();
  assert.equal(companies.length, 0, 'nothing was written by the refused calls');
  assert.equal(after.startupAudit, (await snapshotDataPlane(booted.data)).startupAudit);
});

test('the facade omits the keys that are purely write capability', async (t) => {
  const booted = await bootPostgresqlApp(t);
  if (!booted) return;
  const reader = await bootPostgresqlReader(t, { data: booted.data, tenantId: booted.tenantId });

  // Already conditional in the ordinary facade — an application that composes
  // no operations does not carry them either — so absence is what that shape
  // already means.
  for (const key of ['leaseRenewer', 'productionOperations']) {
    assert.equal(reader[key], undefined, `${key} is write capability and must not be exposed`);
  }
  // Always present, so they refuse instead of vanishing. A generic consumer
  // calls these without asking whether they exist — the framework's own HTTP
  // surface does exactly that — and a missing key there is a TypeError at the
  // call site rather than a boundary.
  for (const key of ['runAction', 'reconcileWrite', 'acknowledgeWrite']) {
    assert.equal(typeof reader[key], 'function', `${key} must be present so that it can refuse`);
    await assert.rejects(
      async () => reader[key]({}),
      (error) => error.code === 'READ_ONLY_COMPOSITION' && error.details?.surface === key,
      `${key} must refuse with a typed error, not a TypeError`,
    );
  }
  // Reads of the write-outcome ledger are still reads.
  assert.equal(typeof reader.lookupWrite, 'function');
  assert.equal(typeof reader.listUnacknowledgedWrites, 'function');
});

test('a data plane bound to another tenant is refused', async (t) => {
  const booted = await bootPostgresqlApp(t, { tenantId: 'acme' });
  if (!booted) return;

  await assert.rejects(
    () => bootPostgresqlReader(t, { data: booted.data, tenantId: 'globex' }),
    (error) => error.code === 'TENANT_BINDING_MISMATCH',
  );
});

/**
 * The cross-check the reader loses by holding no control-plane credential: the
 * writer compares the control mapping against the data marker and refuses on
 * disagreement. A reader sees one term, so the other has to be configured —
 * the shape #171 established for the pinned certificate.
 */
test('a pinned binding that the data plane does not present is refused', async (t) => {
  const booted = await bootPostgresqlApp(t);
  if (!booted) return;

  await assert.rejects(
    () => bootPostgresqlReader(t, {
      data: booted.data,
      tenantId: booted.tenantId,
      pinnedBindingUuid: '00000000-0000-4000-8000-000000000000',
    }),
    (error) => error.code === 'READER_BINDING_MISMATCH',
  );

  // And the matching pin composes, so the refusal above is about the value and
  // not about pinning being broken.
  const client = await connectTo(booted.data);
  let actual;
  try {
    const row = await client.query('SELECT data_plane_id FROM "accordo"."spine_data_plane_binding" WHERE singleton = 1');
    actual = row.rows[0].data_plane_id;
  } finally {
    await client.end();
  }
  const reader = await bootPostgresqlReader(t, {
    data: booted.data, tenantId: booted.tenantId, pinnedBindingUuid: actual,
  });
  assert.equal(reader.storage.mode, 'read-only');
});

/**
 * Version skew is not hypothetical here: the pilot pins its web service and its
 * worker to different refs, so a reader rendering migration set N against a
 * database left at N−1 is a shape this deployment can produce.
 */
test('a reader whose code renders a migration the data plane has not applied is refused', async (t) => {
  const booted = await bootPostgresqlApp(t);
  if (!booted) return;

  await assert.rejects(
    () => bootPostgresqlReader(t, {
      data: booted.data,
      tenantId: booted.tenantId,
      moduleMigrations: [GADGET_MIGRATION, {
        name: 'pg_reader_skew_probe',
        sql: 'CREATE TABLE IF NOT EXISTS "accordo"."widgets" (id TEXT PRIMARY KEY)',
      }],
    }),
    (error) => error.code === 'READER_SCHEMA_SKEW',
  );
});

test('the composition refuses the inputs that would make it a writer', async (t) => {
  const booted = await bootPostgresqlApp(t);
  if (!booted) return;

  const base = {
    adapter: 'postgresql',
    spine: { mode: 'local-development', tenant: { id: booted.tenantId } },
    moduleMigrations: [GADGET_MIGRATION],
  };
  const harness = { loopback: true, access: 'read-only', data: booted.data };

  await assert.rejects(
    () => createAccordoAppAsync({ ...base, testHarness: { ...harness, control: booted.planes.control } }),
    // Named as the caller wrote it. The harness channel calls it `control` and
    // the deployment channel calls it `controlPlane`; a refusal that reports
    // the other one sends the reader looking for a key they did not pass.
    (error) => error.code === 'READ_ONLY_COMPOSITION_REFUSED' && error.details?.option === 'control',
  );
  await assert.rejects(
    () => createAccordoAppAsync({ ...base, testHarness: harness, identityVerifier: { operations: {} } }),
    (error) => error.code === 'READ_ONLY_COMPOSITION_REFUSED' && error.details?.option === 'identityVerifier',
  );
  await assert.rejects(
    () => createAccordoAppAsync({ ...base, testHarness: harness, productionOperations: {} }),
    (error) => error.code === 'READ_ONLY_COMPOSITION_REFUSED' && error.details?.option === 'productionOperations',
  );
});

/**
 * The composition whose entire design is "refuse the inputs that would widen
 * this" must not be the one composition that accepts them silently. The
 * read-only carve returns early, so the globally unsupported options had to be
 * refused before it — otherwise the writer refuses `authorize` and `listen`
 * and the reader, of all things, does not.
 */
test('the reader refuses the globally unsupported options the writer refuses', async (t) => {
  const booted = await bootPostgresqlApp(t);
  if (!booted) return;

  const base = {
    adapter: 'postgresql',
    spine: { mode: 'local-development', tenant: { id: booted.tenantId } },
    testHarness: { loopback: true, access: 'read-only', data: booted.data },
    moduleMigrations: [GADGET_MIGRATION],
  };
  for (const key of ['authorize', 'security', 'openDatabase', 'listen', 'providers']) {
    await assert.rejects(
      () => createAccordoAppAsync({ ...base, [key]: {} }),
      (error) => error.code === 'PORTABLE_OPTION_UNSUPPORTED' && error.details?.option === key,
      `${key} must be refused by the read-only composition too`,
    );
  }
});

/**
 * The inertness twin, one level up from the storage test. A writer composed
 * beside all of this must be the application it was before any of it existed.
 */
test('a writer application is unchanged by the reader existing', async (t) => {
  const booted = await bootPostgresqlApp(t);
  if (!booted) return;
  const { app } = booted;

  assert.equal(app.storage.mode, undefined, 'a writer facade carries no mode key');
  assert.notEqual(app.leaseRenewer, undefined);
  assert.equal(typeof app.reconcileWrite, 'function');
  assert.equal(typeof app.acknowledgeWrite, 'function');
  const company = await app.services.companies.create({ name: 'Still Writing' });
  assert.ok(company.id);
});
