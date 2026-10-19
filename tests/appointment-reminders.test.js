import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDatabase } from '../packages/core/src/database.js';
import { AuditLog } from '../packages/core/src/audit.js';
import { EventBus } from '../packages/core/src/event-bus.js';
import {
  createRecordModuleFromManifest,
  recordModuleMigrations,
} from '../packages/core/src/record-module-runtime.js';
import {
  createDurableJobHandlerRegistry,
  createDurableJobStore,
  createDurableJobWorker,
} from '../packages/core/src/durable-jobs.js';
import { ChannelRegistries } from '../packages/channels/src/adapter.js';
import { buildChannelConnectionActions, createChannelsPackage } from '../packages/channels/src/index.js';
import { createChannelOperations } from '../packages/channels/src/operations.js';
import { createTemplateSendCapability } from '../packages/channels/src/template-send.js';
import {
  WHATSAPP_ADAPTER_NAME,
  WHATSAPP_ADAPTER_VERSION,
  createWhatsAppChannelAdapter,
} from '../packages/channels/src/whatsapp.js';
import { createFollowUpCapability, createWorkPackage } from '../packages/work/src/index.js';
import { createInteractionsPackage } from '../packages/interactions/src/index.js';
import { createAppointmentsPackage } from '../packages/appointments/src/index.js';
import {
  advanceAppointment,
  bookAppointment,
} from '../packages/appointments/src/appointments.js';
import {
  dispatchDueReminders,
  registerAppointmentReminderSweep,
  reminderHistoryBody,
  seedReminderSweep,
} from '../packages/appointments/src/reminder-dispatch.js';
import {
  checkCancelledRowNeverQueues,
  checkConcurrentSweepsQueueOneJob,
  checkCrashBetweenSendAndConfirmSendsOnce,
} from './helpers/outbound-send-conformance.js';

/**
 * Appointment reminders, sent and recorded (backlog:fe0fe10b85d1).
 *
 * A booking with `remindAt` + `reminderChannel` is sent automatically at
 * the instant as an approved WhatsApp template and recorded in the
 * customer's thread — the history the card reads. Queue-then-confirm: the
 * sweep queues one channel-outbox job per due reminder under its
 * deterministic key (the cross-process claim, never a provider call), the
 * worker sends it through the real channel-send handler, and the next sweep
 * confirms the finished job into history and the sent marker. Real sqlite,
 * real module services, the real follow-up seam, the real template queue,
 * the real history seam and the fake-backed WhatsApp adapter; the only
 * doubles are the adapter itself and the secret resolver, like the channel
 * kit.
 *
 * The three concurrency cases below run through the reusable
 * `tests/helpers/outbound-send-conformance.js` checks, driven by
 * `reminderOutboundDriver()`: the helper owns the orchestration and the
 * assertions, this suite only supplies the reminder composition, so the next
 * package with outbound sends reuses the same checks with its own driver.
 */

const here = dirname(fileURLToPath(import.meta.url));
const USER = { type: 'user', id: 'reminder-kit' };
const SYSTEM = { type: 'system', id: 'reminder-kit' };
const SPACE = 'presti';
const TENANT = 'reminder-kit';
const SECRET_REF = 'vault://kit/whatsapp-reminder';
const SECRET = 'whatsapp-fake-secret-reminder';
const TO = '+393331112223';
const NOW_BOOK = '2026-10-19T16:00:00.000Z';
const BEFORE_DUE = '2026-10-19T16:30:00.000Z';
const REMIND_AT = '2026-10-19T17:00:00.000Z';
const STARTS_AT = '2026-10-20T17:00:00.000Z';

const manifest = (pkg, name) => JSON.parse(
  readFileSync(join(here, '..', 'packages', pkg, 'modules', `${name}.module.json`), 'utf8'),
);

const MANIFESTS = [
  ['appointments', 'appointment'],
  ['work', 'work-task'],
  ['work', 'work-activity'],
  ['channels', 'channel-connection'],
  ['channels', 'channel-inbox-event'],
  ['interactions', 'conversation'],
  ['interactions', 'interaction-message'],
  ['interactions', 'interaction-call'],
  ['interactions', 'conversation-thread-key'],
];

