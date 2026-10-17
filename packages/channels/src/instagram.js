// @ts-check

import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError } from '../../core/index.js';
import { verifyHmacWebhook } from './crypto.js';

/**
 * Instagram (Meta Graph) channel adapter (backlog:8e7f99e7).
 *
 * The first provider-shaped adapter on the common channel base: inbound
 * Meta Graph webhooks, replies through the Graph send shape, and the
 * 24-hour reply-window rule — verified and normalized through the same
 * five functions every adapter implements, so the kit in `kit.js` drives
 * it like the fixture.
 *
 * Two inbound dialects, both HMAC-authenticated before parsing:
 *
 * - provider-native: the Graph webhook body (`object: 'instagram'` with
 *   `entry[].messaging[]`), verified against `x-hub-signature-256`
 *   (`sha256=<hex hmac of the raw body>`, Meta's scheme). This is the
 *   only dialect a production composition (`testOnly: false`) accepts.
 * - kit interop: the signed minimal event (`{id, subject, seq?, at?}`)
 *   the channel kit speaks, verified against the fixture timestamp
 *   scheme. Accepted only when `config.testOnly` is true — a
 *   production adapter refuses it like any other malformed event.
 *
 * The reply window (Meta's rule, enforced before the provider): a
 * standard reply needs an inbound from the same user within the last
 * 24 hours; a `HUMAN_AGENT`-tagged reply within the last 7 days. The
 * adapter feeds that memory from every Graph inbound it normalizes, so
 * the rule reads what the provider actually delivered, never a second
 * clock. Sends to the bound page account itself are the kit/self-test
 * loopback and bypass the window only while `testOnly` is true.
 *
 * Real credentials do not exist yet (owner decision MEM_ACC_DECISIONS):
 * delivery runs against the injected fake transport — the same
 * programmable failure modes as the fixture (`ok`, `flaky(n)`,
 * `refuse`, `timeout`) — never against Meta.
 */

export const INSTAGRAM_ADAPTER_NAME = 'instagram-graph';
export const INSTAGRAM_ADAPTER_VERSION = 1;
export const INSTAGRAM_HUMAN_AGENT_TAG = 'HUMAN_AGENT';
/** Standard replies ride the 24-hour window after the user's message. */
export const INSTAGRAM_REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Human-agent-tagged replies ride 7 days (the provider enforces the rest). */
export const INSTAGRAM_TAG_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ID = 256;
const MAX_TEXT = 4096;
const HUB_SIGNATURE_HEADER = 'x-hub-signature-256';
/** Inbox subjects carry the `ig:` prefix, so senders stay 3 chars shorter. */
const SUBJECT_PREFIX = 'ig:';
const MAX_SENDER = MAX_ID - SUBJECT_PREFIX.length;

function malformed(reason) {
  throw new AppError(`Instagram event is not well-formed: ${reason}`, {
    code: 'CHANNEL_EVENT_MALFORMED', status: 422,
  });
}

function malformedMessage(reason) {
  throw new AppError(`Instagram message is not well-formed: ${reason}`, {
    code: 'CHANNEL_MESSAGE_MALFORMED', status: 422,
  });
}

/** Constant-time check of Meta's `sha256=<hex>` hub signature over the raw body. */
function verifyHubSignature(rawBody, signature, secret) {
  if (typeof secret !== 'string' || secret === '') return false;
  if (typeof signature !== 'string' || !signature.startsWith('sha256=')) return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody ?? ''), 'utf8');
  let expected;
  try {
    expected = createHmac('sha256', secret).update(body).digest();
  } catch {
    return false;
  }
  let provided;
  try {
    provided = Buffer.from(signature.slice('sha256='.length), 'hex');
  } catch {
    return false;
  }
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

