import test from 'node:test';
import assert from 'node:assert/strict';

import { validateChannelAdapter } from '../packages/channels/src/adapter.js';
import { hmacWebhookHeaders } from '../packages/channels/src/crypto.js';
import { runChannelAdapterKit } from '../packages/channels/src/kit.js';
import {
  WHATSAPP_ADAPTER_NAME,
  WHATSAPP_ADAPTER_VERSION,
  WHATSAPP_WINDOW_MS,
  buildWhatsAppSendRequest,
  canonicalWhatsAppNumber,
  createWhatsAppChannelAdapter,
} from '../packages/channels/src/whatsapp.js';
import { createChannelsHarness } from './helpers/channels-harness.js';

/**
 * WhatsApp Business Cloud adapter tests (backlog:ecbd24753610): the adapter
 * passes the shared channel kit on the unchanged harness, Meta inbound
 * shapes normalize (messages, delivery/read statuses, self-echo
 * quarantine), the 24-hour window refuses free text outside it while
 * approved templates always send, and the REST mapping is unit-proven
 * against the fake. No Meta credentials anywhere: the fake secret is a
 * declared test-only value.
 */

const SPACE = 'presti';
const ACCOUNT = '+390200000001';
const SECRET_REF = 'vault://kit/whatsapp-a';
const SECRET = 'whatsapp-fake-secret-1';
const PHONE_NUMBER_ID = '15550001111';
const NOW = new Date('2026-10-17T12:00:00.000Z').getTime();
const TS = 1760700000;

function setup(options = {}) {
  const { definition, api } = createWhatsAppChannelAdapter({
    phoneNumberId: PHONE_NUMBER_ID,
    approvedTemplates: [{ name: 'presti_reminder', language: 'it' }],
    businessNumber: '+390200000099',
    secret: SECRET,
    nowMs: () => NOW,
    ...options,
  });
  const harness = createChannelsHarness({
    adapterDefinition: definition, fixtureApi: api, secretRef: SECRET_REF, secretValue: SECRET,
    tenantId: options.tenantId ?? 'channel-kit-whatsapp',
  });
  return { harness, api, definition };
}

async function registeredActive(harness, account = ACCOUNT) {
  const reg = await harness.register(SPACE, {
    channel: 'whatsapp', account, adapter: WHATSAPP_ADAPTER_NAME, adapterVersion: WHATSAPP_ADAPTER_VERSION,
    secretRef: SECRET_REF,
  });
  await harness.activate(SPACE, reg.connection.sourceKey);
  return reg.connection.sourceKey;
}

const metaBody = ({ messages, statuses } = {}) => JSON.stringify({
  object: 'whatsapp_business_account',
  entry: [{
    id: 'waba-1',
    changes: [{
      field: 'messages',
      value: {
        messaging_product: 'whatsapp',
        metadata: { display_phone_number: '390200000099', phone_number_id: PHONE_NUMBER_ID },
        ...(messages ? { messages } : {}),
        ...(statuses ? { statuses } : {}),
      },
    }],
  }],
});

const signedHeaders = (rawBody) => hmacWebhookHeaders(rawBody, SECRET, Math.floor(Date.now() / 1000));

/** One Meta text delivery through the real ingest path, asserting it applies. */
async function ingestMetaMessage(harness, key, { id, from, at }) {
  const rawBody = metaBody({
    messages: [{ id, from, timestamp: String(at), type: 'text', text: { body: 'Ciao' } }],
  });
  const out = await harness.ingest(SPACE, { connectionKey: key, rawBody, headers: signedHeaders(rawBody) });
  assert.equal(out.effect, 'applied');
  return out;
}

/** One Meta status delivery through the real ingest path. */
async function ingestMetaStatus(harness, key, { id, to, at, status }) {
  const rawBody = metaBody({
    statuses: [{ id, recipient_id: to, timestamp: String(at), status }],
  });
  return harness.ingest(SPACE, { connectionKey: key, rawBody, headers: signedHeaders(rawBody) });
}

/** The adapter definition without any harness: pure unit tests open no database and start no worker. */
function whatsappDefinition(options = {}) {
  return createWhatsAppChannelAdapter({
    phoneNumberId: PHONE_NUMBER_ID,
    approvedTemplates: [{ name: 'presti_reminder', language: 'it' }],
    businessNumber: '+390200000099',
    secret: SECRET,
    nowMs: () => NOW,
    ...options,
  }).definition;
}

