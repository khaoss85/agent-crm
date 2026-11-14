// @ts-check

/**
 * Real Google Calendar provider over HTTP (backlog:d1da1ed51e9c).
 *
 * The same four provider functions the sync engine needs
 * (`listEvents`, `findByAccordoSourceKey`, `insertEvent`, `cancelEvent` —
 * the contract `createCalendarSyncOperations` checks), spoken against the
 * Google Calendar v3 REST API instead of the in-memory fake. The transport
 * is injected (`fetchImpl`), so tests prove the mapping against a fake
 * HTTP layer and production passes the platform's authenticated fetch:
 * no test dials Google, no credential is stored or invented here.
 *
 * Auth: every call carries the call-time `secret` the engine resolved
 * from the space grant in the vault — it travels only as an
 * `Authorization: Bearer` header. Without it the call refuses with
 * GOOGLE_GRANT_REFUSED, the same signal the fake gives an unwired
 * composition.
 *
 * Error discipline (the same as the engine's): a provider failure never
 * travels with provider text — the code rides with a fixed message, so
 * no grant, token or personal detail lands in a row, an error or a log.
 * The expired sync token (HTTP 410) keeps its code so the engine runs
 * the full reconcile instead of guessing.
 */

export const GOOGLE_CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3';

const EVENT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function httpError(code, status, message) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function assertSecret(secret, what) {
  if (typeof secret !== 'string' || secret === '') {
    throw httpError('GOOGLE_GRANT_REFUSED', 401,
      `google ${what} refused: the call carries no grant for this calendar`);
  }
  return secret;
}

function assertCalendarId(calendarId) {
  if (typeof calendarId !== 'string' || calendarId.trim() === '' || calendarId.length > 256) {
    throw httpError('GOOGLE_CALL_MALFORMED', 422, 'google call needs a bounded calendarId');
  }
  return calendarId;
}

/**
 * Flatten Google's namespaced extended properties onto the flat shape the
 * sync engine reads (`extendedProperties.accordoSourceKey`): private first,
 * then shared, neither mutating the other.
 *
 * Attendees and the organizer ARE carried (backlog:1f15c248fc05): the
 * deployment mapping (`mapping.subjectForEvent`) links each imported event
 * to the customer whose email appears among them, so dropping them skips
 * every real event in production. Only the matching fields travel —
 * `email`, `displayName`, `responseStatus` — each bounded and frozen, plus
 * Google's `self` flag when true (backlog:13c09f03): it marks the calendar
 * owner's own attendee entry, so the lead resolver can exclude it instead
 * of booking the owner as their own customer. A room's `resource` flag
 * rides along too, so the resolver can tell a meeting room (never a lead)
 * apart from a guest. Everything else on the wire
 * (creator, htmlLink, reminders) stays out. The copy is
 * faithful, never normalized: lowercasing and phone matching belong to
 * the consumer. Beyond ATTENDEES_MAX entries the list stops: the excess
 * degrades to a skip, never to a link against the wrong customer.
 */

const ATTENDEE_EMAIL_MAX = 320;
const ATTENDEE_NAME_MAX = 256;
const ATTENDEES_MAX = 200;
const ATTENDEE_RESPONSE_STATUSES = Object.freeze(new Set(['needsAction', 'declined', 'tentative', 'accepted']));

/** One Google attendee/organizer entry reduced to the matching fields the engine reads. Null when unusable. */
function toEnginePerson(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const person = {};
  if (typeof raw.email === 'string' && raw.email !== '' && raw.email.length <= ATTENDEE_EMAIL_MAX) {
    person.email = raw.email;
  }
  if (typeof raw.displayName === 'string' && raw.displayName !== '' && raw.displayName.length <= ATTENDEE_NAME_MAX) {
    person.displayName = raw.displayName;
  }
  if (typeof raw.responseStatus === 'string' && ATTENDEE_RESPONSE_STATUSES.has(raw.responseStatus)) {
    person.responseStatus = raw.responseStatus;
  }
  if (raw.self === true && typeof person.email === 'string') {
    person.self = true;
  }
  if (raw.resource === true) {
    person.resource = true;
  }
  return Object.keys(person).length === 0 ? null : Object.freeze(person);
}

