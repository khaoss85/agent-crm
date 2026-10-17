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
import { createCalendarSyncPackage } from '../packages/calendar-sync/src/index.js';
import { createFakeGoogleCalendar } from '../packages/calendar-sync/src/google-fake.js';

/**
 * Calendar sync tests (backlog:bf0351325a8c): the hybrid Accordo / Google
 * Calendar story against the fake provider — future-event import with no
 * duplicates on re-run, Google-side edits visible locally, local
 * cancellations visible on Google, two consecutive syncs changing nothing,
 * cancellation-wins convergence, signed push delivery, token-expiry
 * recovery, overlap refusal, terminal-row immunity, and no secret material
 * in any row. No test dials Google.
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
    subjectForEvent: options.subjectForEvent ?? (() => ({ ...SUBJECT })),
    teamMemberForCalendar: () => MEMBER,
    serviceForEvent: () => ({ ...SERVICE }),
    summaryForAppointment: (row) => `Appointment ${row.serviceKey} ${row.startsAt}`,
  };
  const sync = createCalendarSyncOperations({
    modules, appointmentBook, provider, mapping,
    actor: ACTOR, now: () => new Date(fakeNow).toISOString(),
  });
  const appointmentRows = () => [...modules.get('appointment').service.listWhere({})];
  const linkRows = () => [...modules.get('calendar-link').service.listWhere({})];
  const stateRows = () => [...modules.get('calendar-sync-state').service.listWhere({})];
  return {
    database, modules, provider, sync, mapping, appointmentRows, linkRows, stateRows,
    setNow: (ms) => { fakeNow = ms; },
    close: () => database.close(),
  };
}

function seedEvent(ctx, id, day, from, to, extra = {}) {
  return ctx.provider.seedEvent(CAL, { id, summary: `Session ${id}`, ...slot(day, from, to), ...extra });
}

test('import books one appointment per future event and re-import duplicates nothing', async (t) => {
  const ctx = setup();
  t.after(() => ctx.close());
  seedEvent(ctx, 'evt1', '21', '09:00', '10:00');
  seedEvent(ctx, 'evt2', '21', '11:00', '12:00');
  const first = await ctx.sync.importFuture(CAL, { timeMin: '2026-10-20T00:00:00.000Z' });
  assert.equal(first.entries.filter((e) => e.status === 'imported').length, 2);
  assert.equal(ctx.appointmentRows().length, 2);
  assert.equal(ctx.linkRows().length, 2);
  assert.ok(first.nextSyncToken);
  const second = await ctx.sync.importFuture(CAL, { timeMin: '2026-10-20T00:00:00.000Z' });
  assert.ok(second.entries.every((e) => e.status === 'already-tracked'));
  assert.equal(ctx.appointmentRows().length, 2);
});

test('a Google-side edit is visible locally after one pull', async (t) => {
  const ctx = setup();
  t.after(() => ctx.close());
  seedEvent(ctx, 'evt1', '21', '09:00', '10:00');
  await ctx.sync.importFuture(CAL, { timeMin: '2026-10-20T00:00:00.000Z' });
  ctx.setNow(T0 + 60_000);
  ctx.provider.patchEvent({ calendarId: CAL, eventId: 'evt1', patch: { ...slot('21', '14:00', '15:00') } });
  const pull = await ctx.sync.pullIncremental(CAL);
  const applied = pull.entries.filter((e) => e.status === 'applied');
  assert.equal(applied.length, 1);
  assert.equal(applied[0].change, 'rescheduled');
  const rows = ctx.appointmentRows();
  assert.equal(rows.length, 2);
  assert.equal(rows.filter((r) => r.status === 'cancelled').length, 1);
  const fresh = rows.find((r) => r.status === 'booked');
  assert.equal(fresh.startsAt, '2026-10-21T14:00:00.000Z');
  assert.match(fresh.sourceKey, /^gcal:evt1:r1$/);
});

test('a local cancellation is visible on Google after one push', async (t) => {
  const ctx = setup();
  t.after(() => ctx.close());
  seedEvent(ctx, 'evt1', '21', '09:00', '10:00');
  await ctx.sync.importFuture(CAL, { timeMin: '2026-10-20T00:00:00.000Z' });
  const row = ctx.appointmentRows()[0];
  const handle = createAppointmentBookCapability({}).create({ modules: ctx.modules, actor: ACTOR, consumer: 'calendar-sync' });
  await handle.advanceAppointment(row, 'cancelled', 'Customer called off');
  const push = await ctx.sync.pushLocalChanges(CAL);
  assert.equal(push.entries.filter((e) => e.status === 'pushed').length, 1);
  assert.equal(ctx.provider.getEvent(CAL, 'evt1').status, 'cancelled');
  const again = await ctx.sync.pushLocalChanges(CAL);
  assert.ok(again.entries.every((e) => e.status === 'noop'));
});

test('two consecutive full syncs change nothing anywhere', async (t) => {
  const ctx = setup();
  t.after(() => ctx.close());
  seedEvent(ctx, 'evt1', '21', '09:00', '10:00');
  await ctx.sync.importFuture(CAL, { timeMin: '2026-10-20T00:00:00.000Z' });
  const first = await ctx.sync.syncOnce(CAL);
  const second = await ctx.sync.syncOnce(CAL);
  for (const run of [first, second]) {
    assert.ok(run.pull.entries.every((e) => e.status === 'replayed' || e.status === 'acknowledged' || e.status === 'ignored'));
    assert.ok(run.push.entries.every((e) => e.status === 'noop' || e.status === 'acknowledged'));
  }
  assert.equal(ctx.appointmentRows().length, 1);
  assert.equal(ctx.linkRows().length, 1);
});

test('a local cancellation wins over a concurrent Google reschedule', async (t) => {
  const ctx = setup();
  t.after(() => ctx.close());
  seedEvent(ctx, 'evt1', '21', '09:00', '10:00');
  await ctx.sync.importFuture(CAL, { timeMin: '2026-10-20T00:00:00.000Z' });
  const row = ctx.appointmentRows()[0];
  const handle = createAppointmentBookCapability({}).create({ modules: ctx.modules, actor: ACTOR, consumer: 'calendar-sync' });
  await handle.advanceAppointment(row, 'cancelled', 'Customer called off');
  ctx.setNow(T0 + 60_000);
  ctx.provider.patchEvent({ calendarId: CAL, eventId: 'evt1', patch: { ...slot('21', '14:00', '15:00') } });
  const pull = await ctx.sync.pullIncremental(CAL);
  const converged = pull.entries.find((e) => e.eventId === 'evt1');
  assert.equal(converged.direction, 'local-to-google');
  assert.equal(ctx.provider.getEvent(CAL, 'evt1').status, 'cancelled');
  assert.equal(ctx.appointmentRows().length, 1);
  assert.equal(ctx.appointmentRows()[0].status, 'cancelled');
});

test('a Google cancellation cancels the local booking with its reason', async (t) => {
  const ctx = setup();
  t.after(() => ctx.close());
  seedEvent(ctx, 'evt1', '21', '09:00', '10:00');
  await ctx.sync.importFuture(CAL, { timeMin: '2026-10-20T00:00:00.000Z' });
  ctx.setNow(T0 + 60_000);
  ctx.provider.cancelEvent({ calendarId: CAL, eventId: 'evt1' });
  const pull = await ctx.sync.pullIncremental(CAL);
  assert.equal(pull.entries[0].change, 'cancelled');
  const rows = ctx.appointmentRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'cancelled');
  assert.equal(rows[0].cancelReason, 'Cancelled in Google Calendar');
});

test('a push delivery applies the remote change; forged signals refuse', async (t) => {
  const ctx = setup();
  t.after(() => ctx.close());
  seedEvent(ctx, 'evt1', '21', '09:00', '10:00');
  await ctx.sync.importFuture(CAL, { timeMin: '2026-10-20T00:00:00.000Z' });
  const watched = ctx.provider.watch({ calendarId: CAL, token: 'push-bearer-1' });
  await ctx.sync.watchCalendar(CAL, { channelId: watched.channelId, resourceId: watched.resourceId, channelToken: 'push-bearer-1' });
  ctx.setNow(T0 + 60_000);
  ctx.provider.patchEvent({ calendarId: CAL, eventId: 'evt1', patch: { ...slot('21', '14:00', '15:00') } });
  let pulled = null;
  ctx.provider.onPush((delivery) => { pulled = delivery; return ctx.sync.handlePush(delivery); });
  const out = await ctx.provider.deliverPush(watched.channelId);
  assert.equal(out.effect, 'pulled');
  assert.equal(pulled.deliveryId, 'fake-delivery-1');
  assert.equal(ctx.appointmentRows().length, 2);
  await assert.rejects(
    ctx.sync.handlePush({ channelId: watched.channelId, channelToken: 'wrong-bearer', resourceState: 'exists' }),
    (error) => error.code === 'CALENDAR_PUSH_FORBIDDEN',
  );
  await assert.rejects(
    ctx.sync.handlePush({ channelId: 'no-such-channel', channelToken: 'push-bearer-1', resourceState: 'exists' }),
    (error) => error.code === 'CALENDAR_PUSH_UNKNOWN_CHANNEL',
  );
});

test('an expired sync token reconciles fully without duplicating', async (t) => {
  const ctx = setup();
  t.after(() => ctx.close());
  seedEvent(ctx, 'evt1', '21', '09:00', '10:00');
  await ctx.sync.importFuture(CAL, { timeMin: '2026-10-20T00:00:00.000Z' });
  ctx.setNow(T0 + 60_000);
  ctx.provider.patchEvent({ calendarId: CAL, eventId: 'evt1', patch: { ...slot('21', '14:00', '15:00') } });
  seedEvent(ctx, 'evt2', '22', '09:00', '10:00');
  ctx.provider.expireTokens(CAL);
  const pull = await ctx.sync.pullIncremental(CAL);
  assert.equal(pull.recovered, true);
  assert.equal(ctx.appointmentRows().length, 3);
  assert.equal(ctx.linkRows().length, 2);
  const again = await ctx.sync.pullIncremental(CAL);
  assert.ok(again.entries.every((e) => e.status === 'replayed' || e.status === 'acknowledged' || e.status === 'ignored'));
});

test('an import overlapping a held slot is refused, never booked over', async (t) => {
  const ctx = setup();
  t.after(() => ctx.close());
  const handle = createAppointmentBookCapability({}).create({ modules: ctx.modules, actor: ACTOR, consumer: 'calendar-sync' });
  await handle.bookAppointment({
    sourceKey: 'gym:held:1',
    subject: { ...SUBJECT },
    teamMemberId: MEMBER,
    ...SERVICE,
    startsAt: '2026-10-21T09:00:00.000Z',
    endsAt: '2026-10-21T10:00:00.000Z',
    source: { package: 'calendar-sync', action: 'calendar-import' },
  });
  seedEvent(ctx, 'evt-clash', '21', '09:30', '10:30');
  const imported = await ctx.sync.importFuture(CAL, { timeMin: '2026-10-20T00:00:00.000Z' });
  const entry = imported.entries.find((e) => e.eventId === 'evt-clash');
  assert.equal(entry.status, 'conflict');
  assert.match(entry.reason, /APPOINTMENTS_OVERLAP/);
  assert.equal(ctx.appointmentRows().length, 1);
  assert.equal(ctx.linkRows().length, 0);
});

test('a Google change on a terminal row is ignored: the past is evidence', async (t) => {
  const ctx = setup();
  t.after(() => ctx.close());
  seedEvent(ctx, 'evt1', '21', '09:00', '10:00');
  await ctx.sync.importFuture(CAL, { timeMin: '2026-10-20T00:00:00.000Z' });
  const row = ctx.appointmentRows()[0];
  const handle = createAppointmentBookCapability({}).create({ modules: ctx.modules, actor: ACTOR, consumer: 'calendar-sync' });
  await handle.advanceAppointment(row, 'confirmed');
  await handle.advanceAppointment({ ...row, status: 'confirmed' }, 'done');
  ctx.setNow(T0 + 60_000);
  ctx.provider.patchEvent({ calendarId: CAL, eventId: 'evt1', patch: { ...slot('21', '14:00', '15:00') } });
  const pull = await ctx.sync.pullIncremental(CAL);
  assert.equal(pull.entries[0].status, 'ignored');
  const rows = ctx.appointmentRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'done');
  assert.equal(rows[0].startsAt, '2026-10-21T09:00:00.000Z');
});

test('an event with no customer mapping is skipped, never fabricated', async (t) => {
  const ctx = setup({ subjectForEvent: () => null });
  t.after(() => ctx.close());
  seedEvent(ctx, 'evt-ghost', '21', '09:00', '10:00');
  const imported = await ctx.sync.importFuture(CAL, { timeMin: '2026-10-20T00:00:00.000Z' });
  assert.equal(imported.entries[0].status, 'skipped');
  assert.equal(ctx.appointmentRows().length, 0);
  assert.equal(ctx.linkRows().length, 0);
});

test('stored rows hold no secret material: only the channel token hash', async (t) => {
  const ctx = setup();
  t.after(() => ctx.close());
  seedEvent(ctx, 'evt1', '21', '09:00', '10:00');
  await ctx.sync.importFuture(CAL, { timeMin: '2026-10-20T00:00:00.000Z' });
  const watched = ctx.provider.watch({ calendarId: CAL, token: 'push-bearer-secret' });
  await ctx.sync.watchCalendar(CAL, { channelId: watched.channelId, resourceId: watched.resourceId, channelToken: 'push-bearer-secret' });
  const dump = JSON.stringify({ links: ctx.linkRows(), states: ctx.stateRows(), audit: null });
  assert.ok(!dump.includes('push-bearer-secret'));
  const [state] = ctx.stateRows();
  assert.equal(typeof state.channelTokenHash, 'string');
  assert.equal(state.channelTokenHash.length, 64);
});

test('the package factory refuses an unwired composition fail-closed', () => {
  const book = createAppointmentBookCapability({});
  const provider = createFakeGoogleCalendar({});
  const mapping = {
    subjectForEvent: () => ({ ...SUBJECT }),
    teamMemberForCalendar: () => MEMBER,
    serviceForEvent: () => ({ ...SERVICE }),
    summaryForAppointment: () => 'x',
  };
  assert.throws(() => createCalendarSyncPackage({ provider, mapping }), /appointment-book/);
  assert.throws(() => createCalendarSyncPackage({ appointmentBook: book, mapping }), /provider/);
  assert.throws(() => createCalendarSyncPackage({ appointmentBook: book, provider }), /mapping/);
  const pkg = createCalendarSyncPackage({ appointmentBook: book, provider, mapping });
  assert.equal(pkg.name, 'calendar-sync');
  assert.deepEqual(pkg.requires, [{ package: 'appointments', capability: 'appointment-book', version: 1 }]);
  assert.equal(typeof pkg.metadata().conflictRule.cancellationWins, 'string');
});
