import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  cancelAppointment,
  rescheduleAppointment,
} from '../packages/appointments/src/appointments.js';
import { AppError, NotFoundError, ValidationError } from '../packages/core/index.js';
import { createDatabase } from '../packages/core/src/database.js';
import { AuditLog } from '../packages/core/src/audit.js';
import { EventBus } from '../packages/core/src/event-bus.js';
import {
  createRecordModuleFromManifest,
  recordModuleMigrations,
} from '../packages/core/src/record-module-runtime.js';
import { createAppointmentBookCapability } from '../packages/appointments/src/appointments.js';
import { createCalendarSyncOperations } from '../packages/calendar-sync/src/sync.js';
import { createFakeGoogleCalendar } from '../packages/calendar-sync/src/google-fake.js';

/**
 * Series scope (backlog:6acf0a73bfc3): «solo questo / questo e i successivi
 * / tutti» on reschedule and cancel. A series linked to Google refuses 409
 * with an Italian message before the first grid write — one occurrence can
 * never cancel or move the whole Google series behind the grid — while a
 * local-only series converges grid-only. Missing spaceId refuses before any
 * lookup, never as «solo locale».
 */

const ACTOR = { type: 'user', id: 'operator' };
const SUBJECT = { resource: 'contact', id: 'c-presti', owner: 'host' };
const SPACE = 's-presti';
const OTHER_SPACE = 's-arvo';

const occurrence = (index, overrides = {}) => ({
  id: `a-${index + 1}`,
  sourceKey: `gym:serie:1:${index}`,
  subjectResource: SUBJECT.resource,
  subjectId: SUBJECT.id,
  subjectOwner: SUBJECT.owner,
  subjectOwnerPackage: null,
  teamMemberId: 'coach-guido',
  serviceKey: 'pt-single',
  priceCents: 4000,
  currency: 'EUR',
  startsAt: `2026-10-20T${String(17 + index).padStart(2, '0')}:00:00.000Z`,
  endsAt: `2026-10-20T${String(18 + index).padStart(2, '0')}:00:00.000Z`,
  notes: null,
  status: 'booked',
  seriesKey: 'serie:1',
  occurrenceIndex: index,
  ...overrides,
});

const seriesRows = (overrides = []) => [occurrence(0, overrides[0]), occurrence(1, overrides[1]), occurrence(2, overrides[2])];

function fakeAppointments(seed = []) {
  const rows = seed.map((entry) => ({ ...entry }));
  const writes = [];
  return {
    rows,
    writes,
    async listWhere(where) {
      return rows.filter((candidate) => Object.entries(where).every(([key, value]) => candidate[key] === value));
    },
    async createManaged(entry) {
      const stored = { id: `a-${rows.length + 1}`, ...entry };
      rows.push(stored);
      return stored;
    },
    async applyManaged(id, patch) {
      const found = rows.find((candidate) => candidate.id === id);
      if (!found) throw new NotFoundError(`appointment ${id} not found`);
      writes.push({ id, patch: { ...patch } });
      Object.assign(found, patch);
      return found;
    },
    async get(id) {
      const found = rows.find((candidate) => candidate.id === id);
      if (!found) throw new NotFoundError(`appointment ${id} not found`);
      return found;
    },
  };
}

const modulesFor = (service) => ({
  get: (name) => {
    if (name === 'appointment') return { service };
    throw new NotFoundError(`module ${name} not found`);
  },
});

/**
 * The probe behind a linked series: the keys in `linked` behave like rows
 * with a Google sync link owned by `space`. A foreign space throws the same
 * grant refusal the real probe raises, so the grid never mutates alone.
 */
function fakeCalendarSync({ linked = [], space = SPACE } = {}) {
  const calls = { probe: [], push: [], detail: 0 };
  const linkedSet = new Set(linked);
  return {
    calls,
    async seriesScopeLink(sourceKey, { spaceId } = {}) {
      calls.probe.push({ sourceKey, spaceId });
      if (typeof spaceId !== 'string' || spaceId.trim() === '') {
        throw new ValidationError('spaceId is required: a scoped series probe is gated on the space switch', {
          field: 'spaceId',
        });
      }
      if (spaceId !== space) {
        throw new AppError(`calendar "cal-1" has no grant for this space: bind it before syncing`, {
          code: 'CALENDAR_GRANT_UNKNOWN', status: 404,
        });
      }
      return linkedSet.has(sourceKey) ? { linked: true, calendarId: 'cal-1' } : { linked: false };
    },
    async pushAppointment() {
      calls.push.push(Array.from(arguments));
      return { status: 'pushed' };
    },
    async readAppointmentDetail() {
      calls.detail += 1;
      return { sync: null };
    },
  };
}

