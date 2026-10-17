import test from 'node:test';
import assert from 'node:assert/strict';

import { createPaymentsHarness } from './helpers/payments-harness.js';
import { createPaymentOperations } from '../packages/payments/src/operations.js';
import {
  createFixtureStripeAdapter,
  fixturePaymentEventBody,
} from '../packages/payments/src/stripe.js';

/**
 * Payments operations tests (backlog:1972e16d33f2): the fake-Stripe payment
 * to paid status, the replay that never double-pays, and the no-secrets
 * scan — on real sqlite, real module services, the real adapter contract.
 */

const SPACE_A = 'presti';
const SPACE_B = 'arvo';
const ACCOUNT_A = 'acct_presti';
const SECRET_REF = 'vault://kit/stripe-a';
const SECRET = 'kit-stripe-secret-1';

function setup(overrides = {}) {
  const { definition, api } = createFixtureStripeAdapter({ secret: SECRET });
  const harness = createPaymentsHarness({
    adapterDefinition: definition, fixtureApi: api, secretRef: SECRET_REF, secretValue: SECRET,
    ...overrides,
  });
  return { harness, api, definition };
}

async function registeredActive(harness, spaceId = SPACE_A, account = ACCOUNT_A) {
  const { connection } = await harness.register(spaceId, {
    provider: 'stripe', account, adapter: 'fixture-stripe', adapterVersion: 1, secretRef: SECRET_REF,
  });
  await harness.activate(spaceId, connection.sourceKey);
  return connection.sourceKey;
}

function paidBody(providerRef, id = 'evt_paid_1') {
  return fixturePaymentEventBody({ id, paymentRef: providerRef, type: 'checkout.session.completed' });
}

test('a fake-Stripe payment from a quote ends paid in the status read', async (t) => {
  const { harness } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const { duplicate, request } = await harness.request(SPACE_A, {
    connectionKey: key, quoteId: 'quote-1', amount: 4900, currency: 'EUR', requestKey: 'req-1',
  });
  assert.equal(duplicate, false);
  assert.equal(request.status, 'pending');
  assert.ok(request.providerRef.startsWith('cs_fixture_'));
  assert.ok(request.providerUrl.includes(request.providerRef));
  const ingested = await harness.ingest(SPACE_A, {
    connectionKey: key, rawBody: paidBody(request.providerRef), headers: harness.faults.sign(paidBody(request.providerRef)),
  });
  assert.equal(ingested.duplicate, false);
  assert.equal(ingested.effect, 'applied');
  assert.equal(ingested.status, 'paid');
  const status = harness.status(SPACE_A, request.id);
  assert.equal(status.status, 'paid');
  assert.equal(status.amount, 4900);
  assert.equal(status.currency, 'EUR');
  assert.equal(status.quoteId, 'quote-1');
  assert.ok(status.paidAt !== null);
  assert.equal(harness.list(SPACE_A, { status: 'paid' }).length, 1);
});

test('a payment from an offer mints a checkout and the same intent never mints twice', async (t) => {
  const { harness, api } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const first = await harness.request(SPACE_A, {
    connectionKey: key, offerId: 'offer-7', amount: 19900, currency: 'EUR', requestKey: 'req-offer',
  });
  const second = await harness.request(SPACE_A, {
    connectionKey: key, offerId: 'offer-7', amount: 19900, currency: 'EUR', requestKey: 'req-offer',
  });
  assert.equal(second.duplicate, true);
  assert.equal(second.request.providerRef, first.request.providerRef);
  assert.equal(api.state.createdByKey.size, 1);
  assert.equal(api.state.createCalls, 1);
});

test('a repeated webhook never creates a second payment', async (t) => {
  const { harness } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const { request } = await harness.request(SPACE_A, {
    connectionKey: key, quoteId: 'quote-9', amount: 1000, currency: 'EUR', requestKey: 'req-replay',
  });
  const body = paidBody(request.providerRef, 'evt_replay_1');
  const headers = harness.faults.sign(body);
  const first = await harness.ingest(SPACE_A, { connectionKey: key, rawBody: body, headers });
  assert.equal(first.duplicate, false);
  assert.equal(first.status, 'paid');
  // Same delivery again: identical resolution, no second row, no second transition.
  const replay = await harness.ingest(SPACE_A, { connectionKey: key, rawBody: body, headers });
  assert.equal(replay.duplicate, true);
  assert.equal(harness.status(SPACE_A, request.id).status, 'paid');
  // A different event id carrying the same completed outcome: recorded, but
  // the request is already paid, so nothing moves and nothing double-counts.
  const twinBody = paidBody(request.providerRef, 'evt_replay_2');
  const twin = await harness.ingest(SPACE_A, {
    connectionKey: key, rawBody: twinBody, headers: harness.faults.sign(twinBody),
  });
  assert.equal(twin.duplicate, true);
  assert.equal(twin.alreadyFinal, true);
  assert.equal(harness.status(SPACE_A, request.id).status, 'paid');
  assert.equal(harness.list(SPACE_A, { status: 'paid' }).length, 1);
});

