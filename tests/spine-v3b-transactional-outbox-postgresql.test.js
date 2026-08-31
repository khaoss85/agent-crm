import test from 'node:test';
import assert from 'node:assert/strict';

import { createDurableJobStore } from '../packages/core/src/durable-jobs.js';
import { EventBus } from '../packages/core/src/event-bus.js';
import { runExternalOperation } from '../packages/core/src/external-operation.js';
import { injectPostgresqlCommitFault } from '../packages/core/src/postgresql-storage.js';
import { runWithAffineStorage, storageApi } from '../packages/core/src/storage-runtime.js';
import {
  createTransactionalOutboxWorker,
  enqueueWriteOutcomeEffects,
} from '../packages/core/src/transactional-outbox.js';
import { runIdempotentWrite } from '../packages/core/src/write-outcome-runtime.js';
import { createWriteOutcomeStore } from '../packages/core/src/write-outcome-store.js';
import { tenantNamespace } from '../packages/core/src/idempotency.js';
import { postgresqlTestStorage } from '../packages/app/src/portable-app.js';
import { bootPostgresqlApp } from './helpers/postgresql-application.js';

const actor = Object.freeze({ type: 'user', id: 'pg-outbox-operator' });

function databaseHandle(storage, tenantId) {
  const handle = {
    storage,
    tenantId,
    transactionAsync(fn) {
      return storage.transaction(async (tx) => runWithAffineStorage(handle, tx, () => fn(tx)));
    },
  };
  return handle;
}

function outcome(root, phase, runId, overrides = {}) {
  return {
    tenantNamespace: tenantNamespace('acme'),
    rawKey: root,
    phase,
    subjectFingerprint: 'a'.repeat(64),
    operation: `partner.notify.${phase}`,
    target: phase,
    contractVersion: 'external.v2',
    requestFingerprint: 'b'.repeat(64),
    recordIds: [],
    response: null,
    eventIntents: [],
    traceIntent: null,
    runId,
    createdAt: '2026-09-01T09:00:00.000Z',
    ...overrides,
  };
}

function assertExactRunRace(race) {
  const rejected = race.filter((entry) => entry.status === 'rejected');
  for (const result of rejected) {
    assert.equal(result.reason?.code, 'CONFLICT');
    assert.equal(result.reason?.details?.transient, true,
      'only a bounded transient serialization conflict is an acceptable exact-claim loser');
  }
  const fulfilled = race.filter((entry) => entry.status === 'fulfilled').map((entry) => entry.value);
  const succeeded = fulfilled.filter((entry) => entry?.state === 'succeeded');
  assert.equal(succeeded.length, 1);
  assert.equal(fulfilled.filter((entry) => entry === null).length + rejected.length, 1,
    'the exact-claim loser is either skipped or a bounded transient serialization refusal');
}

