import test from 'node:test';
import assert from 'node:assert/strict';

import { createDatabase } from '../packages/core/src/database.js';
import { AppError } from '../packages/core/src/errors.js';
import {
  durableJobStorageOwnerFor,
  registerDurableJobStorageOwner,
} from '../packages/core/src/durable-job-storage.js';
import { AuditLog } from '../packages/core/src/audit.js';
import { EventBus } from '../packages/core/src/event-bus.js';
import {
  createDurableJobHandlerRegistry,
  createDurableJobStore,
  createDurableJobWorker,
} from '../packages/core/src/durable-jobs.js';
import { ensureCommittedWriteOutcomeEffects } from '../packages/core/src/transactional-outbox.js';
import { runIdempotentWrite } from '../packages/core/src/write-outcome-runtime.js';

const actor = Object.freeze({ type: 'user', id: 'sqlite-outbox-operator' });
const systemActor = Object.freeze({ type: 'system', id: 'sqlite-outbox-worker' });

test('SQLite keeps immediate event compatibility and does not claim a durable write-outcome outbox', async (t) => {
  const database = createDatabase({ path: ':memory:', plane: 'data' });
  t.after(() => database.close());
  const events = new EventBus();
  let calls = 0;
  events.subscribe('company.created', () => { calls += 1; });

  const result = await runIdempotentWrite(database, events, {
    tenantId: 'tenant-a',
    actor,
    operation: 'sqlite.compatibility',
  }, async ({ emit }) => {
    await emit('company.created', { companyId: 'sqlite-company' });
    return { ok: true };
  });

  assert.deepEqual(result.result, { ok: true });
  assert.equal(calls, 1);
  const jobs = await createDurableJobStore({
    storage: database.storage,
    tenantId: 'tenant-a',
  }).list();
  assert.deepEqual(jobs, [], 'SQLite compatibility does not imply durable M4 outbox semantics');
});

test('a committed pre-V3B source backfills one deterministic payload-free effect identity', async (t) => {
  const database = createDatabase({ path: ':memory:', plane: 'data' });
  t.after(() => database.close());
  const source = {
    runId: 'legacy-committed-run',
    phase: 'root',
    requestFingerprint: 'a'.repeat(64),
    eventIntents: [{ event: 'company.created', payload: { secret: 'never copied' } }],
  };

  const first = await ensureCommittedWriteOutcomeEffects({ database, tenantId: 'tenant-a', outcome: source });
  const replay = await ensureCommittedWriteOutcomeEffects({ database, tenantId: 'tenant-a', outcome: source });
  assert.equal(first.length, 1);
  assert.equal(replay[0].id, first[0].id);
  const jobs = await createDurableJobStore({ storage: database.storage, tenantId: 'tenant-a' }).list();
  assert.equal(jobs.length, 1);
  assert.deepEqual(Object.keys(jobs[0].payload).sort(), [
    'contractVersion', 'phase', 'runId', 'sourceFingerprint',
  ]);
  assert.equal(JSON.stringify(jobs[0].payload).includes('company.created'), false);
  assert.equal(JSON.stringify(jobs[0].payload).includes('never copied'), false);
});

test('receipt backfill creates a continuation only from persisted finalize-declared evidence', async (t) => {
  const database = createDatabase({ path: ':memory:', plane: 'data' });
  t.after(() => database.close());
  const source = {
    runId: 'receipt-run',
    phase: 'receipt',
    requestFingerprint: 'b'.repeat(64),
    eventIntents: [],
  };
  assert.deepEqual(await ensureCommittedWriteOutcomeEffects({
    database, tenantId: 'tenant-a', outcome: { ...source, externalFinalizeDeclared: false },
  }), []);
  const [continuation] = await ensureCommittedWriteOutcomeEffects({
    database, tenantId: 'tenant-a', outcome: { ...source, externalFinalizeDeclared: true },
  });
  assert.equal(continuation.handler.name, 'continue-external-finalize');
  assert.equal(continuation.state, 'pending');
  const [legacyEvidence] = await ensureCommittedWriteOutcomeEffects({
    database, tenantId: 'tenant-a',
    outcome: { ...source, runId: 'legacy-receipt-run', externalFinalizeDeclared: null },
  });
  assert.equal(legacyEvidence.handler.name, 'continue-external-finalize');
  assert.equal(legacyEvidence.state, 'pending');
});

