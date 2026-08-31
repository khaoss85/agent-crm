import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDatabase } from '../packages/core/src/database.js';
import { AppError } from '../packages/core/src/errors.js';
import {
  DURABLE_JOB_CONTRACT,
  DURABLE_JOB_STATES,
  canonicalJobPayload,
  createDurableJobHandlerRegistry,
  createDurableJobStore,
  createDurableJobWorker,
} from '../packages/core/src/durable-jobs.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'accordo-v3a-'));
  const path = join(dir, 'jobs.sqlite');
  let current = '2026-09-01T09:00:00.000Z';
  const clock = () => current;
  const database = createDatabase({ path, plane: 'data' });
  const ids = Array.from({ length: 20 }, (_unused, index) => `job-${index + 1}`);
  const claims = Array.from({ length: 40 }, (_unused, index) => `claim-${index + 1}`);
  const store = createDurableJobStore({
    storage: database.storage, tenantId: 'tenant-a', clock,
    idSource: () => ids.shift(), claimIdSource: () => claims.shift(),
  });
  t.after(() => {
    try { database.close(); } catch {}
    rmSync(dir, { recursive: true, force: true });
  });
  return { path, database, store, clock, setNow(value) { current = value; } };
}

const input = (root, extra = {}) => ({
  kind: 'named-action',
  handler: { name: 'run-follow-up', contract: 1, version: 1 },
  payload: { recordId: root },
  idempotencyRoot: root,
  ...extra,
});

test('V3A contract is closed and payload fingerprints are canonical without secret-shaped fields', () => {
  assert.equal(DURABLE_JOB_CONTRACT, 1);
  assert.deepEqual(DURABLE_JOB_STATES, [
    'pending', 'claimed', 'succeeded', 'failed_retryable', 'failed_terminal', 'cancelled',
  ]);
  assert.equal(
    canonicalJobPayload({ z: 1, a: { b: true } }).fingerprint,
    canonicalJobPayload({ a: { b: true }, z: 1 }).fingerprint,
  );
  assert.throws(() => canonicalJobPayload({ password: 'SUPERSECRET_JOB_SENTINEL' }), (error) => {
    assert.match(error.message, /credential-shaped/);
    assert.equal(JSON.stringify(error).includes('SUPERSECRET_JOB_SENTINEL'), false);
    return true;
  });
  assert.throws(() => canonicalJobPayload({ n: 1.5 }), /JSON-safe/);
});

test('SQLite schedules at the exact UTC boundary, reschedules one pending job, cancels, and survives restart', async (t) => {
  const f = fixture(t);
  const future = '2026-09-01T10:00:00.000Z';
  const job = await f.store.enqueue(input('root-a', { scheduleAt: future }));
  assert.equal(job.state, 'pending');
  assert.equal(await f.store.claim('worker-a', 30_000), null, 'not due before scheduleAt');

  await f.store.reschedule(job.id, '2026-09-01T09:30:00.000Z');
  f.setNow('2026-09-01T09:29:59.999Z');
  assert.equal(await f.store.claim('worker-a', 30_000), null);
  f.setNow('2026-09-01T09:30:00.000Z');
  const claimed = await f.store.claim('worker-a', 30_000);
  assert.equal(claimed.id, job.id, 'due exactly at scheduleAt');
  await f.store.succeed(claimed, 'worker-a', 'outcome:one');

  const cancelled = await f.store.enqueue(input('root-b'));
  await f.store.cancel(cancelled.id);
  assert.equal((await f.store.get(cancelled.id)).state, 'cancelled');
  assert.equal(await f.store.claim('worker-a', 30_000), null, 'cancelled job never runs');
  const restartFuture = await f.store.enqueue(input('root-restart', {
    scheduleAt: '2026-09-02T09:00:00.000Z',
  }));

  f.database.close();
  const reopened = createDatabase({ path: f.path, plane: 'data' });
  t.after(() => reopened.close());
  const restartedStore = createDurableJobStore({ storage: reopened.storage, tenantId: 'tenant-a', clock: f.clock });
  assert.equal((await restartedStore.get(job.id)).outcomeReference, 'outcome:one');
  assert.equal((await restartedStore.get(cancelled.id)).state, 'cancelled');
  assert.equal((await restartedStore.get(restartFuture.id)).scheduleAt, '2026-09-02T09:00:00.000Z');
  assert.equal((await restartedStore.get(restartFuture.id)).state, 'pending');
});