const contextFor = (service, calendarSync, overrides = {}) => ({
  modules: modulesFor(service),
  actor: ACTOR,
  now: () => '2026-10-19T09:00:00.000Z',
  consumer: 'host',
  calendarSync,
  ...overrides,
});

const shiftDay = (iso) => new Date(Date.parse(iso) + 24 * 60 * 60 * 1000).toISOString();

async function rejectsWith(promise, check) {
  let error = null;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  assert.ok(error, 'the scoped write must refuse');
  check(error);
  return error;
}

test('reschedule: a linked series refuses single scope with 409 and writes nothing', async () => {
  const service = fakeAppointments(seriesRows());
  const calendarSync = fakeCalendarSync({ linked: ['gym:serie:1:0'] });
  const before = service.rows.map((row) => ({ ...row }));
  const error = await rejectsWith(
    rescheduleAppointment(
      contextFor(service, calendarSync),
      {
        id: 'a-2', startsAt: '2026-10-21T18:00:00.000Z', endsAt: '2026-10-21T19:00:00.000Z',
        scope: 'single', spaceId: SPACE,
      },
    ),
    (caught) => {
      assert.equal(caught.code, 'APPOINTMENTS_SERIES_SCOPE_GOOGLE');
      assert.equal(caught.status, 409);
      assert.match(caught.message, /Google Calendar/);
    },
  );
  assert.equal(error.details.scope, 'single');
  assert.deepEqual(service.rows, before, 'the grid is unchanged');
  assert.equal(service.writes.length, 0);
  assert.equal(calendarSync.calls.push.length, 0, 'Google is never touched');
});

test('reschedule: a linked series refuses following and all scopes with 409 and writes nothing', async () => {
  for (const scope of ['following', 'all']) {
    const service = fakeAppointments(seriesRows());
    const calendarSync = fakeCalendarSync({ linked: ['gym:serie:1:0'] });
    const before = service.rows.map((row) => ({ ...row }));
    await rejectsWith(
      rescheduleAppointment(
        contextFor(service, calendarSync),
        {
          id: 'a-1', startsAt: '2026-10-21T17:00:00.000Z', endsAt: '2026-10-21T18:00:00.000Z',
          scope, spaceId: SPACE,
        },
      ),
      (caught) => {
        assert.equal(caught.code, 'APPOINTMENTS_SERIES_SCOPE_GOOGLE');
        assert.equal(caught.status, 409);
      },
    );
    assert.deepEqual(service.rows, before, `the grid is unchanged for scope ${scope}`);
    assert.equal(service.writes.length, 0);
    assert.equal(calendarSync.calls.push.length, 0);
  }
});

test('reschedule: following on a local series shifts this and the tail, grid-only', async () => {
  const service = fakeAppointments(seriesRows());
  const calendarSync = fakeCalendarSync();
  const out = await rescheduleAppointment(
    contextFor(service, calendarSync),
    {
      id: 'a-2', startsAt: shiftDay('2026-10-20T18:00:00.000Z'), endsAt: shiftDay('2026-10-20T19:00:00.000Z'),
      scope: 'following', spaceId: SPACE,
    },
  );
  assert.equal(out.moved, true);
  assert.equal(out.occurrences.length, 2);
  assert.equal(service.rows[0].startsAt, '2026-10-20T17:00:00.000Z', 'the head stays');
  assert.equal(service.rows[1].startsAt, shiftDay('2026-10-20T18:00:00.000Z'));
  assert.equal(service.rows[2].startsAt, shiftDay('2026-10-20T19:00:00.000Z'));
  assert.equal(out.push, null, 'a scoped write never pushes');
  assert.equal(calendarSync.calls.push.length, 0);
});

test('reschedule: all on a local series shifts every occurrence, grid-only', async () => {
  const service = fakeAppointments(seriesRows());
  const calendarSync = fakeCalendarSync();
  const out = await rescheduleAppointment(
    contextFor(service, calendarSync),
    {
      id: 'a-2', startsAt: shiftDay('2026-10-20T18:00:00.000Z'), endsAt: shiftDay('2026-10-20T19:00:00.000Z'),
      scope: 'all', spaceId: SPACE,
    },
  );
  assert.equal(out.moved, true);
  assert.equal(out.occurrences.length, 3);
  assert.equal(service.rows[0].startsAt, shiftDay('2026-10-20T17:00:00.000Z'));
  assert.equal(out.push, null);
});

