import test from 'node:test';
import assert from 'node:assert/strict';

import { hmacWebhookHeaders } from '../packages/channels/src/crypto.js';
import {
  createWhatsAppChannelAdapter,
  WHATSAPP_ADAPTER_NAME,
  WHATSAPP_ADAPTER_VERSION,
} from '../packages/channels/src/whatsapp.js';
import {
  createInstagramChannelAdapter,
  instagramEventBody,
  instagramWebhookHeaders,
  INSTAGRAM_ADAPTER_NAME,
  INSTAGRAM_ADAPTER_VERSION,
} from '../packages/channels/src/index.js';
import {
  createGmailChannelAdapter,
  gmailPushBody,
  GMAIL_ADAPTER_NAME,
  GMAIL_ADAPTER_VERSION,
} from '../packages/channels/src/gmail.js';
import {
  assertChannelAttachment,
  readableCloudText,
} from '../packages/channels/src/meta-webhook.js';
import {
  logMessage,
  readTimeline,
  shapeAttachment,
  validateMessageRequest,
} from '../packages/interactions/src/index.js';
import { createChannelsHarness } from './helpers/channels-harness.js';

/**
 * Attachment acceptance (backlog:32820692): a photo, a video, a voice note
 * or a PDF from WhatsApp, Instagram or email is kept as a provider
 * reference (kind, name, size, fetch handle) and the card shows it — a
 * thumbnail for photos, a player or an icon with the name for audio and
 * documents — with channel markup rendered readable and no attachment
 * bytes reaching rows, logs or prompts without the host choosing to log
 * the message.
 */

const SPACE = 'presti';
const NOW = new Date('2026-10-17T12:00:00.000Z').getTime();
const TS = 1760700000;
const SUBJECT = { resource: 'contact', id: 'c-presti', owner: 'host' };
const SOURCE = { package: 'host', action: 'seed' };
const ACTOR = { type: 'user', id: 'e2e' };

const whatsappMetaBody = ({ messages, statuses } = {}) => JSON.stringify({
  object: 'whatsapp_business_account',
  entry: [{
    id: 'waba-1',
    changes: [{
      field: 'messages',
      value: {
        messaging_product: 'whatsapp',
        metadata: { display_phone_number: '390200000099', phone_number_id: '15550001111' },
        ...(messages ? { messages } : {}),
        ...(statuses ? { statuses } : {}),
      },
    }],
  }],
});

function whatsappSetup() {
  const { definition, api } = createWhatsAppChannelAdapter({
    phoneNumberId: '15550001111',
    approvedTemplates: [{ name: 'presti_reminder', language: 'it' }],
    businessNumber: '+390200000099',
    secret: 'whatsapp-fake-secret-1',
    nowMs: () => NOW,
  });
  const harness = createChannelsHarness({
    adapterDefinition: definition, fixtureApi: api,
    secretRef: 'vault://kit/whatsapp-a', secretValue: 'whatsapp-fake-secret-1',
    tenantId: 'channel-kit-attachments-wa', nowMs: () => NOW,
  });
  return harness;
}

function instagramSetup() {
  const { definition, api } = createInstagramChannelAdapter({
    secret: 'instagram-kit-secret-1', pageId: '17841400008460056', testOnly: true,
  });
  const harness = createChannelsHarness({
    adapterDefinition: definition, fixtureApi: api,
    secretRef: 'vault://presti/instagram-a', secretValue: 'instagram-kit-secret-1',
    tenantId: 'channel-kit-attachments-ig',
  });
  return harness;
}

function gmailSetup() {
  const { definition, api } = createGmailChannelAdapter({
    mailbox: 'presti-pilota@example.com', secret: 'gmail-fake-secret-1',
  });
  const harness = createChannelsHarness({
    adapterDefinition: definition, fixtureApi: api,
    secretRef: 'vault://kit/gmail-a', secretValue: 'gmail-fake-secret-1',
    tenantId: 'channel-kit-attachments-gmail',
  });
  return harness;
}

/** The host logs an applied channel event as an interaction message. */
async function hostLogs(content, sourceKey, channel) {
  let stored = null;
  const service = {
    listWhere: async () => [],
    createManaged: async (row) => { stored = row; return { id: 'm-1', ...row }; },
  };
  const modules = { get: () => ({ service }) };
  const request = {
    sourceKey, conversationId: 'conv-1', direction: 'inbound', channel,
    body: content.text === '' ? undefined : content.text,
    ...(content.attachment ? { attachment: content.attachment } : {}),
    subject: SUBJECT, occurredAt: '2026-10-17T12:00:00.000Z', source: SOURCE,
  };
  const { message } = await logMessage({ modules, actor: ACTOR }, request);
  assert.ok(stored, 'the host stores the message row');
  return { message, stored };
}

