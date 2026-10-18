// @ts-check

import { AppError, ValidationError } from '../../core/index.js';
import { verifyHmacWebhook } from './crypto.js';

/**
 * Gmail API channel adapter (backlog:2f621c1d81b0).
 *
 * The Presti Group mailbox on the shared channel base: inbound mail lands
 * in the right conversation, and a reply from the card stays in the same
 * Gmail thread — on the exact adapter contract, registries, inbox, outbox
 * and kit the channels package already ships.
 *
 * Fake-backed on purpose (owner decision MEM_ACC_DECISIONS: no Google
 * credentials exist yet, and none are invented here): the transport is a
 * programmable in-memory double with the same modes as the fixture
 * (`ok`, `flaky(n)`, `refuse`, `timeout`), and the Gmail REST mapping is a
 * pure function (`buildGmailSendRequest`) so the URL, auth scheme and body
 * shape are unit-proven without dialing Google. Inbound push bodies verify
 * with the shared channel HMAC scheme (`crypto.js`) — the scheme the fake
 * signs with, and the scheme the kit harness signs with. Google's own edge
 * (Pub/Sub push OIDC) lands with the Google decision, as a `verifyInbound`
 * variant: nothing here invents it, so a production composition
 * (`testOnly: false`) refuses every delivery rather than trusting one it
 * cannot prove.
 *
 * What the adapter owns (the Gmail policy, fail-closed):
 * - inbound: Gmail push notification shapes (`message.data` carrying one
 *   message with its Gmail `id` and `threadId`) normalized to a
 *   single-element list. The conversation IS the thread: the inbox subject
 *   is `email:<threadId>`, so every message of one thread shares one
 *   conversation and a reply sent with that thread id stays in it. The
 *   per-thread order is the provider instant (`internalDate`): a late
 *   redelivery of an older message of an already-advanced thread is
 *   ignored through the shared per-subject out-of-order rule, never
 *   applied twice. A delivery off our own mailbox (a sent copy looping
 *   back) normalizes to an empty subject and is quarantined as evidence,
 *   never mapped to a ghost customer.
 * - outbound: email has no service window, so there is no
 *   `outboundWindow` capability — a reply sends at any time. A message
 *   with `threadId` replies inside that thread (the card reads the thread
 *   back out of the inbox subject with `gmailThreadIdForSubject`); a
 *   message without one opens a new thread and the provider assigns it.
 */

export const GMAIL_ADAPTER_NAME = 'gmail-api';
export const GMAIL_ADAPTER_VERSION = 1;
/** The initial import window: threads of the last 90 days. */
export const GMAIL_HISTORY_WINDOW_MS = 90 * 24 * 3600 * 1000;

function encodeHistoryToken(index) {
  return Buffer.from(String(index), 'utf8').toString('base64url');
}

function decodeHistoryToken(pageToken) {
  if (pageToken === null || pageToken === undefined) return 0;
  let index = -1;
  try {
    index = Number.parseInt(Buffer.from(String(pageToken), 'base64url').toString('utf8'), 10);
  } catch {
    index = -1;
  }
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new AppError('Gmail history page token is not one this adapter issued', {
      code: 'CHANNEL_HISTORY_MALFORMED', status: 422,
    });
  }
  return index;
}
/** Inbox subjects carry the `email:` prefix, so threads stay namespaced per channel. */
export const GMAIL_SUBJECT_PREFIX = 'email:';
const MAX_ID = 256;
const MAX_ADDRESS = 256;
const MAX_SUBJECT_LINE = 256;
/** Email bodies run longer than chat bubbles but stay under the 32 KiB outbox bound. */
export const GMAIL_MAX_TEXT = 30000;
const ADDRESS = /^[a-z0-9._%+-]{1,64}@[a-z0-9](?:[a-z0-9.-]{0,253}[a-z0-9])?\.[a-z]{2,}$/;
const THREAD = /^[^\s\x00-\x1f\x7f:]{1,128}$/;

function malformedEvent(reason) {
  throw new AppError(`Gmail event is not well-formed: ${reason}`, {
    code: 'CHANNEL_EVENT_MALFORMED', status: 422,
  });
}

function malformedMessage(reason) {
  throw new AppError(`Gmail message is not well-formed: ${reason}`, {
    code: 'CHANNEL_MESSAGE_MALFORMED', status: 422,
  });
}

/** Canonical lowercase address. Refuses anything that is not a bounded email address. */
export function canonicalGmailAddress(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (text === '' || text.length > MAX_ADDRESS || !ADDRESS.test(text)) {
    throw new AppError('Gmail address must be a bounded email address', {
      code: 'CHANNEL_MESSAGE_MALFORMED', status: 422,
    });
  }
  return text;
}

