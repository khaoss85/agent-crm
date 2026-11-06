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
  isAutomatedGmailRecipient,
  isAutomatedGmailSender,
  isBulkGmailMessage,
  parseGmailAddressHeader,
  parseGmailRecipients,
  splitGmailAddressList,
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
  // Never-human locals decide alone (arbitration 06/11): no local part
  // needs a header to read as bulk.
  for (const local of ['no-reply', 'noreply', 'donotreply', 'do-not-reply', 'mailer-daemon', 'postmaster',
    'notify', 'notification', 'notifications', 'alerts', 'order', 'order-update', 'invoice',
    'billing', 'statements', 'renewals', 'support', 'onboarding']) {
    assert.equal(isBulkGmailMessage({ from: `${local}@example.com` }), true, `${local} is bulk`);
  }
  assert.equal(
    isBulkGmailMessage({ from: 'notifications@example.com', listUnsubscribe: '<mailto:unsub@example.com>' }),
    true, 'a team local with a bulk header is bulk',
  );
  for (const domain of ['amazonses.com', 'sendgrid.net', 'mailchimp.com', 'mailgun.org']) {
    assert.equal(isBulkGmailMessage({ from: `bounce@${domain}` }), true, domain);
    assert.equal(isBulkGmailMessage({ from: `bounce@eu.${domain}` }), true, `subdomain of ${domain}`);
  }
  assert.equal(isBulkGmailMessage({ from: 'Guido Rossi <guido@example.com>' }), false);
  assert.equal(isBulkGmailMessage({ from: 'guido@example.com', precedence: 'normal' }), false);
  assert.equal(isBulkGmailMessage({}), false);
  assert.equal(isBulkGmailMessage({ from: 'not-an-address', precedence: 'bulk' }), true, 'precedence alone still marks bulk');
});

test('the 06/11 proof senders never become customers (backlog:1a4d9b30)', () => {
  // The eight addresses of the supervisor proof on Presti, each with NO
  // headers (arbitration 06/11): the bare address decides alone. None
  // becomes a lead.
  for (const from of [
    'noreply-it@klarna.com',
    'order-update@amazon.it',
    'alerts@mail.zapier.com',
    'invoice+statements@mail.anthropic.com',
    'renewals@godaddy.com',
    'hello@notify.railway.app',
    'support@contabo.com',
    'onboarding@help.example.com',
  ]) {
    assert.equal(isAutomatedGmailSender(from), true, `${from} is automated`);
    assert.equal(isBulkGmailMessage({ from }), true, `${from} is bulk`);
    assert.equal(isAutomatedGmailRecipient(from), true, `${from} is automated outbound too`);
  }
  // The acceptance vocabulary, one by one: every listed local-part alone
  // is automated, even on a plain domain with quiet headers.
  for (const local of ['noreply', 'no-reply', 'donotreply', 'notify', 'notification', 'notifications',
    'alerts', 'order', 'order-update', 'invoice', 'billing', 'statements',
    'renewals', 'support', 'onboarding', 'mailer-daemon', 'postmaster']) {
    assert.equal(isAutomatedGmailSender(`${local}@example.com`), true, `${local} alone is automated`);
    assert.equal(isBulkGmailMessage({ from: `${local}@example.com` }), true, `${local} alone is bulk`);
    assert.equal(isAutomatedGmailRecipient(`${local}@example.com`), true, `${local} alone is automated outbound too`);
  }
  // Sending subdomains automate regardless of local part (arbitration 06/11,
  // P2): any sender on a listed first label is platform traffic.
  for (const label of ['mail', 'notify', 'em', 'news', 'bounce']) {
    assert.equal(isAutomatedGmailSender(`alerts@${label}.railway.example`), true, `${label}. with a listed local is automated`);
    assert.equal(isAutomatedGmailSender(`hello@${label}.railway.example`), true, `${label}. automates a human-looking local too`);
  }
  // Boundaries a person still passes: tags, lookalike stems and domains.
  assert.equal(isAutomatedGmailSender('guido+tag@example.com'), false, 'a tagged person address stays a person');
  assert.equal(isAutomatedGmailSender('notification2@example.com'), false, 'a stem without separator stays a person');
  assert.equal(isAutomatedGmailSender('noreply-italia@example.com'), true, 'a suffixed automated stem stays automated');
  assert.equal(isAutomatedGmailSender('support-team@example.com'), true, 'a suffixed automated stem stays automated');
  assert.equal(isAutomatedGmailSender('marco@mailaziende.example'), false, 'a domain merely containing mail stays a person');
  assert.equal(isAutomatedGmailSender('marco@email.example.com'), false, 'email. is not a sending subdomain');
  assert.equal(isAutomatedGmailSender('not-an-address'), false, 'an unreadable address is simply not automated');
  assert.equal(isAutomatedGmailSender(null), false, 'a missing address is simply not automated');
});