test('enqueue joins a caller transaction and rollback leaves no durable work', async (t) => {
  const f = fixture(t);
  await assert.rejects(
    f.database.storage.transaction(async (tx) => {
      await f.store.enqueue(input('root-rollback'), { transaction: tx });
      throw new Error('rollback');
    }),
    /rollback/,
  );
  assert.deepEqual(await f.store.list(), []);

  const otherPath = join(tmpdir(), `accordo-v3a-other-${process.pid}-${Date.now()}.sqlite`);
  const other = createDatabase({ path: otherPath, plane: 'data' });
  t.after(() => { try { other.close(); } finally { rmSync(otherPath, { force: true }); } });
  await assert.rejects(
    other.storage.transaction(async (tx) => f.store.enqueue(input('root-wrong-storage'), { transaction: tx })),
    (error) => error.code === 'DURABLE_JOB_TRANSACTION_MISMATCH',
  );
  assert.deepEqual(await f.store.list(), []);
});

test('claims fence workers, tenants, generations, active leases, and recover exactly at expiry', async (t) => {
  const f = fixture(t);
  const job = await f.store.enqueue(input('root-claim'));
  const first = await f.store.claim('worker-a', 1_000);
  assert.equal(first.id, job.id);
  assert.equal(first.attempt, 1);
  assert.equal(await f.store.claim('worker-b', 1_000), null, 'active claim cannot be stolen');
  await assert.rejects(f.store.succeed(first, 'worker-b'), (error) => error.code === 'DURABLE_JOB_CLAIM_FENCED');
  const wrongFingerprint = { ...first, claim: { ...first.claim, claimId: 'wrong-claim-fingerprint' } };
  await assert.rejects(f.store.succeed(wrongFingerprint, 'worker-a'), (error) => error.code === 'DURABLE_JOB_CLAIM_FENCED');

  const wrongTenant = createDurableJobStore({ storage: f.database.storage, tenantId: 'tenant-b', clock: f.clock });
  await assert.rejects(wrongTenant.succeed(first, 'worker-a'), (error) => error.code === 'DURABLE_JOB_CLAIM_FENCED');

  f.setNow('2026-09-01T09:00:00.999Z');
  assert.equal(await f.store.claim('worker-b', 1_000), null);
  f.setNow('2026-09-01T09:00:01.000Z');
  const recovered = await f.store.claim('worker-b', 1_000);
  assert.equal(recovered.claim.generation, first.claim.generation + 1);
  assert.equal(recovered.attempt, 2);
  await assert.rejects(f.store.succeed(first, 'worker-a'), (error) => error.code === 'DURABLE_JOB_CLAIM_FENCED');
  assert.equal((await f.store.succeed(recovered, 'worker-b')).state, 'succeeded');
});

test('idempotency root resolves the same work and refuses a semantic mismatch', async (t) => {
  const f = fixture(t);
  const first = await f.store.enqueue(input('root-idempotent'));
  f.setNow('2026-09-01T09:00:10.000Z');
  const same = await f.store.enqueue(input('root-idempotent'));
  assert.equal(same.id, first.id);
  await assert.rejects(
    f.store.enqueue(input('root-idempotent', { payload: { recordId: 'different' } })),
    (error) => error.code === 'DURABLE_JOB_IDEMPOTENCY_MISMATCH',
  );
});

test('corrupt claim metadata is refused instead of being normalized into a job', async (t) => {
  const f = fixture(t);
  const job = await f.store.enqueue(input('root-corrupt-claim'));
  f.database.raw.prepare('UPDATE spine_jobs SET claim_id = ? WHERE id = ?').run('smuggled-claim', job.id);
  await assert.rejects(
    f.store.get(job.id),
    (error) => error.code === 'DURABLE_JOB_ROW_INVALID' && error.details.field === 'claim',
  );
});

test('an expired final claim becomes terminal instead of running beyond maxAttempts', async (t) => {
  const f = fixture(t);
  const job = await f.store.enqueue(input('root-exhausted', { maxAttempts: 1 }));
  await f.store.claim('worker-a', 1_000);
  f.setNow('2026-09-01T09:00:01.000Z');
  assert.equal(await f.store.claim('worker-b', 1_000), null);
  const exhausted = await f.store.get(job.id);
  assert.equal(exhausted.state, 'failed_terminal');
  assert.equal(exhausted.lastErrorCode, 'JOB_ATTEMPTS_EXHAUSTED_AFTER_LEASE');
  assert.equal(exhausted.attempt, 1);
});

