import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';

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
import { AuditLog } from '../packages/core/src/audit.js';

const operator = Object.freeze({ type: 'user', id: 'jobs-operator' });
const systemActor = Object.freeze({ type: 'system', id: 'jobs-worker' });
const operatorContext = Object.freeze({ actor: operator });
const workerContext = Object.freeze({ actor: systemActor });

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
    assert.equal(error.code, 'DURABLE_JOB_PAYLOAD_INVALID');
    assert.equal(JSON.stringify(error).includes('SUPERSECRET_JOB_SENTINEL'), false);
    return true;
  });
  assert.throws(() => canonicalJobPayload({ n: 1.5 }), (error) => error.code === 'DURABLE_JOB_PAYLOAD_INVALID');
});

test('canonical payload inspection never invokes accessors and collapses hostile proxies without leakage', () => {
  const sentinel = 'HOSTILE_PAYLOAD_SENTINEL_DO_NOT_EXPORT';
  let objectGetterCalls = 0;
  const object = {};
  Object.defineProperty(object, 'recordId', {
    enumerable: true,
    get() { objectGetterCalls += 1; throw new Error(sentinel); },
  });
  let arrayGetterCalls = 0;
  const array = [];
  Object.defineProperty(array, '0', {
    enumerable: true, configurable: true,
    get() { arrayGetterCalls += 1; throw new Error(sentinel); },
  });
  array.length = 1;
  const proxy = new Proxy({}, {
    ownKeys() { throw new Error(sentinel); },
  });

  for (const payload of [object, { nested: array }, { nested: proxy }]) {
    assert.throws(() => canonicalJobPayload(payload), (error) => {
      assert.equal(error.code, 'DURABLE_JOB_PAYLOAD_INVALID');
      const blob = [
        error.message, error.code, error.stack, JSON.stringify(error),
        inspect(error, { depth: 12 }), JSON.stringify(error.details), String(error.cause ?? ''),
      ].join('\n');
      assert.equal(blob.includes(sentinel), false);
      assert.equal(error.details, undefined);
      assert.equal(error.cause, undefined);
      return true;
    });
  }
  assert.equal(objectGetterCalls, 0);
  assert.equal(arrayGetterCalls, 0);
});

test('enqueue snapshots its input and handler without invoking hostile accessors or leaking failures', async (t) => {
  const f = fixture(t);
  const sentinel = 'HOSTILE_ENQUEUE_SENTINEL_DO_NOT_EXPORT';
  let getterCalls = 0;
  const hostilePayload = input('hostile-top-payload');
  Object.defineProperty(hostilePayload, 'payload', {
    enumerable: true,
    get() { getterCalls += 1; throw new Error(sentinel); },
  });
  const hostileHandler = input('hostile-top-handler');
  Object.defineProperty(hostileHandler, 'handler', {
    enumerable: true,
    get() { getterCalls += 1; throw new Error(sentinel); },
  });
  const nestedHandler = { contract: 1, version: 1 };
  Object.defineProperty(nestedHandler, 'name', {
    enumerable: true,
    get() { getterCalls += 1; throw new Error(sentinel); },
  });
  const hostileHandlerField = input('hostile-handler-field', { handler: nestedHandler });
  const hostileProxy = new Proxy(input('hostile-envelope-proxy'), {
    ownKeys() { throw new Error(sentinel); },
  });

  for (const candidate of [hostilePayload, hostileHandler, hostileHandlerField, hostileProxy]) {
    await assert.rejects(f.store.enqueue(candidate, operatorContext), (error) => {
      assert.equal(error.code, 'DURABLE_JOB_INPUT_INVALID');
      const blob = [
        error.message, error.code, error.stack, JSON.stringify(error),
        inspect(error, { depth: 12 }), JSON.stringify(error.details), String(error.cause ?? ''),
      ].join('\n');
      assert.equal(blob.includes(sentinel), false);
      assert.equal(error.details, undefined);
      assert.equal(error.cause, undefined);
      return true;
    });
  }
  assert.equal(getterCalls, 0);
});

