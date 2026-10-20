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
 * Event detail (BO-F3-01, "07 Calendario", backlog:3ec06fdee0e2): one
 * appointment row with its origin and its sync state, through
 * `readAppointmentDetail` against the fake provider. No test dials Google;
 * no grant is bound anywhere here — the detail is a purely local read, so
 * it renders while the grant is revoked.
 */

const here = dirname(fileURLToPath(import.meta.url));
const manifest = (pkg, name) => JSON.parse(
  readFileSync(join(here, '..', 'packages', pkg, 'modules', `${name}.module.json`), 'utf8'),
);

const ACTOR = { type: 'user', id: 'calendar-kit' };
const SUBJECT = { resource: 'contact', id: 'c-presti', owner: 'host', label: 'Presti Group' };
const MEMBER = 'coach-guido';
const SERVICE = { serviceKey: 'pt-single', priceCents: 4000, currency: 'EUR' };
const CAL = 'presti-room-1';
const T0 = new Date('2026-10-20T08:00:00.000Z').getTime();

const slot = (day, from, to) => ({
  start: { dateTime: `2026-10-${day}T${from}:00.000Z` },
  end: { dateTime: `2026-10-${day}T${to}:00.000Z` },
});

function setup() {
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
  const provider = createFakeGoogleCalendar({ nowMs: () => T0 });
  const appointmentBook = createAppointmentBookCapability({});
  const mapping = {
    subjectForEvent: () => ({ ...SUBJECT }),
    teamMemberForCalendar: () => MEMBER,
    serviceForEvent: () => ({ ...SERVICE }),
    summaryForAppointment: (row) => `Appointment ${row.serviceKey} ${row.startsAt}`,
  };
  const sync = createCalendarSyncOperations({
    modules, appointmentBook, provider, mapping, database,
    actor: ACTOR, now: () => new Date(T0).toISOString(),
  });
  return {
    database, modules, provider, sync,
    close: () => database.close(),
  };
}

const localBooking = (modules, overrides = {}) => createAppointmentBookCapability({})
  .create({ modules, actor: ACTOR, consumer: 'host' })
  .bookAppointment({
    sourceKey: 'gym:booking:9',
    subject: { ...SUBJECT },
    teamMemberId: MEMBER,
    ...SERVICE,
    startsAt: '2026-10-22T09:00:00.000Z',
    endsAt: '2026-10-22T10:00:00.000Z',
    source: { package: 'host', action: 'book' },
    ...overrides,
  });

test('an imported event details as google-calendar origin with its link state', async (t) => {
  const ctx = setup();
  t.after(() => ctx.close());
  ctx.provider.seedEvent(CAL, { id: 'evt1', summary: 'Session 1', ...slot('21', '09:00', '10:00') });
  const first = await ctx.sync.importFuture(CAL, { timeMin: '2026-10-20T00:00:00.000Z' });
  assert.equal(first.entries.filter((entry) => entry.status === 'imported').length, 1);
  const sourceKey = first.entries[0].appointmentId
    ? (await ctx.sync.readAppointmentDetail({ id: first.entries[0].appointmentId })).appointment.sourceKey
    : null;
  assert.ok(sourceKey);
  const detail = await ctx.sync.readAppointmentDetail({ sourceKey });
  assert.equal(detail.origin, 'google-calendar');
  assert.equal(detail.sync.calendarId, CAL);
  assert.ok(detail.sync.googleEventId.includes('evt1'));
  assert.equal(detail.sync.pending, false);
  assert.equal(detail.sync.conflict, null);
  assert.equal(detail.appointment.teamMemberId, MEMBER);
  assert.equal(detail.appointment.serviceKey, 'pt-single');
  assert.deepEqual(detail.appointment.subject, { resource: 'contact', id: 'c-presti', owner: 'host', ownerPackage: null });
});

test('detail by id answers the same row as detail by sourceKey', async (t) => {
  const ctx = setup();
  t.after(() => ctx.close());
  ctx.provider.seedEvent(CAL, { id: 'evt7', summary: 'Session 7', ...slot('22', '09:00', '10:00') });
  const first = await ctx.sync.importFuture(CAL, { timeMin: '2026-10-20T00:00:00.000Z' });
  const imported = first.entries.find((entry) => entry.status === 'imported');
  const byId = await ctx.sync.readAppointmentDetail({ id: imported.appointmentId });
  const byKey = await ctx.sync.readAppointmentDetail({ sourceKey: byId.appointment.sourceKey });
  assert.deepEqual(byId, byKey);
});

test('a local booking details as locale origin with no sync state', async (t) => {
  const ctx = setup();
  t.after(() => ctx.close());
  const { appointment } = await localBooking(ctx.modules);
  const detail = await ctx.sync.readAppointmentDetail({ id: appointment.id });
  assert.equal(detail.origin, 'locale');
  assert.equal(detail.sync, null);
});

test('a pushed local booking keeps the locale origin and gains its link', async (t) => {
  const ctx = setup();
  t.after(() => ctx.close());
  const { appointment } = await localBooking(ctx.modules);
  const pushed = await ctx.sync.pushAppointment(CAL, appointment.sourceKey);
  assert.equal(pushed.status, 'exported');
  const detail = await ctx.sync.readAppointmentDetail({ sourceKey: appointment.sourceKey });
  assert.equal(detail.origin, 'locale');
  assert.equal(detail.sync.calendarId, CAL);
  assert.ok(detail.sync.googleEventId.includes(pushed.eventId));
  assert.equal(detail.sync.pending, false);
  assert.equal(detail.sync.conflict, null);
});

test('an unknown row is a typed 404, never an empty detail', async (t) => {
  const ctx = setup();
  t.after(() => ctx.close());
  await assert.rejects(
    ctx.sync.readAppointmentDetail({ id: 'a-missing' }),
    (error) => error.code === 'CALENDAR_SYNC_UNKNOWN_APPOINTMENT' && error.status === 404,
  );
  await assert.rejects(
    ctx.sync.readAppointmentDetail({ sourceKey: 'gcal:nowhere:x' }),
    (error) => error.code === 'CALENDAR_SYNC_UNKNOWN_APPOINTMENT' && error.status === 404,
  );
});

test('naming both keys — or none — is refused before any read', async (t) => {
  const ctx = setup();
  t.after(() => ctx.close());
  await assert.rejects(ctx.sync.readAppointmentDetail({ id: 'a-1', sourceKey: 'gym:booking:1' }), (error) => (
    error.code === 'VALIDATION_ERROR' && /exactly one/.test(error.message)
  ));
  await assert.rejects(ctx.sync.readAppointmentDetail({}), (error) => (
    error.code === 'VALIDATION_ERROR' && /exactly one/.test(error.message)
  ));
});

test('the detail is frozen: the BO view cannot rewrite evidence', async (t) => {
  const ctx = setup();
  t.after(() => ctx.close());
  const { appointment } = await localBooking(ctx.modules);
  const detail = await ctx.sync.readAppointmentDetail({ id: appointment.id });
  assert.ok(Object.isFrozen(detail));
  assert.ok(Object.isFrozen(detail.appointment));
  assert.ok(Object.isFrozen(detail.appointment.subject));
  assert.throws(() => { detail.appointment.status = 'done'; }, TypeError);
});
