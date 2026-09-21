// @ts-check

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { inspect } from 'node:util';
import { writeFileSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  BACKUP_CONTRACT,
  backupVocabulary,
  createBackupOperations,
  createPostgresqlNativeBackupProvider,
  defineBackupProvider,
} from '../packages/core/src/backup-restore.js';
import { DATA_RESTORE_CHILD_LOCK } from '../packages/core/src/postgresql-authority.js';
import * as publicCore from '../packages/core/index.js';

const SENTINEL = 'backup-secret-sentinel-never-leak';
const LOCATOR = 'postgresql://sentinel.invalid/private';
const FIXTURE_DIGEST = createHash('sha256').update('closed-fixture-artifact').digest('hex');
const source = Object.freeze({
  contract: 1,
  adapter: 'postgresql',
  bindingUuid: '123e4567-e89b-42d3-a456-426614174000',
  tenantFingerprint: '1'.repeat(64),
  resourceFingerprint: '2'.repeat(64),
  migrationSetFingerprint: '3'.repeat(64),
  repositoryFingerprint: '4'.repeat(64),
});
const FIXTURE_MANIFEST_DIGEST = createHash('sha256').update(`${JSON.stringify({
  contract: 1,
  adapter: 'postgresql',
  createdAt: '2026-08-31T12:00:00.000Z',
  source: Object.fromEntries(Object.entries(source).filter(([key]) => !['contract', 'adapter'].includes(key))),
  artifact: { algorithm: 'sha256', digest: FIXTURE_DIGEST },
  provider: { contract: 1, name: 'fixture', tool: { name: 'fixture', major: 16, version: 'fixture-16.0' } },
}, null, 2)}\n`).digest('hex');
const expected = Object.freeze({
  bindingUuid: source.bindingUuid,
  tenantFingerprint: source.tenantFingerprint,
  resourceFingerprint: source.resourceFingerprint,
  migrationSetFingerprint: source.migrationSetFingerprint,
  repositoryFingerprint: source.repositoryFingerprint,
  artifactDigest: FIXTURE_DIGEST,
  manifestDigest: FIXTURE_MANIFEST_DIGEST,
  targetResourceFingerprint: source.resourceFingerprint,
});
const connection = Object.freeze({
  resourceFingerprint: source.resourceFingerprint,
  async withEnvironment(consumer) {
    return consumer({
      PGHOST: '127.0.0.1', PGPORT: '5432', PGDATABASE: 'fixture', PGUSER: 'fixture', PGPASSWORD: SENTINEL,
      PGSSLMODE: 'disable',
    });
  },
});
const RESTORE_ACTOR = Object.freeze({ type: 'user', id: 'backup-operator' });

function fixtureRestoreControl(receipts = []) {
  const operations = new Map();
  return Object.freeze({
    contract: BACKUP_CONTRACT,
    async authorizeAndRecordAttempt(input) {
      const existing = operations.get(input.operationId);
      if (existing) {
        assert.equal(existing.artifactDigest, input.artifactDigest);
        assert.equal(existing.manifestDigest, input.manifestDigest);
        return {
          id: existing.id,
          attempt: 'existing',
          outcome: existing.outcome,
          artifactDigest: existing.artifactDigest,
          manifestDigest: existing.manifestDigest,
          targetResourceFingerprint: existing.targetResourceFingerprint,
        };
      }
      const state = {
        id: `restore-${input.operationId}`,
        artifactDigest: input.artifactDigest,
        manifestDigest: input.manifestDigest,
        targetResourceFingerprint: input.targetResourceFingerprint,
        outcome: null,
      };
      operations.set(input.operationId, state);
      receipts.push({ phase: 'attempted', input });
      return {
        id: state.id,
        attempt: 'new',
        outcome: null,
        artifactDigest: state.artifactDigest,
        manifestDigest: state.manifestDigest,
        targetResourceFingerprint: state.targetResourceFingerprint,
      };
    },
    async recordOutcome(input) {
      const state = operations.get(input.operationId);
      assert.ok(state);
      assert.equal(state.id, input.receiptId);
      assert.equal(state.artifactDigest, input.artifactDigest);
      assert.equal(state.manifestDigest, input.manifestDigest);
      assert.equal(state.targetResourceFingerprint, input.targetResourceFingerprint);
      if (state.outcome !== null) {
        assert.equal(state.outcome, input.outcome, 'receipt outcome updates are idempotent, never divergent');
        return;
      }
      state.outcome = input.outcome;
      receipts.push({ phase: 'outcome', input });
    },
  });
}

function serialized(value) {
  return [
    String(value), String(value?.stack ?? ''), inspect(value, { depth: 20 }),
    JSON.stringify(value), JSON.stringify(value?.details), JSON.stringify(value?.cause),
  ].join('\n');
}

function assertNoLeak(value) {
  const blob = serialized(value);
  assert.equal(blob.includes(SENTINEL), false, blob);
  assert.equal(blob.includes(LOCATOR), false, blob);
}

function fixtureProvider(overrides = {}) {
  return defineBackupProvider({
    contract: BACKUP_CONTRACT,
    name: 'fixture',
    adapter: 'postgresql',
    async inspectAuthority() {
      return {
        bindingUuid: source.bindingUuid,
        tenantFingerprint: source.tenantFingerprint,
        resourceFingerprint: source.resourceFingerprint,
        migrationSetFingerprint: source.migrationSetFingerprint,
      };
    },
    async createArtifact({ artifactPath, connection: sourceConnection }) {
      return sourceConnection.withEnvironment(async (environment) => {
        assert.equal(environment.PGPASSWORD, SENTINEL);
        await writeFile(artifactPath, Buffer.from('closed-fixture-artifact'));
        return { name: 'fixture', major: 16, version: 'fixture-16.0' };
      });
    },
    async prepareRestore() {},
    async withTargetLock(_input, operation) { return operation(lockedState()); },
    async restoreArtifact() {},
    ...overrides,
  });
}

function lockedState(empty = true, authority = source) {
  return Object.freeze({
    empty,
    lockedTarget: Object.freeze({}),
    async inspectAuthority() {
      return {
        bindingUuid: authority.bindingUuid,
        tenantFingerprint: authority.tenantFingerprint,
        resourceFingerprint: authority.resourceFingerprint,
        migrationSetFingerprint: authority.migrationSetFingerprint,
      };
    },
  });
}

function operations(provider = fixtureProvider()) {
  return createBackupOperations({
    adapter: 'postgresql', provider, evidence: source, connection,
    restoreControl: fixtureRestoreControl(),
    clock: () => '2026-08-31T12:00:00.000Z',
  });
}

