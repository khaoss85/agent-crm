import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createDurableJobStore } from '../packages/core/src/durable-jobs.js';
import { postgresqlTestStorage } from '../packages/app/src/portable-app.js';
import { bootPostgresqlApp } from './helpers/postgresql-application.js';

const jobInput = (root) => ({
  kind: 'named-workflow',
  handler: { name: 'run-renewal-review', contract: 1, version: 1 },
  payload: { contractId: root },
  idempotencyRoot: root,
});

test('PostgreSQL claim authority uses transaction-affine FOR UPDATE SKIP LOCKED', () => {
  const source = readFileSync(new URL('../packages/core/src/durable-job-storage.js', import.meta.url), 'utf8');
  assert.match(source, /FOR UPDATE SKIP LOCKED/);
  assert.match(source, /WITH candidate AS/);
  assert.match(source, /claim_generation/);
});

test('V3A live PostgreSQL migration, concurrent claim, rollback, expiry, and fencing', { timeout: 90_000 }, async (t) => {
  let current = '2026-09-01T09:00:00.000Z';
  const result = await bootPostgresqlApp(t, { clock: () => current, moduleMigrations: [] });
  if (!result) return;
  const storage = postgresqlTestStorage(result.app);
  assert.ok(storage, 'application exposes its test-only bound data storage');
  const ids = ['pg-job-a', 'pg-job-b', 'pg-job-c'];
  const claims = ['pg-claim-a', 'pg-claim-b', 'pg-claim-c', 'pg-claim-d'];
  const store = createDurableJobStore({
    storage, tenantId: result.tenantId, clock: () => current,
    idSource: () => ids.shift(), claimIdSource: () => claims.shift(),
  });

  const scheduled = await store.enqueue(jobInput('pg-root-a'));
  const [left, right] = await Promise.all([
    store.claim('pg-worker-a', 1_000),
    store.claim('pg-worker-b', 1_000),
  ]);
  const winners = [left, right].filter(Boolean);
  assert.equal(winners.length, 1, 'two workers cannot execute one active claim concurrently');
  const first = winners[0];
  assert.equal(first.id, scheduled.id);
  assert.equal(await store.claim('pg-worker-c', 1_000), null, 'active claim cannot be stolen');

  await assert.rejects(
    store.succeed(first, first.claim.workerId === 'pg-worker-a' ? 'pg-worker-b' : 'pg-worker-a'),
    (error) => error.code === 'DURABLE_JOB_CLAIM_FENCED',
  );
  current = '2026-09-01T09:00:01.000Z';
  const recovered = await store.claim('pg-worker-c', 1_000);
  assert.equal(recovered.claim.generation, first.claim.generation + 1);
  await assert.rejects(
    store.succeed(first, first.claim.workerId),
    (error) => error.code === 'DURABLE_JOB_CLAIM_FENCED',
  );
  assert.equal((await store.succeed(recovered, 'pg-worker-c', 'renewal-review:done')).state, 'succeeded');

  await assert.rejects(
    storage.transaction(async (tx) => {
      await store.enqueue(jobInput('pg-root-rollback'), { transaction: tx });
      throw new Error('rollback-pg-job');
    }),
    /rollback-pg-job/,
  );
  assert.equal((await store.list()).some((job) => job.idempotencyRoot === 'pg-root-rollback'), false);

  const wrongTenant = createDurableJobStore({ storage, tenantId: 'wrong-tenant', clock: () => current });
  assert.equal(await wrongTenant.get(scheduled.id), null);
});