function assertThreadId(value, what = 'thread id') {
  if (typeof value !== 'string' || !THREAD.test(value)) {
    malformedMessage(`message needs a bounded Gmail ${what} (1-128 chars, no whitespace)`);
  }
  return value;
}

/** The conversation subject for one Gmail thread: the thread, never the peer. */
export function gmailThreadSubject(threadId) {
  if (typeof threadId !== 'string' || !THREAD.test(threadId)) {
    throw new ValidationError('Gmail thread subject needs a bounded thread id (1-128 chars, no whitespace)', {
      field: 'threadId',
    });
  }
  return `${GMAIL_SUBJECT_PREFIX}${threadId}`;
}

/**
 * The thread id back out of an inbox subject, or null when the subject is
 * not an email-thread conversation. The card replies with this id, so the
 * reply stays in the thread the inbound opened.
 */
export function gmailThreadIdForSubject(subject) {
  if (typeof subject !== 'string' || !subject.startsWith(GMAIL_SUBJECT_PREFIX)) return null;
  const threadId = subject.slice(GMAIL_SUBJECT_PREFIX.length);
  return THREAD.test(threadId) ? threadId : null;
}

function toBase64Url(text) {
  return Buffer.from(text, 'utf8').toString('base64url');
}

function fromBase64Url(value) {
  if (typeof value !== 'string' || value === '' || value.length > 65536) {
    malformedEvent('push data is not bounded base64url text');
  }
  let raw;
  try {
    raw = Buffer.from(value, 'base64url').toString('utf8');
  } catch {
    malformedEvent('push data is not decodable base64url');
  }
  if (raw === '') malformedEvent('push data decodes to nothing');
  return raw;
}

/** Build one provider-native Gmail push body (tests only). */
export function gmailPushBody({
  id, threadId, from, to, subject = '', snippet = '',
  internalDateMs = null, historyId = 'history-fake-1', subscription = 'projects/presti/subscriptions/accordo-gmail',
  publishTime = null,
}) {
  const at = internalDateMs ?? Date.now();
  const data = toBase64Url(JSON.stringify({
    emailAddress: to,
    historyId,
    message: {
      id, threadId, from, to, subject, snippet, internalDateMs: at,
    },
  }));
  return JSON.stringify({
    message: {
      data,
      messageId: `pubsub-${id}`,
      publishTime: new Date(at).toISOString(),
      ...(publishTime === null ? {} : { publishTime }),
    },
    subscription,
  });
}

/** Normalize one Gmail message (the fake push payload) to the channel event shape. */
function normalizeGmailMessage(decoded, config) {
  const item = decoded && typeof decoded === 'object' && !Array.isArray(decoded)
    ? decoded.message && typeof decoded.message === 'object' ? decoded.message : null
    : null;
  if (!item) malformedEvent('push data carries no message');
  if (typeof item.id !== 'string' || item.id === '' || item.id.length > MAX_ID) {
    malformedEvent('message needs a bounded id');
  }
  if (typeof item.threadId !== 'string' || !THREAD.test(item.threadId)) {
    malformedEvent('message needs a bounded threadId');
  }
  let from;
  let to;
  try {
    from = canonicalGmailAddress(item.from);
    to = canonicalGmailAddress(item.to);
  } catch {
    malformedEvent('message needs valid sender and recipient addresses');
  }
  // Our own sent copy looping back is evidence, never a customer: no
  // subject, so the operations layer quarantines it.
  if (from === config.mailbox) {
    return { providerEventId: item.id, subject: '', sequence: null, occurredAt: null };
  }
  const atMs = item.internalDateMs;
  if (!Number.isSafeInteger(atMs) || atMs < 0 || atMs > 4102444800000) {
    malformedEvent('message needs a valid internalDateMs');
  }
  // No skew check here on purpose: the provider instant travels through
  // as `occurredAt` and `operations.js` quarantines a future-dated one
  // centrally (receive time + anomaly note), so it never becomes the
  // out-of-order sequence.
  return {
    providerEventId: item.id,
    subject: `${GMAIL_SUBJECT_PREFIX}${item.threadId}`,
    sequence: atMs,
    occurredAt: new Date(atMs).toISOString(),
  };
}