test('mutation contexts snapshot actor authority without invoking hostile accessors or leaking failures', async (t) => {
  const f = fixture(t);
  const sentinel = 'HOSTILE_ACTOR_CONTEXT_SENTINEL_DO_NOT_EXPORT';
  let getterCalls = 0;
  const hostileActorContext = {};
  Object.defineProperty(hostileActorContext, 'actor', {
    enumerable: true,
    get() { getterCalls += 1; throw new Error(sentinel); },
  });
  const hostileContextProxy = new Proxy({ actor: systemActor }, {
    ownKeys() { throw new Error(sentinel); },
  });
  const assertRefusedWithoutLeak = (error) => {
    assert.equal(error.code, 'DURABLE_JOB_INPUT_INVALID');
    const blob = [
      error.message, error.code, error.stack, JSON.stringify(error),
      inspect(error, { depth: 12 }), JSON.stringify(error.details), String(error.cause ?? ''),
    ].join('\n');
    assert.equal(blob.includes(sentinel), false);
    assert.equal(error.details, undefined);
    assert.equal(error.cause, undefined);
    return true;
  };

  await assert.rejects(
    f.store.enqueue(input('hostile-actor-context'), hostileActorContext),
    assertRefusedWithoutLeak,
  );
  await f.store.enqueue(input('hostile-lifecycle-context'), operatorContext);
  await assert.rejects(f.store.claim('worker-a', 30_000, hostileActorContext), assertRefusedWithoutLeak);
  await assert.rejects(f.store.claim('worker-a', 30_000, hostileContextProxy), assertRefusedWithoutLeak);
  assert.equal(getterCalls, 0);
  assert.equal((await f.store.get('job-1')).state, 'pending');
});

test('SQLite schedules at the exact UTC boundary, reschedules one pending job, cancels, and survives restart', async (t) => {
  const f = fixture(t);
  const audit = new AuditLog(f.database);
  const future = '2026-09-01T10:00:00.000Z';
  const job = await f.store.enqueue(input('root-a', { scheduleAt: future }), operatorContext);
  assert.equal(job.state, 'pending');
  assert.equal(await f.store.claim('worker-a', 30_000, workerContext), null, 'not due before scheduleAt');

  await f.store.reschedule(job.id, '2026-09-01T09:30:00.000Z', operatorContext);
  f.setNow('2026-09-01T09:29:59.999Z');
  assert.equal(await f.store.claim('worker-a', 30_000, workerContext), null);
  f.setNow('2026-09-01T09:30:00.000Z');
  const claimed = await f.store.claim('worker-a', 30_000, workerContext);
  assert.equal(claimed.id, job.id, 'due exactly at scheduleAt');
  const executing = await f.store.beginExecution(claimed, 'worker-a', workerContext);
  await f.store.succeed(executing, 'worker-a', 'outcome:one', workerContext);

  const cancelled = await f.store.enqueue(input('root-b'), operatorContext);
  await f.store.cancel(cancelled.id, operatorContext);
  assert.equal((await f.store.get(cancelled.id)).state, 'cancelled');
  assert.equal(await f.store.claim('worker-a', 30_000, workerContext), null, 'cancelled job never runs');
  const restartFuture = await f.store.enqueue(input('root-restart', {
    scheduleAt: '2026-09-02T09:00:00.000Z',
  }), operatorContext);
  assert.ok(audit.list({ entityType: 'durable_job', entityId: job.id })
    .some((event) => event.action === 'durable_job.rescheduled'));
  assert.ok(audit.list({ entityType: 'durable_job', entityId: cancelled.id })
    .some((event) => event.action === 'durable_job.cancelled'));

  f.database.close();
  const reopened = createDatabase({ path: f.path, plane: 'data' });
  t.after(() => reopened.close());
  const restartedStore = createDurableJobStore({ storage: reopened.storage, tenantId: 'tenant-a', clock: f.clock });
  assert.equal((await restartedStore.get(job.id)).outcomeReference, 'outcome:one');
  assert.equal((await restartedStore.get(cancelled.id)).state, 'cancelled');
  assert.equal((await restartedStore.get(restartFuture.id)).scheduleAt, '2026-09-02T09:00:00.000Z');
  assert.equal((await restartedStore.get(restartFuture.id)).state, 'pending');
});