function nativeTargetPool(authority = source) {
  return () => ({
    async connect() {
      return {
        async query(sql) {
          if (sql.includes('spine_data_plane_binding')) {
            return { rowCount: 1, rows: [{ tenant_slug: 'tenant-a', data_plane_id: authority.bindingUuid }] };
          }
          if (sql.includes('startup_audit')) {
            return { rowCount: 1, rows: [{
              tenant_fingerprint: authority.tenantFingerprint,
              resource_fingerprint: authority.resourceFingerprint,
              migration_set_fingerprint: authority.migrationSetFingerprint,
            }] };
          }
          if (sql.includes('pg_try_advisory_lock')) return { rowCount: 1, rows: [{ acquired: true }] };
          if (sql.includes('pg_advisory_unlock')) return { rowCount: 1, rows: [{ pg_advisory_unlock: true }] };
          if (sql.includes('pg_advisory_lock')) return { rowCount: 1, rows: [{ pg_advisory_lock: '' }] };
          if (sql.includes('WITH user_namespace')) return { rowCount: 1, rows: [{ occupied: false }] };
          throw new Error(`unexpected fixture query: ${sql}`);
        },
        release() {},
      };
    },
    async end() {},
  });
}

function nativeWithFixtureAuthority(options) {
  const native = createPostgresqlNativeBackupProvider(options);
  return defineBackupProvider({
    ...native,
    async inspectAuthority() {
      return {
        bindingUuid: source.bindingUuid,
        tenantFingerprint: source.tenantFingerprint,
        resourceFingerprint: source.resourceFingerprint,
        migrationSetFingerprint: source.migrationSetFingerprint,
      };
    },
  });
}

test('contract vocabulary is closed and SQLite is explicitly unsupported', () => {
  assert.deepEqual(backupVocabulary(), {
    contract: 1,
    adapters: ['postgresql'],
    providerKeys: ['contract', 'name', 'adapter', 'inspectAuthority', 'createArtifact', 'prepareRestore', 'withTargetLock', 'restoreArtifact'],
    evidenceKeys: ['contract', 'adapter', 'bindingUuid', 'tenantFingerprint', 'resourceFingerprint', 'migrationSetFingerprint', 'repositoryFingerprint'],
    expectedIntentKeys: [
      'bindingUuid', 'tenantFingerprint', 'resourceFingerprint',
      'migrationSetFingerprint', 'repositoryFingerprint', 'artifactDigest', 'manifestDigest',
      'targetResourceFingerprint',
    ],
    restoreControlKeys: ['contract', 'authorizeAndRecordAttempt', 'recordOutcome'],
    restoreAttempts: ['new', 'existing'],
    restoreOutcomes: ['succeeded', 'refused', 'possibly-partial'],
    bundleEntries: ['artifact.dump', 'manifest.json'],
    nativeToolMajor: 16,
  });
  assert.throws(
    () => createBackupOperations({
      adapter: 'sqlite', provider: fixtureProvider(), evidence: source, connection,
      restoreControl: fixtureRestoreControl(),
    }),
    (error) => error?.code === 'BACKUP_ADAPTER_UNSUPPORTED',
  );
  assert.equal(publicCore.BACKUP_CONTRACT, BACKUP_CONTRACT);
  assert.equal(publicCore.defineBackupProvider, defineBackupProvider);
  assert.equal(publicCore.createBackupOperations, createBackupOperations);
  assert.equal(publicCore.createPostgresqlNativeBackupProvider, createPostgresqlNativeBackupProvider);
  assert.deepEqual(publicCore.backupVocabulary(), backupVocabulary());
});

test('atomic bundle has a closed non-secret manifest and verifies only against independent expected intent', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'accordo-v4b-unit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundlePath = join(root, 'bundle');
  const created = await operations().create({ bundlePath });
  assert.equal(created.bundleCommitted, true);
  const raw = await readFile(join(bundlePath, 'manifest.json'), 'utf8');
  assert.equal(raw.includes(SENTINEL), false);
  assert.equal(raw.includes(LOCATOR), false);
  assert.equal(raw.includes('PGHOST'), false);
  assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ['adapter', 'artifact', 'contract', 'createdAt', 'provider', 'source']);
  assert.equal((await operations().verify({ bundlePath, expected })).verified, true);
  await assert.rejects(
    operations().verify({ bundlePath, expected: { ...expected, tenantFingerprint: '9'.repeat(64) } }),
    (error) => error?.code === 'BACKUP_EXPECTED_INTENT_MISMATCH' && !serialized(error).includes(SENTINEL),
  );
  await assert.rejects(operations().create({ bundlePath }), (error) => error?.code === 'BACKUP_DESTINATION_EXISTS');
});

test('tampered artifact, manifest and extra bundle entries refuse', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'accordo-v4b-tamper-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifactBundle = join(root, 'artifact');
  await operations().create({ bundlePath: artifactBundle });
  await writeFile(join(artifactBundle, 'artifact.dump'), 'tampered');
  await assert.rejects(operations().verify({ bundlePath: artifactBundle, expected }), (error) => error?.code === 'BACKUP_ARTIFACT_TAMPERED');

  const coherentBundle = join(root, 'coherent-substitution');
  await operations().create({ bundlePath: coherentBundle });
  const coherentBytes = 'coherent-attacker-artifact';
  await writeFile(join(coherentBundle, 'artifact.dump'), coherentBytes);
  const coherentManifestPath = join(coherentBundle, 'manifest.json');
  const coherentManifest = JSON.parse(await readFile(coherentManifestPath, 'utf8'));
  coherentManifest.artifact.digest = createHash('sha256').update(coherentBytes).digest('hex');
  const coherentManifestBytes = `${JSON.stringify(coherentManifest, null, 2)}\n`;
  await writeFile(coherentManifestPath, coherentManifestBytes);
  await assert.rejects(
    operations().verify({
      bundlePath: coherentBundle,
      expected: {
        ...expected,
        manifestDigest: createHash('sha256').update(coherentManifestBytes).digest('hex'),
      },
    }),
    (error) => error?.code === 'BACKUP_EXPECTED_INTENT_MISMATCH'
      && error?.details?.field === 'artifactDigest',
    'a coherent artifact plus manifest replacement cannot replace caller-owned artifact identity',
  );

  const metadataBundle = join(root, 'metadata-substitution');
  await operations().create({ bundlePath: metadataBundle });
  const metadataManifestPath = join(metadataBundle, 'manifest.json');
  const metadataManifest = JSON.parse(await readFile(metadataManifestPath, 'utf8'));
  metadataManifest.source.repositoryFingerprint = '9'.repeat(64);
  await writeFile(metadataManifestPath, `${JSON.stringify(metadataManifest, null, 2)}\n`);
  await assert.rejects(
    operations().verify({
      bundlePath: metadataBundle,
      expected: { ...expected, repositoryFingerprint: '9'.repeat(64) },
    }),
    (error) => error?.code === 'BACKUP_EXPECTED_INTENT_MISMATCH'
      && error?.details?.field === 'manifestDigest',
    'unchanged artifact bytes cannot authorize substituted manifest authority metadata',
  );

  const manifestBundle = join(root, 'manifest');
  await operations().create({ bundlePath: manifestBundle });
  const invalidManifest = JSON.stringify({ contract: 1, secret: SENTINEL });
  await writeFile(join(manifestBundle, 'manifest.json'), invalidManifest);
  await assert.rejects(operations().verify({
    bundlePath: manifestBundle,
    expected: { ...expected, manifestDigest: createHash('sha256').update(invalidManifest).digest('hex') },
  }), (error) => {
    assert.equal(error?.code, 'BACKUP_MANIFEST_INVALID'); assertNoLeak(error); return true;
  });

  const extraBundle = join(root, 'extra');
  await operations().create({ bundlePath: extraBundle });
  await writeFile(join(extraBundle, 'receipt.txt'), 'not allowed');
  await assert.rejects(operations().verify({ bundlePath: extraBundle, expected }), (error) => error?.code === 'BACKUP_BUNDLE_INVALID');
});