/** The kit's signed minimal dialect (test compositions only). */
function normalizeKitEvent(parsed) {
  const providerEventId = typeof parsed.id === 'string' ? parsed.id : '';
  const subject = typeof parsed.subject === 'string' ? parsed.subject : '';
  if (providerEventId === '' || providerEventId.length > MAX_ID
    || subject === '' || subject.length > MAX_ID) {
    malformedEvent('minimal event needs a bounded "id" and "subject"');
  }
  return {
    providerEventId,
    subject,
    sequence: Number.isSafeInteger(parsed.seq) ? parsed.seq : null,
    occurredAt: typeof parsed.at === 'string' ? parsed.at : null,
  };
}

/**
 * Normalize one outbound reply. Email has no service window: a reply sends
 * at any time. `threadId` keeps the reply in the thread the inbound opened
 * (the card reads it back out of the inbox subject); without one the
 * provider opens a new thread.
 */
function normalizeGmailOutbound(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    malformedMessage('message must be an object');
  }
  let to;
  try {
    to = canonicalGmailAddress(message.to);
  } catch {
    malformedMessage('message needs a bounded "to" address');
  }
  const text = typeof message.text === 'string' ? message.text : '';
  if (text === '' || text.length > GMAIL_MAX_TEXT) {
    malformedMessage(`message needs non-empty "text" (at most ${GMAIL_MAX_TEXT} chars)`);
  }
  const subjectLine = message.subject === undefined ? undefined
    : typeof message.subject === 'string' ? message.subject : null;
  if (subjectLine !== undefined && (subjectLine === null || subjectLine === ''
    || subjectLine.length > MAX_SUBJECT_LINE || /[\r\n]/.test(subjectLine))) {
    malformedMessage('message "subject" must be bounded single-line text when present');
  }
  const threadId = message.threadId === undefined ? undefined : assertThreadId(message.threadId);
  return threadId === undefined
    ? { to, text, ...(subjectLine === undefined ? {} : { subject: subjectLine }) }
    : { to, text, threadId, ...(subjectLine === undefined ? {} : { subject: subjectLine }) };
}

function mimeLines({ from, to, subjectLine, text }) {
  const lines = [`From: ${from}`, `To: ${to}`];
  if (subjectLine !== undefined) lines.push(`Subject: ${subjectLine}`);
  lines.push('Content-Type: text/plain; charset=utf-8', '', text);
  return lines.join('\r\n');
}

/**
 * The Gmail REST mapping as a pure function: URL, Bearer [REDACTED] from the
 * call-time secret (never stored), and the send body with the thread id for
 * replies. Unit-proven here; the fake records exactly this shape per send.
 */
export function buildGmailSendRequest({ message, config, secret }) {
  if (!message || typeof message !== 'object') {
    throw new AppError('Gmail send needs a normalized message', { code: 'CHANNEL_MESSAGE_MALFORMED', status: 422 });
  }
  if (typeof secret !== 'string' || secret === '') {
    throw new AppError('Gmail send needs the call-time secret', { code: 'CHANNEL_SECRET_UNAVAILABLE', status: 500 });
  }
  let to;
  try {
    to = canonicalGmailAddress(message.to);
  } catch {
    throw new AppError('Gmail send needs a bounded "to" address', { code: 'CHANNEL_MESSAGE_MALFORMED', status: 422 });
  }
  if (typeof message.text !== 'string' || message.text === '') {
    throw new AppError('Gmail send needs text', { code: 'CHANNEL_MESSAGE_MALFORMED', status: 422 });
  }
  const threadId = message.threadId === undefined ? undefined : message.threadId;
  if (threadId !== undefined && (typeof threadId !== 'string' || !THREAD.test(threadId))) {
    throw new AppError('Gmail send needs a bounded thread id when replying', { code: 'CHANNEL_MESSAGE_MALFORMED', status: 422 });
  }
  const raw = toBase64Url(mimeLines({
    from: config.mailbox,
    to,
    subjectLine: typeof message.subject === 'string' ? message.subject : undefined,
    text: message.text,
  }));
  return {
    method: 'POST',
    url: `${config.baseUrl}/gmail/v1/users/me/messages/send`,
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: threadId === undefined ? { raw } : { threadId, raw },
  };
}

function assertAdapterConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('Gmail adapter options must be a plain object', { field: 'config' });
  }
  const baseUrl = input.baseUrl === undefined ? 'https://gmail.googleapis.com' : input.baseUrl;
  if (typeof baseUrl !== 'string' || !/^https:\/\/[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(baseUrl)) {
    throw new ValidationError('Gmail adapter baseUrl must be a bounded https origin', { field: 'config.baseUrl' });
  }
  // The bound mailbox is required at composition: without it the sent-copy
  // quarantine cannot tell our own address from a customer, and a looped
  // delivery would land as a mailbox-as-customer ghost row.
  if (input.mailbox === undefined) {
    throw new ValidationError('Gmail adapter needs mailbox: the bound mailbox address the echo quarantine compares against', {
      field: 'config.mailbox',
    });
  }
  let mailbox;
  try {
    mailbox = canonicalGmailAddress(input.mailbox);
  } catch {
    throw new ValidationError('Gmail adapter mailbox must be a bounded email address', { field: 'config.mailbox' });
  }
  const testOnly = input.testOnly === undefined ? true : input.testOnly;
  if (typeof testOnly !== 'boolean') {
    throw new ValidationError('Gmail adapter testOnly must be a boolean', { field: 'config.testOnly' });
  }
  return Object.freeze({ mailbox, baseUrl, testOnly });
}

/**
 * Build the fake-backed Gmail adapter: `{ definition, api }` in the
 * fixture's shape, so the kit harness drives it unchanged. `secret` is the
 * declared test-only value the double expects; production resolves the
 * real OAuth token through the same `resolveSecret` edge.
 *
 * @param {{
 *   secret?: string, mailbox?: string, baseUrl?: string, testOnly?: boolean,
 * }} options `mailbox` is the bound Presti Group address: the kit/self-test
 * loopback address.
 */
