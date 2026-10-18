import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PAYMENT_PROVIDERS,
  PaymentRegistries,
  validatePaymentAdapter,
} from '../packages/payments/src/adapter.js';
import {
  CONNECTION_STATUSES,
  CONNECTION_TRANSITIONS,
  assertConnectionInput,
  assertConnectionTransition,
  assertCurrency,
  assertSecretReference,
  assertSpaceId,
  boundedKey,
  paymentIntentKey,
} from '../packages/payments/src/connection.js';
import {
  fingerprintPayload,
  paymentWebhookHeaders,
  verifyPaymentWebhook,
} from '../packages/payments/src/crypto.js';
import {
  EVENT_EVENTS,
  EVENT_STATES,
  REQUEST_EVENTS,
  REQUEST_STATUSES,
  REQUEST_TERMINAL,
  assertPaymentEventTransition,
  assertRequestTransition,
  paymentEventState,
} from '../packages/payments/src/transitions.js';
import {
  buildPaymentConnectionActions,
  resolvePaymentModuleNames,
} from '../packages/payments/src/index.js';

/**
 * Payments contract tests (backlog:1972e16d33f2): the adapter contract, the
 * connection and request identity rules, webhook verification primitives,
 * the lifecycle tables. No database — pure contract.
 */

const adapter = (overrides = {}) => ({
  name: 'fixture-stripe',
  version: 1,
  label: 'Fixture Stripe',
  provider: 'stripe',
  config: { testOnly: true },
  verifyInbound: async () => ({ ok: true, event: '{}' }),
  normalizeInbound: () => ({ providerEventId: 'e1', paymentRef: 'cs_1', eventType: 'checkout.session.completed' }),
  createPayment: async () => ({ providerRef: 'cs_1', url: 'https://checkout.fixture.stripe/pay/cs_1' }),
  ...overrides,
});

const registries = () => new PaymentRegistries({ paymentAdapters: [adapter()] });

const connectionInput = (overrides = {}) => ({
  spaceId: 'presti',
  provider: 'stripe',
  account: 'acct_presti',
  adapter: 'fixture-stripe',
  adapterVersion: 1,
  secretRef: 'vault://presti/stripe',
  ...overrides,
});

test('payment providers and connection statuses are the declared sets', () => {
  assert.deepEqual([...PAYMENT_PROVIDERS], ['stripe']);
  assert.deepEqual([...CONNECTION_STATUSES], ['pending', 'active', 'suspended', 'revoked']);
  assert.deepEqual(Object.keys(CONNECTION_TRANSITIONS).sort(), [...CONNECTION_STATUSES].sort());
  assert.deepEqual([...REQUEST_STATUSES], ['open', 'pending', 'paid', 'failed', 'canceled']);
  assert.deepEqual([...REQUEST_EVENTS], ['mint', 'pay', 'fail', 'cancel']);
  assert.deepEqual([...REQUEST_TERMINAL].sort(), ['canceled', 'failed', 'paid']);
  assert.deepEqual([...EVENT_STATES].sort(), ['applied', 'discarded', 'quarantined', 'received']);
  assert.deepEqual([...EVENT_EVENTS].sort(), ['apply', 'discard', 'quarantine']);
});

test('adapter validation refuses unknown fields, hostile keys and wrong handlers', () => {
  const good = validatePaymentAdapter(adapter());
  assert.equal(good.name, 'fixture-stripe');
  assert.equal(typeof good.fingerprint, 'string');
  assert.throws(() => validatePaymentAdapter({ ...adapter(), extra: 1 }), /unsupported field/);
  assert.throws(() => validatePaymentAdapter({ ...adapter(), ['__proto__']: 1 }), /hostile key/);
  assert.throws(() => validatePaymentAdapter({ ...adapter(), createPayment: 'no' }), /must be a function/);
  assert.throws(() => validatePaymentAdapter({ ...adapter(), provider: 'paypal' }), /provider must be/);
  assert.throws(() => new PaymentRegistries({ paymentAdapters: [adapter(), adapter()] }), /Duplicate/);
  assert.throws(() => registries().getAdapter('nope', 1), /Unknown payment adapter/);
});

