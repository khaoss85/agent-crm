// @ts-check

import { createHmac } from 'node:crypto';
import { AppError } from '../../core/index.js';
import { verifyHmacWebhook } from './crypto.js';
// Batch iteration, echo detection, the window rule and the hub-signature
// check live once in the shared Meta module every Meta adapter delegates
// to (backlog:87d4769dde7e, backlog:23d5b455cb3a).
import {
  META_CUSTOMER_SERVICE_WINDOW_MS,
  checkMetaServiceWindow,
  isMetaSelfEcho,
  iterateMetaBatchItems,
  normalizeGraphMessageContent,
  parseMetaWebhookBody,
  verifyMetaHubSignature,
} from './meta-webhook.js';

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
 * One delivery normalizes to a LIST of channel events — one per message
 * of every entry, in document order (one per attachment when a message
 * carries several, so no photo is truncated to the first) — so a batched
 * Graph webhook stores one inbox row per message and never drops one (the
 * same list path the WhatsApp adapter uses; `operations.js` stores the
 * rows in a single transaction with dedup per providerEventId). Text and
 * attachments ride on the message event — the inbox keeps the envelope
 * only. Echoes off our own account, read receipts and items without a
 * message id stay out of the list.
 * Provider time is never trusted here: a skewed or forged instant travels
 * through as `occurredAt` and `operations.js` quarantines it centrally
 * (receive time + anomaly note), so it never becomes the window
 * observation nor the sequence.
 *
 * The reply window (Meta's rule, enforced at queue time before the
 * provider): a standard reply needs an inbound from the same user within
 * the last 24 hours; a `HUMAN_AGENT`-tagged reply within the last 7 days.
 * The window reads what the provider actually delivered, per space and
 * connection: operations resolves the latest applied inbox instant for the
 * recipient's conversation and hands it to `normalizeOutbound` as
 * `{ lastInboundAt }` — a caller-supplied instant is never trusted, and
 * the adapter keeps no per-user memory of its own (one space can never
 * send on another space's consent, one page never on another page's).
 * Without an observed inbound the reply refuses with
 * CHANNEL_TEMPLATE_REQUIRED, intact through the real queue path like the
 * WhatsApp adapter. Sends to the bound page itself are ordinary
 * recipients: the old test-only loopback bypass is gone.
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
export const INSTAGRAM_REPLY_WINDOW_MS = META_CUSTOMER_SERVICE_WINDOW_MS;
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