test('owner-fenced pre-handler releases do not consume attempts, including external handlers', async (t) => {
  const f = fixture(t);
  for (const [root, sideEffect] of [
    ['root-release-ordinary', 'none'],
    ['root-release-external', 'external-operation-v2'],
  ]) {
    const job = await f.store.enqueue(input(root, { maxAttempts: 1 }));
    let generation = 0;
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const claim = await f.store.claim('worker-a', 30_000);
      assert.equal(claim.attempt, 1);
      assert.ok(claim.claim.generation > generation);
      generation = claim.claim.generation;
      const released = await f.store.release(claim, 'worker-a');
      assert.equal(released.state, 'failed_retryable');
      assert.equal(released.attempt, 0);
      assert.equal(released.lastErrorCode, 'JOB_CLAIM_RELEASED');
    }
    let calls = 0;
    const registry = createDurableJobHandlerRegistry();
    registry.register({
      kind: 'named-action', name: 'run-follow-up', version: 1, sideEffect,
      async execute() { calls += 1; return { outcomeReference: `${root}:done` }; },
    });
    const worker = createDurableJobWorker({
      store: f.store, registry, workerId: 'worker-b', clock: f.clock, pollIntervalMs: 60_000,
    });
    worker.start();
    const completed = await worker.poll();
    assert.equal(completed.id, job.id);
    assert.equal(completed.state, 'succeeded');
    assert.equal(completed.attempt, 1);
    assert.equal(calls, 1, `${sideEffect} handler executes after release without false reconciliation`);
    await worker.close();
  }
});

test('worker retries only closed transient failures with injected backoff and then succeeds', async (t) => {
  const f = fixture(t);
  let calls = 0;
  const registry = createDurableJobHandlerRegistry();
  registry.register({
    kind: 'named-action', name: 'run-follow-up', version: 1,
    async execute() {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('bounded'), { code: 'JOB_HANDLER_TEMPORARY_UNAVAILABLE' });
      return { outcomeReference: 'action:done' };
    },
  });
  const worker = createDurableJobWorker({
    store: f.store, registry, workerId: 'worker-a', clock: f.clock,
    pollIntervalMs: 60_000, backoff: () => 500,
  });
  assert.deepEqual(worker.status(), { accepting: false, closed: false, polling: false, inFlight: false, wakeScheduled: false, lastWorkerErrorCode: null });
  await f.store.enqueue(input('root-retry'));
  worker.start();
  const failed = await worker.poll();
  assert.equal(failed.state, 'failed_retryable');
  assert.equal(failed.scheduleAt, '2026-09-01T09:00:00.500Z');
  assert.equal(failed.lastErrorCode, 'JOB_HANDLER_TEMPORARY_UNAVAILABLE');
  f.setNow('2026-09-01T09:00:00.499Z');
  assert.equal(await worker.poll(), null);
  f.setNow('2026-09-01T09:00:00.500Z');
  assert.equal((await worker.poll()).state, 'succeeded');
  assert.equal(calls, 2);
  assert.deepEqual(await worker.close(), { drained: true });
  assert.deepEqual(worker.status(), { accepting: false, closed: true, polling: false, inFlight: false, wakeScheduled: false, lastWorkerErrorCode: null });
});

test('timer poll survives a hostile code getter, exposes bounded status, and recovers', async () => {
  let claimMode = 'hostile';
  let attempted;
  const firstAttempt = new Promise((resolve) => { attempted = resolve; });
  const store = {
    now: () => '2026-09-01T09:00:00.000Z',
    async claim() {
      attempted();
      if (claimMode === 'hostile') {
        const hostile = new Error('credential-shaped storage detail must not enter status');
        Object.defineProperty(hostile, 'code', {
          get() { throw new Error('hostile-code-getter-do-not-export'); },
        });
        throw hostile;
      }
      if (claimMode === 'bounded') {
        throw new AppError('credential-shaped storage detail must not enter status', {
          code: 'DURABLE_JOB_STORAGE_UNAVAILABLE', status: 500, details: { secret: 'do-not-export' },
        });
      }
      return null;
    },
  };
  const worker = createDurableJobWorker({
    store, registry: createDurableJobHandlerRegistry(), workerId: 'worker-a', pollIntervalMs: 60_000,
  });
  worker.start();
  worker.wake();
  await firstAttempt;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(worker.status().lastWorkerErrorCode, 'DURABLE_JOB_POLL_FAILED');
  assert.equal(worker.status().wakeScheduled, true, 'timer loop remains scheduled after hostile rejection');
  assert.equal(JSON.stringify(worker.status()).includes('hostile-code-getter-do-not-export'), false);
  claimMode = 'bounded';
  await assert.rejects(worker.poll(), (error) => error.code === 'DURABLE_JOB_STORAGE_UNAVAILABLE');
  assert.equal(worker.status().lastWorkerErrorCode, 'DURABLE_JOB_STORAGE_UNAVAILABLE');
  assert.equal(JSON.stringify(worker.status()).includes('do-not-export'), false);
  claimMode = 'recovered';
  assert.equal(await worker.poll(), null);
  assert.equal(worker.status().lastWorkerErrorCode, null);
  await worker.close();
});