test('PostgreSQL commit atomically leaves an exact event job that dispatches once across restart workers', { timeout: 90_000 }, async (t) => {
  const booted = await bootPostgresqlApp(t, { moduleMigrations: [] });
  if (!booted) return;
  const storage = postgresqlTestStorage(booted.app);
  const database = databaseHandle(storage, booted.tenantId);
  const events = new EventBus();
  let deliveries = 0;
  events.subscribe('company.created', () => { deliveries += 1; });
  const key = 'v1.20260901.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

  injectPostgresqlCommitFault(storage, 'post-commit-ack-drop');
  await assert.rejects(
    runIdempotentWrite(database, events, {
      tenantId: booted.tenantId,
      idempotencyKey: key,
      actor,
      operation: 'company.create',
      input: { name: 'Restart Safe' },
      now: () => '2026-09-01T09:00:00.000Z',
    }, async ({ emit }) => {
      await emit('company.created', { id: 'company-restart' });
      return { id: 'company-restart' };
    }),
    (error) => error.code === 'COMMIT_OUTCOME_UNKNOWN',
  );
  assert.equal(deliveries, 0, 'process death before post-commit dispatch loses no intent');

  const jobsStore = createDurableJobStore({ storage, tenantId: booted.tenantId });
  const [job] = await jobsStore.list();
  assert.equal(job.state, 'pending');
  assert.deepEqual(Object.keys(job.payload).sort(), [
    'contractVersion', 'phase', 'runId', 'sourceFingerprint',
  ]);
  assert.equal(JSON.stringify(job.payload).includes('company.created'), false);
  assert.equal(JSON.stringify(job.payload).includes('company-restart'), false);
  assert.equal(JSON.stringify(job.payload).includes(key), false);

  const left = createTransactionalOutboxWorker({
    database, events, tenantId: booted.tenantId, workerId: 'outbox-left', pollIntervalMs: 60_000,
  });
  const right = createTransactionalOutboxWorker({
    database, events, tenantId: booted.tenantId, workerId: 'outbox-right', pollIntervalMs: 60_000,
  });
  left.start();
  right.start();
  const race = await Promise.allSettled([left.run(job.id), right.run(job.id)]);
  assertExactRunRace(race);
  assert.equal(deliveries, 1);
  assert.equal((await jobsStore.get(job.id)).state, 'succeeded');
  assert.equal(await left.run(job.id), null, 'the terminal exact job cannot be claimed again');
  const stored = await createWriteOutcomeStore(database).lookup(
    tenantNamespace(booted.tenantId), key, 'root',
  );
  assert.equal(stored.eventsPromoted, true);
  const replay = await runIdempotentWrite(database, events, {
    tenantId: booted.tenantId,
    idempotencyKey: key,
    actor,
    operation: 'company.create',
    input: { name: 'Restart Safe' },
    now: () => '2026-09-01T09:00:02.000Z',
  }, async () => { throw new Error('replay must not execute'); });
  assert.equal(replay.replayed, true);
  assert.equal(deliveries, 1);
  await left.close();
  await right.close();
});

test('PostgreSQL rollback removes both authoritative outcome and effect job', { timeout: 90_000 }, async (t) => {
  const booted = await bootPostgresqlApp(t, { moduleMigrations: [] });
  if (!booted) return;
  const storage = postgresqlTestStorage(booted.app);
  const database = databaseHandle(storage, booted.tenantId);
  const source = outcome('rollback-root', 'root', 'rollback-run', {
    eventIntents: [{ event: 'company.created', payload: { id: 'must-rollback' } }],
  });

  await assert.rejects(
    database.transactionAsync(async () => {
      await createWriteOutcomeStore(database).insert(source);
      await enqueueWriteOutcomeEffects({
        database, tenantId: booted.tenantId, outcome: source, transaction: storageApi(database),
      });
      throw new Error('rollback-outbox');
    }),
    /rollback-outbox/,
  );
  assert.equal(await createWriteOutcomeStore(database).lookup(
    tenantNamespace(booted.tenantId), source.rawKey, source.phase,
  ), null);
  assert.deepEqual(await createDurableJobStore({ storage, tenantId: booted.tenantId }).list(), []);
});

