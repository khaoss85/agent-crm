// @ts-check

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import pg from 'pg';
import {
  createBackupOperations,
  createPostgresqlNativeBackupProvider,
} from '../packages/core/src/backup-restore.js';
import { bootstrapPostgresqlApplication, DATA_ADVISORY_LOCK, DATA_RESTORE_CHILD_LOCK } from '../packages/core/src/postgresql-bootstrap.js';
import { createPostgresqlPool } from '../packages/core/src/postgresql-storage.js';
import { createTestVerifier, testResource } from './helpers/identity-verifier-fixture.mjs';
import { GADGET_MIGRATION, openIsolatedPostgresqlPlanes } from './helpers/postgresql-application.js';
import { PG_REQUIRED } from './helpers/storage-contract-cases.js';

const { Client } = pg;
const TENANT = 'v4b-tenant';
const SENTINEL = 'v4b-postgresql-password-sentinel';
const RESTORE_ACTOR = Object.freeze({ type: 'user', id: 'v4b-pg-operator' });

function restoreControl(receipts) {
  const operations = new Map();
  return Object.freeze({
    contract: 1,
    async authorizeAndRecordAttempt(input) {
      const existing = operations.get(input.operationId);
      if (existing) {
        assert.equal(existing.artifactDigest, input.artifactDigest);
        assert.equal(existing.manifestDigest, input.manifestDigest);
        assert.equal(existing.targetResourceFingerprint, input.targetResourceFingerprint);
        return {
          id: existing.id, attempt: 'existing', outcome: existing.outcome,
          artifactDigest: existing.artifactDigest,
          manifestDigest: existing.manifestDigest,
          targetResourceFingerprint: existing.targetResourceFingerprint,
        };
      }
      const state = {
        id: `pg-${input.operationId}`,
        artifactDigest: input.artifactDigest,
        manifestDigest: input.manifestDigest,
        targetResourceFingerprint: input.targetResourceFingerprint,
        outcome: null,
      };
      operations.set(input.operationId, state);
      receipts.push({ phase: 'attempted', input });
      return {
        id: state.id, attempt: 'new', outcome: null,
        artifactDigest: state.artifactDigest,
        manifestDigest: state.manifestDigest,
        targetResourceFingerprint: state.targetResourceFingerprint,
      };
    },
    async recordOutcome(input) {
      const state = operations.get(input.operationId);
      assert.equal(state.artifactDigest, input.artifactDigest);
      assert.equal(state.manifestDigest, input.manifestDigest);
      assert.equal(state.targetResourceFingerprint, input.targetResourceFingerprint);
      if (state.outcome !== null) { assert.equal(state.outcome, input.outcome); return; }
      state.outcome = input.outcome;
      receipts.push({ phase: 'outcome', input });
    },
  });
}

function connection(endpoint, resourceFingerprint) {
  return Object.freeze({
    resourceFingerprint,
    async withEnvironment(consumer) {
      return consumer({
        PGHOST: endpoint.host,
        PGPORT: String(endpoint.port ?? 5432),
        PGDATABASE: endpoint.database,
        PGUSER: endpoint.user,
        PGPASSWORD: endpoint.password || SENTINEL,
        PGSSLMODE: 'disable',
      });
    },
  });
}

