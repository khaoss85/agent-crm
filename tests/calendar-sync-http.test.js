import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createDatabase } from '../packages/core/src/database.js';
import { AuditLog } from '../packages/core/src/audit.js';
import { EventBus } from '../packages/core/src/event-bus.js';
import {
  createRecordModuleFromManifest,
  recordModuleMigrations,
} from '../packages/core/src/record-module-runtime.js';
import { createAppointmentBookCapability } from '../packages/appointments/src/appointments.js';
import { createCalendarSyncOperations } from '../packages/calendar-sync/src/sync.js';
import { createHttpGoogleCalendar } from '../packages/calendar-sync/src/google-http.js';

/**
 * Real-provider integration (backlog:d1da1ed51e9c): the same sync engine
 * against `createHttpGoogleCalendar` over a scripted HTTP double that
 * speaks the Google Calendar v3 REST shapes (sync tokens, tombstones,
 * private extended properties, 410 on a stale token). A Google event
 * becomes an appointment, an Accordo booking becomes a Google event, and
 * the status shows the last run, the counts and the coded error.
 * No test dials Google.
 */

const here = dirname(fileURLToPath(import.meta.url));
const manifest = (pkg, name) => JSON.parse(
  readFileSync(join(here, '..', 'packages', pkg, 'modules', `${name}.module.json`), 'utf8'),
);

const ACTOR = { type: 'user', id: 'calendar-http-kit' };
const SUBJECT = { resource: 'contact', id: 'c-presti', owner: 'host', label: 'Presti Group' };
const MEMBER = 'coach-guido';
const SERVICE = { serviceKey: 'pt-single', priceCents: 4000, currency: 'EUR' };
const CAL = 'presti-room-1';
const SPACE = 'presti';
const SECRET_REF = 'vault://presti/google-calendar';
const GRANT = 'oauth-access-token-http-kit';
const T0 = new Date('2026-10-20T08:00:00.000Z').getTime();
const TIME_MIN = '2026-10-20T00:00:00.000Z';

const slot = (day, from, to) => ({
  start: { dateTime: `2026-10-${day}T${from}:00.000Z` },
  end: { dateTime: `2026-10-${day}T${to}:00.000Z` },
});

/**
 * A scripted Google Calendar v3 REST double. Holds live events, a change
 * log for sync tokens, and tombstones — the provider semantics the sync
 * depends on. Refuses without the expected Bearer, expires tokens on
 * demand, and records every request for the tests to inspect.
 */
