// @ts-check

import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

const SENTINEL = 'backup-secret-sentinel-never-leak';
const LOCATOR = 'postgresql://sentinel.invalid/private';
const source = Object.freeze({
  contract: 1,
  adapter: 'postgresql',
  bindingUuid: '123e4567-e89b-42d3-a456-426614174000',
  tenantFingerprint: '1'.repeat(64),
  resourceFingerprint: '2'.repeat(64),
  migrationSetFingerprint: '3'.repeat(64),
  repositoryFingerprint: '4'.repeat(64),
});
const expected = Object.freeze({
  bindingUuid: source.bindingUuid,
  tenantFingerprint: source.tenantFingerprint,
  resourceFingerprint: source.resourceFingerprint,
  migrationSetFingerprint: source.migrationSetFingerprint,
  repositoryFingerprint: source.repositoryFingerprint,
});
const connection = Object.freeze({
  async withEnvironment(consumer) {
    return consumer({
      PGHOST: '127.0.0.1', PGPORT: '5432', PGDATABASE: 'fixture', PGUSER: 'fixture', PGPASSWORD: SENTINEL,
    });
  },
});

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
    async withTargetLock(_input, operation) { return operation({ empty: true }); },
    async restoreArtifact() {},
    ...overrides,
  });
}

function operations(provider = fixtureProvider()) {
  return createBackupOperations({
    adapter: 'postgresql', provider, evidence: source, connection,
    clock: () => '2026-08-31T12:00:00.000Z',
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
    expectedIntentKeys: ['bindingUuid', 'tenantFingerprint', 'resourceFingerprint', 'migrationSetFingerprint', 'repositoryFingerprint'],
    bundleEntries: ['artifact.dump', 'manifest.json'],
    nativeToolMajor: 16,
  });
  assert.throws(
    () => createBackupOperations({ adapter: 'sqlite', provider: fixtureProvider(), evidence: source, connection }),
    (error) => error?.code === 'BACKUP_ADAPTER_UNSUPPORTED',
  );
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

  const manifestBundle = join(root, 'manifest');
  await operations().create({ bundlePath: manifestBundle });
  await writeFile(join(manifestBundle, 'manifest.json'), JSON.stringify({ contract: 1, secret: SENTINEL }));
  await assert.rejects(operations().verify({ bundlePath: manifestBundle, expected }), (error) => {
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
});

test('create resolves a rotating connection once and binds inspection plus dump to that endpoint', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'accordo-v4b-affine-create-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let resolutions = 0;
  const seen = [];
  const rotating = Object.freeze({
    async withEnvironment(consumer) {
      resolutions += 1;
      return consumer({
        PGHOST: '127.0.0.1', PGPORT: '5432', PGDATABASE: `source-${resolutions}`,
        PGUSER: 'fixture', PGPASSWORD: `password-${resolutions}`,
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
  const hostileOptions = { provider: fixtureProvider(), evidence: source, connection };
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

  const envProbe = join(root, 'env-probe');
  await writeFile(envProbe, `#!/bin/sh
if [ -n "$ACCORDO_UNRELATED_CHILD_SENTINEL" ]; then
  exit 91
fi
if [ "$1" = "--version" ]; then
  printf "pg_dump (PostgreSQL) 16.7\\n"
  exit 0
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
  await operations(envProvider)
    .create({ bundlePath: join(root, 'env-bundle') });
});

test('non-empty target refuses before restore and provider failure is visibly partial', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'accordo-v4b-restore-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundlePath = join(root, 'bundle');
  await operations().create({ bundlePath });
  let restored = false;
  const occupied = fixtureProvider({
    async withTargetLock(_input, operation) { return operation({ empty: false }); },
    async restoreArtifact() { restored = true; },
  });
  await assert.rejects(operations(occupied).restore({ bundlePath, expected, target: connection }), (error) => error?.code === 'BACKUP_TARGET_NOT_EMPTY');
  assert.equal(restored, false);

  const partial = fixtureProvider({ async restoreArtifact() { throw new Error(`${SENTINEL} ${LOCATOR}`); } });
  await assert.rejects(operations(partial).restore({ bundlePath, expected, target: connection }), (error) => {
    assert.equal(error?.code, 'BACKUP_RESTORE_PARTIAL');
    assert.equal(error?.details?.targetState, 'possibly-partial');
    assertNoLeak(error);
    return true;
  });
});

test('restore consumes its verified private snapshot and rechecks those exact bytes afterward', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'accordo-v4b-snapshot-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundlePath = join(root, 'bundle');
  await operations().create({ bundlePath });

  const substitution = fixtureProvider({
    async withTargetLock(_input, operation) {
      await writeFile(join(bundlePath, 'artifact.dump'), 'substituted-after-verify');
      return operation({ empty: true });
    },
    async restoreArtifact({ artifactPath }) {
      assert.equal((await readFile(artifactPath, 'utf8')), 'closed-fixture-artifact');
      throw new Error('stop before database authority probe');
    },
  });
  await assert.rejects(
    operations(substitution).restore({ bundlePath, expected, target: connection }),
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
    operations(scratchMutation).restore({ bundlePath: changedBundle, expected, target: connection }),
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
  const rotatingTarget = Object.freeze({
    async withEnvironment(consumer) {
      resolutions += 1;
      return consumer({
        PGHOST: '127.0.0.1', PGPORT: '5432', PGDATABASE: `target-${resolutions}`,
        PGUSER: 'fixture', PGPASSWORD: `password-${resolutions}`,
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
      locked = true;
      try { return await operation({ empty: true }); } finally { locked = false; }
    },
    async restoreArtifact({ connection: bound }) { await observe(bound); },
    async inspectAuthority({ connection: bound }) {
      assert.equal(locked, true, 'post-restore authority is inspected while the target fence is held');
      await observe(bound);
      return {
        bindingUuid: source.bindingUuid,
        tenantFingerprint: source.tenantFingerprint,
        resourceFingerprint: source.resourceFingerprint,
        migrationSetFingerprint: source.migrationSetFingerprint,
      };
    },
  });
  const restoreOperations = createBackupOperations({
    adapter: 'postgresql', provider, evidence: source, connection,
  });
  assert.equal((await restoreOperations.restore({ bundlePath, expected, target: rotatingTarget })).restored, true);
  assert.equal(resolutions, 1);
  assert.deepEqual(seen, ['target-1', 'target-1', 'target-1']);
  assert.equal(locked, false);
});

test('target-lock provider cannot return before its unique callback settles', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'accordo-v4b-lock-settlement-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundlePath = join(root, 'bundle');
  await operations().create({ bundlePath });
  let restored = false;
  const provider = fixtureProvider({
    async withTargetLock(_input, operation) {
      void operation({ empty: true });
      return undefined;
    },
    async restoreArtifact({ artifactPath }) {
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal((await readFile(artifactPath, 'utf8')), 'closed-fixture-artifact');
      restored = true;
    },
  });
  await assert.rejects(
    operations(provider).restore({ bundlePath, expected, target: connection }),
    (error) => error?.code === 'BACKUP_TARGET_LOCK_INVALID',
  );
  assert.equal(restored, true, 'outer restore waited for the detached callback before refusing and cleaning scratch');
});
