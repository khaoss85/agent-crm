// @ts-check

import { AppError } from '../../core/index.js';
import { inboundOnlyOutbound } from './adapter.js';
import { verifyHmacWebhook } from './crypto.js';
import { fixtureEnvelopeEvent } from './fixture.js';

/**
 * Google Calendar push adapter (backlog:ffce3d1cd636).
 *
 * Inbound-only by contract: Google delivers change notifications INTO the
 * space, and this package never sends through it — calendar writes go
 * through `packages/calendar-sync`, never through a channel send. Both
 * halves of the outbound path refuse with the contract's
 * CHANNEL_SEND_UNSUPPORTED (see `inboundOnlyOutbound` in `adapter.js`),
 * which `operations.js` hands back intact and the shared kit asserts.
 *
 * Fake-backed on purpose (owner decision MEM_ACC_DECISIONS: no provider
 * credentials exist yet, and none are invented here): inbound pushes verify
 * with the shared channel HMAC scheme (`crypto.js`) — the scheme the fake
 * signs with, and the scheme the kit harness signs with. The sync itself
 * stays in `packages/calendar-sync`; this adapter is the channel binding
 * that records the notification as one inbox event.
 *
 * What the adapter owns (the calendar policy, fail-closed):
 * - inbound: calendar change notifications (`calendar.changed` with a
 *   notification id, the calendar id, the event id, the change kind and a
 *   canonical update instant) normalized to one channel event per
 *   notification, plus the kit's minimal envelope on the kit path. The
 *   subject is the calendar (`calendar:<calendarId>`); the provider event
 *   id is the notification, so a repeated push for the same change replays
 *   instead of duplicating.
 * - outbound: refused, always, with CHANNEL_SEND_UNSUPPORTED.
 */

export const CALENDAR_ADAPTER_NAME = 'calendar-push';
export const CALENDAR_ADAPTER_VERSION = 1;
const CHANGE_KINDS = Object.freeze(['created', 'updated', 'canceled']);

function malformedEvent(reason) {
  throw new AppError(`Calendar event is not well-formed: ${reason}`, {
    code: 'CHANNEL_EVENT_MALFORMED', status: 422,
  });
}

function boundedId(value, max, field) {
  if (typeof value !== 'string' || value === '' || value.length > max) {
    malformedEvent(`${field} must be bounded non-empty text (1-${max} characters)`);
  }
  return value;
}

function isCanonicalInstant(value) {
  return typeof value === 'string' && value !== '' && Number.isSafeInteger(Date.parse(value))
    && new Date(Date.parse(value)).toISOString() === value;
}

/**
 * Normalize one verified push body. Speaks the `calendar.changed` shape
 * when the body carries it, and the kit's minimal envelope otherwise (the
 * same fallback every fake adapter shares, so the kit drives
 * receive/replay/out-of-order through the provider path).
 */
function normalizeCalendarInbound(event) {
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
  if (parsed.event !== 'calendar.changed') {
    malformedEvent(`unsupported calendar event "${String(parsed.event).slice(0, 64)}"`);
  }
  const notificationId = boundedId(parsed.notification_id, 256, '"notification_id"');
  const calendarId = boundedId(parsed.calendar_id, 256, '"calendar_id"');
  boundedId(parsed.event_id, 256, '"event_id"');
  if (!CHANGE_KINDS.includes(parsed.kind)) {
    malformedEvent('"kind" must be one of: created, updated, canceled');
  }
  if (!isCanonicalInstant(parsed.updated_at)) {
    malformedEvent('"updated_at" must be a canonical instant');
  }
  return {
    providerEventId: notificationId,
    subject: `calendar:${calendarId}`,
    sequence: null,
    occurredAt: parsed.updated_at,
  };
}

/**
 * Build the fake-backed calendar adapter: `{ definition, api }` in the
 * fixture's shape, so the kit harness drives it unchanged. The double
 * keeps no secret of its own: verification is the HMAC over the secret
 * production resolves through the same `resolveSecret` edge.
 */
export function createCalendarChannelAdapter(options = {}) {
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
      name: options.name ?? CALENDAR_ADAPTER_NAME,
      version: CALENDAR_ADAPTER_VERSION,
      label: 'Google Calendar push (fake-backed)',
      channel: 'calendar',
      config: { testOnly: true },

      verifyInbound({ rawBody, headers, secret }) {
        const signature = headers?.['x-channel-signature-256'];
        const timestamp = headers?.['x-channel-timestamp'];
        const ok = verifyHmacWebhook({ rawBody, signature, timestamp, secret });
        if (!ok) return { ok: false };
        return { ok: true, event: Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody ?? '') };
      },

      normalizeInbound(event) {
        return normalizeCalendarInbound(event);
      },

      ...inboundOnlyOutbound('Google Calendar push'),
    },
    api,
  };
}

/** Build one calendar change-notification body. */
export function calendarEventBody({ notificationId, calendarId = 'primary', eventId = 'evt-1', kind = 'updated', at = null }) {
  return JSON.stringify({
    event: 'calendar.changed',
    notification_id: notificationId,
    calendar_id: calendarId,
    event_id: eventId,
    kind,
    updated_at: at ?? new Date().toISOString(),
  });
}
