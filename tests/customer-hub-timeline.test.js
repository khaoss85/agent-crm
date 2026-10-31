import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { shapeCustomerTimeline } from '../packages/customer-hub/src/timeline.js';
import { boot, project } from './helpers/customer-data-project.js';
import { moduleAlreadyPresent } from './helpers/apply-module.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * **The customer timeline: every conversation, every appointment, every way
 * to reach the customer — zero new records.**
 *
 * What it must prove: the timeline groups the subject's threads with their
 * latest entry, lists its appointment bookings soonest first, and derives
 * one contact point per channel from the same identities the card reads —
 * all from records the owning packages already hold. Reading it creates
 * nothing: no table appears, no row count moves, and the hub still declares
 * zero owned resources. A composition missing any one provider still boots
 * and serves the card; the timeline read itself refuses naming that edge,
 * never a silent partial timeline.
 */

const ACTOR = { type: 'user', id: 'timeline-reader' };
const EMAIL = 'guido@palestra-esempio.it';
const NOW = '2026-10-21T08:00:00.000Z';

function row(externalId) {
  return {
    externalId, email: EMAIL, firstName: 'Guido', lastName: 'Presti',
    companyName: 'Palestra Esempio', domain: 'palestra-esempio.it',
  };
}

/** Every record the timeline reads, beyond the customer-data helper's own. */
const INTERACTIONS_MANIFESTS = [
  'conversation.module.json',
  'interaction-message.module.json',
  'interaction-call.module.json',
  'conversation-assignment.module.json',
  'conversation-read.module.json',
  'conversation-thread-key.module.json',
];

function cli(root, args) {
  return spawnSync(process.execPath,
    ['--no-warnings', join(root, 'packages/cli/bin/accordo.js'), ...args, '--root', root],
    { encoding: 'utf8', cwd: root });
}

/** The same project as the customer-data helper, plus work, interactions, appointments and the hub. */
function projectWithTimeline(t) {
  const root = project(t, {});
  for (const manifest of INTERACTIONS_MANIFESTS) {
    const applied = cli(root, ['module', 'create', join(root, 'packages/interactions/modules', manifest), '--apply']);
    assert.equal(applied.status, 0, `apply ${manifest}: ${applied.stderr}`);
  }
  for (const manifest of ['appointment.module.json']) {
    const applied = cli(root, ['module', 'create', join(root, 'packages/appointments/modules', manifest), '--apply']);
    assert.equal(applied.status, 0, `apply ${manifest}: ${applied.stderr}`);
  }
  for (const manifest of ['work-task.module.json', 'work-activity.module.json']) {
    if (moduleAlreadyPresent(root, manifest)) continue;
    const applied = cli(root, ['module', 'create', join(root, 'packages/work/modules', manifest), '--apply']);
    assert.equal(applied.status, 0, `apply ${manifest}: ${applied.stderr}`);
  }
  const path = join(root, 'packages/domains/generated/index.js');
  const before = readFileSync(path, 'utf8');
  assert.ok(before.includes('createCustomerDataPackage()'), 'helper composes customer-data');
  writeFileSync(path, [
    "import { createCustomerDataPackage } from '../../customer-data/src/index.js';",
    "import { createCustomerHubPackage } from '../../customer-hub/src/index.js';",
    "import { createInteractionsPackage } from '../../interactions/src/index.js';",
    "import { createAppointmentsPackage } from '../../appointments/src/index.js';",
    "import { createWorkPackage } from '../../work/src/index.js';",
    'const customerData = createCustomerDataPackage();',
    'const work = createWorkPackage();',
    'const interactions = createInteractionsPackage();',
    'const appointments = createAppointmentsPackage({ work });',
    'export const generatedDomains = [',
    '  customerData,',
    '  work,',
    '  interactions,',
    '  appointments,',
    '  createCustomerHubPackage({ customerData, interactions, appointments }),',
    '];',
    '',
  ].join('\n'));
  const after = readFileSync(path, 'utf8');
  assert.ok(after.includes('createCustomerHubPackage({ customerData, interactions, appointments })'),
    'the hub is composed with all three provider definitions');
  return root;
}

