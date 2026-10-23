// @ts-check

import { AppError } from '../../core/index.js';
import { inboundOnlyOutbound } from './adapter.js';
import { verifyHmacWebhook } from './crypto.js';
import { fixtureEnvelopeEvent } from './fixture.js';

/**
 * TikTok direct-message adapter (backlog:ffce3d1cd636).
 *
 * Inbound-only by contract: TikTok delivers messages INTO the space, and
 * this package never sends through it — a reply rides the customer's
 * reachable channel instead (WhatsApp when the request carries a phone
 * number, email otherwise). Both halves of the outbound path refuse with
 * the contract's CHANNEL_SEND_UNSUPPORTED (see `inboundOnlyOutbound` in
 * `adapter.js`), which `operations.js` hands back intact and the shared
 * kit asserts.
 *
 * Fake-backed on purpose (owner decision MEM_ACC_DECISIONS: no provider
 * credentials exist yet, and none are invented here): the transport is a
 * programmable in-memory double in the fixture's shape (`ok` mode only —
 * fault modes do not apply to a channel that never sends), and inbound
 * webhooks verify with the shared channel HMAC scheme (`crypto.js`) — the
 * scheme the fake signs with, and the scheme the kit harness signs with.
 *
 * What the adapter owns (the TikTok policy, fail-closed):
 * - inbound: TikTok direct-message deliveries (`dm.received` with a message
 *   id, the sender handle, text and a unix timestamp) normalized to one
 *   channel event per message, plus the kit's minimal envelope on the kit
 *   path. The conversation subject is the sender (`tiktok:<handle>`), so
 *   the thread stays with the customer, never with the business account.
 * - outbound: refused, always, with CHANNEL_SEND_UNSUPPORTED.
 */

export const TIKTOK_ADAPTER_NAME = 'tiktok-inbox';
export const TIKTOK_ADAPTER_VERSION = 1;
const MAX_TEXT = 4000;
const MAX_HANDLE = 128;

function malformedEvent(reason) {
  throw new AppError(`TikTok event is not well-formed: ${reason}`, {
    code: 'CHANNEL_EVENT_MALFORMED', status: 422,
  });
}

function boundedText(value, max, field) {
  if (typeof value !== 'string' || value === '' || value.length > max) {
    malformedEvent(`${field} must be bounded non-empty text (1-${max} characters)`);
  }
  return value;
}

function unixToInstant(timestamp) {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > 4102444800) return null;
  return new Date(timestamp * 1000).toISOString();
}

/**
 * Normalize one verified webhook body. Speaks the TikTok direct-message
 * shape when the body carries it, and the kit's minimal envelope otherwise
 * (the same fallback every fake adapter shares, so the kit drives
 * receive/replay/out-of-order through the provider path).
 */
function normalizeTikTokInbound(event) {
  let parsed;
  try {
    parsed = JSON.parse(String(event));
  } catch {
    malformedEvent('event is not JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    malformedEvent('event is not an object');
  }
  if (parsed.event === undefined || parsed.event === null) {
    return fixtureEnvelopeEvent(parsed);
  }
  if (parsed.event !== 'dm.received') {
    malformedEvent(`unsupported TikTok event "${String(parsed.event).slice(0, 64)}"`);
  }
  const messageId = boundedText(parsed.message_id, 256, '"message_id"');
  const fromUser = boundedText(parsed.from_user, MAX_HANDLE, '"from_user"');
  if (typeof parsed.text !== 'string' || parsed.text.length > MAX_TEXT) {
    malformedEvent('"text" must be text (at most 4000 characters)');
  }
  const occurredAt = unixToInstant(parsed.timestamp);
  if (occurredAt === null) {
    malformedEvent('"timestamp" must be unix seconds');
  }
  return {
    providerEventId: messageId,
    subject: `tiktok:${fromUser}`,
    sequence: Number.isSafeInteger(parsed.timestamp) ? parsed.timestamp : null,
    occurredAt,
  };
}

/**
 * Build the fake-backed TikTok adapter: `{ definition, api }` in the
 * fixture's shape, so the kit harness drives it unchanged. The double
 * keeps no secret of its own: verification is the HMAC over the secret
 * production resolves through the same `resolveSecret` edge.
 */
export function createTikTokChannelAdapter(options = {}) {
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
      name: options.name ?? TIKTOK_ADAPTER_NAME,
      version: TIKTOK_ADAPTER_VERSION,
      label: 'TikTok direct messages (fake-backed)',
      channel: 'tiktok',
      config: { testOnly: true },

      verifyInbound({ rawBody, headers, secret }) {
        const signature = headers?.['x-channel-signature-256'];
        const timestamp = headers?.['x-channel-timestamp'];
        const ok = verifyHmacWebhook({ rawBody, signature, timestamp, secret });
        if (!ok) return { ok: false };
        return { ok: true, event: Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody ?? '') };
      },

      normalizeInbound(event) {
        return normalizeTikTokInbound(event);
      },

      ...inboundOnlyOutbound('TikTok direct messages'),
    },
    api,
  };
}

/** Build one TikTok direct-message body. */
export function tiktokEventBody({ messageId, fromUser = 'cliente.rossi', text = 'Avete posto sabato?', atSec = null }) {
  return JSON.stringify({
    event: 'dm.received',
    message_id: messageId,
    from_user: fromUser,
    text,
    timestamp: atSec ?? Math.floor(Date.now() / 1000),
  });
}