test('hostile provider failures are collapsed and create staging is cleaned', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'accordo-v4b-hostile-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const provider = fixtureProvider({
    async createArtifact() {
      throw Object.assign(new Error(`${SENTINEL} ${LOCATOR}`), {
        details: { password: SENTINEL }, cause: new Error(LOCATOR),
      });
    },
  });
  await assert.rejects(operations(provider).create({ bundlePath: join(root, 'bundle') }), (error) => {
    assert.equal(error?.code, 'BACKUP_PROVIDER_FAILED'); assertNoLeak(error); return true;
  });
  assert.deepEqual((await (await import('node:fs/promises')).readdir(root)), []);
});

test('source connection authority must match the evidence before artifact creation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'accordo-v4b-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let artifactCalled = false;
  const provider = fixtureProvider({
    async inspectAuthority() {
      return {
        bindingUuid: source.bindingUuid,
        tenantFingerprint: '9'.repeat(64),
        resourceFingerprint: source.resourceFingerprint,
        migrationSetFingerprint: source.migrationSetFingerprint,
      };
    },
    async createArtifact() { artifactCalled = true; },
  });
  await assert.rejects(operations(provider).create({ bundlePath: join(root, 'bundle') }), (error) => {
    assert.equal(error?.code, 'BACKUP_SOURCE_AUTHORITY_MISMATCH'); assertNoLeak(error); return true;
  });
  assert.equal(artifactCalled, false);

  let mismatchedConnectionUsed = false;
  const mismatchedConnection = Object.freeze({
    resourceFingerprint: '9'.repeat(64),
    async withEnvironment() { mismatchedConnectionUsed = true; throw new Error(SENTINEL); },
  });
  const mismatchedOperations = createBackupOperations({
    adapter: 'postgresql', provider: fixtureProvider(), evidence: source,
    connection: mismatchedConnection, restoreControl: fixtureRestoreControl(),
  });
  await assert.rejects(
    mismatchedOperations.create({ bundlePath: join(root, 'wrong-resource') }),
    (error) => error?.code === 'BACKUP_SOURCE_AUTHORITY_MISMATCH'
      && error?.details?.field === 'resourceFingerprint',
  );
  assert.equal(mismatchedConnectionUsed, false, 'declared source resource mismatch refuses before credentials resolve');
});

test('create resolves a rotating connection once and binds inspection plus dump to that endpoint', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'accordo-v4b-affine-create-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let resolutions = 0;
  const seen = [];
  const rotating = Object.freeze({
    resourceFingerprint: source.resourceFingerprint,
    async withEnvironment(consumer) {
      resolutions += 1;
      return consumer({
        PGHOST: '127.0.0.1', PGPORT: '5432', PGDATABASE: `source-${resolutions}`,
        PGUSER: 'fixture', PGPASSWORD: `password-${resolutions}`, PGSSLMODE: 'disable',
      });
    },
  });
  const provider = fixtureProvider({
    async inspectAuthority({ connection: bound }) {
      return bound.withEnvironment((environment) => {
        seen.push(environment.PGDATABASE);
        return {
          bindingUuid: source.bindingUuid,
          tenantFingerprint: source.tenantFingerprint,
          resourceFingerprint: source.resourceFingerprint,
          migrationSetFingerprint: source.migrationSetFingerprint,
        };
      });
    },
    async createArtifact({ artifactPath, connection: bound }) {
      return bound.withEnvironment(async (environment) => {
        seen.push(environment.PGDATABASE);
        await writeFile(artifactPath, 'affine-source');
        return { name: 'fixture', major: 16, version: 'fixture-16.0' };
      });
    },
  });
  const affineOperations = createBackupOperations({
    adapter: 'postgresql', provider, evidence: source, connection: rotating,
    restoreControl: fixtureRestoreControl(),
    clock: () => '2026-08-31T12:00:00.000Z',
  });
  await affineOperations.create({ bundlePath: join(root, 'bundle') });
  assert.equal(resolutions, 1);
  assert.deepEqual(seen, ['source-1', 'source-1']);
});

test('top-level accessors and coercion objects refuse without invoking or reflecting hostile values', async () => {
  let invoked = false;
  const hostileCreate = {};
  Object.defineProperty(hostileCreate, 'bundlePath', {
    enumerable: true,
    get() { invoked = true; throw new Error(SENTINEL); },
  });
  await assert.rejects(operations().create(hostileCreate), (error) => {
    assert.equal(error?.code, 'BACKUP_CREATE_INPUT_INVALID'); assertNoLeak(error); return true;
  });
  assert.equal(invoked, false);
  await assert.rejects(
    operations().verify({ bundlePath: { toString() { throw new Error(SENTINEL); } }, expected }),
    (error) => { assert.equal(error?.code, 'BACKUP_PATH_INVALID'); assertNoLeak(error); return true; },
  );
  const hostileOptions = {
    provider: fixtureProvider(), evidence: source, connection,
    restoreControl: fixtureRestoreControl(),
  };
  Object.defineProperty(hostileOptions, 'adapter', {
    enumerable: true,
    get() { throw new Error(SENTINEL); },
  });
  assert.throws(() => createBackupOperations(hostileOptions), (error) => {
    assert.equal(error?.code, 'BACKUP_CONTRACT_INVALID'); assertNoLeak(error); return true;
  });
});