function tables(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => row.name);
}

function counts(db) {
  const out = {};
  for (const table of tables(db)) {
    out[table] = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n;
  }
  return out;
}

async function seedCustomer(t, file) {
  const root = projectWithTimeline(t);
  const context = await boot(root, join(root, 'data', file));
  t.after(() => context.close());
  const { app } = context;
  const rootUrl = pathToFileURL(join(root, 'packages/interactions/src/index.js')).href;
  const { openConversation, logMessage, logCall } = await import(rootUrl);
  const appointmentsUrl = pathToFileURL(join(root, 'packages/appointments/src/index.js')).href;
  const { bookAppointment } = await import(appointmentsUrl);

  await app.applyCustomerImport({ actor: ACTOR, system: 'whatsapp', rows: [row('+39 333 1234567')] });
  await app.applyCustomerImport({ actor: ACTOR, system: 'instagram', rows: [row('guido.presti')] });
  const contacts = await app.services.contacts.list();
  assert.equal(contacts.length, 1, 'the second source matched the same contact — no parallel record');
  const subject = { resource: 'contact', id: contacts[0].id, owner: 'host' };
  const SOURCE = { package: 'host', action: 'timeline-test' };
  const scope = { modules: app.modules, actor: ACTOR, now: () => NOW };

  const first = await openConversation(scope, {
    sourceKey: 'wa:thread:1', subject, channel: 'whatsapp', remoteHandle: '+39 333 1234567', source: SOURCE,
  });
  await logMessage(scope, {
    sourceKey: 'wa:msg:1', conversationId: first.conversation.id, direction: 'inbound', channel: 'whatsapp',
    body: 'Ciao, vorrei prenotare una prova', remoteHandle: '+39 333 1234567',
    subject, occurredAt: '2026-10-20T09:00:00.000Z', source: SOURCE,
  });
  await logMessage(scope, {
    sourceKey: 'wa:msg:2', conversationId: first.conversation.id, direction: 'outbound', channel: 'whatsapp',
    body: 'Certo, ti propongo giovedi alle 18', teamAuthorId: 'guido',
    subject, occurredAt: '2026-10-20T09:05:00.000Z', source: SOURCE,
  });
  await app.runAction({ module: 'conversation', action: 'close', recordId: first.conversation.id, input: {}, actor: ACTOR });

  const second = await openConversation(scope, {
    sourceKey: 'ig:thread:1', subject, channel: 'instagram', remoteHandle: 'guido.presti', source: SOURCE,
  });
  assert.notEqual(second.conversation.id, first.conversation.id, 'the closed thread stays resolved: a new key opens a fresh one');
  await logMessage(scope, {
    sourceKey: 'ig:msg:1', conversationId: second.conversation.id, direction: 'inbound', channel: 'instagram',
    body: 'Quanto costa il pacchetto da 10 ingressi?', remoteHandle: 'guido.presti',
    subject, occurredAt: '2026-10-20T11:00:00.000Z', source: SOURCE,
  });
  await logCall({ modules: app.modules, actor: ACTOR, now: () => NOW }, {
    sourceKey: 'tel:call:1', direction: 'outbound', channel: 'phone', outcome: 'completed', durationSec: 120,
    teamAuthorId: 'guido', remoteHandle: '+39 333 1234567',
    subject, occurredAt: '2026-10-20T12:00:00.000Z', source: SOURCE,
  });

  await bookAppointment({ ...scope, moduleNames: {}, followUps: null }, {
    sourceKey: 'gym:book:1', subject, teamMemberId: 'coach-guido', serviceKey: 'pt-single',
    priceCents: 4000, currency: 'EUR',
    startsAt: '2026-10-23T16:00:00.000Z', endsAt: '2026-10-23T17:00:00.000Z', source: SOURCE,
  });
  await bookAppointment({ ...scope, moduleNames: {}, followUps: null }, {
    sourceKey: 'gym:book:2', subject, teamMemberId: 'coach-maria', serviceKey: 'pt-single',
    priceCents: 4000, currency: 'EUR', notes: 'prima visita',
    startsAt: '2026-10-22T16:00:00.000Z', endsAt: '2026-10-22T17:00:00.000Z', source: SOURCE,
  });

  return { app, contact: contacts[0] };
}

