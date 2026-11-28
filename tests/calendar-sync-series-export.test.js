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
import { createFakeGoogleCalendar } from '../packages/calendar-sync/src/google-fake.js';

/**
 * Series export tests (backlog:bb13ef1823ad): a confirmed series in a
 * connected space arrives whole on Google — one recurring event carrying
 * its RRULE — proven against the fake provider. No test dials Google.
 */

const here = dirname(fileURLToPath(import.meta.url));
const manifest = (pkg, name) => JSON.parse(
  readFileSync(join(here, '..', 'packages', pkg, 'modules', `${name}.module.json`), 'utf8'),
);

const ACTOR = { type: 'user', id: 'calendar-series-kit' };
const SUBJECT = { resource: 'contact', id: 'c-presti', owner: 'host', label: 'Presti Group' };
const MEMBER = 'coach-guido';
const SERVICE = { serviceKey: 'pt-single', priceCents: 4000, currency: 'EUR' };
const CAL = 'presti-room-1';
const T0 = new Date('2026-10-20T08:00:00.000Z').getTime();
const WEEKLY4 = ['RRULE:FREQ=WEEKLY;COUNT=4'];

function setup(options = {}) {
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
  let fakeNow = options.nowMs ?? T0;
  const provider = createFakeGoogleCalendar({ nowMs: () => fakeNow });
  const appointmentBook = createAppointmentBookCapability({});
  const mapping = {
    subjectForEvent: () => ({ ...SUBJECT }),
    teamMemberForCalendar: () => MEMBER,
    serviceForEvent: () => ({ ...SERVICE }),
    summaryForAppointment: (row) => `Appointment ${row.serviceKey} ${row.startsAt}`,
  };
  const sync = createCalendarSyncOperations({
    modules, appointmentBook, provider, mapping, database,
    actor: ACTOR, now: () => new Date(fakeNow).toISOString(),
  });
  return {
    database, modules, provider, sync,
    appointmentRows: () => [...modules.get('appointment').service.listWhere({})],
    linkRows: () => [...modules.get('calendar-link').service.listWhere({})],
    setNow: (ms) => { fakeNow = ms; },
    close: () => database.close(),
  };
}

async function bookHead(ctx, sourceKey) {
  const handle = createAppointmentBookCapability({}).create({
    modules: ctx.modules, actor: ACTOR, consumer: 'calendar-sync',
  });
  const { appointment } = await handle.bookAppointment({
    sourceKey,
    subject: { ...SUBJECT },
    teamMemberId: MEMBER,
    ...SERVICE,
    startsAt: '2026-10-21T09:00:00.000Z',
    endsAt: '2026-10-21T10:00:00.000Z',
    source: { package: 'calendar-sync', action: 'series-probe' },
  });
  return appointment;
}

test('pushSeries exports one recurring event: the whole series lands on Google', async (t) => {
  const ctx = setup();
  t.after(() => ctx.close());
  const appointment = await bookHead(ctx, 'gym:series:1');
  const out = await ctx.sync.pushSeries(CAL, appointment.sourceKey, { recurrence: WEEKLY4 });
  assert.equal(out.status, 'exported');
  assert.equal(out.sourceKey, appointment.sourceKey);
  assert.ok(typeof out.eventId === 'string' && out.eventId !== '');
  const live = ctx.provider.getEvent(CAL, out.eventId);
  assert.deepEqual(live.recurrence, WEEKLY4);
  assert.equal(live.extendedProperties.accordoSourceKey, appointment.sourceKey);
  assert.equal(ctx.linkRows().length, 1);
  assert.equal(ctx.linkRows()[0].appointmentSourceKey, appointment.sourceKey);
  // The series reads whole inside a window: four weekly occurrences,
  // each carrying the master identity — nothing stays local-only.
  const page = ctx.provider.listEvents({
    calendarId: CAL, timeMin: '2026-10-20T00:00:00.000Z', timeMax: '2026-11-20T00:00:00.000Z',
  });
  assert.equal(page.items.length, 4);
  assert.ok(page.items.every((item) => item.recurringEventId === out.eventId));
  assert.deepEqual(
    page.items.map((item) => item.start.dateTime),
    [
      '2026-10-21T09:00:00.000Z',
      '2026-10-28T09:00:00.000Z',
      '2026-11-04T09:00:00.000Z',
      '2026-11-11T09:00:00.000Z',
    ],
  );
});

test('pushSeries after a lost link reconciles instead of inserting twice', async (t) => {
  const ctx = setup();
  t.after(() => ctx.close());
  const appointment = await bookHead(ctx, 'gym:series:lost');
  // A previous export inserted the recurring event but its link never landed.
  ctx.provider.insertEvent({
    calendarId: CAL,
    summary: 'Appointment pt-single',
    start: { dateTime: appointment.startsAt },
    end: { dateTime: appointment.endsAt },
    recurrence: WEEKLY4,
    extendedProperties: { accordoSourceKey: appointment.sourceKey },
  });
  const countBefore = ctx.provider.eventCount(CAL);
  const out = await ctx.sync.pushSeries(CAL, appointment.sourceKey, { recurrence: WEEKLY4 });
  assert.equal(out.status, 'linked');
  assert.equal(out.healed, true);
  assert.equal(ctx.provider.eventCount(CAL), countBefore);
  assert.equal(ctx.linkRows().length, 1);
});