test('handler error code accessors are never invoked or persisted', async (t) => {
  const f = fixture(t);
  const registry = createDurableJobHandlerRegistry();
  registry.register({
    kind: 'named-action', name: 'run-follow-up', version: 1,
    async execute() {
      const hostile = new Error('handler detail must stay bounded');
      Object.defineProperty(hostile, 'code', {
        get() { throw new Error('handler-code-getter-do-not-export'); },
      });
      throw hostile;
    },
  });
  const worker = createDurableJobWorker({
    store: f.store, registry, workerId: 'worker-a', clock: f.clock, pollIntervalMs: 60_000,
  });
  await f.store.enqueue(input('root-hostile-handler'));
  worker.start();
  const failed = await worker.poll();
  assert.equal(failed.state, 'failed_terminal');
  assert.equal(failed.lastErrorCode, 'JOB_HANDLER_FAILED');
  assert.equal(JSON.stringify(failed).includes('handler-code-getter-do-not-export'), false);
  await worker.close();
});

test('terminal and external-operation failures never retry implicitly', async (t) => {
  const f = fixture(t);
  const registry = createDurableJobHandlerRegistry();
  registry.register({
    kind: 'named-action', name: 'run-follow-up', version: 1,
    sideEffect: 'external-operation-v2',
    async execute() { throw Object.assign(new Error('provider unknown'), { code: 'JOB_HANDLER_TEMPORARY_UNAVAILABLE' }); },
  });
  const worker = createDurableJobWorker({ store: f.store, registry, workerId: 'worker-a', clock: f.clock, pollIntervalMs: 60_000 });
  await f.store.enqueue(input('root-external'));
  worker.start();
  const result = await worker.poll();
  assert.equal(result.state, 'failed_terminal');
  assert.equal(result.lastErrorCode, 'JOB_EXTERNAL_OUTCOME_RECONCILIATION_REQUIRED');
  assert.equal(await worker.poll(), null);
  await worker.close();
});

test('an expired external-operation claim is reconciled, never called a second time', async (t) => {
  const f = fixture(t);
  let release;
  let calls = 0;
  let observedIdentity;
  const held = new Promise((resolve) => { release = resolve; });
  const registry = createDurableJobHandlerRegistry();
  registry.register({
    kind: 'named-action', name: 'run-follow-up', version: 1,
    sideEffect: 'external-operation-v2',
    async execute(context) {
      calls += 1;
      observedIdentity = context.externalOperationId;
      return held;
    },
  });
  const firstWorker = createDurableJobWorker({
    store: f.store, registry, workerId: 'worker-a', clock: f.clock,
    pollIntervalMs: 60_000, leaseMs: 1_000,
  });
  const recoveryWorker = createDurableJobWorker({
    store: f.store, registry, workerId: 'worker-b', clock: f.clock,
    pollIntervalMs: 60_000, leaseMs: 1_000,
  });
  await f.store.enqueue(input('root-external-expiry'));
  firstWorker.start();
  const firstPoll = firstWorker.poll();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(observedIdentity, 'root-external-expiry');

  f.setNow('2026-09-01T09:00:01.000Z');
  recoveryWorker.start();
  const recovered = await recoveryWorker.poll();
  assert.equal(recovered.state, 'failed_terminal');
  assert.equal(recovered.lastErrorCode, 'JOB_EXTERNAL_OUTCOME_RECONCILIATION_REQUIRED');
  assert.equal(calls, 1, 'recovered external effect never calls the provider again');

  release({ outcomeReference: 'provider:late' });
  await assert.rejects(firstPoll, (error) => error.code === 'DURABLE_JOB_CLAIM_FENCED');
  await firstWorker.close();
  await recoveryWorker.close();
});

test('drain is bounded, stops claims, clears its timer, and keeps an active lease fenced', async (t) => {
  const f = fixture(t);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const registry = createDurableJobHandlerRegistry();
  registry.register({ kind: 'named-action', name: 'run-follow-up', version: 1, execute: () => held });
  const worker = createDurableJobWorker({ store: f.store, registry, workerId: 'worker-a', clock: f.clock, pollIntervalMs: 60_000 });
  await f.store.enqueue(input('root-drain'));
  worker.start();
  const polling = worker.poll();
  await new Promise((resolve) => setImmediate(resolve));
  const close = await worker.close({ timeoutMs: 5 });
  assert.deepEqual(close, { drained: false, code: 'DURABLE_JOB_DRAIN_TIMEOUT' });
  assert.equal(worker.status().accepting, false);
  assert.equal(worker.status().wakeScheduled, false);
  assert.equal(await f.store.claim('worker-b', 30_000), null, 'close does not unsafely release executing work');
  release({ outcomeReference: 'late-safe-finish' });
  assert.equal((await polling).state, 'succeeded');
});