test('receipt continuation resumes finalize only and never receives or calls a provider', { timeout: 90_000 }, async (t) => {
  const booted = await bootPostgresqlApp(t, { moduleMigrations: [] });
  if (!booted) return;
  const storage = postgresqlTestStorage(booted.app);
  const database = databaseHandle(storage, booted.tenantId);
  const events = new EventBus();
  const runId = 'external-restart-run';
  const intent = outcome('external-root', 'intent', runId, {
    operation: 'partner.notify.intent',
    response: { intent: { accountId: 'account-safe' } },
  });
  const receipt = outcome('external-root', 'receipt', runId, {
    operation: 'partner.notify.receipt',
    response: { receiptId: 'receipt-safe', status: 'present' },
    externalFinalizeDeclared: true,
  });
  await database.transactionAsync(async () => {
    const store = createWriteOutcomeStore(database);
    await store.insert(intent);
    await store.insert(receipt);
    await enqueueWriteOutcomeEffects({
      database, tenantId: booted.tenantId, outcome: receipt, transaction: storageApi(database),
    });
  });

  let finalizeCalls = 0;
  let providerCalls = 0;
  const resolveExternalFinalize = async (operationName) => {
    assert.equal(operationName, 'partner.notify');
    return async (context) => {
      finalizeCalls += 1;
      assert.deepEqual(Object.keys(context).sort(), ['intent', 'operation', 'receipt', 'runId']);
      const { intent: storedIntent, receipt: storedReceipt } = context;
      assert.deepEqual(storedIntent.intent, { accountId: 'account-safe' });
      assert.equal(storedReceipt.receiptId, 'receipt-safe');
      await runIdempotentWrite(database, events, {
        tenantId: booted.tenantId,
        idempotencyKey: receipt.rawKey,
        actor,
        operation: 'partner.notify.finalize',
        target: 'finalize',
        contractVersion: 'external.v2',
        phase: 'finalize',
        runId,
        input: { localOnly: true },
        now: () => '2026-09-01T09:00:01.000Z',
      }, async () => ({ finalized: true }));
    };
  };
  void providerCalls;

  const [job] = await createDurableJobStore({ storage, tenantId: booted.tenantId }).list();
  const left = createTransactionalOutboxWorker({
    database, events, tenantId: booted.tenantId, workerId: 'finalize-left',
    resolveExternalFinalize, pollIntervalMs: 60_000,
  });
  const right = createTransactionalOutboxWorker({
    database, events, tenantId: booted.tenantId, workerId: 'finalize-right',
    resolveExternalFinalize, pollIntervalMs: 60_000,
  });
  left.start();
  right.start();
  const race = await Promise.allSettled([left.run(job.id), right.run(job.id)]);
  assertExactRunRace(race);
  assert.equal(finalizeCalls, 1);
  assert.equal(providerCalls, 0);
  assert.equal((await createDurableJobStore({ storage, tenantId: booted.tenantId }).get(job.id)).state, 'succeeded');
  assert.equal(await left.run(job.id), null, 'the terminal continuation cannot be claimed again');
  assert.ok(await createWriteOutcomeStore(database).lookupByRun(
    tenantNamespace(booted.tenantId), runId, 'finalize',
  ));
  await left.close();
  await right.close();
});

test('provider-only receipt declares no finalize continuation while a declared finalize is queued atomically', { timeout: 90_000 }, async (t) => {
  const booted = await bootPostgresqlApp(t, { moduleMigrations: [] });
  if (!booted) return;
  const storage = postgresqlTestStorage(booted.app);
  const database = databaseHandle(storage, booted.tenantId);
  const events = new EventBus();
  const makeProvider = () => ({
    call(args) {
      return {
        idempotencyKey: args.idempotencyKey,
        operation: args.operation,
        requestFingerprint: args.requestFingerprint,
        receiptId: `receipt-${args.idempotencyKey.slice(-8)}`,
        status: 'present',
      };
    },
    reconcile() { return { status: 'absent' }; },
  });
  const providerOnlyKey = 'v1.20260901.cccccccccccccccccccccccccccccccc';
  await runExternalOperation({
    database, events, tenantId: booted.tenantId, actor,
    name: 'partner.provider-only', externalOperation: 2,
    idempotencyKey: providerOnlyKey, provider: makeProvider(),
    input: { command: 'safe' },
    now: () => '2026-09-01T09:00:00.000Z',
    async intent() { return { requested: true }; },
  });
  const outcomes = createWriteOutcomeStore(database);
  const providerOnlyReceipt = await outcomes.lookup(
    tenantNamespace(booted.tenantId), providerOnlyKey, 'receipt',
  );
  assert.equal(providerOnlyReceipt.externalFinalizeDeclared, false);
  assert.equal((await createDurableJobStore({ storage, tenantId: booted.tenantId }).list())
    .some((entry) => entry.handler.name === 'continue-external-finalize'), false,
  'a valid provider-only operation creates no poison continuation');

  const finalizeKey = 'v1.20260901.dddddddddddddddddddddddddddddddd';
  await assert.rejects(
    runExternalOperation({
      database, events, tenantId: booted.tenantId, actor,
      name: 'partner.with-finalize', externalOperation: 2,
      idempotencyKey: finalizeKey, provider: makeProvider(),
      input: { command: 'safe' },
      now: () => '2026-09-01T09:00:01.000Z',
      async intent() { return { requested: true }; },
      async finalize() { throw new Error('finalize intentionally interrupted'); },
    }),
    /finalize intentionally interrupted/,
  );
  const finalizeReceipt = await outcomes.lookup(
    tenantNamespace(booted.tenantId), finalizeKey, 'receipt',
  );
  assert.equal(finalizeReceipt.externalFinalizeDeclared, true);
  const continuations = (await createDurableJobStore({ storage, tenantId: booted.tenantId }).list())
    .filter((entry) => entry.handler.name === 'continue-external-finalize');
  assert.equal(continuations.length, 1,
    'the committed receipt and its declared-finalize continuation survive the interrupted finalize together');
  assert.equal(continuations[0].state, 'pending');
});

