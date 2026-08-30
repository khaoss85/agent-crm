// @ts-check

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createAccordoAppAsync } from '../packages/app/src/index.js';
import { bootstrapPostgresqlApplication } from '../packages/core/src/postgresql-bootstrap.js';
import { assertIdentityTenant } from '../packages/core/src/tenant-binding.js';
import { POSTGRES_SCHEMA_NAME } from '../packages/core/src/physical-name.js';
import { probePostgresqlQueryDeadline } from '../packages/core/src/postgresql-storage.js';
import { NotFoundError } from '../packages/core/src/errors.js';
import { createTestVerifier, testResource } from './helpers/identity-verifier-fixture.mjs';
import {
  assertNoSecrets,
  bootPostgresqlApp,
  GADGET_MIGRATION,
  openIsolatedPostgresqlPlanes,
} from './helpers/postgresql-application.js';
import { PG_TEST_URL } from './helpers/storage-contract-cases.js';

const { Client } = pg;
const here = dirname(fileURLToPath(import.meta.url));
const actor = { type: 'system', id: 'm4b' };

const PROBE_GRAPH = Object.freeze({
  packageContract: 2,
  packages: [{
    packageContract: 2,
    name: 'probe-domain',
    version: 1,
    label: 'probe-domain',
    actions: [{
      module: 'opportunity',
      name: 'probe-tag',
      actionContract: 2,
      execute: async (ctx) => ({ id: ctx.record.id, tagged: true }),
    }],
    operations: [],
    capabilities: [],
  }],
  actions: [],
  modules: ['opportunity'],
});

function postgresOptions({ control, data, tenantId, identityVerifier, extra = {} }) {
  return {
    adapter: 'postgresql',
    testHarness: { loopback: true, control, data, ...extra.testHarness },
    spine: { mode: 'local-development', tenant: { id: tenantId } },
    identityVerifier: identityVerifier ?? createTestVerifier({ tenantId }),
    moduleMigrations: extra.moduleMigrations ?? [],
    now: extra.now,
    leaseTtlMs: extra.leaseTtlMs,
    queryDeadlineMs: extra.queryDeadlineMs,
    rebind: extra.rebind,
    promoteClone: extra.promoteClone,
    selected: extra.selected,
  };
}

async function openClient(endpoint) {
  const client = new Client({
    host: endpoint.host,
    port: endpoint.port,
    database: endpoint.database,
    user: endpoint.user,
    password: endpoint.password,
    connectionTimeoutMillis: 2000,
  });
  await client.connect();
  return client;
}

async function qualifiedExists(endpoint, qualifiedName) {
  const client = await openClient(endpoint);
  try {
    const result = await client.query('SELECT to_regclass($1) AS name', [qualifiedName]);
    return result.rows[0].name;
  } finally {
    await client.end();
  }
}

function secretsOf(planes, extras = []) {
  return [
    planes.control.database,
    planes.data.database,
    ...(planes.dataPlanes ?? []).map((plane) => plane.database),
    planes.control.password,
    PG_TEST_URL,
    'SUPERSECRET_SENTINEL_PASSWORD',
    'password=',
    ...extras,
  ].filter((value) => typeof value === 'string' && value.length > 3);
}

test('assertIdentityTenant is 404-before-403 and names no tenant', () => {
  assert.doesNotThrow(() => assertIdentityTenant({ organizationId: 'alpha' }, 'alpha'));
  assert.throws(
    () => assertIdentityTenant({ organizationId: 'bravo' }, 'alpha'),
    (error) => {
      assert.equal(error instanceof NotFoundError, true);
      assert.equal(error.status, 404);
      assert.equal(error.code, 'NOT_FOUND');
      assert.equal(error.message.includes('bravo'), false);
      assert.equal(error.message.includes('alpha'), false);
      return true;
    },
  );
  assert.throws(
    () => assertIdentityTenant({ organizationId: '' }, 'alpha'),
    (error) => error.status === 401 && error.code === 'SPINE_TENANT_REQUIRED',
  );
});

