import test from 'node:test';
import assert from 'node:assert/strict';

import { createDurableJobStore } from '../packages/core/src/durable-jobs.js';
import { EventBus } from '../packages/core/src/event-bus.js';
import { runExternalOperation } from '../packages/core/src/external-operation.js';
import { injectPostgresqlCommitFault, probePostgresqlQuery } from '../packages/core/src/postgresql-storage.js';
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
  const clock = () => '2026-09-01T09:00:00.000Z';
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
      now: clock,
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
    database, events, tenantId: booted.tenantId, workerId: 'outbox-left', pollIntervalMs: 60_000, clock,
  });
  const right = createTransactionalOutboxWorker({
    database, events, tenantId: booted.tenantId, workerId: 'outbox-right', pollIntervalMs: 60_000, clock,
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
  let current = '2026-09-01T09:00:00.000Z';
  const booted = await bootPostgresqlApp(t, { moduleMigrations: [], clock: () => current });
  if (!booted) return;
  const storage = postgresqlTestStorage(booted.app);
  const database = databaseHandle(storage, booted.tenantId);
  const events = new EventBus();
  const runId = 'external-restart-run';
  const externalKey = 'v1.20260901.eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  const intent = outcome(externalKey, 'intent', runId, {
    operation: 'partner.notify.intent',
    response: { intent: { accountId: 'account-safe' } },
  });
  const receipt = outcome(externalKey, 'receipt', runId, {
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
      clock: () => current,
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

  const jobs = createDurableJobStore({ storage, tenantId: booted.tenantId, clock: () => current });
  const [job] = await jobs.list();
  assert.equal(job.recoveryPolicy, 'reconcilable_at_least_once');
  const abandoned = await jobs.claimById(job.id, 'finalize-crashed', 1_000, {
    actor: { type: 'system', id: 'finalize-crashed' },
  });
  await jobs.beginExecution(abandoned, 'finalize-crashed', {
    actor: { type: 'system', id: 'finalize-crashed' },
  });
  current = '2026-09-01T09:00:01.000Z';
  const left = createTransactionalOutboxWorker({
    database, events, tenantId: booted.tenantId, workerId: 'finalize-left',
    resolveExternalFinalize, pollIntervalMs: 60_000, clock: () => current,
  });
  const right = createTransactionalOutboxWorker({
    database, events, tenantId: booted.tenantId, workerId: 'finalize-right',
    resolveExternalFinalize, pollIntervalMs: 60_000, clock: () => current,
  });
  left.start();
  right.start();
  const race = await Promise.allSettled([left.run(job.id), right.run(job.id)]);
  assertExactRunRace(race);
  assert.equal(finalizeCalls, 1);
  assert.equal(providerCalls, 0);
  assert.equal((await jobs.get(job.id)).state, 'succeeded');
  await assert.rejects(
    jobs.succeed(abandoned, 'finalize-crashed', 'stale', {
      actor: { type: 'system', id: 'finalize-crashed' },
    }),
    (error) => error.code === 'DURABLE_JOB_CLAIM_FENCED',
  );
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
  await assert.rejects(
    runExternalOperation({
      database, events, tenantId: booted.tenantId, actor,
      name: 'partner.provider-only', externalOperation: 2,
      idempotencyKey: providerOnlyKey, provider: makeProvider(),
      input: { command: 'safe' },
      now: () => '2026-09-01T09:00:00.000Z',
      async intent() { throw new Error('committed intent must replay'); },
      async finalize() { throw new Error('mismatched finalize must never run'); },
    }),
    (error) => error.code === 'DIVERGENT_REPLAY',
  );

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
  await assert.rejects(
    runExternalOperation({
      database, events, tenantId: booted.tenantId, actor,
      name: 'partner.with-finalize', externalOperation: 2,
      idempotencyKey: finalizeKey, provider: makeProvider(),
      input: { command: 'safe' },
      now: () => '2026-09-01T09:00:01.000Z',
      async intent() { throw new Error('committed intent must replay'); },
    }),
    (error) => error.code === 'DIVERGENT_REPLAY',
  );
});

