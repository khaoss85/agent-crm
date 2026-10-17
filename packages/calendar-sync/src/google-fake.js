// @ts-check

import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Fake Google Calendar provider (backlog:bf0351325a8c).
 *
 * Fake-backed on purpose (owner decision MEM_ACC_DECISIONS: no Google
 * credentials exist yet, and none are invented here): an in-memory double
 * that speaks the provider semantics the sync engine depends on, so the
 * two-way sync is proven against sync tokens, tombstones and push
 * notifications without dialing Google.
 *
 * Modeled semantics (the subset the sync needs, nothing more):
 * - `list` with `syncToken` returns only what changed since that token and
 *   a `nextSyncToken`; an unknown or expired token refuses with
 *   `GOOGLE_SYNC_TOKEN_INVALID`, and the sync answers with a full
 *   reconcile instead of guessing.
 * - a deleted event keeps exactly one tombstone (`status: 'cancelled'`),
 *   the way Google's incremental sync reports deletions.
 * - `watch` registers a push channel; `deliverPush` simulates Google
 *   calling the deployment's webhook for that channel. The channel token
 *   is a bearer credential: the fake keeps it in its closure, and the sync
 *   stores only its hash — never the token — in its state row.
 * - every mutation stamps `updated` from the injected clock, so conflict
 *   tests move time instead of sleeping.
 */

export const GOOGLE_SYNC_TOKEN_INVALID = 'GOOGLE_SYNC_TOKEN_INVALID';

const EVENT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function fakeError(code, status, message, details) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  if (details !== undefined) error.details = details;
  return error;
}

function checkEventId(id) {
  if (typeof id !== 'string' || !EVENT_ID_RE.test(id)) {
    throw fakeError('GOOGLE_EVENT_MALFORMED', 422, 'event id must be 1-128 chars of letters, digits, _ or -');
  }
  return id;
}

function snapshot(event) {
  return Object.freeze({ ...event, extendedProperties: Object.freeze({ ...(event.extendedProperties ?? {}) }) });
}

/**
 * @param {{ nowMs?: () => number, secret?: string }} [options]
 * `secret` signs nothing here — the push channel uses a bearer token the
 * test holds. It is accepted only so a future signature variant has a
 * named parameter, and is never stored on any row.
 */