test('the WhatsApp adapter passes the shared channel kit', async (t) => {
  const { harness } = setup();
  t.after(() => harness.close());
  const results = await runChannelAdapterKit({
    adapter: harness.internals.registries.getAdapter(WHATSAPP_ADAPTER_NAME, WHATSAPP_ADAPTER_VERSION).definition,
    secrets: { ref: SECRET_REF, value: SECRET },
    harness,
  });
  assert.equal(results.length, 8);
  for (const result of results) {
    assert.equal(result.pass, true, `kit check "${result.name}" failed: ${result.detail}`);
  }
});

test('Meta inbound text normalizes to the customer conversation', async (t) => {
  const { harness } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const rawBody = metaBody({
    messages: [{
      id: 'wamid.HBgMNTI0MgUCABIYFjNFQjBENDQ0RjM0NQA=', from: '390200000002', timestamp: String(TS), type: 'text',
      text: { body: 'Ciao, vorrei prenotare' },
    }],
  });
  const out = await harness.ingest(SPACE, { connectionKey: key, rawBody, headers: signedHeaders(rawBody) });
  assert.equal(out.effect, 'applied');
  const rows = harness.inbox(SPACE).filter((row) => row.providerEventId === 'wamid.HBgMNTI0MgUCABIYFjNFQjBENDQ0RjM0NQA=');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].subject, 'wa:+390200000002');
  assert.equal(rows[0].sequence, TS);
  assert.equal(rows[0].occurredAt, new Date(TS * 1000).toISOString());
});

test('delivery and read states are one row each on the same conversation', async (t) => {
  const { harness } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const ingestStatus = async (status, at) => {
    const rawBody = metaBody({
      statuses: [{ id: 'wamid.OUT1', recipient_id: '390200000002', timestamp: String(at), status }],
    });
    return harness.ingest(SPACE, { connectionKey: key, rawBody, headers: signedHeaders(rawBody) });
  };
  const delivered = await ingestStatus('delivered', TS);
  const read = await ingestStatus('read', TS + 60);
  assert.equal(delivered.effect, 'applied');
  assert.equal(read.effect, 'applied');
  const rows = harness.inbox(SPACE).filter((row) => row.subject === 'wa:+390200000002');
  assert.deepEqual(
    rows.map((row) => row.providerEventId).sort(),
    ['wamid.OUT1:delivered', 'wamid.OUT1:read'],
    'each delivery state is its own row: read never replays delivered',
  );
});

test('a self echo off the bound business number quarantines, never a ghost customer', async (t) => {
  const { harness } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const rawBody = metaBody({
    messages: [{
      id: 'wamid.ECHO1', from: '390200000099', timestamp: String(TS), type: 'text', text: { body: 'echo' },
    }],
  });
  const out = await harness.ingest(SPACE, { connectionKey: key, rawBody, headers: signedHeaders(rawBody) });
  assert.equal(out.effect, 'quarantined');
});

test('unknown statuses and malformed bodies refuse without writing', async (t) => {
  const { harness } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const unknown = metaBody({
    statuses: [{ id: 'wamid.OUT9', recipient_id: '390200000002', timestamp: String(TS), status: 'teleported' }],
  });
  await assert.rejects(
    harness.ingest(SPACE, { connectionKey: key, rawBody: unknown, headers: signedHeaders(unknown) }),
    (error) => error.code === 'CHANNEL_EVENT_MALFORMED',
  );
  await assert.rejects(
    harness.ingest(SPACE, { connectionKey: key, rawBody: 'not json', headers: signedHeaders('not json') }),
    (error) => error.code === 'CHANNEL_EVENT_MALFORMED',
  );
  assert.equal(harness.inbox(SPACE).length, 0);
});

