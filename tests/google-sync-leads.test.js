import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  GMAIL_ADAPTER_NAME,
  GMAIL_ADAPTER_VERSION,
  createGmailChannelAdapter,
  formatGoogleSyncLog,
  gmailPushBody,
  isBulkGmailMessage,
  parseGmailAddressHeader,
  parseGmailRecipients,
  splitGmailDisplayName,
} from '../packages/channels/src/gmail.js';
import { normalizeGmailRestMessage } from '../packages/channels/src/gmail-http.js';
import { hmacWebhookHeaders } from '../packages/channels/src/crypto.js';
import { createChannelsHarness } from './helpers/channels-harness.js';
import { boot, project } from './helpers/customer-data-project.js';
import { createDatabase } from '../packages/core/src/database.js';
import { AuditLog } from '../packages/core/src/audit.js';
import { EventBus } from '../packages/core/src/event-bus.js';
import {
  createRecordModuleFromManifest,
  recordModuleMigrations,
} from '../packages/core/src/record-module-runtime.js';
import { createAppointmentBookCapability } from '../packages/appointments/src/appointments.js';
import { createCalendarSyncOperations } from '../packages/calendar-sync/src/sync.js';
import { createFakeGoogleCalendar } from '../packages/calendar-sync/src/google-fake.js';

/**
 * Google sync auto-leads (backlog:13c09f03): an unknown sender becomes a
 * lead, the owner's sent mail imports its recipients, mass mail creates
 * nothing, an unknown calendar invitee becomes a lead with its
 * appointment, events without external invitees stay skipped, every
 * creation lands in the log without an address in the clear, and a
 * second sighting of the same person reuses the one profile.
 */

const SPACE = 'presti';
const MAILBOX = 'presti-pilota@example.com';
const SECRET_REF = 'vault://kit/google-sync-leads';
const SECRET = 'google-sync-leads-secret';
const ACTOR = { type: 'user', id: 'google-sync-leads' };
const HOUR = 3600 * 1000;

test('bulk mail is recognized by headers, sender locals and notification domains', () => {
  for (const from of [
    'newsletter@example.com',
    'news@example.com',
  ]) {
    assert.equal(
      isBulkGmailMessage({ from, listUnsubscribe: '<mailto:unsub@example.com>' }),
      true, `List-Unsubscribe marks ${from} as bulk`,
    );
  }
  for (const precedence of ['bulk', 'list', 'junk']) {
    assert.equal(isBulkGmailMessage({ from: 'team@example.com', precedence }), true);
    assert.equal(isBulkGmailMessage({ from: 'team@example.com', precedence: precedence.toUpperCase() }), true);
  }
  for (const local of ['no-reply', 'noreply', 'donotreply', 'do-not-reply', 'notifications', 'mailer-daemon', 'postmaster']) {
    assert.equal(isBulkGmailMessage({ from: `${local}@example.com` }), true, `${local} is bulk`);
  }
  for (const domain of ['amazonses.com', 'sendgrid.net', 'mailchimp.com', 'mailgun.org']) {
    assert.equal(isBulkGmailMessage({ from: `bounce@${domain}` }), true, domain);
    assert.equal(isBulkGmailMessage({ from: `bounce@eu.${domain}` }), true, `subdomain of ${domain}`);
  }
  assert.equal(isBulkGmailMessage({ from: 'Guido Rossi <guido@example.com>' }), false);
  assert.equal(isBulkGmailMessage({ from: 'guido@example.com', precedence: 'normal' }), false);
  assert.equal(isBulkGmailMessage({}), false);
  assert.equal(isBulkGmailMessage({ from: 'not-an-address', precedence: 'bulk' }), true, 'precedence alone still marks bulk');
});

test('address headers parse display names and recipients exclude the mailbox', () => {
  assert.deepEqual(parseGmailAddressHeader('"Rossi, Guido" <Guido@Example.com>'), {
    address: 'guido@example.com', firstName: 'Rossi,', lastName: 'Guido',
  });
  assert.deepEqual(parseGmailAddressHeader('  cliente@example.com  '), {
    address: 'cliente@example.com', firstName: null, lastName: null,
  });
  assert.throws(() => parseGmailAddressHeader('not-an-address'), /bounded email address/);
  assert.deepEqual(splitGmailDisplayName('  '), { firstName: null, lastName: null });
  const recipients = parseGmailRecipients(
    ['"Amico Uno" <uno@example.com>', 'uno@example.com', 'not-an-address', MAILBOX],
    'due@example.com',
    MAILBOX,
  );
  assert.deepEqual(recipients, [
    { handle: 'uno@example.com', firstName: 'Amico', lastName: 'Uno' },
    { handle: 'due@example.com' },
  ]);
});

