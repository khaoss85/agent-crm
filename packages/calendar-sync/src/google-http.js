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
 * then shared, neither mutating the other. Anything else on the wire is
 * not carried — the engine decides on the documented fields only.
 */
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
  return Object.freeze({
    id,
    summary: typeof wire.summary === 'string' ? wire.summary : '',
    description: typeof wire.description === 'string' ? wire.description : '',
    start: wire.start ?? null,
    end: wire.end ?? null,
    status: wire.status === 'cancelled' ? 'cancelled' : 'confirmed',
    updated: typeof wire.updated === 'string' ? wire.updated : new Date().toISOString(),
    extendedProperties: Object.freeze({ ...flat }),
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
     * `nextSyncToken`. Without: the full snapshot (`timeMin` bounds it,
     * `showDeleted` adds tombstones) — the same page shape as the fake.
     */
    async listEvents({ calendarId, syncToken, timeMin, showDeleted = false, secret } = {}) {
      assertSecret(secret, 'listEvents');
      const id = assertCalendarId(calendarId);
      const params = new URLSearchParams();
      if (syncToken !== undefined) {
        if (typeof syncToken !== 'string' || syncToken === '') {
          throw httpError('GOOGLE_CALL_MALFORMED', 422, 'google listEvents needs a bounded syncToken when resuming');
        }
        params.set('syncToken', syncToken);
      } else {
        if (typeof timeMin === 'string' && timeMin !== '') params.set('timeMin', timeMin);
        params.set('singleEvents', 'true');
        params.set('maxResults', '2500');
      }
      if (showDeleted) params.set('showDeleted', 'true');
      const body = await get(`/calendars/${encodeURIComponent(id)}/events`, params.toString(), secret, 'listEvents');
      const items = Array.isArray(body.items) ? body.items.map(toEngineEvent) : [];
      const nextSyncToken = typeof body.nextSyncToken === 'string' ? body.nextSyncToken : undefined;
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
    async insertEvent({ calendarId, summary, description = '', start, end, extendedProperties = {}, id, secret } = {}) {
      assertSecret(secret, 'insertEvent');
      const cal = assertCalendarId(calendarId);
      const body = await write('POST', `/calendars/${encodeURIComponent(cal)}/events`, secret, 'insertEvent', {
        ...(typeof summary === 'string' ? { summary } : {}),
        ...(typeof description === 'string' && description !== '' ? { description } : {}),
        ...(start === undefined || start === null ? {} : { start }),
        ...(end === undefined || end === null ? {} : { end }),
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