test('a WhatsApp photo is kept as a reference and the card shows the thumbnail', async (t) => {
  const harness = whatsappSetup();
  t.after(() => harness.close());
  const reg = await harness.register(SPACE, {
    channel: 'whatsapp', account: '+390200000001',
    adapter: WHATSAPP_ADAPTER_NAME, adapterVersion: WHATSAPP_ADAPTER_VERSION,
    secretRef: 'vault://kit/whatsapp-a',
  });
  await harness.activate(SPACE, reg.connection.sourceKey);
  const rawBody = whatsappMetaBody({
    messages: [{
      id: 'wamid.photo1', from: '+390200000001', timestamp: String(TS),
      type: 'image', image: { id: 'media-photo-1', caption: '*Promo* estate' },
    }],
  });
  const out = await harness.ingest(SPACE, {
    connectionKey: reg.connection.sourceKey,
    rawBody, headers: hmacWebhookHeaders(rawBody, 'whatsapp-fake-secret-1', Math.floor(Date.now() / 1000)),
  });
  assert.equal(out.effect, 'applied');
  assert.equal(out.content?.attachment?.kind, 'photo');
  assert.equal(out.content?.attachment?.ref, 'media-photo-1');
  assert.equal(out.content?.text, 'Promo estate');
  // The inbox keeps the envelope only: no attachment reference lands there.
  const rows = harness.inbox(SPACE);
  assert.equal(rows.length, 1);
  for (const key of Object.keys(rows[0])) {
    assert.ok(!key.toLowerCase().includes('attachment'), `inbox row carries no attachment column (${key})`);
  }
  assert.ok(!('text' in rows[0]), 'the inbox row carries no message text');
  // The host logs the message with its reference; the card reads the
  // thumbnail handle (preview first, fetch handle otherwise).
  const { stored } = await hostLogs(out.content, 'wa:photo:1', 'whatsapp');
  assert.equal(stored.attachmentKind, 'photo');
  assert.equal(stored.attachmentRef, 'media-photo-1');
  const card = shapeAttachment(stored);
  assert.equal(card?.kind, 'photo');
  assert.equal(card?.preview ?? card?.ref, 'media-photo-1');
});

test('an Instagram photo lands the same way, with its caption kept', async (t) => {
  const harness = instagramSetup();
  t.after(() => harness.close());
  const reg = await harness.register(SPACE, {
    channel: 'instagram', account: '17841400008460056',
    adapter: INSTAGRAM_ADAPTER_NAME, adapterVersion: INSTAGRAM_ADAPTER_VERSION,
    secretRef: 'vault://presti/instagram-a',
  });
  await harness.activate(SPACE, reg.connection.sourceKey);
  const rawBody = instagramEventBody({
    mid: 'ig-mid-1', sender: 'ig-user-7', recipient: '17841400008460056',
    text: 'Ecco la *locandina*',
    timestampMs: NOW,
    attachments: [{ type: 'image', payload: { url: 'https://cdn.example/ig/locandina.jpg' } }],
  });
  const out = await harness.ingest(SPACE, {
    connectionKey: reg.connection.sourceKey,
    rawBody, headers: instagramWebhookHeaders(rawBody, 'instagram-kit-secret-1'),
  });
  assert.equal(out.effect, 'applied');
  assert.equal(out.content?.attachment?.kind, 'photo');
  assert.equal(out.content?.attachment?.ref, 'https://cdn.example/ig/locandina.jpg');
  assert.equal(out.content?.text, 'Ecco la *locandina*');
  const { stored } = await hostLogs(out.content, 'ig:photo:1', 'instagram');
  const card = shapeAttachment(stored);
  assert.equal(card?.kind, 'photo');
  assert.equal(card?.preview ?? card?.ref, 'https://cdn.example/ig/locandina.jpg');
});

