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
 * Expand one seeded endless weekly series into its single occurrences
 * inside the read window (backlog:3a3a41b2) — the fake half of Google's
 * `singleEvents=true`. Returns null when the event is no weekly series
 * or a bound is missing, so the caller reads the master row as before.
 * Only `FREQ=WEEKLY` (with an optional `INTERVAL`) expands; anything
 * else stays a master row rather than a guessed schedule.
 */
const WEEKLY_EXPANSION_MAX = 1000;

/**
 * One read bound, or absent. The same contract as the HTTP provider
 * (backlog:3a3a41b2): undefined, null and '' all mean "no bound", a
 * non-empty string must read as an instant, and anything else refuses
 * with the same code — so a test written against the fake never passes
 * a bound production would 422, and never 422s on one it would accept.
 */
function boundOrAbsent(raw, what) {
  if (raw === undefined || raw === null || raw === '') return NaN;
  if (typeof raw !== 'string' || !Number.isFinite(Date.parse(raw))) {
    throw fakeError('GOOGLE_CALL_MALFORMED', 422, `google listEvents needs a readable ${what} instant when bounding`);
  }
  return Date.parse(raw);
}

function parseUntilInstant(raw) {
  if (typeof raw !== 'string' || raw === '') return NaN;
  const direct = Date.parse(raw);
  if (Number.isFinite(direct)) return direct;
  const basic = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/.exec(raw);
  if (!basic) return NaN;
  return Date.parse(`${basic[1]}-${basic[2]}-${basic[3]}T${basic[4]}:${basic[5]}:${basic[6]}Z`);
}

function expandWeeklySeries(event, minMs, maxMs) {
  if (!Number.isFinite(minMs) || !Number.isFinite(maxMs) || maxMs <= minMs) return null;
  const lines = Array.isArray(event?.recurrence) ? event.recurrence : null;
  if (!lines) return null;
  let weekly = false;
  let interval = 1;
  let count = null;
  let untilMs = null;
  for (const line of lines) {
    if (typeof line !== 'string') return null;
    if (!line.startsWith('RRULE:')) return null;
    const rule = line.slice('RRULE:'.length);
    const parts = Object.fromEntries(rule.split(';').map((pair) => {
      const at = pair.indexOf('=');
      return at < 0 ? [pair, ''] : [pair.slice(0, at), pair.slice(at + 1)];
    }));
    if (parts.FREQ !== 'WEEKLY') return null;
    weekly = true;
    if (parts.INTERVAL !== undefined) {
      const n = Number.parseInt(parts.INTERVAL, 10);
      if (!Number.isSafeInteger(n) || n < 1 || n > 52) return null;
      interval = n;
    }
    if (parts.COUNT !== undefined) {
      const n = Number.parseInt(parts.COUNT, 10);
      if (!Number.isSafeInteger(n) || n < 1) return null;
      count = n;
    }
    if (parts.UNTIL !== undefined) {
      const parsed = parseUntilInstant(parts.UNTIL);
      if (!Number.isFinite(parsed)) return null;
      untilMs = parsed;
    }
    for (const key of Object.keys(parts)) {
      if (key !== 'FREQ' && key !== 'INTERVAL' && key !== 'COUNT' && key !== 'UNTIL') return null;
    }
  }
  if (!weekly) return null;
  const firstStart = Date.parse(event?.start?.dateTime ?? '');
  const firstEnd = Date.parse(event?.end?.dateTime ?? '');
  if (!Number.isFinite(firstStart) || !Number.isFinite(firstEnd) || firstEnd <= firstStart) return null;
  const duration = firstEnd - firstStart;
  const step = interval * 7 * 24 * 3600 * 1000;
  // Skip whole years before the window without iterating them: an
  // endless series starting decades back still answers in one pass.
  // The skip counts toward COUNT, so an exhausted series reads empty.
  const skip = firstStart < minMs - duration ? Math.floor((minMs - duration - firstStart) / step) : 0;
  const instances = [];
  let cut = false;
  for (let index = skip, at = firstStart + skip * step;
    at < maxMs;
    index += 1, at += step) {
    if (instances.length >= WEEKLY_EXPANSION_MAX) {
      // The cap cuts the window instead of paging it: report the cut so
      // the caller never mistakes 1000 rows for a complete window
      // (backlog:3a3a41b2). The -30/+90-day production window stays far
      // below the cap; anything wider must page or narrow the window.
      cut = true;
      break;
    }
    if (count !== null && index >= count) break;
    if (untilMs !== null && at > untilMs) break;
    const end = at + duration;
    if (end <= minMs) continue;
    const startIso = new Date(at).toISOString();
    instances.push(snapshot({
      ...event,
      id: `${event.id}_${startIso.replace(/[-:.]/g, '')}`,
      recurringEventId: event.id,
      start: { ...(event.start ?? {}), dateTime: startIso },
      end: { ...(event.end ?? {}), dateTime: new Date(end).toISOString() },
      recurrence: undefined,
    }));
  }
  return { instances, truncated: cut };
}

/**
 * @param {{ nowMs?: () => number, secret?: string, expectedSecret?: string }} [options]
 * `expectedSecret` binds the fake to the space grant: every engine call
 * must then carry it as its call-time `secret`, or the call refuses.
 * `secret` signs nothing here — the push channel uses a bearer token the
 * test holds. It is accepted only so a future signature variant has a
 * named parameter, and is never stored on any row.
 */
