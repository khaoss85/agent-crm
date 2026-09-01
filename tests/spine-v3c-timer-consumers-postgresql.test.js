import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createDurableJobHandlerRegistry,
  createDurableJobStore,
  createDurableJobWorker,
} from '../packages/core/src/durable-jobs.js';
import { runWithAffineStorage } from '../packages/core/src/storage-runtime.js';
import { postgresqlTestStorage } from '../packages/app/src/portable-app.js';
import {
  readScheduledAsk,
  registerScheduledAskHandlers,
  scheduleAsk,
  scheduledAskMigration,
} from '../packages/core/src/domain-timers.js';

import { bootPostgresqlApp } from './helpers/postgresql-application.js';

const PG_MIGRATION = scheduledAskMigration({ dialect: 'postgresql' });

const HUMAN = Object.freeze({ type: 'user', id: 'v3c-pg-operator' });
const AT = '2026-10-01T09:00:00.000Z';

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

function followUpAsk(index) {
  return {
    kind: 'work-follow-up',
    consumerPackage: 'lifecycle',
    capability: { name: 'follow-up', version: 1 },
    scheduledFor: AT,
    ask: {
      sourceKey: `lifecycle-commercial-followup:pg-${index}`,
      title: `Follow up on contract ${index}`,
      subject: { resource: 'commercial-contract', id: `contract-${index}` },
    },
  };
}

/**
 * A seam double that counts what it opened, keyed by the business identity the
 * instruction carries. Work's own capability is idempotent on that key; here the
 * count is the point, so it is the double that must not collapse duplicates.
 */
function countingRegistry(opened) {
  return {
    capability({ context }) {
      return Object.freeze({
        async createFollowUp(request) {
          opened.push({ sourceKey: request.sourceKey, actor: context.actor?.type });
          return { task: { id: `task-${opened.length}` } };
        },
      });
    },
  };
}

function timerWorker(database, tenantId, workerId, opened, clock = () => AT) {
  const registry = createDurableJobHandlerRegistry();
  registerScheduledAskHandlers(registry, {
    database, tenantId, clock, modules: { get: () => null }, domains: countingRegistry(opened),
  });
  return createDurableJobWorker({
    store: createDurableJobStore({ storage: database.storage, tenantId, clock }),
    registry, actor: { type: 'system', id: workerId },
    workerId, pollIntervalMs: 60_000, clock,
  });
}

test('two workers racing one due timer open exactly one ask', { timeout: 90_000 }, async (t) => {
  const booted = await bootPostgresqlApp(t, { moduleMigrations: [PG_MIGRATION] });
  if (!booted) return;
  const storage = postgresqlTestStorage(booted.app);
  const database = databaseHandle(storage, booted.tenantId);
  const scheduled = await scheduleAsk(
    { database, tenantId: booted.tenantId, actor: HUMAN, now: () => '2026-09-01T00:00:00.000Z' },
    followUpAsk(1),
  );

  const opened = [];
  const left = timerWorker(database, booted.tenantId, 'racer-left', opened);
  const right = timerWorker(database, booted.tenantId, 'racer-right', opened);
  left.start();
  right.start();
  const [job] = await createDurableJobStore({ storage, tenantId: booted.tenantId }).list();
  const race = await Promise.allSettled([left.run(job.id), right.run(job.id)]);
  await Promise.all([left.close(), right.close()]);

  // V3A owns the claim; the loser is skipped or refused as a bounded transient
  // conflict, and neither outcome may open a second ask.
  const settled = race.filter((entry) => entry.status === 'fulfilled' && entry.value?.state === 'succeeded');
  assert.equal(settled.length, 1, 'exactly one worker settles the timer');
  for (const rejected of race.filter((entry) => entry.status === 'rejected')) {
    assert.equal(rejected.reason?.code, 'CONFLICT');
    assert.equal(rejected.reason?.details?.transient, true);
  }
  assert.equal(opened.length, 1, 'two workers, one business ask');
  assert.equal((await readScheduledAsk(database, booted.tenantId, scheduled.id)).state, 'opened');
});

test('a timer replayed after a lost acknowledgement still opens one ask', { timeout: 90_000 }, async (t) => {
  const booted = await bootPostgresqlApp(t, { moduleMigrations: [PG_MIGRATION] });
  if (!booted) return;
  const storage = postgresqlTestStorage(booted.app);
  const database = databaseHandle(storage, booted.tenantId);
  const scheduled = await scheduleAsk(
    { database, tenantId: booted.tenantId, actor: HUMAN, now: () => '2026-09-01T00:00:00.000Z' },
    followUpAsk(2),
  );
  const opened = [];
  const worker = timerWorker(database, booted.tenantId, 'replaying-worker', opened);
  worker.start();
  const jobs = createDurableJobStore({ storage, tenantId: booted.tenantId });
  const [job] = await jobs.list();
  assert.equal((await worker.run(job.id)).state, 'succeeded');

  // Running the settled timer again is what a replay looks like from here.
  const replayed = await worker.run(job.id);
  await worker.close();
  assert.equal(replayed, null, 'a settled timer is not claimable again');
  assert.equal(opened.length, 1, 'a replay opens nothing further');
  assert.equal((await readScheduledAsk(database, booted.tenantId, scheduled.id)).state, 'opened');
});

test('a timer survives storage close and reopen, still due at the instant a person chose', { timeout: 90_000 }, async (t) => {
  const first = await bootPostgresqlApp(t, { moduleMigrations: [PG_MIGRATION] });
  if (!first) return;
  const firstStorage = postgresqlTestStorage(first.app);
  const firstDatabase = databaseHandle(firstStorage, first.tenantId);
  const scheduled = await scheduleAsk(
    { database: firstDatabase, tenantId: first.tenantId, actor: HUMAN, now: () => '2026-09-01T00:00:00.000Z' },
    followUpAsk(3),
  );
  await first.app.close();

  const restarted = await bootPostgresqlApp(t, {
    planes: first.planes, moduleMigrations: [PG_MIGRATION],
  });
  const storage = postgresqlTestStorage(restarted.app);
  const database = databaseHandle(storage, restarted.tenantId);
  const survived = await readScheduledAsk(database, restarted.tenantId, scheduled.id);
  assert.equal(survived.state, 'scheduled', 'the instruction outlived the process that wrote it');
  assert.equal(survived.scheduledFor, AT);

  const jobs = createDurableJobStore({ storage, tenantId: restarted.tenantId });
  const [job] = await jobs.list();
  assert.equal(job.state, 'pending');
  assert.equal(job.scheduleAt, AT);

  // Not due before the instant, due exactly at it.
  const early = timerWorker(database, restarted.tenantId, 'early-worker', [], () => '2026-09-30T23:59:59.999Z');
  early.start();
  assert.equal(await early.run(job.id), null, 'a timer is not due one millisecond early');
  await early.close();

  const opened = [];
  const onTime = timerWorker(database, restarted.tenantId, 'on-time-worker', opened);
  onTime.start();
  assert.equal((await onTime.run(job.id)).state, 'succeeded', 'it is due exactly at the instant');
  await onTime.close();
  assert.equal(opened.length, 1);
});
