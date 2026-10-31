import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GMAIL_ADAPTER_NAME,
  GMAIL_ADAPTER_VERSION,
  createGmailChannelAdapter,
} from '../packages/channels/src/gmail.js';
import { createChannelsHarness } from './helpers/channels-harness.js';

/**
 * Scheda cliente composer «Scrivi» (backlog:e9b4fc2f): the worker logs a
 * proven Gmail send as its host subject's outbound timeline row, so the
 * message the operator just sent reads back in the scheda cronologia.
 *
 * No Google credentials anywhere: the fake secret is a declared test-only
 * value, and the timeline writer is a recording fake standing in for the
 * composed `interaction-log@1` capability (the harness opens it exactly
 * like the production composition does).
 */

const SPACE = 'presti';
const MAILBOX = 'presti-pilota@example.com';
const CUSTOMER = 'cliente@example.com';
const SECRET_REF = 'vault://kit/gmail-composer';
const SECRET = 'gmail-fake-secret-composer';

function setup() {
  const logged = [];
  const { definition, api } = createGmailChannelAdapter({ mailbox: MAILBOX, secret: SECRET });
  const harness = createChannelsHarness({
    adapterDefinition: definition,
    fixtureApi: api,
    secretRef: SECRET_REF,
    secretValue: SECRET,
    tenantId: 'channel-kit-composer',
    interactionLog: { logMessage: async (request) => { logged.push(request); return { id: `row-${logged.length}` }; } },
  });
  return { harness, api, logged };
}

async function registeredActive(harness) {
  const reg = await harness.register(SPACE, {
    channel: 'email', account: MAILBOX, adapter: GMAIL_ADAPTER_NAME, adapterVersion: GMAIL_ADAPTER_VERSION,
    secretRef: SECRET_REF,
  });
  await harness.activate(SPACE, reg.connection.sourceKey);
  return reg.connection.sourceKey;
}

const TIMELINE = { subject: { resource: 'contact', id: 'c1', owner: 'host' } };

test('e9b4fc2f: a proven Gmail send logs the subject outbound timeline row', async (t) => {
  const { harness, api, logged } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const queued = await harness.queue(SPACE, {
    connectionKey: key,
    message: { to: CUSTOMER, subject: 'Re: Preventivo', text: 'Certo, domani alle 18.', threadId: 'thread-AAA' },
    messageKey: 'composer-gmail-1',
    timeline: TIMELINE,
  });
  const settled = await harness.pump(queued.jobId);
  assert.equal(settled.state, 'succeeded');
  assert.equal(api.state.sentByKey.size, 1, 'the provider really sent once');
  assert.equal(logged.length, 1, 'the proven send logs exactly one timeline row');
  const [row] = logged;
  assert.equal(row.direction, 'outbound');
  assert.equal(row.channel, 'email');
  assert.equal(row.body, 'Certo, domani alle 18.');
  assert.equal(row.remoteHandle, CUSTOMER);
  assert.equal(row.teamAuthorId, 'channel-kit', 'the sending human stays the team author');
  assert.deepEqual(row.subject, TIMELINE.subject);
  assert.equal(row.conversationId, 'email:thread-AAA', 'the row joins the customer email thread');
  assert.match(row.sourceKey, /^channels-send:[0-9a-f]{64}$/, 'the row key derives from the send key');
});

test('e9b4fc2f: retrying the same send replays the row, never a second one', async (t) => {
  const { harness, api, logged } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const first = await harness.queue(SPACE, {
    connectionKey: key,
    message: { to: CUSTOMER, text: 'Ciao!' },
    messageKey: 'composer-gmail-retry',
    timeline: TIMELINE,
  });
  assert.equal((await harness.pump(first.jobId)).state, 'succeeded');
  const again = await harness.queue(SPACE, {
    connectionKey: key,
    message: { to: CUSTOMER, text: 'Ciao!' },
    messageKey: 'composer-gmail-retry',
    timeline: TIMELINE,
  });
  assert.equal(again.jobId, first.jobId, 'the same idempotency key replays the same job');
  assert.equal((await harness.pump(again.jobId)).state, 'succeeded');
  assert.equal(api.state.sentByKey.size, 1, 'the provider sent once');
  assert.equal(logged.length, 1, 'one row, never two');
});

test('e9b4fc2f: a send without a host subject sends with no timeline row', async (t) => {
  const { harness, api, logged } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const queued = await harness.queue(SPACE, {
    connectionKey: key,
    message: { to: CUSTOMER, text: 'Ciao!' },
    messageKey: 'composer-gmail-nosubject',
  });
  assert.equal((await harness.pump(queued.jobId)).state, 'succeeded');
  assert.equal(api.state.sentByKey.size, 1);
  assert.equal(logged.length, 0, 'no subject, no row — the send behaves exactly as before');
});
