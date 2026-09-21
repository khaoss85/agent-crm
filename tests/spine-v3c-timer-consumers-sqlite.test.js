import test from 'node:test';
import assert from 'node:assert/strict';

import { createDatabase } from '../packages/core/src/database.js';
import { createDurableJobHandlerRegistry, createDurableJobStore, createDurableJobWorker } from '../packages/core/src/durable-jobs.js';
import {
  SCHEDULED_ASK_MIGRATION,
  cancelScheduledAsk,
  readScheduledAsk,
  registerScheduledAskHandlers,
  rescheduleAsk,
  scheduleAsk,
  scheduledAskFingerprint,
} from '../packages/core/src/domain-timers.js';

const HUMAN = Object.freeze({ type: 'user', id: 'v3c-operator' });
const AGENT = Object.freeze({ type: 'agent', id: 'v3c-assistant' });
const TENANT = 'v3c-tenant';
const AT = '2026-10-01T09:00:00.000Z';

function fixture(t, clock = () => '2026-09-01T00:00:00.000Z') {
  const database = createDatabase({
    path: ':memory:', plane: 'data', moduleMigrations: [SCHEDULED_ASK_MIGRATION],
  });
  t.after(() => database.close());
  return { database, context: { database, tenantId: TENANT, actor: HUMAN, now: clock } };
}

function followUpAsk(overrides = {}) {
  return {
    kind: 'work-follow-up',
    consumerPackage: 'lifecycle',
    capability: { name: 'follow-up', version: 1 },
    scheduledFor: AT,
    ask: {
      sourceKey: 'lifecycle-commercial-followup:fu-1',
      title: 'Call the customer about renewal',
      subject: { resource: 'commercial-contract', id: 'contract-1' },
    },
    ...overrides,
  };
}

/**
 * A capability double that records what it was handed. It is not a work package:
 * what matters here is the identity the registry would have proved and the
 * request the timer presents, not what Work does with it afterwards.
 */
function registryDouble(opened = []) {
  return {
    capability({ consumer, capability, version, context }) {
      return Object.freeze({
        createFollowUp(request) {
          opened.push({ consumer, capability, version, actor: context.actor, request });
          return { task: { id: `task-${opened.length}` } };
        },
      });
    },
  };
}

test('scheduling is a human decision and an agent is refused it', async (t) => {
  const { context } = fixture(t);
  await assert.rejects(
    scheduleAsk({ ...context, actor: AGENT }, followUpAsk()),
    (error) => error.code === 'HUMAN_APPROVAL_REQUIRED' && error.status === 403,
  );
});

test('the instruction and its timer commit together, and a rollback leaves neither', async (t) => {
  const { database, context } = fixture(t);
  const scheduled = await scheduleAsk(context, followUpAsk());
  assert.equal(scheduled.state, 'scheduled');
  const jobs = createDurableJobStore({ storage: database.storage, tenantId: TENANT });
  const [job] = await jobs.list();
  assert.equal(job.scheduleAt, AT, 'the timer is due at the instant a person asked for');
  assert.equal(job.kind, 'scheduled-ask');

  // The payload identifies the instruction and proves it; it carries none of it.
  assert.deepEqual(Object.keys(job.payload).sort(), ['askId', 'contractVersion', 'fingerprint']);
  const serialized = JSON.stringify(job.payload);
  assert.equal(serialized.includes('Call the customer'), false, 'no domain content reaches a job payload');
  assert.equal(serialized.includes('lifecycle'), false);
  assert.equal(serialized.includes('contract-1'), false);
});

test('a rolled-back schedule leaves no instruction and no timer', async (t) => {
  const { database, context } = fixture(t);
  await assert.rejects(
    scheduleAsk(context, followUpAsk({ ask: { sourceKey: 'k', title: 'x', subject: { resource: 'company', id: '' } } })),
    (error) => error.status === 400,
  );
  const jobs = createDurableJobStore({ storage: database.storage, tenantId: TENANT });
  assert.deepEqual(await jobs.list(), [], 'a refused instruction schedules nothing');
});