export function createGmailChannelAdapter(options = {}) {
  const expectedSecret = typeof options.secret === 'string' && options.secret !== ''
    ? options.secret : 'gmail-fake-secret';
  const config = assertAdapterConfig(options);
  const state = {
    mode: 'ok',
    flakyRemaining: 0,
    /** @type {Map<string, {providerMessageId: string, request: any}>} */
    sentByKey: new Map(),
    sendCalls: 0,
    /** @type {Array<{id: string, threadId: string, from: string, to?: string, subject?: string, internalDateMs: number}>} */
    mailboxHistory: [],
  };

  const api = {
    state,
    /** @param {'ok'|'refuse'|'timeout'} mode @param {number} [flakyFailures] */
    setMode(mode, flakyFailures = 0) {
      state.mode = mode;
      state.flakyRemaining = flakyFailures;
    },
    reset() {
      // Transport state only: the seeded provider past is fixture data, and
      // re-seeding replaces it. A mid-run reset (the kit resets before its
      // send check) must never wipe the past the history check pages.
      state.mode = 'ok';
      state.flakyRemaining = 0;
      state.sentByKey.clear();
      state.sendCalls = 0;
    },
    sentMessages() {
      return [...state.sentByKey.values()].map((entry) => entry.request.body);
    },
    sentRequests() {
      return [...state.sentByKey.values()].map((entry) => entry.request);
    },
    /**
     * Seed the fake mailbox the import pages through: provider messages
     * (`{ id, threadId, from, to?, subject?, internalDateMs }`). Each seed
     * normalizes through the same `normalizeGmailMessage` the push path
     * uses, so a bad seed fails the test setup, never the import.
     * @param {Array<any>} messages
     */
    seedMailbox(messages) {
      const seeds = Array.isArray(messages) ? messages : [];
      state.mailboxHistory.length = 0;
      for (const item of seeds) {
        const atMs = item?.internalDateMs;
        if (!Number.isSafeInteger(atMs) || atMs < 0 || atMs > 4102444800000) {
          malformedEvent('seeded message needs a valid internalDateMs');
        }
        const normalized = normalizeGmailMessage({
          message: {
            id: item?.id,
            threadId: item?.threadId,
            from: item?.from,
            to: item?.to ?? config.mailbox,
            subject: item?.subject ?? '',
            snippet: '',
            internalDateMs: atMs,
          },
        }, config);
        // A sent copy looping back carries no subject, so the import
        // quarantines it exactly like the push path does — with its
        // provider time, so the window keeps it instead of dropping it.
        const event = normalized.subject === ''
          ? { ...normalized, occurredAt: new Date(atMs).toISOString() }
          : normalized;
        state.mailboxHistory.push({ normalized: event, from: canonicalGmailAddress(item?.from) });
      }
    },
  };

  return {
    definition: {
      name: options.name ?? GMAIL_ADAPTER_NAME,
      version: GMAIL_ADAPTER_VERSION,
      label: 'Gmail API (fake-backed)',
      channel: 'email',
      config: {
        mailbox: config.mailbox,
        baseUrl: config.baseUrl,
        testOnly: config.testOnly,
      },

      verifyInbound({ rawBody, headers, secret }) {
        // The channel HMAC scheme the fake signs with — the same primitive
        // and headers the kit harness uses. Production Pub/Sub push OIDC
        // arrives with the Google credential decision, as a variant of this
        // function: until then a production composition refuses every
        // delivery rather than trusting one it cannot prove.
        if (!config.testOnly) return { ok: false };
        const signature = headers?.['x-channel-signature-256'];
        const timestamp = headers?.['x-channel-timestamp'];
        const ok = verifyHmacWebhook({ rawBody, signature, timestamp, secret });
        if (!ok) return { ok: false };
        return { ok: true, event: Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody ?? '') };
      },

      /**
       * Normalize one verified push body to a single-element LIST of
       * channel events. The ingest stores one inbox row per event, so the
       * conversation subject (`email:<threadId>`) is the thread the reply
       * path reads back.
       */
      normalizeInbound(event) {
        let parsed;
        try {
          parsed = JSON.parse(String(event));
        } catch {
          malformedEvent('event is not JSON');
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          malformedEvent('event is not an object');
        }
        if (parsed.message && typeof parsed.message === 'object'
          && typeof parsed.message.data === 'string') {
          let decoded;
          try {
            decoded = JSON.parse(fromBase64Url(parsed.message.data));
          } catch {
            malformedEvent('push data is not a Gmail notification');
          }
          return [normalizeGmailMessage(decoded, config)];
        }
        if (config.testOnly) return [normalizeKitEvent(parsed)];
        malformedEvent('only Gmail push notifications are accepted');
      },

      historyImport: {
        windowMs: GMAIL_HISTORY_WINDOW_MS,
        /**
         * Page the seeded mailbox oldest-first: threads of the last 90
         * days, one normalized event per message with its sender attached.
         * The fake serves its single bound mailbox; production lists the
         * OAuth mailbox the call-time secret names, through the same
         * `resolveSecret` edge the import uses.
         */
        async listHistory({ secret, since, pageToken, limit }) {
          if (secret !== expectedSecret) {
            throw new AppError('Gmail history refuses this secret', { code: 'CHANNEL_HISTORY_REFUSED', status: 403 });
          }
          const start = decodeHistoryToken(pageToken);
          const from = Date.parse(since);
          const past = state.mailboxHistory
            .filter((entry) => Date.parse(entry.normalized.occurredAt ?? '') >= from)
            .sort((a, b) => {
              const atA = a.normalized.occurredAt ?? '';
              const atB = b.normalized.occurredAt ?? '';
              if (atA !== atB) return atA < atB ? -1 : 1;
              return a.normalized.providerEventId < b.normalized.providerEventId ? -1 : 1;
            });
          const size = Number.isSafeInteger(limit) && limit > 0 ? limit : past.length;
          const slice = past.slice(start, start + size);
          const next = start + size < past.length ? encodeHistoryToken(start + size) : null;
          return {
            events: slice.map((entry) => ({ ...entry.normalized, sender: { handle: entry.from } })),
            nextPageToken: next,
          };
        },
      },

      normalizeOutbound(message) {
        return normalizeGmailOutbound(message);
      },

      async sendOutbound({ message, secret, idempotencyKey }) {
        state.sendCalls += 1;
        if (secret !== expectedSecret) {
          throw new AppError('Gmail secret mismatch', { code: 'CHANNEL_SEND_REFUSED', status: 403 });
        }
        if (state.mode === 'timeout') {
          await new Promise(() => {});
          throw new AppError('Unreachable', { code: 'CHANNEL_SEND_TRANSIENT', status: 503 });
        }
        if (state.mode === 'refuse') {
          throw new AppError('Gmail provider refuses this message', { code: 'CHANNEL_SEND_REFUSED', status: 422 });
        }
        if (state.mode === 'flaky' && state.flakyRemaining > 0) {
          state.flakyRemaining -= 1;
          throw new AppError('Gmail provider temporarily unavailable', { code: 'CHANNEL_SEND_TRANSIENT', status: 503 });
        }
        const existing = state.sentByKey.get(idempotencyKey);
        if (existing) return { providerMessageId: existing.providerMessageId };
        const request = buildGmailSendRequest({
          message,
          config: { mailbox: config.mailbox, baseUrl: config.baseUrl },
          secret,
        });
        const providerMessageId = `gmailmsg.fake-${state.sentByKey.size + 1}`;
        // The Bearer [REDACTED] is call-time only: the retained copy keeps the
        // wire shape minus the secret, so no dump of sentRequests() leaks it.
        const { Authorization: _withheld, ...publicHeaders } = request.headers;
        void _withheld;
        state.sentByKey.set(idempotencyKey, {
          providerMessageId,
          request: { method: request.method, url: request.url, headers: publicHeaders, body: request.body },
        });
        return { providerMessageId };
      },
    },
    api,
  };
}
