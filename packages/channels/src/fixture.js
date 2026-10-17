// @ts-check

import { AppError } from '../../core/index.js';
import { hmacWebhookHeaders, verifyHmacWebhook } from './crypto.js';

/**
 * Fixture channel adapter (backlog:e5532d1c9146).
 *
 * The adapter the kit proves today, and the shape every real adapter takes
 * tomorrow: HMAC-signed inbound webhooks over `timestamp.body`, canonical
 * JSON events, idempotent outbound sends keyed by the framework's
 * idempotency key. Real credentials do not exist yet (owner decision
 * MEM_ACC_DECISIONS) — the secret here is a declared test-only fixture
 * value, resolved through the same `resolveSecret` edge production uses.
 *
 * Failure modes are programmable per test: `ok`, `flaky(n)` (transient
 * failures, then success), `refuse` (permanent), `timeout` (never settles —
 * the framework's bound converts it).
 */

export const FIXTURE_ADAPTER_NAME = 'fixture-channel';
export const FIXTURE_ADAPTER_VERSION = 1;

export function createFixtureChannelAdapter(options = {}) {
  const name = options.name ?? FIXTURE_ADAPTER_NAME;
  const channel = options.channel ?? 'whatsapp';
  const expectedSecret = options.secret ?? 'fixture-channel-secret';
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
    sentMessages() {
      return [...state.sentByKey.values()].map((entry) => entry.message);
    },
  };

  return {
    definition: {
      name,
      version: FIXTURE_ADAPTER_VERSION,
      label: 'Fixture channel',
      channel,
      config: { testOnly: true },

      verifyInbound({ rawBody, headers, secret }) {
        const signature = headers?.['x-channel-signature-256'];
        const timestamp = headers?.['x-channel-timestamp'];
        const ok = verifyHmacWebhook({ rawBody, signature, timestamp, secret });
        if (!ok) return { ok: false };
        return { ok: true, event: Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody ?? '') };
      },

      normalizeInbound(event) {
        let parsed;
        try {
          parsed = JSON.parse(String(event));
        } catch {
          throw new AppError('Fixture event is not JSON', { code: 'CHANNEL_EVENT_MALFORMED', status: 422 });
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new AppError('Fixture event is not an object', { code: 'CHANNEL_EVENT_MALFORMED', status: 422 });
        }
        return {
          providerEventId: typeof parsed.id === 'string' ? parsed.id : '',
          subject: typeof parsed.subject === 'string' ? parsed.subject : '',
          sequence: Number.isSafeInteger(parsed.seq) ? parsed.seq : null,
          occurredAt: typeof parsed.at === 'string' ? parsed.at : null,
        };
      },

      normalizeOutbound(message) {
        if (!message || typeof message !== 'object' || Array.isArray(message)) {
          throw new AppError('Fixture message must be an object', { code: 'CHANNEL_MESSAGE_MALFORMED', status: 422 });
        }
        const to = typeof message.to === 'string' ? message.to.trim() : '';
        const text = typeof message.text === 'string' ? message.text : '';
        if (to === '' || to.length > 256 || text === '' || text.length > 4096) {
          throw new AppError('Fixture message needs a bounded "to" and non-empty "text" (at most 4096 chars)', {
            code: 'CHANNEL_MESSAGE_MALFORMED', status: 422,
          });
        }
        return { to, text };
      },

      async sendOutbound({ message, secret, idempotencyKey }) {
        state.sendCalls += 1;
        if (secret !== expectedSecret) {
          throw new AppError('Fixture secret mismatch', { code: 'CHANNEL_SEND_REFUSED', status: 403 });
        }
        if (state.mode === 'timeout') {
          await new Promise(() => {});
          throw new AppError('Unreachable', { code: 'CHANNEL_SEND_TRANSIENT', status: 503 });
        }
        if (state.mode === 'refuse') {
          throw new AppError('Fixture provider refuses this message', { code: 'CHANNEL_SEND_REFUSED', status: 422 });
        }
        if (state.mode === 'flaky' && state.flakyRemaining > 0) {
          state.flakyRemaining -= 1;
          throw new AppError('Fixture provider temporarily unavailable', { code: 'CHANNEL_SEND_TRANSIENT', status: 503 });
        }
        const existing = state.sentByKey.get(idempotencyKey);
        if (existing) return { providerMessageId: existing.providerMessageId };
        const providerMessageId = `wamid.fixture-${state.sentByKey.size + 1}`;
        state.sentByKey.set(idempotencyKey, { providerMessageId, message });
        return { providerMessageId };
      },
    },
    api,
  };
}

/** Headers a test client sends for a signed fixture body. One construction, shared with verification. */
export function fixtureWebhookHeaders(rawBody, secret, timestampSeconds) {
  return hmacWebhookHeaders(rawBody, secret, timestampSeconds);
}

/** Build one fixture event body. */
export function fixtureEventBody({ id, subject = 'chat-1', seq = null, at = null }) {
  return JSON.stringify({ id, subject, ...(seq === null ? {} : { seq }), ...(at === null ? {} : { at }) });
}