test('enqueue requires a live caller-owned transaction and stale handles persist nothing', async (t) => {
  const f = fixture(t);
  const audit = new AuditLog(f.database);
  let rolledBackTx;
  await assert.rejects(
    f.database.storage.transaction(async (tx) => {
      rolledBackTx = tx;
      await f.store.enqueue(input('root-rollback'), { transaction: tx, actor: operator });
      throw new Error('rollback');
    }),
    /rollback/,
  );
  assert.deepEqual(await f.store.list(), []);
  assert.deepEqual(audit.list({ entityType: 'durable_job' }), [], 'job and audit roll back together');
  await assert.rejects(
    f.store.enqueue(input('root-after-rollback'), { transaction: rolledBackTx, actor: operator }),
    (error) => error.code === 'DURABLE_JOB_TRANSACTION_REQUIRED'
      && error.details.proof === 'no-transaction',
  );

  let committedTx;
  await f.database.storage.transaction(async (tx) => {
    committedTx = tx;
    await f.store.enqueue(input('root-live-commit'), { transaction: tx, actor: operator });
  });
  await assert.rejects(
    f.store.enqueue(input('root-after-commit'), { transaction: committedTx, actor: operator }),
    (error) => error.code === 'DURABLE_JOB_TRANSACTION_REQUIRED'
      && error.details.proof === 'no-transaction',
  );
  await assert.rejects(
    f.store.enqueue(input('root-handle-refused'), { transaction: f.database.storage, actor: operator }),
    (error) => error.code === 'DURABLE_JOB_TRANSACTION_REQUIRED',
  );
  assert.deepEqual((await f.store.list()).map((job) => job.idempotencyRoot), ['root-live-commit']);
  assert.deepEqual(
    audit.list({ entityType: 'durable_job' }).map((event) => event.action),
    ['durable_job.enqueued'],
    'committed caller transaction contains its audit evidence',
  );

  const otherPath = join(tmpdir(), `accordo-v3a-other-${process.pid}-${Date.now()}.sqlite`);
  const other = createDatabase({ path: otherPath, plane: 'data' });
  t.after(() => { try { other.close(); } finally { rmSync(otherPath, { force: true }); } });
  await assert.rejects(
    other.storage.transaction(async (tx) => f.store.enqueue(input('root-wrong-storage'), { transaction: tx, actor: operator })),
    (error) => error.code === 'DURABLE_JOB_TRANSACTION_MISMATCH',
  );
  assert.deepEqual((await f.store.list()).map((job) => job.idempotencyRoot), ['root-live-commit']);
});

test('an audit insertion fault rolls back the job mutation on the same transaction', async (t) => {
  const f = fixture(t);
  f.database.raw.exec(`
    CREATE TEMP TRIGGER refuse_job_audit
    BEFORE INSERT ON audit_events
    WHEN NEW.entity_type = 'durable_job'
    BEGIN
      SELECT RAISE(ABORT, 'injected durable-job audit fault');
    END;
  `);
  await assert.rejects(
    f.store.enqueue(input('root-audit-fault'), operatorContext),
    /injected durable-job audit fault/,
  );
  assert.deepEqual(await f.store.list(), []);
});

test('an execution-start audit fault rolls back its claim CAS on the same transaction', async (t) => {
  const f = fixture(t);
  const job = await f.store.enqueue(input('root-execution-audit-fault'), operatorContext);
  const claimed = await f.store.claim('worker-a', 30_000, workerContext);
  f.database.raw.exec(`
    CREATE TEMP TRIGGER refuse_execution_started_audit
    BEFORE INSERT ON audit_events
    WHEN NEW.action = 'durable_job.execution_started'
    BEGIN
      SELECT RAISE(ABORT, 'injected execution-start audit fault');
    END;
  `);
  await assert.rejects(
    f.store.beginExecution(claimed, 'worker-a', workerContext),
    /injected execution-start audit fault/,
  );
  const persisted = await f.store.get(job.id);
  assert.equal(persisted.state, 'claimed');
  assert.equal(persisted.claim.claimId, claimed.claim.claimId);
  assert.equal(persisted.executionStartedAt, null);
});

