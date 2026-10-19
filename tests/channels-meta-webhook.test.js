import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import {
  META_CUSTOMER_SERVICE_WINDOW_MS,
  checkMetaServiceWindow,
  createInstagramChannelAdapter,
  createMessengerChannelAdapter,
  createWhatsAppChannelAdapter,
  isMetaSelfEcho,
  iterateMetaBatchItems,
  parseMetaWebhookBody,
  verifyMetaHubSignature,
} from '../packages/channels/src/index.js';

/**
 * The shared Meta webhook module (backlog:87d4769dde7e).
 *
 * WhatsApp (#232) and Instagram (#233) fixed the same three defects in
 * separate reviews — batched deliveries truncated to the first message,
 * echoes off our own account applied as customer inbound, and the 24-hour
 * window read from caller time or adapter memory. Both adapters now
 * delegate to the one module in `packages/channels/src/meta-webhook.js`;
 * these tests prove the module once, with mixed batches carrying both
 * Meta dialects, and prove each adapter routes through it.
 */

const NOW = Date.parse('2026-10-10T12:00:00.000Z');
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const SKEW_MS = 5 * 60 * 1000;
const PAGE_ID = '17841400008460056';
const BUSINESS_NUMBER = '+15551234567';

const atIso = (ms) => new Date(ms).toISOString();

test('the shared window constant is the Meta 24-hour rule', () => {
  assert.equal(META_CUSTOMER_SERVICE_WINDOW_MS, 24 * 3600 * 1000);
});

test('parseMetaWebhookBody parses objects and refuses the rest', () => {
  assert.deepEqual(parseMetaWebhookBody('{"entry":[]}', 'WhatsApp'), { entry: [] });
  for (const body of ['not json', '[1,2]', '"just a string"', '42', 'null']) {
    assert.throws(
      () => parseMetaWebhookBody(body, 'Instagram'),
      (error) => error.code === 'CHANNEL_EVENT_MALFORMED',
      `body ${body} must refuse as malformed`,
    );
  }
});

test('iterateMetaBatchItems walks both dialects in document order, skipping nothing listable', () => {
  const cloudMessage = (id) => ({ id, from: '15551234567', timestamp: '1760097600', type: 'text' });
  const mixed = {
    entry: [
      {
        id: 'waba-1',
        changes: [
          { value: { messaging_product: 'whatsapp', messages: [cloudMessage('wamid.1'), cloudMessage('wamid.2')] } },
          { value: { messaging_product: 'whatsapp', statuses: [{ id: 'wamid.1', recipient_id: '15551234567', timestamp: '1760097660', status: 'delivered' }] } },
          { value: { messaging_product: 'someone-else', messages: [cloudMessage('wamid.foreign')] } },
          { value: null },
          'junk-change',
        ],
      },
      {
        id: PAGE_ID,
        time: 1760097600,
        messaging: [
          { sender: { id: 'ig-user-1' }, recipient: { id: PAGE_ID }, timestamp: 1760097600000, message: { mid: 'ig.1', text: 'one' } },
          { sender: { id: PAGE_ID }, recipient: { id: 'ig-user-1' }, timestamp: 1760097600000, is_echo: true, message: { mid: 'ig.echo', text: 'our reply' } },
          { sender: { id: 'ig-user-1' }, recipient: { id: PAGE_ID }, timestamp: 1760097600000, read: { mid: 'ig.1' } },
          { sender: { id: 'ig-user-2' }, recipient: { id: PAGE_ID }, timestamp: 1760097600000, message: { mid: 'ig.2', text: 'two' } },
        ],
      },
      'junk-entry',
      null,
    ],
  };
  const items = iterateMetaBatchItems(mixed, { messagingProduct: 'whatsapp' });
  assert.deepEqual(
    items.map(({ dialect, kind }) => `${dialect}/${kind}`),
    ['cloud/message', 'cloud/message', 'cloud/status', 'graph/message', 'graph/message', 'graph/message', 'graph/message'],
    'every listable item in document order: nothing truncated, nothing from another product',
  );
  assert.equal(items[0].item.id, 'wamid.1');
  assert.equal(items[2].item.status, 'delivered');
  assert.equal(items[3].item.message.mid, 'ig.1');
});