test('native provider refuses missing, wrong-major and hung tools with stable leak-free errors', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'accordo-v4b-tools-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const missing = nativeWithFixtureAuthority({ pgDump: join(root, 'missing') });
  await assert.rejects(operations(missing).create({ bundlePath: join(root, 'missing-bundle') }), (error) => {
    assert.equal(error?.code, 'BACKUP_TOOL_UNAVAILABLE'); assertNoLeak(error); return true;
  });

  const wrong = join(root, 'wrong');
  await writeFile(wrong, '#!/bin/sh\nprintf "pg_dump (PostgreSQL) 15.9\\n"\n');
  await chmod(wrong, 0o700);
  const wrongProvider = nativeWithFixtureAuthority({ pgDump: wrong });
  await assert.rejects(operations(wrongProvider).create({ bundlePath: join(root, 'wrong-bundle') }), (error) => error?.code === 'BACKUP_TOOL_VERSION_REFUSED');

  const hung = join(root, 'hung');
  await writeFile(hung, '#!/bin/sh\nwhile :; do :; done\n');
  await chmod(hung, 0o700);
  const hungProvider = nativeWithFixtureAuthority({ pgDump: hung, timeoutMs: 10 });
  await assert.rejects(operations(hungProvider).create({ bundlePath: join(root, 'hung-bundle') }), (error) => error?.code === 'BACKUP_TOOL_TIMEOUT');

  const descendantMarker = join(root, 'descendant-marker');
  const descendant = join(root, 'descendant');
  await writeFile(descendantMarker, '');
  await writeFile(descendant, `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf "pg_dump (PostgreSQL) 16.7\\n"
  exit 0
fi
: > ${JSON.stringify(descendantMarker)}
(
  while :; do
    printf x >> ${JSON.stringify(descendantMarker)}
    sleep 0.01
  done
) &
wait
`);
  await chmod(descendant, 0o700);
  const descendantProvider = nativeWithFixtureAuthority({ pgDump: descendant, timeoutMs: 1000 });
  await assert.rejects(
    operations(descendantProvider).create({ bundlePath: join(root, 'descendant-bundle') }),
    (error) => error?.code === 'BACKUP_TOOL_TIMEOUT',
  );
  const markerSize = (await stat(descendantMarker)).size;
  assert.ok(markerSize > 0, 'the wrapper descendant ran before the timeout fence');
  await new Promise((resolveWait) => setTimeout(resolveWait, 80));
  assert.equal((await stat(descendantMarker)).size, markerSize, 'timeout kills and observes the wrapper descendant group');

  const envProbe = join(root, 'env-probe');
  const caPath = join(root, 'ca.pem');
  await writeFile(caPath, 'fixture-ca');
  await chmod(caPath, 0o600);
  await writeFile(envProbe, `#!/bin/sh
if [ -n "$ACCORDO_UNRELATED_CHILD_SENTINEL" ]; then
  exit 91
fi
if [ "$1" = "--version" ]; then
  printf "pg_dump (PostgreSQL) 16.7\\n"
  exit 0
fi
if [ "$PGHOST" != "db.internal.example" ] || [ "$PGHOSTADDR" != "127.0.0.1" ] || [ "$PGSSLMODE" != "verify-full" ] || [ "$PGGSSENCMODE" != "disable" ] || [ "${'$'}(cat "$PGSSLROOTCERT")" != "fixture-ca" ]; then
  exit 92
fi
for argument in "$@"; do
  case "$argument" in
    --file=*) printf "fixture" > "${'$'}{argument#--file=}" ;;
  esac
done
`);
  await chmod(envProbe, 0o700);
  const prior = process.env.ACCORDO_UNRELATED_CHILD_SENTINEL;
  process.env.ACCORDO_UNRELATED_CHILD_SENTINEL = SENTINEL;
  t.after(() => {
    if (prior === undefined) delete process.env.ACCORDO_UNRELATED_CHILD_SENTINEL;
    else process.env.ACCORDO_UNRELATED_CHILD_SENTINEL = prior;
  });
  const envProvider = nativeWithFixtureAuthority({ pgDump: envProbe });
  const tlsConnection = Object.freeze({
    resourceFingerprint: source.resourceFingerprint,
    async withEnvironment(consumer) {
      return consumer({
        PGHOST: 'db.internal.example', PGHOSTADDR: '127.0.0.1', PGPORT: '5432',
        PGDATABASE: 'fixture', PGUSER: 'fixture', PGPASSWORD: SENTINEL,
        PGSSLMODE: 'verify-full', PGSSLROOTCERT: caPath,
      });
    },
  });
  await createBackupOperations({
    adapter: 'postgresql', provider: envProvider, evidence: source, connection: tlsConnection,
    restoreControl: fixtureRestoreControl(),
  }).create({ bundlePath: join(root, 'env-bundle') });
});

