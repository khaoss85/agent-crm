import test from 'node:test';
import assert from 'node:assert/strict';

import { createDatabase } from '../packages/core/src/database.js';
import { EventBus } from '../packages/core/src/event-bus.js';
import {
  createDurableJobHandlerRegistry,
  createDurableJobStore,
  createDurableJobWorker,
} from '../packages/core/src/durable-jobs.js';
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