test('the google-sync log line carries counts, never addresses', () => {
  assert.equal(formatGoogleSyncLog({ created: 3, source: 'gmail' }), 'google-sync created=3 source=gmail');
  assert.equal(formatGoogleSyncLog({ created: 1, source: 'calendar' }), 'google-sync created=1 source=calendar');
  assert.equal(formatGoogleSyncLog({}), 'google-sync created=0 source=gmail');
});

test('the REST reader carries sender names, recipients and bulk like the fake', () => {
  const at = Date.now() - HOUR;
  const wire = (headers, extra = {}) => ({
    id: 'rest-1',
    threadId: 'thread-AAA',
    snippet: 'Ciao',
    internalDate: String(at),
    payload: { headers },
    ...extra,
  });
  const from = normalizeGmailRestMessage(
    wire([{ name: 'From', value: '"Nuova Persona" <nuova@example.com>' }]),
    MAILBOX,
  );
  assert.equal(from.sender.handle, 'nuova@example.com');
  assert.equal(from.sender.firstName, 'Nuova');
  assert.equal(from.sender.lastName, 'Persona');

  const loopback = normalizeGmailRestMessage(
    wire([
      { name: 'From', value: MAILBOX },
      { name: 'To', value: '"Amico" <amico@example.com>' },
    ]),
    MAILBOX,
  );
  assert.deepEqual(loopback.recipients, [{ handle: 'amico@example.com', firstName: 'Amico' }]);

  const bulk = normalizeGmailRestMessage(
    wire([
      { name: 'From', value: 'news@example.com' },
      { name: 'List-Unsubscribe', value: '<https://example.com/unsub>' },
    ]),
    MAILBOX,
  );
  assert.equal(bulk.subject, '');
  assert.equal(bulk.sender, undefined);
});

/** Emulates the resolution contract: first sighting creates, repeats match. */
function stubSender() {
  const seen = new Map();
  const calls = [];
  const resolveSender = async (request) => {
    calls.push(request);
    if (seen.has(request.handle)) {
      return { outcome: 'matched', contact: { id: seen.get(request.handle) } };
    }
    const id = `contact-${seen.size + 1}`;
    seen.set(request.handle, id);
    return { outcome: 'created', contact: { id } };
  };
  return { resolveSender, calls, seen };
}

function gmailScene() {
  const sender = stubSender();
  const { definition, api } = createGmailChannelAdapter({ mailbox: MAILBOX, secret: SECRET });
  const harness = createChannelsHarness({
    adapterDefinition: definition, fixtureApi: api, secretRef: SECRET_REF, secretValue: SECRET,
    tenantId: 'google-sync-leads', resolveSender: sender.resolveSender,
  });
  return { harness, api, sender };
}

async function registeredActive(harness) {
  const reg = await harness.register(SPACE, {
    channel: 'email', account: MAILBOX, adapter: GMAIL_ADAPTER_NAME, adapterVersion: GMAIL_ADAPTER_VERSION,
    secretRef: SECRET_REF,
  });
  await harness.activate(SPACE, reg.connection.sourceKey);
  return reg.connection.sourceKey;
}

function outcomeRows(harness) {
  return harness.internals.modules.get('channel-import-outcome').service.listWhere({});
}

/** Capture console.info lines while the callback runs. */
async function captureInfo(callback) {
  const lines = [];
  const info = console.info;
  console.info = (line) => { lines.push(String(line)); };
  try {
    const result = await callback();
    return { result, lines };
  } finally {
    console.info = info;
  }
}