test('the timeline shows every thread with its latest entry, every booking, every contact point', async (t) => {
  const { app, contact } = await seedCustomer(t, 'hub-timeline.sqlite');

  const timeline = await app.readCustomerTimeline({ resource: 'contact', id: contact.id });
  assert.equal(timeline.customerTimelineContract, 1);

  assert.equal(timeline.conversations.available, true);
  assert.equal(timeline.conversations.count, 2);
  assert.equal(timeline.conversations.truncated, false);
  const [whatsapp, instagram] = timeline.conversations.items;
  assert.equal(whatsapp.channel, 'whatsapp');
  assert.equal(whatsapp.status, 'closed');
  assert.equal(whatsapp.peer, '+39 333 1234567');
  assert.equal(whatsapp.messageCount, 2);
  assert.equal(whatsapp.last.direction, 'outbound');
  assert.equal(whatsapp.last.body, 'Certo, ti propongo giovedi alle 18');
  assert.equal(whatsapp.lastOccurredAt, '2026-10-20T09:05:00.000Z');
  assert.equal(instagram.channel, 'instagram');
  assert.equal(instagram.status, 'open');
  assert.equal(instagram.messageCount, 1);
  assert.equal(instagram.last.direction, 'inbound');
  assert.equal(instagram.last.body, 'Quanto costa il pacchetto da 10 ingressi?');
  assert.equal(timeline.conversations.unthreadedMessages, 0);
  assert.equal(timeline.conversations.unthreadedCalls, 1, 'the call logged with no thread is counted, never dropped');

  assert.equal(timeline.appointments.available, true);
  assert.equal(timeline.appointments.count, 2);
  assert.equal(timeline.appointments.truncated, false);
  assert.deepEqual(timeline.appointments.items.map((item) => item.startsAt), [
    '2026-10-22T16:00:00.000Z',
    '2026-10-23T16:00:00.000Z',
  ], 'bookings read soonest slot first');
  assert.equal(timeline.appointments.items[0].teamMemberId, 'coach-maria');
  assert.equal(timeline.appointments.items[0].notes, 'prima visita');
  assert.equal(timeline.appointments.items[0].status, 'booked');

  const points = [...timeline.contactPoints.items].sort((a, b) => a.channel.localeCompare(b.channel));
  assert.deepEqual(points, [
    { channel: 'email', kind: 'email', value: EMAIL },
    { channel: 'instagram', kind: 'social', value: 'guido.presti' },
    { channel: 'whatsapp', kind: 'phone', value: '+39 333 1234567' },
  ], 'one contact point per channel, from the same identities the card reads');
});

test('every passage carries its channel, direction and sync state', async (t) => {
  const { app, contact } = await seedCustomer(t, 'hub-timeline-entries.sqlite');

  const timeline = await app.readCustomerTimeline({ resource: 'contact', id: contact.id });
  assert.equal(timeline.entries.available, true);
  // Four seeded channel passages: two WhatsApp messages, one Instagram
  // message, one phone call — oldest first, work notes excluded by shape.
  assert.deepEqual(
    timeline.entries.items.map((item) => [item.entry, item.channel, item.direction, item.sync]),
    [
      ['message', 'whatsapp', 'inbound', 'received'],
      ['message', 'whatsapp', 'outbound', 'sent'],
      ['message', 'instagram', 'inbound', 'received'],
      ['call', 'phone', 'outbound', 'completed'],
    ],
    'each passage names its channel, direction and delivery/sync state',
  );
  assert.equal(timeline.entries.count, timeline.entries.items.length);
  for (const item of timeline.entries.items) {
    assert.ok(item.occurredAt, `${item.id} carries its timestamp for day grouping`);
  }
});