test('nothing runs on a clock: far past the instant, an unworked ask is untouched', async (t) => {
  let instant = '2026-09-01T00:00:00.000Z';
  const { database, context } = fixture(t, () => instant);
  const scheduled = await scheduleAsk(context, followUpAsk());
  const before = await readScheduledAsk(database, TENANT, scheduled.id);

  instant = '2027-09-01T00:00:00.000Z';
  const after = await readScheduledAsk(database, TENANT, scheduled.id);
  assert.deepEqual(after, before, 'a passed instant with no worker changes nothing at all');
  assert.equal(after.state, 'scheduled');
  assert.equal(after.openedReference, null);
});

test('an executed timer opens exactly one ask, through the identity the record carries', async (t) => {
  const { database, context } = fixture(t);
  const scheduled = await scheduleAsk(context, followUpAsk());
  const opened = [];
  const registry = createDurableJobHandlerRegistry();
  registerScheduledAskHandlers(registry, {
    database, tenantId: TENANT, domains: registryDouble(opened), modules: { get: () => null },
    clock: () => '2026-10-01T09:00:00.000Z',
  });
  const worker = createDurableJobWorker({
    store: createDurableJobStore({ storage: database.storage, tenantId: TENANT, clock: () => '2026-10-01T09:00:00.000Z' }),
    registry, actor: { type: 'system', id: 'v3c-worker' },
    workerId: 'v3c-worker', pollIntervalMs: 60_000, clock: () => '2026-10-01T09:00:00.000Z',
  });
  worker.start();
  const jobs = createDurableJobStore({ storage: database.storage, tenantId: TENANT });
  const [job] = await jobs.list();
  const terminal = await worker.run(job.id);
  await worker.close();

  assert.equal(terminal.state, 'succeeded');
  assert.equal(opened.length, 1, 'exactly one ask is opened');
  assert.equal(opened[0].consumer, 'lifecycle', 'the consumer comes from the record, never from the timer');
  assert.equal(opened[0].capability, 'follow-up');
  assert.equal(opened[0].actor.type, 'system');
  assert.equal(opened[0].request.title, 'Call the customer about renewal');

  const record = await readScheduledAsk(database, TENANT, scheduled.id);
  assert.equal(record.state, 'opened');
  assert.equal(record.openedReference, 'task-1');
});

test('a cancelled instruction is never presented, and the timer still settles', async (t) => {
  const { database, context } = fixture(t);
  const scheduled = await scheduleAsk(context, followUpAsk());
  const cancelled = await cancelScheduledAsk(context, scheduled.id);
  assert.equal(cancelled.state, 'cancelled');

  const opened = [];
  const registry = createDurableJobHandlerRegistry();
  registerScheduledAskHandlers(registry, {
    database, tenantId: TENANT, domains: registryDouble(opened), modules: { get: () => null },
    clock: () => '2026-10-01T09:00:00.000Z',
  });
  const worker = createDurableJobWorker({
    store: createDurableJobStore({ storage: database.storage, tenantId: TENANT, clock: () => '2026-10-01T09:00:00.000Z' }),
    registry, actor: { type: 'system', id: 'v3c-worker' },
    workerId: 'v3c-worker', pollIntervalMs: 60_000, clock: () => '2026-10-01T09:00:00.000Z',
  });
  worker.start();
  const jobs = createDurableJobStore({ storage: database.storage, tenantId: TENANT });
  const [job] = await jobs.list();
  const terminal = await worker.run(job.id);
  await worker.close();

  assert.equal(terminal.state, 'succeeded', 'a cancelled ask is an answer, not a failure');
  assert.deepEqual(opened, [], 'nothing was opened');
  assert.equal((await readScheduledAsk(database, TENANT, scheduled.id)).state, 'cancelled');
});