test('iterateMetaBatchItems needs no entry array and no options', () => {
  assert.deepEqual(iterateMetaBatchItems({}), []);
  assert.deepEqual(iterateMetaBatchItems({ entry: 'nope' }), []);
  assert.deepEqual(iterateMetaBatchItems({ entry: [] }), []);
});

test('isMetaSelfEcho spots our own account in both dialects, never a customer', () => {
  assert.equal(isMetaSelfEcho({ is_echo: true }, PAGE_ID), true);
  assert.equal(isMetaSelfEcho({ is_echo: true }, ''), true, 'the flag alone is an echo');
  assert.equal(
    isMetaSelfEcho({ sender: { id: PAGE_ID }, recipient: { id: 'ig-user-1' } }, PAGE_ID),
    false,
    'narrow contract: a flagless page sender still applies on main (kit window seed), hardening is a follow-up',
  );
  assert.equal(isMetaSelfEcho({ from: BUSINESS_NUMBER }, BUSINESS_NUMBER), true);
  assert.equal(isMetaSelfEcho({ recipient_id: BUSINESS_NUMBER }, BUSINESS_NUMBER), true);
  assert.equal(
    isMetaSelfEcho({ sender: { id: 'ig-user-1' }, recipient: { id: PAGE_ID } }, PAGE_ID),
    false,
    'a customer message to our page is never an echo',
  );
  assert.equal(isMetaSelfEcho({ from: '+15550001111' }, BUSINESS_NUMBER), false);
  assert.equal(isMetaSelfEcho({ sender: { id: PAGE_ID } }, ''), false, 'no bound account, no echo claim');
  assert.equal(isMetaSelfEcho(null, PAGE_ID), false);
  assert.equal(isMetaSelfEcho('junk', PAGE_ID), false);
});

test('checkMetaServiceWindow classifies the server-resolved observation', () => {
  const check = (observed, options = {}) => checkMetaServiceWindow(observed, {
    nowMs: () => NOW, windowMs: DAY_MS, skewMs: SKEW_MS, ...options,
  });
  assert.equal(check(atIso(NOW - HOUR_MS)), 'ok');
  assert.equal(check(atIso(NOW - DAY_MS)), 'ok', 'the boundary instant still counts as inside');
  assert.equal(check(undefined), 'missing');
  assert.equal(check(null), 'missing');
  assert.equal(check(1760097600), 'invalid', 'a raw number is never an observation');
  assert.equal(check('the day before'), 'invalid');
  assert.equal(check('2026-10-10 12:00:00'), 'invalid', 'only canonical ISO-8601 counts');
  assert.equal(check(atIso(NOW + 2 * 60 * 1000)), 'ok', 'clock drift inside the skew stands');
  assert.equal(check(atIso(NOW + 10 * 60 * 1000)), 'future', 'provider time never holds the window open');
  assert.equal(check(atIso(NOW - DAY_MS - 1)), 'stale');
  assert.equal(
    check(atIso(NOW - 3 * DAY_MS), { windowMs: 7 * DAY_MS, skewMs: 0 }),
    'ok',
    'the human-agent tag rides the 7-day bound with no skew',
  );
  assert.equal(check(atIso(NOW + 1), { skewMs: 0 }), 'future', 'no skew: any future instant refuses');
});

test('WhatsApp normalizes through the shared module: batches, quarantine, dialect filter', () => {
  const definition = createWhatsAppChannelAdapter({
    phoneNumberId: '1234567890',
    businessNumber: BUSINESS_NUMBER,
    nowMs: () => NOW,
  }).definition;
  const body = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'waba-1',
        changes: [{
          value: {
            messaging_product: 'whatsapp',
            messages: [
              { id: 'wamid.1', from: '15550001111', timestamp: '1760097600', type: 'text' },
              { id: 'wamid.echo', from: '15551234567', timestamp: '1760097600', type: 'text' },
              { id: 'wamid.2', from: '15550002222', timestamp: '1760097660', type: 'text' },
            ],
            statuses: [{ id: 'wamid.1', recipient_id: '15550001111', timestamp: '1760097700', status: 'delivered' }],
          },
        }],
      },
      { id: PAGE_ID, messaging: [{ sender: { id: 'x' }, timestamp: 1, message: { mid: 'foreign' } }] },
    ],
  });
  const events = definition.normalizeInbound(body);
  assert.deepEqual(
    events.map((event) => [event.providerEventId, event.subject]),
    [
      ['wamid.1', 'wa:+15550001111'],
      ['wamid.echo', ''],
      ['wamid.2', 'wa:+15550002222'],
      ['wamid.1:delivered', 'wa:+15550001111'],
    ],
    'every batch item lands in order, the echo quarantines with an empty subject, Graph items stay out',
  );
});