/** Headers a fake Graph client sends for a signed body (tests only). */
export function instagramWebhookHeaders(rawBody, secret) {
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
  return {
    [HUB_SIGNATURE_HEADER]: `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
  };
}

/** Build one provider-native Graph webhook body (tests only). */
export function instagramEventBody({
  mid, sender = 'ig-user-1', recipient = 'ig-page-1', text = 'Ciao', timestampMs = null,
  echo = false, extra = [], attachments = undefined,
}) {
  return JSON.stringify({
    object: 'instagram',
    entry: [{
      id: recipient,
      time: Math.floor((timestampMs ?? Date.now()) / 1000),
      messaging: [{
        sender: { id: sender },
        recipient: { id: recipient },
        timestamp: timestampMs ?? Date.now(),
        ...(echo ? { is_echo: true } : {}),
        message: { mid, text, ...(attachments === undefined ? {} : { attachments }) },
      }, ...extra],
    }],
  });
}

/**
 * Outside the window the reply refuses fail-closed with the shared
 * window code, intact through the queue path like the WhatsApp adapter:
 * no inbound, no send. There is no template fallback on Instagram — the
 * caller waits for the next customer message instead.
 */
function templateRequired() {
  throw new AppError('Instagram reply is outside the window: reply within 24 hours of their message (7 days with the HUMAN_AGENT tag)', {
    code: 'CHANNEL_TEMPLATE_REQUIRED', status: 422,
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
  // The adapter keeps no per-user window memory: the reply window reads the
  // persisted inbox per (space, connection) through the `outboundWindow`
  // capability below, so one space can never send on another's consent.
  const state = {
    mode: 'ok',
    flakyRemaining: 0,
    /** @type {Map<string, {providerMessageId: string, message: any}>} */
    sentByKey: new Map(),
    sendCalls: 0,
    seedCounter: 0,
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
      state.seedCounter = 0;
    },
    sentMessages() {
      return [...state.sentByKey.values()].map((entry) => entry.message);
    },
  };

  /**
   * Normalize one Graph messaging item to a LIST of channel events
   * (backlog:32820692): one per attachment, so a two-photo message stores
   * two rows and the card shows both — never a first-only truncation. A
   * message with zero or one attachment keeps its bare message id (stable
   * with every key stored before attachments existed); of several
   * attachments the first keeps the bare id and later siblings derive
   * stable (`<mid>:a<index>`) ids, so a retry replays the same rows
   * instead of conflicting. The caption rides on every sibling.
   */
  function normalizeGraphEvents(messaging) {
    const item = messaging && typeof messaging === 'object' ? messaging : null;
    const senderId = item?.sender?.id;
    const recipientId = item?.recipient?.id;
    const mid = item?.message?.mid;
    const rawText = item?.message?.text;
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
    if (rawText !== undefined && (typeof rawText !== 'string' || rawText.length > MAX_TEXT)) {
      malformed('message text must be text (at most 4096 characters)');
    }
    if (!Number.isSafeInteger(stamp)) malformed('timestamp must be an integer');
    // Graph stamps messaging events in milliseconds; accept seconds too.
    const atMs = stamp < 1e12 ? stamp * 1000 : stamp;
    // No skew check here on purpose: the provider instant travels through
    // as `occurredAt` and `operations.js` quarantines a future-dated one
    // centrally (receive time + anomaly note), so one forged delivery can
    // never hold the window open nor poison the sequence.
    const content = normalizeGraphMessageContent(item?.message ?? {}, 'Instagram');
    const text = content.text;
    if (typeof text !== 'string' || text.length > MAX_TEXT) {
      malformed('message text must be text (at most 4096 characters)');
    }
    const base = {
      subject: `${SUBJECT_PREFIX}${senderId}`,
      sequence: null,
      occurredAt: new Date(atMs).toISOString(),
      from: senderId,
      to: recipientId,
      text,
    };
    if (content.attachments.length <= 1) {
      return [{ providerEventId: mid, ...base, attachment: content.attachments[0] ?? null }];
    }
    // The first sibling keeps the bare message id (backlog:32820692): it is
    // the identity every row stored before attachments existed carries, so a
    // redelivery of a previously ingested message replays or conflicts on
    // the same row instead of silently doubling the timeline. Later siblings
    // derive stable `<mid>:a<index>` ids, so a retry replays the same rows.
    return content.attachments.map((attachment, index) => ({
      providerEventId: index === 0 ? mid : `${mid}:a${index}`,
      ...base,
      attachment,
    }));
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
        if (verifyMetaHubSignature(rawBody, headers?.[HUB_SIGNATURE_HEADER], secret)) {
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

      /**
       * Normalize one verified webhook body to a LIST of channel events,
       * one per message of every entry in document order — the same list
       * path the WhatsApp adapter uses. The ingest stores one inbox row
       * per event in a single transaction, so a batched Graph delivery
       * never loses a message. Echoes off our own account, read receipts
       * and items without a message id stay out of the list; a delivery
       * with nothing listable refuses as malformed and writes nothing.
       */
      normalizeInbound(event) {
        const parsed = parseMetaWebhookBody(event, 'Instagram');
        if (Array.isArray(parsed.entry)) {
          if (parsed.object !== undefined && parsed.object !== 'instagram') {
            malformed(`unexpected webhook object "${String(parsed.object).slice(0, 64)}"`);
          }
          const candidates = [];
          // Batch iteration and echo detection are the shared Meta rule:
          // every messaging item of every entry in document order, minus
          // our own account's echoes (the is_echo flag).
          for (const { dialect, item } of iterateMetaBatchItems(parsed)) {
            if (dialect !== 'graph') continue;
            if (isMetaSelfEcho(item, pageId)) continue;
            if (item.read && typeof item.read === 'object') continue;
            const message = item.message && typeof item.message === 'object' ? item.message : null;
            if (!message || typeof message.mid !== 'string' || message.mid === '') continue;
            candidates.push(item);
          }
          if (candidates.length === 0) {
            malformed('no message in this webhook delivery (receipts and echoes stay out of the inbox)');
          }
          return candidates.flatMap((item) => normalizeGraphEvents(item));
        }
        if (testOnly) return [normalizeKitEvent(parsed)];
        malformed('only Graph webhook deliveries are accepted');
      },

      /**
       * Normalize one outbound reply and enforce the window policy. Free
       * text needs the conversation inside the window; a HUMAN_AGENT tag
       * rides 7 days instead of 24 hours.
       *
       * The window observation is never caller time:
       * `message.lastInboundAt` is not read at all. On the real path
       * operations resolves the last inbound server-side from the inbox
       * and hands it in as `{ lastInboundAt }`; direct calls (unit tests)
       * pass the observation the same way. An absent, non-canonical,
       * future or stale observation refuses fail-closed with the shared
       * CHANNEL_TEMPLATE_REQUIRED code.
       */
      normalizeOutbound(message, windowCtx) {
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
        const bound = tag === INSTAGRAM_HUMAN_AGENT_TAG ? INSTAGRAM_TAG_WINDOW_MS : INSTAGRAM_REPLY_WINDOW_MS;
        const observed = windowCtx && typeof windowCtx === 'object' ? windowCtx.lastInboundAt : undefined;
        // The window verdict is the shared Meta rule (missing/future/stale
        // refuse with CHANNEL_TEMPLATE_REQUIRED, a non-canonical
        // observation is malformed). No skew here on purpose: a
        // future-dated provider instant travels through as data and the
        // ingest path quarantines it centrally instead.
        const verdict = checkMetaServiceWindow(observed, { nowMs, windowMs: bound, skewMs: 0 });
        if (verdict === 'missing' || verdict === 'future' || verdict === 'stale') templateRequired();
        if (verdict === 'invalid') {
          malformedMessage('"lastInboundAt" must be a canonical ISO-8601 instant');
        }
        return tag === undefined ? { to, text } : { to, text, tag };
      },

      /**
       * The service-window capability the shared contract allows: the
       * conversation subject for one recipient, a seedable windowed
       * inbound for the kit, and the customer-message predicate that
       * keeps non-customer rows out of the window observation.
       */
      outboundWindow: {
        windowMs: INSTAGRAM_REPLY_WINDOW_MS,
        subjectForRecipient(to) {
          if (typeof to !== 'string' || to === '') {
            throw new AppError('Instagram recipient must be non-empty text', {
              code: 'CHANNEL_MESSAGE_MALFORMED', status: 422,
            });
          }
          return `${SUBJECT_PREFIX}${to}`;
        },
        seedInbound({ from } = {}) {
          if (typeof from !== 'string' || from === '') {
            throw new AppError('Instagram seed needs a sender', {
              code: 'CHANNEL_MESSAGE_MALFORMED', status: 422,
            });
          }
          state.seedCounter += 1;
          return instagramEventBody({
            mid: `ig-window-seed-${state.seedCounter}`,
            sender: from,
            recipient: pageId,
            text: 'kit window seed',
            timestampMs: nowMs(),
          });
        },
        isObservation(row) {
          return typeof row?.providerEventId === 'string' && row.providerEventId !== ''
            && typeof row?.subject === 'string' && row.subject.startsWith(SUBJECT_PREFIX);
        },
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
        // No window check here: the window is enforced at queue time in
        // normalizeOutbound against the inbox observation. The transport
        // only proves delivery, refusal and retry modes.
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