test('native provider injects one database client factory into source and restored authority inspection', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'accordo-v4b-native-authority-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dump = join(root, 'pg-dump');
  const restore = join(root, 'pg-restore');
  const psql = join(root, 'psql');
  const caPath = join(root, 'root.crt');
  const pinnedPathReceipt = join(root, 'pinned-path-receipt');
  const originalCa = 'native-original-ca';
  const replacementCa = 'native-replacement-ca';
  await writeFile(caPath, originalCa, { mode: 0o600 });
  await writeFile(dump, `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf "pg_dump (PostgreSQL) 16.7\\n"
  exit 0
fi
if [ "$PGGSSENCMODE" != "disable" ]; then exit 90; fi
if [ "${'$'}(cat "$PGSSLROOTCERT")" != "${originalCa}" ]; then exit 91; fi
printf "%s" "$PGSSLROOTCERT" > ${JSON.stringify(pinnedPathReceipt)}
for argument in "$@"; do
  case "$argument" in
    --file=*) printf "native-authority-artifact" > "${'$'}{argument#--file=}" ;;
  esac
done
`);
  await writeFile(restore, `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf "pg_restore (PostgreSQL) 16.7\\n"
  exit 0
fi
if [ -n "$PGDATABASE" ] || [ -n "$PGSSLROOTCERT" ]; then exit 92; fi
for argument in "$@"; do
  case "$argument" in
    --dbname=*) exit 93 ;;
    --file=*) printf -- "SELECT 1;\\n" > "${'$'}{argument#--file=}" ;;
  esac
done
`);
  await writeFile(psql, `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf "psql (PostgreSQL) 16.7\\n"
  exit 0
fi
if [ "$PGGSSENCMODE" != "disable" ]; then exit 90; fi
if [ "${'$'}(cat "$PGSSLROOTCERT")" != "${originalCa}" ]; then exit 92; fi
printf "%s" "$PGSSLROOTCERT" > ${JSON.stringify(pinnedPathReceipt)}
for argument in "$@"; do
  case "$argument" in
    --file=*.postlude.sql)
      rendered="${'$'}{argument#--file=}"
      printf "accordo-restore-authority-v1|%s|%s|%s|%s\\n" \\
        "${source.bindingUuid}" "${source.tenantFingerprint}" \\
        "${source.resourceFingerprint}" "${source.migrationSetFingerprint}" \\
        > "${'$'}{rendered%.postlude.sql}.authority"
      ;;
  esac
done
`);
  await Promise.all([chmod(dump, 0o700), chmod(restore, 0o700), chmod(psql, 0o700)]);

  let pools = 0;
  let markerReads = 0;
  const createPool = (options) => {
    pools += 1;
    assert.equal(options.database, 'fixture');
    assert.equal(options.password, SENTINEL);
    assert.equal(options.ssl.ca, originalCa, 'Node authority probes consume the pinned original CA bytes');
    if (pools <= 2) writeFileSync(caPath, replacementCa, { mode: 0o600 });
    const client = {
      async query(sql) {
        if (sql.includes('spine_data_plane_binding')) {
          markerReads += 1;
          return { rowCount: 1, rows: [{ tenant_slug: 'tenant-a', data_plane_id: source.bindingUuid }] };
        }
        if (sql.includes('startup_audit')) {
          return { rowCount: 1, rows: [{
            tenant_fingerprint: source.tenantFingerprint,
            resource_fingerprint: source.resourceFingerprint,
            migration_set_fingerprint: source.migrationSetFingerprint,
          }] };
        }
        if (sql.includes('pg_try_advisory_lock')) return { rowCount: 1, rows: [{ acquired: true }] };
        if (sql.includes('WITH user_namespace')) {
          assert.match(sql, /pg_catalog\.pg_cast WHERE oid >= 16384/);
          return { rowCount: 1, rows: [{ occupied: false }] };
        }
        if (sql.includes('pg_advisory_unlock')) return { rowCount: 1, rows: [{ pg_advisory_unlock: true }] };
        if (sql.includes('pg_advisory_lock')) return { rowCount: 1, rows: [{ pg_advisory_lock: '' }] };
        throw new Error(`unexpected fixture query: ${sql}`);
      },
      release() {},
    };
    return {
      async connect() { return client; },
      async end() {},
    };
  };
  const provider = createPostgresqlNativeBackupProvider({
    pgDump: dump, pgRestore: restore, psql, createPool,
  });
  const tlsConnection = Object.freeze({
    resourceFingerprint: source.resourceFingerprint,
    async withEnvironment(consumer) {
      return consumer({
        PGHOST: 'db.internal.example', PGHOSTADDR: '127.0.0.1', PGPORT: '5432',
        PGDATABASE: 'fixture', PGUSER: 'fixture', PGPASSWORD: SENTINEL,
        PGSSLMODE: 'verify-full', PGSSLROOTCERT: caPath,
      });
    },
  });
  const nativeOperations = createBackupOperations({
    adapter: 'postgresql', provider, evidence: source, connection: tlsConnection,
    restoreControl: fixtureRestoreControl(),
    clock: () => '2026-08-31T12:00:00.000Z',
  });
  const bundlePath = join(root, 'bundle');
  const created = await nativeOperations.create({ bundlePath });
  await writeFile(caPath, originalCa, { mode: 0o600 });
  const intent = {
    ...expected,
    artifactDigest: created.artifactDigest,
    manifestDigest: created.manifestDigest,
  };
  const result = await nativeOperations.restore({
    bundlePath, expected: intent, target: tlsConnection, actor: RESTORE_ACTOR,
    operationId: 'native-authority-inspection',
  });
  assert.equal(result.restored, true);
  assert.equal(markerReads, 2, 'both source and post-restore authority use the injected client factory');
  assert.equal(pools, 2, 'post-restore authority reuses the exact client that holds the target lock');
  const removedPinnedPath = await readFile(pinnedPathReceipt, 'utf8');
  await assert.rejects(readFile(removedPinnedPath), { code: 'ENOENT' });
});

test('connection transport is explicit: plaintext is loopback-only and remote requires verify-full trust', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'accordo-v4b-transport-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, transport] of [
    ['omitted', {}],
    ['remote-plaintext', { PGSSLMODE: 'disable' }],
  ]) {
    const unsafe = Object.freeze({
      resourceFingerprint: source.resourceFingerprint,
      async withEnvironment(consumer) {
        return consumer({
          PGHOST: 'remote-db.example', PGPORT: '5432', PGDATABASE: 'fixture',
          PGUSER: 'fixture', PGPASSWORD: SENTINEL, ...transport,
        });
      },
    });
    const unsafeOperations = createBackupOperations({
      adapter: 'postgresql', provider: fixtureProvider(), evidence: source,
      connection: unsafe, restoreControl: fixtureRestoreControl(),
    });
    await assert.rejects(
      unsafeOperations.create({ bundlePath: join(root, name) }),
      (error) => { assert.equal(error?.code, 'BACKUP_CONNECTION_TLS_REFUSED'); assertNoLeak(error); return true; },
    );
  }

  const caPath = join(root, 'remote-ca.pem');
  await writeFile(caPath, 'remote-ca', { mode: 0o600 });
  for (const [name, hostaddr] of [['missing-endpoint', undefined], ['hostname-endpoint', 'another.example']]) {
    const unsafe = Object.freeze({
      resourceFingerprint: source.resourceFingerprint,
      async withEnvironment(consumer) {
        return consumer({
          PGHOST: 'remote-db.example', ...(hostaddr === undefined ? {} : { PGHOSTADDR: hostaddr }),
          PGPORT: '5432', PGDATABASE: 'fixture', PGUSER: 'fixture', PGPASSWORD: SENTINEL,
          PGSSLMODE: 'verify-full', PGSSLROOTCERT: caPath,
        });
      },
    });
    await assert.rejects(
      createBackupOperations({
        adapter: 'postgresql', provider: fixtureProvider(), evidence: source,
        connection: unsafe, restoreControl: fixtureRestoreControl(),
      }).create({ bundlePath: join(root, name) }),
      (error) => error?.code === 'BACKUP_CONNECTION_ENDPOINT_REFUSED',
    );
  }
});