test('a tampered instruction is refused: the timer executes only what a person wrote', async (t) => {
  const { database, context } = fixture(t);
  const scheduled = await scheduleAsk(context, followUpAsk());
  // Move the consumer identity under the timer, leaving the fingerprint behind.
  database.raw.prepare(`UPDATE spine_scheduled_asks SET consumer_package = ? WHERE id = ?`)
    .run('service', scheduled.id);

  const opened = [];
  const registry = createDurableJobHandlerRegistry();
  registerScheduledAskHandlers(registry, {
    database, tenantId: TENANT, domains: registryDouble(opened), modules: { get: () => null },
    clock: () => '2026-10-01T09:00:00.000Z',
  });
  const worker = createDurableJobWorker({
    store: createDurableJobStore({ storage: database.storage, tenantId: TENANT, clock: () => '2026-10-01T09:00:00.000Z' }),
    registry, actor: { type: 'system', id: 'v3c-worker' },
    workerId: 'v3c-worker', pollIntervalMs: 60_000, clock: () => '2026-10-01T09:00:00.000Z',
  });
  worker.start();
  const jobs = createDurableJobStore({ storage: database.storage, tenantId: TENANT });
  const [job] = await jobs.list();
  const terminal = await worker.run(job.id);
  await worker.close();

  assert.equal(terminal.outcomeReference, `scheduled-ask:${scheduled.id}:superseded`);
  assert.deepEqual(opened, [], 'a moved consumer identity opens nothing');
  assert.equal((await readScheduledAsk(database, TENANT, scheduled.id)).state, 'scheduled');
});

test('a rescheduled instruction executes at the new instant and never at the old one', async (t) => {
  const { database, context } = fixture(t);
  const scheduled = await scheduleAsk(context, followUpAsk());
  const later = '2026-11-15T08:30:00.000Z';
  const moved = await rescheduleAsk(context, scheduled.id, later);
  assert.equal(moved.scheduledFor, later);
  assert.notEqual(moved.fingerprint, scheduled.fingerprint, 'the instruction changed, so its fingerprint did');

  const jobs = createDurableJobStore({ storage: database.storage, tenantId: TENANT });
  const all = await jobs.list();
  const stale = all.find((entry) => entry.payload.fingerprint === scheduled.fingerprint);
  const current = all.find((entry) => entry.payload.fingerprint === moved.fingerprint);
  assert.ok(stale && current, 'both timers exist; only one still describes the instruction');
  assert.equal(current.scheduleAt, later);

  const opened = [];
  const registry = createDurableJobHandlerRegistry();
  registerScheduledAskHandlers(registry, {
    database, tenantId: TENANT, domains: registryDouble(opened), modules: { get: () => null },
    clock: () => later,
  });
  const worker = createDurableJobWorker({
    store: createDurableJobStore({ storage: database.storage, tenantId: TENANT, clock: () => later }),
    registry, actor: { type: 'system', id: 'v3c-worker' },
    workerId: 'v3c-worker', pollIntervalMs: 60_000, clock: () => later,
  });
  worker.start();
  assert.equal((await worker.run(stale.id)).outcomeReference, `scheduled-ask:${scheduled.id}:superseded`);
  assert.deepEqual(opened, [], 'the timer holding the old instruction opens nothing');
  await worker.run(current.id);
  await worker.close();
  assert.equal(opened.length, 1, 'only the current instruction is presented');
});

test('a renewal review becomes due and decides nothing', async (t) => {
  const { database, context } = fixture(t);
  const scheduled = await scheduleAsk(context, {
    kind: 'renewal-review',
    consumerPackage: 'lifecycle',
    capability: { name: 'contract-lifecycle-source', version: 2 },
    scheduledFor: AT,
    ask: { sourceKey: 'renewal-review:contract-1', summary: 'Term ends within notice', contractId: 'contract-1' },
  });
  const opened = [];
  const registry = createDurableJobHandlerRegistry();
  registerScheduledAskHandlers(registry, {
    database, tenantId: TENANT, domains: registryDouble(opened), modules: { get: () => null },
    clock: () => AT,
  });
  const worker = createDurableJobWorker({
    store: createDurableJobStore({ storage: database.storage, tenantId: TENANT, clock: () => AT }),
    registry, actor: { type: 'system', id: 'v3c-worker' },
    workerId: 'v3c-worker', pollIntervalMs: 60_000, clock: () => AT,
  });
  worker.start();
  const jobs = createDurableJobStore({ storage: database.storage, tenantId: TENANT });
  const [job] = await jobs.list();
  const terminal = await worker.run(job.id);
  await worker.close();

  assert.equal(terminal.state, 'succeeded');
  assert.deepEqual(opened, [], 'a renewal review reaches no domain seam at all');
  const record = await readScheduledAsk(database, TENANT, scheduled.id);
  assert.equal(record.state, 'due', 'it is due, which is an ask; the decision stays human');
  assert.equal(record.openedReference, null);
});