export function toEngineEvent(wire) {
  if (!wire || typeof wire !== 'object' || Array.isArray(wire)) {
    throw httpError('GOOGLE_EVENT_MALFORMED', 502, 'google returned an unreadable event');
  }
  const id = wire.id;
  if (typeof id !== 'string' || !EVENT_ID_RE.test(id)) {
    throw httpError('GOOGLE_EVENT_MALFORMED', 502, 'google returned an event without a bounded id');
  }
  const extended = wire.extendedProperties;
  const flat = {
    ...((extended && typeof extended === 'object' && !Array.isArray(extended) && extended.shared
      && typeof extended.shared === 'object' && !Array.isArray(extended.shared)) ? extended.shared : {}),
    ...((extended && typeof extended === 'object' && !Array.isArray(extended) && extended.private
      && typeof extended.private === 'object' && !Array.isArray(extended.private)) ? extended.private : {}),
  };
  const rawAttendees = Array.isArray(wire.attendees) ? wire.attendees.slice(0, ATTENDEES_MAX) : [];
  const attendees = [];
  for (const raw of rawAttendees) {
    const person = toEnginePerson(raw);
    if (person !== null) attendees.push(person);
  }
  // An expanded occurrence carries its series identity
  // (`recurringEventId`, backlog:3a3a41b2): the fake emits it, so the
  // HTTP read carries the same shape — grouping by series works on
  // production exactly as proven against the fake. A missing or
  // unbounded value stays absent, never a guessed link.
  const recurring = typeof wire.recurringEventId === 'string' && EVENT_ID_RE.test(wire.recurringEventId)
    ? { recurringEventId: wire.recurringEventId }
    : {};
  return Object.freeze({
    id,
    ...recurring,
    summary: typeof wire.summary === 'string' ? wire.summary : '',
    description: typeof wire.description === 'string' ? wire.description : '',
    start: wire.start ?? null,
    end: wire.end ?? null,
    status: wire.status === 'cancelled' ? 'cancelled' : 'confirmed',
    updated: typeof wire.updated === 'string' ? wire.updated : new Date().toISOString(),
    extendedProperties: Object.freeze({ ...flat }),
    organizer: toEnginePerson(wire.organizer),
    attendees: Object.freeze(attendees),
  });
}

/**
 * Map one failed Google HTTP round-trip onto a coded error with a fixed
 * message. The body is read for the status only and never quoted, so a
 * grant, token or personal detail echoed by Google cannot leak.
 */
async function mapHttpFailure(response, what) {
  const status = Number.isSafeInteger(response?.status) ? response.status : 502;
  if (status === 410) {
    throw httpError('GOOGLE_SYNC_TOKEN_INVALID', 410,
      'google sync token expired or unknown: run a full reconcile instead of guessing');
  }
  if (status === 404) {
    throw httpError('GOOGLE_EVENT_UNKNOWN', 404,
      `google calendar ${what} found nothing at that address`);
  }
  if (status === 409) {
    throw httpError('GOOGLE_EVENT_CONFLICT', 409,
      `google calendar ${what} conflicts with an event that already exists`);
  }
  if (status === 401 || status === 403) {
    throw httpError('GOOGLE_GRANT_REFUSED', status,
      `google calendar ${what} refused: the grant is missing, expired or revoked`);
  }
  if (status === 429) {
    throw httpError('GOOGLE_RATE_LIMITED', 429,
      `google calendar ${what} is rate limited: retry the sync later`);
  }
  throw httpError('CALENDAR_PROVIDER_UNAVAILABLE', status >= 400 && status < 600 ? status : 502,
    `google calendar ${what} failed without provider detail: retry the sync`);
}

async function readJson(response) {
  try {
    const body = await response.json();
    return body && typeof body === 'object' ? body : {};
  } catch {
    throw httpError('GOOGLE_EVENT_MALFORMED', 502, 'google returned an unreadable response');
  }
}

/**
 * Build the real provider.
 *
 * @param {{ fetchImpl: (url: string, init?: any) => Promise<any>, baseUrl?: string, now?: () => string }} options
 * `fetchImpl` is the HTTP layer (undici/global fetch in production, a
 * scripted double in tests). Required: without a transport the factory
 * refuses instead of composing a provider that cannot call.
 */