test('native restore keeps database locator out of argv and consumes PGDATABASE from the bounded environment', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'accordo-v4b-restore-argv-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundlePath = join(root, 'bundle');
  await operations().create({ bundlePath });
  const restoreProbe = join(root, 'pg-restore-probe');
  const psqlProbe = join(root, 'psql-probe');
  // pg_restore only renders the archive to local SQL, so it must receive no
  // connection environment and no locator at all.
  await writeFile(restoreProbe, `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf "pg_restore (PostgreSQL) 16.7\\n"
  exit 0
fi
if [ -n "$PGDATABASE" ] || [ -n "$PGUSER" ] || [ -n "$PGPASSWORD" ]; then exit 91; fi
for argument in "$@"; do
  case "$argument" in
    --dbname=*) exit 92 ;;
    fixture) exit 93 ;;
    --file=*) printf -- "SELECT 1;\\n" > "${'$'}{argument#--file=}" ;;
  esac
done
`);
  // psql inherits the original invariant: the database is named by the bounded
  // environment, never by argv.
  await writeFile(psqlProbe, `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf "psql (PostgreSQL) 16.7\\n"
  exit 0
fi
if [ "$PGDATABASE" != "fixture" ]; then exit 91; fi
seen_empty=0
for argument in "$@"; do
  if [ "$argument" = "--dbname=" ]; then seen_empty=1; fi
  if [ "$argument" = "fixture" ] || [ "$argument" = "--dbname=fixture" ]; then exit 92; fi
  case "$argument" in
    --file=*.postlude.sql)
      rendered="${'$'}{argument#--file=}"
      printf "accordo-restore-authority-v1|%s|%s|%s|%s\\n" \\
        "${source.bindingUuid}" "${source.tenantFingerprint}" \\
        "${source.resourceFingerprint}" "${source.migrationSetFingerprint}" \\
        > "${'$'}{rendered%.postlude.sql}.authority"
      ;;
  esac
done
if [ "$seen_empty" != "1" ]; then exit 93; fi
`);
  await Promise.all([chmod(restoreProbe, 0o700), chmod(psqlProbe, 0o700)]);
  const provider = nativeWithFixtureAuthority({
    pgRestore: restoreProbe, psql: psqlProbe, createPool: nativeTargetPool(),
  });
  const restoreOperations = createBackupOperations({
    adapter: 'postgresql', provider, evidence: source, connection,
    restoreControl: fixtureRestoreControl(),
  });
  const restored = await restoreOperations.restore({
    bundlePath, expected, target: connection, actor: RESTORE_ACTOR, operationId: 'argv-free-restore',
  });
  assert.equal(restored.restored, true);
});

test('non-empty target refuses before restore and provider failure is visibly partial', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'accordo-v4b-restore-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundlePath = join(root, 'bundle');
  await operations().create({ bundlePath });
  let restored = false;
  const occupied = fixtureProvider({
    async withTargetLock(_input, operation) { return operation(lockedState(false)); },
    async restoreArtifact() { restored = true; },
  });
  await assert.rejects(operations(occupied).restore({
    bundlePath, expected, target: connection, actor: RESTORE_ACTOR, operationId: 'occupied-target',
  }), (error) => error?.code === 'BACKUP_TARGET_NOT_EMPTY');
  assert.equal(restored, false);

  const partial = fixtureProvider({ async restoreArtifact() { throw new Error(`${SENTINEL} ${LOCATOR}`); } });
  await assert.rejects(operations(partial).restore({
    bundlePath, expected, target: connection, actor: RESTORE_ACTOR, operationId: 'partial-target',
  }), (error) => {
    assert.equal(error?.code, 'BACKUP_RESTORE_PARTIAL');
    assert.equal(error?.details?.targetState, 'possibly-partial');
    assertNoLeak(error);
    return true;
  });
});

test('restore requires an actor and records path-free control-plane attempt plus terminal or partial outcome', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'accordo-v4b-receipts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundlePath = join(root, 'bundle');
  const receipts = [];
  const sequence = [];
  let receiptLockHeld = false;
  const control = fixtureRestoreControl(receipts);
  const provider = fixtureProvider({
    async withTargetLock(_input, operation) {
      sequence.push('target-lock');
      receiptLockHeld = true;
      try { return await operation(lockedState()); } finally { receiptLockHeld = false; }
    },
    async restoreArtifact() {
      sequence.push('target-mutation');
      throw new Error(SENTINEL);
    },
  });
  const bounded = createBackupOperations({
    adapter: 'postgresql', provider, evidence: source, connection,
    restoreControl: Object.freeze({
      ...control,
      async authorizeAndRecordAttempt(input) {
        sequence.push('attempt-receipt');
        return control.authorizeAndRecordAttempt(input);
      },
      async recordOutcome(input) {
        assert.equal(receiptLockHeld, true, 'partial outcome is durable before the target lock is released');
        sequence.push(`outcome-${input.outcome}`);
        return control.recordOutcome(input);
      },
    }),
    clock: () => '2026-08-31T12:00:00.000Z',
  });
  await bounded.create({ bundlePath });
  await assert.rejects(
    bounded.restore({ bundlePath, expected, target: connection, operationId: 'missing-actor' }),
    (error) => error?.code === 'BACKUP_RESTORE_INPUT_INVALID',
  );
  assert.deepEqual(sequence, []);
  await assert.rejects(
    bounded.restore({
      bundlePath, expected, target: connection, actor: RESTORE_ACTOR, operationId: 'partial-receipt',
    }),
    (error) => { assert.equal(error?.code, 'BACKUP_RESTORE_PARTIAL'); assertNoLeak(error); return true; },
  );
  assert.deepEqual(sequence, ['attempt-receipt', 'target-lock', 'target-mutation', 'outcome-possibly-partial']);
  assert.deepEqual(receipts.map((item) => [item.phase, item.input.outcome ?? null]), [
    ['attempted', null], ['outcome', 'possibly-partial'],
  ]);
  const serializedReceipts = JSON.stringify(receipts);
  for (const forbidden of [bundlePath, SENTINEL, LOCATOR, 'PGHOST', 'PGPASSWORD']) {
    assert.equal(serializedReceipts.includes(forbidden), false, serializedReceipts);
  }

  let unauthorizedTargetTouched = false;
  const refusingControl = Object.freeze({
    contract: BACKUP_CONTRACT,
    async authorizeAndRecordAttempt() {
      throw Object.assign(new Error(`${SENTINEL} unauthorized`), { details: { locator: LOCATOR } });
    },
    async recordOutcome() { throw new Error('unreachable'); },
  });
  const refusing = createBackupOperations({
    adapter: 'postgresql', evidence: source, connection,
    restoreControl: refusingControl,
    provider: fixtureProvider({
      async withTargetLock(_input, operation) {
        unauthorizedTargetTouched = true;
        return operation(lockedState());
      },
    }),
  });
  await assert.rejects(
    refusing.restore({
      bundlePath, expected, target: connection, actor: RESTORE_ACTOR, operationId: 'unauthorized',
    }),
    (error) => { assert.equal(error?.code, 'BACKUP_PROVIDER_FAILED'); assertNoLeak(error); return true; },
  );
  assert.equal(unauthorizedTargetTouched, false, 'control-plane authorization and attempt receipt precede target access');
});