test('free text sends inside the window and refuses outside it', () => {
  const definition = whatsappDefinition();
  const hoursAgo = (hours) => new Date(NOW - hours * 3600 * 1000).toISOString();
  const win = (lastInboundAt) => ({ lastInboundAt });
  assert.deepEqual(
    definition.normalizeOutbound({ to: ACCOUNT, text: 'Ciao!' }, win(hoursAgo(1))),
    { to: ACCOUNT, kind: 'text', text: 'Ciao!' },
  );
  assert.deepEqual(
    definition.normalizeOutbound({ to: ACCOUNT, text: 'Al limite' }, win(hoursAgo(24))),
    { to: ACCOUNT, kind: 'text', text: 'Al limite' },
    'exactly 24h is still inside the window',
  );
  assert.throws(
    () => definition.normalizeOutbound({ to: ACCOUNT, text: 'Troppo tardi' }, win(hoursAgo(25))),
    (error) => error.code === 'CHANNEL_TEMPLATE_REQUIRED' && /24-hour window/.test(error.message),
  );
  // Fail-closed: no observation, a future instant or a non-canonical one
  // never opens the window — the caller sends a template instead.
  for (const [name, ctx] of [
    ['absent context', undefined],
    ['absent observation', win(undefined)],
    ['null observation', win(null)],
    ['future observation', win(new Date(NOW + 3600 * 1000).toISOString())],
  ]) {
    assert.throws(
      () => definition.normalizeOutbound({ to: ACCOUNT, text: 'Senza prova' }, ctx),
      (error) => error.code === 'CHANNEL_TEMPLATE_REQUIRED',
      `${name} refuses fail-closed`,
    );
  }
  assert.throws(
    () => definition.normalizeOutbound({ to: ACCOUNT, text: 'x' }, win('not-a-date')),
    (error) => error.code === 'CHANNEL_MESSAGE_MALFORMED',
    'a non-instant observation is malformed, not a window refusal',
  );
  // Caller time is never read: a forged lastInboundAt in the message cannot
  // open a stale window, nor close a fresh one.
  assert.throws(
    () => definition.normalizeOutbound(
      { to: ACCOUNT, text: 'Falso fresco', lastInboundAt: hoursAgo(1) },
      win(hoursAgo(25)),
    ),
    (error) => error.code === 'CHANNEL_TEMPLATE_REQUIRED',
    'a forged fresh instant in the message is ignored',
  );
  assert.deepEqual(
    definition.normalizeOutbound(
      { to: ACCOUNT, text: 'Falso vecchio', lastInboundAt: hoursAgo(25) },
      win(hoursAgo(1)),
    ),
    { to: ACCOUNT, kind: 'text', text: 'Falso vecchio' },
    'a forged stale instant in the message is ignored',
  );
  assert.equal(WHATSAPP_WINDOW_MS, 24 * 3600 * 1000);
});

test('outside the window only an approved template sends', () => {
  const definition = whatsappDefinition();
  // Templates ignore the window entirely: no observation needed, none read.
  const sent = definition.normalizeOutbound({
    to: ACCOUNT,
    template: { name: 'presti_reminder', variables: ['Marco', 'domani alle 18'] },
  });
  assert.deepEqual(sent, {
    to: ACCOUNT,
    kind: 'template',
    template: { name: 'presti_reminder', language: 'it', variables: ['Marco', 'domani alle 18'] },
  });
  assert.throws(
    () => definition.normalizeOutbound({ to: ACCOUNT, template: { name: 'promo_fantasma' } }),
    /not an approved template/,
  );
  assert.throws(
    () => definition.normalizeOutbound({ to: ACCOUNT, template: { name: 'presti_reminder', language: 'en' } }),
    /approved language/,
  );
  assert.throws(
    () => definition.normalizeOutbound({
      to: ACCOUNT, template: { name: 'presti_reminder', variables: Array.from({ length: 33 }, (_, index) => `v${index}`) },
    }),
    /bounded list/,
  );
});

test('recipients are canonical E.164, nothing else', () => {
  assert.equal(canonicalWhatsAppNumber('+390200000001'), '+390200000001');
  assert.equal(canonicalWhatsAppNumber('390200000001'), '+390200000001');
  assert.equal(canonicalWhatsAppNumber('+39 02-000 0001'), '+39020000001');
  for (const bad of ['', 'not-a-number', '+', '++3902', '+3902abc', '+0123', '123']) {
    assert.throws(() => canonicalWhatsAppNumber(bad), /E\.164/);
  }
  const definition = whatsappDefinition();
  assert.throws(() => definition.normalizeOutbound({ to: 'call-me', text: 'hi' }), /E\.164/);
});