test('pushSeries on an existing link rides the single path: noop when nothing moved', async (t) => {
  const ctx = setup();
  t.after(() => ctx.close());
  const appointment = await bookHead(ctx, 'gym:series:again');
  const first = await ctx.sync.pushSeries(CAL, appointment.sourceKey, { recurrence: WEEKLY4 });
  assert.equal(first.status, 'exported');
  const again = await ctx.sync.pushSeries(CAL, appointment.sourceKey, { recurrence: WEEKLY4 });
  assert.equal(again.status, 'noop');
  assert.equal(ctx.provider.eventCount(CAL), 1);
});

test('pushSeries on an existing link fails closed when the RRULE changed', async (t) => {
  // Review rev-agent-crm-1136 P1: a changed RRULE after the export must
  // never read as noop while Google keeps the old COUNT — the call
  // names the drift instead of dropping the required recurrence param.
  const ctx = setup();
  t.after(() => ctx.close());
  const appointment = await bookHead(ctx, 'gym:series:drift');
  const first = await ctx.sync.pushSeries(CAL, appointment.sourceKey, { recurrence: WEEKLY4 });
  assert.equal(first.status, 'exported');
  const WEEKLY8 = ['RRULE:FREQ=WEEKLY;COUNT=8'];
  const drifted = await ctx.sync.pushSeries(CAL, appointment.sourceKey, { recurrence: WEEKLY8 });
  assert.equal(drifted.status, 'conflict');
  assert.equal(drifted.recurrenceChanged, true);
  assert.equal(drifted.eventId, first.eventId);
  assert.equal(ctx.provider.eventCount(CAL), 1, 'no silent second series');
  assert.deepEqual(ctx.provider.getEvent(CAL, first.eventId).recurrence, WEEKLY4, 'Google keeps the old COUNT');
});

test('pushSeries refuses to link a single event as an exported series', async (t) => {
  // Review rev-agent-crm-1136 P1: reconciling any event with the same
  // sourceKey without checking recurrence would link one occurrence as
  // if the whole series had landed.
  const ctx = setup();
  t.after(() => ctx.close());
  const appointment = await bookHead(ctx, 'gym:series:single');
  // A single non-recurring event left on the calendar with our key.
  ctx.provider.insertEvent({
    calendarId: CAL,
    summary: 'Appointment pt-single',
    start: { dateTime: appointment.startsAt },
    end: { dateTime: appointment.endsAt },
    extendedProperties: { accordoSourceKey: appointment.sourceKey },
  });
  const countBefore = ctx.provider.eventCount(CAL);
  await assert.rejects(
    ctx.sync.pushSeries(CAL, appointment.sourceKey, { recurrence: WEEKLY4 }),
    (error) => error?.code === 'CALENDAR_SYNC_SERIES_SHAPE_MISMATCH' && error?.status === 409,
  );
  assert.equal(ctx.provider.eventCount(CAL), countBefore, 'nothing inserted on refusal');
  assert.equal(ctx.linkRows().length, 0, 'no link to a foreign shape');
});

test('importFuture after a series export books no new appointment', async (t) => {
  // Review rev-agent-crm-1136 P1 regression: the exported recurring
  // master expands on Google into occurrences with different ids, which
  // used to miss the link-id invariant and re-import as new bookings.
  // The fake expands only with both bounds, so the test seeds the
  // production shape Google returns (`singleEvents=true`): instance
  // items carrying the master identity and our source key.
  const ctx = setup();
  t.after(() => ctx.close());
  const appointment = await bookHead(ctx, 'gym:series:roundtrip');
  const first = await ctx.sync.pushSeries(CAL, appointment.sourceKey, { recurrence: WEEKLY4 });
  assert.equal(first.status, 'exported');
  for (const day of ['21', '28']) {
    ctx.provider.seedEvent(CAL, {
      id: `${first.eventId}_202610${day}T090000000Z`,
      summary: 'Appointment pt-single',
      start: { dateTime: `2026-10-${day}T09:00:00.000Z` },
      end: { dateTime: `2026-10-${day}T10:00:00.000Z` },
      recurringEventId: first.eventId,
      extendedProperties: { accordoSourceKey: appointment.sourceKey },
    });
  }
  const headsBefore = ctx.appointmentRows().length;
  const imported = await ctx.sync.importFuture(CAL, {
    timeMin: '2026-10-20T00:00:00.000Z',
  });
  assert.equal(ctx.appointmentRows().length, headsBefore, 'no duplicate bookings from our own series');
  assert.ok(imported.entries.length > 0, 'the window covers the series');
  assert.ok(imported.entries.every((entry) => entry.status === 'already-tracked'),
    'every occurrence reads as already-tracked, none as imported');
});

