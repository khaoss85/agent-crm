import test from 'node:test';
import assert from 'node:assert/strict';

import { hmacWebhookHeaders } from '../packages/channels/src/crypto.js';
import {
  GMAIL_ADAPTER_NAME,
  GMAIL_ADAPTER_VERSION,
  createGmailChannelAdapter,
  gmailPushBody,
} from '../packages/channels/src/gmail.js';
import { buildChannelConnectionActions } from '../packages/channels/src/index.js';
import { createChannelsHarness } from './helpers/channels-harness.js';

/**
 * Google-grant tests (backlog:43b62d4bcaa3): the Gmail adapter runs under
 * the space's Google grant from the vault. Registering the gmail
 * connection with secretRef `vault://<space>/google-gmail`, activating it
 * and starting the initial import pulls the mailbox past through the
 * vault-resolved grant; revoking stops the sync (advance refuses, inbound
 * quarantines) and no grant lands in a row, an error or a log.
 */

const SPACE = 'presti';
const MAILBOX = 'presti-pilota@example.com';
const SECRET_REF = 'vault://presti/google-gmail';
const GRANT = 'grant-vault-value-4d8b1a9036';

function setup(options = {}) {
  const { definition, api } = createGmailChannelAdapter({ mailbox: MAILBOX, secret: GRANT });
  const harness = createChannelsHarness({
    adapterDefinition: definition,
    fixtureApi: api,
    secretRef: SECRET_REF,
    secretValue: GRANT,
    tenantId: options.tenantId ?? 'channel-kit-google-grant',
  });
  return { harness, api };
}

async function registeredActive(harness) {
  const reg = await harness.register(SPACE, {
    channel: 'email',
    account: MAILBOX,
    adapter: GMAIL_ADAPTER_NAME,
    adapterVersion: GMAIL_ADAPTER_VERSION,
    secretRef: SECRET_REF,
  });
  assert.equal(reg.connection.secretRef, SECRET_REF, 'the row stores the locator, never the grant');
  await harness.activate(SPACE, reg.connection.sourceKey);
  return reg.connection.sourceKey;
}

async function revoke(harness, key) {
  const actions = Object.fromEntries(buildChannelConnectionActions().map((action) => [action.name, action]));
  const service = harness.internals.modules.get('channel-connection').service;
  return actions['revoke-connection'].execute({
    record: harness.ops.getConnection(SPACE, key),
    input: { reason: 'owner revoked the Google grant' },
    actor: harness.userActor,
    modules: harness.internals.modules,
    managed: (id, patch) => service.applyManaged(id, patch, { actor: harness.userActor }),
    now: () => new Date().toISOString(),
  });
}

const at = Date.now() - 30 * 60 * 1000;

function seedPast(api) {
  api.seedMailbox([
    { id: 'gmail-g1', threadId: 'thread-A', from: 'cliente-a@example.com', internalDateMs: at },
    { id: 'gmail-g2', threadId: 'thread-B', from: 'cliente-b@example.com', internalDateMs: at + 1000 },
    { id: 'gmail-g3', threadId: 'thread-A', from: 'cliente-a@example.com', internalDateMs: at + 2000 },
  ]);
}

test('an active Google connection starts the initial import with the vault grant', async (t) => {
  const { harness, api } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  seedPast(api);
  const started = await harness.startImport(SPACE, { connectionKey: key });
  assert.equal(started.started, true);
  const advanced = await harness.advanceImport(SPACE, { connectionKey: key });
  assert.equal(advanced.page?.imported, 3, 'the past arrives through the resolved grant');
  const subjects = new Set(harness.inbox(SPACE).map((row) => row.subject));
  assert.ok(subjects.has('email:thread-A') && subjects.has('email:thread-B'));
  const progress = harness.readImport(SPACE, { connectionKey: key });
  assert.ok(progress, 'progress is visible while the import runs');
  const dump = await harness.dumpStorage();
  assert.ok(!dump.includes(GRANT), 'the resolved grant is in no row, job, or audit entry');
  assert.ok(dump.includes(SECRET_REF), 'the locator is the only secret shape at rest');
});

test('registering with a raw grant value refuses before storage', async (t) => {
  const { harness } = setup({ tenantId: 'channel-kit-google-grant-raw' });
  t.after(() => harness.close());
  await assert.rejects(
    harness.register(SPACE, {
      channel: 'email',
      account: MAILBOX,
      adapter: GMAIL_ADAPTER_NAME,
      adapterVersion: GMAIL_ADAPTER_VERSION,
      secretRef: GRANT,
    }),
    /secretRef must be a bounded reference locator/,
  );
  assert.equal(harness.connections(SPACE).length, 0);
});

test('revoke stops the sync and no token leaks', async (t) => {
  const { harness, api } = setup({ tenantId: 'channel-kit-google-grant-revoke' });
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  seedPast(api);
  await harness.startImport(SPACE, { connectionKey: key });
  await harness.advanceImport(SPACE, { connectionKey: key });
  await revoke(harness, key);
  await assert.rejects(
    harness.advanceImport(SPACE, { connectionKey: key }),
    (error) => error?.code === 'CHANNEL_CONNECTION_NOT_ACTIVE',
  );
  const rawBody = gmailPushBody({
    id: 'gmail-late', threadId: 'thread-A', from: 'cliente-a@example.com', to: MAILBOX,
    subject: 'Dopo la revoca', internalDateMs: Date.now(),
  });
  const out = await harness.ingest(SPACE, {
    connectionKey: key,
    rawBody,
    headers: hmacWebhookHeaders(rawBody, GRANT, Math.floor(Date.now() / 1000)),
  });
  assert.equal(out.effect, 'quarantined', 'inbound after revoke is evidence, never applied');
  const late = harness.inbox(SPACE).filter((row) => row.providerEventId === 'gmail-late');
  assert.equal(late.length, 1, 'the quarantined delivery is kept as evidence');
  assert.equal(late[0].effect, 'quarantined', 'stored quarantined, never applied');
  const dump = await harness.dumpStorage();
  assert.ok(!dump.includes(GRANT), 'no grant in rows, jobs, or audit after the revoke');
});
