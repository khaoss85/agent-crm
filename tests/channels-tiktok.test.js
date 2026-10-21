import test from 'node:test';
import assert from 'node:assert/strict';

import { runChannelAdapterKit } from '../packages/channels/src/kit.js';
import { fixtureWebhookHeaders } from '../packages/channels/src/fixture.js';
import {
  createTikTokChannelAdapter,
  tiktokEventBody,
  TIKTOK_ADAPTER_NAME,
  TIKTOK_ADAPTER_VERSION,
} from '../packages/channels/src/index.js';
import { createChannelsHarness } from './helpers/channels-harness.js';

/**
 * TikTok adapter tests (backlog:ffce3d1cd636).
 *
 * The inbound-only TikTok binding on the common channel base: TikTok
 * direct-message deliveries in, no send ever out — against a fake
 * transport, no credentials (owner decision MEM_ACC_DECISIONS). Proven the
 * same way the acceptance names it: the channel kit (whose send check
 * asserts the contract refusal instead of a delivery), plus one TikTok
 * message reaching the inbox and the outbound refusal, direct and through
 * the real queue path.
 */

const SPACE_A = 'presti';
const SPACE_B = 'arvo-trial';
const ACCOUNT_A = '@cliente.rossi';
const ACCOUNT_B = '@altro.cliente';
const SECRET_REF = 'vault://presti/tiktok-a';
const SECRET = 'tiktok-kit-secret-1';
const ACTOR = { type: 'user', id: 'tiktok-kit' };
const T0_SEC = Math.floor(new Date('2026-10-01T10:00:00.000Z').getTime() / 1000);

const signedHeaders = (rawBody) => fixtureWebhookHeaders(rawBody, SECRET, Math.floor(Date.now() / 1000));

function setup(options = {}) {
  const { definition, api } = createTikTokChannelAdapter({ ...(options.adapter ?? {}) });
  const harness = createChannelsHarness({
    adapterDefinition: definition, fixtureApi: api, secretRef: SECRET_REF, secretValue: SECRET,
    tenantId: options.tenantId ?? 'tiktok-kit',
  });
  return { harness, api, definition };
}

async function registeredActive(harness, space = SPACE_A, account = ACCOUNT_A) {
  const reg = await harness.register(space, {
    channel: 'tiktok', account, adapter: TIKTOK_ADAPTER_NAME, adapterVersion: TIKTOK_ADAPTER_VERSION,
    secretRef: SECRET_REF,
  });
  await harness.activate(space, reg.connection.sourceKey);
  return reg.connection.sourceKey;
}

test('the tiktok adapter passes the channel kit, refusing sends by contract', async (t) => {
  const { harness, definition } = setup({ tenantId: 'tiktok-kit-acceptance' });
  t.after(() => harness.close());
  const results = await runChannelAdapterKit({
    adapter: definition,
    secrets: { ref: SECRET_REF, value: SECRET },
    spaceA: SPACE_A,
    spaceB: SPACE_B,
    accountA: ACCOUNT_A,
    accountB: ACCOUNT_B,
    actor: harness.userActor,
    harness: {
      register: (spaceId, input) => harness.register(spaceId, input),
      activate: (spaceId, key) => harness.activate(spaceId, key),
      ingest: (spaceId, args) => harness.ingest(spaceId, args),
      queue: (spaceId, args) => harness.queue(spaceId, args),
      pump: (jobId) => harness.pump(jobId),
      faults: harness.faults,
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
  assert.match(
    results.find((row) => row.name === 'send').detail,
    /outbound refused by contract/,
    'the kit send check proves the refusal, not a delivery',
  );
});

test('a tiktok direct message applies with the sender subject; forgeries write nothing', async (t) => {
  const { harness } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const rawBody = tiktokEventBody({ messageId: 'mid.in.1', fromUser: 'cliente.rossi', atSec: T0_SEC });
  const out = await harness.ingest(SPACE_A, { connectionKey: key, rawBody, headers: signedHeaders(rawBody) });
  assert.equal(out.effect, 'applied');
  const rows = harness.inbox(SPACE_A).filter((row) => row.providerEventId === 'mid.in.1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].subject, 'tiktok:cliente.rossi');

  const forged = tiktokEventBody({ messageId: 'mid.forged.1', atSec: T0_SEC });
  const tampered = { ...signedHeaders(forged), 'x-channel-signature-256': '0'.repeat(64) };
  const countBefore = harness.inbox(SPACE_A).length;
  await assert.rejects(
    () => harness.ingest(SPACE_A, { connectionKey: key, rawBody: forged, headers: tampered }),
    (error) => error.code === 'CHANNEL_SIGNATURE_INVALID',
  );
  assert.equal(harness.inbox(SPACE_A).length, countBefore);
});

test('tiktok refuses every send by contract, direct and through the queue', async (t) => {
  const { harness, api, definition } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  // Direct: both halves of the outbound path refuse.
  await assert.rejects(
    async () => definition.normalizeOutbound({ to: ACCOUNT_A, text: 'ciao' }),
    (error) => error.code === 'CHANNEL_SEND_UNSUPPORTED',
  );
  await assert.rejects(
    async () => definition.sendOutbound({ message: { to: ACCOUNT_A, text: 'ciao' }, secret: SECRET, idempotencyKey: 'k1' }),
    (error) => error.code === 'CHANNEL_SEND_UNSUPPORTED',
  );
  // Through the real queue path: the refusal travels intact, nothing queues.
  await assert.rejects(
    () => harness.queue(SPACE_A, { connectionKey: key, message: { to: ACCOUNT_A, text: 'ciao' }, messageKey: 'kit-send-refused' }),
    (error) => error.code === 'CHANNEL_SEND_UNSUPPORTED',
  );
  assert.equal(api.state.sendCalls, 0);
  assert.equal(api.state.sentByKey.size, 0);
  assert.equal((await harness.jobs()).length, 0, 'refused messages never reach the outbox');
});

test('a malformed tiktok delivery refuses without writing', async (t) => {
  const { harness } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const rawBody = JSON.stringify({ event: 'dm.received', message_id: '', from_user: 'x' });
  const countBefore = harness.inbox(SPACE_A).length;
  await assert.rejects(
    () => harness.ingest(SPACE_A, { connectionKey: key, rawBody, headers: signedHeaders(rawBody) }),
    (error) => error.code === 'CHANNEL_EVENT_MALFORMED',
  );
  assert.equal(harness.inbox(SPACE_A).length, countBefore);
});
