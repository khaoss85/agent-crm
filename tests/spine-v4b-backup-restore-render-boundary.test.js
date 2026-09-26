// @ts-check

/**
 * TASKS.md:217 — the render/apply boundary in restore.
 *
 * A purely local render failure (missing binary, corrupt archive, no scratch
 * space) must not record `possibly-partial` and must not permanently refuse
 * replay of an operation id whose target was never opened. A failure after
 * the target was opened must still record `possibly-partial` and still
 * refuse replay.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  BACKUP_CONTRACT,
  createBackupOperations,
  defineBackupProvider,
} from '../packages/core/src/backup-restore.js';

const SENTINEL = 'render-boundary-secret-never-leak';
const FIXTURE_DIGEST = createHash('sha256').update('render-boundary-artifact').digest('hex');
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
const RESTORE_ACTOR = Object.freeze({ type: 'user', id: 'render-boundary-operator' });

function lockedState() {
  return Object.freeze({
    empty: true,
    lockedTarget: Object.freeze({}),
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

function fixtureRestoreControl(receipts = []) {
  const operations = new Map();
  return Object.freeze({
    contract: BACKUP_CONTRACT,
    async authorizeAndRecordAttempt(input) {
      const existing = operations.get(input.operationId);
      if (existing) {
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
      if (state.outcome !== null) {
        assert.equal(state.outcome, input.outcome);
        return;
      }
      state.outcome = input.outcome;
      receipts.push({ phase: 'outcome', input });
    },
  });
}

async function writeBundle(t) {
  const root = await mkdtemp(join(tmpdir(), 'accordo-v4b-render-boundary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundlePath = join(root, 'bundle');
  const seed = defineBackupProvider({
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
    async createArtifact({ artifactPath, connection: seedConnection }) {
      return seedConnection.withEnvironment(async () => {
        await writeFile(artifactPath, Buffer.from('render-boundary-artifact'));
        return { name: 'fixture', major: 16, version: 'fixture-16.0' };
      });
    },
    async prepareRestore() {},
    async withTargetLock(_input, operation) { return operation(lockedState()); },
    async renderRestoreArtifact({ renderedPath }) {
      await writeFile(renderedPath, Buffer.from('SELECT 1;'));
    },
    async applyRestoreArtifact() {},
  });
  await createBackupOperations({
    adapter: 'postgresql', provider: seed, evidence: source, connection,
    restoreControl: fixtureRestoreControl(),
    clock: () => '2026-08-31T12:00:00.000Z',
  }).create({ bundlePath });
  return bundlePath;
}

test('a render failure that never opened the target records no outcome and leaves the operation id replayable', async (t) => {
  const bundlePath = await writeBundle(t);
  const receipts = [];
  let renderCalls = 0;
  let renderFails = true;
  let applied = false;
  let lockEntries = 0;
  const provider = defineBackupProvider({
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
    async createArtifact() { throw new Error('unreachable'); },
    async prepareRestore() {},
    async withTargetLock(_input, operation) {
      lockEntries += 1;
      return operation(lockedState());
    },
    async renderRestoreArtifact({ renderedPath }) {
      renderCalls += 1;
      if (renderFails) throw new Error('pg_restore is missing: purely local render failure');
      await writeFile(renderedPath, Buffer.from('SELECT 1;'));
    },
    async applyRestoreArtifact() { applied = true; },
  });
  const restoreOperations = createBackupOperations({
    adapter: 'postgresql', provider, evidence: source, connection,
    restoreControl: fixtureRestoreControl(receipts),
    clock: () => '2026-08-31T12:00:00.000Z',
  });
  const request = {
    bundlePath, expected, target: connection, actor: RESTORE_ACTOR, operationId: 'render-failure-replay',
  };
  await assert.rejects(restoreOperations.restore(request), (error) => {
    assert.equal(error?.code, 'BACKUP_PROVIDER_FAILED');
    assert.equal(error?.details?.operation, 'render-restore');
    assert.notEqual(error?.details?.targetState, 'possibly-partial');
    return true;
  });
  assert.equal(applied, false, 'a render failure never reaches the apply step');
  assert.equal(lockEntries, 0, 'a render failure never reaches the target lock');
  assert.deepEqual(
    receipts.map((item) => [item.phase, item.input.outcome ?? null]),
    [],
    'a render failure records no attempt outcome at all, least of all possibly-partial',
  );

  renderFails = false;
  const retried = await restoreOperations.restore(request);
  assert.equal(retried.restored, true);
  assert.equal(retried.replayed, false, 'the retry is a first execution, not a replay');
  assert.equal(applied, true);
  assert.equal(renderCalls, 2);
});

test('a failure after the target was opened still records possibly-partial and still refuses replay', async (t) => {
  const bundlePath = await writeBundle(t);
  const receipts = [];
  let lockEntries = 0;
  const provider = defineBackupProvider({
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
    async createArtifact() { throw new Error('unreachable'); },
    async prepareRestore() {},
    async withTargetLock(_input, operation) {
      lockEntries += 1;
      return operation(lockedState());
    },
    async renderRestoreArtifact({ renderedPath }) {
      await writeFile(renderedPath, Buffer.from('SELECT 1;'));
    },
    async applyRestoreArtifact() { throw new Error('psql failed mid-apply: target is possibly partial'); },
  });
  const restoreOperations = createBackupOperations({
    adapter: 'postgresql', provider, evidence: source, connection,
    restoreControl: fixtureRestoreControl(receipts),
    clock: () => '2026-08-31T12:00:00.000Z',
  });
  const request = {
    bundlePath, expected, target: connection, actor: RESTORE_ACTOR, operationId: 'apply-failure-terminal',
  };
  await assert.rejects(restoreOperations.restore(request), (error) => {
    assert.equal(error?.code, 'BACKUP_RESTORE_PARTIAL');
    assert.equal(error?.details?.targetState, 'possibly-partial');
    return true;
  });
  assert.deepEqual(receipts.map((item) => [item.phase, item.input.outcome ?? null]), [
    ['attempted', null], ['outcome', 'possibly-partial'],
  ]);
  await assert.rejects(restoreOperations.restore(request), (error) => {
    assert.equal(error?.code, 'BACKUP_RESTORE_REPLAY_REFUSED');
    assert.equal(error?.details?.outcome, 'possibly-partial');
    return true;
  });
  assert.equal(lockEntries, 1, 'the refused replay never reaches the target lock again');
});