function compose(dbPath = ':memory:', migrate = true, busyTimeoutMs = undefined) {
  const { definition, api } = createWhatsAppChannelAdapter({
    phoneNumberId: '15550001111',
    approvedTemplates: [{ name: 'presti_reminder', language: 'it' }],
    businessNumber: '+390200000099',
    secret: SECRET,
    nowMs: () => Date.parse(NOW_BOOK),
  });
  const registries = new ChannelRegistries({ channelAdapters: [definition] });
  const database = createDatabase({
    path: dbPath,
    ...(busyTimeoutMs === undefined ? {} : { busyTimeoutMs }),
  });
  // Module DDL runs once per database: a second stack on the same file (a
  // second dyno) opens and builds services without re-emitting it.
  if (migrate) {
    for (const { sql } of recordModuleMigrations(MANIFESTS.map(([pkg, name]) => ({ name, manifest: manifest(pkg, name) })))) {
      database.raw.exec(sql);
    }
  }
  const audit = new AuditLog(database);
  const events = new EventBus();
  const modules = new Map();
  for (const [, name] of MANIFESTS) {
    const built = createRecordModuleFromManifest(manifestOf(name), { database, audit, events, references: {} });
    modules.set(name, { service: built.service });
  }
  const resolveSecret = async (ref) => {
    if (ref !== SECRET_REF) {
      const error = new Error('unknown secret reference');
      error.code = 'SECRET_NOT_FOUND';
      throw error;
    }
    return SECRET;
  };
  const ops = createChannelOperations({
    database,
    modules,
    registries,
    resolveSecret,
    tenantId: TENANT,
    config: {},
    resolveSender: null,
    nowMs: () => Date.parse(NOW_BOOK),
  });
  return { database, modules, ops, registries, api, adapterDefinition: definition, resolveSecret };
}

function manifestOf(name) {
  const found = MANIFESTS.find(([, manifestName]) => manifestName === name);
  return manifest(found[0], found[1]);
}

function seams(composed, now) {
  const { modules, registries } = composed;
  const followUps = createFollowUpCapability().create({
    modules, actor: USER, now, consumer: 'appointments',
  });
  const channelsDefinition = createChannelsPackage({
    channelAdapters: [composed.adapterDefinition],
    resolveSecret: composed.resolveSecret,
    tenantId: TENANT,
  });
  const templateSendProvider = channelsDefinition.capabilities
    .find((entry) => entry?.name === 'channel-template-send' && entry?.version === 1) ?? null;
  assert.ok(templateSendProvider, 'channels publishes channel-template-send@1');
  const templateSend = templateSendProvider.create({ modules });
  const interactionsDefinition = createInteractionsPackage();
  const interactionLogProvider = interactionsDefinition.capabilities
    .find((entry) => entry?.name === 'interaction-log' && entry?.version === 1) ?? null;
  assert.ok(interactionLogProvider, 'interactions publishes interaction-log@1');
  const interactionLog = interactionLogProvider.create({
    modules, actor: SYSTEM, now, consumer: 'appointments',
  });
  return { followUps, templateSend, interactionLog };
}

async function activeConnection(composed) {
  const { modules, ops } = composed;
  const reg = await ops.registerChannelConnection({
    spaceId: SPACE,
    channel: 'whatsapp',
    account: '+390200000099',
    adapter: WHATSAPP_ADAPTER_NAME,
    adapterVersion: WHATSAPP_ADAPTER_VERSION,
    secretRef: SECRET_REF,
    actor: USER,
  });
  const actions = Object.fromEntries(
    buildChannelConnectionActions().map((action) => [action.name, action]),
  );
  const connectionService = () => modules.get('channel-connection').service;
  await actions['activate-connection'].execute({
    record: reg.connection,
    input: { reason: 'reminder kit activation' },
    actor: USER,
    modules,
    managed: (id, patch) => connectionService().applyManaged(id, patch, { actor: USER }),
    now: () => NOW_BOOK,
  });
  return reg.connection.sourceKey;
}

const bookingRequest = (connectionKey, overrides = {}) => ({
  sourceKey: 'gym:reminder:1',
  subject: { resource: 'contact', id: 'c-presti', owner: 'host' },
  teamMemberId: 'coach-guido',
  serviceKey: 'pt-single',
  priceCents: 4000,
  currency: 'EUR',
  startsAt: STARTS_AT,
  endsAt: '2026-10-20T18:00:00.000Z',
  source: { package: 'appointments', action: 'book' },
  remindAt: REMIND_AT,
  reminderChannel: {
    spaceId: SPACE,
    connectionKey,
    to: TO,
    template: { name: 'presti_reminder', language: 'it', variables: ['Guido', 'mar 20 ott, ore 17:00'] },
  },
  ...overrides,
});

async function book(composed, now, request) {
  const { database, modules } = composed;
  const { followUps, templateSend } = seams(composed, now);
  return database.transactionAsync(() => bookAppointment({
    modules, actor: USER, now, consumer: 'appointments', followUps, templateSend,
  }, request));
}

function services(composed) {
  const { modules } = composed;
  return {
    appointments: modules.get('appointment').service,
    tasks: modules.get('work-task').service,
    messages: modules.get('interaction-message').service,
    conversations: modules.get('conversation').service,
  };
}

function templateQueue(composed) {
  return {
    queueTemplate: (request) => composed.ops.queueTemplateSend({ ...request, actor: SYSTEM }),
  };
}