export function createFakeGoogleCalendar(options = {}) {
  const nowMs = typeof options.nowMs === 'function' ? options.nowMs : () => Date.now();
  const nowIso = () => new Date(nowMs()).toISOString();
  /** @type {Map<string, { events: Map<string, any>, log: Array<{seq:number, eventId:string}>, seq: number, epoch: number, channels: Map<string, any> }>} */
  const calendars = new Map();
  let channelCounter = 0;
  let pushCounter = 0;

  const calendar = (calendarId) => {
    let cal = calendars.get(calendarId);
    if (!cal) {
      cal = { events: new Map(), log: [], seq: 0, epoch: 0, channels: new Map() };
      calendars.set(calendarId, cal);
    }
    return cal;
  };

  /** Fetch the live event or null when it was never created or hard-deleted. */
  function liveEvent(cal, eventId) {
    return cal.events.get(eventId) ?? null;
  }

  function touch(cal, eventId) {
    cal.seq += 1;
    cal.log.push({ seq: cal.seq, eventId });
    // The log is a change index, not history: one entry per event, the
    // newest, so a long-lived calendar never grows it without bound.
    const newest = new Map();
    for (const entry of cal.log) newest.set(entry.eventId, entry);
    cal.log = [...newest.values()];
    return cal.seq;
  }

  function tokenFor(cal) {
    return `fake-sync-${cal.epoch}-${cal.seq}`;
  }

  function parseToken(cal, syncToken) {
    const match = typeof syncToken === 'string' ? /^fake-sync-(\d+)-(\d+)$/.exec(syncToken) : null;
    if (!match || Number(match[1]) !== cal.epoch) {
      throw fakeError(GOOGLE_SYNC_TOKEN_INVALID, 410,
        'sync token unknown or expired: do a full reconcile instead of guessing', { status: 410 });
    }
    return Number(match[2]);
  }

  const api = {
    /** Seed one event directly (test setup): full Google shape, no sync involved. */
    seedEvent(calendarId, event) {
      const cal = calendar(calendarId);
      const id = checkEventId(event?.id);
      const stored = {
        id,
        summary: typeof event?.summary === 'string' ? event.summary : '',
        description: typeof event?.description === 'string' ? event.description : '',
        start: event?.start ?? null,
        end: event?.end ?? null,
        status: 'confirmed',
        updated: typeof event?.updated === 'string' ? event.updated : nowIso(),
        extendedProperties: { ...(event?.extendedProperties ?? {}) },
      };
      cal.events.set(id, stored);
      touch(cal, id);
      return snapshot(stored);
    },

    /** Direct read of the live event (what the provider holds right now). */
    getEvent(calendarId, eventId) {
      const found = liveEvent(calendar(calendarId), checkEventId(eventId));
      return found ? snapshot(found) : null;
    },

    /**
     * List events. With `syncToken`: only what changed since, plus
     * `nextSyncToken`. Without: the full snapshot (`timeMin` bounds it to
     * events ending after the instant; `showDeleted` adds tombstones).
     */
    listEvents({ calendarId, syncToken, timeMin, showDeleted = false }) {
      const cal = calendar(calendarId);
      if (syncToken !== undefined) {
        const since = parseToken(cal, syncToken);
        const changed = [];
        for (const { eventId } of cal.log) {
          const live = liveEvent(cal, eventId);
          const lastSeq = cal.log.find((entry) => entry.eventId === eventId)?.seq ?? 0;
          if (lastSeq <= since) continue;
          if (live) {
            changed.push(snapshot(live));
          } else {
            changed.push(Object.freeze({ id: eventId, status: 'cancelled', updated: nowIso() }));
          }
        }
        return Object.freeze({ items: Object.freeze(changed), nextSyncToken: tokenFor(cal) });
      }
      const minMs = typeof timeMin === 'string' && timeMin !== '' ? Date.parse(timeMin) : NaN;
      const items = [];
      for (const event of cal.events.values()) {
        if (event.status === 'cancelled' && !showDeleted) continue;
        if (Number.isFinite(minMs)) {
          const endMs = Date.parse(event?.end?.dateTime ?? '');
          if (Number.isFinite(endMs) && endMs <= minMs) continue;
        }
        items.push(snapshot(event));
      }
      return Object.freeze({ items: Object.freeze(items), nextSyncToken: tokenFor(cal) });
    },

    /** Provider-side insert (the push direction lands here). */
    insertEvent({ calendarId, summary, description = '', start, end, extendedProperties = {}, id }) {
      const cal = calendar(calendarId);
      const eventId = id === undefined ? `fake-${cal.seq + 1}-${Math.floor(nowMs() % 100000)}` : checkEventId(id);
      if (liveEvent(cal, eventId)) {
        throw fakeError('GOOGLE_EVENT_CONFLICT', 409, `event "${eventId}" already exists`);
      }
      const stored = {
        id: eventId,
        summary: typeof summary === 'string' ? summary : '',
        description: typeof description === 'string' ? description : '',
        start: start ?? null,
        end: end ?? null,
        status: 'confirmed',
        updated: nowIso(),
        extendedProperties: { ...extendedProperties },
      };
      cal.events.set(eventId, stored);
      touch(cal, eventId);
      return snapshot(stored);
    },

    /** Provider-side partial update (schedule or summary moved elsewhere). */
    patchEvent({ calendarId, eventId, patch }) {
      const cal = calendar(calendarId);
      const live = liveEvent(cal, checkEventId(eventId));
      if (!live || live.status === 'cancelled') {
        throw fakeError('GOOGLE_EVENT_UNKNOWN', 404, `event "${eventId}" does not exist`);
      }
      const next = { ...live, ...(patch ?? {}) };
      delete next.id;
      next.id = live.id;
      next.status = 'confirmed';
      next.updated = typeof patch?.updated === 'string' ? patch.updated : nowIso();
      next.extendedProperties = { ...(patch?.extendedProperties ?? live.extendedProperties) };
      cal.events.set(live.id, next);
      touch(cal, live.id);
      return snapshot(next);
    },

    /** Provider-side cancellation: the tombstone incremental sync reports. */
    cancelEvent({ calendarId, eventId }) {
      const cal = calendar(calendarId);
      const live = liveEvent(cal, checkEventId(eventId));
      if (!live) {
        throw fakeError('GOOGLE_EVENT_UNKNOWN', 404, `event "${eventId}" does not exist`);
      }
      if (live.status === 'cancelled') return snapshot(live);
      const next = { ...live, status: 'cancelled', updated: nowIso() };
      cal.events.set(live.id, next);
      touch(cal, live.id);
      return snapshot(next);
    },

    /**
     * Register a push channel. Returns the channel the deployment stores
     * (id + resource, never the token) and hands the bearer token to the
     * caller only — the test holds it the way the deployment's secret
     * custody would.
     */
    watch({ calendarId, token }) {
      const cal = calendar(calendarId);
      if (typeof token !== 'string' || token === '') {
        throw fakeError('GOOGLE_PUSH_MALFORMED', 422, 'watch needs a non-empty channel token');
      }
      channelCounter += 1;
      const channelId = `fake-channel-${channelCounter}`;
      const resourceId = `fake-resource-${calendarId}-${channelCounter}`;
      cal.channels.set(channelId, { channelId, resourceId, calendarId, token });
      return Object.freeze({ channelId, resourceId });
    },

    onPush(handler) {
      if (typeof handler !== 'function') {
        throw fakeError('GOOGLE_PUSH_MALFORMED', 422, 'onPush needs a handler function');
      }
      api.pushHandler = handler;
    },

    /**
     * Simulate Google calling the deployment's webhook: builds the push
     * headers (channel id, resource id, state, bearer token) and invokes
     * the registered handler. No registered handler is a test wiring fault,
     * never a silent drop.
     */
    deliverPush(channelId, { state = 'exists' } = {}) {
      let found = null;
      for (const cal of calendars.values()) {
        const channel = cal.channels.get(channelId);
        if (channel) { found = channel; break; }
      }
      if (!found) {
        throw fakeError('GOOGLE_PUSH_UNKNOWN_CHANNEL', 404, `push channel "${String(channelId)}" is not watched`);
      }
      if (typeof api.pushHandler !== 'function') {
        throw fakeError('GOOGLE_PUSH_UNWIRED', 500, 'no push handler registered: the deployment never wired its webhook');
      }
      pushCounter += 1;
      return api.pushHandler({
        channelId: found.channelId,
        resourceId: found.resourceId,
        resourceState: state,
        channelToken: found.token,
        deliveryId: `fake-delivery-${pushCounter}`,
      });
    },

    /** Expire every token of a calendar: the next incremental list refuses. */
    expireTokens(calendarId) {
      calendar(calendarId).epoch += 1;
    },

    /** Constant-time bearer comparison the sync uses instead of storing tokens. */
    checkToken(candidate, expected) {
      if (typeof candidate !== 'string' || typeof expected !== 'string') return false;
      const a = Buffer.from(candidate);
      const b = Buffer.from(expected);
      return a.length === b.length && timingSafeEqual(a, b);
    },

    /** sha256 of a channel token: what the sync stores, so rows hold no secret. */
    hashToken(token) {
      return createHash('sha256').update(String(token)).digest('hex');
    },

    /** Test introspection: how many live events the provider holds. */
    eventCount(calendarId) {
      return calendar(calendarId).events.size;
    },
  };

  return api;
}