function createRestDouble({ expectedBearer, nowMs } = {}) {
  const events = new Map();
  const log = [];
  let seq = 0;
  let epoch = 0;
  const requests = [];
  let bearer = expectedBearer ?? GRANT;

  const token = () => `rest-${epoch}-${seq}`;
  const touch = (id) => {
    seq += 1;
    const at = log.findIndex((entry) => entry.eventId === id);
    if (at >= 0) log.splice(at, 1);
    log.push({ seq, eventId: id });
  };
  const checkAuth = (init) => {
    const header = init?.headers?.Authorization ?? init?.headers?.authorization ?? '';
    return typeof header === 'string' && header === `Bearer ${bearer}`;
  };
  const ok = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  const fail = (status, message) => ({
    ok: false,
    status,
    json: async () => ({ error: { code: status, message, errors: [{ message, reason: 'httpDouble' }] } }),
  });

  const wire = (stored) => ({
    id: stored.id,
    summary: stored.summary,
    description: stored.description,
    start: stored.start,
    end: stored.end,
    status: stored.status,
    updated: stored.updated,
    extendedProperties: { private: { ...stored.privateProps } },
  });

  const api = {
    requests,
    setBearer: (next) => { bearer = next; },
    seed(id, { summary = `Session ${id}`, start = null, end = null, privateProps = {} } = {}) {
      const stored = {
        id, summary, description: '', start, end, status: 'confirmed',
        updated: new Date(nowMs()).toISOString(), privateProps: { ...privateProps },
      };
      events.set(id, stored);
      touch(id);
      return stored;
    },
    expireTokens() { epoch += 1; },
    liveCount() { return events.size; },
    async fetch(url, init = {}) {
      requests.push({ url, method: init.method ?? 'GET' });
      if (!checkAuth(init)) return fail(401, 'login required');
      const parsed = new URL(url, 'https://www.googleapis.com');
      const match = /^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(parsed.pathname);
      if (!match) return fail(404, 'not found');
      const eventId = match[2] === undefined ? null : decodeURIComponent(match[2]);
      const method = (init.method ?? 'GET').toUpperCase();
      if (method === 'DELETE') {
        const live = events.get(eventId);
        if (!live || live.status === 'cancelled') return fail(410, 'gone');
        const next = { ...live, status: 'cancelled', updated: new Date(nowMs()).toISOString() };
        events.set(eventId, next);
        touch(eventId);
        return ok({});
      }
      if (method === 'POST' && eventId === null) {
        const body = JSON.parse(init.body ?? '{}');
        if (typeof body.id === 'string' && body.id !== '' && events.has(body.id)) {
          return fail(409, 'already exists');
        }
        const id = typeof body.id === 'string' && body.id !== '' ? body.id : `rest-${seq + 1}`;
        const stored = {
          id,
          summary: typeof body.summary === 'string' ? body.summary : '',
          description: typeof body.description === 'string' ? body.description : '',
          start: body.start ?? null,
          end: body.end ?? null,
          status: 'confirmed',
          updated: new Date(nowMs()).toISOString(),
          privateProps: { ...((body.extendedProperties && body.extendedProperties.private) ?? {}) },
        };
        events.set(id, stored);
        touch(id);
        return ok(wire(stored));
      }
      if (method === 'GET' && eventId !== null) {
        const live = events.get(eventId);
        if (!live) return fail(404, 'not found');
        return ok(wire(live));
      }
      if (method === 'GET' && eventId === null) {
        const params = parsed.searchParams;
        const syncToken = params.get('syncToken');
        if (syncToken !== null) {
          const tokenMatch = /^rest-(\d+)-(\d+)$/.exec(syncToken);
          if (!tokenMatch || Number(tokenMatch[1]) !== epoch) {
            return fail(410, 'sync token expired');
          }
          const since = Number(tokenMatch[2]);
          const items = [];
          for (const { seq: atSeq, eventId: id } of log) {
            if (atSeq <= since) continue;
            const live = events.get(id);
            if (live && live.status !== 'cancelled') items.push(wire(live));
            else items.push({ id, status: 'cancelled', updated: new Date(nowMs()).toISOString() });
          }
          return ok({ items, nextSyncToken: token() });
        }
        const prop = params.get('privateExtendedProperty');
        let all = [...events.values()];
        if (prop !== null) {
          const [name, value] = prop.split('=');
          all = all.filter((live) => live.status !== 'cancelled'
            && String(live.privateProps[name] ?? '') === value);
        }
        if (params.get('showDeleted') !== 'true') {
          all = all.filter((live) => live.status !== 'cancelled');
        }
        const timeMin = params.get('timeMin');
        if (timeMin !== null && timeMin !== '') {
          const minMs = Date.parse(timeMin);
          if (Number.isFinite(minMs)) {
            all = all.filter((live) => Date.parse(live?.end?.dateTime ?? '') > minMs
              || !Number.isFinite(Date.parse(live?.end?.dateTime ?? '')));
          }
        }
        return ok({ items: all.map(wire), nextSyncToken: token() });
      }
      return fail(404, 'not found');
    },
  };
  return api;
}