test('audio and documents arrive with a player or an icon and the name', async (t) => {
  const harness = whatsappSetup();
  t.after(() => harness.close());
  const reg = await harness.register(SPACE, {
    channel: 'whatsapp', account: '+390200000001',
    adapter: WHATSAPP_ADAPTER_NAME, adapterVersion: WHATSAPP_ADAPTER_VERSION,
    secretRef: 'vault://kit/whatsapp-a',
  });
  await harness.activate(SPACE, reg.connection.sourceKey);
  const headersFor = (rawBody) => hmacWebhookHeaders(rawBody, 'whatsapp-fake-secret-1', Math.floor(Date.now() / 1000));
  const voiceBody = whatsappMetaBody({
    messages: [{
      id: 'wamid.voice1', from: '+390200000001', timestamp: String(TS),
      type: 'audio', audio: { id: 'media-voice-1' },
    }],
  });
  const voice = await harness.ingest(SPACE, {
    connectionKey: reg.connection.sourceKey, rawBody: voiceBody, headers: headersFor(voiceBody),
  });
  assert.equal(voice.effect, 'applied');
  assert.equal(voice.content?.attachment?.kind, 'audio');
  const { stored: voiceRow } = await hostLogs(voice.content, 'wa:voice:1', 'whatsapp');
  const voiceCard = shapeAttachment(voiceRow);
  assert.equal(voiceCard?.kind, 'audio');
  assert.equal(voiceCard?.preview ?? voiceCard?.ref, 'media-voice-1');
  const docBody = whatsappMetaBody({
    messages: [{
      id: 'wamid.doc1', from: '+390200000001', timestamp: String(TS + 1),
      type: 'document', document: { id: 'media-doc-1', filename: 'preventivo.pdf' },
    }],
  });
  const doc = await harness.ingest(SPACE, {
    connectionKey: reg.connection.sourceKey, rawBody: docBody, headers: headersFor(docBody),
  });
  assert.equal(doc.effect, 'applied');
  assert.equal(doc.content?.attachment?.kind, 'document');
  assert.equal(doc.content?.attachment?.name, 'preventivo.pdf');
  const { stored: docRow } = await hostLogs(doc.content, 'wa:doc:1', 'whatsapp');
  const docCard = shapeAttachment(docRow);
  assert.equal(docCard?.kind, 'document');
  assert.equal(docCard?.name, 'preventivo.pdf');
});

test('a Gmail PDF arrives as a named document beside the readable excerpt', async (t) => {
  const harness = gmailSetup();
  t.after(() => harness.close());
  const reg = await harness.register(SPACE, {
    channel: 'email', account: 'presti-pilota@example.com',
    adapter: GMAIL_ADAPTER_NAME, adapterVersion: GMAIL_ADAPTER_VERSION,
    secretRef: 'vault://kit/gmail-a',
  });
  await harness.activate(SPACE, reg.connection.sourceKey);
  const rawBody = gmailPushBody({
    id: 'gmail-pdf-1', threadId: 'thread-AAA', from: 'cliente@example.com',
    to: 'presti-pilota@example.com', subject: 'Preventivo', snippet: 'In allegato il preventivo',
    internalDateMs: NOW,
    attachments: [{ filename: 'preventivo.pdf', mimeType: 'application/pdf', size: 42000, attachmentId: 'gmail-att-1' }],
  });
  const out = await harness.ingest(SPACE, {
    connectionKey: reg.connection.sourceKey,
    rawBody, headers: hmacWebhookHeaders(rawBody, 'gmail-fake-secret-1', Math.floor(Date.now() / 1000)),
  });
  assert.equal(out.effect, 'applied');
  assert.equal(out.content?.attachment?.kind, 'document');
  assert.equal(out.content?.attachment?.name, 'preventivo.pdf');
  assert.equal(out.content?.text, 'In allegato il preventivo');
});

test('channel markup stays readable, without raw markup', () => {
  assert.equal(readableCloudText('*Promo* estate\nseconda riga'), 'Promo estate\nseconda riga');
  assert.equal(readableCloudText('_italico_ e ~barrato~'), 'italico e barrato');
  assert.equal(readableCloudText('```codice``` fatto'), 'codice fatto');
  assert.equal(readableCloudText('2*3=6 resta'), '2*3=6 resta');
  assert.equal(readableCloudText('*senza chiusura resta'), '*senza chiusura resta');
  assert.equal(readableCloudText('ordine order_123_inviato ok'), 'ordine order_123_inviato ok');
  assert.equal(readableCloudText('(*nota*) qui'), '(nota) qui');
  const validated = validateMessageRequest({
    sourceKey: 'wa:fmt:1', conversationId: 'conv-1', direction: 'inbound',
    channel: 'whatsapp', body: 'Riga uno.\nRiga due con *grassetto*.',
    subject: SUBJECT, occurredAt: '2026-10-17T12:00:00.000Z', source: SOURCE,
  });
  assert.equal(validated.body, 'Riga uno.\nRiga due con *grassetto*.');
});