test('exact one-shot claim does not terminalize an unrelated expired begun job', async (t) => {
  const database = createDatabase({ path: ':memory:', plane: 'data' });
  t.after(() => database.close());
  let current = '2026-09-01T09:00:00.000Z';
  const ids = ['unrelated-job', 'target-job'];
  const store = createDurableJobStore({
    storage: database.storage,
    tenantId: 'tenant-a',
    clock: () => current,
    idSource: () => ids.shift(),
  });
  const input = (root) => ({
    kind: 'named-action',
    handler: { name: 'run-target', contract: 1, version: 1 },
    payload: { root },
    idempotencyRoot: root,
  });
  await store.enqueue(input('unrelated'), { actor });
  await store.enqueue(input('target'), { actor });
  const unrelated = await store.claimById('unrelated-job', 'worker-a', 1_000, { actor: systemActor });
  await store.beginExecution(unrelated, 'worker-a', { actor: systemActor });
  current = '2026-09-01T09:00:01.000Z';

  const registry = createDurableJobHandlerRegistry();
  registry.register({
    kind: 'named-action', name: 'run-target', version: 1,
    async execute() { return { outcomeReference: 'target:done' }; },
  });
  const worker = createDurableJobWorker({
    store, registry, workerId: 'worker-b', actor: systemActor,
    clock: () => current, pollIntervalMs: 60_000,
  });
  worker.start();
  assert.equal((await worker.run('target-job')).state, 'succeeded');
  assert.equal((await store.get('unrelated-job')).state, 'claimed',
    'exact dispatch does not mutate unrelated reconciliation evidence');
  assert.equal(await worker.poll(), null);
  assert.equal((await store.get('unrelated-job')).state, 'failed_terminal',
    'ordinary polling still reconciles expired begun work');
  await worker.close();
});

test('persisted reconcilable policy recovers the zero-delivery crash window with a new fenced attempt', async (t) => {
  const database = createDatabase({ path: ':memory:', plane: 'data' });
  t.after(() => database.close());
  let current = '2026-09-01T09:00:00.000Z';
  const store = createDurableJobStore({
    storage: database.storage, tenantId: 'tenant-a', clock: () => current,
  });
  const job = await store.enqueue({
    kind: 'outbox-effect',
    handler: { name: 'recover-effect', contract: 1, version: 1 },
    payload: { source: 'zero-window' },
    idempotencyRoot: 'zero-window', maxAttempts: 3,
    recoveryPolicy: 'reconcilable_at_least_once',
  }, { actor });
  const abandoned = await store.claimById(job.id, 'crashed-worker', 1_000, { actor: systemActor });
  await store.beginExecution(abandoned, 'crashed-worker', { actor: systemActor });
  current = '2026-09-01T09:00:01.000Z';
  let calls = 0;
  const registry = createDurableJobHandlerRegistry();
  registry.register({
    kind: 'outbox-effect', name: 'recover-effect', version: 1,
    async execute() { calls += 1; return { outcomeReference: 'effect:done' }; },
  });
  const recovery = createDurableJobWorker({
    store, registry, workerId: 'recovery-worker', actor: systemActor,
    clock: () => current, pollIntervalMs: 60_000,
  });
  recovery.start();
  const completed = await recovery.run(job.id);
  assert.equal(completed.state, 'succeeded');
  assert.equal(completed.attempt, 2);
  assert.equal(completed.claimGeneration, 2);
  assert.equal(calls, 1, 'execution-start without delivery is retried after expiry');
  const recoveredAudit = new AuditLog(database).list({ entityType: 'durable_job', entityId: job.id })
    .find((entry) => entry.action === 'durable_job.claimed' && entry.data.recoveredUnknownOutcome === true);
  assert.ok(recoveredAudit, 'unknown-outcome recovery is bounded operator-visible audit evidence');
  await assert.rejects(
    store.succeed(abandoned, 'crashed-worker', 'stale:result', { actor: systemActor }),
    (error) => error.code === 'DURABLE_JOB_CLAIM_FENCED',
  );
  await recovery.close();
});