test('reading the timeline creates no record anywhere', async (t) => {
  const { app, contact } = await seedCustomer(t, 'hub-timeline-no-write.sqlite');

  const db = app.database.raw;
  const tablesBefore = tables(db);
  assert.ok(!tablesBefore.some((name) => /customer.?hub|customers/.test(name)),
    `no customer master table exists beside the foundation's own: ${tablesBefore.join(',')}`);
  const countsBefore = counts(db);

  await app.readCustomerTimeline({ resource: 'contact', id: contact.id });
  await app.readCustomerTimeline({ resource: 'contact', id: contact.id });

  assert.deepEqual(tables(db), tablesBefore, 'a timeline read adds no table');
  assert.deepEqual(counts(db), countsBefore, 'a timeline read adds no row anywhere');
});

test('the hub declares the card edge and opens the timeline edges at operation time', async () => {
  const { createCustomerHubPackage } = await import('../packages/customer-hub/src/index.js');
  const definition = createCustomerHubPackage();
  assert.deepEqual(definition.requires, [
    { package: 'customer-data', capability: 'customer-profile', version: 1 },
  ], 'only the card profile is a startup edge, so card-only compositions keep booting; '
    + 'threads and bookings fail closed when the timeline operation opens, never at startup');
});

test('a timeline read missing any provider fails closed naming the edge', async () => {
  const { createCustomerHubPackage } = await import('../packages/customer-hub/src/index.js');
  const profile = { name: 'customer-profile', version: 1, create: () => ({}) };
  const threads = { name: 'interaction-timeline', version: 1, create: () => ({}) };
  const schedule = { name: 'appointment-schedule', version: 1, create: () => ({}) };
  const runtime = { modules: { get() { return null; } }, core: {}, database: {}, events: {}, config: {} };
  const operation = (options) => createCustomerHubPackage(options)
    .operations.find((entry) => entry.name === 'read-customer-timeline');
  // Opening never throws: the framework opens every operation at boot, and a
  // card-only composition must keep booting. The read itself refuses instead.
  const subject = { resource: 'contact', id: 'card-only' };
  await assert.rejects(
    operation({}).create(runtime)(subject),
    /customer-data.*customer-profile@1/,
    'no profile handle means no timeline stitched from the wrong tables',
  );
  await assert.rejects(
    operation({ customerData: { capabilities: [profile] } }).create(runtime)(subject),
    /interactions.*interaction-timeline@1/,
    'no threads handle means no timeline without conversations',
  );
  await assert.rejects(
    operation({
      customerData: { capabilities: [profile] },
      interactions: { capabilities: [threads] },
    }).create(runtime)(subject),
    /appointments.*appointment-schedule@1/,
    'no schedule handle means no timeline without bookings',
  );
  // The full set opens: the failure above is the missing edge, never the shape.
  const full = operation({
    customerData: { capabilities: [profile] },
    interactions: { capabilities: [threads] },
    appointments: { capabilities: [schedule] },
  }).create(runtime);
  assert.equal(typeof full, 'function', 'all three handles open the timeline read');
});

test('a timeline for a missing record says the customer does not exist', () => {
  assert.throws(
    () => shapeCustomerTimeline({
      profile: { identity: { contact: null, company: null }, externalIdentities: [] },
      threads: [], history: { entries: [] }, schedule: [],
      subject: { resource: 'contact', id: 'deleted-id' },
    }),
    (error) => error.code === 'NOT_FOUND' && error.status === 404,
    'a deleted or mistyped id throws NOT_FOUND like the card, never an empty timeline',
  );
});