test('a contradicting event against a paid request quarantines and the stored outcome wins', async (t) => {
  const { harness } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const { request } = await harness.request(SPACE_A, {
    connectionKey: key, quoteId: 'quote-2', amount: 1000, currency: 'EUR', requestKey: 'req-contra',
  });
  const paid = paidBody(request.providerRef, 'evt_c_1');
  await harness.ingest(SPACE_A, { connectionKey: key, rawBody: paid, headers: harness.faults.sign(paid) });
  const failedBody = fixturePaymentEventBody({
    id: 'evt_c_2', paymentRef: request.providerRef, type: 'payment_intent.payment_failed',
  });
  const contra = await harness.ingest(SPACE_A, {
    connectionKey: key, rawBody: failedBody, headers: harness.faults.sign(failedBody),
  });
  assert.equal(contra.effect, 'quarantined');
  assert.equal(harness.status(SPACE_A, request.id).status, 'paid');
});

test('a failed checkout finalizes failed and a raw secret value is refused', async (t) => {
  const { harness } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const { request } = await harness.request(SPACE_A, {
    connectionKey: key, quoteId: 'quote-3', amount: 2500, currency: 'EUR', requestKey: 'req-fail',
  });
  const body = fixturePaymentEventBody({
    id: 'evt_f_1', paymentRef: request.providerRef, type: 'checkout.session.expired',
  });
  const ingested = await harness.ingest(SPACE_A, {
    connectionKey: key, rawBody: body, headers: harness.faults.sign(body),
  });
  assert.equal(ingested.status, 'failed');
  assert.equal(harness.status(SPACE_A, request.id).status, 'failed');
  await assert.rejects(
    harness.register(SPACE_A, {
      provider: 'stripe', account: 'acct_x', adapter: 'fixture-stripe', adapterVersion: 1,
      secretRef: 'sk_live_abc123rawvalue',
    }),
    (e) => e.code === 'VALIDATION_ERROR',
  );
  await assert.rejects(
    harness.request(SPACE_A, { connectionKey: key, amount: 100, currency: 'EUR', requestKey: 'req-none' }),
    (e) => e.code === 'VALIDATION_ERROR',
  );
  await assert.rejects(
    harness.request(SPACE_A, {
      connectionKey: key, quoteId: 'q', offerId: 'o', amount: 100, currency: 'EUR', requestKey: 'req-both',
    }),
    (e) => e.code === 'VALIDATION_ERROR',
  );
});

test('unknown checkouts quarantine, bad signatures refuse, spaces stay separate', async (t) => {
  const { harness } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const ghostBody = paidBody('cs_fixture_ghost', 'evt_ghost_1');
  const ghost = await harness.ingest(SPACE_A, {
    connectionKey: key, rawBody: ghostBody, headers: harness.faults.sign(ghostBody),
  });
  assert.equal(ghost.quarantined, true);
  const body = paidBody('cs_fixture_ghost', 'evt_bad_1');
  await assert.rejects(
    harness.ingest(SPACE_A, { connectionKey: key, rawBody: body, headers: { 'x-payment-timestamp': '1', 'x-payment-signature-256': '00' } }),
    (e) => e.code === 'PAYMENT_SIGNATURE_INVALID',
  );
  await assert.rejects(
    harness.ingest(SPACE_B, { connectionKey: key, rawBody: body, headers: harness.faults.sign(body) }),
    (e) => e.code === 'PAYMENT_CONNECTION_UNKNOWN',
  );
  assert.equal(harness.status(SPACE_B, 'nope'), null);
});

test('no secret material rests in rows or audit', async (t) => {
  const { harness } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const { request } = await harness.request(SPACE_A, {
    connectionKey: key, quoteId: 'quote-sec', amount: 100, currency: 'EUR', requestKey: 'req-sec',
  });
  const body = paidBody(request.providerRef, 'evt_sec_1');
  await harness.ingest(SPACE_A, { connectionKey: key, rawBody: body, headers: harness.faults.sign(body) });
  const dump = harness.dumpStorage();
  assert.ok(!dump.includes(SECRET), 'secret value appears nowhere in stored rows or audit');
  assert.ok(dump.includes(SECRET_REF), 'the reference is what is stored');
  assert.ok(dump.includes(request.providerRef), 'the provider reference is scanned, not just rows');
});

test('unwired composition refuses instead of inventing custody', async (t) => {
  const { harness } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const bare = createPaymentOperations({ ...harness.internals });
  await assert.rejects(
    bare.requestPayment({ spaceId: SPACE_A, connectionKey: key, quoteId: 'q', amount: 100, currency: 'EUR', requestKey: 'k', actor: harness.userActor }),
    (e) => e.code === 'PAYMENT_SECRET_UNAVAILABLE',
  );
  const body = paidBody('cs_x', 'evt_bare_1');
  await assert.rejects(
    bare.ingestPaymentEvent({ spaceId: SPACE_A, connectionKey: key, rawBody: body, headers: harness.faults.sign(body) }),
    (e) => e.code === 'PAYMENT_SECRET_UNAVAILABLE',
  );
});