test('Auto-Submitted other than no marks bulk, and the question splits by reason', () => {
  for (const value of ['auto-replied', 'auto-generated', 'AUTO-REPLIED']) {
    assert.equal(isBulkGmailMessage({ from: 'guido@example.com', autoSubmitted: value }), true, value);
  }
  assert.equal(isBulkGmailMessage({ from: 'guido@example.com', autoSubmitted: 'no' }), false);
  assert.equal(isBulkGmailMessage({ from: 'guido@example.com', autoSubmitted: 'NO' }), false);
  assert.equal(isBulkGmailMessage({ from: 'guido@example.com', autoSubmitted: '' }), false);
  // The split the sync round logs by: from-only asks automated-sender,
  // headers-only asks bulk-header. A listed local alone is automated
  // (arbitration 06/11), so both reasons still get exercised below.
  assert.equal(isBulkGmailMessage({ from: 'noreply@example.com' }), true, 'from alone answers automated-sender');
  assert.equal(isBulkGmailMessage({ from: 'support@contabo.com' }), true, 'a listed local alone answers automated-sender');
  assert.equal(
    isBulkGmailMessage({ from: 'team@example.com', listUnsubscribe: '<mailto:unsub@example.com>' }),
    true, 'an unlisted local with bulk headers answers bulk-header',
  );
  assert.equal(
    isBulkGmailMessage({ listUnsubscribe: '<https://example.com/unsub>' }),
    true, 'headers alone answer bulk-header',
  );
  assert.equal(
    isBulkGmailMessage({ from: 'guido@example.com', listUnsubscribe: null, precedence: null, autoSubmitted: null }),
    false, 'a real person with quiet headers stays a lead',
  );
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

test('comma-separated recipient headers split before parsing', () => {
  assert.deepEqual(
    splitGmailAddressList('"Rossi, Guido" <guido@example.com>, amica@example.com'),
    ['"Rossi, Guido" <guido@example.com>', 'amica@example.com'],
  );
  assert.deepEqual(splitGmailAddressList('  , , '), []);
  assert.deepEqual(splitGmailAddressList(42), []);
  const recipients = parseGmailRecipients(
    'Alice <alice@example.com>, Bob <bob@example.com>',
    `"Rossi, Guido" <Guido@Example.com>, alice@example.com, not-an-address, ${MAILBOX}`,
    MAILBOX,
  );
  assert.deepEqual(recipients, [
    { handle: 'alice@example.com', firstName: 'Alice' },
    { handle: 'bob@example.com', firstName: 'Bob' },
    { handle: 'guido@example.com', firstName: 'Rossi,', lastName: 'Guido' },
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

  // The recipient door on the REST path too: mail the owner sent to
  // automated addresses names nobody.
  const loopbackAuto = normalizeGmailRestMessage(
    wire([
      { name: 'From', value: MAILBOX },
      { name: 'To', value: 'support@contabo.com, noreply-it@klarna.com' },
    ]),
    MAILBOX,
  );
  assert.equal(loopbackAuto.subject, '', 'an all-automated To quarantines as evidence');
  assert.equal(loopbackAuto.sender, undefined);
  const loopbackMixed = normalizeGmailRestMessage(
    wire([
      { name: 'From', value: MAILBOX },
      { name: 'To', value: '"Amico" <amico@example.com>, support@contabo.com' },
    ]),
    MAILBOX,
  );
  assert.deepEqual(loopbackMixed.recipients, [{ handle: 'amico@example.com', firstName: 'Amico' }]);

  const bulk = normalizeGmailRestMessage(
    wire([
      { name: 'From', value: 'news@example.com' },
      { name: 'List-Unsubscribe', value: '<https://example.com/unsub>' },
    ]),
    MAILBOX,
  );
  assert.equal(bulk.subject, '');
  assert.equal(bulk.sender, undefined);

  const auto = normalizeGmailRestMessage(
    wire([
      { name: 'From', value: 'guido@example.com' },
      { name: 'Auto-Submitted', value: 'auto-replied' },
    ]),
    MAILBOX,
  );
  assert.equal(auto.subject, '', 'Auto-Submitted other than no quarantines like bulk');
  assert.equal(auto.sender, undefined);

  const manual = normalizeGmailRestMessage(
    wire([
      { name: 'From', value: 'Guido Rossi <guido@example.com>' },
      { name: 'Auto-Submitted', value: 'no' },
    ]),
    MAILBOX,
  );
  assert.equal(manual.sender.handle, 'guido@example.com', 'Auto-Submitted: no stays a person');
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

test('a real person stays a lead, with the display name (backlog:1a4d9b30)', async (t) => {
  const { harness, api, sender } = gmailScene();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const at = Date.now() - HOUR;
  api.seedMailbox([
    { id: 'human-1', threadId: 'thread-human-A', from: '"Mario Rossi" <mario.rossi@piccola-azienda.it>', internalDateMs: at },
    { id: 'human-2', threadId: 'thread-human-B', from: 'guido@example.com', internalDateMs: at + 1000 },
  ]);
  await harness.startImport(SPACE, { connectionKey: key, actor: ACTOR });
  const { result: page } = await captureInfo(
    () => harness.advanceImport(SPACE, { connectionKey: key, limit: 10 }),
  );
  assert.equal(page.page.created, 2, 'two real people, two leads');
  assert.deepEqual(
    sender.calls.map((call) => call.handle),
    ['mario.rossi@piccola-azienda.it', 'guido@example.com'],
  );
  assert.equal(sender.calls[0].firstName, 'Mario');
});

test('the recipient door is the same verdict as the inbound door (arbitration 06/11, P2)', () => {
  for (const handle of [
    'support@contabo.com',
    'noreply-it@klarna.com',
    'alerts@mail.zapier.com',
    'hello@notify.railway.app',
    'support@piccola-azienda.it',
    'support-team@azienda.it',
  ]) {
    assert.equal(
      isAutomatedGmailRecipient(handle), isBulkGmailMessage({ from: handle }),
      `${handle} reads the same inbound and outbound`,
    );
    assert.equal(isAutomatedGmailRecipient(handle), true, `${handle} is automated outbound`);
  }
  assert.equal(isAutomatedGmailRecipient('amico@example.com'), false, 'a person stays a person outbound');
  assert.equal(isAutomatedGmailRecipient('not-an-address'), false, 'an unreadable address is simply not automated');
});

test('sent mail to automated recipients creates nothing (backlog:1a4d9b30)', async (t) => {
  const { harness, api, sender } = gmailScene();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const at = Date.now() - HOUR;
  api.seedMailbox([
    {
      id: 'sent-auto', threadId: 'thread-sent-auto', from: MAILBOX,
      to: 'support@contabo.com, noreply-it@klarna.com', internalDateMs: at,
    },
    {
      id: 'sent-mixed', threadId: 'thread-sent-mixed', from: MAILBOX,
      to: '"Amico" <amico@example.com>, support@contabo.com', internalDateMs: at + 1000,
    },
  ]);
  await harness.startImport(SPACE, { connectionKey: key, actor: ACTOR });
  const { result: page } = await captureInfo(
    () => harness.advanceImport(SPACE, { connectionKey: key, limit: 10 }),
  );
  assert.equal(page.page.created, 1, 'only the human recipient became a lead');
  assert.deepEqual(sender.calls.map((call) => call.handle), ['amico@example.com']);
  const byEvent = Object.fromEntries(outcomeRows(harness).map((row) => [row.providerEventId, row.sender]));
  assert.deepEqual(byEvent, { 'sent-auto': 'none', 'sent-mixed': 'created' });
});

test('an automated-local mailbox still imports its sent-mail recipients (arbitration 06/11, P1)', async (t) => {
  const autoMailbox = 'support@azienda.it';
  const sender = stubSender();
  const { definition, api } = createGmailChannelAdapter({ mailbox: autoMailbox, secret: SECRET });
  const harness = createChannelsHarness({
    adapterDefinition: definition, fixtureApi: api, secretRef: SECRET_REF, secretValue: SECRET,
    tenantId: 'google-sync-leads', resolveSender: sender.resolveSender,
  });
  t.after(() => harness.close());
  const reg = await harness.register(SPACE, {
    channel: 'email', account: autoMailbox, adapter: GMAIL_ADAPTER_NAME, adapterVersion: GMAIL_ADAPTER_VERSION,
    secretRef: SECRET_REF,
  });
  await harness.activate(SPACE, reg.connection.sourceKey);
  const at = Date.now() - HOUR;
  api.seedMailbox([
    {
      id: 'sent-mbox-1', threadId: 'thread-sent-mbox', from: autoMailbox,
      to: '"Amico" <amico@example.com>', internalDateMs: at,
    },
  ]);
  await harness.startImport(SPACE, { connectionKey: reg.connection.sourceKey, actor: ACTOR });
  const { result: page } = await captureInfo(
    () => harness.advanceImport(SPACE, { connectionKey: reg.connection.sourceKey, limit: 10 }),
  );
  assert.equal(page.page.created, 1, 'the human recipient of an automated-local mailbox became a lead');
  assert.deepEqual(sender.calls.map((call) => call.handle), ['amico@example.com']);
  const byEvent = Object.fromEntries(outcomeRows(harness).map((row) => [row.providerEventId, row.sender]));
  assert.deepEqual(byEvent, { 'sent-mbox-1': 'created' });

  // The REST path reads the same way: the linked mailbox first, bulk after.
  const rest = normalizeGmailRestMessage(
    {
      id: 'rest-mbox-1',
      threadId: 'thread-rest-mbox',
      snippet: 'Ciao',
      internalDate: String(at),
      payload: {
        headers: [
          { name: 'From', value: autoMailbox },
          { name: 'To', value: '"Amica" <amica@example.com>' },
        ],
      },
    },
    autoMailbox,
  );
  assert.deepEqual(rest.recipients, [{ handle: 'amica@example.com', firstName: 'Amica' }]);
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
    ownerEmails: options.ownerEmails,
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

test('the calendar owner never becomes their own lead', async (t) => {
  const sender = calendarSender();
  const provider = createFakeGoogleCalendar();
  const ctx = calendarScene({ provider, subjectForEvent: () => null, resolveSender: sender.resolveSender });
  t.after(() => ctx.close());
  provider.seedEvent(CAL, {
    id: 'evt-self', summary: 'Solo titolare', ...slot('21', '13:00', '14:00'),
    organizer: { email: 'titolare@example.com', displayName: 'Titolare' },
    attendees: [{ email: 'titolare@example.com', displayName: 'Titolare', self: true }],
  });
  provider.seedEvent(CAL, {
    id: 'evt-owner-first', summary: 'Con ospite', ...slot('21', '15:00', '16:00'),
    organizer: { email: 'titolare@example.com', displayName: 'Titolare' },
    attendees: [
      { email: 'TITOLARE@example.com', displayName: 'Titolare', self: true },
      { email: 'ospite@example.com', displayName: 'Ospite Rossi' },
    ],
  });
  const result = await ctx.sync.importFuture(CAL, { timeMin: '2026-10-20T00:00:00.000Z' });
  assert.equal(result.entries.length, 2);
  const byId = Object.fromEntries(result.entries.map((entry) => [entry.eventId, entry]));
  assert.equal(byId['evt-self'].status, 'skipped', 'an owner-only event stays skipped');
  assert.equal(byId['evt-owner-first'].status, 'imported');
  assert.equal(byId['evt-owner-first'].leadCreated, true);
  assert.deepEqual(sender.calls.map((call) => call.handle), ['ospite@example.com']);
  assert.equal(ctx.appointmentRows().length, 1, 'one appointment, linked to the guest');
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

test('a large To/Cc degrades to the first 50 recipients instead of bricking the import', async (t) => {
  const { harness, api, sender } = gmailScene();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const at = Date.now() - HOUR;
  const crowd = Array.from({ length: 55 }, (_, index) => `persona${index}@example.com`);
  const parsed = parseGmailRecipients(crowd.join(', '), undefined, MAILBOX);
  assert.equal(parsed.length, 50, 'the parse stops at the history-page bound');
  assert.deepEqual(parsed.map((entry) => entry.handle), crowd.slice(0, 50));
  api.seedMailbox([
    { id: 'sent-many', threadId: 'thread-many', from: MAILBOX, to: crowd.join(', '), internalDateMs: at },
  ]);
  await harness.startImport(SPACE, { connectionKey: key, actor: ACTOR });
  const { result: page, lines } = await captureInfo(
    () => harness.advanceImport(SPACE, { connectionKey: key, limit: 10 }),
  );
  assert.equal(page.page.created, 50, 'every invented lead is counted');
  assert.ok(lines.includes('[accordo] google-sync created=50 source=gmail'));
  assert.equal(sender.seen.size, 50);
});

test('one mail to two new people reports two leads, not one row', async (t) => {
  const { harness, api, sender } = gmailScene();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const at = Date.now() - HOUR;
  api.seedMailbox([
    {
      id: 'sent-two', threadId: 'thread-two', from: MAILBOX,
      to: 'Alice <alice@example.com>, bob@example.com', internalDateMs: at,
    },
  ]);
  await harness.startImport(SPACE, { connectionKey: key, actor: ACTOR });
  const { result: page, lines } = await captureInfo(
    () => harness.advanceImport(SPACE, { connectionKey: key, limit: 10 }),
  );
  assert.equal(page.page.created, 2);
  assert.ok(lines.includes('[accordo] google-sync created=2 source=gmail'));
  assert.equal(sender.seen.size, 2);
  const rows = outcomeRows(harness);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sender, 'created', 'the row keeps its single folded outcome');
});

test('a meeting room is never a lead: a resource-only event stays skipped', async (t) => {
  const sender = calendarSender();
  const provider = createFakeGoogleCalendar();
  const ctx = calendarScene({ provider, subjectForEvent: () => null, resolveSender: sender.resolveSender });
  t.after(() => ctx.close());
  provider.seedEvent(CAL, {
    id: 'evt-room', summary: 'Sala', ...slot('21', '09:00', '10:00'),
    attendees: [{ email: 'sala@example.com', displayName: 'Sala Rossa', resource: true }],
  });
  const result = await ctx.sync.importFuture(CAL, { timeMin: '2026-10-20T00:00:00.000Z' });
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].status, 'skipped');
  assert.equal(sender.calls.length, 0, 'no room ever reaches the resolution');
  assert.equal(ctx.appointmentRows().length, 0);
});

test('an owner alias the wire cannot tell from a guest stays skipped when configured', async (t) => {
  const sender = calendarSender();
  const provider = createFakeGoogleCalendar();
  const ctx = calendarScene({
    provider,
    subjectForEvent: () => null,
    resolveSender: sender.resolveSender,
    ownerEmails: ['Titolare.Alias@Example.com'],
  });
  t.after(() => ctx.close());
  provider.seedEvent(CAL, {
    id: 'evt-alias', summary: 'Solo titolare', ...slot('21', '13:00', '14:00'),
    organizer: { email: 'titolare@example.com', displayName: 'Titolare' },
    attendees: [{ email: 'titolare.alias@example.com', displayName: 'Titolare' }],
  });
  const result = await ctx.sync.importFuture(CAL, { timeMin: '2026-10-20T00:00:00.000Z' });
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].status, 'skipped', 'the alias is not its own lead');
  assert.equal(sender.calls.length, 0);
  assert.equal(ctx.appointmentRows().length, 0);
});

test('a reschedule keeps the linked customer when the guest list changes', async (t) => {
  const sender = calendarSender();
  const provider = createFakeGoogleCalendar();
  const ctx = calendarScene({ provider, subjectForEvent: () => null, resolveSender: sender.resolveSender });
  t.after(() => ctx.close());
  provider.seedEvent(CAL, {
    id: 'evt-move', summary: 'Sessione', ...slot('21', '09:00', '10:00'),
    attendees: [{ email: 'ospite-a@example.com', displayName: 'Ospite A' }],
  });
  const first = await ctx.sync.importFuture(CAL, { timeMin: '2026-10-20T00:00:00.000Z' });
  assert.equal(first.entries[0].status, 'imported');
  assert.equal(sender.calls.length, 1);
  const booked = ctx.appointmentRows().find((row) => row.status !== 'cancelled');
  assert.equal(booked.subjectId, 'contact-cal-1');
  provider.patchEvent({
    calendarId: CAL,
    eventId: 'evt-move',
    patch: {
      ...slot('21', '14:00', '15:00'),
      attendees: [{ email: 'ospite-b@example.com', displayName: 'Ospite B' }],
    },
  });
  const pull = await ctx.sync.pullIncremental(CAL);
  const moved = pull.entries.find((entry) => entry.eventId === 'evt-move');
  assert.equal(moved.status, 'applied');
  assert.equal(moved.change, 'rescheduled');
  assert.equal(moved.leadCreated, undefined, 'no new lead on a tracked move');
  assert.equal(sender.calls.length, 1, 'the new guest list is never re-resolved');
  const fresh = ctx.appointmentRows().find((row) => row.status !== 'cancelled');
  assert.equal(fresh.subjectId, 'contact-cal-1', 'the appointment stays with its customer');
  assert.equal(fresh.startsAt, '2026-10-21T14:00:00.000Z');
});