function setup(options = {}) {
  const double = options.double ?? createRestDouble({ nowMs: () => fakeNow, expectedBearer: GRANT });
  let fakeNow = options.nowMs ?? T0;
  const database = createDatabase({ path: ':memory:' });
  const manifests = [
    { name: 'appointment', manifest: manifest('appointments', 'appointment') },
    { name: 'calendar-link', manifest: manifest('calendar-sync', 'calendar-link') },
    { name: 'calendar-sync-state', manifest: manifest('calendar-sync', 'calendar-sync-state') },
  ];
  for (const { sql } of recordModuleMigrations(manifests)) database.raw.exec(sql);
  const audit = new AuditLog(database);
  const events = new EventBus();
  const modules = new Map();
  for (const { name, manifest: body } of manifests) {
    modules.set(name, { service: createRecordModuleFromManifest(body, { database, audit, events, references: {} }).service });
  }
  const provider = createHttpGoogleCalendar({
    fetchImpl: (...args) => double.fetch(...args),
    now: () => new Date(fakeNow).toISOString(),
  });
  const resolveCalls = [];
  const resolveSecret = async (ref) => {
    resolveCalls.push(ref);
    if (ref !== SECRET_REF) {
      const error = new Error('unknown secret reference');
      error.code = 'SECRET_NOT_FOUND';
      throw error;
    }
    return options.grantValue === undefined ? GRANT : options.grantValue;
  };
  const appointmentBook = createAppointmentBookCapability({});
  const mapping = {
    subjectForEvent: () => ({ ...SUBJECT }),
    teamMemberForCalendar: () => MEMBER,
    serviceForEvent: () => ({ ...SERVICE }),
    summaryForAppointment: (row) => `Appointment ${row.serviceKey} ${row.startsAt}`,
  };
  const sync = createCalendarSyncOperations({
    modules, appointmentBook, provider, mapping, database,
    actor: ACTOR, now: () => new Date(fakeNow).toISOString(), resolveSecret,
  });
  return {
    database, modules, provider, sync, double, resolveCalls,
    rows: () => ({
      appointments: [...modules.get('appointment').service.listWhere({})],
      links: [...modules.get('calendar-link').service.listWhere({})],
      states: [...modules.get('calendar-sync-state').service.listWhere({})],
    }),
    setNow: (ms) => { fakeNow = ms; },
    close: () => database.close(),
  };
}

async function bound(ctx, ref = SECRET_REF) {
  return ctx.sync.bindCalendarGrant({ spaceId: SPACE, calendarId: CAL, secretRef: ref, actor: ACTOR });
}

function bookLocal(ctx, sourceKey, day, from, to) {
  const handle = createAppointmentBookCapability({}).create({ modules: ctx.modules, actor: ACTOR, consumer: 'calendar-sync' });
  return handle.bookAppointment({
    sourceKey,
    subject: { ...SUBJECT },
    teamMemberId: MEMBER,
    ...SERVICE,
    startsAt: `2026-10-${day}T${from}:00.000Z`,
    endsAt: `2026-10-${day}T${to}:00.000Z`,
    source: { package: 'calendar-sync', action: 'book' },
  });
}

test('a Google event becomes an appointment, and a second import changes nothing', async (t) => {
  const ctx = setup();
  t.after(() => ctx.close());
  await bound(ctx);
  ctx.double.seed('evt1', { ...slot('21', '09:00', '10:00') });
  ctx.double.seed('evt2', { ...slot('21', '11:00', '12:00') });
  const first = await ctx.sync.importFuture(CAL, { spaceId: SPACE, timeMin: TIME_MIN });
  assert.equal(first.entries.filter((e) => e.status === 'imported').length, 2);
  assert.equal(ctx.rows().appointments.length, 2, 'two Google events, two appointments');
  const again = await ctx.sync.importFuture(CAL, { spaceId: SPACE, timeMin: TIME_MIN });
  assert.equal(ctx.rows().appointments.length, 2, 'no duplicate on re-run');
  assert.ok(again.entries.every((e) => e.status === 'already-tracked'));
  const post = ctx.double.requests.find((r) => r.method === 'POST');
  assert.equal(post, undefined, 'no provider write on a no-op re-run');
});

test('an Accordo booking becomes a Google event with the round-trip key', async (t) => {
  const ctx = setup();
  t.after(() => ctx.close());
  await bound(ctx);
  await ctx.sync.importFuture(CAL, { spaceId: SPACE, timeMin: TIME_MIN });
  const { appointment } = await bookLocal(ctx, 'gym:local:1', '22', '09:00', '10:00');
  const pushed = await ctx.sync.pushAppointment(CAL, appointment.sourceKey, { spaceId: SPACE });
  assert.equal(pushed.status, 'exported');
  assert.ok(pushed.eventId, 'the provider named the event');
  const post = ctx.double.requests.find((r) => r.method === 'POST');
  assert.ok(post, 'the push spoke REST, not the fake');
  assert.match(post.url, /\/calendars\/presti-room-1\/events$/);
  // A retry after a lost link reconciles instead of inserting a second event.
  const before = ctx.double.liveCount();
  const reconciled = await ctx.provider.findByAccordoSourceKey({
    calendarId: CAL, sourceKey: appointment.sourceKey, secret: GRANT,
  });
  assert.equal(reconciled.id, pushed.eventId);
  assert.equal(ctx.double.liveCount(), before);
});