test('reschedule: a wide scope on a row with no series refuses naming scope', async () => {
  const service = fakeAppointments([occurrence(0, { seriesKey: undefined, occurrenceIndex: undefined, sourceKey: 'gym:single:1' })]);
  const calendarSync = fakeCalendarSync();
  await rejectsWith(
    rescheduleAppointment(
      contextFor(service, calendarSync),
      {
        id: 'a-1', startsAt: '2026-10-21T17:00:00.000Z', endsAt: '2026-10-21T18:00:00.000Z',
        scope: 'following', spaceId: SPACE,
      },
    ),
    (caught) => {
      assert.ok(caught instanceof ValidationError);
      assert.equal(caught.details?.field, 'scope');
    },
  );
  assert.equal(service.writes.length, 0);
});

test('reschedule: a scoped move without spaceId refuses before any lookup', async () => {
  const service = fakeAppointments(seriesRows());
  const calendarSync = fakeCalendarSync();
  await rejectsWith(
    rescheduleAppointment(
      contextFor(service, calendarSync),
      {
        id: 'a-2', startsAt: '2026-10-21T18:00:00.000Z', endsAt: '2026-10-21T19:00:00.000Z', scope: 'single',
      },
    ),
    (caught) => {
      assert.ok(caught instanceof ValidationError);
      assert.equal(caught.details?.field, 'spaceId');
    },
  );
  assert.equal(calendarSync.calls.probe.length, 0, 'no link is read without a space');
  assert.equal(service.writes.length, 0);
});

test('reschedule: a scoped move from a foreign space refuses and writes nothing', async () => {
  const service = fakeAppointments(seriesRows());
  const calendarSync = fakeCalendarSync({ linked: ['gym:serie:1:0'] });
  const before = service.rows.map((row) => ({ ...row }));
  await rejectsWith(
    rescheduleAppointment(
      contextFor(service, calendarSync),
      {
        id: 'a-1', startsAt: '2026-10-21T17:00:00.000Z', endsAt: '2026-10-21T18:00:00.000Z',
        scope: 'all', spaceId: OTHER_SPACE,
      },
    ),
    (caught) => {
      assert.equal(caught.code, 'CALENDAR_GRANT_UNKNOWN');
    },
  );
  assert.deepEqual(service.rows, before);
  assert.equal(service.writes.length, 0);
});

test('reschedule: an unknown scope value refuses naming scope', async () => {
  const service = fakeAppointments(seriesRows());
  const calendarSync = fakeCalendarSync();
  await rejectsWith(
    rescheduleAppointment(
      contextFor(service, calendarSync),
      {
        id: 'a-1', startsAt: '2026-10-21T17:00:00.000Z', endsAt: '2026-10-21T18:00:00.000Z',
        scope: 'rest', spaceId: SPACE,
      },
    ),
    (caught) => {
      assert.ok(caught instanceof ValidationError);
      assert.equal(caught.details?.field, 'scope');
    },
  );
  assert.equal(service.writes.length, 0);
});

test('cancel: a linked series refuses single scope with 409 and the Google series survives', async () => {
  const service = fakeAppointments(seriesRows());
  const calendarSync = fakeCalendarSync({ linked: ['gym:serie:1:0', 'gym:serie:1:1', 'gym:serie:1:2'] });
  const before = service.rows.map((row) => ({ ...row }));
  const error = await rejectsWith(
    cancelAppointment(
      contextFor(service, calendarSync),
      { id: 'a-2', reason: 'Non serve piu', scope: 'single', spaceId: SPACE },
    ),
    (caught) => {
      assert.equal(caught.code, 'APPOINTMENTS_SERIES_SCOPE_GOOGLE');
      assert.equal(caught.status, 409);
      assert.match(caught.message, /Google Calendar/);
    },
  );
  assert.equal(error.details.scope, 'single');
  assert.deepEqual(service.rows, before, 'no occurrence is cancelled');
  assert.ok(service.rows.every((row) => row.status === 'booked'));
  assert.equal(service.writes.length, 0);
  assert.equal(calendarSync.calls.push.length, 0, 'the whole Google series is never cancelled');
  assert.equal(calendarSync.calls.detail, 0, 'the auto-push never resolves a link for a scoped cancel');
});

test('cancel: a linked series refuses following and all scopes with 409 and writes nothing', async () => {
  for (const scope of ['following', 'all']) {
    const service = fakeAppointments(seriesRows());
    const calendarSync = fakeCalendarSync({ linked: ['gym:serie:1:0'] });
    const before = service.rows.map((row) => ({ ...row }));
    await rejectsWith(
      cancelAppointment(
        contextFor(service, calendarSync),
        { id: 'a-1', reason: 'Non serve piu', scope, spaceId: SPACE },
      ),
      (caught) => {
        assert.equal(caught.code, 'APPOINTMENTS_SERIES_SCOPE_GOOGLE');
        assert.equal(caught.status, 409);
      },
    );
    assert.deepEqual(service.rows, before, `the grid is unchanged for scope ${scope}`);
    assert.equal(service.writes.length, 0);
    assert.equal(calendarSync.calls.push.length, 0);
    assert.equal(calendarSync.calls.detail, 0);
  }
});

