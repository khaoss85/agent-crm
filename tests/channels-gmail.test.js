import test from 'node:test';
import assert from 'node:assert/strict';

import { validateChannelAdapter } from '../packages/channels/src/adapter.js';
import { hmacWebhookHeaders } from '../packages/channels/src/crypto.js';
import { runChannelAdapterKit } from '../packages/channels/src/kit.js';
import {
  GMAIL_ADAPTER_NAME,
  GMAIL_ADAPTER_VERSION,
  GMAIL_MAX_TEXT,
  buildGmailSendRequest,
  canonicalGmailAddress,
  createGmailChannelAdapter,
  gmailPushBody,
  gmailThreadIdForSubject,
  gmailThreadSubject,
} from '../packages/channels/src/gmail.js';
import { createChannelsHarness } from './helpers/channels-harness.js';

/**
 * Gmail API channel adapter tests (backlog:2f621c1d81b0): the adapter
 * passes the shared channel kit on the unchanged harness, inbound mail
 * lands in the thread's conversation, a reply from the card stays in the
 * same Gmail thread, a sent copy looping back quarantines instead of
 * becoming a ghost customer, and the REST mapping is unit-proven against
 * the fake. No Google credentials anywhere: the fake secret is a declared
 * test-only value.
 */

const SPACE = 'presti';
const MAILBOX = 'presti-pilota@example.com';
const CUSTOMER = 'cliente@example.com';
const SECRET_REF = 'vault://kit/gmail-a';
const SECRET = 'gmail-fake-secret-1';
const HOUR = 3600 * 1000;

function setup(options = {}) {
  const { definition, api } = createGmailChannelAdapter({
    mailbox: MAILBOX,
    secret: SECRET,
    ...options,
  });
  const harness = createChannelsHarness({
    adapterDefinition: definition, fixtureApi: api, secretRef: SECRET_REF, secretValue: SECRET,
    tenantId: options.tenantId ?? 'channel-kit-gmail',
  });
  return { harness, api, definition };
}

async function registeredActive(harness, account = MAILBOX) {
  const reg = await harness.register(SPACE, {
    channel: 'email', account, adapter: GMAIL_ADAPTER_NAME, adapterVersion: GMAIL_ADAPTER_VERSION,
    secretRef: SECRET_REF,
  });
  await harness.activate(SPACE, reg.connection.sourceKey);
  return reg.connection.sourceKey;
}

const signedHeaders = (rawBody) => hmacWebhookHeaders(rawBody, SECRET, Math.floor(Date.now() / 1000));

/** One Gmail push delivery through the real ingest path, asserting it applies. */
async function ingestPush(harness, key, { id, threadId, from = CUSTOMER, at }) {
  const rawBody = gmailPushBody({
    id, threadId, from, to: MAILBOX, subject: 'Preventivo', internalDateMs: at,
  });
  const out = await harness.ingest(SPACE, { connectionKey: key, rawBody, headers: signedHeaders(rawBody) });
  assert.equal(out.effect, 'applied');
  return out;
}

/** The adapter definition without any harness: pure unit tests open no database and start no worker. */
function gmailDefinition(options = {}) {
  return createGmailChannelAdapter({ mailbox: MAILBOX, secret: SECRET, ...options }).definition;
}

test('the Gmail adapter passes the shared channel kit', async (t) => {
  const { harness } = setup();
  t.after(() => harness.close());
  const results = await runChannelAdapterKit({
    adapter: harness.internals.registries.getAdapter(GMAIL_ADAPTER_NAME, GMAIL_ADAPTER_VERSION).definition,
    secrets: { ref: SECRET_REF, value: SECRET },
    // The kit's default accounts are phone numbers: email needs addresses.
    accountA: 'cliente-a@example.com',
    accountB: 'cliente-b@example.com',
    harness,
  });
  assert.equal(results.length, 7);
  for (const result of results) {
    assert.equal(result.pass, true, `kit check "${result.name}" failed: ${result.detail}`);
  }
});