test('claims fence workers, tenants, generations, active leases, and recover exactly at expiry', async (t) => {
  const f = fixture(t);
  const job = await f.store.enqueue(input('root-claim'), operatorContext);
  const first = await f.store.claim('worker-a', 1_000, workerContext);
  assert.equal(first.id, job.id);
  assert.equal(first.attempt, 1);
  await assert.rejects(
    f.store.succeed(first, 'worker-a', null, workerContext),
    (error) => error.code === 'DURABLE_JOB_CLAIM_FENCED',
  );
  assert.equal(await f.store.claim('worker-b', 1_000, workerContext), null, 'active claim cannot be stolen');
  await assert.rejects(f.store.succeed(first, 'worker-b', null, workerContext), (error) => error.code === 'DURABLE_JOB_CLAIM_FENCED');
  const wrongFingerprint = { ...first, claim: { ...first.claim, claimId: 'wrong-claim-fingerprint' } };
  await assert.rejects(f.store.succeed(wrongFingerprint, 'worker-a', null, workerContext), (error) => error.code === 'DURABLE_JOB_CLAIM_FENCED');

  const wrongTenant = createDurableJobStore({ storage: f.database.storage, tenantId: 'tenant-b', clock: f.clock });
  await assert.rejects(wrongTenant.succeed(first, 'worker-a', null, workerContext), (error) => error.code === 'DURABLE_JOB_CLAIM_FENCED');

  f.setNow('2026-09-01T09:00:00.999Z');
  assert.equal(await f.store.claim('worker-b', 1_000, workerContext), null);
  f.setNow('2026-09-01T09:00:01.000Z');
  const recovered = await f.store.claim('worker-b', 1_000, workerContext);
  assert.equal(recovered.claim.generation, first.claim.generation + 1);
  assert.equal(recovered.attempt, 1, 'an expired unstarted claim does not consume another attempt');
  await assert.rejects(f.store.succeed(first, 'worker-a', null, workerContext), (error) => error.code === 'DURABLE_JOB_CLAIM_FENCED');
  const executing = await f.store.beginExecution(recovered, 'worker-b', workerContext);
  assert.equal((await f.store.succeed(executing, 'worker-b', null, workerContext)).state, 'succeeded');
});

test('idempotency root resolves the same work and refuses a semantic mismatch', async (t) => {
  const f = fixture(t);
  const first = await f.store.enqueue(input('root-idempotent'), operatorContext);
  assert.equal(first.scheduleIntent, 'immediate');
  f.setNow('2026-09-01T09:00:10.000Z');
  const same = await f.store.enqueue(input('root-idempotent'), operatorContext);
  assert.equal(same.id, first.id);
  assert.equal(same.scheduleAt, first.scheduleAt, 'omitted immediate schedule joins despite clock drift');
  await assert.rejects(
    f.store.enqueue(input('root-idempotent', { scheduleAt: '2026-09-01T10:00:00.000Z' }), operatorContext),
    (error) => error.code === 'DURABLE_JOB_IDEMPOTENCY_MISMATCH',
  );

  const scheduled = await f.store.enqueue(input('root-scheduled', {
    scheduleAt: '2026-09-02T10:00:00.000Z',
  }), operatorContext);
  assert.equal(scheduled.scheduleIntent, 'scheduled');
  f.setNow('2026-09-01T09:01:00.000Z');
  assert.equal((await f.store.enqueue(input('root-scheduled', {
    scheduleAt: '2026-09-02T10:00:00.000Z',
  }), operatorContext)).id, scheduled.id);
  await assert.rejects(
    f.store.enqueue(input('root-scheduled'), operatorContext),
    (error) => error.code === 'DURABLE_JOB_IDEMPOTENCY_MISMATCH',
  );
  await assert.rejects(
    f.store.enqueue(input('root-idempotent', { payload: { recordId: 'different' } }), operatorContext),
    (error) => error.code === 'DURABLE_JOB_IDEMPOTENCY_MISMATCH',
  );
});