test('reconcilable partial delivery may duplicate, fences late completion, and exhausts visibly', async (t) => {
  const database = createDatabase({ path: ':memory:', plane: 'data' });
  t.after(() => database.close());
  let current = '2026-09-01T09:00:00.000Z';
  const store = createDurableJobStore({ storage: database.storage, tenantId: 'tenant-a', clock: () => current });
  const job = await store.enqueue({
    kind: 'outbox-effect', handler: { name: 'partial-effect', contract: 1, version: 1 },
    payload: { source: 'partial' }, idempotencyRoot: 'partial', maxAttempts: 3,
    recoveryPolicy: 'reconcilable_at_least_once',
  }, { actor });
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let deliveries = 0;
  const registry = createDurableJobHandlerRegistry();
  registry.register({
    kind: 'outbox-effect', name: 'partial-effect', version: 1,
    async execute() {
      deliveries += 1;
      if (deliveries === 1) await held;
      return { outcomeReference: 'effect:done' };
    },
  });
  const first = createDurableJobWorker({
    store, registry, workerId: 'partial-first', actor: systemActor,
    clock: () => current, pollIntervalMs: 60_000, leaseMs: 1_000,
  });
  const second = createDurableJobWorker({
    store, registry, workerId: 'partial-second', actor: systemActor,
    clock: () => current, pollIntervalMs: 60_000, leaseMs: 1_000,
  });
  first.start();
  second.start();
  const stale = first.run(job.id);
  await new Promise((resolve) => setImmediate(resolve));
  current = '2026-09-01T09:00:01.000Z';
  assert.equal((await second.run(job.id)).state, 'succeeded');
  assert.equal(deliveries, 2, 'at-least-once recovery honestly permits a duplicate partial delivery');
  release();
  await assert.rejects(stale, (error) => error.code === 'DURABLE_JOB_CLAIM_FENCED');
  assert.equal((await store.get(job.id)).state, 'succeeded');
  await first.close();
  await second.close();

  current = '2026-09-01T10:00:00.000Z';
  const poison = await store.enqueue({
    kind: 'outbox-effect', handler: { name: 'partial-effect', contract: 1, version: 1 },
    payload: { source: 'poison' }, idempotencyRoot: 'poison', maxAttempts: 2,
    recoveryPolicy: 'reconcilable_at_least_once',
  }, { actor });
  const firstPoison = await store.claimById(poison.id, 'poison-one', 1_000, { actor: systemActor });
  await store.beginExecution(firstPoison, 'poison-one', { actor: systemActor });
  current = '2026-09-01T10:00:01.000Z';
  const secondPoison = await store.claimById(poison.id, 'poison-two', 1_000, { actor: systemActor });
  await store.beginExecution(secondPoison, 'poison-two', { actor: systemActor });
  current = '2026-09-01T10:00:02.000Z';
  assert.equal(await store.claimById(poison.id, 'poison-three', 1_000, { actor: systemActor }), null);
  const exhausted = await store.get(poison.id);
  assert.equal(exhausted.state, 'failed_terminal');
  assert.equal(exhausted.lastErrorCode, 'JOB_RECONCILABLE_OUTCOME_MAX_ATTEMPTS');
});