test('connection input binds one account per space and refuses raw secrets', () => {
  const first = assertConnectionInput(connectionInput(), registries());
  assert.equal(first.sourceKey, assertConnectionInput(connectionInput(), registries()).sourceKey);
  assert.notEqual(
    first.sourceKey,
    assertConnectionInput(connectionInput({ spaceId: 'other' }), registries()).sourceKey,
  );
  assert.throws(() => assertConnectionInput(connectionInput({ secretRef: 'sk_live_rawvalue' }), registries()), /secretRef/);
  assert.throws(() => assertConnectionInput(connectionInput({ secretRef: 'sk_live_abc123' }), registries()), /secretRef/);
  assert.throws(() => assertConnectionInput(connectionInput({ provider: 'paypal' }), registries()), /provider must be/);
  assert.throws(() => assertConnectionInput(connectionInput({ adapter: 'nope' }), registries()), /Unknown payment adapter/);
});

test('connection transitions gate every move, with rebind the single revoked exit', () => {
  assert.equal(assertConnectionTransition('pending', 'active'), 'active');
  assert.equal(assertConnectionTransition('revoked', 'pending'), 'pending');
  assert.throws(() => assertConnectionTransition('revoked', 'active'), /cannot move/);
  assert.throws(() => assertConnectionTransition('revoked', 'suspended'), /cannot move/);
  assert.throws(() => assertConnectionTransition('revoked', 'revoked'), /cannot move/);
  assert.throws(() => assertConnectionTransition('active', 'pending'), /cannot move/);
});

test('request transitions move intent to terminal exactly once', () => {
  assert.equal(assertRequestTransition('open', 'mint'), 'pending');
  assert.equal(assertRequestTransition('pending', 'pay'), 'paid');
  assert.equal(assertRequestTransition('pending', 'fail'), 'failed');
  assert.equal(assertRequestTransition('open', 'cancel'), 'canceled');
  assert.equal(assertRequestTransition('pending', 'cancel'), 'canceled');
  for (const terminal of REQUEST_TERMINAL) {
    for (const event of REQUEST_EVENTS) {
      assert.throws(() => assertRequestTransition(terminal, event), /cannot/, `${terminal} + ${event} must refuse`);
    }
  }
  assert.throws(() => assertRequestTransition('open', 'pay'), /cannot/);
  assert.equal(assertPaymentEventTransition('received', 'apply'), 'applied');
  assert.throws(() => assertPaymentEventTransition('applied', 'apply'), /cannot/);
  assert.equal(paymentEventState({ processed: true, effect: 'applied' }), 'applied');
  assert.equal(paymentEventState({ processed: false }), 'received');
});

test('control characters never land in keys, accounts or request ids', () => {
  for (const hostile of ['a\nb', 'a\rb', 'a\tb', 'a\x7fb', 'a\x00b']) {
    assert.throws(() => boundedKey('pay-evt', 'presti', 'k', hostile), /single-line/, JSON.stringify(hostile));
    assert.throws(
      () => assertConnectionInput(connectionInput({ account: hostile }), registries()),
      /single-line/,
      JSON.stringify(hostile),
    );
    assert.throws(
      () => paymentIntentKey({ spaceId: 'presti', connectionKey: 'k', requestKey: hostile }),
      /single-line/,
      JSON.stringify(hostile),
    );
  }
});

test('space, currency and intent keys are bounded and injective', () => {
  assert.equal(assertSpaceId('presti'), 'presti');
  assert.throws(() => assertSpaceId('Presti'), /spaceId/);
  assert.equal(assertCurrency('EUR'), 'EUR');
  assert.throws(() => assertCurrency('eur'), /currency/);
  assert.throws(() => assertCurrency('EURO'), /currency/);
  const key = paymentIntentKey({ spaceId: 'presti', connectionKey: 'pay-conn:presti:stripe:x', requestKey: 'r1' });
  assert.ok(key.startsWith('pay-req:'));
  assert.ok(key.length <= 256);
  assert.notEqual(key, paymentIntentKey({ spaceId: 'presti', connectionKey: 'pay-conn:presti:stripe:x', requestKey: 'r2' }));
  assert.equal(boundedKey('a:b', 'c'), 'a%3Ab:c');
});

