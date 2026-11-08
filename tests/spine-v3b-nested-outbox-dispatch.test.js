// @ts-check
// backlog:ad52f988afa4 — company.create annidato nella transazione del
// sender (gira Gmail): niente log NESTED_TRANSACTION, niente dispatch
// inline; il giro di recovery consegna dopo il commit esterno.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createDurableJobStore } from '../packages/core/src/durable-jobs.js';
import { EventBus } from '../packages/core/src/event-bus.js';
import { affineStorageFor, runWithAffineStorage } from '../packages/core/src/storage-runtime.js';
import {
  createTransactionalOutboxWorker,
  dispatchTransactionalOutboxJob,
} from '../packages/core/src/transactional-outbox.js';
import { runIdempotentWrite } from '../packages/core/src/write-outcome-runtime.js';
import { createWriteOutcomeStore } from '../packages/core/src/write-outcome-store.js';
import { tenantNamespace } from '../packages/core/src/idempotency.js';
import { postgresqlTestStorage } from '../packages/app/src/portable-app.js';
import { bootPostgresqlApp } from './helpers/postgresql-application.js';

const actor = Object.freeze({ type: 'user', id: 'pg-nested-outbox' });

function databaseHandle(storage, tenantId) {
  // Stessa forma dell'handle di produzione (portable-app.js): dentro una
  // transazione esterna l'annidato diventa savepoint, mai NESTED.
  const handle = {
    storage,
    tenantId,
    transactionAsync(fn) {
      const current = affineStorageFor(handle);
      if (current && typeof current.savepoint === 'function') {
        return current.savepoint('nested_tx', () => fn(current));
      }
      return storage.transaction(async (tx) => runWithAffineStorage(handle, tx, () => fn(tx)));
    },
  };
  return handle;
}

test('PostgreSQL nested company.create skips inline dispatch without NESTED_TRANSACTION and recovery delivers', { timeout: 90_000 }, async (t) => {
  const clock = () => '2026-11-07T03:00:00.000Z';
  const booted = await bootPostgresqlApp(t, { moduleMigrations: [] });
  if (!booted) return;
  const storage = postgresqlTestStorage(booted.app);
  const database = databaseHandle(storage, booted.tenantId);
  const events = new EventBus();
  let deliveries = 0;
  events.subscribe('company.created', () => { deliveries += 1; });
  const key = 'v1.20261107.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

  const logged = [];
  const realError = console.error;
  console.error = (...args) => { logged.push(args.map(String).join(' ')); };
  t.after(() => { console.error = realError; });

  // Come resolve-channel-sender: la creazione del lead gira dentro la
  // transazione esterna del sync Gmail.
  await database.transactionAsync(async () => {
    const outcome = await runIdempotentWrite(database, events, {
      tenantId: booted.tenantId,
      idempotencyKey: key,
      actor,
      operation: 'company.create',
      input: { name: 'Presti Lead Co' },
      now: clock,
    }, async ({ emit }) => {
      await emit('company.created', { id: 'company-nested-lead' });
      return { id: 'company-nested-lead' };
    });
    assert.equal(outcome.replayed, false);
    assert.deepEqual(outcome.result, { id: 'company-nested-lead' });
  });

  const nestedLogs = logged.filter((line) => line.includes('NESTED_TRANSACTION')
    || line.includes('pending recovery'));
  assert.deepEqual(nestedLogs, [], 'nested company.create logs no NESTED_TRANSACTION and no pending-recovery line');
  assert.equal(deliveries, 0, 'inline dispatch is deferred while the outer transaction owns the handle');

  const stored = await createWriteOutcomeStore(database).lookup(
    tenantNamespace(booted.tenantId), key, 'root',
  );
  assert.ok(stored, 'the nested write committed its authoritative outcome');

  const jobsStore = createDurableJobStore({ storage, tenantId: booted.tenantId });
  const [job] = await jobsStore.list();
  assert.ok(job, 'the effect job waits for the recovery round');
  assert.equal(job.state, 'pending');

  // Il giro di recovery esistente (poller): consegna dopo il commit esterno.
  const recovered = await dispatchTransactionalOutboxJob({
    database, events, tenantId: booted.tenantId, clock, workerId: 'outbox-recovery-probe',
  }, job.id);
  assert.equal(recovered?.state, 'succeeded');
  assert.equal(deliveries, 1, 'recovery delivers the company.created intent once');
  assert.equal((await jobsStore.get(job.id)).state, 'succeeded');

  const worker = createTransactionalOutboxWorker({
    database, events, tenantId: booted.tenantId, workerId: 'outbox-recovery-idle', pollIntervalMs: 60_000, clock,
  });
  worker.start();
  t.after(() => worker.close());
});

test('PostgreSQL non-nested company.create still dispatches inline', { timeout: 90_000 }, async (t) => {
  const clock = () => '2026-11-07T03:00:00.000Z';
  const booted = await bootPostgresqlApp(t, { moduleMigrations: [] });
  if (!booted) return;
  const storage = postgresqlTestStorage(booted.app);
  const database = databaseHandle(storage, booted.tenantId);
  const events = new EventBus();
  let deliveries = 0;
  events.subscribe('company.created', () => { deliveries += 1; });

  await runIdempotentWrite(database, events, {
    tenantId: booted.tenantId,
    idempotencyKey: 'v1.20261107.cccccccccccccccccccccccccccccccc',
    actor,
    operation: 'company.create',
    input: { name: 'Direct Co' },
    now: clock,
  }, async ({ emit }) => {
    await emit('company.created', { id: 'company-direct' });
    return { id: 'company-direct' };
  });

  assert.equal(deliveries, 1, 'outside an outer transaction the inline dispatch still runs');
});
