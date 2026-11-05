// @ts-check

import { AppError } from '../../core/index.js';
import {
  GMAIL_MAX_TEXT,
  buildGmailSendRequest,
  canonicalGmailAddress,
  gmailThreadIdForSubject,
  isGmailThreadId,
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

/**
 * Normalize one Gmail REST message (`messages.get` with
 * `format=metadata`) onto the channel event shape the inbox path reads:
 * the conversation IS the thread (`email:<threadId>`), the order IS the
 * provider instant (`internalDate`), the sender IS the From header.
 * Provider text stays provider text until `isGmailThreadId` says
 * otherwise — a message id never lands in the `email:` namespace.
 *
 * A delivery off our own mailbox (a sent copy looping back) normalizes
 * to an empty subject, exactly like the push path: the operations layer
 * quarantines it as evidence, never as a customer.
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
    const rawFrom = restHeader(wire.payload, 'From') ?? '';
    const bare = rawFrom.includes('<')
      ? (/<([^<>]*)>/.exec(rawFrom)?.[1] ?? '')
      : rawFrom.trim();
    from = canonicalGmailAddress(bare);
  } catch {
    throw httpError('Gmail message needs a valid sender address', 'CHANNEL_EVENT_MALFORMED', 422);
  }
  if (from === mailbox) {
    return { providerEventId: id, subject: '', sequence: null, occurredAt: null };
  }
  const atMs = typeof wire.internalDate === 'string'
    ? Number.parseInt(wire.internalDate, 10)
    : wire.internalDate;
  if (!Number.isSafeInteger(atMs) || atMs < 0 || atMs > 4102444800000) {
    throw httpError('Gmail message needs a valid internalDate', 'CHANNEL_EVENT_MALFORMED', 422);
  }
  const snippet = typeof wire.snippet === 'string' ? wire.snippet : '';
  if (snippet.length > GMAIL_MAX_TEXT) {
    throw httpError('Gmail message snippet exceeds the bound', 'CHANNEL_EVENT_MALFORMED', 422);
  }
  return {
    providerEventId: id,
    subject: `email:${threadId}`,
    sequence: atMs,
    occurredAt: new Date(atMs).toISOString(),
    text: snippet,
    attachment: null,
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

function mapHistoryFailure(status, what, body) {
  if (status === 401 || status === 403) {
    const reason = googleRefusalReason(body);
    throw httpError(`Gmail ${what} refused: the grant is missing, expired or revoked`,
      'CHANNEL_HISTORY_REFUSED', 403, reason === null ? undefined : { reason });
  }
  if (status === 429) {
    throw httpError(`Gmail ${what} is rate limited: retry the import later`,
      'CHANNEL_HISTORY_TRANSIENT', 503);
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
     * page shape the fake serves, so the import converges identically.
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
      for (const entry of messages) {
        if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || entry.id === '') continue;
        const full = await call(
          `${baseUrl}/gmail/v1/users/me/messages/${encodeURIComponent(entry.id)}`
          + '?format=metadata&metadataHeaders=From&metadataHeaders=Subject',
          { method: 'GET', headers: headers(secret) },
          'history',
          mapHistoryFailure,
        );
        const normalized = normalizeGmailRestMessage(full, mailbox);
        if (normalized.subject === '') {
          // Our own sent copy looping back: quarantined as evidence with
          // its provider time, the same way the push path treats it.
          events.push({ ...normalized, sender: { handle: mailbox } });
          continue;
        }
        events.push({ ...normalized, sender: { handle: senderOf(full) } });
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
      return { events, nextPageToken: next };
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

  /** The sender behind one REST message: already validated by the normalizer. */
  function senderOf(full) {
    const raw = restHeader(full?.payload, 'From') ?? '';
    const bare = raw.includes('<') ? (/<([^<>]*)>/.exec(raw)?.[1] ?? '') : raw.trim();
    return canonicalGmailAddress(bare);
  }
}