test('webhook verification is constant-time over timestamp.body and refuses skew', () => {
  const secret = 's3cret';
  const body = JSON.stringify({ id: 'evt_1' });
  const nowSec = Math.floor(Date.now() / 1000);
  const headers = paymentWebhookHeaders(body, secret, nowSec);
  assert.equal(verifyPaymentWebhook({ rawBody: body, secret, ...pick(headers) }), true);
  assert.equal(verifyPaymentWebhook({ rawBody: `${body} `, secret, ...pick(headers) }), false);
  assert.equal(verifyPaymentWebhook({ rawBody: body, secret: 'wrong', ...pick(headers) }), false);
  const stale = paymentWebhookHeaders(body, secret, nowSec - 3600);
  assert.equal(verifyPaymentWebhook({ rawBody: body, secret, ...pick(stale) }), false);
  assert.equal(typeof fingerprintPayload(body), 'string');
  assert.equal(fingerprintPayload(body), fingerprintPayload(Buffer.from(body, 'utf8')));
});

/** Map the header names onto verifyPaymentWebhook params. */
function pick(headers) {
  return { signature: headers['x-payment-signature-256'], timestamp: headers['x-payment-timestamp'] };
}

test('module renames are honored by actions and config, and unknown names are refused', () => {
  const canonical = resolvePaymentModuleNames({});
  assert.deepEqual({ ...canonical }, {
    'payment-connection': 'payment-connection',
    'payment-request': 'payment-request',
    'payment-event': 'payment-event',
  });
  const renamed = resolvePaymentModuleNames({ modules: { 'payment-request': 'shop-payment-request' } });
  assert.equal(renamed['payment-request'], 'shop-payment-request');
  assert.equal(renamed['payment-connection'], 'payment-connection');
  const actions = buildPaymentConnectionActions(renamed);
  assert.equal(actions.find((entry) => entry.name === 'cancel-request').module, 'shop-payment-request');
  assert.equal(actions.find((entry) => entry.name === 'suspend-connection').module, 'payment-connection');
  // Every action declares its renamed module — including rotate, which
  // once hardcoded the canonical connection name, and the rebind action.
  const allRenamed = resolvePaymentModuleNames({
    modules: {
      'payment-connection': 'shop-payment-connection',
      'payment-request': 'shop-payment-request',
      'payment-event': 'shop-payment-event',
    },
  });
  assert.deepEqual(
    Object.fromEntries(
      buildPaymentConnectionActions(allRenamed).map((entry) => [entry.name, entry.module]),
    ),
    {
      'activate-connection': 'shop-payment-connection',
      'suspend-connection': 'shop-payment-connection',
      'revoke-connection': 'shop-payment-connection',
      'rotate-connection-secret': 'shop-payment-connection',
      'rebind-connection': 'shop-payment-connection',
      'cancel-request': 'shop-payment-request',
    },
  );
  const fromConfig = resolvePaymentModuleNames({ config: { requestModule: 'shop-payment-request' } });
  assert.equal(fromConfig['payment-request'], 'shop-payment-request');
  // A modules entry wins over the config key saying the same thing.
  const both = resolvePaymentModuleNames({
    config: { requestModule: 'cfg-payment-request' },
    modules: { 'payment-request': 'shop-payment-request' },
  });
  assert.equal(both['payment-request'], 'shop-payment-request');
  assert.throws(() => resolvePaymentModuleNames({ modules: { 'payment-ledger': 'x' } }), /unknown payment module/);
  assert.throws(() => resolvePaymentModuleNames({ modules: { 'payment-request': '' } }), /non-empty string/);
  assert.throws(() => resolvePaymentModuleNames({ modules: ['payment-request'] }), /must map record names/);
  assert.throws(() => resolvePaymentModuleNames({ config: { requestModule: '' } }), /non-empty string/);
});
