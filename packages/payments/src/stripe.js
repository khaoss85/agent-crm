// @ts-check

import { AppError } from '../../core/index.js';
import { paymentWebhookHeaders, verifyPaymentWebhook } from './crypto.js';

/**
 * Fixture Stripe adapter (backlog:1972e16d33f2).
 *
 * The adapter the tests prove today, and the shape the real Stripe adapter
 * takes tomorrow: HMAC-signed inbound webhooks over `timestamp.body`,
 * canonical JSON events naming the paid checkout, idempotent payment
 * creation keyed by the framework's intent key. Real credentials do not
 * exist yet (owner decision MEM_ACC_DECISIONS) — the secret here is a
 * declared test-only fixture value, resolved through the same
 * `resolveSecret` edge production uses.
 *
 * Product choice (simplest that meets the use case): one `createPayment`
 * entry mints either a Checkout Session or a Payment Link — the fixture
 * models Checkout; a real adapter picks per call from the same intent.
 */

export const FIXTURE_STRIPE_ADAPTER_NAME = 'fixture-stripe';
export const FIXTURE_STRIPE_ADAPTER_VERSION = 1;

/** Event types the ingest finalizes. Anything else quarantines as evidence. */
export const STRIPE_FINAL_TYPES = Object.freeze(['checkout.session.completed', 'checkout.session.expired', 'payment_intent.payment_failed']);

export function createFixtureStripeAdapter(options = {}) {
  const name = options.name ?? FIXTURE_STRIPE_ADAPTER_NAME;
  const expectedSecret = options.secret ?? 'fixture-stripe-secret';
  const state = {
    /** @type {Map<string, {providerRef: string, url: string, amount: number, currency: string}>} */
    createdByKey: new Map(),
    createCalls: 0,
  };

  const api = {
    state,
    reset() {
      state.createdByKey.clear();
      state.createCalls = 0;
    },
    createdPayments() {
      return [...state.createdByKey.values()];
    },
  };

  return {
    definition: {
      name,
      version: FIXTURE_STRIPE_ADAPTER_VERSION,
      label: 'Fixture Stripe',
      provider: 'stripe',
      config: { testOnly: true, mode: 'checkout' },

      verifyInbound({ rawBody, headers, secret }) {
        const signature = headers?.['x-payment-signature-256'];
        const timestamp = headers?.['x-payment-timestamp'];
        const ok = verifyPaymentWebhook({ rawBody, signature, timestamp, secret });
        if (!ok) return { ok: false };
        return { ok: true, event: Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody ?? '') };
      },

      normalizeInbound(event) {
        let parsed;
        try {
          parsed = JSON.parse(String(event));
        } catch {
          throw new AppError('Fixture payment event is not JSON', { code: 'PAYMENT_EVENT_MALFORMED', status: 422 });
        }
        // Stripe sends one event per webhook delivery — never a batch
        // (README): a list-shaped body is refused, never silently mapped.
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new AppError('Fixture payment event is not an object', { code: 'PAYMENT_EVENT_MALFORMED', status: 422 });
        }
        return {
          providerEventId: typeof parsed?.id === 'string' ? parsed.id : '',
          paymentRef: typeof parsed?.paymentRef === 'string' ? parsed.paymentRef : '',
          eventType: typeof parsed?.type === 'string' ? parsed.type : '',
          occurredAt: typeof parsed?.at === 'string' ? parsed.at : null,
        };
      },

      async createPayment({ amount, currency, intentKey, secret }) {
        state.createCalls += 1;
        if (secret !== expectedSecret) {
          throw new AppError('Fixture secret mismatch', { code: 'PAYMENT_PROVIDER_REFUSED', status: 403 });
        }
        if (!Number.isSafeInteger(amount) || amount <= 0) {
          throw new AppError('Fixture payment needs a positive integer amount', { code: 'PAYMENT_AMOUNT_INVALID', status: 422 });
        }
        const existing = state.createdByKey.get(intentKey);
        if (existing) return { providerRef: existing.providerRef, url: existing.url };
        const providerRef = `cs_fixture_${state.createdByKey.size + 1}`;
        const url = `https://checkout.fixture.stripe/pay/${providerRef}`;
        state.createdByKey.set(intentKey, { providerRef, url, amount, currency });
        return { providerRef, url };
      },
    },
    api,
  };
}

/** Headers a test client sends for a signed fixture body. One construction, shared with verification. */
export function fixturePaymentWebhookHeaders(rawBody, secret, timestampSeconds) {
  return paymentWebhookHeaders(rawBody, secret, timestampSeconds);
}

/** Build one fixture payment event body (Stripe-like checkout.session.completed). */
export function fixturePaymentEventBody({ id, paymentRef, type = 'checkout.session.completed', at = null }) {
  return JSON.stringify({ id, paymentRef, type, ...(at === null ? {} : { at }) });
}