test('event promotion attempts later stored intents before surfacing one bounded retryable failure', { timeout: 90_000 }, async (t) => {
  const booted = await bootPostgresqlApp(t, { moduleMigrations: [] });
  if (!booted) return;
  const storage = postgresqlTestStorage(booted.app);
  const database = databaseHandle(storage, booted.tenantId);
  const events = new EventBus();
  let firstAttempts = 0;
  let laterAttempts = 0;
  events.subscribe('company.first', () => {
    firstAttempts += 1;
    throw new Error('subscriber detail must remain bounded');
  });
  events.subscribe('company.later', () => { laterAttempts += 1; });
  const source = outcome('multi-intent-root', 'root', 'multi-intent-run', {
    eventIntents: [
      { event: 'company.first', payload: { id: 'first' } },
      { event: 'company.later', payload: { id: 'later' } },
    ],
  });
  await database.transactionAsync(async () => {
    await createWriteOutcomeStore(database).insert(source);
    await enqueueWriteOutcomeEffects({
      database, tenantId: booted.tenantId, outcome: source,
      transaction: storageApi(database),
    });
  });
  const [job] = await createDurableJobStore({ storage, tenantId: booted.tenantId }).list();
  const worker = createTransactionalOutboxWorker({
    database, events, tenantId: booted.tenantId, workerId: 'multi-intent-worker',
    pollIntervalMs: 60_000, backoff: () => 0,
  });
  worker.start();
  const failed = await worker.run(job.id);
  assert.equal(failed.state, 'failed_retryable');
  assert.equal(failed.lastErrorCode, 'JOB_HANDLER_TEMPORARY_UNAVAILABLE');
  assert.equal(firstAttempts, 1);
  assert.equal(laterAttempts, 1, 'a prior subscriber failure cannot starve a later stored intent');
  assert.equal(JSON.stringify(failed).includes('subscriber detail'), false);
  assert.equal((await createWriteOutcomeStore(database).lookup(
    tenantNamespace(booted.tenantId), source.rawKey, source.phase,
  )).eventsPromoted, false);
  await worker.close();
});

