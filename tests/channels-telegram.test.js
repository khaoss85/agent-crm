import test from 'node:test';
import assert from 'node:assert/strict';

import { runChannelAdapterKit } from '../packages/channels/src/kit.js';
import {
  buildTelegramSendRequest,
  canonicalTelegramChatId,
  createTelegramChannelAdapter,
  redactTelegramSendRequest,
  telegramEventBody,
  verifyTelegramWebhookToken,
  TELEGRAM_ADAPTER_NAME,
  TELEGRAM_ADAPTER_VERSION,
  TELEGRAM_SECRET_HEADER,
} from '../packages/channels/src/index.js';
import { createChannelsHarness } from './helpers/channels-harness.js';

/**
 * Telegram Bot API adapter tests (backlog:2a5651e1933d).
 *
 * The owner decision of 29/10 makes Telegram a channel of Accordo: Bot API
 * updates in, `sendMessage` replies out, no reply window, the webhook
 * secret carried by the `X-Telegram-Bot-Api-Secret-Token` header. Proven
 * the same way the acceptance names it: the channel kit, the secret
 * gate, the sendMessage shape without the token in storage, and the
 * Connettori card (covered in tests/admin-personalizzazione.test.js).
 */

const SPACE_A = 'presti';
const SPACE_B = 'arvo-trial';
const CHAT_A = '445001122';
const CHAT_B = '445001133';
const SECRET_REF = 'vault://presti/telegram-a';
const SECRET = 'telegram-kit-secret-1';
const T0 = new Date('2026-10-01T10:00:00.000Z').getTime();
const DATE_S = Math.floor(T0 / 1000);

function setup(options = {}) {
  const { definition, api } = createTelegramChannelAdapter({
    secret: SECRET,
    testOnly: options.testOnly ?? true,
  });
  const harness = createChannelsHarness({
    adapterDefinition: definition, fixtureApi: api, secretRef: SECRET_REF, secretValue: SECRET,
    tenantId: options.tenantId ?? 'telegram-kit', config: options.config,
  });
  return { harness, api, definition };
}

async function registeredActive(harness, space = SPACE_A, account = CHAT_A) {
  const reg = await harness.register(space, {
    channel: 'telegram', account, adapter: TELEGRAM_ADAPTER_NAME, adapterVersion: TELEGRAM_ADAPTER_VERSION,
    secretRef: SECRET_REF,
  });
  await harness.activate(space, reg.connection.sourceKey);
  return reg.connection.sourceKey;
}

/** Provider-scheme headers: the Telegram secret-token header. */
function secretHeaders(secret = SECRET) {
  return { [TELEGRAM_SECRET_HEADER]: secret };
}

function updateBody(overrides = {}) {
  return telegramEventBody({ chatId: Number(CHAT_A), userId: Number(CHAT_A), dateSeconds: DATE_S, ...overrides });
}

test('the telegram adapter passes the channel kit', async (t) => {
  const { harness, definition } = setup({ tenantId: 'telegram-kit-acceptance' });
  t.after(() => harness.close());
  // Telegram bodies travel secret-token-signed (the production scheme),
  // so the kit's seeded window proves nothing here — Telegram sets no
  // window and sends directly. The kit's own minimal envelopes keep the
  // fixture scheme.
  const sign = (rawBody) => {
    try {
      const parsed = JSON.parse(String(rawBody));
      if (parsed && typeof parsed === 'object' && parsed.message && typeof parsed.message === 'object') {
        return secretHeaders(SECRET);
      }
    } catch {
      // Not JSON: the fixture scheme signs it like before.
    }
    return harness.faults.sign(rawBody);
  };
  const results = await runChannelAdapterKit({
    adapter: definition,
    secrets: { ref: SECRET_REF, value: SECRET },
    spaceA: SPACE_A,
    spaceB: SPACE_B,
    accountA: CHAT_A,
    accountB: CHAT_B,
    actor: harness.userActor,
    harness: {
      register: (spaceId, input) => harness.register(spaceId, input),
      activate: (spaceId, key) => harness.activate(spaceId, key),
      ingest: (spaceId, args) => harness.ingest(spaceId, args),
      queue: (spaceId, args) => harness.queue(spaceId, args),
      pump: (jobId) => harness.pump(jobId),
      faults: { ...harness.faults, sign },
      connections: (spaceId) => harness.connections(spaceId),
      inbox: (spaceId) => harness.inbox(spaceId),
      letters: (spaceId, state) => harness.letters(spaceId, state),
      dumpStorage: () => harness.dumpStorage(),
    },
  });
  assert.deepEqual(
    results.map((row) => `${row.name}:${row.pass ? 'pass' : `FAIL ${row.detail}`}`),
    ['receive:pass', 'send:pass', 'replay:pass', 'bad-signature:pass', 'out-of-order:pass', 'no-secrets:pass', 'space-isolation:pass', 'history:pass'],
  );
});

