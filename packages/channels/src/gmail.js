// @ts-check

import { AppError, ValidationError } from '../../core/index.js';
import { verifyHmacWebhook } from './crypto.js';
import { createGmailHttpIo } from './gmail-http.js';
import { assertChannelAttachment } from './meta-webhook.js';

/**
 * Gmail API channel adapter (backlog:2f621c1d81b0).
 *
 * The space's linked mailbox on the shared channel base: inbound mail lands
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

/**
 * Bulk-mail signals (backlog:13c09f03): mass mail never names a customer,
 * so it quarantines as evidence instead of resolving a contact. Every
 * table below is closed vocabulary — an unknown value is simply not bulk.
 */

/** Local parts that mark a sender as automated, never a person. */
export const GMAIL_BULK_SENDER_LOCALS = Object.freeze([
  'no-reply', 'noreply', 'donotreply', 'do-not-reply',
  'notifications', 'notification', 'notify',
  'mailer-daemon', 'postmaster',
]);

/** Precedence header values that mark a message as mass mail. */
export const GMAIL_BULK_PRECEDENCE = Object.freeze(['bulk', 'list', 'junk']);

/**
 * Bulk-infrastructure domains: mail from these is platform traffic, never
 * a person writing. Bare domains match their subdomains too
 * (`newsletter.example` covers `a.newsletter.example`). Kept tight on
 * purpose — an unknown sender domain is a person until proven otherwise.
 */
export const GMAIL_NOTIFICATION_DOMAINS = Object.freeze([
  'amazonses.com',
  'sendgrid.net',
  'mandrillapp.com',
  'mailchimp.com',
  'list-manage.com',
  'campaign-archive.com',
  'constantcontact.com',
  'mailgun.org',
  'hubspotemail.net',
  'mktomail.com',
  'cmail20.com',
]);

/**
 * Whether one Gmail message is mass mail. Pure and total: every signal is
 * optional, an unreadable signal is simply not bulk, and no address ever
 * leaves this function — the caller keeps only the boolean.
 * @param {{from?: unknown, listUnsubscribe?: unknown, precedence?: unknown}} input
 */
export function isBulkGmailMessage(input = {}) {
  const listUnsubscribe = typeof input?.listUnsubscribe === 'string' ? input.listUnsubscribe.trim() : '';
  if (listUnsubscribe !== '') return true;
  const precedence = typeof input?.precedence === 'string' ? input.precedence.trim().toLowerCase() : '';
  if (GMAIL_BULK_PRECEDENCE.includes(precedence)) return true;
  const from = typeof input?.from === 'string' ? input.from.trim().toLowerCase() : '';
  const at = from.lastIndexOf('@');
  if (at <= 0 || at === from.length - 1) return false;
  const local = from.slice(0, at);
  if (GMAIL_BULK_SENDER_LOCALS.includes(local)) return true;
  const domain = from.slice(at + 1);
  return GMAIL_NOTIFICATION_DOMAINS.some((entry) => domain === entry || domain.endsWith(`.${entry}`));
}

/**
 * The `google-sync` log line both readers share the shape of: counts only,
 * never an address — a contact created from mail must not leak into logs.
 * @param {{source?: unknown, created?: unknown}} input
 */
export function formatGoogleSyncLog(input = {}) {
  const source = input?.source === 'calendar' ? 'calendar' : 'gmail';
  const created = Number.isSafeInteger(input?.created) && input.created >= 0 ? input.created : 0;
  return `google-sync created=${created} source=${source}`;
}

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

/**
 * Split a display name into first/last: the first token names, the rest
 * describes. Bounded to the sender-evidence limits; longer text truncates
 * instead of refusing the whole message over a cosmetic field.
 * @param {string} name
 */
export function splitGmailDisplayName(name) {
  const tokens = String(name ?? '').trim().replace(/^"|"$/g, '').trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { firstName: null, lastName: null };
  const clip = (text) => text.slice(0, 128) === '' ? null : text.slice(0, 128);
  if (tokens.length === 1) return { firstName: clip(tokens[0]), lastName: null };
  return { firstName: clip(tokens[0]), lastName: clip(tokens.slice(1).join(' ')) };
}

/**
 * One address header (`From`, `To`, `Cc`) into address plus display name:
 * `"John Doe" <john@example.com>` or a bare `john@example.com`. Throws
 * fail-closed — a message without a readable sender names nobody.
 * @param {unknown} value
 */