test('an expired REST token reconciles instead of guessing', async (t) => {
  const ctx = setup();
  t.after(() => ctx.close());
  await bound(ctx);
  ctx.double.seed('evt1', { ...slot('21', '09:00', '10:00') });
  await ctx.sync.importFuture(CAL, { spaceId: SPACE, timeMin: TIME_MIN });
  ctx.double.expireTokens();
  const pull = await ctx.sync.pullIncremental(CAL, { spaceId: SPACE });
  assert.equal(pull.recovered, true, '410 becomes a full reconcile');
  assert.equal(ctx.rows().appointments.length, 1, 'no duplicate after recovery');
});

test('the status shows the last run, the counts and the coded error', async (t) => {
  const ctx = setup();
  t.after(() => ctx.close());
  await bound(ctx);
  const fresh = await ctx.sync.readSyncStatus({ spaceId: SPACE, calendarId: CAL });
  assert.equal(fresh.bound, true);
  assert.equal(fresh.grantStatus, 'active');
  assert.equal(fresh.hasSyncToken, false);
  assert.equal(fresh.lastRun, null, 'no run yet, no invented history');
  ctx.double.seed('evt1', { ...slot('21', '09:00', '10:00') });
  await ctx.sync.importFuture(CAL, { spaceId: SPACE, timeMin: TIME_MIN });
  const { appointment } = await bookLocal(ctx, 'gym:local:1', '22', '09:00', '10:00');
  await ctx.sync.pushAppointment(CAL, appointment.sourceKey, { spaceId: SPACE });
  const status = await ctx.sync.readSyncStatus({ spaceId: SPACE, calendarId: CAL });
  assert.equal(status.hasSyncToken, true);
  assert.ok(status.lastRun, 'the push recorded a run');
  assert.equal(status.lastRun.error, null);
  assert.equal(status.lastRun.pushed, 1);
  assert.ok(typeof status.lastRun.at === 'string' && status.lastRun.at !== '');
  // A failed run records its code and keeps the earlier binding facts.
  ctx.double.setBearer('revoked-elsewhere');
  const failure = await ctx.sync.pullIncremental(CAL, { spaceId: SPACE }).then(
    () => { throw new Error('pull should have refused'); },
    (error) => error,
  );
  assert.equal(failure.code, 'GOOGLE_GRANT_REFUSED');
  const failed = await ctx.sync.readSyncStatus({ spaceId: SPACE, calendarId: CAL });
  assert.equal(failed.lastRun.error, 'GOOGLE_GRANT_REFUSED');
  assert.equal(failed.bound, true, 'the binding row is untouched by a failed run');
  const dump = JSON.stringify(ctx.rows());
  assert.ok(!dump.includes(GRANT), 'the Bearer never lands in a row');
});

test('a foreign space reads the status as unknown, the owner still reads it revoked', async (t) => {
  const ctx = setup();
  t.after(() => ctx.close());
  await bound(ctx);
  await assert.rejects(
    ctx.sync.readSyncStatus({ spaceId: 'altro-spazio', calendarId: CAL }),
    (error) => error?.code === 'CALENDAR_GRANT_UNKNOWN',
  );
  await ctx.sync.revokeCalendarGrant({ spaceId: SPACE, calendarId: CAL, actor: ACTOR });
  const revoked = await ctx.sync.readSyncStatus({ spaceId: SPACE, calendarId: CAL });
  assert.equal(revoked.grantStatus, 'revoked', 'the owner inspects the revoked grant with no provider call');
  assert.equal(revoked.bound, true, 'the binding row survives the revoke');
  await assert.rejects(
    ctx.sync.readSyncStatus({ spaceId: 'altro-spazio', calendarId: CAL }),
    (error) => error?.code === 'CALENDAR_GRANT_UNKNOWN',
  );
});