export function createHttpGoogleCalendar(options = {}) {
  const fetchImpl = options.fetchImpl;
  if (typeof fetchImpl !== 'function') {
    throw httpError('CALENDAR_SYNC_CONTEXT_INVALID', 500,
      'http google calendar needs a fetchImpl transport: pass fetch or a test double');
  }
  const baseUrl = typeof options.baseUrl === 'string' && options.baseUrl !== ''
    ? options.baseUrl.replace(/\/+$/, '')
    : GOOGLE_CALENDAR_API_BASE;
  if (!/^https:\/\/[a-zA-Z0-9][a-zA-Z0-9._:\/-]{0,200}$/.test(baseUrl)) {
    throw httpError('CALENDAR_SYNC_CONTEXT_INVALID', 500, 'http google calendar baseUrl must be a bounded https URL');
  }
  const now = typeof options.now === 'function' ? options.now : () => new Date().toISOString();

  function headers(secret) {
    return { Authorization: `Bearer ${secret}`, Accept: 'application/json' };
  }

  async function get(path, query, secret, what) {
    const url = `${baseUrl}${path}${query ? `?${query}` : ''}`;
    let response;
    try {
      response = await fetchImpl(url, { method: 'GET', headers: headers(secret) });
    } catch {
      throw httpError('CALENDAR_PROVIDER_UNAVAILABLE', 502,
        `google calendar ${what} is unreachable: retry the sync`);
    }
    if (!response || response.ok !== true) await mapHttpFailure(response, what);
    return readJson(response);
  }

  async function write(method, path, secret, what, body) {
    const url = `${baseUrl}${path}`;
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: { ...headers(secret), 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
    } catch {
      throw httpError('CALENDAR_PROVIDER_UNAVAILABLE', 502,
        `google calendar ${what} is unreachable: retry the sync`);
    }
    if (response !== undefined && response !== null && response.status === 204) return {};
    if (!response || response.ok !== true) await mapHttpFailure(response, what);
    return readJson(response);
  }

  return {
    /**
     * List events. With `syncToken`: only what changed since, plus
     * `nextSyncToken` (Google refuses time bounds beside a sync token).
     * Without: the full snapshot (`timeMin`/`timeMax` bound it,
     * `showDeleted` adds tombstones) — the same page shape as the fake.
     * Both bounds together keep an endless recurrence readable: with
     * `singleEvents` Google expands only the occurrences inside the
     * window instead of the whole infinite series (backlog:3a3a41b2).
     */
    async listEvents({ calendarId, syncToken, timeMin, timeMax, showDeleted = false, secret } = {}) {
      assertSecret(secret, 'listEvents');
      const id = assertCalendarId(calendarId);
      const params = new URLSearchParams();
      // A bound is present only as a non-empty string: undefined, null
      // and '' all mean "no bound" on both providers (backlog:3a3a41b2),
      // so an optional field forwarded as null never 422s. Anything else
      // must read as an instant, or the call refuses on both providers.
      const boundOrAbsent = (value, name) => {
        if (value === undefined || value === null || value === '') return undefined;
        if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
          throw httpError('GOOGLE_CALL_MALFORMED', 422, `google listEvents needs a readable ${name} instant when bounding`);
        }
        return value;
      };
      const from = boundOrAbsent(timeMin, 'timeMin');
      const to = boundOrAbsent(timeMax, 'timeMax');
      if (syncToken !== undefined) {
        if (typeof syncToken !== 'string' || syncToken === '') {
          throw httpError('GOOGLE_CALL_MALFORMED', 422, 'google listEvents needs a bounded syncToken when resuming');
        }
        if (from !== undefined || to !== undefined) {
          throw httpError('GOOGLE_CALL_MALFORMED', 422, 'google listEvents refuses time bounds beside a syncToken: resume without bounds');
        }
        params.set('syncToken', syncToken);
      } else {
        if (from !== undefined) params.set('timeMin', from);
        if (to !== undefined) params.set('timeMax', to);
        params.set('singleEvents', 'true');
        params.set('maxResults', '2500');
      }
      if (showDeleted) params.set('showDeleted', 'true');
      // Google pages below maxResults and only stamps nextSyncToken on
      // the final page: follow every pageToken with the same query and
      // combine the events, or an import would miss appointments and an
      // incremental pull would persist an undefined cursor. The walk
      // stays bounded: a provider answering page tokens forever refuses
      // instead of hanging a run with no timeout above it.
      const LIST_PAGES_MAX = 50;
      const items = [];
      let nextSyncToken;
      let pageToken;
      for (let seen = 0; ; seen += 1) {
        if (seen >= LIST_PAGES_MAX) {
          throw httpError('CALENDAR_PROVIDER_UNAVAILABLE', 502,
            'google calendar listEvents returned too many pages: retry the sync');
        }
        if (pageToken !== undefined) params.set('pageToken', pageToken);
        else params.delete('pageToken');
        const body = await get(`/calendars/${encodeURIComponent(id)}/events`, params.toString(), secret, 'listEvents');
        for (const wire of (Array.isArray(body.items) ? body.items : [])) items.push(toEngineEvent(wire));
        if (typeof body.nextSyncToken === 'string') nextSyncToken = body.nextSyncToken;
        pageToken = typeof body.nextPageToken === 'string' && body.nextPageToken !== ''
          ? body.nextPageToken
          : undefined;
        if (pageToken === undefined) break;
      }
      return Object.freeze({ items: Object.freeze(items), ...(nextSyncToken === undefined ? {} : { nextSyncToken }) });
    },

    /**
     * Find the live event carrying the round-trip property the export
     * writes (`extendedProperties.private.accordoSourceKey`), so a retry
     * after a lost link reconciles instead of inserting a duplicate —
     * the provider-side half of export idempotency, like the fake's
     * `findByAccordoSourceKey`.
     */
    async findByAccordoSourceKey({ calendarId, sourceKey, secret } = {}) {
      assertSecret(secret, 'findByAccordoSourceKey');
      const id = assertCalendarId(calendarId);
      if (typeof sourceKey !== 'string' || sourceKey === '' || sourceKey.length > 256) {
        throw httpError('GOOGLE_CALL_MALFORMED', 422, 'findByAccordoSourceKey needs { calendarId, sourceKey }');
      }
      const params = new URLSearchParams();
      params.set('privateExtendedProperty', `accordoSourceKey=${sourceKey}`);
      params.set('singleEvents', 'true');
      params.set('maxResults', '10');
      let body;
      try {
        body = await get(`/calendars/${encodeURIComponent(id)}/events`, params.toString(), secret, 'findByAccordoSourceKey');
      } catch (error) {
        if (error?.code === 'GOOGLE_EVENT_UNKNOWN') return null;
        throw error;
      }
      const items = Array.isArray(body.items) ? body.items : [];
      for (const wire of items) {
        const event = toEngineEvent(wire);
        if (event.status !== 'cancelled') return event;
      }
      return null;
    },

    /** Provider-side insert (the push direction lands here). */
    async insertEvent({ calendarId, summary, description = '', start, end, extendedProperties = {}, id, recurrence = null, secret } = {}) {
      assertSecret(secret, 'insertEvent');
      const cal = assertCalendarId(calendarId);
      const lines = recurrence === null || recurrence === undefined ? null : recurrence;
      if (lines !== null && (!Array.isArray(lines) || lines.length === 0 || lines.length > 8
        || lines.some((line) => typeof line !== 'string' || line.length === 0 || line.length > 256))) {
        throw httpError('GOOGLE_CALL_MALFORMED', 422, 'google insertEvent needs a bounded recurrence string array when naming one');
      }
      const body = await write('POST', `/calendars/${encodeURIComponent(cal)}/events`, secret, 'insertEvent', {
        ...(typeof summary === 'string' ? { summary } : {}),
        ...(typeof description === 'string' && description !== '' ? { description } : {}),
        ...(start === undefined || start === null ? {} : { start }),
        ...(end === undefined || end === null ? {} : { end }),
        ...(lines === null ? {} : { recurrence: [...lines] }),
        extendedProperties: { private: { ...extendedProperties } },
        ...(typeof id === 'string' && EVENT_ID_RE.test(id) ? { id } : {}),
      });
      return toEngineEvent(body);
    },

    /**
     * Provider-side cancellation. Already gone (404/410) converges to
     * the same tombstone a delete returns — like the fake, deleting
     * twice is not an error.
     */
    async cancelEvent({ calendarId, eventId, secret } = {}) {
      assertSecret(secret, 'cancelEvent');
      const cal = assertCalendarId(calendarId);
      if (typeof eventId !== 'string' || !EVENT_ID_RE.test(eventId)) {
        throw httpError('GOOGLE_CALL_MALFORMED', 422, 'cancelEvent needs a bounded eventId');
      }
      const url = `${baseUrl}/calendars/${encodeURIComponent(cal)}/events/${encodeURIComponent(eventId)}`;
      let response;
      try {
        response = await fetchImpl(url, { method: 'DELETE', headers: headers(secret) });
      } catch {
        throw httpError('CALENDAR_PROVIDER_UNAVAILABLE', 502,
          'google calendar cancelEvent is unreachable: retry the sync');
      }
      if (response !== undefined && response !== null && (response.status === 200 || response.status === 204)) {
        return Object.freeze({ id: eventId, status: 'cancelled', updated: now() });
      }
      if (Number.isSafeInteger(response?.status) && (response.status === 404 || response.status === 410)) {
        return Object.freeze({ id: eventId, status: 'cancelled', updated: now() });
      }
      await mapHttpFailure(response, 'cancelEvent');
      return Object.freeze({ id: eventId, status: 'cancelled', updated: now() });
    },
  };
}