test('an indeterminate durable attempt after process death cannot authorize a second mutation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'accordo-v4b-indeterminate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundlePath = join(root, 'bundle');
  await operations().create({ bundlePath });
  let targetTouched = false;
  const crashedAttemptControl = Object.freeze({
    contract: BACKUP_CONTRACT,
    async authorizeAndRecordAttempt(input) {
      return {
        id: 'restore-crashed-before-terminal-receipt',
        attempt: 'existing',
        outcome: null,
        artifactDigest: input.artifactDigest,
        manifestDigest: input.manifestDigest,
        targetResourceFingerprint: input.targetResourceFingerprint,
      };
    },
    async recordOutcome() { throw new Error('indeterminate replay must not mint a terminal outcome'); },
  });
  const bounded = createBackupOperations({
    adapter: 'postgresql', evidence: source, connection, restoreControl: crashedAttemptControl,
    provider: fixtureProvider({
      async withTargetLock(_input, operation) {
        targetTouched = true;
        return operation(lockedState());
      },
    }),
  });
  await assert.rejects(
    bounded.restore({
      bundlePath, expected, target: connection, actor: RESTORE_ACTOR,
      operationId: 'crashed-restore-replay',
    }),
    (error) => error?.code === 'BACKUP_RESTORE_RECONCILIATION_REQUIRED'
      && error?.details?.targetState === 'indeterminate',
  );
  assert.equal(targetTouched, false, 'a surviving native child cannot make its pending receipt replayable');
});

test('restore consumes its verified private snapshot and rechecks those exact bytes afterward', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'accordo-v4b-snapshot-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundlePath = join(root, 'bundle');
  await operations().create({ bundlePath });

  const substitution = fixtureProvider({
    async withTargetLock(_input, operation) {
      await writeFile(join(bundlePath, 'artifact.dump'), 'substituted-after-verify');
      return operation(lockedState());
    },
    async restoreArtifact({ artifactPath }) {
      assert.equal((await readFile(artifactPath, 'utf8')), 'closed-fixture-artifact');
      throw new Error('stop before database authority probe');
    },
  });
  await assert.rejects(
    operations(substitution).restore({
      bundlePath, expected, target: connection, actor: RESTORE_ACTOR, operationId: 'bundle-substitution',
    }),
    (error) => error?.code === 'BACKUP_RESTORE_PARTIAL',
  );

  const changedBundle = join(root, 'changed-bundle');
  await operations().create({ bundlePath: changedBundle });
  const scratchMutation = fixtureProvider({
    async restoreArtifact({ artifactPath }) {
      await chmod(artifactPath, 0o600);
      await writeFile(artifactPath, 'changed-during-restore');
    },
  });
  await assert.rejects(
    operations(scratchMutation).restore({
      bundlePath: changedBundle, expected, target: connection, actor: RESTORE_ACTOR,
      operationId: 'scratch-mutation',
    }),
    (error) => error?.code === 'BACKUP_ARTIFACT_CHANGED_DURING_RESTORE',
  );
});

test('restore resolves one target for lock, import, and post-restore authority', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'accordo-v4b-affine-restore-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundlePath = join(root, 'bundle');
  await operations().create({ bundlePath });
  let resolutions = 0;
  const seen = [];
  let locked = false;
  let lockEntries = 0;
  const rotatingTarget = Object.freeze({
    resourceFingerprint: source.resourceFingerprint,
    async withEnvironment(consumer) {
      resolutions += 1;
      return consumer({
        PGHOST: '127.0.0.1', PGPORT: '5432', PGDATABASE: `target-${resolutions}`,
        PGUSER: 'fixture', PGPASSWORD: `password-${resolutions}`, PGSSLMODE: 'disable',
      });
    },
  });
  const observe = (bound) => bound.withEnvironment((environment) => {
    seen.push(environment.PGDATABASE);
    return environment;
  });
  const provider = fixtureProvider({
    async withTargetLock({ connection: bound }, operation) {
      await observe(bound);
      lockEntries += 1;
      locked = true;
      try {
        return await operation(Object.freeze({
          empty: true,
          lockedTarget: Object.freeze({}),
          async inspectAuthority() {
            assert.equal(locked, true, 'post-restore authority is read on the held-lock session');
            await observe(bound);
            return lockedState().inspectAuthority();
          },
        }));
      } finally { locked = false; }
    },
    async restoreArtifact({ connection: bound }) { await observe(bound); },
  });
  const restoreReceipts = [];
  const baseRestoreControl = fixtureRestoreControl(restoreReceipts);
  const restoreOperations = createBackupOperations({
    adapter: 'postgresql', provider, evidence: source, connection,
    restoreControl: Object.freeze({
      ...baseRestoreControl,
      async recordOutcome(input) {
        assert.equal(locked, true, 'successful outcome is durable before the target lock is released');
        return baseRestoreControl.recordOutcome(input);
      },
    }),
  });
  const restoreRequest = {
    bundlePath, expected, target: rotatingTarget, actor: RESTORE_ACTOR, operationId: 'affine-target',
  };
  assert.equal((await restoreOperations.restore(restoreRequest)).restored, true);
  const otherTargetFingerprint = '8'.repeat(64);
  const otherTarget = Object.freeze({
    resourceFingerprint: otherTargetFingerprint,
    async withEnvironment(consumer) {
      throw new Error(`replayed target must not resolve its environment: ${typeof consumer}`);
    },
  });
  await assert.rejects(
    restoreOperations.restore({
      ...restoreRequest,
      target: otherTarget,
      expected: { ...expected, targetResourceFingerprint: otherTargetFingerprint },
    }),
    (error) => error?.code === 'BACKUP_RESTORE_RECEIPT_INVALID',
    'a terminal operation receipt for target A cannot authorize target B',
  );
  const replay = await restoreOperations.restore(restoreRequest);
  assert.equal(replay.replayed, true);
  assert.equal(resolutions, 1);
  assert.deepEqual(seen, ['target-1', 'target-1', 'target-1']);
  assert.equal(lockEntries, 1, 'terminal replay never re-enters the target lock or mutation');
  assert.equal(restoreReceipts.filter((item) => item.phase === 'attempted').length, 1);
  assert.equal(restoreReceipts.filter((item) => item.phase === 'outcome').length, 1);
  assert.equal(locked, false);
});

test('a restore routed away from the held-lock backend is possibly partial and never adopted', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'accordo-v4b-backend-fence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundlePath = join(root, 'bundle');
  await operations().create({ bundlePath });
  const receipts = [];
  let wrongBackendMutated = false;
  let lockedInspection = false;
  const provider = fixtureProvider({
    async withTargetLock(_input, operation) {
      return operation(Object.freeze({
        empty: true,
        lockedTarget: Object.freeze({}),
        async inspectAuthority() {
          lockedInspection = true;
          return {
            bindingUuid: source.bindingUuid,
            tenantFingerprint: source.tenantFingerprint,
            resourceFingerprint: '9'.repeat(64),
            migrationSetFingerprint: source.migrationSetFingerprint,
          };
        },
      }));
    },
    async restoreArtifact() { wrongBackendMutated = true; },
    async inspectAuthority() {
      throw new Error('a fresh post-restore connection must never replace held-lock authority');
    },
  });
  await assert.rejects(
    createBackupOperations({
      adapter: 'postgresql', provider, evidence: source, connection,
      restoreControl: fixtureRestoreControl(receipts),
    }).restore({
      bundlePath, expected, target: connection, actor: RESTORE_ACTOR,
      operationId: 'wrong-backend-import',
    }),
    (error) => error?.code === 'BACKUP_RESTORED_AUTHORITY_MISMATCH',
  );
  assert.equal(wrongBackendMutated, true, 'the native tool outcome is conservatively treated as unknown');
  assert.equal(lockedInspection, true, 'acceptance is decided only by the held-lock backend session');
  assert.equal(
    receipts.some((item) => item.phase === 'outcome' && item.input.outcome === 'possibly-partial'),
    true,
  );
});