test('requested rebind and clone promotion refuse before connect', async () => {
  const dummyA = {
    host: '127.0.0.1', port: 1, database: 'accordo_a', user: 'pg-user',
    password: 'SUPERSECRET_SENTINEL_PASSWORD',
  };
  const dummyB = { ...dummyA, database: 'accordo_b' };
  await assert.rejects(
    () => createAccordoAppAsync(postgresOptions({
      control: dummyA, data: dummyB, tenantId: 'acme', extra: { rebind: true },
    })),
    (error) => {
      assert.equal(error.code, 'TENANT_REBIND_REFUSED');
      assert.equal(JSON.stringify(error).includes('SUPERSECRET_SENTINEL_PASSWORD'), false);
      assert.equal(error.message.includes('pg-user'), false);
      return true;
    },
  );
  await assert.rejects(
    () => createAccordoAppAsync(postgresOptions({
      control: dummyA, data: dummyB, tenantId: 'acme', extra: { promoteClone: true },
    })),
    (error) => error.code === 'TENANT_REBIND_REFUSED',
  );
});

test('startup uses transaction advisory locks, never session locks', () => {
  const src = readFileSync(join(here, '../packages/core/src/postgresql-bootstrap.js'), 'utf8');
  assert.equal(src.includes('pg_advisory_xact_lock'), true);
  assert.equal(src.includes('pg_advisory_lock('), false);
  assert.equal(src.includes('pg_advisory_lock('), false);
  assert.equal(/pg_try_advisory_lock|pg_advisory_lock\s*\(/.test(src), false);
});

describe('M4B PostgreSQL leases and tenant authority', { concurrency: 1 }, () => {
  test('two tenants, two databases, cross-tenant 404-before-403', { timeout: 90_000 }, async (t) => {
    const planes = await openIsolatedPostgresqlPlanes(t, { dataCount: 2 });
    if (!planes) return;
    const alpha = await bootPostgresqlApp(t, {
      planes,
      tenantId: 'alpha',
      data: planes.dataPlanes[0],
      moduleMigrations: [],
      selected: PROBE_GRAPH,
    });
    const bravo = await bootPostgresqlApp(t, {
      planes,
      tenantId: 'bravo',
      data: planes.dataPlanes[1],
      moduleMigrations: [],
      selected: PROBE_GRAPH,
    });
    if (!alpha || !bravo) return;

    const company = await alpha.app.services.companies.create({ name: 'Alpha Confidential' }, { actor });
    const bravoCompanies = await Promise.resolve(bravo.app.services.companies.list());
    assert.equal(bravoCompanies.some((row) => row.name === 'Alpha Confidential'), false);
    await assert.rejects(
      () => bravo.app.services.companies.get(company.id),
      (error) => error.status === 404 && error.code === 'NOT_FOUND',
    );

    const bravoOwn = await bravo.app.services.companies.create({ name: 'Bravo Public' }, { actor });
    const alphaList = await Promise.resolve(alpha.app.services.companies.list());
    assert.equal(alphaList.some((row) => row.id === bravoOwn.id), false);

    const alphaAudit = await Promise.resolve(alpha.app.audit.list({ entityType: 'company', entityId: company.id }));
    assert.ok(alphaAudit.some((entry) => entry.action === 'company.created'));
    const bravoAudit = await Promise.resolve(bravo.app.audit.list());
    assert.equal(bravoAudit.some((entry) => entry.entityId === company.id || entry.action === 'company.created' && String(entry.data?.name ?? '').includes('Alpha')), false);

    const contact = await alpha.app.services.contacts.create({
      companyId: company.id, firstName: 'Ada', lastName: 'Lovelace', email: 'ada@alpha.test',
    }, { actor });
    const opportunity = await alpha.app.services.opportunities.create({
      companyId: company.id, contactId: contact.id, name: 'Secret deal', valueCents: 1000, owner: 'ada',
    }, { actor });
    const workflow = await alpha.app.workflows.run('request-opportunity-stage-change', {
      opportunityId: opportunity.id, targetStage: 'proposal',
    }, { actor });
    assert.equal(workflow.status, 'completed');
    const bravoRuns = await Promise.resolve(bravo.app.workflows.listRuns());
    assert.equal((bravoRuns ?? []).some((run) => run.id === workflow.runId || run.runId === workflow.runId), false);

    await assert.rejects(
      () => alpha.app.runAction({
        module: 'opportunity',
        action: 'probe-tag',
        recordId: opportunity.id,
        actor,
        identity: { organizationId: 'bravo' },
      }),
      (error) => {
        assert.equal(error.status, 404);
        assert.equal(error.code, 'NOT_FOUND');
        const blob = `${error.message}\n${JSON.stringify(error)}`;
        assert.equal(blob.includes('bravo'), false);
        assert.equal(blob.includes('alpha'), false);
        assert.equal(error.status === 403, false);
        return true;
      },
    );

    const tagged = await alpha.app.runAction({
      module: 'opportunity',
      action: 'probe-tag',
      recordId: opportunity.id,
      actor,
      identity: { organizationId: 'alpha' },
    });
    assert.equal((tagged.result ?? tagged).tagged, true);

    const health = alpha.app.health();
    assert.equal(health.ok, true);
    assert.equal(health.ready, true);
    assert.equal(health.reason, undefined);
    assertNoSecrets(alpha.app, secretsOf(planes));
    assertNoSecrets(health, secretsOf(planes));
    assertNoSecrets(alpha.app.tenantBinding, secretsOf(planes));
    assert.equal(alpha.app.tenantBinding.dataPlaneIsolation, 'dedicated_database');
    assert.equal('generation' in health, false);
    assert.equal('expiresAt' in health, false);
  });

  test('claimed-database mismatch refuses before DDL', { timeout: 90_000 }, async (t) => {
    const planes = await openIsolatedPostgresqlPlanes(t);
    if (!planes) return;
    const first = await bootPostgresqlApp(t, {
      planes,
      tenantId: 'acme',
      moduleMigrations: [],
    });
    if (!first) return;
    await first.app.services.companies.create({ name: 'Acme Co' }, { actor });

    await assert.rejects(
      () => createAccordoAppAsync(postgresOptions({
        control: planes.control,
        data: planes.data,
        tenantId: 'beta',
        extra: { moduleMigrations: [GADGET_MIGRATION] },
      })),
      (error) => {
        assert.equal(error.code, 'TENANT_BINDING_MISMATCH');
        const blob = `${error.message}\n${JSON.stringify(error)}`;
        assert.equal(blob.includes('acme'), false);
        assert.equal(blob.includes('beta'), false);
        assert.equal(blob.includes(planes.data.database), false);
        return true;
      },
    );

    assert.equal(await qualifiedExists(planes.data, `${POSTGRES_SCHEMA_NAME}.gadgets`), null);
    const client = await openClient(planes.data);
    try {
      await client.query('SET search_path TO public, pg_temp');
      const companies = await client.query(`SELECT name FROM ${POSTGRES_SCHEMA_NAME}.companies`);
      assert.equal(companies.rows.some((row) => row.name === 'Acme Co'), true);
      assert.equal(companies.rows.length, 1);
    } finally {
      await client.end();
    }
  });

  test('first-claim race: one winner, loser does not mix schema', { timeout: 120_000 }, async (t) => {
    const planes = await openIsolatedPostgresqlPlanes(t);
    if (!planes) return;
    const results = await Promise.allSettled([
      createAccordoAppAsync(postgresOptions({
        control: planes.control, data: planes.data, tenantId: 'acme',
      })),
      createAccordoAppAsync(postgresOptions({
        control: planes.control, data: planes.data, tenantId: 'beta',
      })),
    ]);
    const winners = results.filter((result) => result.status === 'fulfilled');
    const losers = results.filter((result) => result.status === 'rejected');
    assert.equal(winners.length, 1, JSON.stringify(results.map((result) => result.status === 'rejected' ? result.reason?.code : 'ok')));
    assert.equal(losers.length, 1);
    assert.equal(losers[0].reason.code, 'TENANT_BINDING_MISMATCH');
    const app = winners[0].value;
    t.after(() => app.close());
    await app.services.companies.create({ name: 'Winner Co' }, { actor });
    const listed = await Promise.resolve(app.services.companies.list());
    assert.equal(listed.length, 1);
    const client = await openClient(planes.data);
    try {
      const marker = await client.query(
        `SELECT tenant_slug FROM ${POSTGRES_SCHEMA_NAME}.spine_data_plane_binding WHERE singleton = 1`,
      );
      assert.equal(marker.rows.length, 1);
    } finally {
      await client.end();
    }
  });

  test('same-tenant two-database race: one binding, loser cannot migrate', { timeout: 120_000 }, async (t) => {
    const planes = await openIsolatedPostgresqlPlanes(t, { dataCount: 2 });
    if (!planes) return;
    const results = await Promise.allSettled([
      createAccordoAppAsync(postgresOptions({
        control: planes.control, data: planes.dataPlanes[0], tenantId: 'acme',
        extra: { moduleMigrations: [GADGET_MIGRATION] },
      })),
      createAccordoAppAsync(postgresOptions({
        control: planes.control, data: planes.dataPlanes[1], tenantId: 'acme',
        extra: { moduleMigrations: [GADGET_MIGRATION] },
      })),
    ]);
    const winners = results.filter((result) => result.status === 'fulfilled');
    const losers = results.filter((result) => result.status === 'rejected');
    assert.equal(winners.length, 1, JSON.stringify(results.map((result) => result.status === 'rejected' ? result.reason?.code : 'ok')));
    assert.equal(losers.length, 1);
    assert.equal(losers[0].reason.code, 'TENANT_BINDING_MISMATCH');
    const app = winners[0].value;
    t.after(() => app.close());

    const winnerData = await qualifiedExists(planes.dataPlanes[0], `${POSTGRES_SCHEMA_NAME}.gadgets`)
      ? planes.dataPlanes[0]
      : planes.dataPlanes[1];
    const loserData = winnerData === planes.dataPlanes[0] ? planes.dataPlanes[1] : planes.dataPlanes[0];
    assert.ok(await qualifiedExists(winnerData, `${POSTGRES_SCHEMA_NAME}.gadgets`));
    assert.equal(await qualifiedExists(loserData, `${POSTGRES_SCHEMA_NAME}.companies`), null);
    assert.equal(await qualifiedExists(loserData, `${POSTGRES_SCHEMA_NAME}.gadgets`), null);
    assert.equal(await qualifiedExists(loserData, `${POSTGRES_SCHEMA_NAME}.schema_migrations`), null);
  });

  test('lease expiry does not auto-promote a clone', { timeout: 90_000 }, async (t) => {
    const planes = await openIsolatedPostgresqlPlanes(t);
    if (!planes) return;
    let current = 1_700_000_000_000;
    const original = await bootPostgresqlApp(t, {
      planes,
      tenantId: 'acme',
      moduleMigrations: [],
      now: () => current,
      leaseTtlMs: 5_000,
      identityVerifier: createTestVerifier({ tenantId: 'acme', dataResource: testResource('original') }),
    });
    if (!original) return;
    const live = original.app.health();
    assert.equal(live.ok, true);
    assert.equal(live.ready, true);
    await original.app.services.companies.create({ name: 'Original Co' }, { actor });

    current += 6_000;
    const expired = original.app.health();
    assert.equal(expired.ok, true, 'liveness remains true after lease expiry');
    assert.equal(expired.ready, false);
    assert.equal(expired.reason, 'WRITER_LEASE_EXPIRED');
    assert.equal('generation' in expired, false);
    assertNoSecrets(expired, secretsOf(planes, ['original', 'clone']));

    await assert.rejects(
      () => createAccordoAppAsync(postgresOptions({
        control: planes.control,
        data: planes.data,
        tenantId: 'acme',
        identityVerifier: createTestVerifier({ tenantId: 'acme', dataResource: testResource('clone') }),
        extra: { now: () => current, leaseTtlMs: 5_000, moduleMigrations: [GADGET_MIGRATION] },
      })),
      (error) => error.code === 'CLONE_PROMOTION_REFUSED',
    );

    assert.equal(original.app.health().ready, false);
    assert.equal(original.app.health().ok, true);
    await assert.rejects(
      () => original.app.services.companies.create({ name: 'After Expiry' }, { actor }),
      (error) => error.code === 'WRITER_LEASE_EXPIRED',
    );
    assert.equal(await qualifiedExists(planes.data, `${POSTGRES_SCHEMA_NAME}.gadgets`), null);
  });

  test('close fences writes and reports not-ready before releasing the lease', { timeout: 90_000 }, async (t) => {
    const planes = await openIsolatedPostgresqlPlanes(t);
    if (!planes) return;
    const first = await bootPostgresqlApp(t, {
      planes,
      tenantId: 'acme',
      moduleMigrations: [],
    });
    if (!first) return;
    await first.app.close();
    const closed = first.app.health();
    assert.equal(closed.ok, true);
    assert.equal(closed.ready, false);
    assert.equal(closed.reason, 'WRITER_LEASE_RELEASED');
    await assert.rejects(
      () => first.app.services.companies.create({ name: 'After Close' }, { actor }),
      (error) => error.code === 'WRITER_LEASE_RELEASED' || error.code === 'WRITER_LEASE_EXPIRED',
    );
  });

  test('unexpired writer lease refuses a second same-resource instance', { timeout: 90_000 }, async (t) => {
    const planes = await openIsolatedPostgresqlPlanes(t);
    if (!planes) return;
    const first = await bootPostgresqlApp(t, {
      planes,
      tenantId: 'acme',
      moduleMigrations: [],
    });
    if (!first) return;
    await assert.rejects(
      () => createAccordoAppAsync(postgresOptions({
        control: planes.control, data: planes.data, tenantId: 'acme',
        extra: { moduleMigrations: [GADGET_MIGRATION] },
      })),
      (error) => error.code === 'WRITER_LEASE_HELD',
    );
    assert.equal(await qualifiedExists(planes.data, `${POSTGRES_SCHEMA_NAME}.gadgets`), null);
  });

  test('caller search_path is ignored as isolation input', { timeout: 90_000 }, async (t) => {
    const planes = await openIsolatedPostgresqlPlanes(t);
    if (!planes) return;
    const hostile = {
      ...planes.data,
      searchPath: 'public,pg_temp',
      options: '-c search_path=public',
    };
    const app = await createAccordoAppAsync(postgresOptions({
      control: planes.control,
      data: hostile,
      tenantId: 'acme',
    }));
    t.after(() => app.close());
    await app.services.companies.create({ name: 'Path Co' }, { actor });
    const client = await openClient(planes.data);
    try {
      await client.query('SET search_path TO public, pg_temp');
      const marker = await client.query(
        `SELECT tenant_slug FROM ${POSTGRES_SCHEMA_NAME}.spine_data_plane_binding WHERE singleton = 1`,
      );
      assert.equal(marker.rows.length, 1);
      await assert.rejects(client.query('SELECT name FROM companies'));
    } finally {
      await client.end();
    }
  });

  test('destroyed black-hole client does not poison the pool', { timeout: 60_000 }, async (t) => {
    const planes = await openIsolatedPostgresqlPlanes(t);
    if (!planes) return;
    const bootstrap = await bootstrapPostgresqlApplication({
      control: { ...planes.control, ssl: false },
      data: { ...planes.data, ssl: false },
      tenantId: 'acme',
      identityVerifier: createTestVerifier({ tenantId: 'acme' }),
      queryDeadlineMs: 80,
    });
    t.after(() => bootstrap.close());
    await assert.rejects(
      () => probePostgresqlQueryDeadline(bootstrap.dataStorage, 2),
      (error) => {
        assert.equal(error.code, 'STORAGE_TIMEOUT');
        assertNoSecrets(error, secretsOf(planes));
        return true;
      },
    );
    const counted = await bootstrap.dataStorage.maybeOne({ kind: 'count', table: 'companies' });
    assert.equal(Number(counted?.n ?? 0), 0);
    await bootstrap.dataStorage.execute({
      kind: 'insert',
      table: 'companies',
      values: [
        { column: 'id', value: 'after-timeout' },
        { column: 'name', value: 'Alive' },
        { column: 'domain', value: null },
        { column: 'created_at', value: '2026-01-01T00:00:00.000Z' },
        { column: 'updated_at', value: '2026-01-01T00:00:00.000Z' },
      ],
    });
    const row = await bootstrap.dataStorage.maybeOne({
      kind: 'select',
      table: 'companies',
      columns: ['name'],
      where: [{ column: 'id', op: 'eq', value: 'after-timeout' }],
    });
    assert.equal(row?.name, 'Alive');
    assert.equal(bootstrap.health().ok, true);
    assert.equal(bootstrap.health().ready, true);
    assertNoSecrets(bootstrap.health(), secretsOf(planes));
    assertNoSecrets({ tenantBinding: { adapter: 'postgresql' }, writerLease: bootstrap.writerLease }, secretsOf(planes));
  });
});