test('committed effect ownership absorbs a lost contest only when the identity is already durable', async (t) => {
  const database = createDatabase({ path: ':memory:', plane: 'data' });
  t.after(() => database.close());
  const committed = {
    runId: 'contested-committed-run',
    phase: 'root',
    requestFingerprint: 'c'.repeat(64),
    eventIntents: [{ event: 'company.created', payload: { id: 'contested' } }],
  };
  const [owned] = await ensureCommittedWriteOutcomeEffects({
    database, tenantId: 'tenant-a', outcome: committed,
  });

  // One lost contest, then an honest storage: exactly the shape a concurrent
  // caller produces while owning the same committed source.
  const contested = (remaining) => {
    const storage = Object.freeze({
      ...database.storage,
      transaction(fn) {
        if (remaining.count > 0) {
          remaining.count -= 1;
          throw new AppError('the write lost a serialization contest', {
            code: 'CONFLICT', status: 409, details: { transient: true },
          });
        }
        return database.storage.transaction(fn);
      },
    });
    registerDurableJobStorageOwner(storage, durableJobStorageOwnerFor(database.storage));
    return { storage };
  };

  const [absorbed] = await ensureCommittedWriteOutcomeEffects({
    database: contested({ count: 1 }), tenantId: 'tenant-a', outcome: committed,
  });
  assert.equal(absorbed.id, owned.id,
    'a lost contest over an already durable effect answers with the row that owns the work');

  // The identical failure for a source that owns no effect must stand: nothing
  // else would ever create that row, so absorbing it would lose the work.
  await assert.rejects(
    ensureCommittedWriteOutcomeEffects({
      database: contested({ count: 1 }),
      tenantId: 'tenant-a',
      outcome: { ...committed, runId: 'contested-absent-run' },
    }),
    (error) => error.code === 'CONFLICT',
  );
});

test('a receipt source owns both effects or none, and an identity collision is never absorbed', async (t) => {
  const database = createDatabase({ path: ':memory:', plane: 'data' });
  t.after(() => database.close());
  const receipt = {
    runId: 'two-effect-receipt-run',
    phase: 'receipt',
    requestFingerprint: 'd'.repeat(64),
    externalFinalizeDeclared: true,
    eventIntents: [{ event: 'partner.notified', payload: { id: 'two-effect' } }],
  };
  const owned = await ensureCommittedWriteOutcomeEffects({
    database, tenantId: 'tenant-a', outcome: receipt,
  });
  assert.deepEqual(owned.map((job) => job.handler.name).sort(),
    ['continue-external-finalize', 'promote-write-outcome-events']);

  const store = createDurableJobStore({ storage: database.storage, tenantId: 'tenant-a' });
  const contested = Object.freeze({
    ...database.storage,
    transaction(fn) {
      if (contest.pending > 0) {
        contest.pending -= 1;
        throw new AppError('the write lost a serialization contest', {
          code: 'CONFLICT', status: 409, details: { transient: true },
        });
      }
      return database.storage.transaction(fn);
    },
  });
  const contest = { pending: 0 };
  registerDurableJobStorageOwner(contested, durableJobStorageOwnerFor(database.storage));

  // Both effect rows are durable, so a lost contest is absorbed for the pair.
  contest.pending = 1;
  const absorbed = await ensureCommittedWriteOutcomeEffects({
    database: { storage: contested }, tenantId: 'tenant-a', outcome: receipt,
  });
  assert.deepEqual(absorbed.map((job) => job.id).sort(), owned.map((job) => job.id).sort());

  // Half-owned is not owned: with one row gone the same contest must stand,
  // rather than answer as if the pair existed.
  const [dropped] = owned.filter((job) => job.handler.name === 'continue-external-finalize');
  database.raw.prepare('DELETE FROM spine_jobs WHERE id = ?').run(dropped.id);
  assert.equal(await store.get(dropped.id), null);
  contest.pending = 1;
  await assert.rejects(
    ensureCommittedWriteOutcomeEffects({
      database: { storage: contested }, tenantId: 'tenant-a', outcome: receipt,
    }),
    (error) => error.code === 'CONFLICT',
  );
});