function dispatch(composed, now) {
  const { modules } = composed;
  const { interactionLog } = seams(composed, now);
  return dispatchDueReminders({
    appointments: modules.get('appointment').service,
    tasks: modules.get('work-task').service,
    templateQueue: templateQueue(composed),
    interactionLog,
    now,
  });
}

function workerKit(composed, clock) {
  // The store clock rides the test instant: outbox jobs schedule at the due
  // instant, and the worker only claims what is due.
  const store = createDurableJobStore({ storage: composed.database.storage, tenantId: TENANT, clock });
  const registry = createDurableJobHandlerRegistry();
  const { interactionLog } = seams(composed, clock);
  registerAppointmentReminderSweep(registry, {
    appointments: composed.modules.get('appointment').service,
    tasks: composed.modules.get('work-task').service,
    templateQueue: templateQueue(composed),
    interactionLog,
    clock,
  });
  composed.ops.registerChannelSendHandlers(registry);
  const worker = createDurableJobWorker({
    store, registry, workerId: 'reminder-kit', actor: SYSTEM, backoff: () => 0, pollIntervalMs: 60000,
  });
  return { store, registry, worker };
}

test('a due reminder queues at the instant, sends through the outbox, and is recorded in the thread', async (t) => {
  const composed = compose();
  t.after(() => composed.database.close());
  const now = () => NOW_BOOK;
  const connectionKey = await activeConnection(composed);
  const booked = await book(composed, now, bookingRequest(connectionKey));
  assert.equal(booked.replayed, false);
  assert.equal(booked.appointment.reminderTo, TO);

  // Before the instant the sweep runs and queues nothing: the timer owns
  // when, and early is not when.
  const early = await dispatch(composed, () => BEFORE_DUE);
  assert.equal(early.sent.length, 0);
  assert.equal(early.queued.length, 0);
  assert.equal(composed.api.state.sendCalls, 0);

  // At the instant the sweep queues exactly one outbox job and sends
  // nothing itself: the provider bytes belong to the outbox, and the sent
  // marker waits for the job's confirmation.
  const queued = await dispatch(composed, () => REMIND_AT);
  assert.equal(queued.sent.length, 0);
  assert.equal(queued.queued.length, 1);
  assert.equal(queued.queued[0].sourceKey, 'gym:reminder:1');
  assert.ok(typeof queued.queued[0].jobId === 'string');
  assert.equal(composed.api.state.sendCalls, 0);
  const { messages, conversations, tasks, appointments } = services(composed);
  const unmarked = (await appointments.listWhere({ sourceKey: 'gym:reminder:1' }))[0];
  assert.ok(!unmarked.reminderSentAt);

  // The worker sends the queued job: exactly the approved template for the
  // recipient, through the outbox handler production runs.
  const { worker } = workerKit(composed, () => REMIND_AT);
  worker.start();
  t.after(() => worker.close());
  const settled = await worker.run(queued.queued[0].jobId);
  assert.ok(settled && settled.state === 'succeeded', 'the channel job settles');
  assert.equal(composed.api.state.sendCalls, 1);
  const bodies = composed.api.sentMessages();
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].type, 'template');
  assert.equal(bodies[0].to, '393331112223');
  assert.equal(bodies[0].template.name, 'presti_reminder');
  assert.equal(bodies[0].template.language.code, 'it');

  // The next sweep confirms the finished job: one open thread, one
  // outbound WhatsApp message naming the template. No provider id is
  // copied into history — the thread proves the send happened, the jobs
  // table proves the provider answered.
  const fired = await dispatch(composed, () => REMIND_AT);
  assert.equal(fired.sent.length, 1);
  assert.equal(fired.sent[0].sourceKey, 'gym:reminder:1');
  assert.equal(fired.sent[0].jobId, queued.queued[0].jobId);
  const threads = await conversations.listWhere({ subjectId: 'c-presti' });
  assert.equal(threads.length, 1);
  assert.equal(threads[0].status, 'open');
  const logged = await messages.listWhere({ conversationId: threads[0].id });
  assert.equal(logged.length, 1);
  assert.equal(logged[0].direction, 'outbound');
  assert.equal(logged[0].channel, 'whatsapp');
  assert.equal(logged[0].teamAuthorId, 'coach-guido');
  assert.equal(logged[0].remoteHandle ?? null, null);
  assert.equal(logged[0].sourcePackage, 'appointments');
  assert.match(logged[0].body, /presti_reminder/);

  // The reminder row is marked sent and the human checklist stays open:
  // the follow-up is the human's work, and only a person moves it.
  const stored = (await appointments.listWhere({ sourceKey: 'gym:reminder:1' }))[0];
  assert.equal(stored.reminderSentAt, REMIND_AT);
  const task = (await tasks.listWhere({ sourceKey: 'appointment:gym:reminder:1:reminder' }))[0];
  assert.equal(task.status, 'open');

  // A further sweep replays: no second job, no second provider call, no
  // second row.
  const again = await dispatch(composed, () => REMIND_AT);
  assert.equal(again.sent.length, 0);
  assert.equal(again.queued.length, 0);
  assert.equal(composed.api.state.sendCalls, 1);
  assert.equal((await messages.listWhere({})).length, 1);
});