test('a photo with no caption needs no body, and text-only messages keep the old contract', () => {
  const photoOnly = validateMessageRequest({
    sourceKey: 'wa:cap:1', conversationId: 'conv-1', direction: 'inbound',
    channel: 'whatsapp',
    attachment: { kind: 'photo', ref: 'media-photo-9' },
    subject: SUBJECT, occurredAt: '2026-10-17T12:00:00.000Z', source: SOURCE,
  });
  assert.equal(photoOnly.body, null);
  assert.equal(photoOnly.attachment?.kind, 'photo');
  assert.throws(
    () => validateMessageRequest({
      sourceKey: 'wa:cap:2', conversationId: 'conv-1', direction: 'inbound',
      channel: 'whatsapp', subject: SUBJECT,
      occurredAt: '2026-10-17T12:00:00.000Z', source: SOURCE,
    }),
    /body is required/,
  );
  // A wrong-typed body is refused even beside an attachment (fail-closed).
  assert.throws(
    () => validateMessageRequest({
      sourceKey: 'wa:cap:3', conversationId: 'conv-1', direction: 'inbound',
      channel: 'whatsapp', body: 123,
      attachment: { kind: 'photo', ref: 'media-photo-9' },
      subject: SUBJECT, occurredAt: '2026-10-17T12:00:00.000Z', source: SOURCE,
    }),
    /body is required/,
  );
});

test('the timeline carries the attachment the card renders', async () => {
  const row = {
    id: 'm-photo', direction: 'inbound', channel: 'whatsapp', status: 'received',
    body: null, attachmentKind: 'photo', attachmentName: null, attachmentSize: 1234,
    attachmentRef: 'media-photo-1', attachmentPreview: null,
    teamAuthorId: null, remoteHandle: '+390200000001', errorCode: null,
    occurredAt: '2026-10-17T12:00:00.000Z', createdAt: '2026-10-17T12:00:01.000Z',
  };
  const modules = {
    get: (name) => (name === 'interaction-message'
      ? { service: { listWhere: async () => [row] } }
      : { service: { listWhere: async () => [] } }),
  };
  const timeline = await readTimeline({ modules, moduleNames: undefined }, SUBJECT);
  const found = timeline.entries.filter((entry) => entry.entry === 'message' && entry.id === 'm-photo');
  assert.equal(found.length, 1);
  assert.equal(found[0].attachment?.kind, 'photo');
  assert.equal(found[0].attachment?.preview ?? found[0].attachment?.ref, 'media-photo-1');
});

test('no attachment reference reaches logs or prompts without the host logging the message', async (t) => {
  const harness = whatsappSetup();
  t.after(() => harness.close());
  const reg = await harness.register(SPACE, {
    channel: 'whatsapp', account: '+390200000001',
    adapter: WHATSAPP_ADAPTER_NAME, adapterVersion: WHATSAPP_ADAPTER_VERSION,
    secretRef: 'vault://kit/whatsapp-a',
  });
  await harness.activate(SPACE, reg.connection.sourceKey);
  const rawBody = whatsappMetaBody({
    messages: [{
      id: 'wamid.quiet1', from: '+390200000001', timestamp: String(TS),
      type: 'image', image: { id: 'media-quiet-1' },
    }],
  });
  await harness.ingest(SPACE, {
    connectionKey: reg.connection.sourceKey,
    rawBody, headers: hmacWebhookHeaders(rawBody, 'whatsapp-fake-secret-1', Math.floor(Date.now() / 1000)),
  });
  const dump = await harness.dumpStorage();
  assert.ok(!dump.includes('media-quiet-1'), 'the attachment fetch handle never lands in rows, jobs or audit without consent');
  const auditDumps = JSON.stringify(harness.auditRows());
  assert.ok(!auditDumps.includes('media-quiet-1'), 'the audit trail carries no attachment reference');
  // Refusals name the field, never the value: a secret smuggled into a
  // fetch handle must not come back in the error.
  const smuggled = 'tok-segreto-xyz-1';
  assert.throws(
    () => assertChannelAttachment({ kind: 'photo', ref: `https://user:${smuggled}@cdn.example/x` }, 'WhatsApp'),
    (error) => {
      assert.ok(!String(error?.message ?? '').includes(smuggled), 'the refusal echoes no secret');
      return true;
    },
  );
});