test('the REST mapping posts text and templates to the bound number id', () => {
  const config = {
    phoneNumberId: PHONE_NUMBER_ID, apiVersion: '21.0', baseUrl: 'https://fake-meta.test',
    approvedTemplates: [{ name: 'presti_reminder', language: 'it' }],
  };
  const textRequest = buildWhatsAppSendRequest({
    message: { to: '+390200000002', kind: 'text', text: 'Ciao!' }, config, secret: SECRET,
  });
  assert.equal(textRequest.method, 'POST');
  assert.equal(textRequest.url, `https://fake-meta.test/v21.0/${PHONE_NUMBER_ID}/messages`);
  assert.equal(textRequest.headers.Authorization, `Bearer ${SECRET}`);
  assert.deepEqual(textRequest.body, {
    messaging_product: 'whatsapp', to: '390200000002', type: 'text',
    text: { body: 'Ciao!', preview_url: false },
  });
  const templateRequest = buildWhatsAppSendRequest({
    message: {
      to: '+390200000002', kind: 'template',
      template: { name: 'presti_reminder', language: 'it', variables: ['Marco'] },
    },
    config,
    secret: SECRET,
  });
  assert.deepEqual(templateRequest.body.template, {
    name: 'presti_reminder',
    language: { code: 'it' },
    components: [{ type: 'body', parameters: [{ type: 'text', text: 'Marco' }] }],
  });
  assert.throws(
    () => buildWhatsAppSendRequest({ message: { to: '+390200000002', kind: 'text', text: 'x' }, config, secret: '' }),
    (error) => error.code === 'CHANNEL_SECRET_UNAVAILABLE',
  );
});

test('sends are idempotent and refusals carry the provider code', async (t) => {
  const { harness, api } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  await ingestMetaMessage(harness, key, { id: 'wamid.WIN1', from: '390200000001', at: Math.floor(NOW / 1000) - 60 });
  const queued = await harness.queue(SPACE, {
    connectionKey: key, message: { to: ACCOUNT, text: 'Arrivederci!' }, messageKey: 'wa-once',
  });
  const settled = await harness.pump(queued.jobId);
  assert.equal(settled.state, 'succeeded');
  assert.equal(api.state.sentByKey.size, 1);
  assert.match([...api.state.sentByKey.values()][0].providerMessageId, /^wamid\.fake-/);
  const [request] = api.sentRequests();
  assert.equal(request.url, `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`);
  api.setMode('refuse');
  const refused = await harness.queue(SPACE, {
    connectionKey: key, message: { to: ACCOUNT, text: 'no' }, messageKey: 'wa-refused',
  });
  const dead = await harness.pump(refused.jobId);
  assert.equal(dead.state, 'failed_terminal');
  assert.equal(harness.letters(SPACE).length, 1);
  assert.equal(harness.letters(SPACE)[0].errorCode, 'CHANNEL_SEND_REFUSED');
});

test('adapter config validates fail-closed at composition', () => {
  assert.throws(() => createWhatsAppChannelAdapter({}), /phoneNumberId/);
  assert.throws(() => createWhatsAppChannelAdapter({ phoneNumberId: 'abc' }), /phoneNumberId/);
  assert.throws(
    () => createWhatsAppChannelAdapter({ phoneNumberId: PHONE_NUMBER_ID, approvedTemplates: [{ name: 'BAD NAME' }] }),
    /approvedTemplates/,
  );
  // The bound business line is required: without it the echo quarantine
  // cannot tell our own number from a customer.
  assert.throws(
    () => createWhatsAppChannelAdapter({ phoneNumberId: PHONE_NUMBER_ID }),
    /businessNumber/,
  );
  assert.throws(
    () => createWhatsAppChannelAdapter({ phoneNumberId: PHONE_NUMBER_ID, businessNumber: 'call-me' }),
    /businessNumber/,
  );
  const { definition } = createWhatsAppChannelAdapter({
    phoneNumberId: PHONE_NUMBER_ID, approvedTemplates: [], secret: SECRET,
    businessNumber: '+390200000099',
  });
  assert.throws(
    () => definition.normalizeOutbound({ to: ACCOUNT, template: { name: 'anything' } }),
    /not an approved template/,
    'with no approved templates every template refuses',
  );
});

