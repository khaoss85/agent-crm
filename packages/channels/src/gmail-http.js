// @ts-check

import { AppError } from '../../core/index.js';
import { htmlToText, isPlaceholderBody } from '../../core/src/message-preview.js';
import {
  GMAIL_MAX_ATTACHMENTS,
  GMAIL_MAX_TEXT,
  boundMailAttachmentSize,
  buildGmailSendRequest,
  canonicalGmailAddress,
  decodeGmailSubject,
  isAutomatedGmailRecipient,
  isBulkGmailMessage,
  isGmailThreadId,
  gmailThreadIdForSubject,
  parseGmailAddressHeader,
  parseGmailRecipients,
  sanitizeGmailText,
  sanitizeMailDescriptorText,
} from './gmail.js';

/**
 * Real Gmail transport over HTTP (backlog:d1da1ed51e9c).
 *
 * The Gmail REST mapping the fake adapter only describes as a pure
 * function (`buildGmailSendRequest`): history paging (`messages.list` +
 * `messages.get`) and send (`messages.send`), spoken against
 * `https://gmail.googleapis.com` with the call-time secret as the
 * Bearer. The transport is injected (`fetchImpl`), so tests prove the
 * mapping against a fake HTTP layer and production passes the
 * platform's authenticated fetch: no test dials Google, no credential
 * is stored or invented here.
 *
 * Error discipline (the channels package's): a provider failure never
 * travels with provider text — the code rides with a fixed message, so
 * no token or personal detail lands in a row, an error or a log.
 */

export const GMAIL_API_BASE = 'https://gmail.googleapis.com';

/**
 * The readable body a stored row may hold (backlog:3055d50330b5): the
 * interactions record refuses bodies past its own `bounds.body` (2000), so
 * the reader truncates here instead of letting a long newsletter be refused
 * downstream and never stored. Mirrors that bound — each package owns its
 * boundary validation and never file-imports another domain package, so the
 * two fences stay equal by this comment, and the interactions suite owns
 * the refusal this one never re-checks.
 */
export const GMAIL_MAX_STORED_TEXT = 2000;

function httpError(message, code, status, details) {
  return new AppError(message, { code, status, ...(details === undefined ? {} : { details }) });
}

function assertSecret(secret, what) {
  if (typeof secret !== 'string' || secret === '') {
    throw httpError(`Gmail ${what} needs the call-time secret`, 'CHANNEL_HISTORY_REFUSED', 403);
  }
  return secret;
}

/** One header value out of a Gmail `payload.headers` list, or null. */
function restHeader(payload, name) {
  const headers = payload && typeof payload === 'object' && Array.isArray(payload.headers)
    ? payload.headers
    : [];
  const want = String(name).toLowerCase();
  for (const entry of headers) {
    if (entry && typeof entry === 'object'
      && typeof entry.name === 'string' && entry.name.toLowerCase() === want
      && typeof entry.value === 'string') {
      return entry.value;
    }
  }
  return null;
}

/** Every value one header name carries on a REST payload (To/Cc may repeat). */
function restHeaderAll(payload, name) {
  const headers = payload && typeof payload === 'object' && Array.isArray(payload.headers)
    ? payload.headers
    : [];
  const want = String(name).toLowerCase();
  const values = [];
  for (const entry of headers) {
    if (entry && typeof entry === 'object'
      && typeof entry.name === 'string' && entry.name.toLowerCase() === want
      && typeof entry.value === 'string') {
      values.push(entry.value);
    }
  }
  return values;
}

/**
 * The three bulk headers off a REST payload, in the plain shape
 * `isBulkGmailMessage` reads (backlog:13c09f03, backlog:1a4d9b30):
 * same three names the fake path reads, same closed-vocabulary verdict.
 */
function restBulkHeaders(payload) {
  const list = restHeaderAll(payload, 'List-Unsubscribe');
  const precedence = restHeaderAll(payload, 'Precedence');
  const auto = restHeaderAll(payload, 'Auto-Submitted');
  return {
    listUnsubscribe: list.length > 0 ? list[0] : null,
    precedence: precedence.length > 0 ? precedence[0] : null,
    autoSubmitted: auto.length > 0 ? auto[0] : null,
  };
}