test('every mutation requires actor authority and workers require an explicit system operation actor', async (t) => {
  const f = fixture(t);
  await assert.rejects(f.store.enqueue(input('root-no-actor')), (error) => error.code === 'DURABLE_JOB_INPUT_INVALID');
  await assert.rejects(f.store.claim('worker-a', 1_000), (error) => error.code === 'DURABLE_JOB_INPUT_INVALID');
  await assert.rejects(
    f.store.enqueue(input('root-malformed-actor'), { actor: Object.create({ type: 'system', id: 'inherited' }) }),
    (error) => error.code === 'DURABLE_JOB_INPUT_INVALID',
  );
  let invoked = false;
  const accessorActor = { type: 'system', get id() { invoked = true; return 'hostile'; } };
  await assert.rejects(
    f.store.enqueue(input('root-accessor-actor'), { actor: accessorActor }),
    (error) => error.code === 'DURABLE_JOB_INPUT_INVALID',
  );
  assert.equal(invoked, false);
  const direct = await f.store.enqueue(input('root-direct-lifecycle-authority'), operatorContext);
  await assert.rejects(
    f.store.claim('untrusted-worker', 1_000, operatorContext),
    /system authority/,
  );
  const claimed = await f.store.claim('worker-a', 30_000, workerContext);
  await assert.rejects(
    f.store.beginExecution(claimed, 'worker-a', operatorContext),
    /system authority/,
  );
  const stillUnstarted = await f.store.get(direct.id);
  assert.equal(stillUnstarted.state, 'claimed');
  assert.equal(stillUnstarted.executionStartedAt, null);
  const executing = await f.store.beginExecution(claimed, 'worker-a', workerContext);
  for (const mutation of [
    () => f.store.succeed(executing, 'worker-a', 'fabricated', operatorContext),
    () => f.store.fail(executing, 'worker-a', { errorCode: 'JOB_HANDLER_FAILED' }, operatorContext),
    () => f.store.release(executing, 'worker-a', operatorContext),
  ]) await assert.rejects(mutation(), /system authority/);
  assert.equal((await f.store.get(direct.id)).state, 'claimed');
  const registry = createDurableJobHandlerRegistry();
  assert.throws(
    () => createDurableJobWorker({ store: f.store, registry, workerId: 'worker-a' }),
    /requires "actor"/,
  );
  assert.throws(
    () => createDurableJobWorker({ store: f.store, registry, workerId: 'worker-a', actor: operator }),
    /system authority/,
  );
  assert.deepEqual((await f.store.list()).map((job) => job.idempotencyRoot), ['root-direct-lifecycle-authority']);
});

test('job and audit transitions share fencing and audit never copies payload or secret-shaped input', async (t) => {
  const f = fixture(t);
  const audit = new AuditLog(f.database);
  const sentinel = 'AUDIT_PAYLOAD_SENTINEL_DO_NOT_COPY';
  const job = await f.store.enqueue(input('root-audit', { payload: { recordId: sentinel } }), operatorContext);
  const claimed = await f.store.claim('worker-a', 30_000, workerContext);
  const stale = { ...claimed, claim: { ...claimed.claim, claimId: 'stale-claim' } };
  await assert.rejects(
    f.store.succeed(stale, 'worker-a', null, workerContext),
    (error) => error.code === 'DURABLE_JOB_CLAIM_FENCED',
  );
  const executing = await f.store.beginExecution(claimed, 'worker-a', workerContext);
  await assert.rejects(
    f.store.beginExecution(claimed, 'worker-a', workerContext),
    (error) => error.code === 'DURABLE_JOB_CLAIM_FENCED',
  );
  await assert.rejects(
    f.store.release(executing, 'worker-a', workerContext),
    (error) => error.code === 'DURABLE_JOB_CLAIM_FENCED',
  );
  await f.store.succeed(executing, 'worker-a', 'outcome-must-not-be-audited', workerContext);

  const events = audit.list({ entityType: 'durable_job', entityId: job.id });
  assert.deepEqual(events.map((event) => event.action).sort(), [
    'durable_job.claimed', 'durable_job.enqueued', 'durable_job.execution_started', 'durable_job.succeeded',
  ]);
  assert.deepEqual(events.map((event) => event.actorId).sort(), ['jobs-operator', 'jobs-worker', 'jobs-worker', 'jobs-worker']);
  assert.equal(events.find((event) => event.action === 'durable_job.claimed').data.claimGeneration,
    claimed.claim.generation);
  const encoded = JSON.stringify(events);
  assert.equal(encoded.includes(sentinel), false);
  assert.equal(encoded.includes('root-audit'), false);
  assert.equal(encoded.includes('outcome-must-not-be-audited'), false);
});

test('corrupt claim metadata is refused instead of being normalized into a job', async (t) => {
  const f = fixture(t);
  const job = await f.store.enqueue(input('root-corrupt-claim'), operatorContext);
  f.database.raw.prepare('UPDATE spine_jobs SET claim_id = ? WHERE id = ?').run('smuggled-claim', job.id);
  await assert.rejects(
    f.store.get(job.id),
    (error) => error.code === 'DURABLE_JOB_ROW_INVALID' && error.details.field === 'claim',
  );
});