test('a new sender becomes a lead with the From name and the log counts it', async (t) => {
  const { harness, api, sender } = gmailScene();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const at = Date.now() - HOUR;
  api.seedMailbox([
    { id: 'lead-1', threadId: 'thread-lead-A', from: '"Nuova Persona" <nuova@example.com>', internalDateMs: at },
  ]);
  await harness.startImport(SPACE, { connectionKey: key, actor: ACTOR });
  const { result: page, lines } = await captureInfo(
    () => harness.advanceImport(SPACE, { connectionKey: key, limit: 10 }),
  );
  assert.equal(page.page.created, 1);
  assert.equal(page.page.matched, 0);
  assert.equal(sender.calls.length, 1);
  assert.equal(sender.calls[0].handle, 'nuova@example.com');
  assert.equal(sender.calls[0].firstName, 'Nuova');
  assert.equal(sender.calls[0].lastName, 'Persona');
  assert.equal(sender.calls[0].origin, 'gmail');
  assert.ok(lines.includes('[accordo] google-sync created=1 source=gmail'), `log lines: ${JSON.stringify(lines)}`);
  const rows = outcomeRows(harness);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sender, 'created');
  assert.ok(!JSON.stringify(rows).includes('nuova@example.com'), 'no address in the outcome rows');
});

test('mass mail creates nothing and never reaches the resolution', async (t) => {
  const { harness, api, sender } = gmailScene();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const at = Date.now() - HOUR;
  api.seedMailbox([
    {
      id: 'bulk-1', threadId: 'thread-bulk-A', from: 'news@example.com', internalDateMs: at,
      headers: { listUnsubscribe: '<https://example.com/unsub>', precedence: 'bulk' },
    },
    {
      id: 'bulk-2', threadId: 'thread-bulk-B', from: 'no-reply@example.com', internalDateMs: at + 1000,
    },
  ]);
  await harness.startImport(SPACE, { connectionKey: key, actor: ACTOR });
  const { result: page, lines } = await captureInfo(
    () => harness.advanceImport(SPACE, { connectionKey: key, limit: 10 }),
  );
  assert.equal(page.page.created, 0);
  assert.equal(sender.calls.length, 0, 'bulk never names a sender');
  assert.ok(!lines.some((line) => line.includes('google-sync')), 'no log line without creations');
  assert.ok(outcomeRows(harness).every((row) => row.sender === 'none'));
});

test('sent mail imports its recipients: a new person becomes a lead', async (t) => {
  const { harness, api, sender } = gmailScene();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const at = Date.now() - HOUR;
  api.seedMailbox([
    {
      id: 'sent-1', threadId: 'thread-sent-A', from: MAILBOX, to: '"Amico" <amico@example.com>',
      internalDateMs: at,
    },
    { id: 'sent-2', threadId: 'thread-sent-B', from: MAILBOX, to: MAILBOX, internalDateMs: at + 1000 },
  ]);
  await harness.startImport(SPACE, { connectionKey: key, actor: ACTOR });
  const { result: page } = await captureInfo(
    () => harness.advanceImport(SPACE, { connectionKey: key, limit: 10 }),
  );
  assert.equal(page.page.created, 1, 'the recipient became a lead, the self-only loopback nothing');
  assert.deepEqual(sender.calls.map((call) => call.handle), ['amico@example.com']);
  const byEvent = Object.fromEntries(outcomeRows(harness).map((row) => [row.providerEventId, row.sender]));
  assert.deepEqual(byEvent, { 'sent-1': 'created', 'sent-2': 'none' });
});

test('a second mail from the same person reuses the one profile', async (t) => {
  const { harness, api, sender } = gmailScene();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const at = Date.now() - HOUR;
  api.seedMailbox([
    { id: 'twice-1', threadId: 'thread-twice-A', from: 'ripetuta@example.com', internalDateMs: at },
    { id: 'twice-2', threadId: 'thread-twice-B', from: 'Ripetuta <ripetuta@example.com>', internalDateMs: at + 1000 },
  ]);
  await harness.startImport(SPACE, { connectionKey: key, actor: ACTOR });
  const page = await harness.advanceImport(SPACE, { connectionKey: key, limit: 10 });
  assert.equal(page.page.created, 1);
  assert.equal(page.page.matched, 1);
  assert.equal(sender.seen.size, 1, 'one handle resolved, one profile');
  const byEvent = Object.fromEntries(outcomeRows(harness).map((row) => [row.providerEventId, row.sender]));
  assert.deepEqual(byEvent, { 'twice-1': 'created', 'twice-2': 'matched' });
});