test('a cancelled booking never sends', async (t) => {
  const composed = compose();
  t.after(() => composed.database.close());
  const now = () => NOW_BOOK;
  const connectionKey = await activeConnection(composed);
  const booked = await book(composed, now, bookingRequest(connectionKey, {
    sourceKey: 'gym:reminder:2',
    startsAt: '2026-10-20T19:00:00.000Z',
    endsAt: '2026-10-20T20:00:00.000Z',
  }));
  await advanceAppointment(
    { appointments: composed.modules.get('appointment').service, actor: USER, now },
    booked.appointment,
    'cancelled',
    'the customer called it off',
  );
  const fired = await dispatch(composed, () => REMIND_AT);
  assert.equal(fired.sent.length, 0);
  assert.equal(fired.queued.length, 0);
  assert.equal(composed.api.state.sendCalls, 0);
});

test('a booking that names an unapproved template is refused before anything is written', async (t) => {
  const composed = compose();
  t.after(() => composed.database.close());
  const now = () => NOW_BOOK;
  const connectionKey = await activeConnection(composed);
  const request = bookingRequest(connectionKey, {
    template: undefined,
    reminderChannel: {
      spaceId: SPACE,
      connectionKey,
      to: TO,
      template: { name: 'unapproved_promo', language: 'it', variables: [] },
    },
  });
  await assert.rejects(
    book(composed, now, request),
    (error) => error?.code === 'CHANNEL_MESSAGE_MALFORMED',
  );
  const { appointments } = services(composed);
  assert.equal((await appointments.listWhere({})).length, 0);
});

test('a channel without an instant is refused: a send with no instant sends never', async (t) => {
  const composed = compose();
  t.after(() => composed.database.close());
  const now = () => NOW_BOOK;
  const connectionKey = await activeConnection(composed);
  const { reminderChannel, ...withoutChannel } = bookingRequest(connectionKey);
  void reminderChannel;
  await assert.rejects(
    book(composed, now, {
      ...withoutChannel,
      remindAt: null,
      reminderChannel: {
        spaceId: SPACE, connectionKey, to: TO, template: { name: 'presti_reminder' },
      },
    }),
    /reminderChannel needs remindAt/,
  );
});

test('moving the send target behind the same source key is a conflict, not an adoption', async (t) => {
  const composed = compose();
  t.after(() => composed.database.close());
  const now = () => NOW_BOOK;
  const connectionKey = await activeConnection(composed);
  await book(composed, now, bookingRequest(connectionKey));
  await assert.rejects(
    book(composed, now, bookingRequest(connectionKey, {
      reminderChannel: {
        spaceId: SPACE, connectionKey, to: '+393339998887', template: { name: 'presti_reminder' },
      },
    })),
    (error) => error?.code === 'APPOINTMENTS_LOG_CONFLICT',
  );
  assert.equal(composed.api.state.sendCalls, 0);
});

test('the template seam never sends free text and refuses without custody', async (t) => {
  const composed = compose();
  t.after(() => composed.database.close());
  const { templateSend } = seams(composed, () => NOW_BOOK);
  const connectionKey = await activeConnection(composed);
  // There is no text field to reach for: a request without a template is
  // malformed before any connection is read.
  await assert.rejects(
    templateSend.sendTemplate({ actor: USER, spaceId: SPACE, connectionKey, to: TO, messageKey: 'kit:no-template' }),
    /template must be an object/,
  );
  // A pending connection is not an active one.
  const pending = await composed.ops.registerChannelConnection({
    spaceId: SPACE,
    channel: 'whatsapp',
    account: '+390200000077',
    adapter: WHATSAPP_ADAPTER_NAME,
    adapterVersion: WHATSAPP_ADAPTER_VERSION,
    secretRef: SECRET_REF,
    actor: USER,
  });
  await assert.rejects(
    templateSend.checkSendable({
      actor: USER, spaceId: SPACE, connectionKey: pending.connection.sourceKey, to: TO, template: { name: 'presti_reminder' },
    }),
    (error) => error?.code === 'CHANNEL_CONNECTION_NOT_ACTIVE',
  );
  // Without the deployment's custody edge every send refuses fail-closed.
  const unwired = createTemplateSendCapability({ registries: composed.registries }).create({
    modules: composed.modules,
  });
  await assert.rejects(
    unwired.sendTemplate({
      actor: USER, spaceId: SPACE, connectionKey, to: TO, template: { name: 'presti_reminder' }, messageKey: 'kit:unwired',
    }),
    (error) => error?.code === 'CHANNEL_SECRET_UNAVAILABLE',
  );
  assert.equal(composed.api.state.sendCalls, 0);
});