test('without the grant the provider refuses and the status says unbound', async (t) => {
  const ctx = setup();
  t.after(() => ctx.close());
  const status = await ctx.sync.readSyncStatus({ spaceId: SPACE, calendarId: CAL });
  assert.equal(status.bound, false);
  assert.equal(status.grantStatus, 'unbound');
  assert.equal(status.lastRun, null);
  await assert.rejects(
    ctx.provider.listEvents({ calendarId: CAL, secret: '' }),
    (error) => error?.code === 'GOOGLE_GRANT_REFUSED',
  );
});

test('listEvents bounds the snapshot with timeMax, never beside a sync token', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => ({ items: [] }) };
  };
  const provider = createHttpGoogleCalendar({ fetchImpl });
  const TIME_MAX = '2027-01-18T00:00:00.000Z';
  await provider.listEvents({ calendarId: CAL, secret: GRANT, timeMin: TIME_MIN, timeMax: TIME_MAX });
  const params = new URL(calls[0], 'https://www.googleapis.com').searchParams;
  assert.equal(params.get('timeMin'), TIME_MIN);
  assert.equal(params.get('timeMax'), TIME_MAX);
  assert.equal(params.get('singleEvents'), 'true', 'recurrences expand inside the window only');
  await assert.rejects(
    provider.listEvents({ calendarId: CAL, secret: GRANT, syncToken: 'rest-0-1', timeMax: TIME_MAX }),
    (error) => error?.code === 'GOOGLE_CALL_MALFORMED',
    'Google refuses time bounds beside a sync token',
  );
  await assert.rejects(
    provider.listEvents({ calendarId: CAL, secret: GRANT, syncToken: 'rest-0-1', timeMin: TIME_MIN }),
    (error) => error?.code === 'GOOGLE_CALL_MALFORMED',
    'timeMin beside a sync token refuses too',
  );
  await assert.rejects(
    provider.listEvents({ calendarId: CAL, secret: GRANT, timeMax: 'not-an-instant' }),
    (error) => error?.code === 'GOOGLE_CALL_MALFORMED',
  );
  await assert.rejects(
    provider.listEvents({ calendarId: CAL, secret: GRANT, timeMin: 'not-an-instant' }),
    (error) => error?.code === 'GOOGLE_CALL_MALFORMED',
  );
});

test('listEvents follows every result page and keeps the final sync token', async () => {
  const calls = [];
  const wire = (id) => ({ id, status: 'confirmed', updated: '2026-10-21T09:00:00.000Z' });
  const page = (items, extra) => ({
    ok: true, status: 200, json: async () => ({ items, ...extra }),
  });
  const fetchImpl = async (url) => {
    calls.push(url);
    const params = new URL(url, 'https://www.googleapis.com').searchParams;
    if (params.get('pageToken') === null) return page([wire('evt-page-1')], { nextPageToken: 'second' });
    return page([wire('evt-page-2')], { nextSyncToken: 'rest-0-2' });
  };
  const provider = createHttpGoogleCalendar({ fetchImpl });
  const listed = await provider.listEvents({ calendarId: CAL, secret: GRANT, timeMin: TIME_MIN });
  assert.deepEqual(listed.items.map((event) => event.id), ['evt-page-1', 'evt-page-2']);
  assert.equal(listed.nextSyncToken, 'rest-0-2', 'the token rides on the final page only');
  assert.ok(calls.length === 2 && calls[1].includes('pageToken=second'), 'the same query continues the pages');
});

test('the factory refuses without a transport, and the grant never travels in text', async (t) => {
  assert.throws(
    () => createHttpGoogleCalendar({}),
    (error) => error?.code === 'CALENDAR_SYNC_CONTEXT_INVALID',
  );
  assert.throws(
    () => createHttpGoogleCalendar({ fetchImpl: async () => ({}), baseUrl: 'http://plain.example/x' }),
    (error) => error?.code === 'CALENDAR_SYNC_CONTEXT_INVALID',
  );
  const refusing = async () => ({ ok: false, status: 500, json: async () => ({ error: { message: `leak ${GRANT}` } }) });
  const provider = createHttpGoogleCalendar({ fetchImpl: refusing });
  const failure = await provider.listEvents({ calendarId: CAL, secret: GRANT }).then(
    () => { throw new Error('list should have failed'); },
    (error) => error,
  );
  assert.equal(failure.code, 'CALENDAR_PROVIDER_UNAVAILABLE');
  assert.ok(!String(failure.message).includes(GRANT), 'fixed message, never provider text');
});