test('the origin rides the identity run: gmail, calendar, or the plain run', async (t) => {
  const root = project(t, {});
  const context = await boot(root, join(root, 'data', 'sync-leads-origin.sqlite'));
  t.after(() => context.close());
  const { app } = context;
  const identitiesOf = (contactId) => app.modules.get('external-identity').service
    .listWhere({ subjectResource: 'contact', subjectId: contactId, status: 'active' });

  const viaGmail = await app.resolveChannelSender({
    channel: 'email', handle: 'origine@example.com', firstName: 'Origine', origin: 'gmail', actor: ACTOR,
  });
  assert.equal(viaGmail.outcome, 'created');
  assert.deepEqual(
    identitiesOf(viaGmail.contact.id).map((row) => row.firstObservedRunId),
    ['channel-sender:gmail'],
  );

  // The same person through the calendar sync: one profile, both runs on it.
  const viaCalendar = await app.resolveChannelSender({
    channel: 'email', handle: 'Origine@Example.com', origin: 'calendar', actor: ACTOR,
  });
  assert.equal(viaCalendar.outcome, 'matched');
  assert.equal(viaCalendar.contact.id, viaGmail.contact.id);
  const rows = identitiesOf(viaGmail.contact.id);
  assert.equal(rows.length, 1, 'one profile for the same address across both syncs');
  assert.equal(rows[0].firstObservedRunId, 'channel-sender:gmail');
  assert.equal(rows[0].lastObservedRunId, 'channel-sender:calendar');

  const plain = await app.resolveChannelSender({
    channel: 'email', handle: 'neutra@example.com', actor: ACTOR,
  });
  assert.equal(plain.outcome, 'created');
  assert.deepEqual(
    identitiesOf(plain.contact.id).map((row) => row.firstObservedRunId),
    ['channel-sender'],
  );

  await assert.rejects(
    app.resolveChannelSender({ channel: 'email', handle: 'x@example.com', origin: 'sms', actor: ACTOR }),
    /origin/,
    'an unknown origin refuses instead of silently unattributing the lead',
  );
});

const here = dirname(fileURLToPath(import.meta.url));
const manifest = (pkg, name) => JSON.parse(
  readFileSync(join(here, '..', 'packages', pkg, 'modules', `${name}.module.json`), 'utf8'),
);

const CAL = 'presti-room-1';
const MEMBER = 'coach-guido';
const SERVICE = { serviceKey: 'pt-single', priceCents: 4000, currency: 'EUR' };
const CAL_SUBJECT = { resource: 'contact', id: 'c-presti', owner: 'host', label: 'Presti Group' };

const slot = (day, from, to) => ({
  start: { dateTime: `2026-10-${day}T${from}:00.000Z` },
  end: { dateTime: `2026-10-${day}T${to}:00.000Z` },
});

function calendarScene(options = {}) {
  const database = createDatabase({ path: ':memory:' });
  const manifests = [
    { name: 'appointment', manifest: manifest('appointments', 'appointment') },
    { name: 'calendar-link', manifest: manifest('calendar-sync', 'calendar-link') },
    { name: 'calendar-sync-state', manifest: manifest('calendar-sync', 'calendar-sync-state') },
  ];
  for (const { sql } of recordModuleMigrations(manifests)) database.raw.exec(sql);
  const audit = new AuditLog(database);
  const events = new EventBus();
  const modules = new Map();
  for (const { name, manifest: body } of manifests) {
    modules.set(name, { service: createRecordModuleFromManifest(body, { database, audit, events, references: {} }).service });
  }
  const provider = options.provider;
  const appointmentBook = createAppointmentBookCapability({});
  const mapping = {
    subjectForEvent: options.subjectForEvent ?? (() => ({ ...CAL_SUBJECT })),
    teamMemberForCalendar: () => MEMBER,
    serviceForEvent: () => ({ ...SERVICE }),
    summaryForAppointment: (row) => `Appointment ${row.serviceKey} ${row.startsAt}`,
  };
  const sync = createCalendarSyncOperations({
    modules, appointmentBook, provider, mapping, database,
    resolveSender: options.resolveSender ?? null,
    actor: ACTOR, now: () => new Date().toISOString(),
  });
  return {
    database, modules, provider, sync,
    appointmentRows: () => [...modules.get('appointment').service.listWhere({})],
    linkRows: () => [...modules.get('calendar-link').service.listWhere({})],
    close: () => database.close(),
  };
}