test('a wrong or missing webhook secret refuses; the right one applies a chat event', async (t) => {
  const { harness, definition } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const rawBody = updateBody({ text: 'Avete posto sabato?' });

  for (const headers of [{}, secretHeaders('wrong-secret')]) {
    await assert.rejects(
      harness.ingest(SPACE_A, { connectionKey: key, rawBody, headers }),
      (error) => error.code === 'CHANNEL_SIGNATURE_INVALID',
      `secret ${JSON.stringify(headers)} refuses`,
    );
  }
  assert.equal(harness.inbox(SPACE_A).length, 0, 'forgeries write nothing');

  const out = await harness.ingest(SPACE_A, { connectionKey: key, rawBody, headers: secretHeaders() });
  assert.equal(out.effect, 'applied');
  const rows = harness.inbox(SPACE_A).filter((row) => row.providerEventId === 'tg:1001');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].subject, `tg:${CHAT_A}`);
  assert.equal(rows[0].occurredAt, new Date(T0).toISOString());

  const normalized = definition.normalizeInbound(rawBody);
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].subject, `tg:${CHAT_A}`);
  assert.equal(normalized[0].from, CHAT_A);
  assert.equal(normalized[0].to, CHAT_A);
  assert.equal(normalized[0].text, 'Avete posto sabato?');
});

test('updates without a message refuse as malformed and write nothing', async (t) => {
  const { harness } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const bodies = [
    'not json',
    JSON.stringify({ update_id: 2 }),
    JSON.stringify({ update_id: 3, edited_message: { message_id: 1 } }),
    JSON.stringify({ update_id: 4, message: { message_id: 5 } }),
    JSON.stringify({ update_id: 5, message: { message_id: 6, from: { id: 7 }, chat: { id: 7 }, date: 'soon', text: 'x' } }),
    JSON.stringify({ update_id: 6, message: { message_id: 7, from: { id: 8 }, chat: { id: 8 }, date: DATE_S, text: 'x'.repeat(4097) } }),
  ];
  for (const [index, rawBody] of bodies.entries()) {
    await assert.rejects(
      harness.ingest(SPACE_A, { connectionKey: key, rawBody, headers: secretHeaders() }),
      (error) => error.code === 'CHANNEL_EVENT_MALFORMED',
      `body ${index} refuses`,
    );
  }
  assert.equal(harness.inbox(SPACE_A).length, 0);
});

test('a photo caption travels as the text; a captionless message lands empty', async (t) => {
  const { harness, definition } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const captioned = telegramEventBody({
    chatId: Number(CHAT_A), userId: Number(CHAT_A), dateSeconds: DATE_S, text: undefined,
    extraMessage: { photo: [{ file_id: 'pic' }], caption: 'Ecco la sala' },
  });
  const out = await harness.ingest(SPACE_A, { connectionKey: key, rawBody: captioned, headers: secretHeaders() });
  assert.equal(out.effect, 'applied');
  assert.equal(definition.normalizeInbound(captioned)[0].text, 'Ecco la sala');
});

