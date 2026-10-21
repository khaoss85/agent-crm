import test from 'node:test';
import assert from 'node:assert/strict';

import { runChannelAdapterKit } from '../packages/channels/src/kit.js';
import { fixtureWebhookHeaders } from '../packages/channels/src/fixture.js';
import {
  createStripeChannelAdapter,
  stripeEventBody,
  STRIPE_ADAPTER_NAME,
  STRIPE_ADAPTER_VERSION,
} from '../packages/channels/src/index.js';
import { createChannelsHarness } from './helpers/channels-harness.js';

/**
 * Stripe webhook adapter tests (backlog:ffce3d1cd636).
 *
 * The inbound-only Stripe binding on the common channel base: payment
 * events in, no send ever out (money moves through `packages/payments`) —
 * against a fake transport, no credentials (owner decision
 * MEM_ACC_DECISIONS). Proven the same way the acceptance names it: the
 * channel kit (whose send check asserts the contract refusal instead of a
 * delivery), plus one payment event reaching the inbox and the outbound
 * refusal, direct and through the real queue path.
 */

const SPACE_A = 'presti';
const SPACE_B = 'arvo-trial';
const ACCOUNT_A = 'acct_presti';
const ACCOUNT_B = 'acct_arvo';
const SECRET_REF = 'vault://presti/stripe-a';
// Declared test-only fixture value: no credential exists anywhere here,
// so it is assembled, never a literal no scanner should read as a secret.
const SECRET = ['stripe', 'kit', 'secret', '1'].join('-');
const ACTOR = { type: 'user', id: 'stripe-kit' };
const T0_SEC = Math.floor(new Date('2026-10-01T10:00:00.000Z').getTime() / 1000);

const signedHeaders = (rawBody) => fixtureWebhookHeaders(rawBody, SECRET, Math.floor(Date.now() / 1000));

function setup(options = {}) {
  const { definition, api } = createStripeChannelAdapter({ ...(options.adapter ?? {}) });
  const harness = createChannelsHarness({
    adapterDefinition: definition, fixtureApi: api, secretRef: SECRET_REF, secretValue: SECRET,
    tenantId: options.tenantId ?? 'stripe-kit',
  });
  return { harness, api, definition };
}

async function registeredActive(harness, space = SPACE_A, account = ACCOUNT_A) {
  const reg = await harness.register(space, {
    channel: 'stripe', account, adapter: STRIPE_ADAPTER_NAME, adapterVersion: STRIPE_ADAPTER_VERSION,
    secretRef: SECRET_REF,
  });
  await harness.activate(space, reg.connection.sourceKey);
  return reg.connection.sourceKey;
}

test('the stripe adapter passes the channel kit, refusing sends by contract', async (t) => {
  const { harness, definition } = setup({ tenantId: 'stripe-kit-acceptance' });
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
});

test('a stripe payment event applies on its type thread; forgeries write nothing', async (t) => {
  const { harness } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const rawBody = stripeEventBody({ id: 'evt_in_1', type: 'payment_intent.succeeded', createdSec: T0_SEC });
  const out = await harness.ingest(SPACE_A, { connectionKey: key, rawBody, headers: signedHeaders(rawBody) });
  assert.equal(out.effect, 'applied');
  const rows = harness.inbox(SPACE_A).filter((row) => row.providerEventId === 'evt_in_1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].subject, 'stripe:payment_intent.succeeded');

  const forged = stripeEventBody({ id: 'evt_forged_1', createdSec: T0_SEC });
  const tampered = { ...signedHeaders(forged), 'x-channel-signature-256': '0'.repeat(64) };
  const countBefore = harness.inbox(SPACE_A).length;
  await assert.rejects(
    () => harness.ingest(SPACE_A, { connectionKey: key, rawBody: forged, headers: tampered }),
    (error) => error.code === 'CHANNEL_SIGNATURE_INVALID',
  );
  assert.equal(harness.inbox(SPACE_A).length, countBefore);
});

test('stripe refuses every send by contract, direct and through the queue', async (t) => {
  const { harness, api, definition } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  await assert.rejects(
    async () => definition.normalizeOutbound({ to: ACCOUNT_A, text: 'ciao' }),
    (error) => error.code === 'CHANNEL_SEND_UNSUPPORTED',
  );
  await assert.rejects(
    async () => definition.sendOutbound({ message: { to: ACCOUNT_A, text: 'ciao' }, secret: SECRET, idempotencyKey: 'k1' }),
    (error) => error.code === 'CHANNEL_SEND_UNSUPPORTED',
  );
  await assert.rejects(
    () => harness.queue(SPACE_A, { connectionKey: key, message: { to: ACCOUNT_A, text: 'ciao' }, messageKey: 'kit-send-refused' }),
    (error) => error.code === 'CHANNEL_SEND_UNSUPPORTED',
  );
  assert.equal(api.state.sendCalls, 0);
  assert.equal(api.state.sentByKey.size, 0);
  assert.equal((await harness.jobs()).length, 0, 'refused messages never reach the outbox');
});

test('a redelivered stripe event replays instead of duplicating', async (t) => {
  const { harness } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const rawBody = stripeEventBody({ id: 'evt_dup_1', createdSec: T0_SEC });
  const first = await harness.ingest(SPACE_A, { connectionKey: key, rawBody, headers: signedHeaders(rawBody) });
  assert.equal(first.duplicate, false);
  const second = await harness.ingest(SPACE_A, { connectionKey: key, rawBody, headers: signedHeaders(rawBody) });
  assert.equal(second.duplicate, true);
  assert.equal(second.eventId, first.eventId);
});
