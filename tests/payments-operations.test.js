import test from 'node:test';
import assert from 'node:assert/strict';

import { createPaymentsHarness } from './helpers/payments-harness.js';
import { createPaymentOperations } from '../packages/payments/src/operations.js';
import {
  buildPaymentConnectionActions,
  createPaymentsPackage,
  resolvePaymentModuleNames,
} from '../packages/payments/src/index.js';
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

test('the same idempotency key with different terms conflicts instead of returning the original', async (t) => {
  const { harness, api } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const first = await harness.request(SPACE_A, {
    connectionKey: key, quoteId: 'quote-1', amount: 4900, currency: 'EUR', requestKey: 'req-terms',
  });
  assert.equal(first.duplicate, false);
  // A retried key with a different amount is a conflict, never the original checkout.
  await assert.rejects(
    harness.request(SPACE_A, {
      connectionKey: key, quoteId: 'quote-1', amount: 100, currency: 'EUR', requestKey: 'req-terms',
    }),
    (e) => e.code === 'PAYMENT_REQUEST_CONFLICT' && e.status === 409,
  );
  // Same for a different currency and for an offer swapped in for the quote.
  await assert.rejects(
    harness.request(SPACE_A, {
      connectionKey: key, quoteId: 'quote-1', amount: 4900, currency: 'USD', requestKey: 'req-terms',
    }),
    (e) => e.code === 'PAYMENT_REQUEST_CONFLICT',
  );
  await assert.rejects(
    harness.request(SPACE_A, {
      connectionKey: key, offerId: 'offer-1', amount: 4900, currency: 'EUR', requestKey: 'req-terms',
    }),
    (e) => e.code === 'PAYMENT_REQUEST_CONFLICT',
  );
  // The original intent is untouched and the provider minted only once.
  assert.equal(harness.status(SPACE_A, first.request.id).amount, 4900);
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

test('a raced duplicate delivery resolves as a replay, not a raw violation', async (t) => {
  const { harness } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const { request } = await harness.request(SPACE_A, {
    connectionKey: key, quoteId: 'quote-race', amount: 1000, currency: 'EUR', requestKey: 'req-race',
  });
  const rawBody = paidBody(request.providerRef, 'evt_race_1');
  const headers = harness.faults.sign(rawBody);
  // A concurrent delivery commits first under the same identity; the
  // loser's insert then fails with a raw violation (channels race idiom).
  const entry = harness.internals.modules.get('payment-event');
  const real = entry.service;
  const realCreate = real.createManaged.bind(real);
  let armed = true;
  const raced = Object.create(real);
  raced.createManaged = async (row, opts) => {
    if (armed) {
      armed = false;
      await realCreate(row, opts);
      throw Object.assign(new Error('UNIQUE constraint failed: payment-event.sourceKey'), { code: 'CONFLICT' });
    }
    return realCreate(row, opts);
  };
  entry.service = raced;
  try {
    const ingested = await harness.ingest(SPACE_A, { connectionKey: key, rawBody, headers });
    assert.equal(ingested.duplicate, true);
    assert.equal(ingested.effect, 'applied');
  } finally {
    entry.service = real;
  }
  assert.equal(harness.status(SPACE_A, request.id).status, 'paid');
  assert.equal(JSON.parse(harness.dumpStorage()).events.length, 1);
});

test('two concurrent deliveries finalize once: the loser follows the terminal contract', async (t) => {
  const { definition } = createFixtureStripeAdapter({ secret: SECRET });
  // Both deliveries must be past verification before either may move the
  // request row: the loser's move then reads the winner's paid state.
  // (The old write-then-throw injection is unrepresentable now: the move
  // rolls back with the throw, so the race is driven for real instead.)
  let entered = 0;
  let releaseGate;
  const gate = new Promise((resolve) => { releaseGate = resolve; });
  const gated = {
    ...definition,
    verifyInbound: async (args) => {
      const out = await definition.verifyInbound(args);
      entered += 1;
      if (entered >= 2) releaseGate();
      else await gate;
      return out;
    },
  };
  const { harness } = setup({ adapterDefinition: gated });
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const { request } = await harness.request(SPACE_A, {
    connectionKey: key, quoteId: 'quote-race-t', amount: 1000, currency: 'EUR', requestKey: 'req-race-t',
  });
  const bodyA = paidBody(request.providerRef, 'evt_race_t_1');
  const bodyB = paidBody(request.providerRef, 'evt_race_t_2');
  const [first, second] = await Promise.all([
    harness.ingest(SPACE_A, { connectionKey: key, rawBody: bodyA, headers: harness.faults.sign(bodyA) }),
    harness.ingest(SPACE_A, { connectionKey: key, rawBody: bodyB, headers: harness.faults.sign(bodyB) }),
  ]);
  const applied = [first, second].filter((result) => result.duplicate === false);
  const replayed = [first, second].filter((result) => result.duplicate === true);
  assert.equal(entered, 2, 'both deliveries were in flight before either moved the row');
  assert.equal(applied.length, 1, 'exactly one delivery finalizes');
  assert.equal(applied[0].effect, 'applied');
  assert.equal(replayed.length, 1, 'the loser follows the terminal contract');
  assert.equal(replayed[0].alreadyFinal, true);
  assert.equal(harness.status(SPACE_A, request.id).status, 'paid');
  assert.equal(JSON.parse(harness.dumpStorage()).events.length, 2);
});

test('a secret-shaped provider reference is refused and never stored', async (t) => {
  const hostileRef = 'sk_live_51H7x8y9z0qwertyuiop';
  const { definition } = createFixtureStripeAdapter({ secret: SECRET });
  const hostile = {
    ...definition,
    createPayment: async () => ({ providerRef: hostileRef, url: 'https://checkout.fixture.stripe/pay/x' }),
  };
  const { harness } = setup({ adapterDefinition: hostile });
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  await assert.rejects(
    harness.request(SPACE_A, {
      connectionKey: key, quoteId: 'quote-hostile', amount: 100, currency: 'EUR', requestKey: 'req-hostile',
    }),
    (e) => e.code === 'PAYMENT_PROVIDER_INVALID',
  );
  assert.ok(!harness.dumpStorage().includes(hostileRef), 'the secret-shaped value appears nowhere in stored rows or audit');
});

test('a webhook for another connection quarantines and never finalizes', async (t) => {
  const { harness } = setup();
  t.after(() => harness.close());
  const keyA = await registeredActive(harness, SPACE_A, 'acct_a');
  const keyB = await registeredActive(harness, SPACE_A, 'acct_b');
  const { request } = await harness.request(SPACE_A, {
    connectionKey: keyA, quoteId: 'quote-x', amount: 100, currency: 'EUR', requestKey: 'req-x',
  });
  const body = paidBody(request.providerRef, 'evt_cross_1');
  const ingested = await harness.ingest(SPACE_A, {
    connectionKey: keyB, rawBody: body, headers: harness.faults.sign(body),
  });
  assert.equal(ingested.quarantined, true);
  assert.equal(harness.status(SPACE_A, request.id).status, 'pending');
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

/** Drive a package action the way a direct execute caller does (no framework envelope). */
function directAction(harness, moduleName, actionName, record, input) {
  const action = buildPaymentConnectionActions().find((entry) => entry.name === actionName);
  if (!action) throw new Error(`unknown test action ${actionName}`);
  const service = harness.internals.modules.get(moduleName).service;
  return action.execute({
    record,
    input,
    actor: harness.userActor,
    managed: (id, patch) => service.applyManaged(id, patch, { actor: harness.userActor }),
    now: () => new Date().toISOString(),
  });
}

function connectionRow(harness, spaceId, connectionKey) {
  return harness.internals.modules.get('payment-connection').service
    .listWhere({ spaceId, sourceKey: connectionKey })[0];
}

function requestRow(harness, spaceId, sourceKey) {
  return harness.internals.modules.get('payment-request').service
    .listWhere({ spaceId, sourceKey })[0];
}

test('ingest awaits an async adapter normalization instead of failing closed', async (t) => {
  const { definition } = createFixtureStripeAdapter({ secret: SECRET });
  const syncNormalize = definition.normalizeInbound;
  const asyncDef = { ...definition, normalizeInbound: async (event) => syncNormalize(event) };
  const { harness } = setup({ adapterDefinition: asyncDef });
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const { request } = await harness.request(SPACE_A, {
    connectionKey: key, quoteId: 'quote-async', amount: 100, currency: 'EUR', requestKey: 'req-async',
  });
  const body = paidBody(request.providerRef, 'evt_async_1');
  const ingested = await harness.ingest(SPACE_A, {
    connectionKey: key, rawBody: body, headers: harness.faults.sign(body),
  });
  assert.equal(ingested.effect, 'applied');
  assert.equal(harness.status(SPACE_A, request.id).status, 'paid');
  // An async rejection maps to the same 422 as a sync throw, never a crash.
  const failing = { ...definition, normalizeInbound: async () => { throw new Error('provider boom'); } };
  const { harness: failingHarness } = setup({ adapterDefinition: failing });
  t.after(() => failingHarness.close());
  const failingKey = await registeredActive(failingHarness);
  const pending = await failingHarness.request(SPACE_A, {
    connectionKey: failingKey, quoteId: 'quote-async-fail', amount: 100, currency: 'EUR', requestKey: 'req-async-fail',
  });
  const failBody = paidBody(pending.request.providerRef, 'evt_async_f1');
  await assert.rejects(
    failingHarness.ingest(SPACE_A, {
      connectionKey: failingKey, rawBody: failBody, headers: failingHarness.faults.sign(failBody),
    }),
    (e) => e.code === 'PAYMENT_EVENT_MALFORMED' && e.status === 422,
  );
});

test('a list-shaped normalization is refused, never silently mapped', async (t) => {
  const { definition } = createFixtureStripeAdapter({ secret: SECRET });
  const listed = { ...definition, normalizeInbound: () => [{ providerEventId: 'e1', paymentRef: 'cs_1', eventType: 'checkout.session.completed' }] };
  const { harness } = setup({ adapterDefinition: listed });
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const { request } = await harness.request(SPACE_A, {
    connectionKey: key, quoteId: 'quote-list', amount: 100, currency: 'EUR', requestKey: 'req-list',
  });
  const body = paidBody(request.providerRef, 'evt_list_1');
  await assert.rejects(
    harness.ingest(SPACE_A, { connectionKey: key, rawBody: body, headers: harness.faults.sign(body) }),
    (e) => e.code === 'PAYMENT_EVENT_MALFORMED' && e.status === 422,
  );
});

test('a same-id redelivery after reactivation resumes instead of replaying quarantine', async (t) => {
  const { harness } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const { request } = await harness.request(SPACE_A, {
    connectionKey: key, quoteId: 'quote-resume', amount: 100, currency: 'EUR', requestKey: 'req-resume',
  });
  await directAction(harness, 'payment-connection', 'suspend-connection', connectionRow(harness, SPACE_A, key), { reason: 'kit suspends before the retry' });
  const body = paidBody(request.providerRef, 'evt_resume_1');
  const held = await harness.ingest(SPACE_A, { connectionKey: key, rawBody: body, headers: harness.faults.sign(body) });
  assert.equal(held.quarantined, true);
  assert.equal(harness.status(SPACE_A, request.id).status, 'pending');
  // The binding is reinstated; Stripe retries the identical bytes.
  await directAction(harness, 'payment-connection', 'activate-connection', connectionRow(harness, SPACE_A, key), { reason: 'kit reinstates the binding' });
  const resumed = await harness.ingest(SPACE_A, { connectionKey: key, rawBody: body, headers: harness.faults.sign(body) });
  assert.equal(resumed.duplicate, true);
  assert.equal(resumed.effect, 'applied');
  assert.equal(resumed.status, 'paid');
  assert.equal(harness.status(SPACE_A, request.id).status, 'paid');
  assert.equal(JSON.parse(harness.dumpStorage()).events.length, 1);
});

test('whitespace-only quoteId or offerId is refused', async (t) => {
  const { harness } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  await assert.rejects(
    harness.request(SPACE_A, {
      connectionKey: key, quoteId: '   ', amount: 100, currency: 'EUR', requestKey: 'req-blank-q',
    }),
    (e) => e.code === 'VALIDATION_ERROR',
  );
  await assert.rejects(
    harness.request(SPACE_A, {
      connectionKey: key, offerId: '\t ', amount: 100, currency: 'EUR', requestKey: 'req-blank-o',
    }),
    (e) => e.code === 'VALIDATION_ERROR',
  );
  assert.equal(harness.list(SPACE_A).length, 0);
});

test('cancel-request on a terminal request refuses instead of regressing it', async (t) => {
  const { harness } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const { request } = await harness.request(SPACE_A, {
    connectionKey: key, quoteId: 'quote-cancel', amount: 100, currency: 'EUR', requestKey: 'req-cancel',
  });
  const body = paidBody(request.providerRef, 'evt_cancel_1');
  await harness.ingest(SPACE_A, { connectionKey: key, rawBody: body, headers: harness.faults.sign(body) });
  const paid = requestRow(harness, SPACE_A, request.sourceKey);
  assert.equal(paid.status, 'paid');
  // Direct execute — outside the framework fromStates envelope — refuses.
  await assert.rejects(
    directAction(harness, 'payment-request', 'cancel-request', paid, { reason: 'kit cancels too late' }),
    (e) => e.code === 'PAYMENT_TRANSITION_INVALID',
  );
  assert.equal(harness.status(SPACE_A, request.id).status, 'paid');
  // An open intent still cancels through the same path.
  const open = await harness.request(SPACE_A, {
    connectionKey: key, quoteId: 'quote-cancel-2', amount: 100, currency: 'EUR', requestKey: 'req-cancel-2',
  });
  const canceled = await directAction(
    harness, 'payment-request', 'cancel-request',
    requestRow(harness, SPACE_A, open.request.sourceKey), { reason: 'kit cancels in time' },
  );
  assert.equal(canceled.request.status, 'canceled');
});

/** The kit secret custody, for package-level compositions over the harness stores. */
function kitSecrets() {
  return async (ref) => {
    if (ref !== SECRET_REF) {
      const error = new Error('unknown secret reference');
      error.code = 'SECRET_NOT_FOUND';
      throw error;
    }
    return SECRET;
  };
}

test('two concurrent mints from open mint one checkout: the loser resolves duplicate', async (t) => {
  const { definition, api } = createFixtureStripeAdapter({ secret: SECRET });
  // Force the overlap the single path exists to close: both mints must be
  // inside the provider call before either may move the row. Reaching
  // `pending` is impossible without passing this gate, so the test cannot
  // hang on a missed interleaving.
  let entered = 0;
  let releaseGate;
  const gate = new Promise((resolve) => { releaseGate = resolve; });
  const gated = {
    ...definition,
    createPayment: async (args) => {
      entered += 1;
      if (entered >= 2) releaseGate();
      else await gate;
      return definition.createPayment(args);
    },
  };
  const { harness } = setup({ adapterDefinition: gated });
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const params = {
    connectionKey: key, quoteId: 'quote-race-mint', amount: 100, currency: 'EUR', requestKey: 'req-race-mint',
  };
  const [first, second] = await Promise.all([
    harness.request(SPACE_A, { ...params }),
    harness.request(SPACE_A, { ...params }),
  ]);
  assert.equal(entered, 2, 'both mints reached the provider before either moved the row');
  const winner = first.duplicate ? second : first;
  const loser = first.duplicate ? first : second;
  assert.equal(winner.duplicate, false);
  assert.equal(loser.duplicate, true);
  assert.equal(loser.request.providerRef, winner.request.providerRef);
  assert.equal(loser.request.status, 'pending');
  assert.equal(api.state.createdByKey.size, 1, 'one checkout for one intent');
  assert.equal(harness.list(SPACE_A, { status: 'pending' }).length, 1);
});

test('a suspend racing an in-flight delivery quarantines instead of applying', async (t) => {
  const { definition } = createFixtureStripeAdapter({ secret: SECRET });
  // Park the delivery inside verification: the suspend below must land
  // after the stale connection read and before the finalize decision.
  let enteredVerify = false;
  let releaseVerify;
  const verifyGate = new Promise((resolve) => { releaseVerify = resolve; });
  const gated = {
    ...definition,
    verifyInbound: async (args) => {
      enteredVerify = true;
      await verifyGate;
      return definition.verifyInbound(args);
    },
  };
  const { harness } = setup({ adapterDefinition: gated });
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const { request } = await harness.request(SPACE_A, {
    connectionKey: key, quoteId: 'quote-suspend-race', amount: 100, currency: 'EUR', requestKey: 'req-suspend-race',
  });
  const body = paidBody(request.providerRef, 'evt_suspend_race_1');
  const headers = harness.faults.sign(body);
  const flight = harness.ingest(SPACE_A, { connectionKey: key, rawBody: body, headers });
  let spins = 0;
  while (!enteredVerify && spins < 1000) {
    spins += 1;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(enteredVerify, 'the delivery parked inside verification');
  await directAction(harness, 'payment-connection', 'suspend-connection', connectionRow(harness, SPACE_A, key), { reason: 'kit suspends mid-delivery' });
  releaseVerify();
  const held = await flight;
  assert.equal(held.quarantined, true);
  assert.equal(harness.status(SPACE_A, request.id).status, 'pending');
  // Reactivation resumes the identical retry bytes to paid, on one event row.
  await directAction(harness, 'payment-connection', 'activate-connection', connectionRow(harness, SPACE_A, key), { reason: 'kit reinstates the binding' });
  const resumed = await harness.ingest(SPACE_A, { connectionKey: key, rawBody: body, headers });
  assert.equal(resumed.effect, 'applied');
  assert.equal(harness.status(SPACE_A, request.id).status, 'paid');
  assert.equal(JSON.parse(harness.dumpStorage()).events.length, 1);
});

test('a case-only retry of the same account resolves duplicate instead of conflicting', async (t) => {
  const { harness } = setup();
  t.after(() => harness.close());
  const first = await harness.register(SPACE_A, {
    provider: 'stripe', account: 'Acct_Presti', adapter: 'fixture-stripe', adapterVersion: 1, secretRef: SECRET_REF,
  });
  assert.equal(first.duplicate, false);
  await harness.activate(SPACE_A, first.connection.sourceKey);
  const second = await harness.register(SPACE_A, {
    provider: 'stripe', account: 'acct_presti', adapter: 'fixture-stripe', adapterVersion: 1, secretRef: SECRET_REF,
  });
  assert.equal(second.duplicate, true);
  assert.equal(second.connection.sourceKey, first.connection.sourceKey);
});

test('listPayments is a composed package operation with a refused unknown filter', async (t) => {
  const { definition } = createFixtureStripeAdapter({ secret: SECRET });
  const { harness } = setup();
  t.after(() => harness.close());
  const pkg = createPaymentsPackage({ paymentAdapters: [definition], resolveSecret: kitSecrets() });
  const byMethod = Object.fromEntries(pkg.operations.map((entry) => [entry.appMethod, entry]));
  assert.ok(byMethod.listPayments, 'list-payments is registered on the composed package');
  assert.equal(byMethod.listPayments.name, 'list-payments');
  const runtime = harness.internals;
  const register = byMethod.registerPaymentConnection.create(runtime);
  const request = byMethod.requestPayment.create(runtime);
  const list = byMethod.listPayments.create(runtime);
  const { connection } = await register({
    spaceId: SPACE_A, provider: 'stripe', account: ACCOUNT_A,
    adapter: 'fixture-stripe', adapterVersion: 1, secretRef: SECRET_REF, actor: harness.userActor,
  });
  await harness.activate(SPACE_A, connection.sourceKey);
  await request({
    spaceId: SPACE_A, connectionKey: connection.sourceKey,
    quoteId: 'quote-pkg-op', amount: 100, currency: 'EUR', requestKey: 'req-pkg-op',
    actor: harness.userActor,
  });
  const rows = await list({ spaceId: SPACE_A });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].quoteId, 'quote-pkg-op');
  assert.equal((await list({ spaceId: SPACE_A, status: 'pending' })).length, 1);
  assert.equal((await list({ spaceId: SPACE_A, status: 'paid' })).length, 0);
  await assert.rejects(list({ spaceId: SPACE_A, status: 'bogus' }), (error) => error.code === 'VALIDATION_ERROR');
});

test('operations honor a renamed request module, and cancel moves through the single path', async (t) => {
  const { harness } = setup();
  t.after(() => harness.close());
  const renamed = new Map(harness.internals.modules);
  renamed.set('shop-payment-request', renamed.get('payment-request'));
  const ops = createPaymentOperations({
    database: harness.internals.database,
    modules: renamed,
    registries: harness.internals.registries,
    resolveSecret: kitSecrets(),
    config: { requestModule: 'shop-payment-request' },
  });
  const key = await registeredActive(harness);
  const { request } = await ops.requestPayment({
    spaceId: SPACE_A, connectionKey: key, quoteId: 'quote-remap', amount: 100, currency: 'EUR',
    requestKey: 'req-remap', actor: harness.userActor,
  });
  assert.equal(request.status, 'pending');
  const cancel = buildPaymentConnectionActions(
    resolvePaymentModuleNames({ modules: { 'payment-request': 'shop-payment-request' } }),
  ).find((entry) => entry.name === 'cancel-request');
  assert.equal(cancel.module, 'shop-payment-request');
  const service = renamed.get('shop-payment-request').service;
  const row = service.listWhere({ spaceId: SPACE_A, sourceKey: request.sourceKey })[0];
  const canceled = await cancel.execute({
    record: row,
    input: { reason: 'kit cancels a remapped request' },
    actor: harness.userActor,
    managed: (id, patch) => service.applyManaged(id, patch, { actor: harness.userActor }),
    modules: renamed,
    database: harness.internals.database,
    now: () => new Date().toISOString(),
  });
  assert.equal(canceled.request.status, 'canceled');
  assert.equal(ops.getPaymentStatus(SPACE_A, request.id).status, 'canceled');
});

test('a revoked account rebinds through the explicit action and serves again', async (t) => {
  const { harness } = setup();
  t.after(() => harness.close());
  const { connection } = await harness.register(SPACE_A, {
    provider: 'stripe', account: ACCOUNT_A, adapter: 'fixture-stripe', adapterVersion: 1, secretRef: SECRET_REF,
  });
  await harness.activate(SPACE_A, connection.sourceKey);
  await directAction(harness, 'payment-connection', 'revoke-connection', connectionRow(harness, SPACE_A, connection.sourceKey), { reason: 'kit revokes by mistake' });
  assert.equal(connectionRow(harness, SPACE_A, connection.sourceKey).status, 'revoked');
  // An identical re-registration over the revoked row resolves identically.
  const identical = await harness.register(SPACE_A, {
    provider: 'stripe', account: ACCOUNT_A, adapter: 'fixture-stripe', adapterVersion: 1, secretRef: SECRET_REF,
  });
  assert.equal(identical.duplicate, true);
  assert.equal(identical.connection.status, 'revoked');
  // A different binding over the revoked row is refused and names the
  // explicit path — never a revoke that could not unblock it.
  await assert.rejects(
    harness.register(SPACE_A, {
      provider: 'stripe', account: ACCOUNT_A, adapter: 'fixture-stripe', adapterVersion: 1, secretRef: 'vault://kit/stripe-b',
    }),
    (e) => e.code === 'PAYMENT_CONNECTION_CONFLICT' && /rebind-connection/.test(e.message),
  );
  // The explicit action returns the binding to pending with a new secret.
  const rebound = await directAction(
    harness, 'payment-connection', 'rebind-connection',
    connectionRow(harness, SPACE_A, connection.sourceKey),
    { secretRef: SECRET_REF, reason: 'kit recovers the incident' },
  );
  assert.equal(rebound.connection.status, 'pending');
  const reboundRow = connectionRow(harness, SPACE_A, connection.sourceKey);
  assert.equal(reboundRow.status, 'pending');
  assert.ok(typeof reboundRow.secretRotatedAt === 'string');
  // Traffic resumes only after activation, and rebinding a live binding
  // is refused on the spot.
  await assert.rejects(
    harness.request(SPACE_A, {
      connectionKey: connection.sourceKey, quoteId: 'quote-early', amount: 100, currency: 'EUR', requestKey: 'req-rebind-early',
    }),
    (e) => e.code === 'PAYMENT_CONNECTION_NOT_ACTIVE',
  );
  await harness.activate(SPACE_A, connection.sourceKey);
  await assert.rejects(
    directAction(harness, 'payment-connection', 'rebind-connection', connectionRow(harness, SPACE_A, connection.sourceKey), { secretRef: SECRET_REF, reason: 'kit rebinds a live binding' }),
    (e) => e.code === 'VALIDATION_ERROR',
  );
  const { request } = await harness.request(SPACE_A, {
    connectionKey: connection.sourceKey, quoteId: 'quote-rebind', amount: 100, currency: 'EUR', requestKey: 'req-rebind',
  });
  assert.equal(request.status, 'pending');
  const body = paidBody(request.providerRef, 'evt_rebind_1');
  const ingested = await harness.ingest(SPACE_A, {
    connectionKey: connection.sourceKey, rawBody: body, headers: harness.faults.sign(body),
  });
  assert.equal(ingested.status, 'paid');
  assert.equal(harness.status(SPACE_A, request.id).status, 'paid');
});

test('rotate-connection-secret stamps a new reference and refuses revoked bindings', async (t) => {
  const { harness } = setup();
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  const rotated = await directAction(
    harness, 'payment-connection', 'rotate-connection-secret',
    connectionRow(harness, SPACE_A, key), { secretRef: SECRET_REF },
  );
  assert.equal(rotated.connection.secretRef, SECRET_REF);
  assert.ok(typeof connectionRow(harness, SPACE_A, key).secretRotatedAt === 'string');
  // A raw value in place of its locator is refused and stored nowhere.
  await assert.rejects(
    directAction(harness, 'payment-connection', 'rotate-connection-secret', connectionRow(harness, SPACE_A, key), { secretRef: 'sk_live_rawvalue' }),
    (e) => e.code === 'VALIDATION_ERROR',
  );
  assert.ok(!harness.dumpStorage().includes('sk_live_rawvalue'));
  await directAction(harness, 'payment-connection', 'revoke-connection', connectionRow(harness, SPACE_A, key), { reason: 'kit revokes before the rotate' });
  await assert.rejects(
    directAction(harness, 'payment-connection', 'rotate-connection-secret', connectionRow(harness, SPACE_A, key), { secretRef: SECRET_REF }),
    (e) => e.code === 'PAYMENT_ROTATE_INVALID' && e.status === 409,
  );
  assert.equal(connectionRow(harness, SPACE_A, key).status, 'revoked');
});

test('a suspend during checkout mint holds the session: no orphan, same session resumed', async (t) => {
  const { definition, api } = createFixtureStripeAdapter({ secret: SECRET });
  let suspendMidMint = null;
  const gated = {
    ...definition,
    createPayment: async (args) => {
      const created = await definition.createPayment(args);
      if (suspendMidMint) await suspendMidMint();
      return created;
    },
  };
  const { harness } = setup({ adapterDefinition: gated });
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  suspendMidMint = () => directAction(
    harness, 'payment-connection', 'suspend-connection',
    connectionRow(harness, SPACE_A, key), { reason: 'kit suspends mid-mint' },
  );
  await assert.rejects(
    harness.request(SPACE_A, {
      connectionKey: key, quoteId: 'quote-hold', amount: 100, currency: 'EUR', requestKey: 'req-hold',
    }),
    (e) => e.code === 'PAYMENT_CONNECTION_NOT_ACTIVE' && e.status === 409,
  );
  // Exactly one provider session exists, and the intent holds its
  // reference instead of dropping it: the session is linked, never orphan.
  assert.equal(api.state.createCalls, 1);
  const mintedRef = [...api.state.createdByKey.values()][0].providerRef;
  const rows = harness.internals.modules.get('payment-request').service.listWhere({ spaceId: SPACE_A });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'open');
  assert.equal(rows[0].providerRef, mintedRef);
  // After reactivation the same key resumes the held checkout: the
  // provider sees no second call, and the webhook finalizes it to paid.
  await harness.activate(SPACE_A, key);
  const retry = await harness.request(SPACE_A, {
    connectionKey: key, quoteId: 'quote-hold', amount: 100, currency: 'EUR', requestKey: 'req-hold',
  });
  assert.equal(retry.request.status, 'pending');
  assert.equal(retry.request.providerRef, mintedRef);
  assert.equal(api.state.createCalls, 1, 'the retry resumes the held checkout instead of minting again');
  const body = paidBody(mintedRef, 'evt_hold_1');
  const ingested = await harness.ingest(SPACE_A, {
    connectionKey: key, rawBody: body, headers: harness.faults.sign(body),
  });
  assert.equal(ingested.status, 'paid');
  assert.equal(harness.status(SPACE_A, retry.request.id).status, 'paid');
});

test('ops.listPayments refuses an unknown status filter directly, never an empty list', async (t) => {
  const { harness } = setup();
  t.after(() => harness.close());
  await registeredActive(harness);
  assert.throws(() => harness.list(SPACE_A, { status: 'pendnig' }), (e) => e.code === 'VALIDATION_ERROR');
  assert.equal(harness.list(SPACE_A, { status: 'pending' }).length, 0);
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
