// @ts-check

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createAccordoApp, createAccordoAppAsync } from '../packages/app/src/index.js';
import {
  describeDeploymentStorage,
  loadDeploymentStorage,
} from '../packages/core/src/deployment-storage.js';
import { TENANT_BINDING_CONTRACT_V2 } from '../packages/core/src/tenant-binding.js';
import { POSTGRES_SCHEMA_NAME } from '../packages/core/src/physical-name.js';
import { createTestVerifier } from './helpers/identity-verifier-fixture.mjs';
import {
  assertNoSecrets,
  bootPostgresqlApp,
  GADGET_MIGRATION,
  openIsolatedPostgresqlPlanes,
} from './helpers/postgresql-application.js';
import { PG_TEST_URL } from './helpers/storage-contract-cases.js';

const { Client } = pg;
const here = dirname(fileURLToPath(import.meta.url));
const actor = { type: 'system', id: 'm3c' };

test('synchronous createAccordoApp stays SQLite-only', () => {
  const app = createAccordoApp({ dbPath: ':memory:' });
  try {
    assert.equal(app instanceof Promise, false);
    assert.deepEqual(app.services.companies.list(), []);
  } finally {
    app.close();
  }
});

test('incomplete PostgreSQL factory options refuse before connect', async () => {
  const sentinel = 'postgresql://pg-user:s3cret-unavailable@127.0.0.1:1/accordo';
  await assert.rejects(
    () => createAccordoAppAsync({ adapter: 'postgresql', connection: sentinel }),
    (error) => {
      assert.equal(error.code, 'PORTABLE_POSTGRESQL_BINDING_REQUIRED');
      const blob = `${error.message}\n${JSON.stringify(error)}`;
      assert.equal(blob.includes('s3cret-unavailable'), false);
      assert.equal(blob.includes('pg-user'), false);
      return true;
    },
  );
});