test('an empty customer reads as empty sections, never as missing ones', () => {
  const timeline = shapeCustomerTimeline({
    profile: {
      identity: { contact: { firstName: 'A', lastName: 'B', email: 'a@b.it' }, company: null },
      externalIdentities: [],
    },
    threads: [], history: { entries: [] }, schedule: [],
    subject: { resource: 'contact', id: 'c1' },
  });
  assert.equal(timeline.conversations.available, true);
  assert.equal(timeline.conversations.count, 0);
  assert.deepEqual(timeline.conversations.items, []);
  assert.equal(timeline.appointments.available, true);
  assert.equal(timeline.appointments.count, 0);
  assert.equal(timeline.contactPoints.available, true);
  assert.deepEqual(timeline.contactPoints.items, [{ channel: 'email', kind: 'email', value: 'a@b.it' }],
    'the host email is a contact point even with no channel identity held');
});

test('a non-dialable channel id is never a phone contact point', () => {
  const timeline = shapeCustomerTimeline({
    profile: {
      identity: { contact: { firstName: 'A', lastName: 'B', email: 'a@b.it' }, company: null },
      externalIdentities: [
        { system: 'whatsapp', externalId: 'CRM-1' },
        { system: 'whatsapp', externalId: '+39 333 1234567' },
        { system: 'instagram', externalId: 'guido.presti' },
      ],
    },
    threads: [], history: { entries: [] }, schedule: [],
    subject: { resource: 'contact', id: 'c1' },
  });
  assert.deepEqual(timeline.contactPoints.items, [
    { channel: 'whatsapp', kind: 'phone', value: '+39 333 1234567' },
    { channel: 'instagram', kind: 'social', value: 'guido.presti' },
    { channel: 'email', kind: 'email', value: 'a@b.it' },
  ], 'CRM identifiers are held, never presented as callable — like the card');
});

test('work notes riding the same timeline read never count as unthreaded messages', () => {
  const timeline = shapeCustomerTimeline({
    profile: {
      identity: { contact: { firstName: 'A', lastName: 'B', email: 'a@b.it' }, company: null },
      externalIdentities: [],
    },
    threads: [],
    history: {
      entries: [
        { entry: 'work-note', id: 'w1', occurredAt: '2026-10-20T08:00:00.000Z', createdAt: null },
      ],
    },
    schedule: [],
    subject: { resource: 'contact', id: 'c1' },
  });
  assert.equal(timeline.conversations.count, 0);
  assert.equal(timeline.conversations.unthreadedMessages, 0, 'a work note is not channel evidence');
  assert.equal(timeline.conversations.unthreadedCalls, 0);
});

test('voce 714433c2: an operator note reads in the entries, never as channel evidence', () => {
  const timeline = shapeCustomerTimeline({
    profile: {
      identity: { contact: { firstName: 'A', lastName: 'B', email: 'a@b.it' }, company: null },
      externalIdentities: [],
    },
    threads: [],
    history: {
      entries: [
        {
          entry: 'work-note', id: 'w1', kind: 'note', body: 'Preferisce la sera.',
          taskId: null, actorType: 'user', actorId: 'elena',
          occurredAt: '2026-10-20T08:00:00.000Z', createdAt: null,
        },
        {
          entry: 'work-note', id: 'w2', kind: 'task_completed', body: 'done',
          taskId: 't1', actorType: 'user', actorId: 'elena',
          occurredAt: '2026-10-20T08:01:00.000Z', createdAt: null,
        },
      ],
    },
    schedule: [],
    subject: { resource: 'contact', id: 'c1' },
  });
  assert.equal(timeline.conversations.count, 0, 'a note opens no conversation');
  assert.equal(timeline.conversations.unthreadedMessages, 0, 'a note is not an unthreaded message');
  assert.equal(timeline.entries.count, 1, 'only the note kind reads; task lifecycle stays in the work views');
  assert.deepEqual(timeline.entries.items, [{
    entry: 'note', id: 'w1', conversationId: null, channel: null, direction: null, sync: null,
    body: 'Preferisce la sera.', teamAuthorId: 'elena', remoteHandle: null, errorCode: null,
    occurredAt: '2026-10-20T08:00:00.000Z',
  }], 'the note row is channel-less with its writer');
});