export function createFakeGoogleCalendar(options = {}) {
  const nowMs = typeof options.nowMs === 'function' ? options.nowMs : () => Date.now();
  const nowIso = () => new Date(nowMs()).toISOString();
  // The space grant this fake is bound to (backlog:43b62d4bcaa3): when set,
  // every engine call must carry the call-time secret the sync resolved
  // from the vault — a call without it refuses GOOGLE_GRANT_REFUSED, the
  // way the real binding refuses without its OAuth grant. Unset, the fake
  // stays permissive, so unwired compositions prove the sync logic as
  // before. The expected value itself is never echoed, stored, or logged.
  const expectedSecret = typeof options.expectedSecret === 'string' && options.expectedSecret !== ''
    ? options.expectedSecret
    : null;

  function requireGrant(params, what) {
    if (expectedSecret === null) return;
    if (!params || params.secret !== expectedSecret) {
      throw fakeError('GOOGLE_GRANT_REFUSED', 401,
        `google ${what} refused: the call carries no grant for this calendar`);
    }
  }
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
        // A weekly RRULE without end (backlog:3a3a41b2): the full snapshot
        // expands it into single occurrences inside the read window, the
        // way Google answers `singleEvents=true` — so a series without
        // end never reads as one infinite row.
        ...(Array.isArray(event?.recurrence)
          && event.recurrence.every((line) => typeof line === 'string' && line.length <= 256)
          ? { recurrence: Object.freeze([...event.recurrence]) } : {}),
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
     * events ending after the instant, `timeMax` to events starting
     * before it; `showDeleted` adds tombstones). A bound reads as absent
     * when undefined, null or '' — the same contract as the HTTP
     * provider — and a non-empty bound must read as an instant, or the
     * read refuses with `GOOGLE_CALL_MALFORMED` on both providers. A
     * seeded endless weekly series expands to its single occurrences
     * inside the window only (backlog:3a3a41b2) — without both bounds
     * the master reads as one row, the way an unbounded Google query
     * would. When the expansion cap cuts the window the answer carries
     * `truncated: true` instead of a silent short page.
     */
    listEvents({ calendarId, syncToken, timeMin, timeMax, showDeleted = false, secret } = {}) {
      requireGrant({ secret }, 'listEvents');
      const cal = calendar(calendarId);
      const minMs = boundOrAbsent(timeMin, 'timeMin');
      const maxMs = boundOrAbsent(timeMax, 'timeMax');
      if (syncToken !== undefined) {
        if (Number.isFinite(minMs) || Number.isFinite(maxMs)) {
          throw fakeError('GOOGLE_CALL_MALFORMED', 422,
            'google listEvents refuses time bounds beside a syncToken: resume without bounds');
        }
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
      const items = [];
      let truncated = false;
      for (const event of cal.events.values()) {
        if (event.status === 'cancelled' && !showDeleted) continue;
        const expanded = expandWeeklySeries(event, minMs, maxMs);
        if (expanded !== null) {
          for (const instance of expanded.instances) items.push(instance);
          if (expanded.truncated) truncated = true;
          continue;
        }
        if (Number.isFinite(minMs)) {
          const endMs = Date.parse(event?.end?.dateTime ?? '');
          if (Number.isFinite(endMs) && endMs <= minMs) continue;
        }
        if (Number.isFinite(maxMs)) {
          const startMs = Date.parse(event?.start?.dateTime ?? '');
          if (Number.isFinite(startMs) && startMs >= maxMs) continue;
        }
        items.push(snapshot(event));
      }
      return Object.freeze({
        items: Object.freeze(items),
        nextSyncToken: tokenFor(cal),
        ...(truncated ? { truncated: true } : {}),
      });
    },

    /**
     * Find a live event by the round-trip property the export writes
     * (`extendedProperties.accordoSourceKey`). The sync reconciles with
     * this before inserting, so a retry after a lost link never inserts
     * a second event — the provider-side half of export idempotency.
     *
     * Call shape: one object `{ calendarId, sourceKey, secret }` — the
     * same object-plus-call-time-secret shape every provider method
     * takes (see the provider contract in sync.js). The old positional
     * shape `(calendarId, sourceKey)` is still accepted and mapped onto
     * it, so an old caller reconciles instead of inserting a duplicate;
     * anything else refuses loudly instead of returning a silent null.
     */
    findByAccordoSourceKey(first = {}, second, third) {
      let calendarId;
      let sourceKey;
      let secret;
      if (typeof first === 'string') {
        calendarId = first;
        sourceKey = second;
        secret = third !== undefined && typeof third === 'object' && third !== null ? third.secret : undefined;
      } else if (first !== null && typeof first === 'object') {
        ({ calendarId, sourceKey, secret } = first);
      } else {
        throw fakeError('GOOGLE_CALL_MALFORMED', 422, 'findByAccordoSourceKey needs { calendarId, sourceKey }');
      }
      if (typeof calendarId !== 'string' || typeof sourceKey !== 'string') {
        throw fakeError('GOOGLE_CALL_MALFORMED', 422, 'findByAccordoSourceKey needs { calendarId, sourceKey }');
      }
      requireGrant({ secret }, 'findByAccordoSourceKey');
      for (const event of calendar(calendarId).events.values()) {
        if (event.status !== 'cancelled' && event.extendedProperties?.accordoSourceKey === sourceKey) {
          return snapshot(event);
        }
      }
      return null;
    },

    /** Provider-side insert (the push direction lands here). */
    insertEvent({ calendarId, summary, description = '', start, end, extendedProperties = {}, id, secret } = {}) {
      requireGrant({ secret }, 'insertEvent');
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
    cancelEvent({ calendarId, eventId, secret } = {}) {
      requireGrant({ secret }, 'cancelEvent');
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