function calendarSender() {
  const calls = [];
  const seen = new Map();
  const resolveSender = async (request) => {
    calls.push(request);
    assert.equal(request.origin, 'calendar');
    assert.equal(request.channel, 'email');
    if (seen.has(request.handle)) {
      return { outcome: 'matched', contact: { id: seen.get(request.handle) } };
    }
    const id = `contact-cal-${seen.size + 1}`;
    seen.set(request.handle, id);
    return { outcome: 'created', contact: { id } };
  };
  return { resolveSender, calls, seen };
}

test('an unknown invitee becomes a lead with the appointment linked', async (t) => {
  const sender = calendarSender();
  const provider = createFakeGoogleCalendar();
  const ctx = calendarScene({ provider, subjectForEvent: () => null, resolveSender: sender.resolveSender });
  t.after(() => ctx.close());
  provider.seedEvent(CAL, {
    id: 'evt-lead', summary: 'Sessione', ...slot('21', '09:00', '10:00'),
    attendees: [{ email: 'ospite@example.com', displayName: 'Ospite Rossi' }],
  });
  const { result, lines } = await captureInfo(
    () => ctx.sync.importFuture(CAL, { timeMin: '2026-10-20T00:00:00.000Z' }),
  );
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].status, 'imported');
  assert.equal(result.entries[0].leadCreated, true);
  assert.equal(sender.calls.length, 1);
  assert.equal(sender.calls[0].handle, 'ospite@example.com');
  assert.equal(sender.calls[0].firstName, 'Ospite');
  assert.equal(sender.calls[0].lastName, 'Rossi');
  assert.equal(ctx.appointmentRows().length, 1, 'the appointment is booked');
  assert.equal(ctx.linkRows().length, 1, 'the event is linked');
  assert.equal(ctx.linkRows()[0].appointmentId, result.entries[0].appointmentId);
  assert.ok(lines.includes('[accordo] google-sync created=1 source=calendar'), `log lines: ${JSON.stringify(lines)}`);
  const status = await ctx.sync.readSyncStatus({ calendarId: CAL });
  assert.equal(status.lastRun.created, 1);
  assert.equal(status.lastRun.error, null);

  // A second run replays the link: no second lead, no second appointment.
  const again = await ctx.sync.importFuture(CAL, { timeMin: '2026-10-20T00:00:00.000Z' });
  assert.ok(again.entries.every((entry) => entry.status === 'already-tracked'));
  assert.equal(sender.calls.length, 1, 'idempotent across runs');
  assert.equal(ctx.appointmentRows().length, 1);
});

test('events without external invitees stay skipped', async (t) => {
  const sender = calendarSender();
  const provider = createFakeGoogleCalendar();
  const ctx = calendarScene({ provider, subjectForEvent: () => null, resolveSender: sender.resolveSender });
  t.after(() => ctx.close());
  provider.seedEvent(CAL, {
    id: 'evt-bare', summary: 'Solo', ...slot('21', '11:00', '12:00'),
  });
  provider.seedEvent(CAL, {
    id: 'evt-org', summary: 'Solo titolare', ...slot('21', '13:00', '14:00'),
    organizer: { email: 'titolare@example.com', displayName: 'Titolare' },
  });
  const result = await ctx.sync.importFuture(CAL, { timeMin: '2026-10-20T00:00:00.000Z' });
  assert.equal(result.entries.length, 2);
  assert.ok(result.entries.every((entry) => entry.status === 'skipped'));
  assert.equal(sender.calls.length, 0, 'the organizer alone is not an invitee');
  assert.equal(ctx.appointmentRows().length, 0);
});

test('an unwired calendar composition keeps skipping unmapped events', async (t) => {
  const provider = createFakeGoogleCalendar();
  const ctx = calendarScene({ provider, subjectForEvent: () => null });
  t.after(() => ctx.close());
  provider.seedEvent(CAL, {
    id: 'evt-unwired', summary: 'Senza composizione', ...slot('21', '09:00', '10:00'),
    attendees: [{ email: 'esterno@example.com' }],
  });
  const result = await ctx.sync.importFuture(CAL, { timeMin: '2026-10-20T00:00:00.000Z' });
  assert.equal(result.entries[0].status, 'skipped');
  assert.equal(ctx.appointmentRows().length, 0);
});