test('a batched Meta delivery stores one row per item', async (t) => {
  const { harness } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const rawBody = metaBody({
    messages: [
      { id: 'wamid.A', from: '390200000002', timestamp: String(TS), type: 'text', text: { body: 'uno' } },
      { id: 'wamid.B', from: '390200000003', timestamp: String(TS), type: 'text', text: { body: 'due' } },
    ],
    statuses: [
      { id: 'wamid.A', recipient_id: '390200000002', timestamp: String(TS + 1), status: 'delivered' },
      { id: 'wamid.B', recipient_id: '390200000003', timestamp: String(TS + 1), status: 'sent' },
    ],
  });
  const out = await harness.ingest(SPACE, { connectionKey: key, rawBody, headers: signedHeaders(rawBody) });
  assert.equal(out.batched, true);
  assert.equal(out.events.length, 4);
  for (const item of out.events) {
    assert.equal(item.effect, 'applied', `every batch item applies, got ${JSON.stringify(item)}`);
    assert.equal(item.duplicate, false);
  }
  const rows = harness.inbox(SPACE);
  assert.equal(rows.length, 4);
  assert.deepEqual(
    rows.map((row) => row.providerEventId).sort(),
    ['wamid.A', 'wamid.A:delivered', 'wamid.B', 'wamid.B:sent'],
  );
  // Redelivering the same batch resolves per item: duplicates, no new rows.
  const replay = await harness.ingest(SPACE, { connectionKey: key, rawBody, headers: signedHeaders(rawBody) });
  assert.equal(replay.batched, true);
  assert.equal(replay.events.length, 4);
  for (const item of replay.events) {
    assert.equal(item.duplicate, true);
  }
  assert.equal(harness.inbox(SPACE).length, 4, 'a batch redelivery stores nothing twice');
});

test('the real queue path resolves the window server-side and keeps the template code', async (t) => {
  const { harness } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const nowSec = Math.floor(NOW / 1000);
  // No observation anywhere: free text refuses fail-closed, never attempting.
  await assert.rejects(
    harness.queue(SPACE, {
      connectionKey: key, message: { to: ACCOUNT, text: 'Mai vista' }, messageKey: 'wa-absent',
    }),
    (error) => error.code === 'CHANNEL_TEMPLATE_REQUIRED',
  );
  // A forged fresh instant in the message never opens the window.
  await assert.rejects(
    harness.queue(SPACE, {
      connectionKey: key,
      message: { to: ACCOUNT, text: 'Falsa', lastInboundAt: new Date(NOW).toISOString() },
      messageKey: 'wa-forged',
    }),
    (error) => error.code === 'CHANNEL_TEMPLATE_REQUIRED',
  );
  assert.equal((await harness.jobs()).length, 0, 'refused sends never reach the outbox');
  // A stale observation: free text refuses with the template code intact,
  // while the approved template sends end to end.
  await ingestMetaMessage(harness, key, { id: 'wamid.OLD1', from: '390200000001', at: nowSec - 25 * 3600 });
  await assert.rejects(
    harness.queue(SPACE, {
      connectionKey: key, message: { to: ACCOUNT, text: 'Troppo tardi' }, messageKey: 'wa-stale',
    }),
    (error) => error.code === 'CHANNEL_TEMPLATE_REQUIRED',
  );
  const tpl = await harness.queue(SPACE, {
    connectionKey: key,
    message: { to: ACCOUNT, template: { name: 'presti_reminder', variables: ['Marco'] } },
    messageKey: 'wa-tpl-stale',
  });
  assert.equal((await harness.pump(tpl.jobId)).state, 'succeeded');
  // A fresh observation reopens the window — and a forged stale instant in
  // the message cannot close it again.
  await ingestMetaMessage(harness, key, { id: 'wamid.FRESH1', from: '390200000001', at: nowSec - 3600 });
  const ok = await harness.queue(SPACE, {
    connectionKey: key,
    message: {
      to: ACCOUNT, text: 'Di nuovo dentro',
      lastInboundAt: new Date(NOW - 25 * 3600 * 1000).toISOString(),
    },
    messageKey: 'wa-fresh',
  });
  assert.equal((await harness.pump(ok.jobId)).state, 'succeeded');
});

