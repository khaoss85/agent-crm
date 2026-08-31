import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createDurableJobStore } from '../packages/core/src/durable-jobs.js';
import { AuditLog } from '../packages/core/src/audit.js';
import { postgresqlTestStorage } from '../packages/app/src/portable-app.js';
import { bootPostgresqlApp } from './helpers/postgresql-application.js';

const jobInput = (root) => ({
  kind: 'named-workflow',
  handler: { name: 'run-renewal-review', contract: 1, version: 1 },
  payload: { contractId: root },
  idempotencyRoot: root,
});

const operator = Object.freeze({ type: 'user', id: 'pg-jobs-operator' });
const workerActor = Object.freeze({ type: 'system', id: 'pg-jobs-worker' });
const operatorContext = Object.freeze({ actor: operator });
const workerContext = Object.freeze({ actor: workerActor });

test('PostgreSQL claim authority uses transaction-affine FOR UPDATE SKIP LOCKED', () => {
  const source = readFileSync(new URL('../packages/core/src/durable-job-storage.js', import.meta.url), 'utf8');
  assert.match(source, /FOR UPDATE SKIP LOCKED/);
  assert.match(source, /WITH candidate AS/);
  assert.match(source, /claim_generation/);
  assert.match(source, /"attempt" = "attempt" - 1/);
});

test('V3A live PostgreSQL migration, concurrent claim, rollback, expiry, and fencing', { timeout: 90_000 }, async (t) => {
  let current = '2026-09-01T09:00:00.000Z';
  const result = await bootPostgresqlApp(t, { clock: () => current, moduleMigrations: [] });
  if (!result) return;
  const storage = postgresqlTestStorage(result.app);
  assert.ok(storage, 'application exposes its test-only bound data storage');
  const ids = ['pg-job-a', 'pg-job-b', 'pg-job-c', 'pg-job-d', 'pg-job-e', 'pg-job-f'];
  const claims = ['pg-claim-a', 'pg-claim-b', 'pg-claim-c', 'pg-claim-d', 'pg-claim-e', 'pg-claim-f'];
  const store = createDurableJobStore({
    storage, tenantId: result.tenantId, clock: () => current,
    idSource: () => ids.shift(), claimIdSource: () => claims.shift(),
  });

  const audit = new AuditLog({ storage });
  const scheduled = await store.enqueue(jobInput('pg-root-a'), operatorContext);
  current = '2026-09-01T09:00:00.100Z';
  assert.equal((await store.enqueue(jobInput('pg-root-a'), operatorContext)).id, scheduled.id);
  await assert.rejects(
    store.enqueue({ ...jobInput('pg-root-a'), scheduleAt: '2026-09-02T09:00:00.000Z' }, operatorContext),
    (error) => error.code === 'DURABLE_JOB_IDEMPOTENCY_MISMATCH',
  );
  const [left, right] = await Promise.all([
    store.claim('pg-worker-a', 1_000, workerContext),
    store.claim('pg-worker-b', 1_000, workerContext),
  ]);
  const winners = [left, right].filter(Boolean);
  assert.equal(winners.length, 1, 'two workers cannot execute one active claim concurrently');
  const first = winners[0];
  assert.equal(first.id, scheduled.id);
  assert.equal(await store.claim('pg-worker-c', 1_000, workerContext), null, 'active claim cannot be stolen');

  await assert.rejects(
    store.succeed(first, first.claim.workerId === 'pg-worker-a' ? 'pg-worker-b' : 'pg-worker-a', null, workerContext),
    (error) => error.code === 'DURABLE_JOB_CLAIM_FENCED',
  );
  current = '2026-09-01T09:00:01.100Z';
  const recovered = await store.claim('pg-worker-c', 1_000, workerContext);
  assert.equal(recovered.claim.generation, first.claim.generation + 1);
  await assert.rejects(
    store.succeed(first, first.claim.workerId, null, workerContext),
    (error) => error.code === 'DURABLE_JOB_CLAIM_FENCED',
  );
  assert.equal((await store.succeed(recovered, 'pg-worker-c', 'renewal-review:done', workerContext)).state, 'succeeded');

  const releasable = await store.enqueue(jobInput('pg-root-release'), operatorContext);
  const beforeHandler = await store.claim('pg-worker-a', 1_000, workerContext);
  assert.equal(beforeHandler.id, releasable.id);
  const released = await store.release(beforeHandler, 'pg-worker-a', workerContext);
  assert.equal(released.attempt, 0, 'a PostgreSQL pre-handler release does not consume execution budget');
  const afterRelease = await store.claim('pg-worker-b', 1_000, workerContext);
  assert.equal(afterRelease.attempt, 1);
  assert.equal(afterRelease.claim.generation, beforeHandler.claim.generation + 1);
  await store.succeed(afterRelease, 'pg-worker-b', null, workerContext);

  const auditCountBeforeRollback = (await audit.list({ entityType: 'durable_job' })).length;
  await assert.rejects(
    storage.transaction(async (tx) => {
      await store.enqueue(jobInput('pg-root-rollback'), { transaction: tx, actor: operator });
      throw new Error('rollback-pg-job');
    }),
    /rollback-pg-job/,
  );
  assert.equal((await store.list()).some((job) => job.idempotencyRoot === 'pg-root-rollback'), false);
  assert.equal((await audit.list({ entityType: 'durable_job' })).length, auditCountBeforeRollback,
    'rolled-back PostgreSQL job has no committed audit event');

  const events = await audit.list({ entityType: 'durable_job', entityId: scheduled.id });
  assert.deepEqual(events.map((event) => event.action).sort(), [
    'durable_job.claimed', 'durable_job.claimed', 'durable_job.enqueued', 'durable_job.succeeded',
  ]);
  assert.deepEqual(events.filter((event) => event.action === 'durable_job.claimed')
    .map((event) => event.data.claimGeneration).sort(), [1, 2]);
  assert.equal(JSON.stringify(events).includes('pg-root-a'), false, 'audit does not copy payload or idempotency root');

  const wrongTenant = createDurableJobStore({ storage, tenantId: 'wrong-tenant', clock: () => current });
  assert.equal(await wrongTenant.get(scheduled.id), null);
});
