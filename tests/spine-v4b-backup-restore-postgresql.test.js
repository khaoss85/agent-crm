// @ts-check

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import pg from 'pg';
import {
  createBackupOperations,
  createPostgresqlNativeBackupProvider,
} from '../packages/core/src/backup-restore.js';
import { bootstrapPostgresqlApplication, DATA_ADVISORY_LOCK } from '../packages/core/src/postgresql-bootstrap.js';
import { createTestVerifier, testResource } from './helpers/identity-verifier-fixture.mjs';
import { GADGET_MIGRATION, openIsolatedPostgresqlPlanes } from './helpers/postgresql-application.js';
import { PG_REQUIRED } from './helpers/storage-contract-cases.js';

const { Client } = pg;
const TENANT = 'v4b-tenant';
const SENTINEL = 'v4b-postgresql-password-sentinel';

function connection(endpoint) {
  return Object.freeze({
    async withEnvironment(consumer) {
      return consumer({
        PGHOST: endpoint.host,
        PGPORT: String(endpoint.port ?? 5432),
        PGDATABASE: endpoint.database,
        PGUSER: endpoint.user,
        PGPASSWORD: endpoint.password || SENTINEL,
      });
    },
  });
}

async function client(endpoint) {
  const handle = new Client({
    host: endpoint.host,
    port: endpoint.port,
    database: endpoint.database,
    user: endpoint.user,
    password: endpoint.password,
    connectionTimeoutMillis: 2000,
  });
  await handle.connect();
  return handle;
}

async function bootstrap(control, data, dataResource, tenantId = TENANT) {
  return bootstrapPostgresqlApplication({
    control,
    data,
    tenantId,
    identityVerifier: createTestVerifier({ tenantId, dataResource }),
    moduleMigrations: [GADGET_MIGRATION],
  });
}

function expectedOf(evidence) {
  return Object.freeze({
    bindingUuid: evidence.bindingUuid,
    tenantFingerprint: evidence.tenantFingerprint,
    resourceFingerprint: evidence.resourceFingerprint,
    migrationSetFingerprint: evidence.migrationSetFingerprint,
    repositoryFingerprint: evidence.repositoryFingerprint,
  });
}

test('PostgreSQL 16 native backup verifies, restores only to empty target, and boots through normal authority', { timeout: 120_000 }, async (t) => {
  const planes = await openIsolatedPostgresqlPlanes(t, { dataCount: 5 });
  if (!planes) return;
  const [sourceData, replacementData, cloneData, occupiedData, wrongSourceData] = planes.dataPlanes;
  const logicalResource = testResource('v4b-logical-primary');
  const cloneResource = testResource('v4b-unratified-clone');
  const root = await mkdtemp(join(tmpdir(), 'accordo-v4b-pg-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundlePath = join(root, 'bundle');

  let source = await bootstrap(planes.control, sourceData, logicalResource);
  const sourceClient = await client(sourceData);
  try {
    await sourceClient.query(
      `INSERT INTO accordo.gadgets(id, label, created_at, updated_at) VALUES($1, $2, NOW(), NOW())`,
      ['v4b-gadget', 'survives native restore'],
    );
  } finally { await sourceClient.end(); }

  const provider = createPostgresqlNativeBackupProvider();
  const operations = createBackupOperations({
    adapter: 'postgresql',
    provider,
    evidence: source.backupEvidence,
    connection: connection(sourceData),
  });
  const expected = expectedOf(source.backupEvidence);

  const otherTenant = 'v4b-other-tenant';
  const other = await bootstrap(planes.control, wrongSourceData, testResource('v4b-other-resource'), otherTenant);
  const wrongSourceOperations = createBackupOperations({
    adapter: 'postgresql',
    provider,
    evidence: source.backupEvidence,
    connection: connection(wrongSourceData),
  });
  await assert.rejects(
    wrongSourceOperations.create({ bundlePath: join(root, 'wrong-source') }),
    (error) => error?.code === 'BACKUP_SOURCE_AUTHORITY_MISMATCH',
  );
  await other.close();

  await operations.create({ bundlePath });
  assert.equal((await operations.verify({ bundlePath, expected })).verified, true);
  const manifest = await readFile(join(bundlePath, 'manifest.json'), 'utf8');
  for (const forbidden of [
    sourceData.host, sourceData.database, sourceData.user, sourceData.password,
    replacementData.database, cloneData.database, occupiedData.database, SENTINEL, 'PGPASSWORD', 'postgresql://',
  ].filter(Boolean)) {
    assert.equal(manifest.includes(String(forbidden)), false, `manifest leaked ${forbidden}`);
  }

  await source.close();
  source = null;

  const occupiedClient = await client(occupiedData);
  try { await occupiedClient.query('CREATE TABLE public.must_not_overwrite(id integer)'); } finally { await occupiedClient.end(); }
  await assert.rejects(
    operations.restore({ bundlePath, expected, target: connection(occupiedData) }),
    (error) => error?.code === 'BACKUP_TARGET_NOT_EMPTY',
  );
  const occupiedProof = await client(occupiedData);
  try {
    assert.equal((await occupiedProof.query("SELECT to_regclass('public.must_not_overwrite') AS name")).rows[0].name, 'must_not_overwrite');
    assert.equal((await occupiedProof.query("SELECT to_regclass('accordo.gadgets') AS name")).rows[0].name, null);
  } finally { await occupiedProof.end(); }

  const lockHolder = await client(replacementData);
  try {
    await lockHolder.query('SELECT pg_advisory_lock($1, $2)', [DATA_ADVISORY_LOCK.classId, DATA_ADVISORY_LOCK.objectId]);
    await assert.rejects(
      operations.restore({ bundlePath, expected, target: connection(replacementData) }),
      (error) => error?.code === 'BACKUP_TARGET_BUSY',
      'restore refuses immediately when startup/restore authority is already held',
    );
  } finally {
    await lockHolder.query('SELECT pg_advisory_unlock($1, $2)', [DATA_ADVISORY_LOCK.classId, DATA_ADVISORY_LOCK.objectId]).catch(() => {});
    await lockHolder.end();
  }

  const restored = await operations.restore({ bundlePath, expected, target: connection(replacementData) });
  assert.equal(restored.restored, true);
  assert.equal(restored.authority, 'normal-startup-required');

  let target = await bootstrap(planes.control, replacementData, logicalResource);
  t.after(async () => { await target?.close(); });
  const targetClient = await client(replacementData);
  try {
    const rows = await targetClient.query('SELECT id, label FROM accordo.gadgets ORDER BY id');
    assert.deepEqual(rows.rows, [{ id: 'v4b-gadget', label: 'survives native restore' }]);
  } finally { await targetClient.end(); }
  assert.equal(target.binding.dataPlaneId, expected.bindingUuid);
  assert.equal(target.backupEvidence.resourceFingerprint, expected.resourceFingerprint);

  await target.close();
  target = null;
  const cloneRestore = await operations.restore({ bundlePath, expected, target: connection(cloneData) });
  assert.equal(cloneRestore.authority, 'normal-startup-required');
  await assert.rejects(
    bootstrap(planes.control, cloneData, cloneResource),
    (error) => error?.code === 'CLONE_PROMOTION_REFUSED',
    'a byte-identical restore with a distinct resource identity does not inherit writer authority',
  );
});

test('hosted PostgreSQL suite requires matching native client 16 tools', { timeout: 10_000 }, async () => {
  if (!PG_REQUIRED) return;
  const provider = createPostgresqlNativeBackupProvider({ timeoutMs: 2000 });
  await provider.prepareRestore();
});