/** Run one SQL file through the real psql the provider would use. */
function runPsql(filePath, endpoint) {
  return new Promise((resolve) => {
    const child = spawn('psql', [
      '-X', '--set=ON_ERROR_STOP=1', '--quiet', '--no-align', '--no-password',
      '--dbname=', `--file=${filePath}`,
    ], {
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        PGHOST: endpoint.host, PGPORT: String(endpoint.port), PGDATABASE: endpoint.database,
        PGUSER: endpoint.user, PGPASSWORD: endpoint.password, PGGSSENCMODE: 'disable',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.stdout.resume();
    child.on('close', (code) => resolve({ code, stderr }));
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

function expectedOf(evidence, artifactDigest, manifestDigest, targetResourceFingerprint) {
  return Object.freeze({
    bindingUuid: evidence.bindingUuid,
    tenantFingerprint: evidence.tenantFingerprint,
    resourceFingerprint: evidence.resourceFingerprint,
    migrationSetFingerprint: evidence.migrationSetFingerprint,
    repositoryFingerprint: evidence.repositoryFingerprint,
    artifactDigest,
    manifestDigest,
    targetResourceFingerprint,
  });
}

test('PostgreSQL 16 native backup verifies, restores only to empty target, and boots through normal authority', { timeout: 120_000 }, async (t) => {
  const planes = await openIsolatedPostgresqlPlanes(t, { dataCount: 14 });
  if (!planes) return;
  const [
    sourceData, replacementData, cloneData, occupiedData, wrongSourceData,
    enumData, domainData, functionData, extensionData, compositeData, textSearchData,
    largeObjectData, defaultAclData, castData,
  ] = planes.dataPlanes;
  const logicalResource = testResource('v4b-logical-primary');
  const cloneResource = testResource('v4b-unratified-clone');
  const occupiedResource = testResource('v4b-occupied-target');
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

  const provider = createPostgresqlNativeBackupProvider({ createPool: createPostgresqlPool });
  const receipts = [];
  const operations = createBackupOperations({
    adapter: 'postgresql',
    provider,
    evidence: source.backupEvidence,
    connection: connection(sourceData, source.backupEvidence.resourceFingerprint),
    restoreControl: restoreControl(receipts),
  });

  const otherTenant = 'v4b-other-tenant';
  const other = await bootstrap(planes.control, wrongSourceData, testResource('v4b-other-resource'), otherTenant);
  const wrongSourceOperations = createBackupOperations({
    adapter: 'postgresql',
    provider,
    evidence: source.backupEvidence,
    connection: connection(wrongSourceData, other.backupEvidence.resourceFingerprint),
    restoreControl: restoreControl([]),
  });
  await assert.rejects(
    wrongSourceOperations.create({ bundlePath: join(root, 'wrong-source') }),
    (error) => error?.code === 'BACKUP_SOURCE_AUTHORITY_MISMATCH',
  );
  await other.close();

  const created = await operations.create({ bundlePath });
  const expected = expectedOf(
    source.backupEvidence,
    created.artifactDigest,
    created.manifestDigest,
    logicalResource.resourceFingerprint,
  );
  assert.equal((await operations.verify({ bundlePath, expected })).verified, true);
  const manifest = await readFile(join(bundlePath, 'manifest.json'), 'utf8');
  const credentialLocator = `postgresql://${sourceData.user}:${sourceData.password}@${sourceData.host}:${sourceData.port ?? 5432}/${sourceData.database}`;
  for (const forbiddenScalar of [
    sourceData.host, sourceData.database, sourceData.user, sourceData.password,
    replacementData.database, cloneData.database, occupiedData.database, SENTINEL, 'PGPASSWORD', 'postgresql://',
  ].filter(Boolean)) {
    assert.equal(
      manifest.includes(JSON.stringify(String(forbiddenScalar))),
      false,
      `manifest leaked a forbidden connection scalar`,
    );
  }
  assert.equal(manifest.includes(credentialLocator), false, 'manifest leaked a complete connection locator');

  await source.close();
  source = null;

  const occupiedClient = await client(occupiedData);
  try { await occupiedClient.query('CREATE TABLE public.must_not_overwrite(id integer)'); } finally { await occupiedClient.end(); }
  await assert.rejects(
    operations.restore({
      bundlePath,
      expected: { ...expected, targetResourceFingerprint: occupiedResource.resourceFingerprint },
      target: connection(occupiedData, occupiedResource.resourceFingerprint), actor: RESTORE_ACTOR,
      operationId: 'occupied-table',
    }),
    (error) => error?.code === 'BACKUP_TARGET_NOT_EMPTY',
  );
  const occupiedProof = await client(occupiedData);
  try {
    assert.equal((await occupiedProof.query("SELECT to_regclass('public.must_not_overwrite') AS name")).rows[0].name, 'must_not_overwrite');
    assert.equal((await occupiedProof.query("SELECT to_regclass('accordo.gadgets') AS name")).rows[0].name, null);
  } finally { await occupiedProof.end(); }

  for (const [index, [endpoint, ddl]] of [
    [enumData, 'CREATE TYPE public.restore_guard_enum AS ENUM (\'one\')'],
    [domainData, 'CREATE DOMAIN public.restore_guard_domain AS text CHECK (VALUE <> \'\')'],
    [functionData, 'CREATE FUNCTION public.restore_guard_function() RETURNS integer LANGUAGE SQL AS \'SELECT 1\''],
    [extensionData, 'CREATE EXTENSION hstore'],
    [compositeData, 'CREATE TYPE public.restore_guard_composite AS (value text)'],
    [textSearchData, 'CREATE TEXT SEARCH CONFIGURATION public.restore_guard_search (COPY = pg_catalog.simple)'],
    [largeObjectData, 'SELECT pg_catalog.lo_create(0)'],
    [defaultAclData, 'ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO PUBLIC'],
    [castData, 'CREATE CAST (text AS boolean) WITH INOUT AS ASSIGNMENT'],
  ].entries()) {
    const catalogResource = testResource(`v4b-catalog-target-${index}`);
    const objectClient = await client(endpoint);
    try { await objectClient.query(ddl); } finally { await objectClient.end(); }
    await assert.rejects(
      operations.restore({
        bundlePath,
        expected: { ...expected, targetResourceFingerprint: catalogResource.resourceFingerprint },
        target: connection(endpoint, catalogResource.resourceFingerprint), actor: RESTORE_ACTOR,
        operationId: `occupied-catalog-${index}`,
      }),
      (error) => error?.code === 'BACKUP_TARGET_NOT_EMPTY',
      `restore refuses a target occupied by ${ddl.split(' ')[1].toLowerCase()}`,
    );
  }

  const lockHolder = await client(replacementData);
  try {
    await lockHolder.query('SELECT pg_advisory_lock($1, $2)', [DATA_ADVISORY_LOCK.classId, DATA_ADVISORY_LOCK.objectId]);
    await assert.rejects(
      operations.restore({
        bundlePath, expected,
        target: connection(replacementData, logicalResource.resourceFingerprint), actor: RESTORE_ACTOR,
        operationId: 'target-lock-busy',
      }),
      (error) => error?.code === 'BACKUP_TARGET_BUSY',
      'restore refuses immediately when startup/restore authority is already held',
    );
  } finally {
    await lockHolder.query('SELECT pg_advisory_unlock($1, $2)', [DATA_ADVISORY_LOCK.classId, DATA_ADVISORY_LOCK.objectId]).catch(() => {});
    await lockHolder.end();
  }

  const restored = await operations.restore({
    bundlePath, expected,
    target: connection(replacementData, logicalResource.resourceFingerprint), actor: RESTORE_ACTOR,
    operationId: 'replacement-restore',
  });
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
  const cloneRestore = await operations.restore({
    bundlePath,
    expected: { ...expected, targetResourceFingerprint: cloneResource.resourceFingerprint },
    target: connection(cloneData, cloneResource.resourceFingerprint), actor: RESTORE_ACTOR,
    operationId: 'clone-restore',
  });
  assert.equal(cloneRestore.authority, 'normal-startup-required');
  await assert.rejects(
    bootstrap(planes.control, cloneData, cloneResource),
    (error) => error?.code === 'CLONE_PROMOTION_REFUSED',
    'a byte-identical restore with a distinct resource identity does not inherit writer authority',
  );
  assert.ok(receipts.some((receipt) => receipt.phase === 'attempted'));
  assert.ok(receipts.some((receipt) => receipt.phase === 'outcome' && receipt.input.outcome === 'succeeded'));
});

test('hosted PostgreSQL suite requires matching native client 16 tools', { timeout: 10_000 }, async (t) => {
  if (!PG_REQUIRED) {
    t.skip('PostgreSQL is not required in this lane');
    return;
  }
  const provider = createPostgresqlNativeBackupProvider({ timeoutMs: 2000, createPool: createPostgresqlPool });
  await provider.prepareRestore();
});

test('the restore child refuses a backend where the coordinator witness is absent', { timeout: 90_000 }, async (t) => {
  if (!PG_REQUIRED) {
    t.skip('PostgreSQL is not required in this lane');
    return;
  }
  const planes = await openIsolatedPostgresqlPlanes(t, { dataCount: 1 });
  const [endpoint] = planes.data;
  const witness = Object.freeze({ classId: 1094927188, objectId: 987654321 });
  const root = await mkdtemp(join(tmpdir(), 'accordo-v4b-fence-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  // The prelude the provider renders, byte for byte, in front of a target the
  // coordinator is not holding. A child that reached the wrong backend sees
  // exactly this: nobody holds the witness, so it takes it, and refuses.
  const preludePath = join(root, 'prelude.sql');
  await writeFile(preludePath, `\\set ON_ERROR_STOP on
BEGIN;
SET LOCAL search_path TO pg_catalog;
SELECT pg_advisory_xact_lock(${DATA_RESTORE_CHILD_LOCK.classId}, ${DATA_RESTORE_CHILD_LOCK.objectId});
DO $accordo_restore_fence$
BEGIN
  IF pg_try_advisory_lock(${witness.classId}, ${witness.objectId}) THEN
    PERFORM pg_advisory_unlock(${witness.classId}, ${witness.objectId});
    RAISE EXCEPTION 'restore coordinator witness is absent' USING ERRCODE = '55000';
  END IF;
END
$accordo_restore_fence$;
CREATE TABLE public.fence_must_not_create (id integer);
COMMIT;
`, { mode: 0o600 });

  const unwitnessed = await runPsql(preludePath, endpoint);
  assert.notEqual(unwitnessed.code, 0, 'an unwitnessed child never reaches COMMIT');
  assert.match(unwitnessed.stderr, /restore coordinator witness is absent/);
  const proof = await client(endpoint);
  try {
    assert.equal(
      (await proof.query("SELECT to_regclass('public.fence_must_not_create') AS name")).rows[0].name,
      null,
      'the refusal rolls back before any DDL becomes durable',
    );
  } finally { await proof.end(); }

  // With the coordinator holding the witness on its own session, the same
  // prelude admits the child and the transaction commits.
  const holder = await client(endpoint);
  try {
    await holder.query('SELECT pg_advisory_lock($1, $2)', [witness.classId, witness.objectId]);
    const witnessed = await runPsql(preludePath, endpoint);
    assert.equal(witnessed.code, 0, `a witnessed child is admitted: ${witnessed.stderr}`);
  } finally {
    await holder.query('SELECT pg_advisory_unlock($1, $2)', [witness.classId, witness.objectId]);
    await holder.end();
  }
  const created = await client(endpoint);
  try {
    assert.equal(
      (await created.query("SELECT to_regclass('public.fence_must_not_create') AS name")).rows[0].name,
      'fence_must_not_create',
    );
  } finally { await created.end(); }
});