test('the 51st thread marks the conversations truncated with its exact count', () => {
  const threads = Array.from({ length: 51 }, (_, index) => ({
    id: `t${index}`, channel: 'whatsapp', status: 'closed',
    openedAt: `2026-10-${String((index % 28) + 1).padStart(2, '0')}T09:00:00.000Z`,
    closedAt: null, remoteHandle: '+39 333 1234567',
  }));
  const timeline = shapeCustomerTimeline({
    profile: {
      identity: { contact: { firstName: 'A', lastName: 'B', email: 'a@b.it' }, company: null },
      externalIdentities: [],
    },
    threads, history: { entries: [] }, schedule: [],
    subject: { resource: 'contact', id: 'c1' },
  });
  assert.equal(timeline.conversations.count, 51);
  assert.equal(timeline.conversations.items.length, 50);
  assert.equal(timeline.conversations.truncated, true, 'the rows left out mark the section truncated, like the profile');
});

test('the 51st passage marks the entries truncated with its exact count', () => {
  const entries = Array.from({ length: 51 }, (_, index) => ({
    entry: 'message', id: `m${index}`, conversationId: 't1', channel: 'whatsapp',
    direction: 'inbound', status: 'received', body: `messaggio ${index}`,
    teamAuthorId: null, remoteHandle: '+39 333 1234567', errorCode: null,
    occurredAt: `2026-10-20T09:${String(index).padStart(2, '0')}:00.000Z`,
  }));
  const timeline = shapeCustomerTimeline({
    profile: {
      identity: { contact: { firstName: 'A', lastName: 'B', email: 'a@b.it' }, company: null },
      externalIdentities: [],
    },
    threads: [], history: { entries }, schedule: [],
    subject: { resource: 'contact', id: 'c1' },
  });
  assert.equal(timeline.entries.count, 51);
  assert.equal(timeline.entries.items.length, 50);
  assert.equal(timeline.entries.truncated, true, 'the rows left out mark the section truncated, like the sibling sections');
  assert.equal(timeline.entries.items[0].id, 'm0', 'the first page keeps the oldest passages first');
});

test('the schedule read refuses a bad subject and a missing store', async () => {
  const rootUrl = pathToFileURL(join(repoRoot, 'packages/appointments/src/appointments.js')).href;
  const { createAppointmentScheduleCapability } = await import(rootUrl);
  const modules = { get: () => null };
  const empty = createAppointmentScheduleCapability({}).create({ modules });
  await assert.rejects(
    () => empty.scheduleFor({ resource: 'contact', id: 'c1', owner: 'host' }),
    (error) => error.code === 'APPOINTMENTS_STORAGE_INVALID',
    'a store without the appointment record fails closed, never an empty schedule',
  );
  await assert.rejects(
    () => empty.scheduleFor({ resource: 'contact', id: 'c1' }),
    (error) => error.name === 'ValidationError',
    'the envelope stays strict: no owner, no read',
  );
});

test('the conversations read refuses a store without its records', async () => {
  const rootUrl = pathToFileURL(join(repoRoot, 'packages/interactions/src/index.js')).href;
  const { createInteractionsPackage } = await import(rootUrl);
  const definition = createInteractionsPackage();
  const timelineCapability = definition.capabilities
    .find((entry) => entry.name === 'interaction-timeline' && entry.version === 1);
  assert.ok(timelineCapability, 'the timeline capability is still offered');
  const opened = timelineCapability.create({ modules: { get: () => null } });
  assert.equal(typeof opened.conversations, 'function', 'threads list beside the entries read');
  await assert.rejects(
    () => opened.conversations({ resource: 'contact', id: 'c1', owner: 'host' }),
    (error) => error.code === 'INTERACTIONS_STORAGE_INVALID',
    'a store without the conversation record fails closed, never an empty thread list',
  );
});
