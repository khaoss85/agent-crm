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
import { assertPackageConforms } from './helpers/package-conformance.js';
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
  if (options.asyncProvider) {
    // A real adapter does network I/O: prove the engine awaits every
    // provider call by serving the same fake asynchronously.
    for (const key of ['listEvents', 'insertEvent', 'patchEvent', 'cancelEvent', 'findByAccordoSourceKey']) {
      const fn = provider[key].bind(provider);
      provider[key] = async (...args) => fn(...args);
    }
  }
  const appointmentBook = createAppointmentBookCapability({});
  const mapping = {
    subjectForEvent: options.subjectForEvent ?? (() => ({ ...SUBJECT })),
    teamMemberForCalendar: () => MEMBER,
    serviceForEvent: () => ({ ...SERVICE }),
    summaryForAppointment: (row) => `Appointment ${row.serviceKey} ${row.startsAt}`,
  };
  const sync = createCalendarSyncOperations({
    modules, appointmentBook, provider, mapping, database,
    actor: ACTOR, now: () => new Date(fakeNow).toISOString(),
  });
  const appointmentRows = () => [...modules.get('appointment').service.listWhere({})];
  const linkRows = () => [...modules.get('calendar-link').service.listWhere({})];
  const stateRows = () => [...modules.get('calendar-sync-state').service.listWhere({})];
  return {
    database, modules, provider, sync, mapping, appointmentRows, linkRows, stateRows, events,
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
  assert.match(fresh.sourceKey, /^gcal:presti-room-1:evt1:r1$/);
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
  // Refused, not lost: an orphan pending link retries on every pull.
  assert.equal(ctx.linkRows().length, 1);
  assert.ok(ctx.linkRows()[0].pendingRemote);
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

test('the package conforms: identity, two owned records, one declared reach', () => {
  const definition = createCalendarSyncPackage({});
  assertPackageConforms({
    definition,
    dir: join(here, '..', 'packages', 'calendar-sync'),
    expected: {
      name: 'calendar-sync',
      version: 1,
      resources: ['calendar-link', 'calendar-sync-state'],
      requires: ['appointments/appointment-book@1'],
      provides: [],
    },
    forbiddenImports: [/from\s+['"]node:(https?|net|dgram|tls|dns)['"]/, /\bfetch\s*\(/, /child_process/],
  });
  assert.equal(typeof definition.metadata().conflictRule.cancellationWins, 'string');
});

test('bindings fail at operation creation, never at definition read', () => {
  const book = createAppointmentBookCapability({});
  const provider = createFakeGoogleCalendar({});
  const mapping = {
    subjectForEvent: () => ({ ...SUBJECT }),
    teamMemberForCalendar: () => MEMBER,
    serviceForEvent: () => ({ ...SERVICE }),
    summaryForAppointment: () => 'x',
  };
  const modules = new Map();
  assert.throws(() => createCalendarSyncOperations({ modules, provider, mapping }), /appointment-book/);
  assert.throws(() => createCalendarSyncOperations({ modules, appointmentBook: book, mapping }), /provider/);
  assert.throws(() => createCalendarSyncOperations({ modules, appointmentBook: book, provider }), /mapping/);
});

test('the engine awaits an asynchronous provider binding', async (t) => {
  const ctx = setup({ asyncProvider: true });
  t.after(() => ctx.close());
  seedEvent(ctx, 'evt1', '21', '09:00', '10:00');
  const imported = await ctx.sync.importFuture(CAL, { timeMin: '2026-10-20T00:00:00.000Z' });
  assert.equal(imported.entries.filter((e) => e.status === 'imported').length, 1);
  ctx.setNow(T0 + 60_000);
  ctx.provider.patchEvent({ calendarId: CAL, eventId: 'evt1', patch: { ...slot('21', '14:00', '15:00') } });
  const pull = await ctx.sync.pullIncremental(CAL);
  assert.equal(pull.entries.filter((e) => e.status === 'applied').length, 1);
  const handle = createAppointmentBookCapability({}).create({ modules: ctx.modules, actor: ACTOR, consumer: 'calendar-sync' });
  const { appointment } = await handle.bookAppointment({
    sourceKey: 'gym:async:1',
    subject: { ...SUBJECT },
    teamMemberId: MEMBER,
    ...SERVICE,
    startsAt: '2026-10-22T09:00:00.000Z',
    endsAt: '2026-10-22T10:00:00.000Z',
    source: { package: 'calendar-sync', action: 'probe' },
  });
  const pushed = await ctx.sync.pushAppointment(CAL, appointment.sourceKey);
  assert.equal(pushed.status, 'exported');
});

test('a self-overlapping Google move applies atomically: no sacrifice, no double hold', async (t) => {
  // The new slot overlaps the booking's own old slot with no other
  // blocker: only the atomic commit converges it (cancel and rebook in
  // one storage transaction, rollback on refusal).
  const ctx = setup();
  t.after(() => ctx.close());
  seedEvent(ctx, 'evt1', '21', '09:00', '10:00');
  await ctx.sync.importFuture(CAL, { timeMin: '2026-10-20T00:00:00.000Z' });
  ctx.setNow(T0 + 60_000);
  ctx.provider.patchEvent({ calendarId: CAL, eventId: 'evt1', patch: { ...slot('21', '09:30', '10:30') } });
  const pull = await ctx.sync.pullIncremental(CAL);
  const applied = pull.entries.find((e) => e.eventId === 'evt1');
  assert.equal(applied.status, 'applied');
  assert.equal(applied.change, 'rescheduled');
  assert.equal(pull.pendingConflicts.length, 0);
  const rows = ctx.appointmentRows();
  assert.equal(rows.length, 2);
  assert.equal(rows.filter((r) => r.status === 'cancelled').length, 1);
  const fresh = rows.find((r) => r.status === 'booked');
  assert.equal(fresh.startsAt, '2026-10-21T09:30:00.000Z');
  assert.match(fresh.sourceKey, /^gcal:presti-room-1:evt1:r1$/);
  assert.equal(ctx.linkRows()[0].appointmentSourceKey, fresh.sourceKey);
});

test('a Google cancellation between two full imports is applied, never skipped past', async (t) => {
  const ctx = setup();
  t.after(() => ctx.close());
  seedEvent(ctx, 'evt1', '21', '09:00', '10:00');
  const first = await ctx.sync.importFuture(CAL, { timeMin: '2026-10-20T00:00:00.000Z' });
  assert.equal(first.entries.filter((e) => e.status === 'imported').length, 1);
  ctx.setNow(T0 + 60_000);
  ctx.provider.cancelEvent({ calendarId: CAL, eventId: 'evt1' });
  // The operator re-runs the full import instead of the incremental pull:
  // the tombstone between the two imports must converge locally before
  // the token moves past it.
  const second = await ctx.sync.importFuture(CAL, { timeMin: '2026-10-20T00:00:00.000Z' });
  const converged = second.entries.find((e) => e.eventId === 'evt1');
  assert.equal(converged?.status, 'applied');
  assert.equal(converged?.change, 'cancelled');
  const rows = ctx.appointmentRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'cancelled');
  assert.equal(rows[0].cancelReason, 'Cancelled in Google Calendar');
  // The token moved past the tombstone: a later pull sees nothing new.
  const pull = await ctx.sync.pullIncremental(CAL);
  assert.ok(pull.entries.every((e) => e.status === 'replayed' || e.status === 'acknowledged' || e.status === 'ignored'));
});

test('a Google move onto a held slot keeps the valid local booking', async (t) => {
  const ctx = setup();
  t.after(() => ctx.close());
  seedEvent(ctx, 'evt1', '21', '09:00', '10:00');
  await ctx.sync.importFuture(CAL, { timeMin: '2026-10-20T00:00:00.000Z' });
  const handle = createAppointmentBookCapability({}).create({ modules: ctx.modules, actor: ACTOR, consumer: 'calendar-sync' });
  await handle.advanceAppointment(ctx.appointmentRows()[0], 'confirmed');
  const held = await handle.bookAppointment({
    sourceKey: 'gym:held:1',
    subject: { ...SUBJECT },
    teamMemberId: MEMBER,
    ...SERVICE,
    startsAt: '2026-10-21T14:00:00.000Z',
    endsAt: '2026-10-21T15:00:00.000Z',
    source: { package: 'calendar-sync', action: 'calendar-import' },
  });
  ctx.setNow(T0 + 60_000);
  ctx.provider.patchEvent({ calendarId: CAL, eventId: 'evt1', patch: { ...slot('21', '14:00', '15:00') } });
  const pull = await ctx.sync.pullIncremental(CAL);
  const conflicted = pull.entries.find((e) => e.eventId === 'evt1');
  assert.equal(conflicted.status, 'conflict');
  assert.equal(conflicted.pending, true);
  assert.equal(pull.pendingConflicts.length, 1);
  // The refused move sacrifices nothing: the original row is still the
  // confirmed booking on its old slot, and the link still points at it.
  const rows = ctx.appointmentRows();
  assert.equal(rows.filter((r) => r.status === 'confirmed').length, 1);
  const kept = rows.find((r) => r.status === 'confirmed');
  assert.equal(kept.startsAt, '2026-10-21T09:00:00.000Z');
  assert.equal(rows.filter((r) => r.status === 'cancelled').length, 0);
  assert.equal(ctx.linkRows().length, 1);
  assert.equal(ctx.linkRows()[0].appointmentSourceKey, kept.sourceKey);
  assert.equal(ctx.linkRows()[0].pendingRemote !== null, true);
  // Free the slot in Accordo: the next pull retries and converges, carrying
  // the confirmed forward like the fresh path.
  await handle.advanceAppointment(held.appointment, 'cancelled', 'Customer moved');
  const retry = await ctx.sync.pullIncremental(CAL);
  const settled = retry.entries.find((e) => e.eventId === 'evt1');
  assert.equal(settled.status, 'applied');
  assert.equal(settled.change, 'rescheduled');
  assert.equal(settled.retried, true);
  assert.equal(retry.pendingConflicts.length, 0);
  const after = ctx.appointmentRows();
  assert.equal(after.filter((r) => r.status === 'confirmed').length, 1);
  assert.equal(after.find((r) => r.status === 'confirmed').startsAt, '2026-10-21T14:00:00.000Z');
});

test('a settled retry still applies the newer Google move on a full import', async (t) => {
  // The S1 move was refused (blocker held) and kept pending; the blocker
  // freed and Google moved the same event again — to S2 — before the next
  // full import. The import retries the stale S1 envelope first, which now
  // books: the settled retry must not skip the newer S2 event in hand.
  const ctx = setup();
  t.after(() => ctx.close());
  seedEvent(ctx, 'evt1', '21', '09:00', '10:00');
  await ctx.sync.importFuture(CAL, { timeMin: '2026-10-20T00:00:00.000Z' });
  const handle = createAppointmentBookCapability({}).create({ modules: ctx.modules, actor: ACTOR, consumer: 'calendar-sync' });
  await handle.advanceAppointment(ctx.appointmentRows()[0], 'confirmed');
  const held = await handle.bookAppointment({
    sourceKey: 'gym:held:1',
    subject: { ...SUBJECT },
    teamMemberId: MEMBER,
    ...SERVICE,
    startsAt: '2026-10-21T14:00:00.000Z',
    endsAt: '2026-10-21T15:00:00.000Z',
    source: { package: 'calendar-sync', action: 'calendar-import' },
  });
  ctx.setNow(T0 + 60_000);
  ctx.provider.patchEvent({ calendarId: CAL, eventId: 'evt1', patch: { ...slot('21', '14:00', '15:00') } });
  const conflicted = await ctx.sync.pullIncremental(CAL);
  assert.equal(conflicted.entries.find((e) => e.eventId === 'evt1').status, 'conflict');
  assert.equal(ctx.linkRows()[0].pendingRemote !== null, true);
  // The slot frees and Google moves the event again — S2 — before the
  // next full import.
  await handle.advanceAppointment(held.appointment, 'cancelled', 'Customer moved');
  ctx.setNow(T0 + 120_000);
  ctx.provider.patchEvent({ calendarId: CAL, eventId: 'evt1', patch: { ...slot('21', '16:00', '17:00') } });
  const second = await ctx.sync.importFuture(CAL, { timeMin: '2026-10-20T00:00:00.000Z' });
  const converged = second.entries.find((e) => e.eventId === 'evt1');
  assert.equal(converged?.status, 'applied');
  assert.equal(converged?.change, 'rescheduled');
  // Accordo ends on S2: the link tracks Google's newest update with no
  // pending snapshot and no conflict left, and the live booking sits on S2.
  const live = ctx.provider.getEvent(CAL, 'evt1');
  assert.equal(ctx.linkRows()[0].googleUpdated, live.updated);
  assert.equal(ctx.linkRows()[0].pendingRemote, null);
  assert.equal(ctx.linkRows()[0].conflictNote, null);
  const rows = ctx.appointmentRows();
  assert.equal(rows.find((r) => r.status === 'confirmed').startsAt, '2026-10-21T16:00:00.000Z');
});

test('a refused self-overlapping move keeps the row: rollback, not sacrifice', async (t) => {
  // The blocker sits back-to-back with the old slot but inside the
  // moved one, which still overlaps the old slot: the cancel must roll
  // back with the refused rebook, leaving the original booking intact
  // and retryable.
  const ctx = setup();
  t.after(() => ctx.close());
  seedEvent(ctx, 'evt1', '21', '09:00', '10:00');
  await ctx.sync.importFuture(CAL, { timeMin: '2026-10-20T00:00:00.000Z' });
  const handle = createAppointmentBookCapability({}).create({ modules: ctx.modules, actor: ACTOR, consumer: 'calendar-sync' });
  await handle.bookAppointment({
    sourceKey: 'gym:held:1',
    subject: { ...SUBJECT },
    teamMemberId: MEMBER,
    ...SERVICE,
    startsAt: '2026-10-21T10:00:00.000Z',
    endsAt: '2026-10-21T10:30:00.000Z',
    source: { package: 'calendar-sync', action: 'calendar-import' },
  });
  ctx.setNow(T0 + 60_000);
  ctx.provider.patchEvent({ calendarId: CAL, eventId: 'evt1', patch: { ...slot('21', '09:15', '10:15') } });
  const pull = await ctx.sync.pullIncremental(CAL);
  const conflicted = pull.entries.find((e) => e.eventId === 'evt1');
  assert.equal(conflicted.status, 'conflict');
  assert.equal(conflicted.pending, true);
  const rows = ctx.appointmentRows();
  assert.equal(rows.filter((r) => r.status === 'booked').length, 2);
  const kept = rows.find((r) => r.sourceKey === `gcal:${CAL}:evt1`);
  assert.equal(kept.startsAt, '2026-10-21T09:00:00.000Z');
  assert.equal(rows.filter((r) => r.status === 'cancelled').length, 0);
  assert.equal(rows.some((r) => r.sourceKey === `gcal:${CAL}:evt1:r1`), false);
});

test('a Google cancellation supersedes an outstanding pending move', async (t) => {
  // The move was refused (blocker held) and kept pending; then Google
  // cancels the event outright. The pull must cancel the local row and
  // clear the snapshot — never book the dead event's slot, never leave
  // the pending retrying forever.
  const ctx = setup();
  t.after(() => ctx.close());
  seedEvent(ctx, 'evt1', '21', '09:00', '10:00');
  await ctx.sync.importFuture(CAL, { timeMin: '2026-10-20T00:00:00.000Z' });
  const handle = createAppointmentBookCapability({}).create({ modules: ctx.modules, actor: ACTOR, consumer: 'calendar-sync' });
  await handle.bookAppointment({
    sourceKey: 'gym:held:1',
    subject: { ...SUBJECT },
    teamMemberId: MEMBER,
    ...SERVICE,
    startsAt: '2026-10-21T14:00:00.000Z',
    endsAt: '2026-10-21T15:00:00.000Z',
    source: { package: 'calendar-sync', action: 'calendar-import' },
  });
  ctx.setNow(T0 + 60_000);
  ctx.provider.patchEvent({ calendarId: CAL, eventId: 'evt1', patch: { ...slot('21', '14:00', '15:00') } });
  const conflicted = await ctx.sync.pullIncremental(CAL);
  assert.equal(conflicted.entries.find((e) => e.eventId === 'evt1').status, 'conflict');
  assert.equal(ctx.linkRows()[0].pendingRemote !== null, true);
  ctx.setNow(T0 + 120_000);
  ctx.provider.cancelEvent({ calendarId: CAL, eventId: 'evt1' });
  const pull = await ctx.sync.pullIncremental(CAL);
  // The pull first retries the stale move (still blocked: conflict) and
  // then the tombstone supersedes it — the entry that matters applies
  // the cancellation and clears the snapshot.
  const converged = pull.entries.filter((e) => e.eventId === 'evt1').find((e) => e.status === 'applied');
  assert.equal(converged?.change, 'cancelled');
  assert.equal(pull.pendingConflicts.length, 0);
  const rows = ctx.appointmentRows();
  assert.equal(rows.filter((r) => r.status === 'booked').length, 1);
  assert.equal(rows.find((r) => r.sourceKey === `gcal:${CAL}:evt1`).status, 'cancelled');
  assert.equal(ctx.linkRows()[0].pendingRemote, null);
});

test('export reconciles an already-inserted event instead of duplicating it', async (t) => {
  const ctx = setup();
  t.after(() => ctx.close());
  const handle = createAppointmentBookCapability({}).create({ modules: ctx.modules, actor: ACTOR, consumer: 'calendar-sync' });
  const { appointment } = await handle.bookAppointment({
    sourceKey: `gcal:${CAL}:evt-lost`,
    subject: { ...SUBJECT },
    teamMemberId: MEMBER,
    ...SERVICE,
    startsAt: '2026-10-21T09:00:00.000Z',
    endsAt: '2026-10-21T10:00:00.000Z',
    source: { package: 'calendar-sync', action: 'calendar-import' },
  });
  // A previous export inserted the event but its link never landed.
  ctx.provider.insertEvent({
    calendarId: CAL,
    summary: 'Appointment pt-single',
    start: { dateTime: appointment.startsAt },
    end: { dateTime: appointment.endsAt },
    extendedProperties: { accordoSourceKey: appointment.sourceKey },
  });
  const countBefore = ctx.provider.eventCount(CAL);
  const out = await ctx.sync.pushAppointment(CAL, appointment.sourceKey);
  assert.equal(out.status, 'linked');
  assert.equal(out.healed, true);
  assert.equal(ctx.provider.eventCount(CAL), countBefore);
  assert.equal(ctx.linkRows().length, 1);
});

test('a newer Google move supersedes a still-conflicted pending move on a pull', async (t) => {
  // Newest Google version wins over an older pending envelope: the S1
  // move was refused (blocker held) and kept pending, then Google moved
  // the same event again to free S2 before the next pull. The pull must
  // decide S2 — never retry-then-skip it — and freeing the blocker later
  // must not resurrect S1.
  const ctx = setup();
  t.after(() => ctx.close());
  seedEvent(ctx, 'evt1', '21', '09:00', '10:00');
  await ctx.sync.importFuture(CAL, { timeMin: '2026-10-20T00:00:00.000Z' });
  const handle = createAppointmentBookCapability({}).create({ modules: ctx.modules, actor: ACTOR, consumer: 'calendar-sync' });
  await handle.advanceAppointment(ctx.appointmentRows()[0], 'confirmed');
  const held = await handle.bookAppointment({
    sourceKey: 'gym:held:1',
    subject: { ...SUBJECT },
    teamMemberId: MEMBER,
    ...SERVICE,
    startsAt: '2026-10-21T14:00:00.000Z',
    endsAt: '2026-10-21T15:00:00.000Z',
    source: { package: 'calendar-sync', action: 'calendar-import' },
  });
  ctx.setNow(T0 + 60_000);
  ctx.provider.patchEvent({ calendarId: CAL, eventId: 'evt1', patch: { ...slot('21', '14:00', '15:00') } });
  const conflicted = await ctx.sync.pullIncremental(CAL);
  assert.equal(conflicted.entries.find((e) => e.eventId === 'evt1').status, 'conflict');
  assert.equal(ctx.linkRows()[0].pendingRemote !== null, true);
  // Google moves again — S2, free — before the next pull. The blocker
  // stays held, so retrying stale S1 would still refuse.
  ctx.setNow(T0 + 120_000);
  ctx.provider.patchEvent({ calendarId: CAL, eventId: 'evt1', patch: { ...slot('21', '16:00', '17:00') } });
  const pull = await ctx.sync.pullIncremental(CAL);
  const converged = pull.entries.filter((e) => e.eventId === 'evt1').find((e) => e.status === 'applied');
  assert.equal(converged?.change, 'rescheduled');
  assert.equal(pull.pendingConflicts.length, 0);
  // Accordo ends on S2: the link tracks Google's newest update with no
  // pending snapshot left, and the live booking sits on S2.
  const live = ctx.provider.getEvent(CAL, 'evt1');
  assert.equal(ctx.linkRows()[0].googleUpdated, live.updated);
  assert.equal(ctx.linkRows()[0].pendingRemote, null);
  assert.equal(ctx.linkRows()[0].conflictNote, null);
  const rows = ctx.appointmentRows();
  assert.equal(rows.find((r) => r.status === 'confirmed').startsAt, '2026-10-21T16:00:00.000Z');
  // Freeing the old blocker resurrects nothing: S2 stands, S1 never books.
  await handle.advanceAppointment(held.appointment, 'cancelled', 'Customer moved');
  const retry = await ctx.sync.pullIncremental(CAL);
  assert.ok(retry.entries.every((e) => e.status === 'replayed' || e.status === 'acknowledged' || e.status === 'ignored'));
  assert.equal(ctx.appointmentRows().find((r) => r.status === 'confirmed').startsAt, '2026-10-21T16:00:00.000Z');
  assert.equal(ctx.linkRows()[0].pendingRemote, null);
});

test('the package factory forwards an explicit database handle to reschedules', async (t) => {
  // index.js documents options.database: a self-overlapping move (which
  // converges only inside a storage transaction) must apply when the
  // handle arrives via the factory with a runtime that carries none.
  const ctx = setup();
  t.after(() => ctx.close());
  assert.throws(() => createCalendarSyncPackage({ database: 42 }), /database must be an object/);
  const definition = createCalendarSyncPackage({
    appointmentBook: createAppointmentBookCapability({}),
    provider: ctx.provider,
    mapping: ctx.mapping,
    database: ctx.database,
    actor: ACTOR,
  });
  const byName = Object.fromEntries(definition.operations.map((o) => [o.name, o]));
  const importFuture = byName['import-future-events'].create({ modules: ctx.modules });
  const pull = byName['pull-calendar'].create({ modules: ctx.modules });
  seedEvent(ctx, 'evt1', '21', '09:00', '10:00');
  await importFuture({ spaceId: 'presti', calendarId: CAL, timeMin: '2026-10-20T00:00:00.000Z' });
  ctx.setNow(T0 + 60_000);
  ctx.provider.patchEvent({ calendarId: CAL, eventId: 'evt1', patch: { ...slot('21', '09:30', '10:30') } });
  const out = await pull({ spaceId: 'presti', calendarId: CAL });
  const applied = out.entries.find((e) => e.eventId === 'evt1');
  assert.equal(applied.status, 'applied');
  assert.equal(applied.change, 'rescheduled');
  assert.equal(out.pendingConflicts.length, 0);
  assert.equal(ctx.appointmentRows().find((r) => r.status === 'booked').startsAt, '2026-10-21T09:30:00.000Z');
});

test('creation refuses without a storage transaction: fail closed, no fallback', () => {
  const book = createAppointmentBookCapability({});
  const provider = createFakeGoogleCalendar({});
  const mapping = {
    subjectForEvent: () => ({ ...SUBJECT }),
    teamMemberForCalendar: () => MEMBER,
    serviceForEvent: () => ({ ...SERVICE }),
    summaryForAppointment: () => 'x',
  };
  const stubService = () => ({
    service: {
      createManaged: async () => ({}),
      applyManaged: async () => ({}),
      listWhere: async () => [],
    },
  });
  const modules = new Map([
    ['calendar-link', stubService()],
    ['calendar-sync-state', stubService()],
  ]);
  // Neither the explicit handle nor the link records' handle carries a
  // transaction: creation refuses instead of running transaction-less.
  assert.throws(
    () => createCalendarSyncOperations({ modules, appointmentBook: book, provider, mapping, database: {} }),
    (error) => error.code === 'CALENDAR_SYNC_TRANSACTIONS_REQUIRED',
  );
  assert.throws(
    () => createCalendarSyncOperations({ modules, appointmentBook: book, provider, mapping }),
    (error) => error.code === 'CALENDAR_SYNC_TRANSACTIONS_REQUIRED',
  );
});

test('a pre-protocol pending is rejected visibly, never pushed to Google as a cancellation', async (t) => {
  // The envelope the pre-atomic code left: {event, preStatus} with no
  // cancelCommitted flag, the old row already cancelled, the fingerprint
  // still booked. A newer Google move must not turn it into a Google
  // cancellation of the live event.
  const ctx = setup();
  t.after(() => ctx.close());
  seedEvent(ctx, 'evt1', '21', '09:00', '10:00');
  await ctx.sync.importFuture(CAL, { timeMin: '2026-10-20T00:00:00.000Z' });
  const handle = createAppointmentBookCapability({}).create({ modules: ctx.modules, actor: ACTOR, consumer: 'calendar-sync' });
  await handle.bookAppointment({
    sourceKey: 'gym:held:1',
    subject: { ...SUBJECT },
    teamMemberId: MEMBER,
    ...SERVICE,
    startsAt: '2026-10-21T14:00:00.000Z',
    endsAt: '2026-10-21T15:00:00.000Z',
    source: { package: 'calendar-sync', action: 'calendar-import' },
  });
  const [link] = ctx.linkRows();
  const bookedFingerprint = link.localFingerprint;
  const row = ctx.appointmentRows()[0];
  ctx.setNow(T0 + 60_000);
  ctx.provider.patchEvent({ calendarId: CAL, eventId: 'evt1', patch: { ...slot('21', '14:00', '15:00') } });
  const staleMove = ctx.provider.getEvent(CAL, 'evt1');
  await handle.advanceAppointment(row, 'cancelled', 'Rescheduled in Google Calendar');
  const linkService = ctx.modules.get('calendar-link').service;
  await linkService.applyManaged(link.id, {
    pendingRemote: JSON.stringify({ event: staleMove, preStatus: 'booked' }),
    localFingerprint: bookedFingerprint,
    conflictNote: 'legacy pending from the pre-atomic code',
  }, { actor: ACTOR });
  // Google moves again — S2, free — before the next pull.
  ctx.setNow(T0 + 120_000);
  ctx.provider.patchEvent({ calendarId: CAL, eventId: 'evt1', patch: { ...slot('21', '16:00', '17:00') } });
  const pull = await ctx.sync.pullIncremental(CAL);
  const entries = pull.entries.filter((e) => String(e.eventId).endsWith('evt1'));
  assert.ok(entries.length > 0);
  assert.ok(entries.every((e) => e.status === 'conflict' && e.pending === true));
  assert.ok(entries.every((e) => /UPGRADE_REQUIRED/.test(e.reason ?? '')));
  // S2 was never pushed as a Google cancellation: the live event stands,
  // nothing was booked over it, and the snapshot stays visible.
  assert.equal(ctx.provider.getEvent(CAL, 'evt1').status, 'confirmed');
  assert.equal(ctx.appointmentRows().filter((r) => r.status === 'booked').length, 1);
  assert.ok(ctx.linkRows()[0].pendingRemote);
  assert.ok((pull.pendingConflicts ?? []).length >= 1);
});

test('a refused atomic move emits no appointment events: rollback drops the ghosts', async (t) => {
  // The blocker sits back-to-back with the old slot but inside the moved
  // one: the cancel rolls back with the refused rebook, and the buffered
  // domain events roll back with the rows — no listener ever observes a
  // cancel that never committed.
  const ctx = setup();
  t.after(() => ctx.close());
  seedEvent(ctx, 'evt1', '21', '09:00', '10:00');
  await ctx.sync.importFuture(CAL, { timeMin: '2026-10-20T00:00:00.000Z' });
  const handle = createAppointmentBookCapability({}).create({ modules: ctx.modules, actor: ACTOR, consumer: 'calendar-sync' });
  const held = await handle.bookAppointment({
    sourceKey: 'gym:held:1',
    subject: { ...SUBJECT },
    teamMemberId: MEMBER,
    ...SERVICE,
    startsAt: '2026-10-21T10:00:00.000Z',
    endsAt: '2026-10-21T10:30:00.000Z',
    source: { package: 'calendar-sync', action: 'calendar-import' },
  });
  const seen = [];
  ctx.events.subscribe('*', ({ event }) => { seen.push(event); });
  ctx.setNow(T0 + 60_000);
  ctx.provider.patchEvent({ calendarId: CAL, eventId: 'evt1', patch: { ...slot('21', '09:15', '10:15') } });
  const pull = await ctx.sync.pullIncremental(CAL);
  assert.equal(pull.entries.find((e) => e.eventId === 'evt1').status, 'conflict');
  assert.ok(seen.filter((name) => name.startsWith('appointment.')).length === 0);
  // The converged move does emit: the buffer flushes after the commit.
  await handle.advanceAppointment(held.appointment, 'cancelled', 'Customer moved');
  ctx.setNow(T0 + 120_000);
  const retry = await ctx.sync.pullIncremental(CAL);
  assert.equal(retry.entries.find((e) => e.eventId === 'evt1').status, 'applied');
  assert.ok(seen.filter((name) => name.startsWith('appointment.')).length > 0);
});

test('a push-converged cancellation leaves the older move snapshot standing, never rebooked', async (t) => {
  // The retryPending stale-snapshot guard, reached: the S1 move was refused
  // and kept pending, then the local row was cancelled and the push
  // converged the cancellation to Google — advancing the link past the
  // standing S1 snapshot. The next pull must not retry the older envelope
  // backward onto the freed slot.
  const ctx = setup();
  t.after(() => ctx.close());
  seedEvent(ctx, 'evt1', '21', '09:00', '10:00');
  await ctx.sync.importFuture(CAL, { timeMin: '2026-10-20T00:00:00.000Z' });
  const handle = createAppointmentBookCapability({}).create({ modules: ctx.modules, actor: ACTOR, consumer: 'calendar-sync' });
  await handle.bookAppointment({
    sourceKey: 'gym:held:1',
    subject: { ...SUBJECT },
    teamMemberId: MEMBER,
    ...SERVICE,
    startsAt: '2026-10-21T14:00:00.000Z',
    endsAt: '2026-10-21T15:00:00.000Z',
    source: { package: 'calendar-sync', action: 'calendar-import' },
  });
  ctx.setNow(T0 + 60_000);
  ctx.provider.patchEvent({ calendarId: CAL, eventId: 'evt1', patch: { ...slot('21', '14:00', '15:00') } });
  const conflicted = await ctx.sync.pullIncremental(CAL);
  assert.equal(conflicted.entries.find((e) => e.eventId === 'evt1').status, 'conflict');
  assert.ok(ctx.linkRows()[0].pendingRemote);
  const row = ctx.appointmentRows().find((r) => r.sourceKey === `gcal:${CAL}:evt1`);
  await handle.advanceAppointment(row, 'cancelled', 'Customer called off');
  ctx.setNow(T0 + 120_000);
  const push = await ctx.sync.pushLocalChanges(CAL);
  assert.equal(push.entries.find((e) => e.sourceKey === row.sourceKey).status, 'pushed');
  assert.equal(ctx.provider.getEvent(CAL, 'evt1').status, 'cancelled');
  const pull = await ctx.sync.pullIncremental(CAL);
  const stale = pull.entries.find((e) => /stale snapshot/.test(e.reason ?? ''));
  assert.ok(stale);
  assert.equal(stale.status, 'conflict');
  // The older envelope never rebooked: no revision row, Google stays
  // cancelled, the freed slot is not resurrected.
  assert.ok(!ctx.appointmentRows().some((r) => /:r1$/.test(r.sourceKey)));
  assert.equal(ctx.provider.getEvent(CAL, 'evt1').status, 'cancelled');
  assert.equal(ctx.appointmentRows().filter((r) => r.status === 'booked').length, 1);
});