test('the package handover proves the target; without channels the booking fails closed', async (t) => {
  const composed = compose();
  t.after(() => composed.database.close());
  const now = () => NOW_BOOK;
  const connectionKey = await activeConnection(composed);
  const workDefinition = createWorkPackage();
  const channelsDefinition = createChannelsPackage({
    channelAdapters: [composed.adapterDefinition],
    resolveSecret: composed.resolveSecret,
    tenantId: TENANT,
  });
  const withChannels = createAppointmentsPackage({ work: workDefinition, channels: channelsDefinition });
  const bookCapability = withChannels.capabilities.find((entry) => entry?.name === 'appointment-book');
  const opened = bookCapability.create({
    modules: composed.modules, actor: USER, now, consumer: 'handover-probe',
  });
  const booked = await composed.database.transactionAsync(() => opened.bookAppointment({
    ...bookingRequest(connectionKey, { sourceKey: 'gym:reminder:3' }),
    source: { package: 'handover-probe', action: 'book' },
  }));
  assert.equal(booked.replayed, false);

  const withoutChannels = createAppointmentsPackage({ work: workDefinition });
  const bareCapability = withoutChannels.capabilities.find((entry) => entry?.name === 'appointment-book');
  const bare = bareCapability.create({
    modules: composed.modules, actor: USER, now, consumer: 'handover-probe',
  });
  // A free slot: the probe isolates the channels handover, not the
  // overlap guard (covered by the booking tests).
  await assert.rejects(
    composed.database.transactionAsync(() => bare.bookAppointment({
      ...bookingRequest(connectionKey, {
        sourceKey: 'gym:reminder:4',
        startsAt: '2026-10-20T19:00:00.000Z',
        endsAt: '2026-10-20T20:00:00.000Z',
      }),
      source: { package: 'handover-probe', action: 'book' },
    })),
    (error) => error?.code === 'APPOINTMENTS_REMINDER_UNAVAILABLE',
  );
});

test('sweep beats are scoped: the next beat seeds after the first succeeds', async (t) => {
  const composed = compose();
  t.after(() => composed.database.close());
  const now = () => NOW_BOOK;
  const connectionKey = await activeConnection(composed);
  await book(composed, now, bookingRequest(connectionKey, { sourceKey: 'gym:reminder:5' }));

  const clock = () => REMIND_AT;
  const { store, worker } = workerKit(composed, clock);
  worker.start();
  t.after(() => worker.close());
  // The seed instant is the worker's business, in the past so the test
  // worker can claim it; the dispatch instant comes from the frozen
  // registration clock, never from the seed.
  const first = await seedReminderSweep({ store, actor: USER, at: '2026-10-19T04:01:00.000Z' });
  assert.equal(first.seeded, true);

  const settled = await worker.run(first.job.id);
  assert.ok(settled && settled.state === 'succeeded', 'the sweep job settles');
  // The sweep itself queued the outbox job and sent nothing: the provider
  // bytes wait for the outbox worker, even through the real sweep handler.
  assert.equal(composed.api.state.sendCalls, 0);

  // The next beat seeds its own sweep: reminders booked after the first
  // sweep still fire. A fixed idempotency root made every later beat
  // collide with the finished row and mismatch — the one-shot sweep.
  const second = await seedReminderSweep({ store, actor: USER, at: '2026-10-19T04:02:00.000Z' });
  assert.equal(second.seeded, true);
  assert.notEqual(second.job.id, first.job.id);

  // The same beat replays its own finished row instead of mismatching it:
  // the handler answers the seed's own reference back.
  const replay = await seedReminderSweep({ store, actor: USER, at: '2026-10-19T04:01:00.000Z' });
  assert.equal(replay.seeded, true);
  assert.equal(replay.job.id, first.job.id);

  // A double beat of the same pending instant still stacks nothing.
  const pending = await seedReminderSweep({ store, actor: USER, at: '2026-10-19T04:02:00.000Z' });
  assert.equal(pending.seeded, true);
  assert.equal(pending.job.id, second.job.id);
});

test('racing sweeps and a crash-retry queue one job and send once', async () => {
  // The orchestration and the assertions live in the reusable conformance
  // helper; this suite only supplies the reminder composition behind it.
  await checkConcurrentSweepsQueueOneJob(reminderOutboundDriver());
});

