// @ts-check

/**
 * A deterministic V4B backup fixture, reduced to what V4C's telemetry evidence
 * needs. It deliberately loads the connection, the manifest source and the
 * bundle path with sentinels: the point of the fixture is that a real create /
 * verify / restore runs against material the exporter must never carry.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  BACKUP_CONTRACT,
  createBackupOperations,
  defineBackupProvider,
} from '../../packages/core/src/backup-restore.js';

export const BACKUP_SENTINELS = Object.freeze({
  backupPassword: 'v4c-BACKUP-PGPASSWORD-SENTINEL',
  backupLocator: 'postgresql://backup.sentinel.invalid:5432/private',
});

const CREATED_AT = '2026-09-01T12:00:00.000Z';
const ARTIFACT_BYTES = 'v4c-closed-fixture-artifact';
const ARTIFACT_DIGEST = createHash('sha256').update(ARTIFACT_BYTES).digest('hex');

const source = Object.freeze({
  contract: 1,
  adapter: 'postgresql',
  bindingUuid: '123e4567-e89b-42d3-a456-426614174000',
  tenantFingerprint: '1'.repeat(64),
  resourceFingerprint: '2'.repeat(64),
  migrationSetFingerprint: '3'.repeat(64),
  repositoryFingerprint: '4'.repeat(64),
});

const MANIFEST_DIGEST = createHash('sha256').update(`${JSON.stringify({
  contract: 1,
  adapter: 'postgresql',
  createdAt: CREATED_AT,
  source: Object.fromEntries(Object.entries(source).filter(([key]) => !['contract', 'adapter'].includes(key))),
  artifact: { algorithm: 'sha256', digest: ARTIFACT_DIGEST },
  provider: { contract: 1, name: 'fixture', tool: { name: 'fixture', major: 16, version: 'fixture-16.0' } },
}, null, 2)}\n`).digest('hex');

const expected = Object.freeze({
  bindingUuid: source.bindingUuid,
  tenantFingerprint: source.tenantFingerprint,
  resourceFingerprint: source.resourceFingerprint,
  migrationSetFingerprint: source.migrationSetFingerprint,
  repositoryFingerprint: source.repositoryFingerprint,
  artifactDigest: ARTIFACT_DIGEST,
  manifestDigest: MANIFEST_DIGEST,
  targetResourceFingerprint: source.resourceFingerprint,
});

const connection = Object.freeze({
  resourceFingerprint: source.resourceFingerprint,
  async withEnvironment(consumer) {
    return consumer({
      PGHOST: '127.0.0.1', PGPORT: '5432', PGDATABASE: 'private',
      PGUSER: 'fixture', PGPASSWORD: BACKUP_SENTINELS.backupPassword, PGSSLMODE: 'disable',
    });
  },
});

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

function restoreControl() {
  const operations = new Map();
  return Object.freeze({
    contract: BACKUP_CONTRACT,
    async authorizeAndRecordAttempt(input) {
      const existing = operations.get(input.operationId);
      if (existing) {
        return {
          id: existing.id, attempt: 'existing', outcome: existing.outcome,
          artifactDigest: existing.artifactDigest, manifestDigest: existing.manifestDigest,
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
      return {
        id: state.id, attempt: 'new', outcome: null,
        artifactDigest: state.artifactDigest, manifestDigest: state.manifestDigest,
        targetResourceFingerprint: state.targetResourceFingerprint,
      };
    },
    async recordOutcome(input) {
      const state = operations.get(input.operationId);
      assert.ok(state);
      if (state.outcome === null) state.outcome = input.outcome;
    },
  });
}

/**
 * @param {import('node:test').TestContext} t
 * @param {any} telemetry
 * @param {{partialRestore?: boolean}} [options]
 */
export async function backupFixture(t, telemetry, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'accordo-v4c-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
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
    async createArtifact({ artifactPath, connection: bound }) {
      return bound.withEnvironment(async (environment) => {
        assert.equal(environment.PGPASSWORD, BACKUP_SENTINELS.backupPassword);
        await writeFile(artifactPath, Buffer.from(ARTIFACT_BYTES));
        return { name: 'fixture', major: 16, version: 'fixture-16.0' };
      });
    },
    async prepareRestore() {},
    async withTargetLock(_input, operation) { return operation(lockedState()); },
    async restoreArtifact() {
      if (options.partialRestore) {
        throw Object.assign(new Error(BACKUP_SENTINELS.backupLocator), { code: 'FIXTURE_RESTORE_FAILED' });
      }
    },
  });
  return {
    bundlePath: join(dir, 'bundle'),
    expected,
    source,
    target: connection,
    operations: createBackupOperations({
      adapter: 'postgresql', provider, evidence: source, connection,
      restoreControl: restoreControl(),
      clock: () => CREATED_AT,
      ...(telemetry ? { telemetry } : {}),
    }),
  };
}
