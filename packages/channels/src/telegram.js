// @ts-check

import { timingSafeEqual } from 'node:crypto';
import { AppError, ValidationError } from '../../core/index.js';
import { verifyHmacWebhook } from './crypto.js';

/**
 * Telegram Bot API channel adapter (backlog:2a5651e1933d).
 *
 * The first non-Meta provider adapter on the common channel base: inbound
 * Telegram Bot API updates, replies through `sendMessage`, no reply-window
 * rule — a bot may write the customer at any time once the customer opened
 * the chat, so unlike WhatsApp and Instagram there is no `outboundWindow`
 * capability and no template fallback.
 *
 * Two inbound dialects, both verified before parsing:
 *
 * - provider-native: the Bot API update body (`{ update_id, message: {
 *   message_id, from: { id }, chat: { id }, date, text?/caption? } }`),
 *   verified against the `X-Telegram-Bot-Api-Secret-Token` header with a
 *   constant-time comparison against the inbound secret. Missing or
 *   mismatched token refuses, nothing is written. This is the only dialect
 *   a production composition (`testOnly: false`) accepts.
 * - kit interop: the signed minimal event (`{id, subject, seq?, at?}`)
 *   the channel kit speaks, verified against the fixture timestamp
 *   scheme. Accepted only when `config.testOnly` is true — a
 *   production adapter refuses it like any other malformed event.
 *
 * One delivery normalizes to a LIST of one channel event, the same list
 * path WhatsApp and Instagram use, so `operations.js` stores it through
 * the same single-transaction ingest with dedup per providerEventId. The
 * conversation subject is the customer chat (`tg:<chat-id>`); the event
 * carries the chat, the text (`text`, else the photo `caption`, else
 * empty) and the provider date. Updates without a `message` (edits,
 * callbacks, service notices) refuse as malformed and write nothing.
 *
 * Two secrets, both deployment-held (owner decision MEM_ACC_DECISIONS):
 * the webhook secret token (inbound purpose) and the bot token (outbound
 * purpose) arrive through the `resolveSecret` edge per purpose — never the
 * repo, never the logs. Delivery runs against the injected fake transport
 * — the same programmable failure modes as the fixture (`ok`,
 * `flaky(n)`, `refuse`, `timeout`) — never against api.telegram.org. The
 * Bot API REST mapping is a pure function (`buildTelegramSendRequest`)
 * so the URL, method and body shape are unit-proven without dialing the
 * provider; the retained copy keeps the wire shape minus the token, which
 * lives in the URL path and is redacted before anything is stored.
 */

export const TELEGRAM_ADAPTER_NAME = 'telegram-bot';
export const TELEGRAM_ADAPTER_VERSION = 1;
export const TELEGRAM_SECRET_HEADER = 'x-telegram-bot-api-secret-token';
const MAX_ID = 256;
const MAX_TEXT = 4096;
const MAX_DATE_SECONDS = 4102444800;
/** Inbox subjects carry the `tg:` prefix, so chats stay namespaced per channel. */
const SUBJECT_PREFIX = 'tg:';
const MAX_CHAT = MAX_ID - SUBJECT_PREFIX.length;

function malformed(reason) {
  throw new AppError(`Telegram event is not well-formed: ${reason}`, {
    code: 'CHANNEL_EVENT_MALFORMED', status: 422,
  });
}

function malformedMessage(reason) {
  throw new AppError(`Telegram message is not well-formed: ${reason}`, {
    code: 'CHANNEL_MESSAGE_MALFORMED', status: 422,
  });
}

/** Header lookup that does not depend on the server's header casing. */
function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return undefined;
  const wanted = String(name).toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === wanted) return headers[key];
  }
  return undefined;
}

/**
 * Constant-time comparison of the presented webhook token against the
 * expected one. Anything missing, non-text or length-mismatched refuses
 * without throwing — only an explicit mismatch is a 401 upstream, never
 * a server-side stall.
 */
export function verifyTelegramWebhookToken(presented, expected) {
  if (typeof presented !== 'string' || presented === '') return false;
  if (typeof expected !== 'string' || expected === '') return false;
  const left = Buffer.from(presented, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Build one provider-native Bot API update body (tests only). */
export function telegramEventBody({
  updateId = 1001, messageId = 11, chatId = 445001122, userId = 445001122,
  text = 'Ciao, avete posto sabato?', dateSeconds = null, extraMessage = {},
} = {}) {
  return JSON.stringify({
    update_id: updateId,
    message: {
      message_id: messageId,
      from: { id: userId, is_bot: false, first_name: 'Cliente' },
      chat: { id: chatId, type: 'private' },
      date: dateSeconds ?? Math.floor(Date.now() / 1000),
      text,
      ...extraMessage,
    },
  });
}

/** Canonical chat/user id: Bot API ids are integers, possibly negative for groups. */
function canonicalTelegramId(value, what) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^-?\d{1,19}$/.test(trimmed)) {
      const asNumber = Number(trimmed);
      if (Number.isSafeInteger(asNumber)) return String(asNumber);
    }
  }
  malformed(`${what} must be an integer id`);
}