test('inbound mail lands in the thread conversation', async (t) => {
  const { harness } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const at = Date.now() - HOUR;
  await ingestPush(harness, key, { id: 'gmail-m1', threadId: 'thread-AAA', at });
  const rows = harness.inbox(SPACE).filter((row) => row.providerEventId === 'gmail-m1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].subject, 'email:thread-AAA');
  assert.equal(rows[0].sequence, at);
  assert.equal(rows[0].occurredAt, new Date(at).toISOString());
});

test('a reply from the card stays in the same email thread', async (t) => {
  const { harness, api } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const firstAt = Date.now() - 2 * HOUR;
  await ingestPush(harness, key, { id: 'gmail-m1', threadId: 'thread-AAA', at: firstAt });
  // The card reads the thread back out of the inbox subject and replies with it.
  const inbound = harness.inbox(SPACE).find((row) => row.providerEventId === 'gmail-m1');
  const threadId = gmailThreadIdForSubject(inbound.subject);
  assert.equal(threadId, 'thread-AAA');
  const queued = await harness.queue(SPACE, {
    connectionKey: key,
    message: { to: CUSTOMER, subject: 'Re: Preventivo', text: 'Certo, domani alle 18.', threadId },
    messageKey: 'gmail-reply-1',
  });
  const settled = await harness.pump(queued.jobId);
  assert.equal(settled.state, 'succeeded');
  const [request] = api.sentRequests();
  assert.equal(request.body.threadId, 'thread-AAA', 'the provider send carries the inbound thread');
  const mime = Buffer.from(request.body.raw, 'base64url').toString('utf8');
  assert.match(mime, new RegExp(`To: ${CUSTOMER}`));
  // The customer's follow-up in the same thread joins the same conversation.
  const laterAt = Date.now() - HOUR;
  await ingestPush(harness, key, { id: 'gmail-m2', threadId: 'thread-AAA', at: laterAt });
  // A message opening another thread opens another conversation.
  await ingestPush(harness, key, {
    id: 'gmail-m3', threadId: 'thread-BBB', from: 'altro@example.com', at: laterAt,
  });
  const sameThread = harness.inbox(SPACE).filter((row) => row.subject === 'email:thread-AAA');
  assert.deepEqual(
    sameThread.map((row) => row.providerEventId).sort(),
    ['gmail-m1', 'gmail-m2'],
    'one thread is one conversation: the reply thread and its follow-up stay together',
  );
  const otherThread = harness.inbox(SPACE).filter((row) => row.subject === 'email:thread-BBB');
  assert.equal(otherThread.length, 1);
  assert.equal(otherThread[0].providerEventId, 'gmail-m3');
});

test('a sent copy looping back quarantines, never a ghost customer', async (t) => {
  const { harness } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const rawBody = gmailPushBody({
    id: 'gmail-echo1', threadId: 'thread-AAA', from: MAILBOX, to: MAILBOX,
    internalDateMs: Date.now() - HOUR,
  });
  const out = await harness.ingest(SPACE, { connectionKey: key, rawBody, headers: signedHeaders(rawBody) });
  assert.equal(out.effect, 'quarantined');
  const rows = harness.inbox(SPACE).filter((row) => row.providerEventId === 'gmail-echo1');
  assert.equal(rows.length, 1);
  // The record module stores the empty subject as null: either way it is
  // not a conversation, so no customer row exists for our own address.
  assert.equal(rows[0].subject ?? '', '');
  assert.equal(harness.inbox(SPACE).filter((row) => (row.subject ?? '').startsWith('email:')).length, 0);
});

test('malformed pushes refuse without writing', async (t) => {
  const { harness } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const bodies = [
    'not json',
    JSON.stringify({ message: { data: '!!!not-base64!!!' } }),
    JSON.stringify({ message: { data: Buffer.from('not a notification', 'utf8').toString('base64url') } }),
    gmailPushBody({ id: 'gmail-no-thread', threadId: '', from: CUSTOMER, to: MAILBOX }),
    gmailPushBody({ id: '', threadId: 'thread-AAA', from: CUSTOMER, to: MAILBOX }),
    gmailPushBody({ id: 'gmail-no-date', threadId: 'thread-AAA', from: CUSTOMER, to: MAILBOX, internalDateMs: -1 }),
    gmailPushBody({ id: 'gmail-bad-from', threadId: 'thread-AAA', from: 'not-an-address', to: MAILBOX }),
    JSON.stringify({ object: 'unexpected' }),
  ];
  for (const [index, rawBody] of bodies.entries()) {
    await assert.rejects(
      harness.ingest(SPACE, { connectionKey: key, rawBody, headers: signedHeaders(rawBody) }),
      (error) => error.code === 'CHANNEL_EVENT_MALFORMED',
      `body ${index} refuses as malformed`,
    );
  }
  assert.equal(harness.inbox(SPACE).length, 0);
});

test('a production composition refuses the kit dialect', () => {
  const { definition } = createGmailChannelAdapter({ mailbox: MAILBOX, secret: SECRET, testOnly: false });
  assert.equal(definition.verifyInbound({ rawBody: '{}', headers: {}, secret: SECRET }).ok, false);
  assert.throws(
    () => definition.normalizeInbound(JSON.stringify({ id: 'evt-1', subject: 'chat-kit-1', seq: 1 })),
    (error) => error.code === 'CHANNEL_EVENT_MALFORMED',
  );
});

test('outbound replies validate fail-closed', () => {
  const definition = gmailDefinition();
  assert.deepEqual(
    definition.normalizeOutbound({ to: CUSTOMER, text: 'Ciao!' }),
    { to: CUSTOMER, text: 'Ciao!' },
    'without a thread id the provider opens a new thread',
  );
  assert.deepEqual(
    definition.normalizeOutbound({ to: CUSTOMER, text: 'Ciao!', threadId: 'thread-AAA' }),
    { to: CUSTOMER, text: 'Ciao!', threadId: 'thread-AAA' },
  );
  assert.deepEqual(
    definition.normalizeOutbound({ to: '  Cliente@Example.COM ', text: 'Ciao!' }),
    { to: CUSTOMER, text: 'Ciao!' },
    'addresses canonicalize to lowercase',
  );
  for (const [name, message] of [
    ['missing to', { text: 'x' }],
    ['bad to', { to: 'call-me', text: 'x' }],
    ['empty text', { to: CUSTOMER, text: '' }],
    ['overlong text', { to: CUSTOMER, text: `x${'y'.repeat(GMAIL_MAX_TEXT)}` } ],
    ['bad thread id', { to: CUSTOMER, text: 'x', threadId: 'has space' }],
    ['multiline subject', { to: CUSTOMER, text: 'x', subject: 'one\ntwo' }],
    ['non-object', 'Ciao!'],
  ]) {
    assert.throws(
      () => definition.normalizeOutbound(message),
      (error) => error.code === 'CHANNEL_MESSAGE_MALFORMED',
      `${name} refuses`,
    );
  }
  assert.equal(GMAIL_MAX_TEXT, 30000);
});

test('thread subjects round-trip for the card', () => {
  assert.equal(gmailThreadSubject('thread-AAA'), 'email:thread-AAA');
  assert.equal(gmailThreadIdForSubject('email:thread-AAA'), 'thread-AAA');
  assert.equal(gmailThreadIdForSubject('wa:+390200000002'), null);
  assert.equal(gmailThreadIdForSubject(''), null);
  assert.equal(gmailThreadIdForSubject('email:has space'), null);
  assert.throws(() => gmailThreadSubject('has space'), /thread id/);
});

test('addresses are canonical email addresses, nothing else', () => {
  assert.equal(canonicalGmailAddress('Cliente@Example.COM'), 'cliente@example.com');
  for (const bad of ['', 'not-an-address', '@example.com', 'a@', `${'a'.repeat(250)}@example.com`, 'a@b', 'a b@example.com']) {
    assert.throws(() => canonicalGmailAddress(bad), /bounded email address/);
  }
});

test('the REST mapping sends replies in-thread and opens new threads without one', () => {
  const config = { mailbox: MAILBOX, baseUrl: 'https://gmail.test' };
  const reply = buildGmailSendRequest({
    message: { to: CUSTOMER, text: 'Certo!', subject: 'Re: Preventivo', threadId: 'thread-AAA' },
    config,
    secret: SECRET,
  });
  assert.equal(reply.method, 'POST');
  assert.equal(reply.url, 'https://gmail.test/gmail/v1/users/me/messages/send');
  assert.equal(reply.headers.Authorization, `Bearer ${SECRET}`);
  assert.equal(reply.body.threadId, 'thread-AAA');
  const mime = Buffer.from(reply.body.raw, 'base64url').toString('utf8');
  assert.match(mime, new RegExp(`From: ${MAILBOX}`));
  assert.match(mime, new RegExp(`To: ${CUSTOMER}`));
  assert.match(mime, /Subject: Re: Preventivo/);
  assert.match(mime, /Certo!/);
  const fresh = buildGmailSendRequest({
    message: { to: CUSTOMER, text: 'Benvenuto!' }, config, secret: SECRET,
  });
  assert.ok(!('threadId' in fresh.body), 'a first message opens a new thread: no thread id is sent');
  assert.throws(
    () => buildGmailSendRequest({ message: { to: CUSTOMER, text: 'x' }, config, secret: '' }),
    (error) => error.code === 'CHANNEL_SECRET_UNAVAILABLE',
  );
});

test('sends are idempotent and refusals carry the provider code', async (t) => {
  const { harness, api } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const queued = await harness.queue(SPACE, {
    connectionKey: key, message: { to: CUSTOMER, text: 'Ciao!' }, messageKey: 'gmail-once',
  });
  const settled = await harness.pump(queued.jobId);
  assert.equal(settled.state, 'succeeded');
  assert.equal(api.state.sentByKey.size, 1);
  assert.match([...api.state.sentByKey.values()][0].providerMessageId, /^gmailmsg\.fake-/);
  const [request] = api.sentRequests();
  assert.equal(request.url, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
  assert.ok(!('Authorization' in request.headers), 'the retained copy never holds the call-time secret');
  api.setMode('refuse');
  const refused = await harness.queue(SPACE, {
    connectionKey: key, message: { to: CUSTOMER, text: 'no' }, messageKey: 'gmail-refused',
  });
  const dead = await harness.pump(refused.jobId);
  assert.equal(dead.state, 'failed_terminal');
  assert.equal(harness.letters(SPACE).length, 1);
  assert.equal(harness.letters(SPACE)[0].errorCode, 'CHANNEL_SEND_REFUSED');
});

test('adapter config validates fail-closed at composition', () => {
  assert.throws(() => createGmailChannelAdapter({}), /mailbox/);
  assert.throws(() => createGmailChannelAdapter({ mailbox: 'not-an-address' }), /mailbox/);
  assert.throws(
    () => createGmailChannelAdapter({ mailbox: MAILBOX, baseUrl: 'http://plain.test' }),
    /baseUrl/,
  );
  const { definition } = createGmailChannelAdapter({ mailbox: ' Presti-Pilota@Example.COM ', secret: SECRET });
  assert.equal(definition.channel, 'email');
  assert.equal(definition.config.mailbox, MAILBOX);
  assert.equal(definition.config.testOnly, true);
  assert.doesNotThrow(() => validateChannelAdapter(definition));
});