test('a reply produces the sendMessage request; the token never reaches storage', async (t) => {
  const { harness, api } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);

  // The pure mapping: POST to the bot URL with the chat and the text.
  const request = buildTelegramSendRequest({
    message: { to: CHAT_A, text: 'Certo, alle 18!' },
    config: { baseUrl: 'https://api.telegram.org' },
    secret: SECRET,
  });
  assert.deepEqual(request, {
    method: 'POST',
    url: `https://api.telegram.org/bot${SECRET}/sendMessage`,
    headers: { 'Content-Type': 'application/json' },
    body: { chat_id: CHAT_A, text: 'Certo, alle 18!' },
  });

  // Through the real queue path: one send, idempotent on the same key.
  const message = { to: CHAT_A, text: 'Certo, alle 18!' };
  const first = await harness.queue(SPACE_A, { connectionKey: key, message, messageKey: 'tg-reply-1' });
  const second = await harness.queue(SPACE_A, { connectionKey: key, message, messageKey: 'tg-reply-1' });
  assert.equal(first.jobId, second.jobId, 'the idempotency root resolves identically');
  assert.equal((await harness.pump(first.jobId)).state, 'succeeded');
  assert.equal(api.state.sentByKey.size, 1, 'one effective provider send');

  const stored = api.sentRequests()[0];
  assert.equal(stored.body.chat_id, CHAT_A);
  assert.equal(stored.body.text, 'Certo, alle 18!');
  assert.ok(!stored.url.includes(SECRET), 'the retained URL carries no token');
  assert.ok(stored.url.endsWith('/sendMessage'), 'the retained URL keeps the method shape');
  const dump = await harness.dumpStorage();
  assert.ok(!dump.includes(SECRET), 'the bot token is nowhere in stored rows, jobs or audit');
});

test('a secret mismatch at send time refuses; the token comparison is constant-time', async () => {
  assert.equal(verifyTelegramWebhookToken(SECRET, SECRET), true);
  assert.equal(verifyTelegramWebhookToken('wrong', SECRET), false);
  assert.equal(verifyTelegramWebhookToken(undefined, SECRET), false);
  assert.equal(verifyTelegramWebhookToken(SECRET, ''), false);
  assert.equal(verifyTelegramWebhookToken('short', 'a-much-longer-secret'), false);

  const { definition } = setup();
  await assert.rejects(
    definition.sendOutbound({ message: { to: CHAT_A, text: 'x' }, secret: 'wrong-secret', idempotencyKey: 'k1' }),
    (error) => error.code === 'CHANNEL_SEND_REFUSED',
  );
});

test('production composition refuses the kit dialect', async (t) => {
  const { harness } = setup({ testOnly: false, tenantId: 'telegram-production' });
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const minimal = JSON.stringify({ id: 'evt-prod-1', subject: 'chat-1', seq: 1 });
  await assert.rejects(
    harness.ingest(SPACE_A, {
      connectionKey: key,
      rawBody: minimal,
      headers: harness.faults.sign(minimal),
    }),
    (error) => error.code === 'CHANNEL_SIGNATURE_INVALID',
  );
});

test('recipient shaping accepts chat ids and @usernames, refuses the rest', () => {
  assert.equal(canonicalTelegramChatId(445001122), '445001122');
  assert.equal(canonicalTelegramChatId('  445001122 '), '445001122');
  assert.equal(canonicalTelegramChatId('-1001234567890'), '-1001234567890');
  assert.equal(canonicalTelegramChatId('@nome_del_bot'), '@nome_del_bot');
  for (const bad of ['', 'wa:+390200000001', 'ig-user', '@ab', '12.5', null, undefined, {}]) {
    assert.throws(() => canonicalTelegramChatId(bad), /CHANNEL_MESSAGE_MALFORMED/);
  }
  const redacted = redactTelegramSendRequest({
    method: 'POST',
    url: `https://api.telegram.org/bot${SECRET}/sendMessage`,
    headers: { 'Content-Type': 'application/json' },
    body: { chat_id: CHAT_A, text: 'x' },
  });
  assert.ok(!redacted.url.includes(SECRET));
  assert.ok(redacted.url.includes('/bot<redacted>/sendMessage'));
});