function unixParts(timestamp) {
  if (typeof timestamp !== 'number' || !Number.isSafeInteger(timestamp)) return null;
  if (timestamp < 0 || timestamp > MAX_DATE_SECONDS) return null;
  return { sequence: timestamp, occurredAt: new Date(timestamp * 1000).toISOString() };
}

/**
 * Normalize one verified Bot API update to a LIST of one channel event.
 * Accepts the provider shape and the kit's minimal envelope (testOnly).
 */
function normalizeTelegramInbound(event, testOnly) {
  let parsed;
  try {
    parsed = JSON.parse(String(event));
  } catch {
    malformed('body is not JSON');
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    && parsed.message && typeof parsed.message === 'object' && !Array.isArray(parsed.message)) {
    return [normalizeTelegramMessage(parsed)];
  }
  if (testOnly) return [normalizeKitEvent(parsed)];
  malformed('only Bot API message updates are accepted');
}

function normalizeTelegramMessage(update) {
  const message = update.message;
  if (!Number.isSafeInteger(update.update_id)) malformed('update needs an integer "update_id"');
  if (!Number.isSafeInteger(message.message_id)) malformed('message needs an integer "message_id"');
  const chatId = canonicalTelegramId(message.chat?.id, 'message chat');
  const userId = canonicalTelegramId(message.from?.id, 'message sender');
  if (chatId.length > MAX_CHAT) malformed('message chat id is too long for a subject');
  const parts = unixParts(message.date);
  if (!parts) malformed('message needs a valid unix "date"');
  const rawText = message.text ?? message.caption ?? '';
  const text = rawText === undefined ? '' : rawText;
  if (typeof text !== 'string' || text.length > MAX_TEXT) {
    malformed('message text must be text (at most 4096 characters)');
  }
  return {
    providerEventId: `tg:${update.update_id}`,
    subject: `${SUBJECT_PREFIX}${chatId}`,
    sequence: parts.sequence,
    occurredAt: parts.occurredAt,
    from: userId,
    to: chatId,
    text,
  };
}

/** The kit's signed minimal dialect (test compositions only). */
function normalizeKitEvent(parsed) {
  const providerEventId = typeof parsed?.id === 'string' ? parsed.id : '';
  const subject = typeof parsed?.subject === 'string' ? parsed.subject : '';
  if (providerEventId === '' || providerEventId.length > MAX_ID || subject === '' || subject.length > MAX_ID) {
    malformed('minimal event needs a bounded "id" and "subject"');
  }
  return {
    providerEventId,
    subject,
    sequence: Number.isSafeInteger(parsed.seq) ? parsed.seq : null,
    occurredAt: typeof parsed.at === 'string' ? parsed.at : null,
  };
}

/**
 * The Bot API `sendMessage` REST mapping as a pure function: method, URL,
 * headers and body. The bot token travels in the URL path (Telegram's
 * scheme) and is passed call-time only — never stored, never logged.
 */
export function buildTelegramSendRequest({ message, config, secret }) {
  if (!message || typeof message !== 'object') {
    throw new AppError('Telegram send needs a normalized message', { code: 'CHANNEL_MESSAGE_MALFORMED', status: 422 });
  }
  if (typeof secret !== 'string' || secret === '') {
    throw new AppError('Telegram send needs the call-time bot token', { code: 'CHANNEL_SECRET_UNAVAILABLE', status: 500 });
  }
  const to = canonicalTelegramChatId(message.to);
  if (typeof message.text !== 'string' || message.text === '' || message.text.length > MAX_TEXT) {
    throw new AppError('Telegram send needs non-empty "text" (at most 4096 chars)', { code: 'CHANNEL_MESSAGE_MALFORMED', status: 422 });
  }
  return {
    method: 'POST',
    url: `${config.baseUrl}/bot${secret}/sendMessage`,
    headers: { 'Content-Type': 'application/json' },
    body: { chat_id: to, text: message.text },
  };
}

/** The recipient of one outbound reply: a Telegram chat id, canonicalized. */
export function canonicalTelegramChatId(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^-?\d{1,19}$/.test(trimmed)) {
      const asNumber = Number(trimmed);
      if (Number.isSafeInteger(asNumber)) return String(asNumber);
    }
    if (/^@[A-Za-z0-9_]{5,32}$/.test(trimmed)) return trimmed;
  }
  throw new AppError('Telegram recipient must be a chat id or @channelusername', {
    code: 'CHANNEL_MESSAGE_MALFORMED', status: 422,
  });
}