/** Headers a fake Graph client sends for a signed body (tests only). */
export function instagramWebhookHeaders(rawBody, secret) {
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
  return {
    [HUB_SIGNATURE_HEADER]: `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
  };
}

/** Build one provider-native Graph webhook body (tests only). */
export function instagramEventBody({ mid, sender = 'ig-user-1', recipient = 'ig-page-1', text = 'Ciao', timestampMs = null }) {
  return JSON.stringify({
    object: 'instagram',
    entry: [{
      id: recipient,
      time: Math.floor((timestampMs ?? Date.now()) / 1000),
      messaging: [{
        sender: { id: sender },
        recipient: { id: recipient },
        timestamp: timestampMs ?? Date.now(),
        message: { mid, text },
      }],
    }],
  });
}

function isCanonicalInstant(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
    && new Date(value).toISOString() === value;
}

/**
 * @param {{
 *   secret?: string, pageId?: string, testOnly?: boolean,
 *   nowMs?: () => number,
 * }} options `secret` is the expected fixture value the fake transport
 * shares (never stored — compared in memory at send time, like the
 * fixture). `pageId` is the bound Instagram account: the kit/self-test
 * loopback address. `nowMs` is injectable for window tests.
 */
export function createInstagramChannelAdapter(options = {}) {
  const expectedSecret = options.secret ?? 'instagram-fixture-secret';
  const pageId = options.pageId ?? 'ig-page-fake';
  const testOnly = options.testOnly ?? true;
  const nowMs = typeof options.nowMs === 'function' ? options.nowMs : () => Date.now();
  /** Recipient user id -> ms of their latest inbound (the window memory). */
  const lastInboundMs = new Map();
  const state = {
    mode: 'ok',
    flakyRemaining: 0,
    /** @type {Map<string, {providerMessageId: string, message: any}>} */
    sentByKey: new Map(),
    sendCalls: 0,
    lastInboundMs,
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
    lastInboundOf(recipient) {
      return state.lastInboundMs.get(recipient) ?? null;
    },
  };

  /** Normalize one Graph messaging event; feeds the window memory. */
  function normalizeGraphEvent(messaging) {
    const item = messaging && typeof messaging === 'object' ? messaging : null;
    const senderId = item?.sender?.id;
    const recipientId = item?.recipient?.id;
    const mid = item?.message?.mid;
    const text = item?.message?.text;
    const stamp = item?.timestamp;
    if (typeof senderId !== 'string' || senderId === '' || senderId.length > MAX_SENDER) {
      malformed(`sender id must be non-empty text (at most ${MAX_SENDER} characters, so the subject fits 256)`);
    }
    if (typeof recipientId !== 'string' || recipientId === '' || recipientId.length > MAX_ID) {
      malformed('recipient id must be non-empty text (at most 256 characters)');
    }
    if (typeof mid !== 'string' || mid === '' || mid.length > MAX_ID) {
      malformed('message id must be non-empty text (at most 256 characters)');
    }
    if (typeof text !== 'string' || text === '' || text.length > MAX_TEXT) {
      malformed('message text must be non-empty text (at most 4096 characters)');
    }
    if (!Number.isSafeInteger(stamp)) malformed('timestamp must be an integer');
    // Graph stamps messaging events in milliseconds; accept seconds too.
    const atMs = stamp < 1e12 ? stamp * 1000 : stamp;
    state.lastInboundMs.set(senderId, atMs);
    return {
      providerEventId: mid,
      subject: `${SUBJECT_PREFIX}${senderId}`,
      sequence: null,
      occurredAt: new Date(atMs).toISOString(),
      from: senderId,
      to: recipientId,
      text,
    };
  }

  /** The kit's signed minimal dialect (test compositions only). */
  function normalizeKitEvent(parsed) {
    const providerEventId = typeof parsed.id === 'string' ? parsed.id : '';
    const subject = typeof parsed.subject === 'string' ? parsed.subject : '';
    if (providerEventId === '' || providerEventId.length > MAX_ID || subject === '' || subject.length > MAX_ID) {
      malformed('minimal event needs a bounded "id" and "subject"');
    }
    return {
      providerEventId,
      subject,
      sequence: Number.isSafeInteger(parsed.seq) ? parsed.seq : null,
      occurredAt: isCanonicalInstant(parsed.at) ? parsed.at : null,
    };
  }

  return {
    definition: {
      name: INSTAGRAM_ADAPTER_NAME,
      version: INSTAGRAM_ADAPTER_VERSION,
      label: 'Instagram Graph',
      channel: 'instagram',
      config: { testOnly, pageId },

      verifyInbound({ rawBody, headers, secret }) {
        if (verifyHubSignature(rawBody, headers?.[HUB_SIGNATURE_HEADER], secret)) {
          return { ok: true, event: Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody ?? '') };
        }
        // The kit drives the adapter through the fixture's signed scheme;
        // production never reaches this branch (testOnly false refuses).
        if (testOnly) {
          const signature = headers?.['x-channel-signature-256'];
          const timestamp = headers?.['x-channel-timestamp'];
          // verifyHmacWebhook closes over the caller clock: hub-less kit
          // bodies stay valid for the same 5-minute tolerance as the fixture.
          if (verifyHmacWebhook({ rawBody, signature, timestamp, secret })) {
            return { ok: true, event: Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody ?? '') };
          }
        }
        return { ok: false };
      },

      normalizeInbound(event) {
        let parsed;
        try {
          parsed = JSON.parse(String(event));
        } catch {
          malformed('event is not JSON');
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          malformed('event is not an object');
        }
        if (Array.isArray(parsed.entry)) {
          if (parsed.object !== undefined && parsed.object !== 'instagram') {
            malformed(`unexpected webhook object "${String(parsed.object).slice(0, 64)}"`);
          }
          for (const entry of parsed.entry) {
            const messaging = Array.isArray(entry?.messaging) ? entry.messaging : [];
            for (const item of messaging) {
              if (item && typeof item === 'object' && item.message && typeof item.message === 'object'
                && typeof item.message.text === 'string') {
                return normalizeGraphEvent(item);
              }
            }
          }
          malformed('no text message in this webhook delivery (receipts, echoes and attachments stay out of the inbox)');
        }
        if (testOnly) return normalizeKitEvent(parsed);
        malformed('only Graph webhook deliveries are accepted');
      },

      normalizeOutbound(message) {
        if (!message || typeof message !== 'object' || Array.isArray(message)) {
          malformedMessage('message must be an object');
        }
        const to = typeof message.to === 'string' ? message.to.trim() : '';
        const text = typeof message.text === 'string' ? message.text : '';
        if (to === '' || to.length > MAX_ID || text === '' || text.length > MAX_TEXT) {
          malformedMessage('message needs a bounded "to" and non-empty "text" (at most 4096 chars)');
        }
        const tag = message.tag;
        if (tag !== undefined && tag !== INSTAGRAM_HUMAN_AGENT_TAG) {
          malformedMessage(`message tag must be "${INSTAGRAM_HUMAN_AGENT_TAG}" when present`);
        }
        return tag === undefined ? { to, text } : { to, text, tag };
      },

      async sendOutbound({ message, secret, idempotencyKey }) {
        state.sendCalls += 1;
        if (secret !== expectedSecret) {
          throw new AppError('Instagram secret mismatch', { code: 'CHANNEL_SEND_REFUSED', status: 403 });
        }
        if (state.mode === 'timeout') {
          await new Promise(() => {});
          throw new AppError('Unreachable', { code: 'CHANNEL_SEND_TRANSIENT', status: 503 });
        }
        const to = message?.to;
        const tagged = message?.tag === INSTAGRAM_HUMAN_AGENT_TAG;
        const loopback = testOnly && to === pageId;
        if (!loopback) {
          const last = state.lastInboundMs.get(to) ?? null;
          const bound = tagged ? INSTAGRAM_TAG_WINDOW_MS : INSTAGRAM_REPLY_WINDOW_MS;
          if (last === null || nowMs() - last > bound) {
            throw new AppError(
              last === null
                ? 'Instagram reply window is closed: no inbound from this user (reply only after they write, or tag HUMAN_AGENT)'
                : 'Instagram reply window is closed: the last inbound is older than the reply window',
              { code: 'CHANNEL_WINDOW_CLOSED', status: 403 },
            );
          }
        }
        if (state.mode === 'refuse') {
          throw new AppError('Instagram provider refuses this message', { code: 'CHANNEL_SEND_REFUSED', status: 422 });
        }
        if (state.mode === 'flaky' && state.flakyRemaining > 0) {
          state.flakyRemaining -= 1;
          throw new AppError('Instagram provider temporarily unavailable', { code: 'CHANNEL_SEND_TRANSIENT', status: 503 });
        }
        const existing = state.sentByKey.get(idempotencyKey);
        if (existing) return { providerMessageId: existing.providerMessageId };
        const providerMessageId = `igmid.fake-${state.sentByKey.size + 1}`;
        state.sentByKey.set(idempotencyKey, { providerMessageId, message });
        return { providerMessageId };
      },
    },
    api,
  };
}