test('the template seam refuses anonymous calls: every send carries an actor', async (t) => {
  const composed = compose();
  t.after(() => composed.database.close());
  const { templateSend } = seams(composed, () => NOW_BOOK);
  const connectionKey = await activeConnection(composed);
  await assert.rejects(
    templateSend.sendTemplate({
      spaceId: SPACE, connectionKey, to: TO, template: { name: 'presti_reminder' }, messageKey: 'kit:no-actor',
    }),
    /actor/,
  );
  await assert.rejects(
    templateSend.checkSendable({
      spaceId: SPACE, connectionKey, to: TO, template: { name: 'presti_reminder' },
    }),
    /actor/,
  );
  assert.equal(composed.api.state.sendCalls, 0);
});

/**
 * A writer that lands after the due-list snapshot and before the fire: the
 * sweep must read the booking fresh by id and skip it. The proxy fires once,
 * on the first due-list read, then behaves like the real service.
 */
function racingAppointments(service, onFirstList) {
  let raced = false;
  return new Proxy(service, {
    get(target, prop) {
      if (prop === 'listWhere') {
        return async (filters) => {
          const rows = await target.listWhere(filters);
          if (!raced) {
            raced = true;
            await onFirstList();
          }
          return rows;
        };
      }
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function channelSendJobs(composed) {
  const probe = createDurableJobStore({ storage: composed.database.storage, tenantId: TENANT });
  return (await probe.list(100)).filter((job) => job.kind === 'channel-send');
}

/**
 * The outbound-send conformance driver for appointment reminders: the
 * composition and fault injection behind the three shared concurrency
 * checks in `tests/helpers/outbound-send-conformance.js`. The mechanics are
 * the ones this suite already proved; the helper owns the orchestration and
 * the assertions.
 */
const CONFORMANCE_KEY = 'gym:reminder:conformance';
const CONFORMANCE_CONFIRM_AT = '2026-10-19T18:00:00.000Z';

function reminderOutboundDriver() {
  const raceAt = async (stack, at) => {
    try {
      return await dispatch(stack, () => at);
    } catch (error) {
      // The enqueue is the claim: the loser takes the framework's transient
      // conflict and retries into the winner's row, like the worker retrying
      // a failed sweep in production.
      const failed = error?.details?.failed ?? [];
      if (error?.code === 'APPOINTMENTS_REMINDER_SWEEP_FAILED'
        && failed.length === 1 && failed[0]?.code === 'CONFLICT') {
        return await dispatch(stack, () => at);
      }
      throw error;
    }
  };
  const settleJob = async (stack, jobId) => {
    // The store clock rides the queue instant: outbox jobs schedule at the
    // due instant, and the worker only claims what is due.
    const { worker } = workerKit(stack, () => REMIND_AT);
    worker.start();
    try {
      const settled = await worker.run(jobId);
      assert.ok(settled && settled.state === 'succeeded', 'the channel job settles');
    } finally {
      worker.close();
    }
  };
  return {
    label: 'appointment reminders',
    now: { queue: REMIND_AT, confirm: CONFORMANCE_CONFIRM_AT },
    expectedSweepFailedCode: 'APPOINTMENTS_REMINDER_SWEEP_FAILED',
    expectedSkipReason: 'not-sendable',
    createRacingStacks: async () => {
      // Two stacks over two connections to one file database, like two
      // dynos: one sqlite handle cannot interleave two transactions, so the
      // race is only real across connections.
      const dir = mkdtempSync(join(tmpdir(), 'reminder-twoproc-'));
      const dbPath = join(dir, 'shared.sqlite');
      const first = compose(dbPath, true, 250);
      const second = compose(dbPath, false, 250);
      const connectionKey = await activeConnection(first);
      await book(first, () => NOW_BOOK, bookingRequest(connectionKey, { sourceKey: CONFORMANCE_KEY }));
      return {
        first,
        second,
        cleanup: () => {
          first.database.close();
          second.database.close();
          rmSync(dir, { recursive: true, force: true });
        },
      };
    },
    createStack: async () => {
      const stack = compose();
      const connectionKey = await activeConnection(stack);
      await book(stack, () => NOW_BOOK, bookingRequest(connectionKey, { sourceKey: CONFORMANCE_KEY }));
      return { stack, cleanup: () => stack.database.close() };
    },
    dispatch: (stack, at) => raceAt(stack, at),
    dispatchWithCancelledRow: async (stack, at) => {
      const service = stack.modules.get('appointment').service;
      const booked = (await service.listWhere({ sourceKey: CONFORMANCE_KEY }))[0] ?? null;
      assert.ok(booked, 'the conformance booking is stored before the race');
      const appointments = racingAppointments(service, () => advanceAppointment(
        { appointments: service, actor: USER, now: () => NOW_BOOK },
        booked,
        'cancelled',
        'the customer called it off between list and fire',
      ));
      const { interactionLog } = seams(stack, () => at);
      return dispatchDueReminders({
        appointments,
        tasks: stack.modules.get('work-task').service,
        templateQueue: templateQueue(stack),
        interactionLog,
        now: () => at,
      });
    },
    dispatchWithCrashingConfirm: async (stack, at) => {
      const service = stack.modules.get('appointment').service;
      let crashOnce = true;
      const crashing = new Proxy(service, {
        get(target, prop) {
          if (prop === 'applyManaged') {
            return async (...args) => {
              if (crashOnce) {
                crashOnce = false;
                const error = new Error('simulated crash between history and marker');
                error.code = 'CRASH_SIMULATED';
                throw error;
              }
              return target.applyManaged(...args);
            };
          }
          const value = target[prop];
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const { interactionLog } = seams(stack, () => at);
      return dispatchDueReminders({
        appointments: crashing,
        tasks: stack.modules.get('work-task').service,
        templateQueue: templateQueue(stack),
        interactionLog,
        now: () => at,
      });
    },
    settleJob,
    providerSendCalls: (stack) => stack.api.state.sendCalls,
    outboxJobCount: async (stack) => (await channelSendJobs(stack)).length,
    historyCount: async (stack) => (await services(stack).messages.listWhere({})).length,
    markerValue: async (stack) => {
      const row = (await services(stack).appointments.listWhere({ sourceKey: CONFORMANCE_KEY }))[0] ?? null;
      return row?.reminderSentAt ?? null;
    },
  };
}

test('a booking cancelled between the list and the fire never queues', async () => {
  // The shared check asserts the zero-counts and the recorded `not-sendable`
  // skip (via the driver's expectedSkipReason) on its own run.
  await checkCancelledRowNeverQueues(reminderOutboundDriver());
});

test('a booking rescheduled between the list and the fire never queues', async (t) => {
  const composed = compose();
  t.after(() => composed.database.close());
  const now = () => NOW_BOOK;
  const connectionKey = await activeConnection(composed);
  const booked = await book(composed, now, bookingRequest(connectionKey, { sourceKey: 'gym:reminder:7' }));
  const service = composed.modules.get('appointment').service;
  const appointments = racingAppointments(service, () => service.applyManaged(
    booked.appointment.id,
    { startsAt: '2026-10-21T17:00:00.000Z', endsAt: '2026-10-21T18:00:00.000Z' },
    { actor: USER },
  ));
  const { interactionLog } = seams(composed, () => REMIND_AT);
  const fired = await dispatchDueReminders({
    appointments,
    tasks: composed.modules.get('work-task').service,
    templateQueue: templateQueue(composed),
    interactionLog,
    now: () => REMIND_AT,
  });
  assert.equal(fired.sent.length, 0);
  assert.equal(fired.queued.length, 0);
  assert.deepEqual(fired.skipped.map((entry) => entry.reason), ['rescheduled']);
  assert.equal(composed.api.state.sendCalls, 0);
  assert.equal((await channelSendJobs(composed)).length, 0);
});

test('a due reminder for a concluded slot is skipped, never sent', async (t) => {
  const composed = compose();
  t.after(() => composed.database.close());
  const now = () => NOW_BOOK;
  const connectionKey = await activeConnection(composed);
  await book(composed, now, bookingRequest(connectionKey, { sourceKey: 'gym:reminder:8' }));
  // The worker was down: the first sweep runs after the slot began. The
  // reminder is due but stale — skip with a reason, queue nothing.
  const fired = await dispatch(composed, () => '2026-10-21T00:00:00.000Z');
  assert.equal(fired.sent.length, 0);
  assert.equal(fired.queued.length, 0);
  assert.deepEqual(fired.skipped.map((entry) => entry.reason), ['past-slot']);
  assert.equal(composed.api.state.sendCalls, 0);
  assert.equal((await channelSendJobs(composed)).length, 0);
});

test('a crash between history and marker confirms once on the next beat, on another clock', async () => {
  await checkCrashBetweenSendAndConfirmSendsOnce(reminderOutboundDriver());
});

test('a stale confirm on another clock skips instead of rewriting history', async (t) => {
  const composed = compose();
  t.after(() => composed.database.close());
  const now = () => NOW_BOOK;
  const connectionKey = await activeConnection(composed);
  await book(composed, now, bookingRequest(connectionKey, { sourceKey: 'gym:reminder:10' }));
  const queued = await dispatch(composed, () => REMIND_AT);
  assert.equal(queued.queued.length, 1);
  const { worker } = workerKit(composed, () => REMIND_AT);
  worker.start();
  t.after(() => worker.close());
  const settled = await worker.run(queued.queued[0].jobId);
  assert.ok(settled && settled.state === 'succeeded', 'the channel job settles');
  const confirmed = await dispatch(composed, () => REMIND_AT);
  assert.equal(confirmed.sent.length, 1);

  // A beat that listed before the confirm (stale snapshot) but fires after
  // it: the succeeded-path re-read sees the marker and skips, on another
  // clock, without touching history.
  const service = composed.modules.get('appointment').service;
  let idReads = 0;
  const stale = new Proxy(service, {
    get(target, prop) {
      if (prop === 'listWhere') {
        return async (filters) => {
          const rows = await target.listWhere(filters);
          const scrub = (row) => (row?.sourceKey === 'gym:reminder:10' ? { ...row, reminderSentAt: null } : row);
          if (filters && typeof filters === 'object' && 'status' in filters) return rows.map(scrub);
          if (filters && typeof filters === 'object' && 'id' in filters && idReads === 0) {
            idReads += 1;
            return rows.map(scrub);
          }
          return rows;
        };
      }
      const value = target[prop];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const { interactionLog } = seams(composed, () => '2026-10-19T18:30:00.000Z');
  const fired = await dispatchDueReminders({
    appointments: stale,
    tasks: composed.modules.get('work-task').service,
    templateQueue: templateQueue(composed),
    interactionLog,
    now: () => '2026-10-19T18:30:00.000Z',
  });
  assert.equal(fired.sent.length, 0);
  assert.equal(fired.queued.length, 0);
  assert.deepEqual(fired.skipped.map((entry) => entry.reason), ['already-sent']);
  const { messages, appointments } = services(composed);
  assert.equal((await messages.listWhere({})).length, 1);
  const marked = (await appointments.listWhere({ sourceKey: 'gym:reminder:10' }))[0];
  assert.equal(marked.reminderSentAt, REMIND_AT);
  assert.equal(composed.api.state.sendCalls, 1);
});

test('a suspended connection skips its row without failing the other reminders', async (t) => {
  const composed = compose();
  t.after(() => composed.database.close());
  const now = () => NOW_BOOK;
  const firstKey = await activeConnection(composed);
  // A second live connection for the booking that must still fire.
  const reg = await composed.ops.registerChannelConnection({
    spaceId: SPACE,
    channel: 'whatsapp',
    account: '+390200000077',
    adapter: WHATSAPP_ADAPTER_NAME,
    adapterVersion: WHATSAPP_ADAPTER_VERSION,
    secretRef: SECRET_REF,
    actor: USER,
  });
  const actions = Object.fromEntries(
    buildChannelConnectionActions().map((action) => [action.name, action]),
  );
  const connectionService = () => composed.modules.get('channel-connection').service;
  const managed = (id, patch) => connectionService().applyManaged(id, patch, { actor: USER });
  await actions['activate-connection'].execute({
    record: reg.connection,
    input: { reason: 'second reminder line' },
    actor: USER,
    modules: composed.modules,
    managed,
    now,
  });
  const secondKey = reg.connection.sourceKey;

  await book(composed, now, bookingRequest(firstKey, { sourceKey: 'gym:reminder:12' }));
  await book(composed, now, bookingRequest(secondKey, {
    sourceKey: 'gym:reminder:13',
    startsAt: '2026-10-21T17:00:00.000Z',
    endsAt: '2026-10-21T18:00:00.000Z',
  }));
  // The first line is suspended after booking: its queue refuses, the
  // other reminder still queues, and the sweep stays green.
  const first = (await connectionService().listWhere({ sourceKey: firstKey }))[0];
  await actions['suspend-connection'].execute({
    record: first,
    input: { reason: 'line suspended before the sweep' },
    actor: USER,
    modules: composed.modules,
    managed,
    now,
  });

  const fired = await dispatch(composed, () => REMIND_AT);
  assert.equal(fired.sent.length, 0);
  assert.equal(fired.queued.length, 1);
  assert.equal(fired.queued[0].sourceKey, 'gym:reminder:13');
  assert.deepEqual(
    fired.skipped.map((entry) => [entry.sourceKey, entry.reason]),
    [['gym:reminder:12', 'send-refused']],
  );
  assert.equal(composed.api.state.sendCalls, 0);
  assert.equal((await channelSendJobs(composed)).length, 1);
});

test('the history body names the template and stays within the message bound', async (t) => {
  const body = reminderHistoryBody({
    serviceKey: 'pt-single',
    startsAt: STARTS_AT,
    reminderTemplateName: 'presti_reminder',
    reminderTemplateLanguage: 'it',
    reminderTemplateVars: JSON.stringify(['Guido', 'mar 20 ott, ore 17:00']),
  });
  assert.match(body, /presti_reminder/);
  assert.match(body, /pt-single/);
  assert.ok(body.length <= 2000);
  const long = reminderHistoryBody({
    serviceKey: 'pt-single',
    startsAt: STARTS_AT,
    reminderTemplateName: 'presti_reminder',
    reminderTemplateLanguage: null,
    reminderTemplateVars: JSON.stringify([`x`.repeat(1024), `y`.repeat(1024)]),
  });
  assert.ok(long.length <= 2000);
  assert.match(long, /…/);
});