test('a future-dated inbound never opens the window', async (t) => {
  const { harness } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  await ingestMetaMessage(harness, key, {
    id: 'wamid.FUT1', from: '390200000001', at: Math.floor(NOW / 1000) + 3600,
  });
  await assert.rejects(
    harness.queue(SPACE, {
      connectionKey: key, message: { to: ACCOUNT, text: 'Dal futuro' }, messageKey: 'wa-future',
    }),
    (error) => error.code === 'CHANNEL_TEMPLATE_REQUIRED',
  );
});

test('a provider timestamp beyond +5min skew quarantines and never poisons the window', async (t) => {
  const { harness } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const realSec = Math.floor(Date.now() / 1000);
  // A message dated an hour in the real future is kept as evidence at
  // receive time: never a window observation, never a sequence.
  const futureBody = metaBody({
    messages: [{
      id: 'wamid.SKEW1', from: '390200000001', timestamp: String(realSec + 3600),
      type: 'text', text: { body: 'dal futuro' },
    }],
  });
  const future = await harness.ingest(SPACE, { connectionKey: key, rawBody: futureBody, headers: signedHeaders(futureBody) });
  assert.equal(future.effect, 'quarantined');
  const futureRows = harness.inbox(SPACE).filter((row) => row.providerEventId === 'wamid.SKEW1');
  assert.equal(futureRows.length, 1);
  assert.equal(futureRows[0].sequence, null);
  assert.match(futureRows[0].effectReason, /beyond \+5min skew/);
  // The window stays closed: the skewed row is not an observation.
  await assert.rejects(
    harness.queue(SPACE, {
      connectionKey: key, message: { to: ACCOUNT, text: 'Dal futuro' }, messageKey: 'wa-skew',
    }),
    (error) => error.code === 'CHANNEL_TEMPLATE_REQUIRED',
  );
  // Within the tolerance the delivery still applies.
  const nearBody = metaBody({
    messages: [{
      id: 'wamid.SKEW2', from: '390200000002', timestamp: String(realSec + 60),
      type: 'text', text: { body: 'quasi in orario' },
    }],
  });
  const near = await harness.ingest(SPACE, { connectionKey: key, rawBody: nearBody, headers: signedHeaders(nearBody) });
  assert.equal(near.effect, 'applied');
  // A legitimate message after the skewed one still applies (never
  // suppressed by it) and opens the window again.
  await ingestMetaMessage(harness, key, { id: 'wamid.REAL1', from: '390200000001', at: Math.floor(NOW / 1000) - 60 });
  const queued = await harness.queue(SPACE, {
    connectionKey: key, message: { to: ACCOUNT, text: 'Di nuovo dentro' }, messageKey: 'wa-after-skew',
  });
  assert.equal((await harness.pump(queued.jobId)).state, 'succeeded');
});

test('the worker rechecks the window at execution time', async (t) => {
  let now = NOW;
  const { harness, api } = setup({ nowMs: () => now });
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  await ingestMetaMessage(harness, key, { id: 'wamid.WIN2', from: '390200000001', at: Math.floor(NOW / 1000) - 60 });
  const queued = await harness.queue(SPACE, {
    connectionKey: key, message: { to: ACCOUNT, text: 'In tempo' }, messageKey: 'wa-expiry',
  });
  now += 25 * 3600 * 1000; // the job executes after the window closed
  const settled = await harness.pump(queued.jobId);
  assert.equal(settled.state, 'failed_terminal');
  assert.equal(harness.letters(SPACE).length, 1);
  assert.equal(harness.letters(SPACE)[0].errorCode, 'CHANNEL_TEMPLATE_REQUIRED');
  assert.equal(api.state.sentByKey.size, 0, 'nothing was sent outside the window');
  // A template queued after expiry still sends: the window never gates it.
  const tpl = await harness.queue(SPACE, {
    connectionKey: key,
    message: { to: ACCOUNT, template: { name: 'presti_reminder', variables: ['Marco'] } },
    messageKey: 'wa-expiry-tpl',
  });
  assert.equal((await harness.pump(tpl.jobId)).state, 'succeeded');
});