test('cancel: all on a local series cancels every occurrence, grid-only', async () => {
  const service = fakeAppointments(seriesRows());
  const calendarSync = fakeCalendarSync();
  const out = await cancelAppointment(
    contextFor(service, calendarSync),
    { id: 'a-2', reason: 'Non serve piu', scope: 'all', spaceId: SPACE },
  );
  assert.equal(out.cancelled, true);
  assert.equal(out.occurrences.length, 3);
  assert.ok(service.rows.every((row) => row.status === 'cancelled'));
  assert.equal(out.push, null, 'a scoped cancel never pushes');
  assert.equal(out.pushError, null);
  assert.equal(calendarSync.calls.push.length, 0);
  assert.equal(calendarSync.calls.detail, 0);
});

test('cancel: following on a local series cancels this and the tail only', async () => {
  const service = fakeAppointments(seriesRows());
  const calendarSync = fakeCalendarSync();
  const out = await cancelAppointment(
    contextFor(service, calendarSync),
    { id: 'a-2', reason: 'Non serve piu', scope: 'following', spaceId: SPACE },
  );
  assert.equal(out.cancelled, true);
  assert.equal(out.occurrences.length, 2);
  assert.equal(service.rows[0].status, 'booked', 'the head stays');
  assert.equal(service.rows[1].status, 'cancelled');
  assert.equal(service.rows[2].status, 'cancelled');
  assert.equal(service.rows[1].cancelReason, 'Non serve piu');
  assert.equal(out.push, null);
});

test('cancel: a wide scope stops before a terminal row instead of cancelling halfway', async () => {
  const service = fakeAppointments(seriesRows([{ status: 'done' }]));
  const calendarSync = fakeCalendarSync();
  await rejectsWith(
    cancelAppointment(
      contextFor(service, calendarSync),
      { id: 'a-3', reason: 'Non serve piu', scope: 'all', spaceId: SPACE },
    ),
    (caught) => {
      assert.equal(caught.code, 'APPOINTMENTS_INVALID_STATE');
      assert.equal(caught.status, 409);
    },
  );
  assert.ok(service.rows.every((row) => row.status !== 'cancelled'), 'nothing is cancelled');
  assert.equal(service.writes.length, 0);
});

test('cancel: a scoped cancel without spaceId refuses before any lookup', async () => {
  const service = fakeAppointments(seriesRows());
  const calendarSync = fakeCalendarSync();
  await rejectsWith(
    cancelAppointment(
      contextFor(service, calendarSync),
      { id: 'a-2', reason: 'Non serve piu', scope: 'all' },
    ),
    (caught) => {
      assert.ok(caught instanceof ValidationError);
      assert.equal(caught.details?.field, 'spaceId');
    },
  );
  assert.equal(calendarSync.calls.probe.length, 0, 'no link is read without a space');
  assert.equal(service.writes.length, 0);
});

test('cancel: a scoped cancel naming a calendar refuses grid-only before any write', async () => {
  const service = fakeAppointments(seriesRows());
  const calendarSync = fakeCalendarSync();
  await rejectsWith(
    cancelAppointment(
      contextFor(service, calendarSync),
      {
        id: 'a-2', reason: 'Non serve piu', scope: 'following', spaceId: SPACE,
        calendar: { calendarId: 'cal-1' },
      },
    ),
    (caught) => {
      assert.ok(caught instanceof ValidationError);
      assert.equal(caught.details?.field, 'calendar');
    },
  );
  assert.equal(service.writes.length, 0);
});

test('cancel: single scope on a local row cancels like the unscoped path', async () => {
  const service = fakeAppointments([occurrence(0, { seriesKey: undefined, occurrenceIndex: undefined, sourceKey: 'gym:single:9' })]);
  const calendarSync = fakeCalendarSync();
  const out = await cancelAppointment(
    contextFor(service, calendarSync),
    { id: 'a-1', reason: 'Non serve piu', scope: 'single', spaceId: SPACE },
  );
  assert.equal(out.cancelled, true);
  assert.equal(out.occurrences.length, 1);
  assert.equal(service.rows[0].status, 'cancelled');
});

