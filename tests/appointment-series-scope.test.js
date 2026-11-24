import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  bookAppointment,
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
 * Series scope (backlog:6acf0a73bfc3): only «solo questo» (`single`) on
 * reschedule and cancel. The wide scopes (`following`, `all`) refuse 409
 * `APPOINTMENTS_SERIES_SCOPE_WIDE` before any row is read — they are a later
 * backlog item — and a series linked to Google refuses 409
 * `APPOINTMENTS_SERIES_SCOPE_GOOGLE` before the first grid write. A local
 * series row moves or cancels grid-only, exactly the named row, never a
 * sibling. Missing or foreign space refuses before any write, never as
 * «solo locale».
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
  spaceId: SPACE,
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

const OP = {
  reschedule: (service, calendarSync, request) => rescheduleAppointment(contextFor(service, calendarSync), request),
  cancel: (service, calendarSync, request) => cancelAppointment(contextFor(service, calendarSync), request),
};

/**
 * One table for every scope case (backlog:6acf0a73bfc3, NOT_GENERAL): each
 * row names the operation, the scope, which sibling keys are Google-linked,
 * and the single refusal the caller must see — with the grid and Google
 * untouched. The wide scopes refuse before any read (probe silent); the
 * linked single refuses after the probe (Google named, grid kept — the
 * probe stops at the first linked key, so a head link reads once while a
 * tail-only link reads every sibling).
 */
const SCOPE_TABLE = [
  { op: 'reschedule', scope: 'following', linked: [], code: 'APPOINTMENTS_SERIES_SCOPE_WIDE', probe: 0 },
  { op: 'reschedule', scope: 'all', linked: [], code: 'APPOINTMENTS_SERIES_SCOPE_WIDE', probe: 0 },
  { op: 'reschedule', scope: 'following', linked: ['gym:serie:1:0'], code: 'APPOINTMENTS_SERIES_SCOPE_WIDE', probe: 0 },
  { op: 'reschedule', scope: 'all', linked: ['gym:serie:1:0'], code: 'APPOINTMENTS_SERIES_SCOPE_WIDE', probe: 0 },
  { op: 'cancel', scope: 'following', linked: [], code: 'APPOINTMENTS_SERIES_SCOPE_WIDE', probe: 0 },
  { op: 'cancel', scope: 'all', linked: [], code: 'APPOINTMENTS_SERIES_SCOPE_WIDE', probe: 0 },
  { op: 'cancel', scope: 'following', linked: ['gym:serie:1:0'], code: 'APPOINTMENTS_SERIES_SCOPE_WIDE', probe: 0 },
  { op: 'cancel', scope: 'all', linked: ['gym:serie:1:0'], code: 'APPOINTMENTS_SERIES_SCOPE_WIDE', probe: 0 },
  { op: 'reschedule', scope: 'single', linked: ['gym:serie:1:0'], code: 'APPOINTMENTS_SERIES_SCOPE_GOOGLE', probe: 1 },
  { op: 'cancel', scope: 'single', linked: ['gym:serie:1:0'], code: 'APPOINTMENTS_SERIES_SCOPE_GOOGLE', probe: 1 },
  { op: 'reschedule', scope: 'single', linked: ['gym:serie:1:2'], code: 'APPOINTMENTS_SERIES_SCOPE_GOOGLE', probe: 3 },
  { op: 'cancel', scope: 'single', linked: ['gym:serie:1:2'], code: 'APPOINTMENTS_SERIES_SCOPE_GOOGLE', probe: 3 },
];

for (const { op, scope, linked, code, probe } of SCOPE_TABLE) {
  test(`scope table: ${op} ${scope} linked=[${linked.join(',') || 'none'}] refuses ${code}`, async () => {
    const service = fakeAppointments(seriesRows());
    const calendarSync = fakeCalendarSync({ linked });
    const before = service.rows.map((row) => ({ ...row }));
    const request = op === 'reschedule'
      ? {
        id: 'a-2', startsAt: '2026-10-21T18:00:00.000Z', endsAt: '2026-10-21T19:00:00.000Z',
        scope, spaceId: SPACE,
      }
      : { id: 'a-2', reason: 'Non serve piu', scope, spaceId: SPACE };
    await rejectsWith(
      OP[op](service, calendarSync, request),
      (caught) => {
        assert.equal(caught.code, code);
        assert.equal(caught.status, 409);
      },
    );
    assert.deepEqual(service.rows, before, 'the grid is unchanged');
    assert.equal(service.writes.length, 0, 'no grid write happens');
    assert.equal(calendarSync.calls.probe.length, probe, 'the probe runs exactly as the case needs');
    assert.equal(calendarSync.calls.push.length, 0, 'Google is never touched');
  });
}