test('Instagram normalizes through the shared module: batches, echo skip, dialect filter', () => {
  const definition = createInstagramChannelAdapter({ pageId: PAGE_ID, nowMs: () => NOW }).definition;
  const body = JSON.stringify({
    object: 'instagram',
    entry: [
      {
        id: PAGE_ID,
        messaging: [
          { sender: { id: 'ig-user-1' }, recipient: { id: PAGE_ID }, timestamp: 1760097600000, message: { mid: 'ig.1', text: 'one' } },
          { sender: { id: PAGE_ID }, recipient: { id: 'ig-user-1' }, timestamp: 1760097600000, is_echo: true, message: { mid: 'ig.echo', text: 'our reply' } },
          { sender: { id: 'ig-user-2' }, recipient: { id: PAGE_ID }, timestamp: 1760097600000, message: { mid: 'ig.2', text: 'two' } },
        ],
      },
      { id: 'waba-1', changes: [{ value: { messaging_product: 'whatsapp', messages: [{ id: 'wamid.x', from: '1', timestamp: '1' }] } }] },
    ],
  });
  const events = definition.normalizeInbound(body);
  assert.deepEqual(
    events.map((event) => [event.providerEventId, event.subject]),
    [['ig.1', 'ig:ig-user-1'], ['ig.2', 'ig:ig-user-2']],
    'every message lands in order, the echo stays out, Cloud API items stay out',
  );
});

test('Messenger normalizes through the shared module: batches, echo skip, dialect filter', () => {
  const definition = createMessengerChannelAdapter({ pageId: PAGE_ID, nowMs: () => NOW }).definition;
  const body = JSON.stringify({
    object: 'page',
    entry: [
      {
        id: PAGE_ID,
        messaging: [
          { sender: { id: 'fb-user-1' }, recipient: { id: PAGE_ID }, timestamp: 1760097600000, message: { mid: 'fb.1', text: 'one' } },
          { sender: { id: PAGE_ID }, recipient: { id: 'fb-user-1' }, timestamp: 1760097600000, is_echo: true, message: { mid: 'fb.echo', text: 'our reply' } },
          { sender: { id: 'fb-user-2' }, recipient: { id: PAGE_ID }, timestamp: 1760097600000, message: { mid: 'fb.2', text: 'two' } },
        ],
      },
      { id: 'waba-1', changes: [{ value: { messaging_product: 'whatsapp', messages: [{ id: 'wamid.x', from: '1', timestamp: '1' }] } }] },
    ],
  });
  const events = definition.normalizeInbound(body);
  assert.deepEqual(
    events.map((event) => [event.providerEventId, event.subject]),
    [['fb.1', 'fb:fb-user-1'], ['fb.2', 'fb:fb-user-2']],
    'every message lands in order, the echo stays out, Cloud API items stay out',
  );
});

test('verifyMetaHubSignature is the one forgery check every Meta adapter uses', () => {
  const body = JSON.stringify({ object: 'page', entry: [] });
  const secret = 'meta-app-secret-1';
  const good = `sha256=${createHmac('sha256', secret).update(Buffer.from(body, 'utf8')).digest('hex')}`;
  assert.equal(verifyMetaHubSignature(body, good, secret), true);
  assert.equal(verifyMetaHubSignature(body, good, 'wrong-secret'), false);
  assert.equal(verifyMetaHubSignature(body, 'sha256=00', secret), false);
  assert.equal(verifyMetaHubSignature(body, 'plain-hex-without-prefix', secret), false);
  assert.equal(verifyMetaHubSignature(body, good, ''), false);
  assert.equal(verifyMetaHubSignature(body, null, secret), false);
});