test('restart before execution-start reclaims the same attempt and executes once', async (t) => {
  const f = fixture(t);
  const job = await f.store.enqueue(input('root-exhausted', { maxAttempts: 1 }), operatorContext);
  await f.store.claim('worker-a', 1_000, workerContext);
  f.setNow('2026-09-01T09:00:01.000Z');
  let calls = 0;
  const registry = createDurableJobHandlerRegistry();
  registry.register({
    kind: 'named-action', name: 'run-follow-up', version: 1,
    async execute() { calls += 1; return { outcomeReference: 'restart:done' }; },
  });
  const worker = createDurableJobWorker({
    store: f.store, registry, workerId: 'worker-b', actor: systemActor,
    clock: f.clock, pollIntervalMs: 60_000, leaseMs: 1_000,
  });
  worker.start();
  const completed = await worker.poll();
  assert.equal(completed.id, job.id);
  assert.equal(completed.state, 'succeeded');
  assert.equal(completed.attempt, 1);
  assert.equal(completed.claimGeneration, 2);
  assert.equal(calls, 1);
  await worker.close();
});

test('owner-fenced pre-handler releases do not consume attempts, including external handlers', async (t) => {
  const f = fixture(t);
  for (const [root, sideEffect] of [
    ['root-release-ordinary', 'none'],
    ['root-release-external', 'external-operation-v2'],
  ]) {
    const job = await f.store.enqueue(input(root, { maxAttempts: 1 }), operatorContext);
    const audit = new AuditLog(f.database);
    let generation = 0;
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const claim = await f.store.claim('worker-a', 30_000, workerContext);
      assert.equal(claim.attempt, 1);
      assert.ok(claim.claim.generation > generation);
      generation = claim.claim.generation;
      const released = await f.store.release(claim, 'worker-a', workerContext);
      assert.equal(released.state, 'failed_retryable');
      assert.equal(released.attempt, 0);
      assert.equal(released.lastErrorCode, 'JOB_CLAIM_RELEASED');
    }
    assert.equal(audit.list({ entityType: 'durable_job', entityId: job.id })
      .filter((event) => event.action === 'durable_job.released').length, 3);
    let calls = 0;
    const registry = createDurableJobHandlerRegistry();
    registry.register({
      kind: 'named-action', name: 'run-follow-up', version: 1, sideEffect,
      async execute() { calls += 1; return { outcomeReference: `${root}:done` }; },
    });
    const worker = createDurableJobWorker({
      store: f.store, registry, workerId: 'worker-b', actor: systemActor, clock: f.clock, pollIntervalMs: 60_000,
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
  const audit = new AuditLog(f.database);
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
    store: f.store, registry, workerId: 'worker-a', actor: systemActor, clock: f.clock,
    pollIntervalMs: 60_000, backoff: () => 500,
  });
  assert.deepEqual(worker.status(), { accepting: false, closed: false, polling: false, inFlight: false, wakeScheduled: false, lastWorkerErrorCode: null });
  await f.store.enqueue(input('root-retry'), operatorContext);
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
  assert.deepEqual(audit.list({ entityType: 'durable_job' })
    .filter((event) => ['durable_job.failed', 'durable_job.succeeded'].includes(event.action))
    .map((event) => event.action).sort(), ['durable_job.failed', 'durable_job.succeeded']);
  assert.deepEqual(await worker.close(), { drained: true });
  assert.deepEqual(worker.status(), { accepting: false, closed: true, polling: false, inFlight: false, wakeScheduled: false, lastWorkerErrorCode: null });
});