test('reschedule: single on a local series row moves only the anchor, grid-only', async () => {
  const service = fakeAppointments(seriesRows());
  const calendarSync = fakeCalendarSync();
  const out = await rescheduleAppointment(
    contextFor(service, calendarSync),
    {
      id: 'a-2', startsAt: shiftDay('2026-10-20T18:00:00.000Z'), endsAt: shiftDay('2026-10-20T19:00:00.000Z'),
      scope: 'single', spaceId: SPACE,
    },
  );
  assert.equal(out.moved, true);
  assert.equal(out.occurrences.length, 1, 'only the named occurrence answers');
  assert.equal(service.rows[0].startsAt, '2026-10-20T17:00:00.000Z', 'the head stays');
  assert.equal(service.rows[1].startsAt, shiftDay('2026-10-20T18:00:00.000Z'), 'the anchor moves');
  assert.equal(service.rows[2].startsAt, '2026-10-20T19:00:00.000Z', 'the tail stays');
  assert.deepEqual(
    calendarSync.calls.probe.map((call) => call.sourceKey).sort(),
    ['gym:serie:1:0', 'gym:serie:1:1', 'gym:serie:1:2'],
    'every sibling key is probed, never just the head',
  );
  assert.equal(out.push, null, 'a scoped write never pushes');
  assert.equal(calendarSync.calls.push.length, 0);
});

test('cancel: single on a local series row cancels only the anchor', async () => {
  const service = fakeAppointments(seriesRows());
  const calendarSync = fakeCalendarSync();
  const out = await cancelAppointment(
    contextFor(service, calendarSync),
    { id: 'a-2', reason: 'Non serve piu', scope: 'single', spaceId: SPACE },
  );
  assert.equal(out.cancelled, true);
  assert.equal(out.occurrences.length, 1);
  assert.equal(service.rows[0].status, 'booked', 'the head stays');
  assert.equal(service.rows[1].status, 'cancelled', 'the anchor cancels');
  assert.equal(service.rows[1].cancelReason, 'Non serve piu');
  assert.equal(service.rows[2].status, 'booked', 'the tail stays');
  assert.equal(out.push, null);
  assert.equal(calendarSync.calls.push.length, 0);
});

test('reschedule: a wide scope refuses before the space gate, even from a foreign space', async () => {
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
      assert.equal(caught.code, 'APPOINTMENTS_SERIES_SCOPE_WIDE');
      assert.equal(caught.status, 409);
    },
  );
  assert.deepEqual(service.rows, before);
  assert.equal(service.writes.length, 0);
  assert.equal(calendarSync.calls.probe.length, 0, 'no link is read for a refused wide scope');
});

test('cancel: a wide scope refuses without a space, naming the scope not the space', async () => {
  const service = fakeAppointments(seriesRows());
  const calendarSync = fakeCalendarSync();
  await rejectsWith(
    cancelAppointment(
      contextFor(service, calendarSync),
      { id: 'a-1', reason: 'Non serve piu', scope: 'following' },
    ),
    (caught) => {
      assert.equal(caught.code, 'APPOINTMENTS_SERIES_SCOPE_WIDE');
      assert.equal(caught.status, 409);
    },
  );
  assert.equal(calendarSync.calls.probe.length, 0);
  assert.equal(service.writes.length, 0);
});

test('reschedule: a wide scope on a row with no series still refuses the scope', async () => {
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
      assert.equal(caught.code, 'APPOINTMENTS_SERIES_SCOPE_WIDE');
      assert.equal(caught.status, 409);
    },
  );
  assert.equal(service.writes.length, 0);
});

