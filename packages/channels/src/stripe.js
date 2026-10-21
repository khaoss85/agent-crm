// @ts-check

import { AppError } from '../../core/index.js';
import { inboundOnlyOutbound } from './adapter.js';
import { verifyHmacWebhook } from './crypto.js';
import { fixtureEnvelopeEvent } from './fixture.js';

/**
 * Stripe webhook adapter (backlog:ffce3d1cd636).
 *
 * Inbound-only by contract: Stripe delivers payment events INTO the space,
 * and this package never sends through it — money moves through
 * `packages/payments`, never through a channel send. Both halves of the
 * outbound path refuse with the contract's CHANNEL_SEND_UNSUPPORTED (see
 * `inboundOnlyOutbound` in `adapter.js`), which `operations.js` hands back
 * intact and the shared kit asserts.
 *
 * Fake-backed on purpose (owner decision MEM_ACC_DECISIONS: no provider
 * credentials exist yet, and none are invented here): inbound webhooks
 * verify with the shared channel HMAC scheme (`crypto.js`) — the scheme
 * the fake signs with, and the scheme the kit harness signs with. The
 * payment itself stays in `packages/payments`; this adapter is the channel
 * binding that records the notification as one inbox event.
 *
 * What the adapter owns (the stripe policy, fail-closed):
 * - inbound: Stripe event notifications (`object: 'event'` with the event
 *   id, the event type and a unix `created` instant) normalized to one
 *   channel event per notification, plus the kit's minimal envelope on the
 *   kit path. The subject is the event type (`stripe:<type>`); the event
 *   payload is never stored — only the fingerprint.
 * - outbound: refused, always, with CHANNEL_SEND_UNSUPPORTED.
 */

export const STRIPE_ADAPTER_NAME = 'stripe-webhook';
export const STRIPE_ADAPTER_VERSION = 1;

function malformedEvent(reason) {
  throw new AppError(`Stripe event is not well-formed: ${reason}`, {
    code: 'CHANNEL_EVENT_MALFORMED', status: 422,
  });
}

function unixToInstant(timestamp) {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > 4102444800) return null;
  return new Date(timestamp * 1000).toISOString();
}

/**
 * Normalize one verified webhook body. Speaks the Stripe event shape when
 * the body carries it, and the kit's minimal envelope otherwise (the same
 * fallback every fake adapter shares, so the kit drives
 * receive/replay/out-of-order through the provider path).
 */
function normalizeStripeInbound(event) {
  let parsed;
  try {
    parsed = JSON.parse(String(event));
  } catch {
    malformedEvent('event is not JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    malformedEvent('event is not an object');
  }
  if (parsed.object === undefined || parsed.object === null) {
    return fixtureEnvelopeEvent(parsed);
  }
  if (parsed.object !== 'event') {
    malformedEvent(`unsupported Stripe object "${String(parsed.object).slice(0, 64)}"`);
  }
  const id = typeof parsed.id === 'string' ? parsed.id : '';
  if (id === '' || id.length > 256) {
    malformedEvent('"id" must be bounded non-empty text (1-256 characters)');
  }
  const type = typeof parsed.type === 'string' ? parsed.type : '';
  if (type === '' || type.length > 128) {
    malformedEvent('"type" must be bounded non-empty text (1-128 characters)');
  }
  const occurredAt = unixToInstant(parsed.created);
  if (occurredAt === null) {
    malformedEvent('"created" must be unix seconds');
  }
  return {
    providerEventId: id,
    subject: `stripe:${type}`,
    sequence: Number.isSafeInteger(parsed.created) ? parsed.created : null,
    occurredAt,
  };
}

/**
 * Build the fake-backed Stripe adapter: `{ definition, api }` in the
 * fixture's shape, so the kit harness drives it unchanged. The double
 * keeps no secret of its own: verification is the HMAC over the secret
 * production resolves through the same `resolveSecret` edge.
 */
export function createStripeChannelAdapter(options = {}) {
  const state = {
    mode: 'ok',
    flakyRemaining: 0,
    /** @type {Map<string, {providerMessageId: string, message: any}>} */
    sentByKey: new Map(),
    sendCalls: 0,
  };

  const api = {
    state,
    /** @param {'ok'|'refuse'|'timeout'} mode @param {number} [flakyFailures] */
    setMode(mode, flakyFailures = 0) {
      state.mode = mode;
      state.flakyRemaining = flakyFailures;
    },
    reset() {
      state.mode = 'ok';
      state.flakyRemaining = 0;
      state.sentByKey.clear();
      state.sendCalls = 0;
    },
  };

  return {
    definition: {
      name: options.name ?? STRIPE_ADAPTER_NAME,
      version: STRIPE_ADAPTER_VERSION,
      label: 'Stripe events (fake-backed)',
      channel: 'stripe',
      config: { testOnly: true },

      verifyInbound({ rawBody, headers, secret }) {
        const signature = headers?.['x-channel-signature-256'];
        const timestamp = headers?.['x-channel-timestamp'];
        const ok = verifyHmacWebhook({ rawBody, signature, timestamp, secret });
        if (!ok) return { ok: false };
        return { ok: true, event: Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody ?? '') };
      },

      normalizeInbound(event) {
        return normalizeStripeInbound(event);
      },

      ...inboundOnlyOutbound('Stripe events'),
    },
    api,
  };
}

/** Build one Stripe event body. */
export function stripeEventBody({ id, type = 'payment_intent.succeeded', createdSec = null }) {
  return JSON.stringify({
    id,
    object: 'event',
    type,
    created: createdSec ?? Math.floor(Date.now() / 1000),
    data: { object: {} },
  });
}