test('the fingerprint covers everything the timer is not allowed to choose', async (t) => {
  const base = {
    id: 'ask-1', kind: 'work-follow-up', tenantId: TENANT, consumerPackage: 'lifecycle',
    capabilityName: 'follow-up', capabilityVersion: 1, scheduledFor: AT, requestedBy: 'operator',
    ask: { sourceKey: 'k', title: 't', subject: { resource: 'company', id: 'c1' } },
  };
  const original = scheduledAskFingerprint(base);
  for (const [field, value] of [
    ['consumerPackage', 'service'],
    ['capabilityName', 'delivery-obligations'],
    ['capabilityVersion', 2],
    ['scheduledFor', '2027-01-01T00:00:00.000Z'],
    ['requestedBy', 'someone-else'],
    ['kind', 'renewal-review'],
  ]) {
    assert.notEqual(scheduledAskFingerprint({ ...base, [field]: value }), original,
      `moving ${field} must produce a different instruction`);
  }
  assert.notEqual(
    scheduledAskFingerprint({ ...base, ask: { ...base.ask, title: 'something else' } }),
    original,
    'moving the ask content must produce a different instruction',
  );
});

test('the timer authority can open an ask and cannot close one', async (t) => {
  const work = await import('../packages/work/src/index.js');
  // The human boundary lives with the follow-up implementation, not on the
  // package's public surface: importing it here keeps that surface unchanged.
  const { requireHumanActor } = await import('../packages/work/src/follow-up.js');
  const timerActor = { type: 'system', id: 'accordo' };

  // What the seam offers a consumer is the whole of what a timer can reach.
  const seam = work.createFollowUpCapability().create({
    modules: { get: () => null }, actor: timerActor, now: () => AT, consumer: 'lifecycle',
  });
  assert.deepEqual(Object.keys(seam).sort(), ['createFollowUp', 'findBySourceKey'],
    'opening work and reading it back is all a consumer is handed');

  // And every closing decision refuses this actor by the package's own rule.
  for (const decision of ['Completing a task', 'Cancelling a task', 'Adding a note']) {
    assert.throws(
      () => requireHumanActor(timerActor, decision),
      (error) => error.code === 'HUMAN_APPROVAL_REQUIRED' && error.status === 403,
      `${decision} stays a human decision`,
    );
  }
  assert.equal(requireHumanActor(HUMAN, 'Completing a task'), HUMAN.id);
});

test('a renewal review reaches no decision vocabulary at all', async (t) => {
  const lifecycle = await import('../packages/lifecycle/src/index.js');
  const { database, context } = fixture(t);
  const scheduled = await scheduleAsk(context, {
    kind: 'renewal-review',
    consumerPackage: 'lifecycle',
    capability: { name: 'contract-lifecycle-source', version: 2 },
    scheduledFor: AT,
    ask: { sourceKey: 'renewal-review:contract-9', summary: 'Term ends within notice', contractId: 'contract-9' },
  });
  const registry = createDurableJobHandlerRegistry();
  const reached = [];
  registerScheduledAskHandlers(registry, {
    database, tenantId: TENANT, clock: () => AT, modules: { get: () => null },
    domains: { capability(request) { reached.push(request); throw new Error('a review must reach no seam'); } },
  });
  const worker = createDurableJobWorker({
    store: createDurableJobStore({ storage: database.storage, tenantId: TENANT, clock: () => AT }),
    registry, actor: { type: 'system', id: 'v3c-worker' },
    workerId: 'v3c-worker', pollIntervalMs: 60_000, clock: () => AT,
  });
  worker.start();
  const [job] = await createDurableJobStore({ storage: database.storage, tenantId: TENANT }).list();
  await worker.run(job.id);
  await worker.close();

  assert.deepEqual(reached, [], 'the review touches no capability, so it can decide nothing');
  const record = await readScheduledAsk(database, TENANT, scheduled.id);
  assert.equal(record.state, 'due');
  // The decision vocabulary stays exactly where it was: with the human action.
  assert.ok(lifecycle.DECISIONS.includes('undecided'));
  for (const decision of lifecycle.DECISIONS) {
    assert.equal(JSON.stringify(record).includes(`"${decision}"`), false,
      `a review never records ${decision}`);
  }
});