test('reschedule: a malformed spaceId refuses naming spaceId before any lookup', async () => {
  const service = fakeAppointments(seriesRows());
  const calendarSync = fakeCalendarSync();
  await rejectsWith(
    rescheduleAppointment(
      contextFor(service, calendarSync),
      {
        id: 'a-2', startsAt: '2026-10-21T18:00:00.000Z', endsAt: '2026-10-21T19:00:00.000Z',
        scope: 'single', spaceId: 'NOT A SPACE!',
      },
    ),
    (caught) => {
      assert.ok(caught instanceof ValidationError);
      assert.equal(caught.details?.field, 'spaceId');
    },
  );
  assert.equal(calendarSync.calls.probe.length, 0, 'no link is read with a malformed space');
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

test('reschedule: a scoped move from a foreign space refuses 404 and writes nothing', async () => {
  const service = fakeAppointments(seriesRows());
  const calendarSync = fakeCalendarSync();
  const before = service.rows.map((row) => ({ ...row }));
  await rejectsWith(
    rescheduleAppointment(
      contextFor(service, calendarSync),
      {
        id: 'a-1', startsAt: '2026-10-21T17:00:00.000Z', endsAt: '2026-10-21T18:00:00.000Z',
        scope: 'single', spaceId: OTHER_SPACE,
      },
    ),
    (caught) => {
      assert.equal(caught.code, 'APPOINTMENTS_SERIES_SPACE_UNKNOWN');
      assert.equal(caught.status, 404);
    },
  );
  assert.deepEqual(service.rows, before);
  assert.equal(service.writes.length, 0);
  assert.equal(calendarSync.calls.probe.length, 0, 'a foreign space never reaches the link probe');
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

test('reschedule: single on a terminal occurrence refuses and writes nothing', async () => {
  const service = fakeAppointments(seriesRows([{ status: 'done' }, {}, {}]));
  const calendarSync = fakeCalendarSync();
  const before = service.rows.map((row) => ({ ...row }));
  await rejectsWith(
    rescheduleAppointment(
      contextFor(service, calendarSync),
      {
        id: 'a-1', startsAt: '2026-10-21T17:00:00.000Z', endsAt: '2026-10-21T18:00:00.000Z',
        scope: 'single', spaceId: SPACE,
      },
    ),
    (caught) => {
      assert.equal(caught.code, 'APPOINTMENTS_INVALID_STATE');
      assert.equal(caught.status, 409);
    },
  );
  assert.deepEqual(service.rows, before);
  assert.equal(service.writes.length, 0);
});

test('cancel: a scoped cancel without spaceId refuses before any lookup', async () => {
  const service = fakeAppointments(seriesRows());
  const calendarSync = fakeCalendarSync();
  await rejectsWith(
    cancelAppointment(
      contextFor(service, calendarSync),
      { id: 'a-2', reason: 'Non serve piu', scope: 'single' },
    ),
    (caught) => {
      assert.ok(caught instanceof ValidationError);
      assert.equal(caught.details?.field, 'spaceId');
    },
  );
  assert.equal(calendarSync.calls.probe.length, 0, 'no link is read without a space');
  assert.equal(service.writes.length, 0);
});

test('cancel: single scope with a calendar cancels and pushes like the unscoped path', async () => {
  const service = fakeAppointments(seriesRows());
  const calendarSync = fakeCalendarSync();
  const out = await cancelAppointment(
    contextFor(service, calendarSync),
    {
      id: 'a-2', reason: 'Non serve piu', scope: 'single', spaceId: SPACE,
      calendar: { calendarId: 'cal-1' },
    },
  );
  assert.equal(out.cancelled, true);
  assert.equal(out.occurrences.length, 1);
  assert.equal(service.rows[1].status, 'cancelled');
  assert.equal(service.rows[0].status, 'booked', 'siblings stay');
  assert.equal(calendarSync.calls.push.length, 1, 'the named calendar still converges after the commit');
});

test('cancel: a scoped cancel from a foreign space refuses 404 and writes nothing', async () => {
  const service = fakeAppointments(seriesRows());
  const calendarSync = fakeCalendarSync();
  const before = service.rows.map((row) => ({ ...row }));
  await rejectsWith(
    cancelAppointment(
      contextFor(service, calendarSync),
      { id: 'a-1', reason: 'Non serve piu', scope: 'single', spaceId: OTHER_SPACE },
    ),
    (caught) => {
      assert.equal(caught.code, 'APPOINTMENTS_SERIES_SPACE_UNKNOWN');
      assert.equal(caught.status, 404);
    },
  );
  assert.deepEqual(service.rows, before);
  assert.equal(service.writes.length, 0);
  assert.equal(calendarSync.calls.probe.length, 0, 'a foreign space never reaches the link probe');
});

test('cancel: single on a done row refuses 409 and writes nothing', async () => {
  const service = fakeAppointments(seriesRows([{}, {}, { status: 'done' }]));
  const calendarSync = fakeCalendarSync();
  const before = service.rows.map((row) => ({ ...row }));
  await rejectsWith(
    cancelAppointment(
      contextFor(service, calendarSync),
      { id: 'a-3', reason: 'Non serve piu', scope: 'single', spaceId: SPACE },
    ),
    (caught) => {
      assert.equal(caught.code, 'APPOINTMENTS_INVALID_STATE');
      assert.equal(caught.status, 409);
    },
  );
  assert.deepEqual(service.rows, before);
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
 * The booking path persists the series identity (backlog:6acf0a73bfc3): a
 * series booked through the API is a series on real storage, so scoped
 * writes never depend on a hand-seeded fake.
 */
const bookingRequest = (overrides = {}) => ({
  sourceKey: 'gym:booked:serie:7',
  subject: SUBJECT,
  teamMemberId: 'coach-guido',
  serviceKey: 'pt-single',
  priceCents: 4000,
  currency: 'EUR',
  startsAt: '2026-10-20T17:00:00.000Z',
  endsAt: '2026-10-20T18:00:00.000Z',
  source: { package: 'host', action: 'book' },
  ...overrides,
});

test('booking: a series booking persists seriesKey, occurrenceIndex and spaceId', async () => {
  const service = fakeAppointments();
  const booked = await bookAppointment(
    contextFor(service, null),
    bookingRequest({ seriesKey: 'serie:7', occurrenceIndex: 0, spaceId: SPACE }),
  );
  assert.equal(booked.appointment.seriesKey, 'serie:7');
  assert.equal(booked.appointment.occurrenceIndex, 0);
  assert.equal(booked.appointment.spaceId, SPACE);
  assert.equal(service.rows.length, 1);
});

test('booking: a seriesKey without a space refuses before any write', async () => {
  const service = fakeAppointments();
  await rejectsWith(
    bookAppointment(
      contextFor(service, null),
      bookingRequest({ seriesKey: 'serie:7', occurrenceIndex: 0 }),
    ),
    (caught) => {
      assert.ok(caught instanceof ValidationError);
      assert.equal(caught.details?.field, 'spaceId');
    },
  );
  assert.equal(service.rows.length, 0, 'nothing is booked');
});

test('booking: an occurrenceIndex without a series refuses before any write', async () => {
  const service = fakeAppointments();
  await rejectsWith(
    bookAppointment(
      contextFor(service, null),
      bookingRequest({ occurrenceIndex: 0 }),
    ),
    (caught) => {
      assert.ok(caught instanceof ValidationError);
      assert.equal(caught.details?.field, 'occurrenceIndex');
    },
  );
  assert.equal(service.rows.length, 0, 'nothing is booked');
});

test('booking: a plain booking stays series-free, like on main', async () => {
  const service = fakeAppointments();
  const booked = await bookAppointment(contextFor(service, null), bookingRequest());
  assert.equal(booked.appointment.seriesKey, null);
  assert.equal(booked.appointment.occurrenceIndex, null);
  assert.equal(booked.appointment.spaceId, null);
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

  let foreignUnknown = null;
  try {
    await ctx.sync.seriesScopeLink(foreign, { spaceId: OTHER_SPACE });
  } catch (caught) {
    foreignUnknown = caught;
  }
  assert.ok(foreignUnknown, 'an unknown key refuses from a foreign space, like the exported one: no cross-space oracle');
  assert.equal(foreignUnknown.code, 'CALENDAR_GRANT_UNKNOWN');

  const unknown = await ctx.sync.seriesScopeLink(foreign, { spaceId: SPACE });
  assert.equal(unknown.linked, false, 'an unknown key reads as unlinked from the owning space');

  await ctx.sync.revokeCalendarGrant({ spaceId: SPACE, calendarId: CAL, actor: ACTOR });
  let revoked = null;
  try {
    await ctx.sync.seriesScopeLink(foreign, { spaceId: SPACE });
  } catch (caught) {
    revoked = caught;
  }
  assert.ok(revoked, 'a space with only revoked grants refuses before any lookup');
  assert.equal(revoked.code, 'CALENDAR_GRANT_REVOKED');

  let missing = null;
  try {
    await ctx.sync.seriesScopeLink(row.sourceKey, {});
  } catch (caught) {
    missing = caught;
  }
  assert.ok(missing, 'a missing space refuses before any lookup');
  assert.ok(missing instanceof ValidationError);
});