test('hostile backoff failures terminalize with a bounded code and leak no details', async (t) => {
  const f = fixture(t);
  const sentinel = 'BACKOFF_SECRET_SENTINEL_DO_NOT_EXPORT';
  const registry = createDurableJobHandlerRegistry();
  registry.register({
    kind: 'named-action', name: 'run-follow-up', version: 1,
    async execute() {
      throw Object.assign(new Error('bounded handler failure'), { code: 'JOB_HANDLER_BUSY' });
    },
  });
  const worker = createDurableJobWorker({
    store: f.store, registry, workerId: 'worker-a', actor: systemActor, clock: f.clock,
    pollIntervalMs: 60_000, backoff() { throw new Error(sentinel); },
  });
  const job = await f.store.enqueue(input('root-hostile-backoff'), operatorContext);
  worker.start();
  const failed = await worker.poll();
  assert.equal(failed.state, 'failed_terminal');
  assert.equal(failed.lastErrorCode, 'JOB_BACKOFF_INVALID');
  assert.notEqual(failed.executionStartedAt, null);
  const audit = new AuditLog(f.database).list({ entityType: 'durable_job', entityId: job.id });
  const blob = [JSON.stringify(failed), JSON.stringify(worker.status()), JSON.stringify(audit), inspect(failed, { depth: 12 })].join('\n');
  assert.equal(blob.includes(sentinel), false);
  assert.equal(worker.status().lastWorkerErrorCode, null);
  await worker.close();
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
    store, registry: createDurableJobHandlerRegistry(), workerId: 'worker-a', actor: systemActor, pollIntervalMs: 60_000,
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
    store: f.store, registry, workerId: 'worker-a', actor: systemActor, clock: f.clock, pollIntervalMs: 60_000,
  });
  await f.store.enqueue(input('root-hostile-handler'), operatorContext);
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
  const worker = createDurableJobWorker({ store: f.store, registry, workerId: 'worker-a', actor: systemActor, clock: f.clock, pollIntervalMs: 60_000 });
  await f.store.enqueue(input('root-external'), operatorContext);
  worker.start();
  const result = await worker.poll();
  assert.equal(result.state, 'failed_terminal');
  assert.equal(result.lastErrorCode, 'JOB_EXTERNAL_OUTCOME_RECONCILIATION_REQUIRED');
  assert.equal(await worker.poll(), null);
  await worker.close();
});

test('a handler held through exact lease expiry is never invoked by recovery and old completion is fenced', async (t) => {
  const f = fixture(t);
  let release;
  let calls = 0;
  let observedIdentity;
  const held = new Promise((resolve) => { release = resolve; });
  const registry = createDurableJobHandlerRegistry();
  registry.register({
    kind: 'named-action', name: 'run-follow-up', version: 1,
    async execute(context) {
      calls += 1;
      observedIdentity = context.externalOperationId;
      return held;
    },
  });
  const firstWorker = createDurableJobWorker({
    store: f.store, registry, workerId: 'worker-a', actor: systemActor, clock: f.clock,
    pollIntervalMs: 60_000, leaseMs: 1_000,
  });
  const recoveryWorker = createDurableJobWorker({
    store: f.store, registry, workerId: 'worker-b', actor: systemActor, clock: f.clock,
    pollIntervalMs: 60_000, leaseMs: 1_000,
  });
  await f.store.enqueue(input('root-external-expiry'), operatorContext);
  firstWorker.start();
  const firstPoll = firstWorker.poll();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(observedIdentity, 'root-external-expiry');

  f.setNow('2026-09-01T09:00:01.000Z');
  recoveryWorker.start();
  const recovered = await recoveryWorker.poll();
  assert.equal(recovered, null);
  const reconciliation = await f.store.get((await f.store.list())[0].id);
  assert.equal(reconciliation.state, 'failed_terminal');
  assert.equal(reconciliation.lastErrorCode, 'JOB_EXECUTION_OUTCOME_RECONCILIATION_REQUIRED');
  assert.equal(reconciliation.executionStartedAt, '2026-09-01T09:00:00.000Z');
  assert.equal(calls, 1, 'recovery never invokes a handler whose execution-start was durable');
  const terminalAudit = new AuditLog(f.database).list({ entityType: 'durable_job', entityId: reconciliation.id })
    .find((event) => event.action === 'durable_job.failed');
  assert.equal(terminalAudit.data.errorCode, 'JOB_EXECUTION_OUTCOME_RECONCILIATION_REQUIRED');

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
  const worker = createDurableJobWorker({ store: f.store, registry, workerId: 'worker-a', actor: systemActor, clock: f.clock, pollIntervalMs: 60_000 });
  await f.store.enqueue(input('root-drain'), operatorContext);
  worker.start();
  const polling = worker.poll();
  await new Promise((resolve) => setImmediate(resolve));
  const close = await worker.close({ timeoutMs: 5 });
  assert.deepEqual(close, { drained: false, code: 'DURABLE_JOB_DRAIN_TIMEOUT' });
  assert.equal(worker.status().accepting, false);
  assert.equal(worker.status().wakeScheduled, false);
  assert.equal(await f.store.claim('worker-b', 30_000, workerContext), null, 'close does not unsafely release executing work');
  release({ outcomeReference: 'late-safe-finish' });
  assert.equal((await polling).state, 'succeeded');
});