/** One sender-shaped evidence off a REST address header: address plus display name, never a throw past the caller. */
function restAddressEvidence(raw) {
  const parsed = parseGmailAddressHeader(raw);
  return {
    handle: parsed.address,
    ...(parsed.firstName === null ? {} : { firstName: parsed.firstName }),
    ...(parsed.lastName === null ? {} : { lastName: parsed.lastName }),
  };
}

/**
 * One MIME part body to text, or null. Bodies arrive base64url-encoded;
 * anything undecodable or absurdly large is simply not text — the caller
 * falls back to the snippet instead of refusing the message.
 */
function decodePartBodyData(data) {
  if (typeof data !== 'string' || data === '' || data.length > 1024 * 1024) return null;
  try {
    return Buffer.from(data, 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Walk one payload part depth-first, collecting readable texts in order:
 * `{ kind: 'text'|'html', text }`. Container parts (`multipart/*`) carry
 * no body of their own — their children do.
 */
function collectPartTexts(part, out) {
  if (!part || typeof part !== 'object' || Array.isArray(part)) return;
  const children = Array.isArray(part.parts) ? part.parts : [];
  for (const child of children) collectPartTexts(child, out);
  if (children.length > 0) return;
  const mime = typeof part.mimeType === 'string' ? part.mimeType.toLowerCase().split(';')[0].trim() : '';
  if (mime !== 'text/plain' && mime !== 'text/html') return;
  // Parts with a filename are attachments (descriptors only, read by
  // `readMailAttachments`): their bytes never become the readable body,
  // mirroring that reader's `filename === ''` guard.
  if (typeof part.filename === 'string' && part.filename !== '') return;
  const body = part.body && typeof part.body === 'object' && !Array.isArray(part.body) ? part.body : null;
  const text = decodePartBodyData(body?.data);
  if (text === null || text === '') return;
  out.push({ kind: mime === 'text/html' ? 'html' : 'text', text });
}

/**
 * An HTML part to readable text: the core `htmlToText` (Dan 10/11) — head,
 * scripts, styles and hidden preheaders (display:none, max-height:0,
 * opacity:0) gone, blocks broken, tags stripped quote-aware, never an
 * attribute fragment left behind. The old stripper rewrote `<div id=…>`
 * as `<div>id=…>` and stored the attributes as text.
 */
function stripHtmlToText(html) {
  return htmlToText(html);
}

/**
 * The readable body of one `format=full` payload (backlog:3055d50330b5):
 * the first `text/plain` part wins, then the first `text/html` part
 * stripped to text, then the snippet. A plain part that is only a stand-in
 * for the HTML (core `isPlaceholderBody`) loses to the HTML part. Sanitized either way (entities
 * decoded, padding invisibles stripped). Longer than
 * `GMAIL_MAX_STORED_TEXT` truncates instead of refusing the message — a
 * newsletter stays saved with its preheader at the top, never skipped over
 * a long tail, and the stored text always fits the interactions body fence
 * the record enforces downstream.
 */
function readMailBodyText(payload, snippet) {
  const found = [];
  collectPartTexts(payload, found);
  // Select AFTER cleaning (backlog:3055d50330b5): a text/plain part that is
  // only padding invisibles or entities cleaning to nothing must not shadow
  // a real HTML body — the first non-empty cleaned candidate wins, then the
  // cleaned snippet. Truncation stays after the pick, same fence as before.
  const clean = (text) => {
    const out = sanitizeGmailText(text);
    return out.length > GMAIL_MAX_STORED_TEXT ? out.slice(0, GMAIL_MAX_STORED_TEXT) : out;
  };
  // A plain part that is only a stand-in (Dan 10/11: «Please view this
  // email in an HTML-capable email client», «Visualizza la versione Web
  // <url>», a list of tracking links) gives way to the HTML part; it is
  // kept only when no HTML part reads to text.
  let standIn = null;
  for (const entry of found) {
    if (entry.kind !== 'text') continue;
    const text = clean(entry.text);
    if (text === '') continue;
    if (!isPlaceholderBody(text)) return text;
    standIn ??= text;
  }
  for (const entry of found) {
    if (entry.kind !== 'html') continue;
    const text = clean(stripHtmlToText(entry.text));
    if (text !== '') return text;
  }
  if (standIn !== null) return standIn;
  return clean(snippet);
}

/**
 * The attachment descriptors of one `format=full` payload
 * (backlog:3055d50330b5): every part with a filename, in wire order —
 * `{ name, mimeType, sizeBytes }`, metadata only, never the content (no
 * `messages.attachments.get` call happens here). Bounded to
 * `GMAIL_MAX_ATTACHMENTS`: a message with more parts keeps the first ones.
 * Parts without a filename (inline bodies the text extraction already
 * covers) are not attachments.
 */
function readMailAttachments(payload) {
  const out = [];
  const walk = (part) => {
    if (!part || typeof part !== 'object' || Array.isArray(part)) return;
    const children = Array.isArray(part.parts) ? part.parts : [];
    for (const child of children) walk(child);
    if (out.length >= GMAIL_MAX_ATTACHMENTS) return;
    const body = part.body && typeof part.body === 'object' && !Array.isArray(part.body) ? part.body : null;
    if (!body || typeof body.attachmentId !== 'string' || body.attachmentId === '') return;
    // A dirty provider name degrades to a skipped descriptor, never a
    // refused message: the same shared helper the push reader uses, so both
    // paths sanitize identically.
    const name = sanitizeMailDescriptorText(part.filename, 200);
    if (name === null) return;
    const mime = typeof part.mimeType === 'string' && part.mimeType !== ''
      ? sanitizeMailDescriptorText(part.mimeType, 128)
      : 'application/octet-stream';
    if (mime === null) return;
    // Same shared bound as the push reader: an over-cap provider size
    // degrades to a null sizeBytes, never a refused message.
    const sizeBytes = boundMailAttachmentSize(body.size);
    out.push(Object.freeze({
      name,
      mimeType: mime,
      sizeBytes,
    }));
  };
  walk(payload);
  return Object.freeze(out);
}

/**
 * Normalize one Gmail REST message (`messages.get` with `format=full`)
 * onto the channel event shape the inbox path reads: the conversation IS
 * the thread (`email:<threadId>`), the order IS the provider instant
 * (`internalDate`), the sender IS the From header. Provider text stays
 * provider text until `isGmailThreadId` says otherwise — a message id
 * never lands in the `email:` namespace.
 *
 * Beyond the thread key the event carries the mail content the card reads
 * (backlog:3055d50330b5): `mailSubject` (the decoded `Subject` header, or
 * null), `text` (readable body, entities decoded and padding invisibles
 * stripped) and `attachments` (filename, MIME type and byte size per part —
 * metadata only, the content is never fetched). The legacy singular
 * `attachment` stays null on this path: email attachments travel as the
 * list, and the timeline exposes that list.
 *
 * A delivery off our own mailbox (a sent copy looping back) normalizes
 * to an empty subject with its recipients attached, exactly like the
 * push path: the operations layer reconciles the recipients into leads
 * and quarantines a loopback with nobody else as evidence, never as a
 * customer. Mass mail normalizes to an empty subject with no sender at
 * all: no contact is ever invented from it.
 */
export function normalizeGmailRestMessage(wire, mailbox) {
  if (!wire || typeof wire !== 'object' || Array.isArray(wire)) {
    throw httpError('Gmail message is not well-formed', 'CHANNEL_EVENT_MALFORMED', 422);
  }
  const id = wire.id;
  if (typeof id !== 'string' || id === '' || id.length > 256) {
    throw httpError('Gmail message needs a bounded id', 'CHANNEL_EVENT_MALFORMED', 422);
  }
  const threadId = wire.threadId;
  if (!isGmailThreadId(threadId)) {
    throw httpError('Gmail message needs a bounded threadId', 'CHANNEL_EVENT_MALFORMED', 422);
  }
  if (gmailThreadIdForSubject(`email:${threadId}`) !== threadId) {
    throw httpError('Gmail message thread is not addressable', 'CHANNEL_EVENT_MALFORMED', 422);
  }
  let from;
  try {
    from = restAddressEvidence(restHeader(wire.payload, 'From') ?? '');
  } catch {
    throw httpError('Gmail message needs a valid sender address', 'CHANNEL_EVENT_MALFORMED', 422);
  }
  const atMs = typeof wire.internalDate === 'string'
    ? Number.parseInt(wire.internalDate, 10)
    : wire.internalDate;
  if (!Number.isSafeInteger(atMs) || atMs < 0 || atMs > 4102444800000) {
    throw httpError('Gmail message needs a valid internalDate', 'CHANNEL_EVENT_MALFORMED', 422);
  }
  const atIso = new Date(atMs).toISOString();
  // The linked mailbox reads first (backlog:1a4d9b30, arbitration 06/11):
  // mail the owner sent — even from an automated-looking mailbox like
  // support@ — is never bulk-quarantined for its From alone.
  if (from.handle === mailbox) {
    // Same recipient door as the fake path (backlog:1a4d9b30): an
    // automated To/Cc never becomes a lead, and an all-automated To/Cc
    // quarantines as evidence below.
    const recipients = parseGmailRecipients(
      restHeaderAll(wire.payload, 'To'), restHeaderAll(wire.payload, 'Cc'), mailbox,
    ).filter((recipient) => !isAutomatedGmailRecipient(recipient.handle));
    if (recipients.length === 0) {
      return { providerEventId: id, subject: '', sequence: null, occurredAt: atIso };
    }
    return {
      providerEventId: id,
      subject: `email:${threadId}`,
      sequence: atMs,
      occurredAt: atIso,
      text: '',
      recipients,
      mailSubject: decodeGmailSubject(restHeader(wire.payload, 'Subject')),
      attachments: readMailAttachments(wire.payload),
    };
  }
  // Bulk quarantines inbound only: the mailbox branch above already took
  // the owner's sent mail (backlog:1a4d9b30).
  if (isBulkGmailMessage({ from: from.handle, ...restBulkHeaders(wire.payload) })) {
    return { providerEventId: id, subject: '', sequence: null, occurredAt: atIso };
  }
  const snippet = typeof wire.snippet === 'string' ? wire.snippet : '';
  if (snippet.length > GMAIL_MAX_TEXT) {
    throw httpError('Gmail message snippet exceeds the bound', 'CHANNEL_EVENT_MALFORMED', 422);
  }
  return {
    providerEventId: id,
    subject: `email:${threadId}`,
    sequence: atMs,
    occurredAt: atIso,
    text: readMailBodyText(wire.payload, snippet),
    mailSubject: decodeGmailSubject(restHeader(wire.payload, 'Subject')),
    attachments: readMailAttachments(wire.payload),
    attachment: null,
    sender: from,
  };
}

async function readJson(response, what) {
  try {
    const body = await response.json();
    if (body && typeof body === 'object' && !Array.isArray(body)) return body;
  } catch {
    // Falls through to the malformed error below.
  }
  throw httpError(`Gmail ${what} returned an unreadable response`, 'CHANNEL_HISTORY_MALFORMED', 502);
}

/**
 * Google's machine reason for a refused call, or null. The shape is the
 * documented error envelope (`{ error: { errors: [{ reason }], status } }`):
 * `errors[0].reason` first (`insufficientPermissions` for a missing scope,
 * `accessNotConfigured` for a disabled Gmail API, `authError` for a dead
 * grant), then the envelope `status` (`PERMISSION_DENIED`,
 * `UNAUTHENTICATED`). Only those two code fields travel — never the
 * envelope message (it can echo the request), never the token, never an
 * address: anything else falls back to the closed-vocabulary refusal.
 */
function googleRefusalReason(body) {
  const envelope = body && typeof body === 'object' && !Array.isArray(body) ? body.error : null;
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return null;
  const errors = Array.isArray(envelope.errors) ? envelope.errors : [];
  const first = errors.length > 0 && errors[0] && typeof errors[0] === 'object' && !Array.isArray(errors[0])
    ? errors[0]
    : null;
  for (const candidate of [first?.reason, envelope.status]) {
    if (typeof candidate === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(candidate)) return candidate;
  }
  return null;
}

/**
 * Gmail answers quota exhaustion with 403, not 429: after hundreds of
 * `messages.get` calls in one import the provider refuses with
 * `rateLimitExceeded`, which used to read as a revoked grant
 * (CHANNEL_HISTORY_REFUSED, backlog:3a3a41b2). The body's machine reason
 * tells the two apart — a quota reason retries, only an auth-shaped
 * refusal (or no reason at all, fail-closed) keeps the refused code.
 * The reason itself never lands in a message, a row or a rethrow.
 */
const GMAIL_QUOTA_REASONS = new Set([
  'rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded',
  'dailyLimitExceeded', 'dailyLimitExceededUnreg',
]);

function mapHistoryFailure(status, what, body) {
  if (status === 403 && GMAIL_QUOTA_REASONS.has(googleRefusalReason(body))) {
    throw httpError(`Gmail ${what} is rate limited: retry the import later`,
      'CHANNEL_HISTORY_TRANSIENT', 503);
  }
  if (status === 401 || status === 403) {
    const reason = googleRefusalReason(body);
    throw httpError(`Gmail ${what} refused: the grant is missing, expired or revoked`,
      'CHANNEL_HISTORY_REFUSED', 403, reason === null ? undefined : { reason });
  }
  if (status === 429) {
    throw httpError(`Gmail ${what} is rate limited: retry the import later`,
      'CHANNEL_HISTORY_TRANSIENT', 503);
  }
  // The list-level read always aborts the page with a retryable code:
  // a status that names "not found" (HTTP 404) is still a provider
  // failure here — the per-message get below is the only path that may
  // skip one message gone between list and get, and only on Google's
  // confirmed not-found envelope. Keeping 404 out of the transient
  // pair stops retry, alerting and HTTP mapping keyed on status from
  // reading "not found" for a retryable condition (backlog:3a3a41b2).
  throw httpError(`Gmail ${what} failed without provider detail: retry the import later`,
    'CHANNEL_HISTORY_TRANSIENT', 502);
}

/**
 * One `messages.get` failure, mapped beside the list-level mapper. Quota
 * and outage map exactly like the list read (retryable); a 404 carrying
 * Google's confirmed not-found envelope (`reason: 'notFound'`) becomes
 * the gone marker the loop skips — one deleted message never aborts the
 * hundreds already read. Any other 404 (transient miss, mapped proxy
 * error) still aborts the page as transient, so a live message is
 * retried instead of silently dropped (backlog:3a3a41b2). The marker
 * carries a fixed message and no body: no provider text travels.
 */
function mapHistoryGetFailure(status, what, body) {
  if (status === 403 && GMAIL_QUOTA_REASONS.has(googleRefusalReason(body))) {
    throw httpError(`Gmail ${what} is rate limited: retry the import later`,
      'CHANNEL_HISTORY_TRANSIENT', 503);
  }
  if (status === 401 || status === 403) {
    const reason = googleRefusalReason(body);
    throw httpError(`Gmail ${what} refused: the grant is missing, expired or revoked`,
      'CHANNEL_HISTORY_REFUSED', 403, reason === null ? undefined : { reason });
  }
  if (status === 429) {
    throw httpError(`Gmail ${what} is rate limited: retry the import later`,
      'CHANNEL_HISTORY_TRANSIENT', 503);
  }
  if (status === 404 && googleRefusalReason(body) === 'notFound') {
    throw httpError('Gmail message gone between list and get: skipped', 'CHANNEL_HISTORY_MESSAGE_GONE', 404);
  }
  throw httpError(`Gmail ${what} failed without provider detail: retry the import later`,
    'CHANNEL_HISTORY_TRANSIENT', 502);
}

function mapSendFailure(status) {
  if (status === 401 || status === 403) {
    throw httpError('Gmail provider refuses this message: the grant is missing, expired or revoked',
      'CHANNEL_SEND_REFUSED', 403);
  }
  if (status === 429 || (Number.isSafeInteger(status) && status >= 500 && status < 600)) {
    // A provider outage is retryable through the outbox backoff, never a
    // terminal refusal: a 503 once settled the job as failed_terminal with
    // attempts remaining and forced a human requeue.
    throw httpError('Gmail provider temporarily unavailable', 'CHANNEL_SEND_TRANSIENT', 503);
  }
  throw httpError('Gmail provider refuses this message', 'CHANNEL_SEND_REFUSED', 422);
}

/**
 * Build the real Gmail HTTP io.
 *
 * @param {{ fetchImpl: (url: string, init?: any) => Promise<any>, baseUrl?: string, mailbox: string }} options
 * `fetchImpl` is the HTTP layer (undici/global fetch in production, a
 * scripted double in tests). Required: without a transport the factory
 * refuses instead of composing an io that cannot call. `mailbox` is the
 * bound space address the echo quarantine compares against — the same
 * bound address the adapter requires at composition.
 */
export function createGmailHttpIo(options = {}) {
  const fetchImpl = options.fetchImpl;
  if (typeof fetchImpl !== 'function') {
    throw httpError('Gmail http io needs a fetchImpl transport', 'CHANNEL_HISTORY_MALFORMED', 500);
  }
  const baseUrl = typeof options.baseUrl === 'string' && options.baseUrl !== ''
    ? options.baseUrl.replace(/\/+$/, '')
    : GMAIL_API_BASE;
  if (!/^https:\/\/[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(baseUrl)) {
    throw httpError('Gmail http io baseUrl must be a bounded https origin', 'CHANNEL_HISTORY_MALFORMED', 500);
  }
  let mailbox;
  try {
    mailbox = canonicalGmailAddress(options.mailbox);
  } catch {
    throw httpError('Gmail http io needs the bound mailbox address', 'CHANNEL_HISTORY_MALFORMED', 500);
  }

  function headers(secret) {
    return { Authorization: `Bearer ${secret}`, Accept: 'application/json' };
  }

  async function call(url, init, what, mapFailure) {
    let response;
    try {
      response = await fetchImpl(url, init);
    } catch {
      throw httpError(`Gmail ${what} is unreachable: retry later`, 'CHANNEL_HISTORY_TRANSIENT', 503);
    }
    if (!response || response.ok !== true) {
      // The refusal mapper reads the provider envelope (reason codes only,
      // never text): consume the body once here, since the mapper throws.
      let failureBody = null;
      try {
        const parsed = await response?.json();
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) failureBody = parsed;
      } catch {
        // Unreadable refusal body: the mapper falls back to the bare code.
      }
      mapFailure(Number.isSafeInteger(response?.status) ? response.status : 502, what, failureBody);
    }
    return readJson(response, what);
  }

  return {
    mailbox,
    /**
     * Page the mailbox oldest-first: threads since the instant, one
     * normalized event per message with its sender attached — the same
     * page shape the fake serves, so the import converges identically —
     * plus `skippedMessages`, the count of provider-confirmed-gone
     * messages skipped on this page.
     */
    async listHistory({ secret, since, pageToken, limit }) {
      assertSecret(secret, 'history');
      const from = Date.parse(since);
      if (!Number.isFinite(from)) {
        throw httpError('Gmail history needs a readable since instant', 'CHANNEL_HISTORY_MALFORMED', 422);
      }
      const params = new URLSearchParams();
      params.set('q', `after:${Math.floor(from / 1000)}`);
      params.set('maxResults', String(Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 500) : 100));
      if (typeof pageToken === 'string' && pageToken !== '') params.set('pageToken', pageToken);
      const listed = await call(
        `${baseUrl}/gmail/v1/users/me/messages?${params.toString()}`,
        { method: 'GET', headers: headers(secret) },
        'history',
        mapHistoryFailure,
      );
      const messages = Array.isArray(listed.messages) ? listed.messages : [];
      const events = [];
      // Messages Google confirms gone between list and get: skipped, and
      // counted on the page so a systematically-404 read is visible as a
      // number instead of a silently shorter page (backlog:3a3a41b2).
      let skippedMessages = 0;
      for (const entry of messages) {
        if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || entry.id === '') continue;
        let full;
        try {
          // Full payloads (backlog:3055d50330b5): the card reads the decoded
          // Subject, the readable body and the attachment descriptors, so
          // the get returns the whole MIME tree — headers, bodies and part
          // metadata — instead of the header subset. Same call count,
          // larger responses; the content itself (`messages.attachments.get`)
          // is never fetched. From/To/Cc name the recipients, and
          // List-Unsubscribe, Precedence and Auto-Submitted still mark mass
          // mail (backlog:13c09f03, backlog:1a4d9b30): a full payload
          // carries every header, so no metadataHeaders subset is needed.
          const params = new URLSearchParams();
          params.set('format', 'full');
          full = await call(
            `${baseUrl}/gmail/v1/users/me/messages/${encodeURIComponent(entry.id)}?${params.toString()}`,
            { method: 'GET', headers: headers(secret) },
            'history',
            mapHistoryGetFailure,
          );
        } catch (error) {
          // Only the confirmed-gone marker skips: one deleted message
          // must not abort the hundreds already read. Anything else —
          // quota, refusal, an unconfirmed 404 — still aborts the page
          // and the retry re-reads it.
          if (error?.code === 'CHANNEL_HISTORY_MESSAGE_GONE') {
            skippedMessages += 1;
            continue;
          }
          throw error;
        }
        // The normalizer already carries sender, recipients, bulk and
        // loopback evidence in the same shape the fake serves — pushed
        // unchanged, so the import converges identically on both readers.
        events.push(normalizeGmailRestMessage(full, mailbox));
      }
      const next = typeof listed.nextPageToken === 'string' && listed.nextPageToken !== ''
        ? listed.nextPageToken
        : null;
      events.sort((a, b) => {
        const atA = a.occurredAt ?? '';
        const atB = b.occurredAt ?? '';
        if (atA !== atB) return atA < atB ? -1 : 1;
        return a.providerEventId < b.providerEventId ? -1 : 1;
      });
      return { events, nextPageToken: next, skippedMessages };
    },

    /**
     * Send one normalized message through `messages.send`, built by the
     * same pure `buildGmailSendRequest` the fake records — URL, auth
     * scheme and body proven once, spoken twice.
     */
    async sendMessage({ message, secret, idempotencyKey }) {
      if (typeof secret !== 'string' || secret === '') {
        throw httpError('Gmail send needs the call-time secret', 'CHANNEL_SEND_REFUSED', 403);
      }
      const request = buildGmailSendRequest({ message, config: { mailbox, baseUrl }, secret });
      let response;
      try {
        response = await fetchImpl(request.url, {
          method: request.method,
          headers: request.headers,
          body: JSON.stringify(request.body),
        });
      } catch {
        throw httpError('Gmail provider temporarily unavailable', 'CHANNEL_SEND_TRANSIENT', 503);
      }
      if (!response || response.ok !== true) {
        mapSendFailure(Number.isSafeInteger(response?.status) ? response.status : 502);
      }
      let body;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)
        || typeof body.id !== 'string' || body.id === '') {
        throw httpError('Gmail send returned an unreadable message', 'CHANNEL_SEND_REFUSED', 502);
      }
      void idempotencyKey;
      const providerThreadId = isGmailThreadId(body.threadId) ? body.threadId : undefined;
      return {
        providerMessageId: body.id,
        ...(providerThreadId === undefined ? {} : { providerThreadId }),
      };
    },
  };
}