test('deployment loader returns a PostgreSQL selection without connecting', () => {
  const root = mkdtempSync(join(tmpdir(), 'accordo-m3c-loader-'));
  try {
    const configPath = join(root, 'deployment-storage.json');
    writeFileSync(configPath, `${JSON.stringify({
      contract: 1,
      adapter: 'postgresql',
      connection: {
        host: '127.0.0.1', port: 1, database: 'accordo', user: 'accordo',
        password: 'SUPERSECRET_SENTINEL_PASSWORD', sslmode: 'verify-full',
        tls: { enabled: true, verify: 'full', caFile: './tls/ca.pem', servername: 'db.example.test' },
      },
      controlPlane: {
        host: '127.0.0.1', port: 1, database: 'accordo_control', user: 'accordo',
        password: 'SUPERSECRET_SENTINEL_PASSWORD', sslmode: 'verify-full',
        tls: { enabled: true, verify: 'full', caFile: './tls/ca.pem', servername: 'db.example.test' },
      },
      spine: { mode: 'production', tenant: { id: 'acme' } },
      identityVerifier: './providers/identity-verifier.js',
    }, null, 2)}\n`);
    chmodSync(configPath, 0o600);
    const selected = loadDeploymentStorage({ configPath, env: {} });
    assert.equal(selected.adapter, 'postgresql');
    assert.deepEqual(describeDeploymentStorage(selected), { adapter: 'postgresql', available: true });
    assert.equal(JSON.stringify(describeDeploymentStorage(selected)).includes('SUPERSECRET'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('identical PostgreSQL endpoints refuse before connect', () => {
  const root = mkdtempSync(join(tmpdir(), 'accordo-m3c-alias-'));
  try {
    const configPath = join(root, 'deployment-storage.json');
    const endpoint = {
      host: '127.0.0.1', port: 1, database: 'accordo', user: 'accordo',
      password: 'SUPERSECRET_SENTINEL_PASSWORD', sslmode: 'verify-full',
      tls: { enabled: true, verify: 'full', caFile: './tls/ca.pem' },
    };
    writeFileSync(configPath, `${JSON.stringify({
      contract: 1,
      adapter: 'postgresql',
      connection: endpoint,
      controlPlane: endpoint,
      spine: { mode: 'production', tenant: { id: 'acme' } },
      identityVerifier: './providers/identity-verifier.js',
    }, null, 2)}\n`);
    chmodSync(configPath, 0o600);
    assert.throws(
      () => loadDeploymentStorage({ configPath, env: {} }),
      (error) => error.code === 'DEPLOYMENT_STORAGE_PLANES_ALIAS',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('M3C PostgreSQL application', { concurrency: 1 }, () => {
test('M3C PostgreSQL application boots, migrates and runs representative paths', { timeout: 60_000 }, async (t) => {
  const result = await bootPostgresqlApp(t, {
    moduleMigrations: [GADGET_MIGRATION],
  });
  if (!result) return;
  const { app, planes } = result;
  assert.equal(app.storage.adapter, 'postgresql');
  assert.equal(app.storage.available, true);
  assert.equal(app.tenantBinding.contract, TENANT_BINDING_CONTRACT_V2);
  assert.equal(app.tenantBinding.dataPlaneIsolation, 'dedicated_database');
  assert.equal(app.health().storage.adapter, 'postgresql');
  assertNoSecrets(app);

  const company = await app.services.companies.create({ name: 'Acme' }, { actor });
  assert.equal(company.name, 'Acme');
  const listed = await Promise.resolve(app.services.companies.list());
  assert.equal(listed.length, 1);
  const fetched = await Promise.resolve(app.services.companies.get(company.id));
  assert.equal(fetched.id, company.id);

  const contact = await app.services.contacts.create({
    companyId: company.id, firstName: 'Ada', lastName: 'Lovelace', email: 'ada@acme.test',
  }, { actor });
  const opportunity = await app.services.opportunities.create({
    companyId: company.id,
    contactId: contact.id,
    name: 'Renewal',
    valueCents: 6_000_000,
    owner: 'ada',
  }, { actor });
  const approval = await app.services.approvals.request({
    opportunityId: opportunity.id, reason: 'over threshold',
  }, { actor });
  assert.equal(approval.status, 'pending');

  const workflow = await app.workflows.run('request-opportunity-stage-change', {
    opportunityId: opportunity.id, targetStage: 'proposal',
  }, { actor });
  assert.equal(workflow.status, 'completed');
  const run = await Promise.resolve(app.workflows.getRun(workflow.runId));
  assert.ok(Array.isArray(run.spans));
  assert.ok(run.spans.length > 0);

  const audit = await Promise.resolve(app.audit.list({ entityType: 'company', entityId: company.id }));
  assert.ok(audit.some((entry) => entry.action === 'company.created'));
  assertNoSecrets(audit);

  const client = new Client({
    host: planes.data.host,
    port: planes.data.port,
    database: planes.data.database,
    user: planes.data.user,
    password: planes.data.password,
    connectionTimeoutMillis: 2000,
  });
  await client.connect();
  try {
    await client.query('SET search_path TO pg_catalog, public');
    const gadgets = await client.query(`SELECT to_regclass($1) AS name`, [`${POSTGRES_SCHEMA_NAME}.gadgets`]);
    assert.equal(String(gadgets.rows[0].name), `${POSTGRES_SCHEMA_NAME}.gadgets`);
    const companies = await client.query(`SELECT name FROM ${POSTGRES_SCHEMA_NAME}.companies`);
    assert.equal(companies.rows[0].name, 'Acme');
    await assert.rejects(client.query('SELECT name FROM companies'));
  } finally {
    await client.end();
  }
});

test('startup attestation refuses missing schema:migrate before DDL', { timeout: 30_000 }, async (t) => {
  const planes = await openIsolatedPostgresqlPlanes(t);
  if (!planes) return;
  await assert.rejects(
    () => createAccordoAppAsync({
      adapter: 'postgresql',
      testHarness: { loopback: true, control: planes.control, data: planes.data },
      spine: { mode: 'local-development', tenant: { id: 'acme' } },
      identityVerifier: createTestVerifier({ tenantId: 'acme', permission: 'records.write' }),
    }),
    (error) => error.code === 'STARTUP_PERMISSION_MISSING',
  );
});

test('request evidence cannot satisfy startup attestation', { timeout: 30_000 }, async (t) => {
  const planes = await openIsolatedPostgresqlPlanes(t);
  if (!planes) return;
  await assert.rejects(
    () => createAccordoAppAsync({
      adapter: 'postgresql',
      testHarness: { loopback: true, control: planes.control, data: planes.data },
      spine: { mode: 'local-development', tenant: { id: 'acme' } },
      identityVerifier: createTestVerifier({ tenantId: 'acme', swapRequest: true }),
    }),
    (error) => error.code === 'STARTUP_EVIDENCE_INTERCHANGEABLE' || error.code === 'STARTUP_OPERATION_MISMATCH',
  );
});

test('fault injection before control audit leaves no committed control schema unit', { timeout: 30_000 }, async (t) => {
  const planes = await openIsolatedPostgresqlPlanes(t);
  if (!planes) return;
  await assert.rejects(
    () => createAccordoAppAsync({
      adapter: 'postgresql',
      testHarness: { loopback: true, control: planes.control, data: planes.data },
      spine: { mode: 'local-development', tenant: { id: 'acme' } },
      identityVerifier: createTestVerifier({ tenantId: 'acme' }),
      faultInject: 'control-after-ddl-5',
    }),
    (error) => error.code === 'STARTUP_FAULT_INJECTED',
  );
  const client = new Client({
    host: planes.control.host, port: planes.control.port, database: planes.control.database,
    user: planes.control.user, password: planes.control.password, connectionTimeoutMillis: 2000,
  });
  await client.connect();
  try {
    const ledger = await client.query(
      'SELECT to_regclass($1) AS name',
      [`${POSTGRES_SCHEMA_NAME}.schema_migrations`],
    );
    assert.equal(ledger.rows[0].name, null);
  } finally {
    await client.end();
  }
});

test('child-process PostgreSQL boot writes domain, workflow, audit and trace', { timeout: 60_000 }, async (t) => {
  const planes = await openIsolatedPostgresqlPlanes(t);
  if (!planes) return;
  const env = {
    ...process.env,
    ACCORDO_M3C_HOST: String(planes.control.host),
    ACCORDO_M3C_PORT: String(planes.control.port),
    ACCORDO_M3C_USER: String(planes.control.user),
    ACCORDO_M3C_PASSWORD: String(planes.control.password ?? ''),
    ACCORDO_M3C_CONTROL_DB: planes.control.database,
    ACCORDO_M3C_DATA_DB: planes.data.database,
    ACCORDO_M3C_SENTINEL: 'SUPERSECRET_SENTINEL_PASSWORD',
  };
  const run = spawnSync(process.execPath, ['--no-warnings', join(here, 'helpers/m3c-child-boot.mjs')], {
    cwd: join(here, '..'),
    env,
    encoding: 'utf8',
    timeout: 45_000,
  });
  assert.equal(run.status, 0, run.stderr);
  const receipt = JSON.parse(run.stdout);
  assert.equal(receipt.ok, true);
  assert.equal(receipt.adapter, 'postgresql');
  assert.equal(receipt.company, 'Child Co');
  assert.equal(receipt.workflow, 'completed');
  assert.ok(receipt.traceSpans.length > 0);
  assert.ok(receipt.auditActions.includes('company.created'));
  assert.equal(run.stdout.includes('SUPERSECRET_SENTINEL_PASSWORD'), false);
  assert.equal(run.stderr.includes('SUPERSECRET_SENTINEL_PASSWORD'), false);
  assert.equal(JSON.stringify(receipt).includes(PG_TEST_URL), false);
});
});