test('poison event dispatch remains terminal and operator-visible without silent deletion', { timeout: 90_000 }, async (t) => {
  let current = '2026-09-01T09:00:00.000Z';
  const booted = await bootPostgresqlApp(t, { moduleMigrations: [], clock: () => current });
  if (!booted) return;
  const storage = postgresqlTestStorage(booted.app);
  const database = databaseHandle(storage, booted.tenantId);
  const events = new EventBus();
  events.subscribe('company.created', () => { throw new Error('poison subscriber detail'); });
  const source = outcome('poison-root', 'root', 'poison-run', {
    eventIntents: [{ event: 'company.created', payload: { id: 'poison-company' } }],
  });
  await database.transactionAsync(async () => {
    await createWriteOutcomeStore(database).insert(source);
    await enqueueWriteOutcomeEffects({
      database, tenantId: booted.tenantId, outcome: source,
      transaction: storageApi(database), clock: () => current,
    });
  });
  const [job] = await createDurableJobStore({ storage, tenantId: booted.tenantId }).list();
  const worker = createTransactionalOutboxWorker({
    database, events, tenantId: booted.tenantId, workerId: 'poison-worker',
    clock: () => current, pollIntervalMs: 60_000, backoff: () => 0,
  });
  worker.start();
  let latest;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    latest = await worker.run(job.id);
  }
  assert.equal(latest.state, 'failed_terminal');
  assert.equal(latest.attempt, 5);
  assert.equal(latest.lastErrorCode, 'JOB_HANDLER_TEMPORARY_UNAVAILABLE');
  assert.equal((await createWriteOutcomeStore(database).lookup(
    tenantNamespace(booted.tenantId), source.rawKey, source.phase,
  )).eventsPromoted, false);
  assert.equal((await createDurableJobStore({ storage, tenantId: booted.tenantId }).list())
    .some((entry) => entry.id === job.id), true, 'poison work is never deleted');
  await worker.close();
});

test('dispatch begun at lease expiry is reconciliation evidence and is never invoked twice', { timeout: 90_000 }, async (t) => {
  let current = '2026-09-01T09:00:00.000Z';
  const booted = await bootPostgresqlApp(t, { moduleMigrations: [], clock: () => current });
  if (!booted) return;
  const storage = postgresqlTestStorage(booted.app);
  const database = databaseHandle(storage, booted.tenantId);
  const events = new EventBus();
  let release;
  let calls = 0;
  const held = new Promise((resolve) => { release = resolve; });
  events.subscribe('company.created', async () => { calls += 1; await held; });
  const source = outcome('held-root', 'root', 'held-run', {
    eventIntents: [{ event: 'company.created', payload: { id: 'held-company' } }],
  });
  await database.transactionAsync(async () => {
    await createWriteOutcomeStore(database).insert(source);
    await enqueueWriteOutcomeEffects({
      database, tenantId: booted.tenantId, outcome: source,
      transaction: storageApi(database), clock: () => current,
    });
  });
  const jobs = createDurableJobStore({ storage, tenantId: booted.tenantId, clock: () => current });
  const [job] = await jobs.list();
  const first = createTransactionalOutboxWorker({
    database, events, tenantId: booted.tenantId, workerId: 'held-first',
    clock: () => current, pollIntervalMs: 60_000, leaseMs: 1_000,
  });
  const recovery = createTransactionalOutboxWorker({
    database, events, tenantId: booted.tenantId, workerId: 'held-recovery',
    clock: () => current, pollIntervalMs: 60_000, leaseMs: 1_000,
  });
  first.start();
  recovery.start();
  const firstRun = first.run(job.id);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  current = '2026-09-01T09:00:01.000Z';
  assert.equal(await recovery.run(job.id), null);
  const reconciled = await jobs.get(job.id);
  assert.equal(reconciled.state, 'failed_terminal');
  assert.equal(reconciled.lastErrorCode, 'JOB_EXECUTION_OUTCOME_RECONCILIATION_REQUIRED');
  assert.equal(calls, 1);
  release();
  await assert.rejects(firstRun, (error) => error.code === 'DURABLE_JOB_CLAIM_FENCED');
  assert.equal((await jobs.get(job.id)).state, 'failed_terminal');
  assert.equal((await createWriteOutcomeStore(database).lookup(
    tenantNamespace(booted.tenantId), source.rawKey, source.phase,
  )).eventsPromoted, false, 'stale dispatch cannot promote outcome evidence after recovery fencing');
  await first.close();
  await recovery.close();
});