test('a real schema upgrade preserves legacy receipt declaration as reconcilable unknown', { timeout: 90_000 }, async (t) => {
  const firstBoot = await bootPostgresqlApp(t, { moduleMigrations: [] });
  if (!firstBoot) return;
  const firstStorage = postgresqlTestStorage(firstBoot.app);
  const firstDatabase = databaseHandle(firstStorage, firstBoot.tenantId);
  const legacy = outcome('v1.20260901.eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', 'receipt', 'legacy-receipt-run', {
    externalFinalizeDeclared: true,
  });
  await firstDatabase.transactionAsync(async () => {
    await createWriteOutcomeStore(firstDatabase).insert(legacy);
  });
  await probePostgresqlQuery(firstStorage,
    'ALTER TABLE "accordo"."write_outcomes" DROP COLUMN external_finalize_declared');
  await firstBoot.app.close();

  const upgraded = await bootPostgresqlApp(t, {
    planes: firstBoot.planes,
    moduleMigrations: [],
  });
  const storage = postgresqlTestStorage(upgraded.app);
  const database = databaseHandle(storage, upgraded.tenantId);
  const stored = await createWriteOutcomeStore(database).lookup(
    tenantNamespace(upgraded.tenantId), legacy.rawKey, legacy.phase,
  );
  assert.equal(stored.externalFinalizeDeclared, null,
    'bootstrap adds the tri-state column without silently rewriting legacy authority to false');
  await assert.rejects(
    runExternalOperation({
      database, events: new EventBus(), tenantId: upgraded.tenantId, actor,
      name: 'partner.notify', externalOperation: 2,
      idempotencyKey: legacy.rawKey,
      provider: {
        call() { throw new Error('legacy receipt must prevent provider call'); },
        reconcile() { throw new Error('legacy receipt must prevent provider reconcile'); },
      },
      input: { command: 'legacy' },
      now: () => '2026-09-01T09:00:02.000Z',
      async intent() { return { requested: true }; },
      async finalize() { throw new Error('legacy ambiguity must prevent finalize'); },
    }),
    (error) => error.code === 'EXTERNAL_FINALIZE_DECLARATION_RECONCILIATION_REQUIRED',
  );
  const [evidence] = (await createDurableJobStore({
    storage, tenantId: upgraded.tenantId,
  }).list()).filter((entry) => entry.handler.name === 'continue-external-finalize');
  assert.equal(evidence.handler.name, 'continue-external-finalize');
  const worker = createTransactionalOutboxWorker({
    database, events: new EventBus(), tenantId: upgraded.tenantId,
    workerId: 'legacy-finalize-evidence', pollIntervalMs: 60_000,
    clock: () => '2026-09-01T09:00:02.000Z',
    resolveExternalFinalize: async () => {
      throw new Error('legacy ambiguity must never infer callback authority');
    },
  });
  worker.start();
  const terminal = await worker.run(evidence.id);
  assert.equal(terminal.state, 'failed_terminal');
  assert.equal(terminal.lastErrorCode,
    'JOB_OUTBOX_FINALIZE_DECLARATION_RECONCILIATION_REQUIRED');
  await worker.close();
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

test('PostgreSQL two-worker recovery reclaims a reconcilable zero-delivery execution start once', { timeout: 90_000 }, async (t) => {
  let current = '2026-09-01T08:00:00.000Z';
  const booted = await bootPostgresqlApp(t, { moduleMigrations: [], clock: () => current });
  if (!booted) return;
  const storage = postgresqlTestStorage(booted.app);
  const database = databaseHandle(storage, booted.tenantId);
  const events = new EventBus();
  let deliveries = 0;
  events.subscribe('company.created', () => { deliveries += 1; });
  const source = outcome('zero-window-root', 'root', 'zero-window-run', {
    eventIntents: [{ event: 'company.created', payload: { id: 'zero-window-company' } }],
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
  assert.equal(job.recoveryPolicy, 'reconcilable_at_least_once');
  const abandoned = await jobs.claimById(job.id, 'zero-crashed', 1_000, { actor: { type: 'system', id: 'zero-crashed' } });
  await jobs.beginExecution(abandoned, 'zero-crashed', { actor: { type: 'system', id: 'zero-crashed' } });
  current = '2026-09-01T08:00:01.000Z';
  const left = createTransactionalOutboxWorker({
    database, events, tenantId: booted.tenantId, workerId: 'zero-left',
    clock: () => current, pollIntervalMs: 60_000, leaseMs: 1_000,
  });
  const right = createTransactionalOutboxWorker({
    database, events, tenantId: booted.tenantId, workerId: 'zero-right',
    clock: () => current, pollIntervalMs: 60_000, leaseMs: 1_000,
  });
  left.start();
  right.start();
  assertExactRunRace(await Promise.allSettled([left.run(job.id), right.run(job.id)]));
  const completed = await jobs.get(job.id);
  assert.equal(completed.state, 'succeeded');
  assert.equal(completed.attempt, 2);
  assert.equal(deliveries, 1);
  await assert.rejects(
    jobs.succeed(abandoned, 'zero-crashed', 'stale', { actor: { type: 'system', id: 'zero-crashed' } }),
    (error) => error.code === 'DURABLE_JOB_CLAIM_FENCED',
  );
  await left.close();
  await right.close();
});

test('dispatch begun at lease expiry retries at least once and may duplicate partial delivery', { timeout: 90_000 }, async (t) => {
  let current = '2026-09-01T09:00:00.000Z';
  const booted = await bootPostgresqlApp(t, { moduleMigrations: [], clock: () => current });
  if (!booted) return;
  const storage = postgresqlTestStorage(booted.app);
  const database = databaseHandle(storage, booted.tenantId);
  const events = new EventBus();
  let release;
  let entered;
  const firstEntered = new Promise((resolve) => { entered = resolve; });
  let calls = 0;
  const held = new Promise((resolve) => { release = resolve; });
  events.subscribe('company.created', async () => {
    calls += 1;
    if (calls === 1) {
      entered();
      await held;
    }
  });
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
  await firstEntered;
  assert.equal(calls, 1);
  current = '2026-09-01T09:00:01.000Z';
  assert.equal((await recovery.run(job.id)).state, 'succeeded');
  const reconciled = await jobs.get(job.id);
  assert.equal(reconciled.state, 'succeeded');
  assert.equal(calls, 2, 'partial delivery may be repeated under honest at-least-once recovery');
  release();
  await assert.rejects(firstRun, (error) => error.code === 'DURABLE_JOB_CLAIM_FENCED');
  assert.equal((await jobs.get(job.id)).state, 'succeeded');
  assert.equal((await createWriteOutcomeStore(database).lookup(
    tenantNamespace(booted.tenantId), source.rawKey, source.phase,
  )).eventsPromoted, true, 'the recovered owner alone promotes terminal outcome evidence');
  await first.close();
  await recovery.close();
});

test('a committed outcome refuses to replay when its effect ownership cannot be proved', { timeout: 90_000 }, async (t) => {
  const clock = () => '2026-09-01T09:00:00.000Z';
  const booted = await bootPostgresqlApp(t, { moduleMigrations: [] });
  if (!booted) return;
  const storage = postgresqlTestStorage(booted.app);
  const database = databaseHandle(storage, booted.tenantId);
  const events = new EventBus();
  events.subscribe('company.created', () => {});
  const spec = {
    tenantId: booted.tenantId,
    idempotencyKey: 'v1.20260901.ffffffffffffffffffffffffffffffff',
    actor,
    operation: 'company.create',
    input: { name: 'Replay Safe' },
    now: clock,
  };
  const first = await runIdempotentWrite(database, events, spec, async ({ emit }) => {
    await emit('company.created', { id: 'company-replay' });
    return { id: 'company-replay' };
  });
  assert.equal(first.replayed, false);

  // Strand the committed outcome exactly as a source committed before V3B, then
  // occupy its effect identity root with unrelated work so ownership can never
  // be established or proved. Absorbing a lost contest is only safe when the
  // effect row is durable; here nothing would ever create it, so the replay must
  // refuse loudly rather than answer a caller that will never retry.
  const jobs = createDurableJobStore({ storage, tenantId: booted.tenantId });
  const [effect] = await jobs.list();
  await probePostgresqlQuery(storage,
    'DELETE FROM "accordo"."spine_jobs" WHERE id = $1', [effect.id]);
  await jobs.enqueue({
    kind: 'unrelated-work',
    handler: { name: 'unrelated-handler', contract: 1, version: 1 },
    payload: { note: 'occupies the effect identity root' },
    idempotencyRoot: effect.idempotencyRoot,
  }, { actor });

  await assert.rejects(
    runIdempotentWrite(database, events, spec, async () => {
      throw new Error('a committed outcome must never re-execute its work');
    }),
    (error) => error.code === 'DURABLE_JOB_IDEMPOTENCY_MISMATCH',
  );
  assert.equal((await jobs.list()).filter(
    (entry) => entry.handler.name === 'promote-write-outcome-events').length, 0,
    'a refused replay never leaves a half-owned effect behind');
});