test('the fake retains the wire shape but never the secret', async (t) => {
  const { harness, api } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  await ingestMetaMessage(harness, key, { id: 'wamid.SEC1', from: '390200000001', at: Math.floor(NOW / 1000) - 60 });
  const queued = await harness.queue(SPACE, {
    connectionKey: key, message: { to: ACCOUNT, text: 'Senza segreti' }, messageKey: 'wa-sec',
  });
  assert.equal((await harness.pump(queued.jobId)).state, 'succeeded');
  const retained = JSON.stringify({ requests: api.sentRequests(), messages: api.sentMessages() });
  assert.ok(!retained.includes(SECRET), 'no retained copy carries the call-time secret');
  const [request] = api.sentRequests();
  assert.equal(request.method, 'POST');
  assert.equal(request.url, `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`);
  assert.equal(request.headers.Authorization, undefined);
  assert.equal(request.headers['Content-Type'], 'application/json');
});

test('a status to the bound business number quarantines', async (t) => {
  const { harness } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const out = await ingestMetaStatus(harness, key, {
    id: 'wamid.OUT7', to: '390200000099', at: TS, status: 'delivered',
  });
  assert.equal(out.effect, 'quarantined');
  const rows = harness.inbox(SPACE).filter((row) => row.providerEventId === 'wamid.OUT7:delivered');
  assert.equal(rows.length, 1);
  // The store reads the empty quarantine subject back as null (same as the
  // message echo): either way it is no customer conversation.
  assert.ok(!rows[0].subject, 'a status to our own line maps to no customer subject');
});

test('every delivery state is its own row', async (t) => {
  const { harness } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  for (const status of ['sent', 'delivered', 'read', 'failed']) {
    const out = await ingestMetaStatus(harness, key, {
      id: 'wamid.OUT2', to: '390200000002', at: TS, status,
    });
    assert.equal(out.effect, 'applied', `status ${status} applies`);
  }
  const rows = harness.inbox(SPACE).filter((row) => row.subject === 'wa:+390200000002');
  assert.deepEqual(
    rows.map((row) => row.providerEventId).sort(),
    ['wamid.OUT2:delivered', 'wamid.OUT2:failed', 'wamid.OUT2:read', 'wamid.OUT2:sent'],
  );
});

test('a late status of another message still applies', async (t) => {
  const { harness } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const at = Math.floor(NOW / 1000);
  const first = await ingestMetaStatus(harness, key, {
    id: 'wamid.MA', to: '390200000002', at: at + 100, status: 'delivered',
  });
  assert.equal(first.effect, 'applied');
  const second = await ingestMetaStatus(harness, key, {
    id: 'wamid.MB', to: '390200000002', at: at + 90, status: 'sent',
  });
  assert.equal(second.effect, 'applied', 'an older-timestamp status of another message is not suppressed');
  const rows = harness.inbox(SPACE).filter((row) => row.subject === 'wa:+390200000002');
  assert.deepEqual(
    rows.map((row) => row.providerEventId).sort(),
    ['wamid.MA:delivered', 'wamid.MB:sent'],
  );
});

test('the window capability validates fail-closed on the shared contract', () => {
  const definition = whatsappDefinition();
  assert.equal(definition.outboundWindow.windowMs, WHATSAPP_WINDOW_MS);
  assert.equal(definition.outboundWindow.subjectForRecipient('+390200000001'), 'wa:+390200000001');
  assert.equal(definition.outboundWindow.isObservation({ providerEventId: 'wamid.X' }), true);
  for (const status of ['sent', 'delivered', 'read', 'failed']) {
    assert.equal(
      definition.outboundWindow.isObservation({ providerEventId: `wamid.X:${status}` }),
      false,
      `a ${status} report is not a window observation`,
    );
  }
  for (const [name, bad] of [
    ['missing functions', { windowMs: WHATSAPP_WINDOW_MS }],
    ['zero window', { ...definition.outboundWindow, windowMs: 0 }],
    ['non-object', 'window'],
  ]) {
    assert.throws(
      () => validateChannelAdapter({ ...definition, outboundWindow: bad }),
      /outboundWindow/,
      `${name} refuses`,
    );
  }
  assert.throws(
    () => validateChannelAdapter({ ...definition, extra: 1 }),
    /unsupported field/,
    'unrelated fields still refuse',
  );
});