/**
 * The real link probe (backlog:6acf0a73bfc3): read-only, against the real
 * sqlite store. The owning space sees the link; a foreign space meets the
 * same grant refusal whatever key it names; an unknown key reads as
 * unlinked from any space — never a cross-space oracle.
 */
const here = dirname(fileURLToPath(import.meta.url));
const probeManifest = (pkg, name) => JSON.parse(
  readFileSync(join(here, '..', 'packages', pkg, 'modules', `${name}.module.json`), 'utf8'),
);

const GRANT_REF = 'vault://s-presti/google-calendar';
const GRANT_VALUE = 'grant-vault-value-9f3a7c2e51';
const CAL = 'presti-room-1';
const PROBE_T0 = new Date('2026-10-20T08:00:00.000Z').getTime();

function probeSetup() {
  const database = createDatabase({ path: ':memory:' });
  const manifests = [
    { name: 'appointment', manifest: probeManifest('appointments', 'appointment') },
    { name: 'calendar-link', manifest: probeManifest('calendar-sync', 'calendar-link') },
    { name: 'calendar-sync-state', manifest: probeManifest('calendar-sync', 'calendar-sync-state') },
  ];
  for (const { sql } of recordModuleMigrations(manifests)) database.raw.exec(sql);
  const audit = new AuditLog(database);
  const events = new EventBus();
  const modules = new Map();
  for (const { name, manifest: body } of manifests) {
    modules.set(name, { service: createRecordModuleFromManifest(body, { database, audit, events, references: {} }).service });
  }
  const provider = createFakeGoogleCalendar({ nowMs: () => PROBE_T0, expectedSecret: GRANT_VALUE });
  const mapping = {
    subjectForEvent: () => ({ resource: 'contact', id: 'c-presti', owner: 'host', label: 'Presti Group' }),
    teamMemberForCalendar: () => 'coach-guido',
    serviceForEvent: () => ({ serviceKey: 'pt-single', priceCents: 4000, currency: 'EUR' }),
    summaryForAppointment: (row) => `Appointment ${row.serviceKey} ${row.startsAt}`,
  };
  const sync = createCalendarSyncOperations({
    modules,
    appointmentBook: createAppointmentBookCapability({}),
    provider,
    mapping,
    database,
    actor: ACTOR,
    now: () => new Date(PROBE_T0).toISOString(),
    resolveSecret: async () => GRANT_VALUE,
  });
  return { database, modules, provider, sync, close: () => database.close() };
}

test('seriesScopeLink: the owning space sees the link, a foreign space cannot reach it', async (t) => {
  const ctx = probeSetup();
  t.after(() => ctx.close());
  await ctx.sync.bindCalendarGrant({ spaceId: SPACE, calendarId: CAL, secretRef: GRANT_REF, actor: ACTOR });
  ctx.provider.seedEvent(CAL, {
    id: 'evt-serie-1',
    summary: 'Serie 1',
    start: { dateTime: '2026-10-21T09:00:00.000Z' },
    end: { dateTime: '2026-10-21T10:00:00.000Z' },
  });
  await ctx.sync.importFuture(CAL, { spaceId: SPACE, timeMin: '2026-10-20T00:00:00.000Z' });
  const [row] = [...ctx.modules.get('appointment').service.listWhere({})];
  assert.ok(row, 'the import stores the head row');

  const owned = await ctx.sync.seriesScopeLink(row.sourceKey, { spaceId: SPACE });
  assert.equal(owned.linked, true);
  assert.equal(owned.calendarId, CAL);

  const foreign = 'gym:serie:mai-esportata';
  let foreignLinked = null;
  try {
    await ctx.sync.seriesScopeLink(row.sourceKey, { spaceId: OTHER_SPACE });
  } catch (caught) {
    foreignLinked = caught;
  }
  assert.ok(foreignLinked, 'a foreign space refuses the exported key');
  assert.equal(foreignLinked.code, 'CALENDAR_GRANT_UNKNOWN');

  const foreignUnknown = await ctx.sync.seriesScopeLink(foreign, { spaceId: OTHER_SPACE });
  assert.equal(foreignUnknown.linked, false, 'an unknown key reads the same from any space: no cross-space oracle');

  const unknown = await ctx.sync.seriesScopeLink(foreign, { spaceId: SPACE });
  assert.equal(unknown.linked, false, 'an unknown key reads as unlinked from the owning space');

  let missing = null;
  try {
    await ctx.sync.seriesScopeLink(row.sourceKey, {});
  } catch (caught) {
    missing = caught;
  }
  assert.ok(missing, 'a missing space refuses before any lookup');
  assert.ok(missing instanceof ValidationError);
});