test('target-lock provider cannot return before its unique callback settles', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'accordo-v4b-lock-settlement-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundlePath = join(root, 'bundle');
  await operations().create({ bundlePath });
  let restored = false;
  const provider = fixtureProvider({
    async withTargetLock(_input, operation) {
      void operation(lockedState());
      return undefined;
    },
    async restoreArtifact({ artifactPath }) {
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal((await readFile(artifactPath, 'utf8')), 'closed-fixture-artifact');
      restored = true;
    },
  });
  await assert.rejects(
    operations(provider).restore({
      bundlePath, expected, target: connection, actor: RESTORE_ACTOR, operationId: 'detached-lock',
    }),
    (error) => error?.code === 'BACKUP_TARGET_LOCK_INVALID',
  );
  assert.equal(restored, true, 'outer restore waited for the detached callback before refusing and cleaning scratch');
});

test('the restore child is admitted only behind the coordinator witness fence', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'accordo-v4b-fence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundlePath = join(root, 'bundle');
  await operations().create({ bundlePath });
  const restoreProbe = join(root, 'pg-restore-probe');
  const psqlProbe = join(root, 'psql-probe');
  const preludeReceipt = join(root, 'prelude-receipt.sql');
  await writeFile(restoreProbe, `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf "pg_restore (PostgreSQL) 16.7\\n"
  exit 0
fi
for argument in "$@"; do
  case "$argument" in
    --file=*) printf -- "SELECT 1;\\n" > "${'$'}{argument#--file=}" ;;
  esac
done
`);
  // The child never reaches a live backend here, so the prelude it would have
  // executed is kept for inspection: this is the only place the fence is
  // observable without PostgreSQL.
  await writeFile(psqlProbe, `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf "psql (PostgreSQL) 16.7\\n"
  exit 0
fi
for argument in "$@"; do
  case "$argument" in
    --file=*.prelude.sql) cp "${'$'}{argument#--file=}" ${JSON.stringify(preludeReceipt)} ;;
    --file=*.postlude.sql)
      rendered="${'$'}{argument#--file=}"
      printf "accordo-restore-authority-v1|%s|%s|%s|%s\\n" \\
        "${source.bindingUuid}" "${source.tenantFingerprint}" \\
        "${source.resourceFingerprint}" "${source.migrationSetFingerprint}" \\
        > "${'$'}{rendered%.postlude.sql}.authority"
      ;;
  esac
done
`);
  await Promise.all([chmod(restoreProbe, 0o700), chmod(psqlProbe, 0o700)]);
  const provider = nativeWithFixtureAuthority({
    pgRestore: restoreProbe, psql: psqlProbe, createPool: nativeTargetPool(),
  });
  const restored = await createBackupOperations({
    adapter: 'postgresql', provider, evidence: source, connection,
    restoreControl: fixtureRestoreControl(),
  }).restore({
    bundlePath, expected, target: connection, actor: RESTORE_ACTOR, operationId: 'witnessed-restore',
  });
  assert.equal(restored.restored, true);

  const prelude = await readFile(preludeReceipt, 'utf8');
  assert.match(prelude, /^\\set ON_ERROR_STOP on$/m,
    'the child stops on the first error rather than continuing into the import');
  assert.match(prelude, /^BEGIN;$/m, 'the child opens the single transaction the import commits');
  assert.match(
    prelude,
    new RegExp(`pg_advisory_xact_lock\\(${DATA_RESTORE_CHILD_LOCK.classId}, ${DATA_RESTORE_CHILD_LOCK.objectId}\\)`),
    'the child holds the lock startup and a later restore both wait on',
  );
  assert.match(prelude, /^CREATE SCHEMA accordo;$/m,
    'the child creates the schema pg_restore --schema never emits, and refuses one that exists');
  // The witness objectId is chosen per run, so the fence is pinned by shape:
  // acquiring the coordinator's witness proves the coordinator is not there.
  // The witness object is a signed 32-bit draw, so half of all runs render it
  // negative — which PostgreSQL accepts, advisory lock keys being int4.
  const fence = prelude.match(
    /IF pg_try_advisory_lock\((-?\d+), (-?\d+)\) THEN\s+PERFORM pg_advisory_unlock\(\1, \2\);\s+RAISE EXCEPTION '[^']*' USING ERRCODE = '55000';/,
  );
  assert.ok(fence, 'the child refuses when it can take the witness, because that proves it reached elsewhere');
  assert.equal(Number(fence[1]), 1094927188, 'the witness is drawn from the reserved restore class');
  assert.notEqual(Number(fence[2]), 0, 'the witness object is a live identity, never a fixed zero');
});

test('a terminal non-success outcome refuses replay instead of touching the target again', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'accordo-v4b-replay-refused-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundlePath = join(root, 'bundle');
  await operations().create({ bundlePath });
  let lockEntries = 0;
  const provider = fixtureProvider({
    async withTargetLock(input, operation) {
      lockEntries += 1;
      return operation(lockedState(false));
    },
  });
  const restoreControl = fixtureRestoreControl();
  const restoreOperations = createBackupOperations({
    adapter: 'postgresql', provider, evidence: source, connection, restoreControl,
  });
  const request = {
    bundlePath, expected, target: connection, actor: RESTORE_ACTOR, operationId: 'terminal-refusal',
  };

  // A non-empty target closes the operation as refused, which is terminal.
  await assert.rejects(restoreOperations.restore(request),
    (error) => error?.code === 'BACKUP_TARGET_NOT_EMPTY');
  assert.equal(lockEntries, 1);

  // Replaying it must answer from the receipt alone: a closed refusal is an
  // answer, and reopening the target to re-derive it would be the mutation the
  // receipt exists to prevent.
  await assert.rejects(restoreOperations.restore(request), (error) => {
    assert.equal(error?.code, 'BACKUP_RESTORE_REPLAY_REFUSED');
    assert.equal(error?.details?.outcome, 'refused');
    return true;
  });
  assert.equal(lockEntries, 1, 'the refused replay never reaches the target lock again');
});
