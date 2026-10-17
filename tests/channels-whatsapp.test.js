import test from 'node:test';
import assert from 'node:assert/strict';

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
  assert.equal(results.length, 7);
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
  assert.deepEqual(
    definition.normalizeOutbound({ to: ACCOUNT, text: 'Ciao!', lastInboundAt: hoursAgo(1) }),
    { to: ACCOUNT, kind: 'text', text: 'Ciao!' },
  );
  assert.deepEqual(
    definition.normalizeOutbound({ to: ACCOUNT, text: 'Al limite', lastInboundAt: hoursAgo(24) }),
    { to: ACCOUNT, kind: 'text', text: 'Al limite' },
    'exactly 24h is still inside the window',
  );
  assert.throws(
    () => definition.normalizeOutbound({ to: ACCOUNT, text: 'Troppo tardi', lastInboundAt: hoursAgo(25) }),
    (error) => error.code === 'CHANNEL_TEMPLATE_REQUIRED' && /24-hour window/.test(error.message),
  );
  assert.doesNotThrow(
    () => definition.normalizeOutbound({ to: ACCOUNT, text: 'Mai osservata' }),
    'a never-observed conversation attempts the send; the provider has the final word',
  );
  assert.equal(WHATSAPP_WINDOW_MS, 24 * 3600 * 1000);
});

test('outside the window only an approved template sends', () => {
  const definition = whatsappDefinition();
  const old = new Date(NOW - 25 * 3600 * 1000).toISOString();
  const sent = definition.normalizeOutbound({
    to: ACCOUNT,
    template: { name: 'presti_reminder', variables: ['Marco', 'domani alle 18'] },
    lastInboundAt: old,
  });
  assert.deepEqual(sent, {
    to: ACCOUNT,
    kind: 'template',
    template: { name: 'presti_reminder', language: 'it', variables: ['Marco', 'domani alle 18'] },
  });
  assert.throws(
    () => definition.normalizeOutbound({ to: ACCOUNT, template: { name: 'promo_fantasma' }, lastInboundAt: old }),
    /not an approved template/,
  );
  assert.throws(
    () => definition.normalizeOutbound({ to: ACCOUNT, template: { name: 'presti_reminder', language: 'en' }, lastInboundAt: old }),
    /approved language/,
  );
  assert.throws(
    () => definition.normalizeOutbound({
      to: ACCOUNT, template: { name: 'presti_reminder', variables: Array.from({ length: 33 }, (_, index) => `v${index}`) },
      lastInboundAt: old,
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
  const { definition } = createWhatsAppChannelAdapter({
    phoneNumberId: PHONE_NUMBER_ID, approvedTemplates: [], secret: SECRET,
  });
  assert.throws(
    () => definition.normalizeOutbound({ to: ACCOUNT, template: { name: 'anything' } }),
    /not an approved template/,
    'with no approved templates every template refuses',
  );
});
