import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

/**
 * Appointment reminders, sent and recorded (backlog:fe0fe10b85d1).
 *
 * A booking with `remindAt` + `reminderChannel` is sent automatically at
 * the instant as an approved WhatsApp template and recorded in the
 * customer's thread — the history the card reads. Real sqlite, real module
 * services, the real follow-up seam, the real template-send seam, the real
 * history seam and the fake-backed WhatsApp adapter; the only doubles are
 * the adapter itself and the secret resolver, like the channel kit.
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
  ['interactions', 'conversation'],
  ['interactions', 'interaction-message'],
  ['interactions', 'interaction-call'],
  ['interactions', 'conversation-thread-key'],
];

function compose() {
  const { definition, api } = createWhatsAppChannelAdapter({
    phoneNumberId: '15550001111',
    approvedTemplates: [{ name: 'presti_reminder', language: 'it' }],
    businessNumber: '+390200000099',
    secret: SECRET,
    nowMs: () => Date.parse(NOW_BOOK),
  });
  const registries = new ChannelRegistries({ channelAdapters: [definition] });
  const database = createDatabase({ path: ':memory:' });
  for (const { sql } of recordModuleMigrations(MANIFESTS.map(([pkg, name]) => ({ name, manifest: manifest(pkg, name) })))) {
    database.raw.exec(sql);
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

function dispatch(composed, now) {
  const { modules } = composed;
  const { templateSend, interactionLog } = seams(composed, now);
  return dispatchDueReminders({
    appointments: modules.get('appointment').service,
    tasks: modules.get('work-task').service,
    templateSend,
    interactionLog,
    now,
  });
}

test('a due reminder sends at the instant as an approved template and is recorded in the thread', async (t) => {
  const composed = compose();
  t.after(() => composed.database.close());
  const now = () => NOW_BOOK;
  const connectionKey = await activeConnection(composed);
  const booked = await book(composed, now, bookingRequest(connectionKey));
  assert.equal(booked.replayed, false);
  assert.equal(booked.appointment.reminderTo, TO);

  // Before the instant the sweep runs and sends nothing: the timer owns
  // when, and early is not when.
  const early = await dispatch(composed, () => BEFORE_DUE);
  assert.equal(early.sent.length, 0);
  assert.equal(composed.api.state.sendCalls, 0);

  const fired = await dispatch(composed, () => REMIND_AT);
  assert.equal(fired.sent.length, 1);
  assert.equal(fired.sent[0].sourceKey, 'gym:reminder:1');
  assert.equal(fired.sent[0].providerMessageId, 'wamid.fake-1');

  // The provider received exactly the approved template for the recipient.
  const bodies = composed.api.sentMessages();
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].type, 'template');
  assert.equal(bodies[0].to, '393331112223');
  assert.equal(bodies[0].template.name, 'presti_reminder');
  assert.equal(bodies[0].template.language.code, 'it');

  // The send is recorded in the customer's thread: one open thread, one
  // outbound WhatsApp message carrying the provider id.
  const { messages, conversations, tasks, appointments } = services(composed);
  const threads = await conversations.listWhere({ subjectId: 'c-presti' });
  assert.equal(threads.length, 1);
  assert.equal(threads[0].status, 'open');
  const logged = await messages.listWhere({ conversationId: threads[0].id });
  assert.equal(logged.length, 1);
  assert.equal(logged[0].direction, 'outbound');
  assert.equal(logged[0].channel, 'whatsapp');
  assert.equal(logged[0].teamAuthorId, 'coach-guido');
  assert.equal(logged[0].remoteHandle, 'wamid.fake-1');
  assert.equal(logged[0].sourcePackage, 'appointments');
  assert.match(logged[0].body, /presti_reminder/);

  // The reminder row is marked sent and the human checklist stays open:
  // the follow-up is the human's work, and only a person moves it.
  const stored = (await appointments.listWhere({ sourceKey: 'gym:reminder:1' }))[0];
  assert.equal(stored.reminderSentAt, REMIND_AT);
  const task = (await tasks.listWhere({ sourceKey: 'appointment:gym:reminder:1:reminder' }))[0];
  assert.equal(task.status, 'open');

  // A second sweep replays: no second provider call, no second row.
  const again = await dispatch(composed, () => REMIND_AT);
  assert.equal(again.sent.length, 0);
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
    templateSend.sendTemplate({ spaceId: SPACE, connectionKey, to: TO, messageKey: 'kit:no-template' }),
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
      spaceId: SPACE, connectionKey: pending.connection.sourceKey, to: TO, template: { name: 'presti_reminder' },
    }),
    (error) => error?.code === 'CHANNEL_CONNECTION_NOT_ACTIVE',
  );
  // Without the deployment's custody edge every send refuses fail-closed.
  const unwired = createTemplateSendCapability({ registries: composed.registries }).create({
    modules: composed.modules,
  });
  await assert.rejects(
    unwired.sendTemplate({
      spaceId: SPACE, connectionKey, to: TO, template: { name: 'presti_reminder' }, messageKey: 'kit:unwired',
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

test('a seeded sweep fires through the real worker; a double beat stacks nothing', async (t) => {
  const composed = compose();
  t.after(() => composed.database.close());
  const now = () => NOW_BOOK;
  const connectionKey = await activeConnection(composed);
  await book(composed, now, bookingRequest(connectionKey, { sourceKey: 'gym:reminder:5' }));

  const store = createDurableJobStore({ storage: composed.database.storage, tenantId: TENANT });
  const registry = createDurableJobHandlerRegistry();
  const clock = () => REMIND_AT;
  const { templateSend, interactionLog } = seams(composed, clock);
  registerAppointmentReminderSweep(registry, {
    appointments: composed.modules.get('appointment').service,
    tasks: composed.modules.get('work-task').service,
    templateSend,
    interactionLog,
    clock,
  });
  // The seed instant is the worker's business, in the past so the test
  // worker can claim it; the dispatch instant comes from the frozen
  // registration clock, never from the seed.
  const first = await seedReminderSweep({ store, actor: USER, at: '2026-10-19T04:01:00.000Z' });
  assert.equal(first.seeded, true);
  const second = await seedReminderSweep({ store, actor: USER, at: '2026-10-19T04:02:00.000Z' });
  assert.equal(second.seeded, false);

  const worker = createDurableJobWorker({
    store, registry, workerId: 'reminder-kit', actor: SYSTEM, backoff: () => 0, pollIntervalMs: 60000,
  });
  worker.start();
  t.after(() => worker.close());
  const settled = await worker.run(first.job.id);
  assert.ok(settled && (settled.state === 'succeeded' || settled.status === 'succeeded'), 'the sweep job settles');
  assert.equal(composed.api.state.sendCalls, 1);
  const bodies = composed.api.sentMessages();
  assert.equal(bodies[0].template.name, 'presti_reminder');
  const { messages } = services(composed);
  assert.equal((await messages.listWhere({})).length, 1);
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