test('malformed recurrence refuses before any Google write', async (t) => {
  const ctx = setup();
  t.after(() => ctx.close());
  const appointment = await bookHead(ctx, 'gym:series:bad');
  const bad = [
    undefined, null, [], 'RRULE:FREQ=WEEKLY;COUNT=4', ['FREQ=WEEKLY;COUNT=4'],
    ['RRULE:FREQ=WEEKLY;COUNT=4', 'DAILY'], [`RRULE:FREQ=WEEKLY;${'X'.repeat(256)}`],
    Array.from({ length: 9 }, (_, i) => `RRULE:FREQ=WEEKLY;COUNT=${i + 1}`),
  ];
  for (const recurrence of bad) {
    await assert.rejects(
      ctx.sync.pushSeries(CAL, appointment.sourceKey, { recurrence }),
      (error) => error?.code === 'VALIDATION_ERROR' && error?.status === 400,
    );
  }
  assert.equal(ctx.provider.eventCount(CAL), 0, 'no refused series writes anything');
  assert.equal(ctx.linkRows().length, 0);
});

test('pushSeries on an unknown head refuses 404', async (t) => {
  const ctx = setup();
  t.after(() => ctx.close());
  await assert.rejects(
    ctx.sync.pushSeries(CAL, 'gym:series:missing', { recurrence: WEEKLY4 }),
    (error) => error?.code === 'CALENDAR_SYNC_UNKNOWN_APPOINTMENT' && error?.status === 404,
  );
});

test('a cancelled series head is never exported as an active event', async (t) => {
  const ctx = setup();
  t.after(() => ctx.close());
  const handle = createAppointmentBookCapability({}).create({
    modules: ctx.modules, actor: ACTOR, consumer: 'calendar-sync',
  });
  const { appointment } = await handle.bookAppointment({
    sourceKey: 'gym:series:cancelled',
    subject: { ...SUBJECT },
    teamMemberId: MEMBER,
    ...SERVICE,
    startsAt: '2026-10-21T09:00:00.000Z',
    endsAt: '2026-10-21T10:00:00.000Z',
    source: { package: 'calendar-sync', action: 'series-probe' },
  });
  await handle.advanceAppointment(appointment, 'cancelled', 'Customer moved');
  const out = await ctx.sync.pushSeries(CAL, appointment.sourceKey, { recurrence: WEEKLY4 });
  assert.equal(out.status, 'noop');
  assert.equal(ctx.provider.eventCount(CAL), 0);
});

test('a cancelled series head converges an orphan recurring event, then stays quiet', async (t) => {
  // A previous export inserted the recurring event but its link never
  // landed; the head is cancelled afterwards. The push must cancel the
  // orphan series on Google instead of leaving it live — the same rule
  // as the single-appointment path.
  const ctx = setup();
  t.after(() => ctx.close());
  const handle = createAppointmentBookCapability({}).create({
    modules: ctx.modules, actor: ACTOR, consumer: 'calendar-sync',
  });
  const { appointment } = await handle.bookAppointment({
    sourceKey: 'gym:series:cancelled-orphan',
    subject: { ...SUBJECT },
    teamMemberId: MEMBER,
    ...SERVICE,
    startsAt: '2026-10-21T09:00:00.000Z',
    endsAt: '2026-10-21T10:00:00.000Z',
    source: { package: 'calendar-sync', action: 'series-probe' },
  });
  const orphan = ctx.provider.insertEvent({
    calendarId: CAL,
    summary: 'Appointment pt-single',
    start: { dateTime: appointment.startsAt },
    end: { dateTime: appointment.endsAt },
    recurrence: WEEKLY4,
    extendedProperties: { accordoSourceKey: appointment.sourceKey },
  });
  await handle.advanceAppointment(appointment, 'cancelled', 'Customer moved');
  const out = await ctx.sync.pushSeries(CAL, appointment.sourceKey, { recurrence: WEEKLY4 });
  assert.equal(out.status, 'pushed');
  assert.equal(out.change, 'cancelled');
  assert.equal(out.healed, true);
  assert.equal(ctx.provider.getEvent(CAL, orphan.id).status, 'cancelled');
});

test('pushSeries under a foreign or revoked grant refuses before any provider call', async (t) => {
  const ctx = setup();
  t.after(() => ctx.close());
  const appointment = await bookHead(ctx, 'gym:series:grant');
  await ctx.sync.bindCalendarGrant({
    spaceId: 'presti', calendarId: CAL, secretRef: 'vault://presti/google-calendar', actor: ACTOR,
  });
  await assert.rejects(
    ctx.sync.pushSeries(CAL, appointment.sourceKey, { spaceId: 'other', recurrence: WEEKLY4 }),
    (error) => error?.code === 'CALENDAR_GRANT_UNKNOWN' && error?.status === 404,
  );
  await ctx.sync.revokeCalendarGrant({ spaceId: 'presti', calendarId: CAL, actor: ACTOR });
  await assert.rejects(
    ctx.sync.pushSeries(CAL, appointment.sourceKey, { spaceId: 'presti', recurrence: WEEKLY4 }),
    (error) => error?.code === 'CALENDAR_GRANT_REVOKED' && error?.status === 409,
  );
  assert.equal(ctx.provider.eventCount(CAL), 0);
});