export function parseGmailAddressHeader(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text === '' || text.length > 512) malformedEvent('message needs a readable address header');
  const bracketed = /<([^<>]*)>/.exec(text);
  const bare = bracketed ? bracketed[1].trim() : text;
  const address = canonicalGmailAddress(bare);
  const display = bracketed ? text.slice(0, bracketed.index).trim() : '';
  const names = splitGmailDisplayName(display);
  return { address, firstName: names.firstName, lastName: names.lastName };
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

/**
 * Whether a provider-returned value is usable as a Gmail thread id
 * (backlog:e9b4fc2f): the worker trusts it only when it passes the THREAD
 * rule, so a message id or any other provider text never lands in the
 * `email:` thread namespace. Provider text stays provider text until this
 * says otherwise — never a thread id by position.
 */
export function isGmailThreadId(value) {
  return typeof value === 'string' && THREAD.test(value);
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

/**
 * Read the bulk headers off one message (`List-Unsubscribe`, `Precedence`):
 * the fake payload carries them as a plain `headers` object, the REST path
 * reads the same two names out of `payload.headers`.
 * @param {unknown} raw
 */
export function readGmailBulkHeaders(raw) {
  const headers = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const listUnsubscribe = typeof headers.listUnsubscribe === 'string' ? headers.listUnsubscribe : null;
  const precedence = typeof headers.precedence === 'string' ? headers.precedence : null;
  return { listUnsubscribe, precedence };
}

/**
 * Parse the recipient headers (`To`, `Cc`) into sender evidence (backlog:13c09f03):
 * the owner's sent mail imports its recipients, so they become leads too.
 * A malformed recipient is skipped, never fatal — one bad address must not
 * drop the good ones beside it. The bound mailbox is always excluded: our
 * own address is evidence of sending, never a customer.
 * @param {unknown} rawTo @param {unknown} rawCc @param {string} mailbox
 */
export function parseGmailRecipients(rawTo, rawCc, mailbox) {
  const seen = new Set();
  const recipients = [];
  const rawList = [...(Array.isArray(rawTo) ? rawTo : [rawTo]), ...(Array.isArray(rawCc) ? rawCc : [rawCc])];
  for (const raw of rawList) {
    if (raw === undefined || raw === null || raw === '') continue;
    let parsed;
    try {
      parsed = parseGmailAddressHeader(raw);
    } catch {
      continue;
    }
    if (parsed.address === mailbox || seen.has(parsed.address)) continue;
    seen.add(parsed.address);
    recipients.push({
      handle: parsed.address,
      ...(parsed.firstName === null ? {} : { firstName: parsed.firstName }),
      ...(parsed.lastName === null ? {} : { lastName: parsed.lastName }),
    });
  }
  return recipients;
}

/** Build one provider-native Gmail push body (tests only). */
export function gmailPushBody({
  id, threadId, from, to, subject = '', snippet = '',
  internalDateMs = null, historyId = 'history-fake-1', subscription = 'projects/example/subscriptions/accordo-gmail',
  publishTime = null, attachments = undefined, cc = undefined, headers = undefined,
}) {
  const at = internalDateMs ?? Date.now();
  const data = toBase64Url(JSON.stringify({
    emailAddress: to,
    historyId,
    message: {
      id, threadId, from, to, subject, snippet, internalDateMs: at,
      ...(attachments === undefined ? {} : { attachments }),
      ...(cc === undefined ? {} : { cc }),
      ...(headers === undefined ? {} : { headers }),
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

/**
 * The Gmail MIME family the card renders as (backlog:32820692): images are
 * photos, video and audio keep their kind, everything else — PDFs included —
 * is a document. The fetch handle is the provider attachment id, fetched
 * server-side with the call-time secret, never bytes in a row.
 * @param {unknown} mimeType
 */
function gmailAttachmentKind(mimeType) {
  const family = typeof mimeType === 'string' ? mimeType.toLowerCase().split(';')[0].trim() : '';
  if (family.startsWith('image/')) return 'photo';
  if (family.startsWith('video/')) return 'video';
  if (family.startsWith('audio/')) return 'audio';
  return 'document';
}

/**
 * Every attachment of one Gmail message (backlog:32820692): the fake push
 * payload carries `attachments[]` with `{filename, mimeType, size,
 * attachmentId}`. Entries without a fetch id are skipped, never refused —
 * one exotic part must not 422 the PDF beside it.
 * @param {unknown} raw
 */
function normalizeGmailAttachments(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const attachments = [];
  for (const candidate of list) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const entry = /** @type {Record<string, any>} */ (candidate);
    if (typeof entry.attachmentId !== 'string' || entry.attachmentId === '') continue;
    const name = typeof entry.filename === 'string' && entry.filename !== '' ? entry.filename : null;
    const size = Number.isSafeInteger(entry.size) ? entry.size : null;
    try {
      attachments.push(assertChannelAttachment({
        kind: gmailAttachmentKind(entry.mimeType), name, size, ref: entry.attachmentId, preview: null,
      }, 'Gmail'));
    } catch {
      continue;
    }
  }
  return attachments;
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
  try {
    from = parseGmailAddressHeader(item.from);
  } catch {
    malformedEvent('message needs a valid sender address');
  }
  const bulkHeaders = readGmailBulkHeaders(item.headers);
  const atMs = item.internalDateMs;
  if (!Number.isSafeInteger(atMs) || atMs < 0 || atMs > 4102444800000) {
    malformedEvent('message needs a valid internalDateMs');
  }
  const atIso = new Date(atMs).toISOString();
  // Mass mail never names a customer (backlog:13c09f03): no subject, so
  // the operations layer quarantines it as evidence — no contact, no
  // timeline identity, exactly like our own sent copy looping back.
  if (isBulkGmailMessage({ from: from.address, ...bulkHeaders })) {
    return { providerEventId: item.id, subject: '', sequence: null, occurredAt: atIso };
  }
  // Our own sent mail imports its recipients (backlog:13c09f03): the people
  // the owner wrote to become leads too. A loopback with nobody else stays
  // evidence, never a customer — same quarantine as before.
  if (from.address === config.mailbox) {
    const recipients = parseGmailRecipients(item.to, item.cc, config.mailbox);
    if (recipients.length === 0) {
      return { providerEventId: item.id, subject: '', sequence: null, occurredAt: atIso };
    }
    return {
      providerEventId: item.id,
      subject: `${GMAIL_SUBJECT_PREFIX}${item.threadId}`,
      sequence: atMs,
      occurredAt: atIso,
      text: '',
      recipients,
    };
  }
  // No skew check here on purpose: the provider instant travels through
  // as `occurredAt` and `operations.js` quarantines a future-dated one
  // centrally (receive time + anomaly note), so it never becomes the
  // out-of-order sequence.
  // Snippet plus attachments (backlog:32820692): the fake push payload
  // carries the readable excerpt as `snippet` and provider parts as
  // `attachments[]`; the text rides with the first attachment's siblings
  // below, and the inbox keeps the envelope only.
  const snippet = typeof item.snippet === 'string' ? item.snippet : '';
  if (snippet.length > GMAIL_MAX_TEXT) malformedEvent('message snippet exceeds the bound');
  const attachments = normalizeGmailAttachments(item.attachments);
  const text = snippet;
  // The sender IS the From header (backlog:13c09f03): an unknown sender
  // becomes a lead through the composed channel-sender capability, with
  // the display name as the contact name.
  const sender = {
    handle: from.address,
    ...(from.firstName === null ? {} : { firstName: from.firstName }),
    ...(from.lastName === null ? {} : { lastName: from.lastName }),
  };
  const base = {
    subject: `${GMAIL_SUBJECT_PREFIX}${item.threadId}`,
    sequence: atMs,
    occurredAt: new Date(atMs).toISOString(),
    text,
    sender,
  };
  if (attachments.length <= 1) {
    return { providerEventId: item.id, ...base, attachment: attachments[0] ?? null };
  }
  // The first sibling keeps the bare message id (backlog:32820692): the
  // same stable identity the Meta adapters use, so a redelivery of a
  // previously ingested message replays or conflicts instead of doubling.
  return attachments.map((attachment, index) => ({
    providerEventId: index === 0 ? item.id : `${item.id}:a${index}`,
    ...base,
    attachment,
  }));
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
 * Build the Gmail adapter: `{ definition, api }` in the fixture's shape,
 * so the kit harness drives it unchanged. `secret` is the declared
 * test-only value the double expects; production resolves the real OAuth
 * token through the same `resolveSecret` edge.
 *
 * Pass `httpFetch` (a fetch-compatible transport, backlog:d1da1ed51e9c)
 * to speak the real Gmail REST API instead of the in-memory double:
 * history paging and send go over HTTP with the call-time secret as the
 * Bearer, against `config.baseUrl`. Without it the adapter stays
 * fake-backed, exactly as before.
 *
 * @param {{
 *   secret?: string, mailbox?: string, baseUrl?: string, testOnly?: boolean,
 *   httpFetch?: (url: string, init?: any) => Promise<any>,
 * }} options `mailbox` is the bound space address: the kit/self-test
 * loopback address, and in production the linked mailbox the echo
 * quarantine compares against.
 */
export function createGmailChannelAdapter(options = {}) {
  const expectedSecret = typeof options.secret === 'string' && options.secret !== ''
    ? options.secret : 'gmail-fake-secret';
  const config = assertAdapterConfig(options);
  const httpFetch = options.httpFetch;
  if (httpFetch !== undefined && typeof httpFetch !== 'function') {
    throw new ValidationError('Gmail adapter httpFetch must be a fetch-compatible function', {
      field: 'config.httpFetch',
    });
  }
  const httpIo = typeof httpFetch === 'function'
    ? createGmailHttpIo({ fetchImpl: httpFetch, baseUrl: config.baseUrl, mailbox: config.mailbox })
    : null;
  const state = {
    mode: 'ok',
    flakyRemaining: 0,
    /** @type {Map<string, {providerMessageId: string, providerThreadId?: string, request: any}>} */
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
     * (`{ id, threadId, from, to?, cc?, headers?, subject?, internalDateMs }`).
     * Each seed normalizes through the same `normalizeGmailMessage` the
     * push path uses, so a bad seed fails the test setup, never the import.
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
        const one = normalizeGmailMessage({
          message: {
            id: item?.id,
            threadId: item?.threadId,
            from: item?.from,
            to: item?.to ?? config.mailbox,
            subject: item?.subject ?? '',
            snippet: typeof item?.snippet === 'string' ? item.snippet : '',
            internalDateMs: atMs,
            ...(item?.attachments === undefined ? {} : { attachments: item.attachments }),
            ...(item?.cc === undefined ? {} : { cc: item.cc }),
            ...(item?.headers === undefined ? {} : { headers: item.headers }),
          },
        }, config);
        const events = Array.isArray(one) ? one : [one];
        for (const event of events) {
          state.mailboxHistory.push({ normalized: event });
        }
      }
    },
  };

  return {
    definition: {
      name: options.name ?? GMAIL_ADAPTER_NAME,
      version: GMAIL_ADAPTER_VERSION,
      label: httpIo ? 'Gmail API' : 'Gmail API (fake-backed)',
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
          // One message with several attachments normalizes to one event
          // per attachment (backlog:32820692) — the same sibling rule the
          // Meta adapters use — so no PDF is truncated to the first.
          const normalized = normalizeGmailMessage(decoded, config);
          return Array.isArray(normalized) ? normalized : [normalized];
        }
        if (config.testOnly) return [normalizeKitEvent(parsed)];
        malformedEvent('only Gmail push notifications are accepted');
      },

      historyImport: {
        windowMs: GMAIL_HISTORY_WINDOW_MS,
        /**
         * Page the seeded mailbox oldest-first: threads of the last 90
         * days, one normalized event per message with the sender,
         * recipients and bulk evidence `normalizeGmailMessage` attached —
         * the same envelope the push path normalizes, so both reconcile
         * identically. The fake serves its single bound mailbox;
         * production lists the OAuth mailbox the call-time secret names,
         * through the same `resolveSecret` edge the import uses.
         */
        async listHistory({ secret, since, pageToken, limit }) {
          if (httpIo) return httpIo.listHistory({ secret, since, pageToken, limit });
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
            events: slice.map((entry) => entry.normalized),
            nextPageToken: next,
          };
        },
      },

      normalizeOutbound(message) {
        return normalizeGmailOutbound(message);
      },

      async sendOutbound({ message, secret, idempotencyKey }) {
        state.sendCalls += 1;
        if (httpIo) return httpIo.sendMessage({ message, secret, idempotencyKey });
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
        if (existing) {
          return {
            providerMessageId: existing.providerMessageId,
            ...(existing.providerThreadId === undefined ? {} : { providerThreadId: existing.providerThreadId }),
          };
        }
        const request = buildGmailSendRequest({
          message,
          config: { mailbox: config.mailbox, baseUrl: config.baseUrl },
          secret,
        });
        const providerMessageId = `gmailmsg.fake-${state.sentByKey.size + 1}`;
        // A reply stays in the thread the inbound opened; a first-ever send
        // opens a new one, and the fake mints its id the way the Gmail API
        // returns `threadId` next to the message `id` (THREAD-shaped, never
        // the message id itself, so the two namespaces cannot be confused).
        const providerThreadId = typeof message.threadId === 'string' && message.threadId !== ''
          ? message.threadId
          : `gmailthread.fake-${state.sentByKey.size + 1}`;
        // The Bearer [REDACTED] is call-time only: the retained copy keeps the
        // wire shape minus the secret, so no dump of sentRequests() leaks it.
        const { Authorization: _withheld, ...publicHeaders } = request.headers;
        void _withheld;
        state.sentByKey.set(idempotencyKey, {
          providerMessageId,
          providerThreadId,
          request: { method: request.method, url: request.url, headers: publicHeaders, body: request.body },
        });
        return { providerMessageId, providerThreadId };
      },
    },
    api,
  };
}