/** The retained copy of one send: the wire shape with the bot token redacted. */
export function redactTelegramSendRequest(request) {
  return {
    method: request.method,
    url: String(request.url).replace(/\/bot[^/]*\//, '/bot<redacted>/'),
    headers: { ...request.headers },
    body: request.body,
  };
}

function assertAdapterConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('Telegram adapter options must be a plain object', { field: 'config' });
  }
  const baseUrl = input.baseUrl === undefined ? 'https://api.telegram.org' : input.baseUrl;
  if (typeof baseUrl !== 'string' || !/^https:\/\/[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(baseUrl)) {
    throw new ValidationError('Telegram adapter baseUrl must be a bounded https origin', { field: 'config.baseUrl' });
  }
  return Object.freeze({ baseUrl, testOnly: true });
}

/**
 * Build the fake-backed Telegram adapter: `{ definition, api }` in the
 * fixture's shape, so the kit harness drives it unchanged. `secret` is the
 * declared test-only value the double expects; production resolves the
 * webhook secret (inbound) and the bot token (outbound) through the same
 * `resolveSecret` edge per purpose.
 */
export function createTelegramChannelAdapter(options = {}) {
  const expectedSecret = typeof options.secret === 'string' && options.secret !== ''
    ? options.secret : 'telegram-fake-secret';
  const config = assertAdapterConfig(options);
  const testOnly = options.testOnly ?? true;
  const state = {
    mode: 'ok',
    flakyRemaining: 0,
    /** @type {Map<string, {providerMessageId: string, request: any}>} */
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
      return [...state.sentByKey.values()].map((entry) => entry.request.body);
    },
    sentRequests() {
      return [...state.sentByKey.values()].map((entry) => entry.request);
    },
  };

  return {
    definition: {
      name: options.name ?? TELEGRAM_ADAPTER_NAME,
      version: TELEGRAM_ADAPTER_VERSION,
      label: 'Telegram Bot API (fake-backed)',
      channel: 'telegram',
      config: { baseUrl: config.baseUrl, testOnly },

      verifyInbound({ rawBody, headers, secret }) {
        // The provider scheme first: Telegram's secret-token header,
        // constant-time, missing or mismatch refuses.
        if (verifyTelegramWebhookToken(headerValue(headers, TELEGRAM_SECRET_HEADER), secret)) {
          return { ok: true, event: Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody ?? '') };
        }
        // The kit drives the adapter through the fixture's signed scheme;
        // production never reaches this branch (testOnly false refuses).
        if (testOnly) {
          const signature = headerValue(headers, 'x-channel-signature-256');
          const timestamp = headerValue(headers, 'x-channel-timestamp');
          if (verifyHmacWebhook({ rawBody, signature, timestamp, secret })) {
            return { ok: true, event: Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody ?? '') };
          }
        }
        return { ok: false };
      },

      normalizeInbound(event) {
        return normalizeTelegramInbound(event, testOnly);
      },

      /**
       * Normalize one outbound reply. Telegram sets no reply window: any
       * well-formed reply sends. The window observation argument is
       * accepted and ignored so the adapter stays a drop-in on the
       * contract the kit and the queue path share.
       */
      normalizeOutbound(message) {
        if (!message || typeof message !== 'object' || Array.isArray(message)) {
          malformedMessage('message must be an object');
        }
        let to;
        try {
          to = canonicalTelegramChatId(message.to);
        } catch {
          malformedMessage('message needs a chat id "to"');
        }
        const text = typeof message.text === 'string' ? message.text : '';
        if (text === '' || text.length > MAX_TEXT) {
          malformedMessage('message needs non-empty "text" (at most 4096 chars)');
        }
        return { to, text };
      },

      async sendOutbound({ message, secret, idempotencyKey }) {
        state.sendCalls += 1;
        if (secret !== expectedSecret) {
          throw new AppError('Telegram secret mismatch', { code: 'CHANNEL_SEND_REFUSED', status: 403 });
        }
        if (state.mode === 'timeout') {
          await new Promise(() => {});
          throw new AppError('Unreachable', { code: 'CHANNEL_SEND_TRANSIENT', status: 503 });
        }
        if (state.mode === 'refuse') {
          throw new AppError('Telegram provider refuses this message', { code: 'CHANNEL_SEND_REFUSED', status: 422 });
        }
        if (state.mode === 'flaky' && state.flakyRemaining > 0) {
          state.flakyRemaining -= 1;
          throw new AppError('Telegram provider temporarily unavailable', { code: 'CHANNEL_SEND_TRANSIENT', status: 503 });
        }
        const existing = state.sentByKey.get(idempotencyKey);
        if (existing) return { providerMessageId: existing.providerMessageId };
        const request = buildTelegramSendRequest({
          message,
          config: { baseUrl: config.baseUrl },
          secret,
        });
        const providerMessageId = `tgmid.fake-${state.sentByKey.size + 1}`;
        // The bot token travels in the URL path: the retained copy keeps
        // the wire shape minus the token, so no dump of sentRequests()
        // leaks it.
        state.sentByKey.set(idempotencyKey, { providerMessageId, request: redactTelegramSendRequest(request) });
        return { providerMessageId };
      },
    },
    api,
  };
}
